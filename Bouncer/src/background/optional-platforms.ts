// Dynamic content-script registration for optional platforms.
//
// Optional platforms (see `optionalTargets` in shared/platforms.ts) have no
// static content_scripts entry in the manifest — their host lives in
// optional_host_permissions and the user grants access at runtime via the
// platform toggle in settings. Once granted, the content script must be
// registered through chrome.scripting so it behaves exactly like the static
// ones.
//
// Registration lifetime: persistAcrossSessions keeps a registration alive
// across browser restarts, but Chrome drops all dynamic registrations on
// extension update/reload. The sync below therefore runs at every service
// worker startup (from the background entry point) and reconciles reality —
// registered scripts on one side, granted origins on the other — rather than
// trying to track individual grant/revoke events.

import type { PlatformDef, SiteId } from '../shared/platforms';
import { optionalPlatforms, contentScripts } from '../shared/platforms';

// One registration id per declared content script. Index 0 is the standard
// adapter + pipeline pair; higher indices are the platform's extras (e.g.
// Instagram's MAIN-world hook and reel-describer bundle).
const scriptId = (id: SiteId, index: number) =>
  index === 0 ? `bouncer-platform-${id}` : `bouncer-platform-${id}-${index}`;

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

  const registered = await chrome.scripting.getRegisteredContentScripts();
  const registeredIds = new Set(registered.map(s => s.id));

  for (const p of platforms) {
    const granted = await isGranted(p);
    const scripts = contentScripts(p);
    for (const [index, script] of scripts.entries()) {
      const id = scriptId(p.id, index);
      try {
        if (granted && !registeredIds.has(id)) {
          await chrome.scripting.registerContentScripts([{
            id,
            matches: [p.manifestHost],
            js: [...script.js],
            ...(script.css ? { css: [...script.css] } : {}),
            runAt: script.runAt ?? 'document_idle',
            ...(script.world ? { world: script.world } : {}),
            persistAcrossSessions: true,
          }]);
          console.log(`[Background] Registered content script ${id}`);
        } else if (!granted && registeredIds.has(id)) {
          await chrome.scripting.unregisterContentScripts({ ids: [id] });
          console.log(`[Background] Unregistered content script ${id}`);
        }
      } catch (err) {
        console.error(`[Background] Failed to sync content script ${id}:`, err);
      }
    }
  }
}

/** Wire up permission listeners and run an initial reconcile. Called once
 *  from the background entry point at service worker startup. */
export function initOptionalPlatforms(): void {
  const sync = (): void => {
    syncOptionalPlatformScripts().catch(err =>
      console.error('[Background] Optional platform sync failed:', err));
  };

  // onAdded fires when the settings toggle's permissions.request() is
  // granted; onRemoved covers revocation via chrome://extensions. Both wake
  // the service worker, so the toggle needs no explicit message round-trip.
  chrome.permissions?.onAdded?.addListener(sync);
  chrome.permissions?.onRemoved?.addListener(sync);
  sync();
}
