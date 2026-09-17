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
//
// Since 2026-09 it also REWRITES: reels the user deletes (curtain swipe-away)
// are dropped from Instagram's own feed responses before the page reads them,
// so the feed's data simply never contains them again. The pure filtering
// lives in ./rewrite.ts; this file owns the fetch/XHR plumbing.

import {
  coverFilenames,
  extractClipsEntries,
  filterClipsPayload,
  rewriteClipsText,
  type ClipsMediaEntry,
} from './rewrite';

const SOURCE = 'bouncer-ig-audio-hook';
// Isolated → MAIN: reels the user deleted. Payload `keys: string[]` — reel
// shortcodes and cover filenames, matched against every media object in feed
// responses from then on. Must match index.ts REMOVE_REELS_SOURCE.
const REMOVE_SOURCE = 'bouncer-ig-remove-reels';
// The hold-and-classify handshake (all must match index.ts):
//   MAIN → isolated: a fresh batch's reels, straight out of the JSON, asking
//   for verdicts while the response is held.
const CLASSIFY_BATCH_SOURCE = 'bouncer-ig-classify-batch';
//   isolated → MAIN: the verdicts. dropKeys name the reels to remove from the
//   held (and every later) response; judgedKeys name everything that got a
//   verdict either way, so a re-served reel is never classified twice.
const CLASSIFY_VERDICTS_SOURCE = 'bouncer-ig-classify-verdicts';
//   isolated → MAIN: whether the user has any filter phrases at all. Holds
//   only happen while true — with nothing to classify against, batches must
//   flow through untouched at full speed.
const FILTER_ACTIVE_SOURCE = 'bouncer-ig-filter-active';

// How long a feed response may be held while its reels are classified.
// Instagram prefetches the next batch well before the user reaches it, so a
// held response is normally invisible; this cap is for the fast scroller and
// for a backend having a bad day — on expiry the batch flows through
// unfiltered and the verdicts, when they do land, still shield those reels at
// discovery (index.ts pendingVerdicts).
const HOLD_MS = 15_000;

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
  /** The deletion rewrite: how many names are on the kill list, and how many
   *  responses/edges it has actually dropped. `keys > 0, edges = 0` across a
   *  whole session is the signature of a payload-shape change. */
  removed: { keys: 0, batches: 0, edges: 0 },
  /** Hold-and-classify: batches held for verdicts, and how many of those
   *  expired unanswered. Rising timeouts = the classifier can't keep up with
   *  the hold window; those reels fall back to discovery-time shields. */
  held: { batches: 0, timeouts: 0 },
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

// ==================== Feed-response deletion ====================

// Every name a deleted reel goes by: shortcode, numeric id, cover filenames.
// Seeded by REMOVE_SOURCE messages from the isolated world (which only knows
// filenames and sometimes a code) and grown by alias expansion below.
const removedKeys = new Set<string>();

// A removal usually arrives as ONE name — the cover filename the isolated
// world scraped off the <img>. But a future payload's surest name is the
// shortcode, and its cover candidates may be different renditions with
// different filenames. The harvest has already seen most reels' full identity
// (all filenames + code), so join the kill list against it: any entry that
// shares a name with a removed reel donates all its other names.
function expandAliases(entries: readonly HookEntry[]): void {
  if (removedKeys.size === 0) return;
  for (const entry of entries) {
    const known = entry.filenames.some(f => removedKeys.has(f))
      || (entry.code !== undefined && removedKeys.has(entry.code));
    if (!known) continue;
    if (entry.code) removedKeys.add(entry.code);
    for (const f of entry.filenames) removedKeys.add(f);
  }
  hookStats.removed.keys = removedKeys.size;
}

// The prototype's own response getters, kept so WE can read a body without
// tripping the per-instance shadows installed below — harvest must see the
// ORIGINAL payload, or a deleted reel drops out of the alias index too.
function protoGetter(name: 'responseText' | 'response'): (() => unknown) | null {
  let p: object | null = XMLHttpRequest.prototype;
  while (p) {
    const d = Object.getOwnPropertyDescriptor(p, name);
    // Intentional unbound getter capture — always re-invoked with .call(xhr).
    // eslint-disable-next-line @typescript-eslint/unbound-method
    if (d?.get) return d.get as () => unknown;
    p = Object.getPrototypeOf(p) as object | null;
  }
  return null;
}
const origTextGet = protoGetter('responseText');
const origResponseGet = protoGetter('response');

// Shadow ONE request's responseText/response with getters that hand the page a
// body with deleted reels filtered out. Instance properties shadow the
// prototype's, so this catches the read no matter when or how Instagram
// registered its handlers. Lazy and cached: the rewrite runs on first read,
// not on arrival, and reruns only if the underlying body changes (readyState
// 3 → 4 on text streams).
function shadowResponses(xhr: XMLHttpRequest): void {
  if (!origTextGet || !origResponseGet) return;
  try {
    let rewrittenFrom: string | null = null;
    let rewrittenTo: string | null = null;
    const rewriteText = (raw: unknown): unknown => {
      if (typeof raw !== 'string' || xhr.readyState !== 4 || removedKeys.size === 0) return raw;
      if (rewrittenFrom !== raw) {
        rewrittenFrom = raw;
        const out = rewriteClipsText(raw, removedKeys);
        if (out) {
          hookStats.removed.batches++;
          hookStats.removed.edges += out.dropped;
        }
        rewrittenTo = out ? out.text : raw;
      }
      return rewrittenTo;
    };
    Object.defineProperty(xhr, 'responseText', {
      configurable: true,
      get: () => rewriteText(origTextGet.call(xhr)),
    });
    // response: a string body filters like responseText; a parsed-JSON body
    // (responseType 'json') filters in place, once. Anything else (blob,
    // arraybuffer, document) passes through untouched.
    let jsonFiltered = false;
    Object.defineProperty(xhr, 'response', {
      configurable: true,
      get: () => {
        const raw = origResponseGet.call(xhr);
        if (xhr.responseType === '' || xhr.responseType === 'text') return rewriteText(raw);
        if (xhr.responseType === 'json' && !jsonFiltered && xhr.readyState === 4
            && removedKeys.size > 0) {
          jsonFiltered = true;
          try {
            const dropped = filterClipsPayload(raw, removedKeys);
            if (dropped > 0) {
              hookStats.removed.batches++;
              hookStats.removed.edges += dropped;
            }
          } catch { /* hand it back unfiltered */ }
        }
        return raw;
      },
    });
  } catch {
    /* never break the page */
  }
}

// ==================== Hold-and-classify ====================
//
// Deleting a reel the page already holds can only ever be papered over — the
// dismissed cover. The reels the page DOESN'T have yet can be removed for
// real: every clips batch arrives seconds before it's needed, so the response
// is held, its reels are classified against the user's filter phrases (over
// in the isolated world, via the describe backend), and matching edges are
// dropped before Instagram reads a byte. To the pager they never existed.

// Whether the user has any filter phrases. Nothing is held when false.
let classifyActive = false;

// Names (codes + cover filenames) of every reel a verdict has ever come back
// for, hidden or kept — a re-served reel must not stall a batch again.
const classifiedKeys = new Set<string>();

const verdictWaiters = new Map<string, (dropKeys: readonly string[]) => void>();
let batchSeq = 0;

/** Ship a batch's reels off for classification; resolve with the keys to drop.
 *  Resolves [] on timeout — the batch then flows through unfiltered and the
 *  discovery-time shield picks up whatever the verdicts eventually say. */
function requestVerdicts(entries: readonly ClipsMediaEntry[]): Promise<readonly string[]> {
  return new Promise((resolve) => {
    const batchId = `b${++batchSeq}`;
    hookStats.held.batches++;
    const timer = setTimeout(() => {
      verdictWaiters.delete(batchId);
      hookStats.held.timeouts++;
      resolve([]);
    }, HOLD_MS);
    verdictWaiters.set(batchId, (dropKeys) => {
      clearTimeout(timer);
      verdictWaiters.delete(batchId);
      resolve(dropKeys);
    });
    window.postMessage({ source: CLASSIFY_BATCH_SOURCE, batchId, entries }, '*');
  });
}

function entryKeys(entry: ClipsMediaEntry): string[] {
  return entry.code ? [entry.code, ...entry.filenames] : [...entry.filenames];
}

/** The reels of `text` still needing a verdict, or null when this body is not
 *  worth holding at all (no clips batch, or everything in it already judged —
 *  already-judged hidden reels drop synchronously through removedKeys). */
function entriesNeedingVerdicts(text: unknown): ClipsMediaEntry[] | null {
  if (!classifyActive || typeof text !== 'string' || !/clips/i.test(text)) return null;
  try {
    const fresh = extractClipsEntries(JSON.parse(text))
      .filter(entry => !entryKeys(entry).some(k => classifiedKeys.has(k) || removedKeys.has(k)));
    return fresh.length > 0 ? fresh : null;
  } catch {
    return null;
  }
}

/** Classify a held body's reels and fold the verdicts into the kill list.
 *  When this resolves, the existing rewrite layer (shadowResponses / the fetch
 *  wrapper) does the actual dropping on first read. */
async function classifyHeldBody(entries: readonly ClipsMediaEntry[]): Promise<void> {
  const dropKeys = await requestVerdicts(entries);
  for (const k of dropKeys) {
    if (typeof k === 'string' && k.length > 0) removedKeys.add(k);
  }
  hookStats.removed.keys = removedKeys.size;
}

// ---- The XHR side of holding ----
//
// A fetch can simply be awaited; an XHR announces its response through events
// that fire when they fire. So every XHR gets interceptor listeners at
// CONSTRUCTION — registered before any listener the page will ever add, which
// makes their stopImmediatePropagation() total — and while a response is held
// its terminal events are swallowed and replayed once the verdicts are in.
// The page sees one delivery, slightly late, already filtered.

type HoldState = 'none' | 'released' | { swallowed: string[] };
const holdStates = new WeakMap<XMLHttpRequest, HoldState>();
const syntheticEvents = new WeakSet<Event>();

function releaseHeldXhr(xhr: XMLHttpRequest, state: { swallowed: string[] }): void {
  holdStates.set(xhr, 'released');
  try {
    // Aborted mid-hold: readyState fell back to 0 and the page already got its
    // abort/loadend — replaying a load now would announce a response that
    // officially never arrived.
    if (xhr.readyState !== 4) return;
    const swallowed = new Set(state.swallowed);
    for (const type of ['readystatechange', 'load', 'loadend'] as const) {
      if (!swallowed.has(type)) continue;
      const ev = type === 'readystatechange' ? new Event(type) : new ProgressEvent(type);
      syntheticEvents.add(ev);
      xhr.dispatchEvent(ev);
    }
  } catch {
    /* never break the page */
  }
}

/** Decide, once per XHR, whether its response gets held. Runs inside the first
 *  terminal event, when the body is finally readable. */
function beginHoldIfNeeded(xhr: XMLHttpRequest): HoldState {
  if (!classifyActive || !origTextGet) return 'none';
  if (!isInterestingUrl(xhrUrls.get(xhr) ?? '')) return 'none';
  // Text bodies only: Instagram's web client doesn't use the json
  // responseType for the feed, and those can still filter at read time.
  if (xhr.responseType !== '' && xhr.responseType !== 'text') return 'none';
  const entries = entriesNeedingVerdicts(origTextGet.call(xhr));
  if (!entries) return 'none';
  const state: HoldState = { swallowed: [] };
  void classifyHeldBody(entries).then(() => releaseHeldXhr(xhr, state));
  return state;
}

/** The constructor-installed listener: swallow a held request's terminal
 *  events; pass everything else (progress states, aborts, our own replays)
 *  straight through. */
function interceptTerminalEvent(xhr: XMLHttpRequest, e: Event): void {
  try {
    if (syntheticEvents.has(e) || xhr.readyState !== 4) return;
    let state = holdStates.get(xhr);
    if (state === undefined) {
      state = beginHoldIfNeeded(xhr);
      holdStates.set(xhr, state);
    }
    if (state === 'none' || state === 'released') return;
    state.swallowed.push(e.type);
    e.stopImmediatePropagation();
  } catch {
    /* never break the page */
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
      // A deleted reel's fuller identity may only now have gone past — teach
      // the kill list its other names before the next response is filtered.
      expandAliases(found);
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
      // Harvest from a clone of the ORIGINAL — see shadowResponses on why the
      // alias index must not read through the deletion filter.
      res.clone().json().then((json: unknown) => harvest(json, 'fetch'))
        .catch(() => { hookStats.parseFailures++; });
      // Hold-and-classify: a clips batch with unjudged reels waits here for
      // verdicts (bounded by HOLD_MS) before the page sees it, so matching
      // reels can be dropped below rather than papered over later.
      let heldText: string | null = null;
      if (classifyActive) {
        heldText = await res.clone().text();
        const entries = entriesNeedingVerdicts(heldText);
        if (entries) await classifyHeldBody(entries);
      }
      // Deletion rewrite: hand the page a Response that never contained the
      // removed reels. Only when something actually matched — the common case
      // returns Instagram's own untouched Response object.
      if (removedKeys.size > 0) {
        const text = heldText ?? await res.clone().text();
        const out = rewriteClipsText(text, removedKeys);
        if (out) {
          hookStats.removed.batches++;
          hookStats.removed.edges += out.dropped;
          return new Response(out.text, {
            status: res.status,
            statusText: res.statusText,
            headers: res.headers,
          });
        }
      }
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
  try {
    // Shadow before the request goes out, so the filtered view is in place
    // whenever Instagram first reads the body. Installed unconditionally on
    // interesting URLs (not only while the kill list is non-empty): a reel can
    // be deleted while its next batch's request is already in flight.
    if (isInterestingUrl(xhrUrls.get(this) ?? '')) shadowResponses(this);
  } catch { /* ignore */ }
  this.addEventListener('load', () => {
    try {
      const url = xhrUrls.get(this) ?? '';
      if (!isInterestingUrl(url)) return;
      if (this.responseType !== '' && this.responseType !== 'text') return;
      // Through the prototype getter, not `this.responseText` — that now reads
      // the filtered view, and the harvest wants the original (see
      // shadowResponses).
      const text = origTextGet ? origTextGet.call(this) as string : this.responseText;
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
  // The hold interceptors, installed at construction so they are FIRST in
  // every XHR's listener list — the property that makes their
  // stopImmediatePropagation() silence the page's own handlers (see the
  // hold-and-classify section). The subclass inherits the patched prototype,
  // so open/send hooks keep working unchanged.
  const OriginalXHR = XMLHttpRequest;
  window.XMLHttpRequest = class extends OriginalXHR {
    constructor() {
      super();
      const intercept = (e: Event): void => interceptTerminalEvent(this, e);
      this.addEventListener('readystatechange', intercept);
      this.addEventListener('load', intercept);
      this.addEventListener('loadend', intercept);
    }
  };

  // A consumer booting later than us asks for what it missed, and gets the whole
  // accumulated set. Cheap — the entries are already built — and it is the only
  // way anything harvested before document_idle ever reaches them.
  window.addEventListener('message', (e: MessageEvent) => {
    try {
      const data = e.data as { source?: string; keys?: unknown } | null;
      if (e.source !== window) return;
      // The kill list. Sent whole on every change (and on boot, from
      // storage), so receipt is idempotent and nothing is lost to ordering.
      if (data?.source === REMOVE_SOURCE) {
        if (Array.isArray(data.keys)) {
          for (const k of data.keys) {
            if (typeof k === 'string' && k.length > 0) removedKeys.add(k);
          }
        }
        hookStats.removed.keys = removedKeys.size;
        expandAliases(announced);
        return;
      }
      // Whether holds happen at all — flipped by the isolated world whenever
      // the user's phrase list goes empty/non-empty.
      if (data?.source === FILTER_ACTIVE_SOURCE) {
        const payload = data as { active?: unknown };
        classifyActive = payload.active === true;
        return;
      }
      // Verdicts for a held batch. judgedKeys stop re-classification;
      // dropKeys land via the waiter, which folds them into removedKeys.
      if (data?.source === CLASSIFY_VERDICTS_SOURCE) {
        const payload = data as { batchId?: unknown; dropKeys?: unknown; judgedKeys?: unknown };
        if (Array.isArray(payload.judgedKeys)) {
          for (const k of payload.judgedKeys) {
            if (typeof k === 'string' && k.length > 0) classifiedKeys.add(k);
          }
        }
        const drops = Array.isArray(payload.dropKeys)
          ? payload.dropKeys.filter((k): k is string => typeof k === 'string' && k.length > 0)
          : [];
        if (typeof payload.batchId === 'string') {
          verdictWaiters.get(payload.batchId)?.(drops);
        }
        return;
      }
      if (data?.source !== READY_SOURCE) return;
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
