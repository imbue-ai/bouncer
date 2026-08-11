// X Pixel install-conversion tracking.
//
// The official uwt.js snippet can't run anywhere in this extension: the
// background script is an MV3 service worker (no DOM, remote code banned in
// extension contexts), and x.com's page CSP allows neither
// static.ads-twitter.com in script-src nor the pixel image endpoints in
// img-src. What the page CSP does allow is connect-src to https://t.co and
// https://*.x.com — exactly the two hosts uwt.js reports to (it targets
// analytics.x.com when running on an x.com page). So instead of loading the
// tag, we replicate the single GET that `twq('event', <id>)` produces
// (uwt.js v2.4.1 wire format) and send it with fetch() from the content
// script, where X's first-party cookies ride along for ad attribution.
//
// Fires once per browser-extension install (Chrome/Safari/Firefox):
// background/index.ts arms `pendingInstallPixel` in onInstalled for
// reason === 'install' only, guarded by the durable `installPixelArmed`
// marker, the install flow opens x.com, and this consumes the flag. The
// iOS/Android app webviews never fire it — see isEmbeddedApp().
//
// The get-then-remove consume below is not atomic, so multiple x.com pages
// loading at once (session restore, prerender) can all read the flag before
// any remove lands — observed in Events Manager as same-second bursts. The
// flag's value is a per-install UUID sent as conversion_id, so X collapses
// those duplicates into a single conversion server-side.

import { getStorage, removeStorage } from '../shared/storage';
import { isEmbeddedApp } from '../shared/utils';

// Full event code from X Ads Events Manager ("tw-xxxxx-yyyyy").
// Empty (open-source builds) disables install tracking entirely.
const INSTALL_EVENT_ID = process.env.TWITTER_EVENT_ID || '';

export async function maybeFireInstallPixel(): Promise<void> {
  if (!INSTALL_EVENT_ID) return;
  // Never fire inside the iOS/Android app webviews: those aren't extension
  // installs, and their ChromePolyfill used to re-arm the flag on every page
  // load — devices that ran that old code still hold a stale armed flag in
  // persistent storage, so the arming-side guard alone isn't enough.
  if (isEmbeddedApp()) return;
  const { pendingInstallPixel } = await getStorage(['pendingInstallPixel']);
  if (!pendingInstallPixel) return;
  // Consume the flag before firing to narrow the window in which a second
  // x.com tab racing through here also fires (conversion_id makes any
  // survivors harmless).
  await removeStorage(['pendingInstallPixel']);

  // Installs that set the flag before it carried a UUID stored `true`; omit
  // conversion_id for those rather than inventing one per firing tab.
  const conversionId = typeof pendingInstallPixel === 'string' ? pendingInstallPixel : undefined;

  const params: Record<string, string> = {
    bci: '4',   // browser-context: snippet loader present (2) + config called (2)
    eci: '4',   // EventCodeImpl.ONETAG_EVENT
    event: JSON.stringify(conversionId ? { conversion_id: conversionId } : {}),
    event_id: crypto.randomUUID(),
    integration: 'advertiser',
    p_id: 'Twitter',
    p_user_id: '0',
    pl_id: crypto.randomUUID(),
    tw_document_href: location.href,
    tw_iframe_status: '0',
    txn_id: INSTALL_EVENT_ID,
    type: 'javascript',
    version: '2.4.1',
  };
  const title = document.title.trim().replace(/\s+/g, ' ').slice(0, 200);
  if (title) params.pt = title;

  const query = Object.keys(params).sort()
    .map(k => `${k}=${encodeURIComponent(params[k])}`)
    .join('&');

  // uwt.js reports to both hosts. Responses are opaque (no-cors) — delivery
  // is fire-and-forget.
  const bases = ['https://analytics.x.com/1/i/adsct', 'https://t.co/1/i/adsct'];
  await Promise.allSettled(bases.map(base =>
    fetch(`${base}?${query}`, {
      mode: 'no-cors',
      credentials: 'include',
      cache: 'no-store',
      keepalive: true,
    })
  ));
  console.log('[Bouncer] Install pixel fired:', INSTALL_EVENT_ID);
}
