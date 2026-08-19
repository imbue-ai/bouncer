// First-install "activate other platforms?" page. Runs in one of two hosts:
//
//  - Chrome: an extension iframe overlaid on x.com by the content script
//    (see maybeShowPlatformOnboarding in content/ui.ts). It must be an
//    extension page rather than content-script DOM: chrome.permissions
//    .request() is unavailable to content scripts, and a user gesture does
//    not survive a message hop to the service worker — but a click inside
//    this iframe is a gesture in an extension context, so the request can
//    run directly (the same trick the settings modal uses for the platform
//    toggles in popup.html).
//
//  - Firefox: a top-level extension tab opened by onInstalled. Gecko gives
//    extension pages inside web-page iframes only content-script privileges
//    (no permissions API — Bugzilla 1443253) and a gesture doesn't survive
//    messaging either (Bugzilla 1397658), so a top-level page is the only
//    context where the checkbox click can fire the permission prompt. When
//    the user is done, the tab navigates on to x.com (or the install
//    landing page on builds that report install conversions).

import { optionalPlatforms, enabledStorageKey } from '../shared/platforms';
import type { PlatformDef } from '../shared/platforms';
import { setStorage } from '../shared/storage';
import type { StorageSchema } from '../types';

// Top-level tab (Firefox install flow) vs. iframe on x.com (Chrome flow).
const IS_TAB = window.top === window;

// Where the Firefox tab goes when onboarding concludes. Mirrors
// INSTALL_LANDING_URL in background/index.ts: production builds route
// through the landing page so its install-conversion pixels still fire,
// everything else heads straight to x.com.
const TAB_DONE_URL =
  process.env.HAS_IMBUE_BACKEND === 'true' &&
  process.env.BOUNCER_ENV !== 'dev' &&
  process.env.BOUNCER_NO_AD !== 'true'
    ? 'https://imbue.com/product/bouncer/just_installed_redirect.html'
    : 'https://x.com';

type ParentMessage =
  | { type: 'bouncerOnboardingDone' }
  | { type: 'bouncerOnboardingResize'; height: number };

// The parent is the host page (x.com), so '*' is fine here — nothing in
// these messages is sensitive, and the content script checks event.source.
function postToParent(msg: ParentMessage): void {
  window.parent.postMessage(msg, '*');
}

// Conclude the onboarding for the current host: hand control back to the
// content script (iframe) or move the tab on to its destination (tab).
function finish(): void {
  if (IS_TAB) {
    location.replace(TAB_DONE_URL);
  } else {
    postToParent({ type: 'bouncerOnboardingDone' });
  }
}

async function isGranted(p: PlatformDef): Promise<boolean> {
  try {
    return await chrome.permissions.contains({ origins: [p.manifestHost] });
  } catch {
    return false;
  }
}

async function init(): Promise<void> {
  if (IS_TAB) {
    // Full-page layout with the content in a centered card; theme follows
    // the OS since there's no host page to inherit from.
    document.body.classList.add('tab-mode');
    if (window.matchMedia('(prefers-color-scheme: light)').matches) {
      document.body.classList.add('light-mode');
    }
  } else {
    const theme = new URLSearchParams(location.search).get('theme');
    if (theme === 'light' || theme === 'dim' || theme === 'dark') {
      document.body.classList.add(`${theme}-mode`);
    }
  }

  // Platforms already granted (e.g. via the toolbar request chip, or a grant
  // Chrome restored from a previous install of this extension) still get a
  // row — shown checked and frozen — so the list doesn't mysteriously shrink.
  // Even when everything is already granted the popup stays up until the user
  // dismisses it: it must NEVER close itself. (It used to conclude
  // immediately in that case, which on a reinstall with restored grants made
  // the popup flash and vanish under the parent's backdrop.)
  const candidates = [...optionalPlatforms()];
  const grantedFlags = await Promise.all(candidates.map(isGranted));

  // Checking a platform's box fires the browser's permission prompt right
  // then — the change event is the user gesture, so the request must be the
  // handler's first await (same pattern as the settings toggles in
  // popup/index.ts). Granting never closes the popup — only the Done button
  // (or, in the iframe host, a backdrop click handled by the parent) does.
  const list = document.getElementById('platformList')!;
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
      })().catch(err => console.error(`[Onboarding] Activating ${p.id} failed:`, err));
    });
  });

  document.getElementById('doneBtn')!.addEventListener('click', finish);

  // Rows are rendered — report the real content height so the parent can
  // size the iframe (and, having heard from us, actually show it).
  if (!IS_TAB) {
    postToParent({ type: 'bouncerOnboardingResize', height: document.body.scrollHeight });
  }
}

init().catch(err => console.error('[Onboarding] init failed:', err));
