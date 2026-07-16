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

import type { PlatformDef, SiteId } from '../shared/platforms';
import { optionalPlatforms, contentScriptFiles } from '../shared/platforms';

const scriptId = (id: SiteId) => `bouncer-platform-${id}`;

async function isGranted(p: PlatformDef): Promise<boolean> {
  try {
    return await chrome.permissions.contains({ origins: [p.manifestHost] });
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
    const granted = await isGranted(p);
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

/** Wire up permission listeners and run an initial reconcile. Called once
 *  from the background entry point at service worker startup. */
export function initOptionalPlatforms(): void {
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
