// First-install "activate other platforms?" page. The content script overlays
// this on x.com in an iframe right after install (see
// maybeShowPlatformOnboarding in content/ui.ts). It must be an extension page
// rather than content-script DOM: chrome.permissions.request() is unavailable
// to content scripts, and a user gesture does not survive a message hop to
// the service worker — but a click inside this iframe is a gesture in an
// extension context, so the request can run directly (the same trick the
// settings modal uses for the platform toggles in popup.html).

import { optionalPlatforms, enabledStorageKey } from '../shared/platforms';
import type { PlatformDef } from '../shared/platforms';
import { setStorage } from '../shared/storage';
import type { StorageSchema } from '../types';

type ParentMessage =
  | { type: 'bouncerOnboardingDone' }
  | { type: 'bouncerOnboardingResize'; height: number };

// The parent is the host page (x.com), so '*' is fine here — nothing in
// these messages is sensitive, and the content script checks event.source.
function postToParent(msg: ParentMessage): void {
  window.parent.postMessage(msg, '*');
}

async function isGranted(p: PlatformDef): Promise<boolean> {
  try {
    return await chrome.permissions.contains({ origins: [p.manifestHost] });
  } catch {
    return false;
  }
}

async function init(): Promise<void> {
  const theme = new URLSearchParams(location.search).get('theme');
  if (theme === 'light' || theme === 'dim' || theme === 'dark') {
    document.body.classList.add(`${theme}-mode`);
  }

  // Platforms already granted (e.g. via the toolbar request chip, or a
  // pre-existing grant on this profile) still get a row — shown checked and
  // frozen — so the list doesn't mysteriously shrink. Only when everything
  // is already granted is there nothing to ask: tell the parent to close.
  const candidates = [...optionalPlatforms()];
  const grantedFlags = await Promise.all(candidates.map(isGranted));
  if (candidates.length === 0 || grantedFlags.every(Boolean)) {
    postToParent({ type: 'bouncerOnboardingDone' });
    return;
  }

  // Checking a platform's box fires the browser's permission prompt right
  // then — the change event is the user gesture, so the request must be the
  // handler's first await (same pattern as the settings toggles in
  // popup/index.ts). Once every offered platform is granted the popup closes
  // itself.
  const list = document.getElementById('platformList')!;
  const remaining = new Set<PlatformDef>(candidates.filter((_, i) => !grantedFlags[i]));
  candidates.forEach((p, i) => {
    const alreadyGranted = grantedFlags[i];
    const row = document.createElement('label');
    row.className = 'platform-row';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = alreadyGranted;
    checkbox.disabled = alreadyGranted;
    row.appendChild(checkbox);
    // Brand icons live as inert <template>s in onboarding.html so this file
    // never builds SVG markup from strings.
    const iconTemplate = document.getElementById(`platformIcon-${p.id}`);
    if (iconTemplate instanceof HTMLTemplateElement) {
      row.appendChild(iconTemplate.content.cloneNode(true));
    }
    const name = document.createElement('span');
    name.textContent = p.displayName;
    row.appendChild(name);
    if (p.id === 'youtube') {
      const tag = document.createElement('span');
      tag.className = 'platform-experimental';
      tag.textContent = '(experimental)';
      row.appendChild(tag);
    }
    list.appendChild(row);
    if (alreadyGranted) return;

    checkbox.addEventListener('change', () => {
      if (!checkbox.checked) return; // nothing granted yet — unchecking is a no-op
      (async () => {
        let granted = false;
        try {
          granted = await chrome.permissions.request({ origins: [p.manifestHost] });
        } catch (err) {
          console.error(`[Onboarding] Permission request for ${p.id} failed:`, err);
        }
        // Denied or dismissed: snap the box back off so it can be re-tried.
        if (!granted) {
          checkbox.checked = false;
          return;
        }
        // Granted — this popup offers no way to revoke, so freeze the box.
        checkbox.disabled = true;
        // The key defaults to true, but setting it explicitly makes the
        // settings toggle and any storage listeners see a definite value.
        const updates: Partial<StorageSchema> = {};
        updates[enabledStorageKey(p.id)] = true;
        await setStorage(updates);
        // permissions.onAdded also triggers the sync in the background, but
        // ask explicitly so the content script is registered before the user
        // navigates to the newly activated platform.
        await chrome.runtime.sendMessage({ type: 'syncOptionalPlatforms' })
          .catch(err => console.error('[Onboarding] Platform sync failed:', err));
        remaining.delete(p);
        if (remaining.size === 0) {
          // Leave the checked state on screen for a beat before closing.
          setTimeout(() => postToParent({ type: 'bouncerOnboardingDone' }), 600);
        }
      })().catch(err => console.error(`[Onboarding] Activating ${p.id} failed:`, err));
    });
  });

  document.getElementById('doneBtn')!.addEventListener('click', () => {
    postToParent({ type: 'bouncerOnboardingDone' });
  });

  // Rows are rendered — report the real content height so the parent can
  // size the iframe.
  postToParent({ type: 'bouncerOnboardingResize', height: document.body.scrollHeight });
}

init().catch(err => console.error('[Onboarding] init failed:', err));
