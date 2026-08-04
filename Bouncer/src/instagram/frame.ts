// Mid-reel frame capture — a still from the MIDDLE of a reel, for describing it.
//
// The describer used to send the cover thumbnail, which is whatever frame
// Instagram picked (often a title card or a face doing nothing) and frequently
// says little about what the reel actually is. A frame from the midpoint is a
// far better single-image summary.
//
// This is cheap because Instagram does the hard part for us: it fully buffers
// several reels ahead of the one you're watching. Measured on a live feed, every
// <video> in the DOM — including one 3000px below the fold — sat at
// readyState 4 with its entire duration buffered. So the frame is already
// decoded locally; we just seek, draw and encode. No CDN fetch, no DASH parsing.
//
// Canvas tainting is a non-issue: reel videos are blob:/MSE-backed, which counts
// as same-origin (the page supplied the bytes), so drawImage + toDataURL is
// allowed. Verified against the live site with getImageData, the strictest check.
//
// ...with one large caveat, also measured: Instagram keeps only 2-3 <video>
// elements in the DOM at a time — sampled repeatedly on a live feed, never the
// 5 the panel describes ahead. So the DOM alone can't cover the lookahead, no
// matter how the capture is tuned. For reels with no element yet, we fetch the
// reel's own video track and decode a frame out of it (fetchFrame below). The
// URL comes from the DASH manifest the MAIN-world hook already parses, and a
// content script with host permissions isn't subject to CORS — the same route
// the audio filter has used all along.

// Encoded width. Portrait reels are 1080x1920, so this yields ~160x284 — still
// plenty for "what is this reel about". Was 200px, which produced frames up to
// 23,904 b64 chars: under the budget on paper, but close enough to the
// gateway's 32KB whole-message cap that descriptions were landing only
// sometimes. Smaller frames, more of them getting answered.
const FRAME_WIDTH_PX = 160;

// The whole analyzeReel message has to clear AWS API Gateway's 32,768-byte
// WebSocket frame cap (see callImbueAudioFilter's note in background/providers).
// The caption can be 2,200 chars on its own, so leave real headroom: base64 is
// ~4/3 the byte size, making this budget roughly a 12KB JPEG. Deliberately far
// below what the cap allows: the caption, the data: prefix and the JSON
// envelope all ride along, and a message that overruns is silently never
// answered rather than rejected.
const MAX_FRAME_B64_CHARS = 16_000;

// Tried in order until one fits MAX_FRAME_B64_CHARS. A reel frame is a photo,
// so JPEG at moderate quality is the right trade; dropping quality degrades far
// more gracefully than dropping resolution for "what is this about".
const QUALITY_STEPS = [0.7, 0.55, 0.4, 0.28];

// How long to wait for a seek to land before giving up on the frame.
const SEEK_TIMEOUT_MS = 1200;

// ---- fetch-and-decode fallback ----

// Lowest-rendition reel clips run a few hundred KB. The cap is a guard against
// a long or unusually large one, not a target: past this we'd rather describe
// from the cover thumbnail than spend the user's bandwidth.
const MAX_VIDEO_BYTES = 2_500_000;
const FETCH_TIMEOUT_MS = 8_000;
const METADATA_TIMEOUT_MS = 4_000;
// Decoding is cheap but the fetches are not, and several reels get described at
// once. Two at a time keeps the lookahead filling without hogging the
// connection the feed itself is using.
const MAX_CONCURRENT_FETCHES = 2;

const HOOK_SOURCE = 'bouncer-ig-audio-hook';   // must match hook.ts

// Cover-image filename -> reel video URL, the same join key the audio filter
// uses. Populated from the hook; entries arrive before the reel is scrolled to.
const videoUrls = new Map<string, string>();
let inFlight = 0;

/** Subscribe to the MAIN-world hook. Call once at boot. */
export function installFrameSources(): void {
  window.addEventListener('message', (e: MessageEvent) => {
    const data = e.data as
      { source?: string; entries?: { filenames?: string[]; videoUrl?: string }[] } | null;
    if (e.source !== window || !data || data.source !== HOOK_SOURCE) return;
    for (const entry of data.entries ?? []) {
      if (!entry.videoUrl) continue;
      for (const f of entry.filenames ?? []) videoUrls.set(f, entry.videoUrl);
    }
  });
}

function fileNameOf(url: string): string | null {
  try {
    const path = new URL(url).pathname;
    const name = path.slice(path.lastIndexOf('/') + 1);
    return name || null;
  } catch {
    return null;
  }
}

/** Why a frame couldn't be taken, or the frame itself. Deliberately not
 *  `string | null`: a null return would let the caller fall back to the cover
 *  thumbnail without anyone ever learning that mid-reel capture had stopped
 *  working — the whole feature would rot silently. Every failure carries a
 *  reason, and the caller logs it. */
export type FrameResult =
  | { ok: true; base64: string; chars: number; quality: number }
  | { ok: false; reason: string };

function videoOf(card: HTMLElement): HTMLVideoElement | null {
  const video = card.querySelector('video');
  return video instanceof HTMLVideoElement ? video : null;
}

/** Seek and wait for the frame to actually be presented. Resolves false if the
 *  seek doesn't land in time — a stalled seek must not hold up the pipeline. */
function seekTo(video: HTMLVideoElement, time: number): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok: boolean): void => {
      if (done) return;
      done = true;
      video.removeEventListener('seeked', onSeeked);
      clearTimeout(timer);
      resolve(ok);
    };
    const onSeeked = (): void => finish(true);
    const timer = setTimeout(() => finish(false), SEEK_TIMEOUT_MS);
    video.addEventListener('seeked', onSeeked, { once: true });
    try {
      video.currentTime = time;
    } catch {
      finish(false);
    }
  });
}

/** Encode the canvas at the first quality that fits the frame budget. */
function encodeWithinBudget(canvas: HTMLCanvasElement):
    { base64: string; quality: number } | null {
  for (const quality of QUALITY_STEPS) {
    const url = canvas.toDataURL('image/jpeg', quality);
    const base64 = url.slice(url.indexOf(',') + 1);
    if (base64.length <= MAX_FRAME_B64_CHARS) return { base64, quality };
  }
  return null;
}

/** Draw a video's current frame and encode it. Shared by both capture paths so
 *  a fetched frame is indistinguishable from a DOM-captured one. */
function drawAndEncode(video: HTMLVideoElement): FrameResult {
  const width = Math.min(FRAME_WIDTH_PX, video.videoWidth);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = Math.max(1, Math.round(width * video.videoHeight / video.videoWidth));
  const ctx = canvas.getContext('2d');
  if (!ctx) return { ok: false, reason: 'no 2d canvas context' };
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  const encoded = encodeWithinBudget(canvas);
  if (!encoded) {
    return {
      ok: false,
      reason: `frame exceeded ${MAX_FRAME_B64_CHARS} b64 chars even at quality `
        + `${QUALITY_STEPS[QUALITY_STEPS.length - 1]}`,
    };
  }
  return {
    ok: true, base64: encoded.base64,
    chars: encoded.base64.length, quality: encoded.quality,
  };
}

/** Resolve on `event`, or false once `ms` elapses. */
function once(target: EventTarget, event: string, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok: boolean): void => {
      if (done) return;
      done = true;
      target.removeEventListener(event, handler);
      clearTimeout(timer);
      resolve(ok);
    };
    const handler = (): void => finish(true);
    const timer = setTimeout(() => finish(false), ms);
    target.addEventListener(event, handler, { once: true });
  });
}

/**
 * Decode a midpoint frame from the reel's own video file, for reels Instagram
 * hasn't mounted a <video> for.
 *
 * The whole (smallest) rendition is fetched rather than a byte range: the audio
 * filter can get away with a prefix because it only wants the opening, but a
 * midpoint seek needs bytes covering that timestamp. A blob: URL is same-origin,
 * so the decoded frame is as canvas-safe as a DOM one.
 */
async function fetchFrame(videoUrl: string): Promise<FrameResult> {
  if (inFlight >= MAX_CONCURRENT_FETCHES) {
    return { ok: false, reason: 'fetch slots busy' };
  }
  inFlight++;
  let objectUrl: string | null = null;
  const video = document.createElement('video');
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let bytes: Blob;
    try {
      const res = await fetch(videoUrl, { signal: controller.signal });
      if (!res.ok) return { ok: false, reason: `video fetch HTTP ${res.status}` };
      const declared = Number(res.headers.get('content-length')) || 0;
      if (declared > MAX_VIDEO_BYTES) {
        return { ok: false, reason: `clip too large (${declared} bytes)` };
      }
      bytes = await res.blob();
    } finally {
      clearTimeout(timer);
    }
    if (bytes.size === 0) return { ok: false, reason: 'video fetch returned 0 bytes' };
    if (bytes.size > MAX_VIDEO_BYTES) {
      return { ok: false, reason: `clip too large (${bytes.size} bytes)` };
    }

    objectUrl = URL.createObjectURL(bytes);
    video.muted = true;
    // iOS treats a <video> without playsinline as a fullscreen player and
    // declines to decode it inline — which is all this element is for. Harmless
    // everywhere else. Set as an attribute too: WebKit reads the attribute.
    video.playsInline = true;
    video.setAttribute('playsinline', '');
    video.preload = 'auto';
    video.src = objectUrl;
    // WebKit treats `preload` as a hint and often ignores it for a detached
    // element, so metadata would never arrive and the seek below would time
    // out. An explicit load() is the request the hint only suggests.
    video.load();
    if (!await once(video, 'loadedmetadata', METADATA_TIMEOUT_MS)) {
      return { ok: false, reason: 'fetched clip never reported metadata' };
    }
    if (!video.videoWidth || !Number.isFinite(video.duration) || video.duration <= 0) {
      return { ok: false, reason: 'fetched clip has no decodable video track' };
    }

    video.currentTime = video.duration / 2;
    if (!await once(video, 'seeked', SEEK_TIMEOUT_MS)) {
      return { ok: false, reason: 'fetched clip seek stalled' };
    }
    return drawAndEncode(video);
  } catch (err) {
    return { ok: false, reason: `fetch/decode: ${(err as Error).name}: ${(err as Error).message}` };
  } finally {
    inFlight--;
    video.removeAttribute('src');
    video.load();
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  }
}

/**
 * Grab a frame from the middle of this reel.
 *
 * Two routes, cheapest first: capture off the page's own <video> if there is
 * one, otherwise fetch and decode the reel's clip. The second exists because
 * Instagram keeps far fewer elements mounted than the panel looks ahead.
 *
 * `allowSeek` must be false for the reel the user is WATCHING — seeking that
 * one visibly jumps the video under them. Upcoming reels are paused and
 * off-screen, so they can be seeked freely; their `currentTime` is put back
 * afterwards so they don't start halfway through when the user arrives. It has
 * no bearing on the fetch route, which decodes its own detached element.
 *
 * Never throws. Returns a reason instead of a frame when one can't be taken —
 * see FrameResult on why that isn't just null.
 */
export async function captureMidFrame(
  card: HTMLElement,
  { allowSeek, thumbnailUrl }: { allowSeek: boolean; thumbnailUrl?: string },
): Promise<FrameResult> {
  const domResult = await captureFromDom(card, allowSeek);
  if (domResult.ok) return domResult;

  // No element to capture from — which is the common case for the far end of
  // the lookahead, not an edge case. Fall back to decoding the reel's own clip.
  const name = thumbnailUrl ? fileNameOf(thumbnailUrl) : null;
  const videoUrl = name ? videoUrls.get(name) : undefined;
  if (!videoUrl) {
    return { ok: false, reason: `${domResult.reason}; no video URL harvested for this reel` };
  }
  const fetched = await fetchFrame(videoUrl);
  if (fetched.ok) return fetched;
  // Report both attempts: which one failed, and how, is the whole diagnostic.
  return { ok: false, reason: `${domResult.reason}; fetch fallback: ${fetched.reason}` };
}

/** The cheap path: capture straight off the <video> the page already has. */
async function captureFromDom(card: HTMLElement, allowSeek: boolean): Promise<FrameResult> {
  try {
    const video = videoOf(card);
    if (!video) return { ok: false, reason: 'no <video> in the reel card' };
    // HAVE_CURRENT_DATA — there's a frame at the current position to draw.
    if (video.readyState < 2) {
      return { ok: false, reason: `not buffered yet (readyState ${video.readyState})` };
    }
    if (!video.videoWidth || !video.videoHeight) {
      return { ok: false, reason: 'video reports zero dimensions' };
    }

    const duration = video.duration;
    const seekable = allowSeek && Number.isFinite(duration) && duration > 0;
    const resumeAt = video.currentTime;
    let restore = false;

    if (seekable) {
      const midpoint = duration / 2;
      // Already near enough the middle — don't disturb it for nothing.
      if (Math.abs(video.currentTime - midpoint) > 0.25) {
        if (!await seekTo(video, midpoint)) {
          // Put it back; a stalled seek means no frame rather than a wrong one.
          if (Math.abs(video.currentTime - resumeAt) > 0.01) video.currentTime = resumeAt;
          return { ok: false, reason: `seek to ${midpoint.toFixed(1)}s stalled` };
        }
        restore = true;
      }
    }

    const result = drawAndEncode(video);
    // Leave the reel where we found it, so it plays from the start on arrival.
    if (restore) video.currentTime = resumeAt;
    return result;
  } catch (err) {
    // Includes the case that would matter most: a tainted canvas, which would
    // mean the same-origin assumption behind this whole approach had broken.
    return { ok: false, reason: `${(err as Error).name}: ${(err as Error).message}` };
  }
}
