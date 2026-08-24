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
// How much of the source m4a to download for transcoding.
const FETCH_MAX_BYTES = 1_500_000;
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

export function installAudioFilter(): AudioFilterController {
  // No UI here — the terms are edited in the Bouncer settings popup, reached
  // from the reel-describer panel's gear (src/instagram/index.ts), which drives
  // us via setCategories.
  window.addEventListener('message', onHookMessage);
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
async function transcodeToOgg(buf: ArrayBuffer): Promise<{ ogg: Uint8Array<ArrayBuffer>; truncated: boolean } | null> {
  if (typeof AudioEncoder === 'undefined') return null;

  const ctx = new OfflineAudioContext(1, 1, 48000);
  const decoded = await ctx.decodeAudioData(buf);   // resampled to 48 kHz
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
    if (size + page.length > AUDIO_BYTE_BUDGET) break;
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

async function fetchClip(audioUrl: string): Promise<{ base64: string; truncated: boolean; mimeType: string }> {
  const res = await fetch(audioUrl, { headers: { Range: `bytes=0-${FETCH_MAX_BYTES - 1}` } });
  if (!res.ok) throw new Error(`audio fetch failed: HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
  if (buf.byteLength === 0) throw new Error('audio fetch returned 0 bytes');

  try {
    const result = await transcodeToOgg(buf);
    if (result) {
      return { base64: await bytesToBase64(result.ogg), truncated: result.truncated, mimeType: 'audio/ogg' };
    }
  } catch (err) {
    console.warn('[Bouncer IG audio] transcode failed, falling back to raw m4a:', (err as Error).message);
  }
  // Raw fallback: first RAW_FALLBACK_BYTES of the fmp4 (init segment leads the
  // file, so a byte-truncated prefix still decodes) — only ~3s of soundtrack.
  const bytes = new Uint8Array(buf, 0, Math.min(buf.byteLength, RAW_FALLBACK_BYTES));
  return { base64: await bytesToBase64(bytes), truncated: buf.byteLength > RAW_FALLBACK_BYTES, mimeType: 'audio/mp4' };
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
): Promise<{ base64: string; format: string } | null> {
  const filename = fileNameOf(thumbnailUrl);
  if (!filename) return null;
  if (clipCache.has(filename)) return clipCache.get(filename) ?? null;

  const audioUrl = audioUrls.get(filename);
  // The hook has not announced this reel's soundtrack yet, or it has none.
  // Not worth waiting for — the caller is describing a reel now.
  if (!audioUrl) return null;

  try {
    // Raced rather than awaited. Extraction is a network fetch and a WebCodecs
    // transcode, and the describer is on the critical path for what the user
    // reads next; the backend's own advice is to send without audio rather
    // than delay. A clip that misses this window still lands in the cache and
    // is used the next time the reel comes round.
    const clip = await Promise.race([
      fetchClip(audioUrl).then(({ base64, truncated, mimeType }) => {
        // A TRUNCATED clip is worse than no clip, and this is the one caller
        // where that matters. The filter route has always tolerated a cut-off
        // fmp4 because it only needs a few seconds of recognisable sound; the
        // describe route hands the same bytes to a model that has to decode
        // the whole container, and a byte-truncated one frequently will not
        // decode at all — the backend contract says so in as many words.
        //
        // This is not hypothetical. On device the WebCodecs transcode fails
        // ("Decoding failed") on every reel, so every clip was the raw fallback
        // cut at the byte budget, and every describe request carrying one came
        // back "Processing failed after multiple attempts".
        if (truncated) {
          console.warn(
            '[Bouncer IG audio] clip truncated — describing without audio rather '
            + 'than sending a container that may not decode');
          return null;
        }
        return { base64, format: mimeType === 'audio/ogg' ? 'ogg' : 'mp4' };
      }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ]);
    if (clip) clipCache.set(filename, clip);
    return clip;
  } catch {
    // Cached as "no audio" so a broken URL is not retried on every scroll-by.
    clipCache.set(filename, null);
    return null;
  }
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
      reel.card.style.display = 'none';
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
