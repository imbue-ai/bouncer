// Instagram MAIN-world hook — harvests per-reel AUDIO and VIDEO stream URLs.
//
// The reel <video> elements use blob:/MSE sources, so the DOM never exposes a
// fetchable media URL. But every reel's media object in Instagram's own
// GraphQL/API JSON responses carries `video_dash_manifest` — a DASH MPD with a
// separate audio-only AdaptationSet whose BaseURL is a plain CDN file we can
// fetch ahead of playback. This script runs in the page's MAIN world (content
// scripts can't see the page's fetches), wraps fetch/XHR, walks JSON responses
// for media objects, and posts { cover-image filenames -> audio URL } entries
// to the isolated-world content script via window.postMessage. The content
// script joins them to reel cards by the cover thumbnail's filename (the same
// key its reelIds are derived from).
//
// Everything is wrapped in try/catch — this must never break instagram.com.

const SOURCE = 'bouncer-ig-audio-hook';

interface HookEntry {
  filenames: string[];
  audioUrl: string;
  /** Lowest-bandwidth VIDEO track, when the manifest carries one. Lets the
   *  frame grabber decode a reel Instagram hasn't mounted a <video> for — it
   *  only ever keeps 2-3 in the DOM, far fewer than the panel describes ahead
   *  (see src/instagram/frame.ts). */
  videoUrl?: string;
  /** The reel's length in seconds, straight off the media object. Same reason
   *  as videoUrl: the chooser screen offers reels whose <video> isn't mounted,
   *  so their length can't be read from the DOM (see src/instagram/durations.ts). */
  durationSec?: number;
  /** The reel's shortcode — its own address, `/reels/<code>/`.
   *
   *  The one fact that makes a reel reachable without a gesture. Everything
   *  else the chooser does to move the feed is a synthetic swipe aimed at
   *  Instagram's pager, because on the layout it actually uses every slide
   *  sits in the same box and there is no scroll position that means "reel
   *  four". A URL has no such problem. Verified against the live page: every
   *  media object carries `code`, and the code of the reel on screen is
   *  exactly what the address bar reads. */
  code?: string;
}

// Sent by a consumer once its listeners are up, asking for everything harvested
// so far. See the replay note below.
const READY_SOURCE = 'bouncer-ig-hook-ready';   // must match durations.ts

// Media ids whose manifest we've already posted (responses repeat media).
const seenMedia = new Set<string>();
// Ids we've posted a length for. Deliberately separate from seenMedia: a
// duration-only sighting must not stop a later, richer payload for the same
// media from delivering its stream URLs.
const seenDuration = new Set<string>();

// What the hook has seen, posted alongside every batch so the isolated world
// can print it. The signed-in feed uses different endpoints and payload shapes
// than the logged-out one, and when lengths stop arriving there the question
// is WHERE the pipeline went quiet — no responses hooked, responses hooked but
// no media found, media found but dropped for want of a cover filename to join
// on, or the walk giving up before reaching them. Each of those was invisible.
const hookStats = {
  /** Interesting responses inspected, by channel. */
  responses: { fetch: 0, xhr: 0, inline: 0 } as Record<string, number>,
  /** Bodies that would not parse as JSON. */
  parseFailures: 0,
  /** Walks that hit the step cap before finishing — a payload bigger than the
   *  walker's budget, whose media past the cap were silently never seen. */
  walkTruncated: 0,
  /** First-sighting media objects carrying a dash manifest. */
  mediaWithManifest: 0,
  /** First-sighting media objects carrying only a bare video_duration. */
  mediaWithDuration: 0,
  /** Entries actually posted to consumers. */
  posted: 0,
  /** Media that had a manifest or a length but NO cover filename — nothing to
   *  join on, so they were dropped. A payload shape change looks like this. */
  droppedNoCover: 0,
  /** The keys of the first few cover-less media objects, to name the shape. */
  coverlessShapes: [] as string[],
};

function noteCoverless(obj: Record<string, unknown>): void {
  hookStats.droppedNoCover++;
  if (hookStats.coverlessShapes.length < 3) {
    hookStats.coverlessShapes.push(Object.keys(obj).slice(0, 14).join('|'));
  }
}

// Everything posted so far, kept for replay.
//
// This hook runs at document_start and scans the server-rendered payload at
// DOMContentLoaded; the content scripts that consume it boot at document_idle.
// So the FIRST screenful of reels — including the one you land on — was
// announced to nobody, and `seenMedia` guaranteed it was never announced again.
// The reel most likely to want its length was the one certain not to have it.
const announced: HookEntry[] = [];

function fileNameOf(url: string): string | null {
  try {
    const p = new URL(url).pathname;
    const name = p.slice(p.lastIndexOf('/') + 1);
    return name || null;
  } catch {
    return null;
  }
}

// Lowest-bandwidth Representation of one kind, by BaseURL.
//
// Lowest for both kinds, for the same reason from opposite directions: audio
// gets truncated to a byte cap, so fewer bits/sec buys more seconds of
// soundtrack; video is only ever decoded down to a ~200px still, so anything
// above the smallest rendition is bytes off the user's connection for detail
// that's thrown away.
function trackUrlFromManifest(xml: string, kind: 'audio' | 'video'): string | null {
  try {
    const doc = new DOMParser().parseFromString(xml, 'text/xml');
    const mimeRe = kind === 'audio' ? /^audio\// : /^video\//;
    const codecRe = kind === 'audio' ? /^(mp4a|opus)/ : /^(avc|hev|hvc|vp0?9|av01)/;
    let bestUrl: string | null = null;
    let bestBw = Infinity;
    for (const rep of Array.from(doc.getElementsByTagName('Representation'))) {
      const mime = rep.getAttribute('mimeType') ?? rep.parentElement?.getAttribute('mimeType') ?? '';
      const codecs = rep.getAttribute('codecs') ?? '';
      if (!mimeRe.test(mime) && !codecRe.test(codecs)) continue;
      const url = rep.getElementsByTagName('BaseURL')[0]?.textContent?.trim();
      if (!url) continue;
      const bw = Number(rep.getAttribute('bandwidth')) || Infinity;
      if (bestUrl === null || bw < bestBw) {
        bestBw = bw;
        bestUrl = url;
      }
    }
    return bestUrl;
  } catch {
    return null;
  }
}

// The reel's length off the MPD itself.
//
// A third source, because the other two leave a gap that shows: `video_duration`
// is not on every media object, and a reel below the fold has no <video> to
// measure. Reels in that gap displayed no length at all while their neighbours
// did — lengths worked "on some but not all". Every manifest we already parse
// for stream URLs carries mediaPresentationDuration, so this costs one regex on
// a string that's in hand.
function durationFromManifest(xml: string): number | undefined {
  try {
    const attr = /mediaPresentationDuration="([^"]+)"/.exec(xml);
    if (!attr) return undefined;
    // ISO 8601, e.g. PT1M12.345S. Reels are short, so days and beyond can't
    // occur — but hours are matched anyway rather than silently misreading one.
    const parts = /^P(?:[^T]*)T(?:([\d.]+)H)?(?:([\d.]+)M)?(?:([\d.]+)S)?$/.exec(attr[1]);
    if (!parts) return undefined;
    const seconds = (Number(parts[1]) || 0) * 3600
      + (Number(parts[2]) || 0) * 60
      + (Number(parts[3]) || 0);
    return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
  } catch {
    return undefined;
  }
}

// Every cover-image filename a media object goes by (image_versions2 on the
// app-API shape; display_url/thumbnail_src on older web-GraphQL shapes). These
// are the join key each consumer matches reel cards on.
function coverFilenames(obj: Record<string, unknown>): string[] {
  const filenames: string[] = [];
  const iv = obj.image_versions2 as { candidates?: { url?: string }[] } | undefined;
  for (const c of iv?.candidates ?? []) {
    const f = c?.url ? fileNameOf(c.url) : null;
    if (f) filenames.push(f);
  }
  for (const k of ['display_url', 'thumbnail_src', 'display_uri']) {
    const v = obj[k];
    if (typeof v === 'string') {
      const f = fileNameOf(v);
      if (f) filenames.push(f);
    }
  }
  return filenames;
}

// Walk any JSON payload for media-shaped objects: something carrying a
// video_dash_manifest (stream URLs) or a video_duration (length), plus
// cover-image URLs to join them to a reel by.
/** Where a batch of media came from. Carried through to the consumers purely so
 *  the on-device report can say which channel a length arrived on — "the lengths
 *  turn up eventually" is a very different bug depending on whether the ones for
 *  the first screenful were never seen or merely seen late. */
type HarvestSource = 'inline' | 'fetch' | 'xhr' | 'replay';

function harvest(root: unknown, via: HarvestSource): void {
  try {
    const found: HookEntry[] = [];
    const stack: unknown[] = [root];
    let steps = 0;
    while (stack.length > 0 && steps < 200_000) {
      const node = stack.pop();
      steps++;
      if (!node || typeof node !== 'object') continue;
      if (Array.isArray(node)) {
        for (const v of node) if (v && typeof v === 'object') stack.push(v);
        continue;
      }
      const obj = node as Record<string, unknown>;
      const rawManifest = obj.video_dash_manifest;
      const manifest = typeof rawManifest === 'string' && rawManifest.includes('<MPD')
        ? rawManifest
        : null;
      const rawDuration = obj.video_duration;
      const durationSec =
        typeof rawDuration === 'number' && Number.isFinite(rawDuration) && rawDuration > 0
          ? rawDuration
          : manifest ? durationFromManifest(manifest) : undefined;
      const code = typeof obj.code === 'string' && obj.code.length > 0 ? obj.code : undefined;
      const mediaId = obj.pk ?? obj.id;
      const idKey = typeof mediaId === 'string' || typeof mediaId === 'number'
        ? String(mediaId)
        : null;

      let postedStreams = false;
      if (manifest) {
        const key = idKey ?? manifest.slice(0, 128);
        if (!seenMedia.has(key)) {
          seenMedia.add(key);
          hookStats.mediaWithManifest++;
          const audioUrl = trackUrlFromManifest(manifest, 'audio');
          const videoUrl = trackUrlFromManifest(manifest, 'video');
          const filenames = coverFilenames(obj);
          // Worth posting if ANY field resolved: the audio filter needs
          // audioUrl, the frame grabber needs videoUrl, the length display needs
          // durationSec, and a manifest missing one shouldn't deny the others.
          // Each consumer guards on its own field.
          if ((audioUrl || videoUrl || durationSec) && filenames.length > 0) {
            found.push({
              filenames,
              audioUrl: audioUrl ?? '',
              ...(videoUrl ? { videoUrl } : {}),
              ...(durationSec ? { durationSec } : {}),
              ...(code ? { code } : {}),
            });
            postedStreams = true;
          } else if (filenames.length === 0) {
            noteCoverless(obj);
          }
        }
      }

      // A length with no dash manifest behind it. This used to be dropped on the
      // floor — the whole block above is gated on the manifest — which meant a
      // reel whose payload carries video_duration but streams its video some
      // other way had no length anywhere, since its <video> is not mounted until
      // you are nearly on it. Tracked in its own seen-set so a duration-only
      // sighting can't mask a later payload that does carry the streams.
      if (!postedStreams && (durationSec !== undefined || code !== undefined)
          && idKey !== null && !seenDuration.has(idKey)) {
        seenDuration.add(idKey);
        hookStats.mediaWithDuration++;
        const filenames = coverFilenames(obj);
        if (filenames.length > 0) {
          found.push({ filenames, audioUrl: '', durationSec, ...(code ? { code } : {}) });
        }
        else noteCoverless(obj);
      }

      for (const v of Object.values(obj)) if (v && typeof v === 'object') stack.push(v);
    }
    if (steps >= 200_000) hookStats.walkTruncated++;
    if (found.length > 0) {
      announced.push(...found);
      hookStats.posted += found.length;
      window.postMessage({ source: SOURCE, entries: found, via, stats: hookStats }, '*');
    }
  } catch {
    /* never break the page */
  }
}

// Only bother parsing responses that can contain media objects.
function isInterestingUrl(url: string): boolean {
  return /\/api\/|\/graphql/.test(url);
}

// ==================== fetch hook ====================

const origFetch = window.fetch;
const hookedFetch = async function (this: unknown, ...args: Parameters<typeof fetch>): Promise<Response> {
  const res = await origFetch.apply(this, args);
  try {
    const input = args[0];
    const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
    if (isInterestingUrl(url)) {
      hookStats.responses.fetch++;
      res.clone().json().then((json: unknown) => harvest(json, 'fetch'))
        .catch(() => { hookStats.parseFailures++; });
    }
  } catch {
    /* never break the page */
  }
  return res;
};

// ==================== XHR hook ====================

const xhrUrls = new WeakMap<XMLHttpRequest, string>();
// Intentional unbound prototype captures — re-invoked with .apply(this) below.
// eslint-disable-next-line @typescript-eslint/unbound-method
const origOpen = XMLHttpRequest.prototype.open;
// eslint-disable-next-line @typescript-eslint/unbound-method
const origSend = XMLHttpRequest.prototype.send;

const hookedOpen = function (this: XMLHttpRequest, ...args: unknown[]): void {
  try {
    const u = args[1];
    xhrUrls.set(this, typeof u === 'string' ? u : u instanceof URL ? u.href : '');
  } catch { /* ignore */ }
  return origOpen.apply(this, args as Parameters<typeof origOpen>);
};

const hookedSend = function (this: XMLHttpRequest, ...args: unknown[]): void {
  this.addEventListener('load', () => {
    try {
      const url = xhrUrls.get(this) ?? '';
      if (!isInterestingUrl(url)) return;
      if (this.responseType !== '' && this.responseType !== 'text') return;
      const text = this.responseText;
      if (!text || text.charAt(0) !== '{') return;
      hookStats.responses.xhr++;
      try {
        harvest(JSON.parse(text), 'xhr');
      } catch {
        hookStats.parseFailures++;
      }
    } catch { /* ignore */ }
  });
  return origSend.apply(this, args as Parameters<typeof origSend>);
};

// ==================== Server-rendered payloads ====================

// The first screenful of reels arrives embedded in inline script tags, not via
// fetch — scan those once the DOM is in.
//
// Two things here were too narrow, and between them they cost the first
// screenful its lengths. Measured on device: eight reels announced, none of them
// the six on screen, and the numbers appearing only after twenty seconds of
// swiping — which is the signature of the visible reels never being harvested at
// all while later, fetched batches were.
//
//   The MANIFEST test. A media object is worth harvesting if it carries a
//   duration, whether or not it also carries a dash manifest — and the inline
//   payload frequently has the first without the second. Every reel on screen
//   was skipped over a string that happened not to appear.
//
//   The TYPE selector. `script[type="application/json"]` is one of the shapes
//   Instagram embeds state in; it is not the only one.
//
// Cheap to widen: the guard is a substring test, and only scripts that pass it
// are parsed.
function scanInlineJson(): void {
  try {
    for (const s of Array.from(document.querySelectorAll('script'))) {
      const text = s.textContent;
      if (!text) continue;
      if (!text.includes('video_dash_manifest') && !text.includes('video_duration')) continue;
      hookStats.responses.inline++;
      try {
        harvest(JSON.parse(text), 'inline');
      } catch {
        // Not JSON on its own — a JS bootstrap that merely mentions the field.
        // Counted, because "inline 4, 0 posted" reads two ways without this:
        // media-free payloads, or payloads we could not read at all.
        hookStats.parseFailures++;
      }
    }
  } catch { /* ignore */ }
}

// ==================== Install ====================

// Self-guard by hostname before touching any page global. The extension
// manifest already scopes this bundle to instagram.com, but the iOS app injects
// every platform's page-world scripts into one WKWebView regardless of site —
// wrapping fetch/XHR on X or LinkedIn would be both useless and invasive.
// Regex mirrors src/shared/platforms.ts PLATFORM_RUNTIME.instagram.hostPattern.
if (/(^|\.)instagram\.com$/i.test(location.hostname)) {
  window.fetch = hookedFetch;
  XMLHttpRequest.prototype.open = hookedOpen;
  XMLHttpRequest.prototype.send = hookedSend;

  // A consumer booting later than us asks for what it missed, and gets the whole
  // accumulated set. Cheap — the entries are already built — and it is the only
  // way anything harvested before document_idle ever reaches them.
  window.addEventListener('message', (e: MessageEvent) => {
    try {
      const data = e.data as { source?: string } | null;
      if (e.source !== window || data?.source !== READY_SOURCE) return;
      // Re-scan first: a consumer asking for a replay has just booted, and
      // between our DOMContentLoaded pass and now the page may have embedded
      // more state — on a route change it certainly has.
      scanInlineJson();
      // Posted even with nothing to replay: an empty reply carrying stats is
      // how the other side learns "the hook is alive and found nothing",
      // which is a different diagnosis from "the hook never ran".
      window.postMessage({ source: SOURCE, entries: announced, via: 'replay', stats: hookStats }, '*');
    } catch { /* never break the page */ }
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', scanInlineJson);
  } else {
    scanInlineJson();
  }
}
