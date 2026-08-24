// How long each reel runs.
//
// The paused card and the transition chooser both want to show a reel's length
// before you commit to watching it — and for the chooser that means reels you
// haven't reached yet, which is the hard half. Instagram only ever keeps 2-3
// <video> elements mounted (see the note in ./frame.ts), so for most of the
// rows on the chooser screen there is no media element to read `duration` off.
//
// So lengths come from three sources, joined on the same key everything else in
// this pipeline uses — the cover thumbnail's filename:
//
//   1. Instagram's own API JSON, which carries `video_duration` on every media
//      object. The MAIN-world hook (./hook.ts) already walks those responses
//      for stream URLs; it posts the duration alongside. This covers reels far
//      below the fold, which is what the chooser needs.
//   2. A mounted <video>'s `duration`, once its metadata loads. Authoritative,
//      but only ever available for the reel you're on and its neighbours.
//   3. The reel's own video file, asked directly — see probeDuration.
//
// The third exists because the first two leave a gap that shows. Not every
// media object carries `video_duration`, not every response goes past the hook
// before the reel is rendered, and a reel below the fold has no <video> to
// measure — so lengths appeared on some rows and not others, with nothing to
// say why. The gap is exactly the case where we DO have the reel's stream URL
// (the same hook posts it) and simply never asked it anything: a video element
// pointed at that URL with `preload="metadata"` reads the file's header, which
// is a few kilobytes and contains the duration.
//
// Still not guaranteed — a reel the hook never saw at all has no length from
// any of the three, and the callers render without one rather than guessing.

const HOOK_SOURCE = 'bouncer-ig-audio-hook';   // must match hook.ts
const HOOK_READY_SOURCE = 'bouncer-ig-hook-ready';   // must match hook.ts

// Cover thumbnail filename -> length in seconds, and the same by stem. See
// stemOf: the filename is the exact key and the stem is the forgiving one.
const byFilename = new Map<string, number>();
const byStem = new Map<string, number>();
// Cover thumbnail filename -> the reel's video URL, for probeDuration. Same
// entries the lengths arrive in; kept whether or not one came with them.
const videoUrlByFilename = new Map<string, string>();
const videoUrlByStem = new Map<string, string>();
// Cover thumbnail filename -> the reel's shortcode, which is its own address:
// `/reels/<code>/`. Kept here because this module already owns the join between
// a cover filename and everything the hook knows about that reel, exact key and
// forgiving stem alike. See reelCodeFor.
const codeByFilename = new Map<string, string>();
const codeByStem = new Map<string, string>();
// Filenames already asked. One probe per reel, ever — a reel whose header we
// couldn't read is not going to become readable by asking again.
const probed = new Set<string>();

// Same join key the audio filter and frame grabber use: the last path segment
// of the cover thumbnail URL, which survives query-string token refreshes.
function fileNameOf(url: string): string | null {
  try {
    const p = new URL(url, location.href).pathname;
    const name = p.slice(p.lastIndexOf('/') + 1);
    return name || null;
  } catch {
    return null;
  }
}

/** The numbers that identify a cover, with everything else thrown away.
 *
 *  The exact filename is the right key when it matches, and on this feed it
 *  frequently doesn't: the payload names a cover one way and the page requests
 *  it another — a size prefix, a different `t51.x-15` bucket, a `_s`/`_e35`
 *  suffix on the renditions. Measured on device, EVERY length arrived and NONE
 *  of them joined: eight reels announced with a duration each, zero rows with a
 *  number on them.
 *
 *  What survives all of that is the ids: `658397544_2494782664325741_...`. Two
 *  filenames sharing those long digit runs are two renditions of one cover. */
function stemOf(filename: string): string | null {
  const digits = filename.match(/\d{6,}/g);
  return digits && digits.length > 0 ? digits.join('_') : null;
}

/** Where a length came from. Each answers a different "why was it late".
 *
 *   inline   the server-rendered payload — should be instant, present at boot
 *   fetch    a later API response, i.e. Instagram fetched this reel's batch
 *   xhr      the same, over XHR
 *   replay   the hook re-announcing what it harvested before we were listening
 *   video    measured off a mounted <video>, so only for a reel you are near
 *   probe    we went and read the file header ourselves, last resort
 */
export type DurationSource = 'inline' | 'fetch' | 'xhr' | 'replay' | 'video' | 'probe' | 'unknown';

/** When a reel's length was wanted and when it turned up.
 *
 *  The interesting number is not how long a length took to arrive — most arrive
 *  before anything asks, and that is invisible and free. It is how long a row
 *  sat on screen with a blank where the time goes, which is `firstAskedAt` to
 *  `resolvedAt`. A length that resolves before its first ask has a wait of zero
 *  by definition, however long it actually took. */
interface Timing {
  firstAskedAt?: number;
  asks: number;
  resolvedAt?: number;
  source?: DurationSource;
}

const timings = new Map<string, Timing>();

function timingFor(filename: string): Timing {
  let timing = timings.get(filename);
  if (!timing) {
    timing = { asks: 0 };
    timings.set(filename, timing);
  }
  return timing;
}

function record(filename: string, seconds: unknown, source: DurationSource = 'unknown'): void {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return;
  const previous = byFilename.get(filename);
  byFilename.set(filename, seconds);
  const stem = stemOf(filename);
  if (stem) byStem.set(stem, seconds);

  // Tell whatever is on screen. This was the lag: only the network probe
  // announced, and probes stopped running the moment the hook join started
  // working — so a length that arrived after a row had rendered sat in the map,
  // correct and invisible, until something unrelated happened to re-render.
  // Most lengths arrive that way: the payload for the reels below the fold
  // lands while you are looking at the chooser.
  //
  // Only on a CHANGE, which is not an optimisation but the thing that stops
  // this recursing. Announcing re-renders the chooser, which re-reads every
  // row, which re-runs the mounted-<video> sweep, which records the same
  // numbers again — announcing unconditionally would be an infinite loop
  // through three modules.
  if (previous === seconds) return;

  // Timing, and the one line worth printing per reel: a row that was rendered
  // blank has just been filled in, and how long it stayed blank is the whole
  // question. Reels nobody had asked about yet resolve silently — they are the
  // majority and they cost nothing.
  const timing = timingFor(filename);
  if (timing.resolvedAt === undefined) {
    timing.resolvedAt = performance.now();
    timing.source = source;
    if (timing.firstAskedAt !== undefined) {
      const waited = Math.round(timing.resolvedAt - timing.firstAskedAt);
      console.debug(
        `[Bouncer IG] length arrived after ${waited}ms blank `
        + `(${timing.asks} render${timing.asks === 1 ? '' : 's'} without it, via ${source}): `
        + filename);
    }
  }
  scheduleAnnounce();
}

function rememberCode(filename: string, code: string): void {
  codeByFilename.set(filename, code);
  const stem = stemOf(filename);
  if (stem) codeByStem.set(stem, code);
}

function rememberVideoUrl(filename: string, url: string): void {
  videoUrlByFilename.set(filename, url);
  const stem = stemOf(filename);
  if (stem) videoUrlByStem.set(stem, url);
}

/** Look a filename up in both maps: exactly first, then by stem. */
function lookup<T>(exact: Map<string, T>, loose: Map<string, T>, filename: string): T | null {
  const hit = exact.get(filename);
  if (hit !== undefined) return hit;
  const stem = stemOf(filename);
  return (stem === null ? undefined : loose.get(stem)) ?? null;
}

/** Start listening to the MAIN-world hook for reel lengths. Cheap and passive —
 *  installed even when the fullscreen flow is off, so a rotation into it finds
 *  the lengths already collected. */
export function installDurationSource(): void {
  window.addEventListener('message', (e: MessageEvent) => {
    const data = e.data as {
      source?: string;
      via?: string;
      entries?: {
        filenames?: string[]; durationSec?: number; videoUrl?: string; code?: string;
      }[];
      stats?: HookStats;
    } | null;
    if (e.source !== window || !data || data.source !== HOOK_SOURCE) return;
    // The hook's own accounting rides along on every batch; keep the latest.
    if (data.stats) hookStats = data.stats;
    const via = data.via ?? 'unknown';
    const channel = byChannel[via] ?? (byChannel[via] = {
      count: 0, firstAt: performance.now(), lastAt: performance.now(),
    });
    channel.count += data.entries?.length ?? 0;
    channel.lastAt = performance.now();
    for (const entry of data.entries ?? []) {
      stats.announced++;
      if (entry.durationSec !== undefined) stats.withLength++;
      if (entry.videoUrl) stats.withUrl++;
      for (const f of entry.filenames ?? []) {
        record(f, entry.durationSec, via as DurationSource);
        // Kept even when this entry carried a length: the URL is what makes a
        // MISSING length recoverable later, and by then the entry is gone.
        if (entry.videoUrl) rememberVideoUrl(f, entry.videoUrl);
        // The shortcode is how a pick reaches this reel without a gesture —
        // kept whatever else the entry carried.
        if (entry.code) rememberCode(f, entry.code);
      }
      // And if it arrived without one, go and get it NOW.
      //
      // This is the difference between a length that is there when you look and
      // one that turns up later. Instagram announces a whole batch of reels in
      // one response, long before any of them is on screen — so the moment to
      // ask is here, while the reel is a name in a payload, rather than when a
      // row for it is being built and the answer is needed this frame.
      const first = entry.filenames?.[0];
      if (first !== undefined && entry.durationSec === undefined && entry.videoUrl) {
        void probeFilename(first);
      }
    }
  });
}

/** Told when a length lands from something asynchronous, so whatever is on
 *  screen can render it. */
const listeners = new Set<() => void>();

export function onDurationResolved(listener: () => void): void {
  listeners.add(listener);
}

function announce(): void {
  for (const listener of listeners) listener();
}

/** Coalesce a burst into one notification.
 *
 *  A single hook payload carries a whole batch of reels, and each one lands
 *  through `record`. Announcing per entry would rebuild the chooser once per
 *  reel in the batch — a dozen renders in one tick, all but the last of them
 *  thrown away. A microtask is the right grain: it runs after the batch and
 *  before the frame is painted, so the rows are right the first time they are
 *  seen. */
let announceQueued = false;

function scheduleAnnounce(): void {
  if (announceQueued) return;
  announceQueued = true;
  queueMicrotask(() => {
    announceQueued = false;
    announce();
  });
}

/** Ask the MAIN-world hook to re-announce everything it harvested before we
 *  were listening.
 *
 *  The hook runs at document_start and scans the server-rendered payload at
 *  DOMContentLoaded; every consumer of it boots at document_idle. Without this
 *  the first screenful of reels — the one you land on — is announced to nobody
 *  and, thanks to the hook's own dedupe, never announced again. Call it once all
 *  listeners are installed; the replay reaches every consumer, not just this one. */
export function requestHookReplay(): void {
  window.postMessage({ source: HOOK_READY_SOURCE }, '*');
}

/** Record a length read straight off a mounted <video>. Overwrites the hook's
 *  value: this one is measured from the media actually being played. */
export function noteDuration(thumbnailUrl: string, seconds: number): void {
  const f = fileNameOf(thumbnailUrl);
  if (f) record(f, seconds, 'video');
}

// Counters, for the on-device report. Lengths have three sources and when a row
// has no number the only useful question is which of them came up short — and
// that is invisible from the outside, because "the hook never mentioned this
// reel" and "the hook mentioned it with no length and no URL to ask" and "we
// asked and the fetch failed" all look identical: a row with no number on it.
const stats = { announced: 0, withLength: 0, withUrl: 0, probes: 0, probed_ok: 0 };
/** Announcements by channel — see HarvestSource in ./hook.ts — with WHEN they
 *  arrived. "The lengths turn up eventually" means one thing if the first
 *  screenful's payload was never harvested and quite another if it was
 *  harvested late, and "slowly" is a claim about these timestamps. */
const byChannel: Record<string, { count: number; firstAt: number; lastAt: number }> = {};

/** The hook's own accounting, posted alongside every batch — see hookStats in
 *  ./hook.ts. Null until the first batch (or replay) arrives, which is itself
 *  a diagnosis: the hook never ran, or predates the stats. */
interface HookStats {
  responses?: Record<string, number>;
  parseFailures?: number;
  walkTruncated?: number;
  mediaWithManifest?: number;
  mediaWithDuration?: number;
  posted?: number;
  droppedNoCover?: number;
  coverlessShapes?: string[];
}
let hookStats: HookStats | null = null;

/** One line of working-out for the discovery report.
 *
 *  `thumbnailUrls` are the covers the page is actually showing, so the report
 *  can print both sides of the join. When every length arrives and none of them
 *  lands — which is exactly what happened — the only thing worth seeing is one
 *  key of each kind, side by side. */
export function durationReport(thumbnailUrls: readonly string[] = []): string {
  const wanted = thumbnailUrls.map(fileNameOf).filter((f): f is string => f !== null);
  const missing = wanted.filter((f) => lookup(byFilename, byStem, f) === null);
  const known = [...byFilename.keys()][0];
  const at = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;
  const channels = Object.entries(byChannel)
    .map(([k, c]) => `${k} ${c.count} @${at(c.firstAt)}`
      + (c.lastAt - c.firstAt > 1000 ? `..${at(c.lastAt)}` : ''))
    .join(', ') || 'none';

  // Each missing cover, with everything a diagnosis needs: was it ever
  // announced under another rendition (the stem says), is there a URL to
  // probe, and did a probe already fail. Three is enough to see a pattern.
  // Filenames printed WHOLE. A 44-char slice here once made a cover look like
  // it had lost its last digit and its extension, and a display artifact that
  // reads as a data bug is worse than a long line.
  const misses = missing.slice(0, 3).map((f) => {
    const url = lookup(videoUrlByFilename, videoUrlByStem, f);
    return `"${f}" (stem ${stemOf(f) ?? '-'};`
      + ` video url ${url ? 'yes' : 'NO'}; probed ${probed.has(f) ? 'yes' : 'no'})`;
  }).join(', ');

  // The hook's own accounting — where the pipeline went quiet, when it did.
  // The signed-in feed answers differently at every one of these stages than
  // the logged-out one, which is the whole reason they are spelled out.
  const hook = hookStats === null
    ? 'no stats received (hook not running, or predates them)'
    : `responses [${Object.entries(hookStats.responses ?? {})
        .map(([k, n]) => `${k} ${n}`).join(', ')}], `
      + `${hookStats.mediaWithManifest ?? 0} manifests + ${hookStats.mediaWithDuration ?? 0} bare lengths seen, `
      + `${hookStats.posted ?? 0} posted, ${hookStats.droppedNoCover ?? 0} DROPPED coverless`
      + ((hookStats.coverlessShapes?.length ?? 0) > 0
        ? ` (shapes: ${(hookStats.coverlessShapes ?? []).join(' :: ')})` : '')
      + ((hookStats.walkTruncated ?? 0) > 0
        ? `, ${hookStats.walkTruncated} walk(s) TRUNCATED at the step cap` : '')
      + ((hookStats.parseFailures ?? 0) > 0
        ? `, ${hookStats.parseFailures} unparseable responses` : '');

  return `${byFilename.size} lengths known from ${stats.announced} reels announced`
    + ` via [${channels}]`
    + ` (${stats.withLength} arrived with one, ${stats.withUrl} carried a video URL);`
    + ` probes ${stats.probed_ok}/${stats.probes} answered.`
    + ` ${waitReport()}.`
    + ` Hook: ${hook}.`
    + (missing.length > 0
      ? ` ${missing.length} of ${wanted.length} on-screen covers missing: ${misses};`
        + ` hook's first key "${known ?? 'nothing'}" (stem ${known ? stemOf(known) ?? '-' : '-'})`
      : ' Every cover on screen joined');
}

/** How long rows actually sat blank, and where the answers came from.
 *
 *  "The times are laggy" is a claim about this line and nothing else. A length
 *  that lands before any row asks for it is free however slow it was; one that
 *  lands after is a visible blank, and the number below is how long it lasted.
 *  The source breakdown says why: `inline` late means we were slow to ask,
 *  `fetch`/`replay` late means Instagram had not sent that reel's batch yet,
 *  and `video`/`probe` mean nothing else answered at all. */
function waitReport(): string {
  const waits: number[] = [];
  const bySource: Record<string, number> = {};
  let instant = 0;
  let outstanding = 0;

  for (const timing of timings.values()) {
    if (timing.resolvedAt === undefined) {
      // Only counts as outstanding if something actually wanted it.
      if (timing.firstAskedAt !== undefined) outstanding++;
      continue;
    }
    const source = timing.source ?? 'unknown';
    bySource[source] = (bySource[source] ?? 0) + 1;
    if (timing.firstAskedAt === undefined) {
      instant++;
      continue;
    }
    waits.push(timing.resolvedAt - timing.firstAskedAt);
  }

  if (waits.length === 0) {
    return `waits: none — ${instant} length${instant === 1 ? '' : 's'} landed before any row asked`
      + (outstanding > 0 ? `, ${outstanding} still missing` : '');
  }

  waits.sort((a, b) => a - b);
  const median = Math.round(waits[Math.floor(waits.length / 2)]);
  const worst = Math.round(waits[waits.length - 1]);
  const sources = Object.entries(bySource).map(([k, n]) => `${k} ${n}`).join(', ');
  return `waits: ${waits.length} row${waits.length === 1 ? '' : 's'} rendered blank`
    + ` (median ${median}ms, worst ${worst}ms), ${instant} instant`
    + (outstanding > 0 ? `, ${outstanding} still missing` : '')
    + `; sources [${sources}]`;
}

/** The reel's own address — the shortcode behind `/reels/<code>/` — when the
 *  hook has seen it.
 *
 *  Verified against the live feed: every media object in Instagram's payloads
 *  carries `code`, and the code of the reel on screen is exactly what the
 *  address bar reads. That makes it the only way to reach a specific reel that
 *  does not go through the pager. */
export function reelCodeFor(thumbnailUrl: string): string | null {
  const f = fileNameOf(thumbnailUrl);
  return f === null ? null : lookup(codeByFilename, codeByStem, f);
}

/** The reel's video URL, when the hook has posted one. Exported for tests. */
export function videoUrlFor(thumbnailUrl: string): string | null {
  const f = fileNameOf(thumbnailUrl);
  return f === null ? null : lookup(videoUrlByFilename, videoUrlByStem, f);
}

/** How long to give the header read before giving up on it. */
const PROBE_TIMEOUT_MS = 6000;

/** Ask the reel's own video file how long it is.
 *
 *  Only the metadata: `preload="metadata"` fetches the header and stops, which
 *  for the low-bandwidth rendition the hook hands us is a few kilobytes. The
 *  element is never attached to the document and never plays — it exists to
 *  expose one number and is torn down immediately after.
 *
 *  Resolves true when a length was recorded, so the caller knows to re-render.
 *  Safe and cheap to call on every row of every render: it answers instantly
 *  for anything already known, already asked, or with no URL to ask. */
export async function probeDuration(thumbnailUrl: string): Promise<boolean> {
  const f = fileNameOf(thumbnailUrl);
  return f === null ? false : probeFilename(f);
}

/** The same, keyed the way the hook talks about reels. */
async function probeFilename(f: string): Promise<boolean> {
  if (lookup(byFilename, byStem, f) !== null || probed.has(f)) return false;
  const url = lookup(videoUrlByFilename, videoUrlByStem, f);
  if (!url) return false;
  probed.add(f);
  stats.probes++;

  const video = document.createElement('video');
  video.preload = 'metadata';
  video.muted = true;
  try {
    const seconds = await new Promise<number | null>((resolve) => {
      const done = (value: number | null): void => {
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => done(null), PROBE_TIMEOUT_MS);
      video.addEventListener('loadedmetadata', () => done(video.duration), { once: true });
      video.addEventListener('error', () => done(null), { once: true });
      video.src = url;
    });
    if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) return false;
    record(f, seconds, 'probe');
    stats.probed_ok++;
    return true;
  } catch {
    return false;
  } finally {
    // Let go of the fetch and the decoder rather than waiting for GC.
    video.removeAttribute('src');
    video.load();
  }
}

/** The reel's length in seconds, or null if no source has one yet. */
export function durationFor(thumbnailUrl: string): number | null {
  const f = fileNameOf(thumbnailUrl);
  if (f === null) return null;
  const found = lookup(byFilename, byStem, f);
  // A miss is a row about to render without a time on it. Counting them here —
  // at the moment of asking, rather than at the moment of arriving — is what
  // makes the wait measurable at all.
  if (found === null) {
    const timing = timingFor(f);
    timing.asks++;
    timing.firstAskedAt ??= performance.now();
  }
  return found;
}

/** "0:07", "1:23". Empty string for anything unusable, so callers can render
 *  the result unconditionally and get nothing when there's nothing to say. */
export function formatDuration(seconds: number | null | undefined): string {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return '';
  const total = Math.round(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
