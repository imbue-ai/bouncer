// The curtain: every reel arrives covered by a preview sheet. Revealing it —
// and swiping its previews aside — are the gestures this module owns.
//
// The architecture is chosen for WHERE the gestures land, because that is what
// three failed designs came down to. Intercepting gestures aimed at
// Instagram's feed is a race WebKit can win — it commits a drag to a native
// scroll before the first cancelable touchmove arrives, and preventDefault
// after that is a no-op (measured on device: the feed panned under the rising
// overlay regardless). Gestures aimed at OUR OWN element have no race at all:
// `touch-action: none` on the cover means the native scroller never bids for
// them, and every move arrives cancelable, always.
//
// So nothing is ever intercepted on the feed. The cycle:
//
//   WATCH      the reel is revealed; the cover is off-screen and inert
//              (pointer-events: none). Scrolling, tapping, liking — all
//              Instagram's, untouched.
//   SCROLL     native, physics and all. As the next reel rides in, the cover
//              rides in with it (a passive scroll listener translating our
//              fixed element — scroll-linking, not interception), so what
//              arrives is a covered reel: previews of what's underneath and
//              what follows it.
//   REVEAL     the covered reel is behind our sheet, so every gesture is ours
//              by hit-testing alone. Swipe up and the cover tracks the finger
//              off the top; let go early and it settles back. Tap a row and
//              the feed scrolls there instead.
//   DISMISS    a row swiped ASIDE is a reel declined sight unseen: it leaves
//              the sheet, the host is told (the feed-response filter can drop
//              it from future batches), and if the feed ever lands on it the
//              cover stays down and the journey continues to the next kept
//              reel — declined means never watched, not merely frowned at.
//   ...        the revealed reel plays; scrolling on brings the next cover.
//
// The rows come from ./library.ts records, same as every chooser before this
// one. Row one IS the reel underneath — tapping it is the same as revealing.
//
// Nothing here writes to Instagram's DOM, styles, or scroll position, with two
// deliberate exceptions: tapping a row scrolls the feed to that reel (smooth,
// visible — navigation by scrolling, the one kind allowed), and the reel UNDER
// a covering sheet is paused and resumed through the media API, so the covered
// part of a reel is not missed. A capture-phase play listener holds it paused
// while covered, because Instagram restarts its videos on its own schedule.

import { isRecordComplete, type ReelRecord } from './library';

const CURTAIN_ID = 'bouncer-ig-curtain';
const SHIELD_CLASS = 'bouncer-ig-shield';
const STYLE_ID = 'bouncer-ig-curtain-style';
const CURTAIN_Z = 2147483630;
/** Within the card's own stacking context — over everything the card draws. */
const SHIELD_Z = 2147483600;

const PANEL_FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';

/** How many rows the cover lists: the reel underneath plus what follows. */
const ROW_COUNT = 3;

const THUMB_ASPECT = 9 / 16;
const THUMB_H_PX = 132;

/** Movement below this is a tap that drifted, not a drag. */
const DRAG_SLOP_PX = 8;
/** How far a finger may land from where it went down and still be lifting a
 *  tap. Wider than DRAG_SLOP_PX, which is when the cover starts FOLLOWING the
 *  finger: a thumb tapping a phone drifts 10–20px as a matter of course, and a
 *  lift inside this band was always going to settle the cover straight back
 *  anyway — reading it as the tap it was costs nothing. */
const TAP_SLOP_PX = 24;
/** Past this fraction of the screen, a released cover commits to revealing. */
const REVEAL_FRACTION = 0.3;
/** A flick this fast reveals from any distance. Pixels per millisecond. */
const REVEAL_VELOCITY = 0.5;
/** Past this fraction of its width, a released row commits to leaving. */
const DISMISS_FRACTION = 0.35;
/** A sideways flick this fast dismisses from any distance. Px per ms. */
const DISMISS_VELOCITY = 0.5;
/** How long settle animations take. */
const SETTLE_MS = 220;
/** Quiet on the scroll stream for this long = the feed has settled. */
const SETTLE_QUIET_MS = 150;
/** The feed has to travel at least this fraction of a viewport from the last
 *  revealed resting place before a settle counts as a NEW reel. */
const NEW_SLIDE_FRACTION = 0.5;
/** Wheel ticks accumulate toward a reveal; a pause ends the gesture. */
const WHEEL_GESTURE_END_MS = 140;
const WHEEL_REVEAL_PX = 160;

export interface CurtainHost {
  /** The reel on screen, followed by everything after it, in feed order. */
  records: () => ReelRecord[];
  /** Scroll the feed to `record`'s card — smoothly; the journey should read as
   *  scrolling, because it is. */
  goTo: (record: ReelRecord) => void;
  /** A reel swiped aside — declined sight unseen. The curtain already skips it
   *  everywhere; the host can forward it to the feed-response filter so future
   *  batches never carry it at all. */
  onDismiss?: (record: ReelRecord) => void;
}

export interface Curtain {
  refresh(): void;
  onActiveReelChanged(): void;
  close(): void;
  isOpen(): boolean;
  teardown(): void;
}

// ==================== Feed geometry (read-only) ====================

function findScroller(): HTMLElement | null {
  let el: HTMLElement | null = document.querySelector('video')?.parentElement ?? null;
  for (let i = 0; i < 25 && el; i++) {
    if (el.scrollHeight > el.clientHeight + 8) {
      const overflowY = getComputedStyle(el).overflowY;
      if (/(auto|scroll|overlay)/.test(overflowY)) return el;
    }
    el = el.parentElement;
  }
  const page = document.scrollingElement;
  if (page instanceof HTMLElement && page.scrollHeight > page.clientHeight + 8) return page;
  return null;
}

/** Slide tops from the scroller's own children — usable only when the children
 *  ARE the slides. The phone feed nests them a level deeper, so every caller
 *  needs the fallback path. */
function childTops(scroller: HTMLElement): number[] {
  const tops: number[] = [];
  for (const child of Array.from(scroller.children)) {
    if (child instanceof HTMLElement && child.offsetHeight > 40) tops.push(child.offsetTop);
  }
  return tops.length > 1 ? tops : [];
}

/** Where the cover sits mid-scroll, as a viewport offset: glued to the top of
 *  the incoming slide when slide tops are knowable, else riding one viewport
 *  below the resting place being left. Exported for tests. */
export function rideInOffset(
  scrollTop: number,
  revealedTop: number,
  tops: readonly number[],
  viewport: number,
): number {
  if (tops.length > 0) {
    let next: number | null = null;
    for (const t of tops) {
      if (t > revealedTop + 8 && (next === null || t < next)) next = t;
    }
    if (next !== null) return Math.max(0, next - scrollTop);
  }
  return Math.max(0, revealedTop + viewport - scrollTop);
}

/** Whether a released row commits to leaving. `progress` is how far it sits
 *  from rest as a fraction of its width; `velocityOutward` is signed the same
 *  way — positive is away from rest, whichever side the drag chose. The same
 *  shape as revealTarget, for the same reasons: a flick outward means "gone"
 *  from any distance, a flick back means "keep" from any distance, and a
 *  deliberate drag is judged by where it stopped. Exported for tests. */
export function dismissTarget(progress: number, velocityOutward: number): 'dismissed' | 'kept' {
  if (velocityOutward >= DISMISS_VELOCITY) return 'dismissed';
  if (velocityOutward <= -DISMISS_VELOCITY) return 'kept';
  return progress >= DISMISS_FRACTION ? 'dismissed' : 'kept';
}

/** Whether a released cover commits to revealing. Exported for tests. */
export function revealTarget(progress: number, velocityUp: number): 'revealed' | 'covered' {
  if (velocityUp >= REVEAL_VELOCITY) return 'revealed';
  if (velocityUp <= -REVEAL_VELOCITY) return 'covered';
  return progress >= REVEAL_FRACTION ? 'revealed' : 'covered';
}

/** What a lifted finger meant: commit to the reveal, tap the row it was on, or
 *  settle the cover back. Exported for tests.
 *
 *  The tap has to be read HERE, off the touch stream, and not waited for as a
 *  click — that wait is why the rows took several taps to hit. The cover
 *  preventDefaults every touchmove it sees (that is the architecture: the
 *  native scroller must never win the gesture), and WebKit answers a cancelled
 *  move by never synthesizing the click at all. Real taps almost always jitter
 *  through at least one touchmove, so only a perfectly still finger ever
 *  produced a click — every other tap did nothing, and the 300ms dead window a
 *  recognised drag sets then ate the quick retry behind it. */
export function liftAction(
  progress: number, velocityUp: number, totalUpPx: number, canceled: boolean,
): 'reveal' | 'tap' | 'settle' {
  // A cancelled gesture is one the system took for itself; a tap read out of
  // it could choose a row the user never meant to touch.
  if (canceled) return 'settle';
  // The tap band is checked before the flick: a sharp tap's last few pixels
  // can carry flick-grade instantaneous velocity, and "flick reveals from any
  // distance" was never meant to reach gestures that barely travelled.
  if (Math.abs(totalUpPx) <= TAP_SLOP_PX) return 'tap';
  return revealTarget(progress, velocityUp) === 'revealed' ? 'reveal' : 'settle';
}

// ==================== State ====================

let host: CurtainHost | null = null;
let curtainEl: HTMLElement | null = null;
let listEl: HTMLElement | null = null;

type Mode = 'hidden' | 'riding' | 'covering' | 'dragging' | 'rowdrag';
let mode: Mode = 'hidden';

/** Where the feed was resting when the current reel was revealed — the
 *  reference every "is this a new reel" question is asked against. */
let revealedTop = 0;
/** The address of the reel that was revealed. THE authoritative new-reel
 *  signal: Instagram rewrites the path for every slide on every layout seen so
 *  far — the scroll-snap web feed and the transform-driven pager alike. The
 *  pager never emits usable scroll events at all (scrollTop just sits there),
 *  which is why a scroll-only trigger showed no cover on the device, ever. */
let revealedPath = '';
let pathTimer: ReturnType<typeof setInterval> | null = null;
/** The rows currently shown, pinned while covering so they can't re-point
 *  under a reaching finger. */
let rowIds: string[] = [];
/** A drag's trailing click must not read as a row tap. */
let tapDeadUntil = 0;
/** Reels swiped aside. Filtered out of the rows, skipped when the feed lands
 *  on them; declined is for keeps (for this page's life — the host hears each
 *  one and owns anything longer-lived). */
const dismissedIds = new Set<string>();

/** Videos WE paused, so the reveal resumes exactly those and nothing else. */
const pausedByUs = new Set<HTMLVideoElement>();

let dragStartY = 0;
let dragLastY = 0;
let dragLastT = 0;
let dragVelocity = 0;    // px/ms, positive = upward
let dragStartX = 0;
let dragLastX = 0;
let dragVelocityX = 0;   // px/ms, positive = rightward
/** The row under the finger when it went down — the one a sideways drag takes. */
let dragRow: HTMLElement | null = null;
let rowTimer: ReturnType<typeof setTimeout> | null = null;
/** A finger is on the cover. While one is, the row LIST must not change shape:
 *  replaceChildren detaches every node it re-appends, and iOS keeps delivering
 *  an in-flight gesture to its touchstart target even detached — where it no
 *  longer bubbles to the cover's listeners. The drag goes quiet mid-swipe
 *  ("loses grip"), the mode sticks, and the NEXT swipe's start is eaten. */
let touchActive = false;
/** A render that arrived while a finger was down, owed after the lift. */
let rowsDirty = false;
let wheelAccum = 0;
let wheelTimer: ReturnType<typeof setTimeout> | null = null;
let quietTimer: ReturnType<typeof setTimeout> | null = null;
let settleTimer: ReturnType<typeof setTimeout> | null = null;
let raf = 0;

// ==================== The element ====================

function injectStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = [
    `#${CURTAIN_ID} .bouncer-ig-crow { transition: background 0.15s ease; }`,
    `#${CURTAIN_ID} .bouncer-ig-crow:active { background: rgba(255,255,255,0.14); }`,
  ].join('\n');
  (document.head ?? document.documentElement).appendChild(style);
}

function buildCurtain(): HTMLElement {
  const el = document.createElement('div');
  el.id = CURTAIN_ID;
  el.style.cssText = [
    'position: fixed',
    'inset: 0',
    `z-index: ${CURTAIN_Z}`,
    'background: linear-gradient(180deg, rgba(6,6,10,0.42) 0%, rgba(6,6,10,0.22) 30%,'
      + ' rgba(6,6,10,0.22) 70%, rgba(6,6,10,0.42) 100%)',
    'backdrop-filter: blur(26px) saturate(180%)',
    '-webkit-backdrop-filter: blur(26px) saturate(180%)',
    `font-family: ${PANEL_FONT}`,
    'display: flex',
    'flex-direction: column',
    'justify-content: center',
    'gap: 8px',
    'padding: max(16px, env(safe-area-inset-top)) 14px max(14px, env(safe-area-inset-bottom))',
    'box-sizing: border-box',
    'transform: translateY(100%)',
    // Inert until it covers. While covering it takes EVERY pointer — which is
    // the whole architecture: gestures on our element cannot be claimed by
    // the native scroller, so the reveal drag has no race to lose.
    'pointer-events: none',
    // And no native gesture ever starts on the cover: this is what makes every
    // touchmove over it cancelable by construction.
    'touch-action: none',
    'will-change: transform',
  ].join(';');

  const list = document.createElement('div');
  list.style.cssText = 'display: flex; flex-direction: column; gap: 8px;';
  el.appendChild(list);
  listEl = list;

  el.addEventListener('touchstart', onCoverTouchStart, { passive: true });
  el.addEventListener('touchmove', onCoverTouchMove, { passive: false });
  // Not passive: a tap is acted on at touchend, and cancelling that touchend
  // is what keeps the browser from synthesizing a click for the same tap.
  el.addEventListener('touchend', onCoverTouchEnd, { passive: false });
  el.addEventListener('touchcancel', onCoverTouchEnd, { passive: true });
  el.addEventListener('wheel', onCoverWheel, { passive: false });

  (document.body ?? document.documentElement).appendChild(el);
  return el;
}

function meta(record: ReelRecord): string {
  const total = record.durationSec;
  if (total === null || !Number.isFinite(total) || total <= 0) return '';
  const secs = Math.round(total);
  return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
}

function buildRow(record: ReelRecord, isUnderneath: boolean): HTMLElement {
  const row = document.createElement('div');
  row.className = 'bouncer-ig-crow';
  row.style.cssText = [
    'display: flex',
    'align-items: center',
    'gap: 12px',
    'padding: 8px',
    'border-radius: 14px',
    'cursor: pointer',
    'user-select: none',
    '-webkit-user-select: none',
    // The reel this cover is sitting on wears the edge; the rest are journeys.
    ...(isUnderneath ? ['outline: 1px solid rgba(255,255,255,0.25)'] : []),
  ].join(';');

  const thumb = document.createElement('img');
  thumb.src = record.thumbnailUrl;
  thumb.alt = '';
  thumb.style.cssText = [
    'flex: 0 0 auto',
    `width: ${Math.round(THUMB_H_PX * THUMB_ASPECT)}px`,
    `height: ${THUMB_H_PX}px`,
    'object-fit: cover',
    'border-radius: 10px',
    'background: rgba(255,255,255,0.12)',
    'border: 1px solid rgba(255,255,255,0.22)',
  ].join(';');

  const body = document.createElement('div');
  body.style.cssText = 'flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px';

  const title = document.createElement('div');
  title.className = 'bouncer-ig-ctitle';
  title.textContent = record.description;
  title.style.cssText = [
    'font-size: 15px', 'font-weight: 650', 'line-height: 1.3', 'color: #fff',
    'display: -webkit-box', '-webkit-line-clamp: 3', '-webkit-box-orient: vertical',
    'overflow: hidden',
  ].join(';');

  const by = document.createElement('div');
  by.className = 'bouncer-ig-cby';
  by.textContent = record.creator ? `by ${record.creator}` : 'by —';
  by.style.cssText =
    'font-size: 13px; color: rgba(255,255,255,0.9); white-space: nowrap;'
    + ' overflow: hidden; text-overflow: ellipsis';

  const time = document.createElement('div');
  time.className = 'bouncer-ig-ctime';
  time.textContent = meta(record);
  time.style.cssText =
    'font-size: 13px; font-weight: 600; font-variant-numeric: tabular-nums;'
    + ' color: rgba(255,255,255,0.96); min-height: 17px';

  body.append(title, by, time);
  row.append(thumb, body);
  rowRecords.set(row, record);
  row.dataset.curtainReel = record.reelId;
  if (isUnderneath) row.dataset.curtainUnder = '1';

  // The mouse's path. A touch tap is acted on at touchend instead (see
  // onCoverTouchEnd) — the click after a touch is synthesized, and the cover's
  // own touchmove preventDefault stops WebKit synthesizing one for any finger
  // that moved at all.
  row.addEventListener('click', () => {
    if (performance.now() < tapDeadUntil) return;
    activateRow(row);
  });
  return row;
}

/** The reel each mounted row stands for — what a touch tap picks by. The click
 *  path could close over its record; the touch path meets the row as an event
 *  target and has to look it up. One map, both paths, one behavior. */
const rowRecords = new WeakMap<HTMLElement, ReelRecord>();

/** What choosing a row does, whichever input chose it. */
function activateRow(row: HTMLElement): void {
  const record = rowRecords.get(row);
  if (!record) return;
  if (row.dataset.curtainUnder) {
    // Row one is the reel this cover is sitting on: choosing it is the
    // reveal, not a journey.
    reveal(true);
    return;
  }
  const fresh = host?.records().find((r) => r.reelId === record.reelId) ?? record;
  hide();                 // the chosen reel arrives covered, like any other
  host?.goTo(fresh);
}

/** A row swiped aside: it plays its exit, then its reel is declined. The
 *  commit waits for the exit because a row that vanishes mid-slide reads as a
 *  glitch, and the finger that flung it has already let go — nothing races. */
function dismissRow(row: HTMLElement, dir: number): void {
  const record = rowRecords.get(row);
  const w = Math.max(1, row.clientWidth || window.innerWidth);
  row.style.pointerEvents = 'none';
  setRowTransform(row, dir * (w + 48), true);
  row.style.opacity = '0';
  if (rowTimer) clearTimeout(rowTimer);
  rowTimer = setTimeout(() => {
    if (!record || !host) return;
    dismissedIds.add(record.reelId);
    console.debug(`[Bouncer IG] curtain: dismissed ${record.reelId}`);
    host.onDismiss?.(record);
    // The shield goes on the reel's card NOW, in the same breath as the
    // decline — attached, it scrolls with the reel and is simply already
    // there whenever any journey brings the reel by. Raising it on arrival
    // instead showed the declined frame for as long as settle detection took.
    syncShields();
    if (row.dataset.curtainUnder) {
      // The reel UNDER the sheet was declined sight unseen: same journey as
      // arriving on a dismissed reel — cover down (its shield has the frame),
      // no resume, next kept reel.
      const next = firstKept();
      if (next) {
        hide(false);
        host.goTo(next);
        return;
      }
      // Nothing known to go to: the cover stays; the reveal gesture remains.
    }
    // Refill the pinned list in place: the remaining rows keep their spots,
    // the next kept reel takes the vacant one.
    rowIds = rowIds.filter((id) => id !== record.reelId);
    for (const r of host.records()) {
      if (rowIds.length >= ROW_COUNT) break;
      if (dismissedIds.has(r.reelId) || rowIds.includes(r.reelId) || !isRecordComplete(r)) continue;
      rowIds.push(r.reelId);
    }
    renderRows();
  }, SETTLE_MS);
}

function renderRows(): void {
  if (!listEl || !host) return;
  // Dismissed reels are gone from every rendering — including the pinned map
  // lookup, so a reel swiped aside mid-cover can't be re-pointed to.
  const records = host.records().filter((r) => !dismissedIds.has(r.reelId));
  const pinned = mode === 'covering' || mode === 'dragging' || mode === 'rowdrag';
  const wanted = pinned && rowIds.length > 0
    ? rowIds
        .map((id) => records.find((r) => r.reelId === id))
        .filter((r): r is ReelRecord => r !== undefined)
    : records.slice(0, ROW_COUNT).filter(isRecordComplete);
  if (!pinned) rowIds = wanted.map((r) => r.reelId);

  if (wanted.length === 0) {
    if (!listEl.querySelector('[data-curtain-empty]')) {
      if (touchActive) { rowsDirty = true; return; }
      const empty = document.createElement('div');
      empty.setAttribute('data-curtain-empty', '');
      empty.textContent = 'Nothing discovered yet.';
      empty.style.cssText = 'padding: 24px 10px; font-size: 15px; color: rgba(255,255,255,0.7)';
      listEl.replaceChildren(empty);
    }
    return;
  }

  // A row already mounted is REUSED, its late facts refreshed in place — never
  // rebuilt. The element is what a finger may be resting on or mid-way through
  // dragging, and rebuilding it snapped the dragged row back to rest and
  // orphaned the touch stream (see `touchActive`). The host refreshes on every
  // rescan and description arrival, so mid-gesture renders are the rule here,
  // not the exception.
  const mounted = new Map<string, HTMLElement>();
  for (const el of Array.from(listEl.querySelectorAll<HTMLElement>('.bouncer-ig-crow'))) {
    if (el.dataset.curtainReel) mounted.set(el.dataset.curtainReel, el);
  }
  const next = wanted.map((r, i) => {
    const row = mounted.get(r.reelId);
    if (!row) return buildRow(r, i === 0);
    refreshRow(row, r, i === 0);
    return row;
  });
  const children = Array.from(listEl.children);
  if (next.length === children.length && next.every((el, i) => el === children[i])) return;
  // The list changed shape. Applying that detaches even the reused nodes for a
  // beat — fatal to an in-flight gesture — so under a finger it waits.
  if (touchActive) { rowsDirty = true; return; }
  listEl.replaceChildren(...next);
}

/** Bring a mounted row up to date without rebuilding it. Text and attributes
 *  only, into the same element — nothing a resting or reaching finger can
 *  lose its place on. */
function refreshRow(row: HTMLElement, record: ReelRecord, isUnderneath: boolean): void {
  rowRecords.set(row, record);
  if (isUnderneath) row.dataset.curtainUnder = '1';
  else delete row.dataset.curtainUnder;
  row.style.outline = isUnderneath ? '1px solid rgba(255,255,255,0.25)' : '';
  const img = row.querySelector('img');
  if (img instanceof HTMLImageElement && img.getAttribute('src') !== record.thumbnailUrl) {
    img.src = record.thumbnailUrl;
  }
  const title = row.querySelector('.bouncer-ig-ctitle');
  if (title instanceof HTMLElement && title.textContent !== record.description) {
    title.textContent = record.description;
  }
  const byText = record.creator ? `by ${record.creator}` : 'by —';
  const by = row.querySelector('.bouncer-ig-cby');
  if (by instanceof HTMLElement && by.textContent !== byText) by.textContent = byText;
  const timeText = meta(record);
  const time = row.querySelector('.bouncer-ig-ctime');
  if (time instanceof HTMLElement && timeText && time.textContent !== timeText) {
    time.textContent = timeText;
  }
}

// ==================== The outer page ====================
//
// Instagram's mobile shell keeps a nav bar's worth of scroll on the OUTER
// document and toggles its bottom bar with it. Any nudge — an ancestor-chained
// scroll, drag spillage — toggles the bar, jumps the layout, and drops an
// in-flight touch on the cover ("it stops grabbing my finger"). Scrolled to
// its bottom, the bar is visible and there is nowhere left to toggle to; the
// pin holds it there. Scroll-position management only — nothing written to
// the page.

function pinOuterPage(): void {
  const doc = document.scrollingElement;
  if (!(doc instanceof HTMLElement)) return;
  if (doc === findScroller()) return;          // the page IS the feed: not ours to hold
  const max = doc.scrollHeight - doc.clientHeight;
  // A small overhang is collapsible chrome; a large one is actual content.
  if (max > 0 && max < 200 && Math.abs(doc.scrollTop - max) > 1) doc.scrollTop = max;
}

// ==================== The reel underneath ====================

/** The video the cover is sitting on: the one whose box is centred on screen. */
function videoUnder(): HTMLVideoElement | null {
  let best: HTMLVideoElement | null = null;
  let bestDistance = Infinity;
  for (const v of Array.from(document.querySelectorAll('video'))) {
    if (!(v instanceof HTMLVideoElement)) continue;
    const r = v.getBoundingClientRect();
    if (r.height < 1) continue;
    const distance = Math.abs(r.top + r.height / 2 - window.innerHeight / 2);
    if (distance < bestDistance) { bestDistance = distance; best = v; }
  }
  return best;
}

function pauseUnderlying(): void {
  const v = videoUnder();
  if (v && !v.paused) {
    pausedByUs.add(v);
    try { v.pause(); } catch { /* a detached player can throw; nothing to hold */ }
  }
}

/** Resume what we paused — but only where the user actually is. A paused reel
 *  that has since left the screen stays paused, which is what Instagram does
 *  with off-screen reels anyway. */
function resumeUnderlying(): void {
  for (const v of pausedByUs) {
    if (!v.isConnected) continue;
    const r = v.getBoundingClientRect();
    if (r.height > 0 && r.bottom > 0 && r.top < window.innerHeight) {
      v.play()?.catch?.(() => { /* autoplay veto: the user's next tap starts it */ });
    }
  }
  pausedByUs.clear();
}

/** Instagram restarts its videos on its own schedule; while the cover is up,
 *  the reel underneath stays paused no matter who pressed play. */
function onPlayCapture(e: Event): void {
  if (mode !== 'covering' && mode !== 'dragging' && mode !== 'rowdrag') return;
  const v = e.target;
  if (!(v instanceof HTMLVideoElement)) return;
  const r = v.getBoundingClientRect();
  // Only the covered reel — a below-fold player warming up may do as it likes.
  if (r.height < 1 || Math.abs(r.top + r.height / 2 - window.innerHeight / 2) > window.innerHeight / 2) return;
  pausedByUs.add(v);
  try { v.pause(); } catch { /* see pauseUnderlying */ }
}

// ==================== Modes ====================

function setTransform(y: string, animate: boolean): void {
  if (!curtainEl) return;
  curtainEl.style.transition = animate
    ? `transform ${SETTLE_MS}ms cubic-bezier(0.22, 0.61, 0.36, 1)`
    : 'none';
  curtainEl.style.transform = `translateY(${y})`;
}

/** A dragged row tracks the finger sideways, thinning as it goes. */
function setRowTransform(row: HTMLElement, x: number, animate: boolean): void {
  row.style.transition = animate
    ? `transform ${SETTLE_MS}ms cubic-bezier(0.22, 0.61, 0.36, 1), opacity ${SETTLE_MS}ms ease`
    : 'none';
  row.style.transform = x === 0 ? '' : `translateX(${x}px)`;
  const w = Math.max(1, row.clientWidth || window.innerWidth);
  row.style.opacity = String(Math.max(0.25, 1 - Math.abs(x) / w));
}

// ==================== The shield ====================
//
// Swiping a reel away doesn't remove it from Instagram's feed — the DOM still
// holds it, and every journey past it would otherwise show its opening frame
// sitting there, declined but plainly visible. The shield covers that up: an
// OPAQUE pane (the sheet itself is deliberately glass, so it can't do this
// job) planted INSIDE the dismissed reel's own card, so it scrolls with the
// reel as part of it. Attached at dismissal time, not raised when the feed
// settles — a fixed overlay driven by settle detection showed the declined
// frame for the fraction of a second the detection took, every time.
//
// This is the third deliberate write to Instagram's DOM (see the module
// comment), and the recycling hazard is the price: Instagram reuses card
// elements, so a shield left standing could black out a reel the user KEEPS.
// syncShields runs on every host refresh and evicts any shield whose card now
// belongs to a different reel; a shield whose reel moved cards is replanted.

/** reelId -> the shield standing on that reel's card. */
const shields = new Map<string, HTMLElement>();

function buildShield(): HTMLElement {
  const el = document.createElement('div');
  el.className = SHIELD_CLASS;
  el.style.cssText = [
    'position: absolute',
    'inset: 0',
    `z-index: ${SHIELD_Z}`,
    // Opaque, which is the whole point: nothing of the declined reel — not a
    // frame, not a silhouette — reaches the screen through it.
    'background: linear-gradient(180deg, #0c0c12 0%, #08080c 55%, #0c0c12 100%)',
    `font-family: ${PANEL_FONT}`,
    'display: flex',
    'flex-direction: column',
    'align-items: center',
    'justify-content: center',
    'gap: 6px',
    'pointer-events: none',
  ].join(';');

  const word = document.createElement('div');
  word.textContent = 'Dismissed';
  word.style.cssText =
    'font-size: 15px; font-weight: 650; color: rgba(255,255,255,0.82); letter-spacing: 0.02em';
  const line = document.createElement('div');
  line.textContent = 'You swiped this reel away';
  line.style.cssText = 'font-size: 13px; color: rgba(255,255,255,0.45)';
  el.append(word, line);
  return el;
}

/** Stand a shield on `record`'s card, once. `inset: 0` needs a positioned
 *  ancestor; a static card is nudged to relative, which changes nothing else
 *  about a box that isn't using offsets. */
function plantShield(record: ReelRecord): void {
  const standing = shields.get(record.reelId);
  if (standing && standing.parentElement === record.card && record.card.isConnected) return;
  standing?.remove();
  shields.delete(record.reelId);
  if (!record.card.isConnected) return;   // replanted by syncShields when it mounts
  if (getComputedStyle(record.card).position === 'static') {
    record.card.style.position = 'relative';
  }
  const el = buildShield();
  record.card.appendChild(el);
  shields.set(record.reelId, el);
}

/** True up every shield against what the host currently knows. Two jobs:
 *  evict shields from recycled cards (another reel lives there now — the one
 *  way a shield could wrong a KEPT reel), and make sure every dismissed reel
 *  the host can still name wears one on its current card. */
function syncShields(): void {
  if (!host) return;
  const records = host.records();
  for (const [id, el] of shields) {
    const owner = el.parentElement;
    if (!owner?.isConnected) { el.remove(); shields.delete(id); continue; }
    const tenant = records.find((r) => r.card === owner);
    if (tenant && tenant.reelId !== id) { el.remove(); shields.delete(id); }
  }
  for (const r of records) {
    if (dismissedIds.has(r.reelId)) plantShield(r);
  }
}

/** The first record the user hasn't sworn off — where a skip lands. */
function firstKept(): ReelRecord | null {
  for (const r of host?.records() ?? []) {
    if (!dismissedIds.has(r.reelId) && isRecordComplete(r)) return r;
  }
  return null;
}

/** Whether the sheet has any journey to offer beyond revealing what is already
 *  underneath it: a kept, renderable record past the first. Mid-ride the first
 *  record may still be the reel being LEFT, which only makes this optimistic —
 *  cover() re-asks against the settled feed and stays hidden if the optimism
 *  was misplaced. */
function hasSkipTargets(): boolean {
  const kept = (host?.records() ?? []).filter((r) => !dismissedIds.has(r.reelId));
  return kept.slice(1).some(isRecordComplete);
}

function cover(): void {
  // A reel dismissed earlier can still scroll back under the sheet: Instagram
  // delivered it long ago and the feed remembers it. Declined means never
  // watched — the cover stays down (no resume for the reel underneath) and the
  // journey continues to the next kept reel, which arrives covered like any
  // other. Nothing here loops: the destination is kept by construction, so the
  // next arrival covers normally.
  const records = host?.records() ?? [];
  const kept = records.filter((r) => !dismissedIds.has(r.reelId));
  const renderable = kept.filter(isRecordComplete);
  console.debug(
    `[Bouncer IG] curtain: covering — ${records.length} reel(s) offered, `
    + `${renderable.length} renderable, showing ${Math.min(renderable.length, ROW_COUNT)} row(s)`,
  );
  const under = records[0];
  if (under && dismissedIds.has(under.reelId)) {
    // Its shield should already be standing (planted at dismissal), but a
    // card that remounted since is bare — make sure before anything shows.
    syncShields();
    const next = firstKept();
    if (next) {
      console.debug(`[Bouncer IG] curtain: skipping dismissed ${under.reelId} → ${next.reelId}`);
      pauseUnderlying();     // it may already be playing; declined reels play to nobody
      hide(false);
      host?.goTo(next);
      return;
    }
    // Nowhere kept to send the feed: the cover still comes down, as a blocker —
    // declined means never watched, even with no skips to offer.
  } else if (!hasSkipTargets()) {
    // Nothing to skip to: a sheet whose only offer is "reveal what's already
    // underneath" is pure obstruction. Stay out of the way; the reel plays
    // uncovered. Decided once per arrival — a description landing mid-watch
    // must not drop a sheet on a reel already playing.
    console.debug('[Bouncer IG] curtain: nothing to skip to — staying hidden');
    hide();
    return;
  }
  mode = 'covering';
  if (curtainEl) curtainEl.style.pointerEvents = 'auto';
  setTransform('0px', true);
  // The covered reel waits instead of playing to nobody.
  pauseUnderlying();
}

/** `resume: false` is for leaving a DISMISSED reel: it stays paused for the
 *  journey away — the whole point is that it is never watched. */
function hide(resume = true): void {
  mode = 'hidden';
  rowIds = [];
  if (curtainEl) curtainEl.style.pointerEvents = 'none';
  setTransform('100%', false);
  if (resume) resumeUnderlying();
}

/** Slide the cover off the top; the reel underneath is the reel now. */
function reveal(animate: boolean): void {
  const scroller = findScroller();
  revealedTop = scroller ? scroller.scrollTop : 0;
  revealedPath = location.pathname;
  resumeUnderlying();
  mode = 'hidden';
  rowIds = [];
  if (curtainEl) curtainEl.style.pointerEvents = 'none';
  setTransform('-100%', animate);
  // Park it back below, off any transition, once the exit has played.
  if (settleTimer) clearTimeout(settleTimer);
  settleTimer = setTimeout(() => {
    if (mode === 'hidden') setTransform('100%', false);
  }, animate ? SETTLE_MS : 0);
}

// ==================== Riding in with the feed ====================
//
// Passive, always. This never argues with a scroll; it only dresses one.

function onFeedScroll(e?: Event): void {
  // Outer-page scrolls are Instagram's collapsible chrome moving, not the feed
  // — put the page straight back (the nav bar stays put, the layout never
  // jumps under a finger) and keep them out of the ride/settle logic
  // entirely. Event-driven, so the correction lands the same frame the wander
  // starts; in practice the outer page is simply not scrollable.
  const target = e?.target;
  if (target === document || target === document.documentElement || target === document.body) {
    pinOuterPage();
    return;
  }
  if (mode === 'dragging' || mode === 'rowdrag') return;
  if (!raf) {
    raf = requestAnimationFrame(() => {
      raf = 0;
      if (mode === 'dragging' || mode === 'rowdrag') return;
      const scroller = findScroller();
      if (!scroller || !curtainEl) return;
      const away = scroller.scrollTop - revealedTop;
      const viewport = Math.max(1, scroller.clientHeight);

      if (Math.abs(away) < 4) {
        // Back at (or still on) the revealed reel: nothing to dress.
        if (mode === 'riding') hide();
        return;
      }

      // The feed is moving somewhere new — whether from a finger, momentum, a
      // row tap's smooth scroll, or Instagram's own snap. The cover rides in
      // glued to the incoming slide, previews already on it. Unless it has
      // nothing to offer — then it never enters the frame (cover() makes the
      // same call at settle).
      if (mode === 'hidden' && !hasSkipTargets()) return;
      mode = 'riding';
      if (curtainEl.style.pointerEvents !== 'none') curtainEl.style.pointerEvents = 'none';
      if (rowIds.length === 0) renderRows();
      const offset = away > 0
        ? rideInOffset(scroller.scrollTop, revealedTop, childTops(scroller), viewport)
        // Scrolling BACK: the cover approaches from above instead.
        : -Math.max(0, scroller.scrollTop - (revealedTop - viewport));
      const clamped = Math.max(-viewport, Math.min(offset, viewport));
      setTransform(`${clamped}px`, false);
    });
  }

  // Settle detection: quiet on the scroll stream means the feed has arrived.
  if (quietTimer) clearTimeout(quietTimer);
  quietTimer = setTimeout(onFeedSettled, SETTLE_QUIET_MS);
}

/** The address says which reel owns the screen; a change that HOLDS for one
 *  tick is an arrival. This is what covers on the pager layout, where no
 *  scroll event ever fires; on scroller layouts it agrees with the scroll
 *  path below, whichever notices first. */
let pendingPath: string | null = null;
function onPathTick(): void {
  pinOuterPage();
  if (mode === 'dragging' || mode === 'covering' || mode === 'rowdrag') return;
  const path = location.pathname;
  if (path === revealedPath) { pendingPath = null; return; }
  if (pendingPath !== path) { pendingPath = path; return; }   // hold one tick
  pendingPath = null;
  console.debug(`[Bouncer IG] curtain: covering — address ${revealedPath || '(start)'} → ${path}`);
  // The new reel is the reference now, whatever geometry this layout has.
  revealedPath = path;
  const scroller = findScroller();
  revealedTop = scroller ? scroller.scrollTop : 0;
  rowIds = [];
  renderRows();
  cover();
}

function onFeedSettled(): void {
  if (mode === 'dragging' || mode === 'covering' || mode === 'rowdrag') return;
  const scroller = findScroller();
  if (!scroller) return;
  const away = Math.abs(scroller.scrollTop - revealedTop);
  const viewport = Math.max(1, scroller.clientHeight);
  if (away < viewport * NEW_SLIDE_FRACTION) {
    // Settled back where the last reveal left us; stay out of the way.
    if (mode !== 'hidden') hide();
    return;
  }
  // A new reel owns the screen. It arrives covered, previews re-anchored on it.
  console.debug(`[Bouncer IG] curtain: covering — scrolled ${Math.round(away)}px`
    + ` (address ${revealedPath} → ${location.pathname})`);
  revealedPath = location.pathname;
  revealedTop = scroller.scrollTop;
  rowIds = [];
  renderRows();
  cover();
}

// ==================== The reveal gesture — on the cover, nowhere else ====================

function onCoverTouchStart(e: TouchEvent): void {
  // A drag whose end never arrived — its target left the document mid-gesture
  // and iOS kept delivering the rest of the stream to the detached node, where
  // it no longer bubbles here — must not eat this gesture too. A new finger
  // down IS the proof the old gesture is over: put its pieces back and listen.
  if (mode === 'rowdrag' || mode === 'dragging') {
    if (dragRow?.isConnected) setRowTransform(dragRow, 0, true);
    dragRow = null;
    setTransform('0px', true);
    mode = 'covering';
  }
  if (mode !== 'covering') return;
  const t = e.touches[0];
  if (!t) return;
  touchActive = true;
  dragStartY = t.clientY;
  dragLastY = t.clientY;
  dragStartX = t.clientX;
  dragLastX = t.clientX;
  dragLastT = performance.now();
  dragVelocity = 0;
  dragVelocityX = 0;
  const row = e.target instanceof Element ? e.target.closest('.bouncer-ig-crow') : null;
  dragRow = row instanceof HTMLElement ? row : null;
}

function onCoverTouchMove(e: TouchEvent): void {
  if (mode !== 'covering' && mode !== 'dragging' && mode !== 'rowdrag') return;
  const t = e.touches[0];
  if (!t) return;
  // Cancelable by construction: the gesture began on our element, whose
  // touch-action is none, so the native scroller never bid for it.
  if (e.cancelable) e.preventDefault();

  const now = performance.now();
  if (now > dragLastT) {
    dragVelocity = (dragLastY - t.clientY) / (now - dragLastT);
    dragVelocityX = (t.clientX - dragLastX) / (now - dragLastT);
  }
  dragLastY = t.clientY;
  dragLastX = t.clientX;
  dragLastT = now;

  const totalUp = dragStartY - t.clientY;
  const totalX = t.clientX - dragStartX;
  if (mode === 'covering') {
    // The slop is left in whichever direction the finger chooses; the first
    // move past it commits the gesture to an axis. Sideways belongs to the row
    // it started on — a sideways drag on the bare sheet means nothing, and
    // falls to the vertical path to settle as the non-gesture it is.
    if (Math.max(Math.abs(totalUp), Math.abs(totalX)) <= DRAG_SLOP_PX) return;
    mode = Math.abs(totalX) > Math.abs(totalUp) && dragRow !== null ? 'rowdrag' : 'dragging';
  }
  if (mode === 'rowdrag') {
    if (dragRow?.isConnected) setRowTransform(dragRow, totalX, false);
    return;
  }
  // Track the finger: up slides the cover off the top; down goes nowhere.
  setTransform(`${Math.min(0, -totalUp)}px`, false);
}

function onCoverTouchEnd(e: TouchEvent): void {
  touchActive = false;
  // A render the finger held back is owed now — after this handler has
  // resolved the gesture, so it never reshapes the list out from under the
  // dismiss/settle the lift decides on.
  if (rowsDirty) {
    setTimeout(() => {
      if (!rowsDirty || touchActive) return;
      rowsDirty = false;
      renderRows();
    }, 0);
  }
  if (mode !== 'covering' && mode !== 'dragging' && mode !== 'rowdrag') return;
  // A recognised drag's trailing click must not read as a row tap; a tap's own
  // trailing click (if WebKit synthesizes one after all) is the same tap again.
  tapDeadUntil = performance.now() + 300;
  if (mode === 'rowdrag') {
    mode = 'covering';
    const row = dragRow;
    dragRow = null;
    if (!row?.isConnected) return;
    if (e.cancelable) e.preventDefault();
    const dx = dragLastX - dragStartX;
    const dir = dx < 0 ? -1 : 1;
    const w = Math.max(1, row.clientWidth || window.innerWidth);
    // Outward is wherever the drag went; a cancelled gesture always settles.
    const action = e.type === 'touchcancel'
      ? 'kept'
      : dismissTarget(Math.abs(dx) / w, dragVelocityX * dir);
    if (action === 'dismissed') dismissRow(row, dir);
    else setRowTransform(row, 0, true);
    return;
  }
  // `||`, not `??`: an unlaid-out cover reports height 0, and dividing by the
  // 1 the clamp leaves behind reads every drag as a whole screen of progress.
  const h = Math.max(1, (curtainEl?.clientHeight || window.innerHeight));
  const totalUp = dragStartY - dragLastY;
  const progress = Math.max(0, totalUp) / h;
  // Only a recognised drag can mean "reveal": inside the slop the finger never
  // travelled, and the instantaneous velocity of a micro-jitter must not
  // commit the cover on what the user meant as a tap.
  const canceled = e.type === 'touchcancel';
  const action = mode === 'dragging'
    ? liftAction(progress, dragVelocity, totalUp, canceled)
    : canceled ? 'settle' : 'tap';
  if (action === 'reveal') {
    reveal(true);
    return;
  }
  if (action === 'tap') {
    const row = (e.target instanceof Element ? e.target : null)?.closest('.bouncer-ig-crow');
    if (row instanceof HTMLElement) {
      // Cancelling the touchend is what stops the click from ever being
      // synthesized — belt to tapDeadUntil's braces.
      if (e.cancelable) e.preventDefault();
      activateRow(row);
      return;
    }
  }
  mode = 'covering';
  setTransform('0px', true);
}

function onCoverWheel(e: WheelEvent): void {
  if (mode !== 'covering') return;
  if (e.cancelable) e.preventDefault();
  wheelAccum += e.deltaY;
  if (wheelTimer) clearTimeout(wheelTimer);
  wheelTimer = setTimeout(() => { wheelAccum = 0; }, WHEEL_GESTURE_END_MS);
  if (wheelAccum >= WHEEL_REVEAL_PX) {
    wheelAccum = 0;
    reveal(true);
  }
}

// ==================== Public API ====================

export function installCurtain(next: CurtainHost): Curtain {
  host = next;
  injectStyles();
  curtainEl = buildCurtain();
  // The reel on screen at install was chosen by arriving at it: it starts
  // revealed, and the first scroll away brings the first cover.
  const scroller = findScroller();
  revealedTop = scroller?.scrollTop ?? 0;
  revealedPath = location.pathname;
  renderRows();
  pinOuterPage();
  console.warn(`[Bouncer IG] curtain: installed — scroller ${scroller
    ? `${Math.round(scroller.clientHeight)}h (scrollTop ${Math.round(scroller.scrollTop)})`
    : 'NOT FOUND'}, path ${revealedPath}`);

  // Scroll events don't bubble; capture sees them wherever the feed lives.
  document.addEventListener('scroll', onFeedScroll, { capture: true, passive: true });
  // Media events don't bubble either, but they do run the capture phase — one
  // listener covers every video Instagram will ever mount.
  document.addEventListener('play', onPlayCapture, true);
  pathTimer = setInterval(onPathTick, 250);

  return {
    refresh(): void {
      // Shields first: a rescan is exactly when recycled cards come to light,
      // and a shield on a card that now holds a KEPT reel must go before
      // anything else trusts the page.
      syncShields();
      renderRows();
    },
    onActiveReelChanged(): void {
      renderRows();
    },
    close(): void {
      reveal(false);
    },
    isOpen(): boolean {
      return mode === 'covering' || mode === 'dragging' || mode === 'rowdrag';
    },
    teardown(): void {
      document.removeEventListener('scroll', onFeedScroll, true);
      document.removeEventListener('play', onPlayCapture, true);
      if (pathTimer) clearInterval(pathTimer);
      pathTimer = null;
      resumeUnderlying();
      if (wheelTimer) clearTimeout(wheelTimer);
      if (quietTimer) clearTimeout(quietTimer);
      if (settleTimer) clearTimeout(settleTimer);
      if (rowTimer) clearTimeout(rowTimer);
      rowTimer = null;
      if (raf) cancelAnimationFrame(raf);
      for (const el of shields.values()) el.remove();
      shields.clear();
      curtainEl?.remove();
      document.getElementById(STYLE_ID)?.remove();
      curtainEl = null;
      listEl = null;
      host = null;
      mode = 'hidden';
      rowIds = [];
      wheelAccum = 0;
      tapDeadUntil = 0;
      dragRow = null;
      touchActive = false;
      rowsDirty = false;
      dismissedIds.clear();
    },
  };
}
