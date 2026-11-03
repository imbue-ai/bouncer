// Single-platform activation page: one "Activate Bouncer on <X>" button,
// opened as a top-level tab (activate.html?platform=<id>) when the user flips
// an optional platform's toggle in Firefox's in-page settings modal. That
// modal is popup.html iframed on x.com, where Gecko gives extension pages only
// content-script privileges — no permissions API (Bugzilla 1443253) — and a
// gesture doesn't survive a message hop to the background (Bugzilla 1397658).
// A click on this page is a gesture in a full extension context, so the
// permission request can run directly.

import { optionalPlatforms, enabledStorageKey } from '../shared/platforms';
import type { PlatformDef } from '../shared/platforms';
import { setStorage } from '../shared/storage';

function init(p: PlatformDef): void {
  const label = `Activate Bouncer on ${p.displayName}`;
  document.title = label;
  const btn = document.getElementById('activateBtn') as HTMLButtonElement;
  const iconTemplate = document.getElementById(`platformIcon-${p.id}`);
  if (iconTemplate instanceof HTMLTemplateElement) {
    btn.appendChild(iconTemplate.content.cloneNode(true));
  }
  const text = document.createElement('span');
  text.textContent = label;
  btn.appendChild(text);

  // The click is the user gesture permissions.request() needs, so the
  // request must be the handler's first await. Granting takes the user
  // straight to the platform's feed (as the toggle does on Chrome); denying
  // leaves the button up for another try.
  btn.addEventListener('click', () => {
    (async () => {
      let granted = false;
      try {
        granted = await chrome.permissions.request({ origins: [p.manifestHost] });
      } catch (err) {
        console.error(`[Activate] Permission request for ${p.id} failed:`, err);
      }
      if (!granted) return;
      btn.disabled = true;
      await setStorage({ [enabledStorageKey(p.id)]: true });
      // Register the content script before landing on the feed.
      await chrome.runtime.sendMessage({ type: 'syncOptionalPlatforms' })
        .catch(err => console.error('[Activate] Platform sync failed:', err));
      location.replace(p.feedUrl);
    })().catch(err => console.error(`[Activate] Activating ${p.id} failed:`, err));
  });
}

const platformId = new URLSearchParams(location.search).get('platform');
const platform = optionalPlatforms().find(p => p.id === platformId);
if (platform) {
  init(platform);
} else {
  console.error(`[Activate] Unknown optional platform: ${platformId}`);
}
