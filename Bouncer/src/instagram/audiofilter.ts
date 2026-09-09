// Instagram reel AUDIO filter — experimental, deliberately rough & separate.
//
// The audio-flavored version of the tweetFilter pipeline: instead of text +
// image URLs, we ship the reel's soundtrack to the backend and ask whether it
// matches any of the user's audio filter categories (e.g. "explosion noises").
//
// PROACTIVE, not reactive: we never record playback. The MAIN-world hook
// (hook.ts) harvests each reel's audio-only DASH stream URL out of Instagram's
// own API responses and posts { cover filenames -> audio URL } entries here.
// When the feed scanner discovers a preloaded card (up to PREFETCH_MARGIN_PX
// below the viewport), we fetch that reel's audio bytes straight off the CDN,
// base64 them, and classify — so a matching reel is hidden BEFORE it is ever
// seen or heard.
//
// Data flow:
//   1. The user types audio categories into this box.
//   2. hook.ts (page world) posts audio stream URLs keyed by cover filename.
//   3. index.ts calls onReelDiscovered() for every new card it scans.
//   4. Once a discovered card has a known audio URL and >=1 category, we fetch
//      the audio and re-encode it to 12 kbps mono Ogg/Opus with WebCodecs.
//      The AWS API Gateway WebSocket hard-closes on any frame > 32 KB (code
//      1009) and Chrome sends each message as one frame, so the entire
//      audioFilter message must fit in 32 KB — raw m4a would cap us at ~3s,
//      re-encoded Opus fits ~15-25s (whole Ogg pages kept until the byte
//      budget is spent).
//   5. Clip goes to the background as `analyzeReelAudio` → imbue `audioFilter`
//      action (lambda/audio_filter.py → audio_filter_queue → Gemma audio
//      worker) → standard tweetFilter parse { shouldHide, reasoning, category }.
//   6. On a match, the card is hidden in place (if "hide matches" is on) and
//      the verdict is appended to the box's log either way.

import type { ContentToBackgroundMessage } from '../types';

// ==================== Tunables ====================

const HOOK_SOURCE = 'bouncer-ig-audio-hook';   // must match hook.ts
// The whole WS message (JSON envelope + base64 clip) must stay under the AWS
// API Gateway 32 KB frame limit or the gateway closes the socket (code 1009).
// 22,500 raw bytes → 30,000 b64 chars, leaving headroom for the envelope.
// (The server's own cap, 120,000 b64 chars, is far above this.)
const AUDIO_BYTE_BUDGET = 22_500;
// The describe path shares its 32 KB frame with the mid-reel frame (16,000 b64
// chars, see frame.ts) and the caption (up to 2,200 chars), so its clip gets a
// much smaller slice: 9,000 raw bytes → 12,000 b64 chars, keeping the worst
// case (16,000 + 2,200 + 12,000 + envelope) under the cap. An audioFilter
// message carries no frame, which is why it can afford AUDIO_BYTE_BUDGET.
const DESCRIBE_AUDIO_BYTE_BUDGET = 9_000;
// How much of the source m4a to download for transcoding.
const FETCH_MAX_BYTES = 1_500_000;
// The describe path's cap when its source is the reel's progressive MP4
// (muxed video+audio, so far bigger than an audio-only stream). WebKit's
// decoder — unlike Chrome's — rejects a truncated file outright (its header
// describes every sample; CoreAudio errors with packet descriptions pointing
// past the data, -50), so the progressive source is fetched whole-or-not-at-
// all: this cap is the walk-away point, checked against Content-Length before
// the body downloads, not a truncation point. Reels over it (roughly a
// minute-plus of 720p) fall through to the backend's own extraction.
const FETCH_MAX_BYTES_VIDEO = 20_000_000;
// Cap on how much soundtrack we even attempt to encode.
const MAX_ENCODE_SECONDS = 30;
const OPUS_BITRATE = 12_000;
// Fallback when WebCodecs is unavailable: send raw (truncated) m4a instead.
// At IG's lowest audio bitrate this is only ~3s of soundtrack.
const RAW_FALLBACK_BYTES = AUDIO_BYTE_BUDGET;
// Parallel CDN fetches + classifications.
const MAX_CONCURRENT = 2;
const MAX_ATTEMPTS = 2;

interface AudioVerdict {
  shouldHide?: boolean;
  matchedCategory?: string | null;
  reasoning?: string | null;
  error?: string;
}

export interface AudioFilterController {
  /** Notify the box that the scanner found a (possibly still off-screen) reel card. */
  onReelDiscovered(reelId: string, card: HTMLElement, thumbnailUrl: string): void;
  /** Replace the active audio filter terms (driven by the settings popover). */
  setCategories(next: string[]): void;
  /** Toggle whether matching reels are hidden before view. */
  setHideMatches(v: boolean): void;
}

// ==================== State ====================

const categories: string[] = [];
let hideMatches = true;

interface TrackedReel {
  reelId: string;
  card: HTMLElement;
  filename: string | null;   // cover thumbnail filename — join key to audioUrls
  state: 'waiting' | 'running' | 'done';
  attempts: number;
}

const reels = new Map<string, TrackedReel>();
const audioUrls = new Map<string, string>();   // cover filename -> audio stream URL
let running = 0;
let hiddenCount = 0;
let analyzedCount = 0;

// ==================== Public API ====================

/** The soundtrack-URL listener alone — passive, no filtering, no page
 *  mutations. Installed unconditionally (mirroring installDurationSource's
 *  rationale) because the describer's audio modality (clipForDescribe) reads
 *  the same map and starves when only the audio FILTER is switched off:
 *  gating this on installAudioFilter left audioUrls empty on every build
 *  with DISABLE_PAGE_MUTATIONS set, which is how reels went undescribed by
 *  their sound. */
let hookListenerInstalled = false;
export function installAudioHookListener(): void {
  if (hookListenerInstalled) return;
  hookListenerInstalled = true;
  window.addEventListener('message', onHookMessage);
}

export function installAudioFilter(): AudioFilterController {
  // No UI here — the terms are edited in the Bouncer settings popup, reached
  // from the reel-describer panel's gear (src/instagram/index.ts), which drives
  // us via setCategories.
  installAudioHookListener();
  return { onReelDiscovered, setCategories, setHideMatches };
}

// Replace the active terms and re-run analysis for any not-yet-hidden reel.
function setCategories(next: string[]): void {
  const cleaned = next.map((c) => c.trim()).filter(Boolean);
  categories.splice(0, categories.length, ...cleaned);
  requeueAll();
}

function setHideMatches(v: boolean): void {
  hideMatches = v;
}

function onReelDiscovered(reelId: string, card: HTMLElement, thumbnailUrl: string): void {
  if (reels.has(reelId)) return;
  reels.set(reelId, {
    reelId,
    card,
    filename: fileNameOf(thumbnailUrl),
    state: 'waiting',
    attempts: 0,
  });
  pump();
}

function onHookMessage(e: MessageEvent): void {
  const data = e.data as { source?: string; entries?: { filenames?: string[]; audioUrl?: string }[] } | null;
  if (e.source !== window || !data || data.source !== HOOK_SOURCE) return;
  for (const entry of data.entries ?? []) {
    if (!entry.audioUrl) continue;
    for (const f of entry.filenames ?? []) audioUrls.set(f, entry.audioUrl);
  }
  pump();
}

function fileNameOf(url: string): string | null {
  try {
    const p = new URL(url, location.href).pathname;
    const name = p.slice(p.lastIndexOf('/') + 1);
    return name || null;
  } catch {
    return null;
  }
}

// ==================== Queue ====================

// Start analyses for every waiting reel whose audio URL is known, up to the
// concurrency cap. Re-entrant: called on discovery, on hook data, on category
// edits, and on completion.
function pump(): void {
  if (categories.length === 0) return;
  for (const reel of reels.values()) {
    if (running >= MAX_CONCURRENT) break;
    if (reel.state !== 'waiting' || reel.attempts >= MAX_ATTEMPTS) continue;
    const audioUrl = reel.filename ? audioUrls.get(reel.filename) : undefined;
    if (!audioUrl) continue;
    reel.state = 'running';
    reel.attempts++;
    running++;
    void analyze(reel, audioUrl).finally(() => {
      running--;
      pump();
    });
  }
}

// Categories changed: previous verdicts are stale — re-run everything that
// isn't already hidden. (Un-hiding on category removal is out of scope.)
function requeueAll(): void {
  for (const reel of reels.values()) {
    if (reel.state === 'done' && reel.card.dataset.bouncerRemoved !== '1') {
      reel.state = 'waiting';
      reel.attempts = 0;
    }
  }
  pump();
}

// ==================== Transcode (WebCodecs → Ogg/Opus) ====================
//
// Validated live against Chrome: 12 kbps mono Opus in a hand-muxed Ogg
// container round-trips through decodeAudioData, and IG's fragmented m4a
// audio streams decode natively. Backend-side ffmpeg accepts 'ogg'.

// Ogg CRC-32: poly 0x04c11db7, no reflection, init/xorout 0.
const oggCrcTable = ((): Int32Array => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let j = 0; j < 8; j++) r = (r & 0x80000000) ? (r << 1) ^ 0x04c11db7 : r << 1;
    t[i] = r;
  }
  return t;
})();

function oggCrc32(bytes: Uint8Array): number {
  let crc = 0;
  for (const b of bytes) crc = ((crc << 8) ^ oggCrcTable[((crc >>> 24) & 0xff) ^ b]) | 0;
  return crc >>> 0;
}

const OGG_SERIAL = 0x424f554e;   // "BOUN"
const OPUS_FRAME_SAMPLES = 960;  // 20 ms @ 48 kHz (granule units are always 48 kHz)
const PACKETS_PER_PAGE = 50;

function makeOggPage(packets: Uint8Array[], granule: number, type: number, seq: number): Uint8Array {
  const segs: number[] = [];
  for (const p of packets) {
    let len = p.length;
    while (len >= 255) { segs.push(255); len -= 255; }
    segs.push(len);
  }
  const payloadLen = packets.reduce((a, p) => a + p.length, 0);
  const page = new Uint8Array(27 + segs.length + payloadLen);
  const dv = new DataView(page.buffer);
  page.set([0x4f, 0x67, 0x67, 0x53, 0], 0);   // "OggS", version 0
  page[5] = type;
  dv.setBigUint64(6, BigInt(granule), true);
  dv.setUint32(14, OGG_SERIAL, true);
  dv.setUint32(18, seq, true);
  page[26] = segs.length;
  page.set(segs, 27);
  let off = 27 + segs.length;
  for (const p of packets) { page.set(p, off); off += p.length; }
  dv.setUint32(22, oggCrc32(page), true);
  return page;
}

// Decode (any container Chrome understands) → mono 48 kHz PCM → Opus packets
// → Ogg pages, keeping whole pages until the byte budget is spent. Returns
// null when WebCodecs isn't available (caller falls back to raw m4a).
// (Uint8Array is generic over its buffer since TS 5.7; pin the backing store to
// a plain ArrayBuffer so these bytes stay assignable to BlobPart.)
async function transcodeToOgg(buf: ArrayBuffer, byteBudget = AUDIO_BYTE_BUDGET): Promise<{ ogg: Uint8Array<ArrayBuffer>; truncated: boolean } | null> {
  // Which half of WebCodecs is missing or failing is the whole iOS question —
  // this used to bail silently, leaving "no audio on device" unexplainable.
  if (typeof AudioEncoder === 'undefined') {
    console.warn('[Bouncer IG audio] transcode unavailable: AudioEncoder is undefined on this platform');
    return null;
  }

  const ctx = new OfflineAudioContext(1, 1, 48000);
  let decoded: AudioBuffer;
  try {
    decoded = await ctx.decodeAudioData(buf);   // resampled to 48 kHz
  } catch (err) {
    console.warn(
      `[Bouncer IG audio] decodeAudioData failed on ${buf.byteLength}B input: `
      + `${(err as Error).name}: ${(err as Error).message}`);
    throw err;
  }
  const totalFrames = decoded.length;
  const frames = Math.min(totalFrames, 48000 * MAX_ENCODE_SECONDS);
  const mono = new Float32Array(frames);
  for (let ch = 0; ch < decoded.numberOfChannels; ch++) {
    const d = decoded.getChannelData(ch);
    for (let i = 0; i < frames; i++) mono[i] += d[i] / decoded.numberOfChannels;
  }

  const packets: Uint8Array[] = [];
  let description: Uint8Array | null = null;
  const encodeErrors: Error[] = [];
  const encoder = new AudioEncoder({
    output: (chunk, meta) => {
      const desc = meta?.decoderConfig?.description;
      if (desc && !description) {
        description = desc instanceof ArrayBuffer
          ? new Uint8Array(desc.slice(0))
          : new Uint8Array((desc as ArrayBufferView).buffer.slice(
              (desc as ArrayBufferView).byteOffset,
              (desc as ArrayBufferView).byteOffset + (desc as ArrayBufferView).byteLength,
            ));
      }
      const b = new Uint8Array(chunk.byteLength);
      chunk.copyTo(b);
      packets.push(b);
    },
    error: (e) => { encodeErrors.push(e); },
  });
  encoder.configure({ codec: 'opus', sampleRate: 48000, numberOfChannels: 1, bitrate: OPUS_BITRATE });
  const BLOCK = OPUS_FRAME_SAMPLES * 25;   // feed ~0.5s at a time
  for (let i = 0; i < mono.length; i += BLOCK) {
    const slice = mono.subarray(i, Math.min(i + BLOCK, mono.length));
    encoder.encode(new AudioData({
      format: 'f32', sampleRate: 48000, numberOfFrames: slice.length,
      numberOfChannels: 1, timestamp: (i / 48000) * 1e6, data: slice,
    }));
  }
  await encoder.flush();
  encoder.close();
  if (encodeErrors.length > 0) throw encodeErrors[0];
  if (packets.length === 0) throw new Error('opus encoder produced no packets');

  // ID header: prefer the encoder's own OpusHead (correct pre-skip) over a
  // hand-built one.
  let head: Uint8Array;
  if (description !== null && (description as Uint8Array).length >= 19) {
    head = description;
  } else {
    head = new Uint8Array(19);
    head.set([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64, 1, 1]);   // "OpusHead" v1, 1ch
    new DataView(head.buffer).setUint16(10, 312, true);                  // default pre-skip
    new DataView(head.buffer).setUint32(12, 48000, true);
  }
  // "OpusTags" + vendor-string length/value + a zero user-comment count (the
  // trailing 4 zero bytes — libopusfile/ffmpeg reject the packet without it).
  const vendor = new TextEncoder().encode('bouncer');
  const tags = new Uint8Array(12 + vendor.length + 4);
  tags.set([0x4f, 0x70, 0x75, 0x73, 0x54, 0x61, 0x67, 0x73]);   // "OpusTags"
  new DataView(tags.buffer).setUint32(8, vendor.length, true);
  tags.set(vendor, 12);

  let seq = 0;
  const pages: Uint8Array[] = [
    makeOggPage([head], 0, 0x02, seq++),
    makeOggPage([tags], 0, 0x00, seq++),
  ];
  let size = pages[0].length + pages[1].length;

  // Group packets into pages; stop when the next page would bust the budget.
  // The final kept page is re-made with the EOS flag. Granule position is
  // cumulative decoded samples at 48 kHz (RFC 7845) — pre-skip samples are
  // part of the decoded output, so they are NOT added separately.
  let granule = 0;
  let kept = 0;
  let lastGroup: { packets: Uint8Array[]; granule: number } | null = null;
  for (let i = 0; i < packets.length; i += PACKETS_PER_PAGE) {
    const group = packets.slice(i, i + PACKETS_PER_PAGE);
    granule += group.length * OPUS_FRAME_SAMPLES;
    const page = makeOggPage(group, granule, 0x00, seq);
    if (size + page.length > byteBudget) break;
    if (lastGroup) pages.push(makeOggPage(lastGroup.packets, lastGroup.granule, 0x00, seq - 1));
    lastGroup = { packets: group, granule };
    size += page.length;
    seq++;
    kept += group.length;
  }
  if (!lastGroup) throw new Error('audio byte budget too small for one Ogg page');
  pages.push(makeOggPage(lastGroup.packets, lastGroup.granule, 0x04, seq - 1));

  const total = pages.reduce((a, p) => a + p.length, 0);
  const ogg = new Uint8Array(total);
  let off = 0;
  for (const p of pages) { ogg.set(p, off); off += p.length; }
  return { ogg, truncated: kept < packets.length || frames < totalFrames };
}

// ==================== Fetch → transcode → base64 → backend ====================

async function bytesToBase64(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error('base64 encode failed'));
    reader.readAsDataURL(new Blob([bytes]));
  });
  return dataUrl.slice(dataUrl.indexOf(',') + 1);
}

// Offset just past the last complete top-level box (ending on an mdat) that
// fits within maxBytes; 0 when no complete audio fragment fits. fmp4 layout is
// ftyp moov [sidx] (moof mdat)+ — a prefix cut between fragments is a valid,
// decodable file, unlike a cut mid-box.
function fmp4CleanPrefixEnd(buf: ArrayBuffer, maxBytes: number): number {
  const dv = new DataView(buf);
  let off = 0;
  let lastMdatEnd = 0;
  while (off + 8 <= buf.byteLength) {
    let size = dv.getUint32(off);
    const type = String.fromCharCode(
      dv.getUint8(off + 4), dv.getUint8(off + 5), dv.getUint8(off + 6), dv.getUint8(off + 7));
    if (size === 1 && off + 16 <= buf.byteLength) size = Number(dv.getBigUint64(off + 8));
    if (size < 8 || off + size > buf.byteLength || off + size > maxBytes) break;
    off += size;
    if (type === 'mdat') lastMdatEnd = off;
  }
  return lastMdatEnd;
}

// `decodable` is the describe path's contract: an Ogg is always whole pages
// with an EOS flag, and an m4a cut on a fragment boundary is a valid file, but
// an m4a cut at an arbitrary byte offset frequently won't decode server-side.
// `truncated` just means "shorter than the full soundtrack" (log flavour).
//
// `wholeFileOnly` is the WebKit mode: its decoder rejects a truncated file
// outright, so a partial fetch is unusable, not degraded. No Range header —
// Content-Length is CORS-readable where Content-Range is not — and a source
// bigger than fetchMax is abandoned immediately (one aborted request, no
// body), leaving that reel to the backend's own extraction.
async function fetchClip(audioUrl: string, byteBudget = AUDIO_BYTE_BUDGET, fetchMax = FETCH_MAX_BYTES, wholeFileOnly = false): Promise<{ base64: string; truncated: boolean; decodable: boolean; mimeType: string }> {
  let buf: ArrayBuffer;
  if (wholeFileOnly) {
    const ctrl = new AbortController();
    const res = await fetch(audioUrl, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`audio fetch failed: HTTP ${res.status}`);
    const len = Number(res.headers.get('Content-Length') ?? NaN);
    if (!Number.isFinite(len) || len > fetchMax) {
      ctrl.abort();
      throw new Error(
        `source is ${Number.isFinite(len) ? `${len}B` : 'of undisclosed size'} — over the ${fetchMax}B whole-file cap`);
    }
    buf = await res.arrayBuffer();
    console.debug(`[Bouncer IG audio] fetched ${buf.byteLength}B (whole file)`);
  } else {
    const res = await fetch(audioUrl, { headers: { Range: `bytes=0-${fetchMax - 1}` } });
    if (!res.ok) throw new Error(`audio fetch failed: HTTP ${res.status}`);
    buf = await res.arrayBuffer();
    // A 206 honouring our range returns exactly fetchMax bytes when the file
    // is bigger; anything shorter means the server ran out of file first.
    console.debug(
      `[Bouncer IG audio] fetched ${buf.byteLength}B (${buf.byteLength < fetchMax ? 'complete file' : `truncated at cap ${fetchMax}`})`);
  }
  if (buf.byteLength === 0) throw new Error('audio fetch returned 0 bytes');

  try {
    const result = await transcodeToOgg(buf, byteBudget);
    if (result) {
      return { base64: await bytesToBase64(result.ogg), truncated: result.truncated, decodable: true, mimeType: 'audio/ogg' };
    }
  } catch (err) {
    console.warn('[Bouncer IG audio] transcode failed, falling back to raw m4a:', (err as Error).message);
  }
  // Raw fallback: a prefix of the fmp4, cut on a fragment boundary when one
  // fits the budget (decodable), else at the raw byte budget (the filter
  // tolerates that; the describer refuses it). Only a few seconds of sound.
  const cleanEnd = fmp4CleanPrefixEnd(buf, Math.min(byteBudget, RAW_FALLBACK_BYTES));
  if (cleanEnd > 0) {
    const bytes = new Uint8Array(buf, 0, cleanEnd);
    return { base64: await bytesToBase64(bytes), truncated: buf.byteLength > cleanEnd, decodable: true, mimeType: 'audio/mp4' };
  }
  console.warn(`[Bouncer IG audio] no complete fmp4 fragment fits ${byteBudget}B — arbitrary cut`);
  const bytes = new Uint8Array(buf, 0, Math.min(buf.byteLength, byteBudget, RAW_FALLBACK_BYTES));
  return { base64: await bytesToBase64(bytes), truncated: buf.byteLength > bytes.byteLength, decodable: false, mimeType: 'audio/mp4' };
}

/** A short clip of a reel's soundtrack, for the describer.
 *
 *  The same extraction the filter uses — fetch, transcode to a small Opus/ogg,
 *  base64 — exposed for the OTHER caller now that reel descriptions are
 *  generated from image + caption + audio in one call rather than from the
 *  frame alone. What is said in a reel is very often the only place its subject
 *  appears at all: a talking head over a static frame with no caption is
 *  otherwise indescribable, and the whole thing came back as "a person
 *  talking".
 *
 *  Returns null rather than throwing, on every path. A description with no
 *  audio is the previous behaviour and perfectly serviceable; a description
 *  that never arrives because the soundtrack 404'd is not. The backend takes
 *  the field as optional for exactly this reason.
 *
 *  Cached by reel: the filter and the describer both want the same clip, and a
 *  reel scrolled past twice should not be fetched twice.
 */
const clipCache = new Map<string, { base64: string; format: string } | null>();

export async function clipForDescribe(
  thumbnailUrl: string,
  timeoutMs: number,
  videoUrl?: string | null,
): Promise<{ base64: string; format: string } | null> {
  // Every no-audio path says why, at warn. A describe that goes out silent is
  // indistinguishable from the modality not being wired at all — that exact
  // ambiguity is how a whole release shipped with audio never riding along.
  const filename = fileNameOf(thumbnailUrl);
  if (!filename) {
    console.warn('[Bouncer IG audio] describe skipped audio: no filename in', thumbnailUrl);
    return null;
  }
  if (clipCache.has(filename)) {
    const cached = clipCache.get(filename) ?? null;
    if (!cached) console.warn('[Bouncer IG audio] describe skipped audio: cached as no-clip for', filename);
    return cached;
  }

  // The audio-only stream when the hook announced one; the reel's progressive
  // MP4 otherwise. The progressive file is muxed video+audio, so only the
  // transcode path can make a clip of it (a byte-budget slice of it is video
  // bytes; fetchClip's raw fallback correctly refuses that as undecodable) —
  // but WHETHER the transcode works on it on this platform is exactly what
  // wants measuring, not assuming: the one recorded decode failure on device
  // was against the fragmented audio-only stream, a different container.
  const audioUrl = audioUrls.get(filename);
  const sourceUrl = audioUrl ?? videoUrl;
  if (!sourceUrl) {
    console.warn(
      `[Bouncer IG audio] describe skipped audio: hook announced no soundtrack for ${filename} `
      + `(${audioUrls.size} announced in total) and no video URL to fall back on`);
    return null;
  }
  if (!audioUrl) {
    console.warn(`[Bouncer IG audio] no announced soundtrack for ${filename} — trying the progressive video URL`);
  }

  // Raced rather than awaited. Extraction is a network fetch and a WebCodecs
  // transcode, and the describer is on the critical path for what the user
  // reads next; the backend's own advice is to send without audio rather
  // than delay. Caching happens inside the fetch chain, not after the race,
  // so a clip that misses this window still lands in the cache and is used
  // the next time the reel comes round.
  const pending = fetchClip(
    sourceUrl, DESCRIBE_AUDIO_BYTE_BUDGET,
    // The progressive file must arrive WHOLE to decode on WebKit (hence
    // whole-file mode with its Content-Length walk-away check); the audio-only
    // stream is small enough that the default cap already fetches all of it.
    audioUrl ? FETCH_MAX_BYTES : FETCH_MAX_BYTES_VIDEO,
    /* wholeFileOnly */ !audioUrl)
    .then(({ base64, decodable, mimeType }) => {
      // An UNDECODABLE clip is worse than no clip, and this is the one caller
      // where that matters. The filter route has always tolerated a cut-off
      // fmp4 because it only needs a few seconds of recognisable sound; the
      // describe route hands the same bytes to a model that has to decode the
      // whole container — sending arbitrary-cut m4a made every describe come
      // back "Processing failed after multiple attempts" on device (WebCodecs
      // fails there, so every clip is the raw fallback). Cleanly shortened
      // Ogg / fragment-boundary m4a are valid files and go through.
      const clip = decodable
        ? { base64, format: mimeType === 'audio/ogg' ? 'ogg' : 'mp4' }
        : null;
      if (!clip) {
        console.warn(
          '[Bouncer IG audio] clip not decodable — describing without audio rather '
          + 'than sending a container that may not decode');
      }
      clipCache.set(filename, clip);
      return clip;
    })
    .catch((err: Error) => {
      // Cached as "no audio" so a broken URL is not retried on every scroll-by.
      console.warn(`[Bouncer IG audio] clip extraction failed for ${filename}: ${err.message}`);
      clipCache.set(filename, null);
      return null;
    });
  const clip = await Promise.race([
    pending,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
  ]);
  // A null here with no cache entry is the deadline, not a failure: the fetch
  // chain is still running and will cache for the next describe of this reel.
  if (!clip && !clipCache.has(filename)) {
    console.warn(`[Bouncer IG audio] describe skipped audio: clip missed ${timeoutMs}ms deadline for ${filename} — will ride along next time`);
  }
  return clip;
}

async function analyze(reel: TrackedReel, audioUrl: string): Promise<void> {
  try {
    const { base64, truncated, mimeType } = await fetchClip(audioUrl);

    const message: ContentToBackgroundMessage = {
      type: 'analyzeReelAudio',
      audioBase64: base64,
      mimeType,
      categories: [...categories],
    };
    const res: AudioVerdict | undefined = await chrome.runtime.sendMessage(message);

    if (!res || res.error) {
      reel.state = reel.attempts < MAX_ATTEMPTS ? 'waiting' : 'done';
      logResult(reel.reelId, { error: res?.error ?? 'no response' });
      return;
    }

    reel.state = 'done';
    analyzedCount++;
    if (res.shouldHide && hideMatches && reel.card.isConnected) {
      reel.card.dataset.bouncerRemoved = '1';
      // Collapse only below the fold, where nothing visible moves. A match on
      // the reel being WATCHED (analysis usually runs ahead, but not always)
      // must not snap the next reel into its place — it is marked instead, and
      // the adapter's scroll-past fade takes it once the user has moved on.
      reel.card.dataset.filteredByExtension = 'true';
      const rect = reel.card.getBoundingClientRect();
      if (rect.height < 1 || rect.top >= window.innerHeight) {
        reel.card.style.display = 'none';
      }
      hiddenCount++;
    }
    logResult(reel.reelId, res, truncated);
  } catch (err) {
    reel.state = reel.attempts < MAX_ATTEMPTS ? 'waiting' : 'done';
    logResult(reel.reelId, { error: (err as Error).message });
  }
}

// ==================== Diagnostics ====================
//
// The audio filter has no UI of its own: terms are edited in the Bouncer
// settings popup (reached via the describer panel's gear) and matching reels
// simply vanish before you reach them. Verdicts go to the console so the
// pipeline stays inspectable while it's experimental.

function logResult(reelId: string, verdict: AudioVerdict, truncated = false): void {
  const shortId = reelId.split('/').pop() ?? reelId;
  if (verdict.error) {
    console.warn(`[Bouncer IG audio] ${shortId} — error: ${verdict.error}`);
    return;
  }
  const outcome = verdict.shouldHide
    ? `MATCH ${verdict.matchedCategory ?? '(unnamed category)'}${hideMatches ? ' — hidden before view' : ''}`
    : `no match${truncated ? ' (clip truncated)' : ''}`;
  console.log(
    `[Bouncer IG audio] ${shortId} — ${outcome}` +
    (verdict.reasoning ? ` — ${verdict.reasoning}` : '') +
    ` · ${audioUrls.size} streams found, ${analyzedCount} analyzed, ${hiddenCount} hidden`,
  );
}
