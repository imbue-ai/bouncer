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
}

// Media ids whose manifest we've already posted (responses repeat media).
const seenMedia = new Set<string>();

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

// Walk any JSON payload for media-shaped objects: something carrying a
// video_dash_manifest plus cover-image URLs (image_versions2 on the app-API
// shape; display_url/thumbnail_src on older web-GraphQL shapes).
function harvest(root: unknown): void {
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
      const manifest = obj.video_dash_manifest;
      if (typeof manifest === 'string' && manifest.includes('<MPD')) {
        const mediaId = obj.pk ?? obj.id;
        const key = typeof mediaId === 'string' || typeof mediaId === 'number'
          ? String(mediaId)
          : manifest.slice(0, 128);
        if (!seenMedia.has(key)) {
          seenMedia.add(key);
          const audioUrl = trackUrlFromManifest(manifest, 'audio');
          const videoUrl = trackUrlFromManifest(manifest, 'video');
          const rawDuration = obj.video_duration;
          const durationSec =
            typeof rawDuration === 'number' && Number.isFinite(rawDuration) && rawDuration > 0
              ? rawDuration
              : undefined;
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
          // An entry is worth posting if ANY of the three resolved: the audio
          // filter needs audioUrl, the frame grabber needs videoUrl, the
          // chooser needs durationSec, and a manifest missing one shouldn't
          // deny the others. Each consumer guards on its own field.
          if ((audioUrl || videoUrl || durationSec) && filenames.length > 0) {
            found.push({
              filenames,
              audioUrl: audioUrl ?? '',
              ...(videoUrl ? { videoUrl } : {}),
              ...(durationSec ? { durationSec } : {}),
            });
          }
        }
      }
      for (const v of Object.values(obj)) if (v && typeof v === 'object') stack.push(v);
    }
    if (found.length > 0) window.postMessage({ source: SOURCE, entries: found }, '*');
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
      res.clone().json().then(harvest).catch(() => { /* not JSON */ });
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
      if (text && text.charAt(0) === '{') harvest(JSON.parse(text));
    } catch { /* ignore */ }
  });
  return origSend.apply(this, args as Parameters<typeof origSend>);
};

// ==================== Server-rendered payloads ====================

// The first screenful of reels arrives embedded in inline JSON script tags, not
// via fetch — scan those once the DOM is in.
function scanInlineJson(): void {
  try {
    for (const s of Array.from(document.querySelectorAll('script[type="application/json"]'))) {
      const text = s.textContent;
      if (!text || !text.includes('video_dash_manifest')) continue;
      try {
        harvest(JSON.parse(text));
      } catch { /* ignore */ }
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

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', scanInlineJson);
  } else {
    scanInlineJson();
  }
}
