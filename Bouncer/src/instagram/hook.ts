// Instagram MAIN-world hook — harvests per-reel AUDIO stream URLs.
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

// Lowest-bandwidth audio Representation's BaseURL. Lowest because we may have
// to truncate the clip to the backend's size cap — fewer bits/sec = more
// seconds of soundtrack under the cap.
function audioUrlFromManifest(xml: string): string | null {
  try {
    const doc = new DOMParser().parseFromString(xml, 'text/xml');
    let bestUrl: string | null = null;
    let bestBw = Infinity;
    for (const rep of Array.from(doc.getElementsByTagName('Representation'))) {
      const mime = rep.getAttribute('mimeType') ?? rep.parentElement?.getAttribute('mimeType') ?? '';
      const codecs = rep.getAttribute('codecs') ?? '';
      if (!/^audio\//.test(mime) && !/^(mp4a|opus)/.test(codecs)) continue;
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
          const audioUrl = audioUrlFromManifest(manifest);
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
          if (audioUrl && filenames.length > 0) found.push({ filenames, audioUrl });
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
