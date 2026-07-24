// Dynamic content-script registration for optional platforms.
//
// Optional platforms (see `optional` in shared/platforms.ts) have no static
// content_scripts entry in the manifest — their host lives in
// optional_host_permissions and the user grants access at runtime via the
// platform toggle in settings. Once granted, the content script must be
// registered through chrome.scripting so it behaves exactly like the static
// ones.
//
// Registration lifetime: persistAcrossSessions keeps a registration alive
// across browser restarts, but Chrome drops all dynamic registrations on
// extension update/reload. The sync below therefore runs at every service
// worker startup (module top level) and reconciles reality — registered
// scripts on one side, granted origins on the other — rather than trying to
// track individual grant/revoke events.

import type { SiteId } from '../shared/platforms';
import { optionalPlatforms, optionalHostPatterns, contentScriptFiles } from '../shared/platforms';

const scriptId = (id: SiteId) => `bouncer-platform-${id}`;

async function isGranted(pattern: string): Promise<boolean> {
  try {
    return await chrome.permissions.contains({ origins: [pattern] });
  } catch {
    return false;
  }
}

/** Reconcile dynamic registrations with currently-granted host permissions:
 *  register scripts for granted optional platforms, unregister for revoked
 *  ones. Safe to call repeatedly. */
export async function syncOptionalPlatformScripts(): Promise<void> {
  const platforms = optionalPlatforms();
  // chrome.scripting is absent in polyfilled in-app contexts; nothing to do.
  if (platforms.length === 0 || !chrome.scripting?.registerContentScripts) return;

  const registered = await chrome.scripting.getRegisteredContentScripts({
    ids: platforms.map(p => scriptId(p.id)),
  });
  const registeredIds = new Set(registered.map(s => s.id));

  for (const p of platforms) {
    const granted = await isGranted(p.manifestHost);
    const id = scriptId(p.id);
    try {
      if (granted && !registeredIds.has(id)) {
        const files = contentScriptFiles(p);
        await chrome.scripting.registerContentScripts([{
          id,
          matches: [p.manifestHost],
          js: files.js,
          css: files.css,
          runAt: 'document_idle',
          persistAcrossSessions: true,
        }]);
        console.log(`[Background] Registered content script for ${p.id}`);
      } else if (!granted && registeredIds.has(id)) {
        await chrome.scripting.unregisterContentScripts({ ids: [id] });
        console.log(`[Background] Unregistered content script for ${p.id}`);
      }
    } catch (err) {
      console.error(`[Background] Failed to sync content script for ${p.id}:`, err);
    }
  }
}

/** Surface an in-context permission request for optional platforms the user
 *  hasn't granted yet, on the given tab.
 *
 *  chrome.permissions.addHostAccessRequest (Chrome 133+) puts a request chip
 *  on the extension's toolbar icon; clicking it runs the normal grant flow.
 *  We fire it as tabs navigate so an existing user who visits LinkedIn/YouTube
 *  is gently prompted right where they are — instead of the settings toggle
 *  being the only discovery path. Because these hosts live in
 *  optional_host_permissions (not host_permissions), shipping this in an
 *  update never disables the extension or forces re-approval.
 *
 *  We deliberately do NOT inspect the tab's URL: Bouncer has neither the
 *  "tabs" permission nor host permission for these sites, so changeInfo.url /
 *  tab.url are stripped to undefined for exactly the tabs we care about.
 *  (Adding "tabs" to read them would itself trigger the disable-on-update
 *  warning we're avoiding.) Instead we hand Chrome the pattern and let it
 *  match: the chip is only shown when the tab's URL matches, and the request
 *  is reset on cross-origin navigation — so re-issuing per navigation is both
 *  correct and idempotent. Granted platforms are skipped (their content
 *  script is already registered). The promise rejects when the request can't
 *  be surfaced (already pending/granted, unmatched tab); ignored. */
async function requestOptionalAccessForTab(tabId: number): Promise<void> {
  if (!chrome.permissions?.addHostAccessRequest) {
    console.log('[Background][hostreq] addHostAccessRequest unavailable (Chrome <133)');
    return;
  }
  for (const pattern of optionalHostPatterns()) {
    if (await isGranted(pattern)) {
      console.log(`[Background][hostreq] ${pattern}: already granted, skipping`);
      continue;
    }
    try {
      await chrome.permissions.addHostAccessRequest({ tabId, pattern });
      console.log(`[Background][hostreq] ${pattern}: request ACCEPTED by Chrome for tab ${tabId}`);
    } catch (err) {
      console.log(`[Background][hostreq] ${pattern}: request REJECTED for tab ${tabId}:`, err);
    }
  }
}

/** Wire up permission listeners and run an initial reconcile. Called once
 *  from the background entry point at service worker startup. */
export function initOptionalPlatforms(): void {
  // Prompt for access as tabs navigate. We fire once per navigation (on the
  // 'loading' status change) rather than on every onUpdated event; Chrome
  // only surfaces the chip when the tab's URL matches an optional platform's
  // pattern, so this is a no-op on unrelated sites.
  if (chrome.tabs?.onUpdated && typeof chrome.permissions?.addHostAccessRequest === 'function') {
    chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
      if (changeInfo.status !== 'loading' && changeInfo.status !== 'complete') return;
      console.log(`[Background][hostreq] onUpdated tab ${tabId} status=${changeInfo.status}`);
      requestOptionalAccessForTab(tabId).catch(() => { /* best-effort */ });
    });
  }

  // onAdded fires when the settings toggle's permissions.request() is
  // granted; onRemoved covers revocation via chrome://extensions. Both wake
  // the service worker, so the toggle needs no explicit message round-trip.
  if (chrome.permissions?.onAdded) {
    chrome.permissions.onAdded.addListener(() => {
      syncOptionalPlatformScripts().catch(err =>
        console.error('[Background] Optional platform sync failed:', err));
    });
  }
  if (chrome.permissions?.onRemoved) {
    chrome.permissions.onRemoved.addListener(() => {
      syncOptionalPlatformScripts().catch(err =>
        console.error('[Background] Optional platform sync failed:', err));
    });
  }
  syncOptionalPlatformScripts().catch(err =>
    console.error('[Background] Optional platform sync failed:', err));
}
