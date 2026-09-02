// Choosing what's next, from inside the reel you're watching.
//
// The reels feed has exactly one control — the swipe — and it does exactly one
// thing: give you whatever is next. You can't see what's coming and can't
// decline. This keeps the gesture and changes what it answers with. Vertical
// scrolling is switched off (lockScroll below), and swiping up on a reel no
// longer hands you the next reel: it lays a sheet of glass over the one you're
// on, carrying the next three — each with its thumbnail, what it is, how long it
// runs, and who made it.
//
// Glass, not a page and not a panel. The overlay covers the reel completely and
// has nothing on it but the rows: no header, no buttons, no card behind them.
// They sit directly on a blurred, tinted pane and the reel goes on playing
// through it. That is the whole difference from the full-page chooser this
// replaces — deciding what to watch next is no longer somewhere you have to go,
// and what you are deciding about never leaves.
//
// And it never MOVES, either. The feed underneath is pinned for the whole time
// the glass is up (see "Holding the feed still", and coverWith for the moves
// the chooser makes itself).
//
// The whole interface:
//
//   SWIPE UP on the reel     the glass comes up with the next three
//   SWIPE DOWN on the reel   the reel before, exactly as it always did
//   SWIPE (either way) or
//   TAP on the pane          the glass goes away; you are back on your reel
//   TAP a row                you go to that reel
//
// Only the FORWARD direction is being replaced. Going back decides nothing for
// you — it returns something you already chose once — so it keeps working the
// way it always has.
//
// Pick one and the reel you land on becomes the new "here", so it repeats:
// watch 3, swipe up, choose 5, swipe up, choose from 6/7/8. Getting there is
// itself a swipe, or three — see "Swiping the feed ourselves", which is how
// every move the chooser makes now reaches Instagram.
//
// What it offers is always the three reels AHEAD. There is no history here and
// nothing to slide: a second axis of movement on a surface whose other gesture
// is "put this away" was a way to lose the reel you were on, not a way to find
// one you had passed.
//
// Everything the rows render comes from ./library.ts, which captures each reel's
// facts on discovery precisely because this surface needs them after Instagram
// has recycled the card.

import { isRecordComplete, type ReelRecord } from './library';

const GLASS_ID = 'bouncer-ig-glass';
const STILL_ID = 'bouncer-ig-hold';
const STYLE_ID = 'bouncer-ig-suggest-style';
// A class shadowing the id, because the glass gives its id up the moment it is
// dismissed (see dismiss) and teardown still has to find it.
const GLASS_CLASS = 'bouncer-ig-glass-pane';
// The describer's collapsed settings icon — ours, so gestures over it are let
// through rather than swallowed by the scroll lock.
const COLLAPSED_ID = 'bouncer-ig-frame';

const PANEL_FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';

// Above the reel, below the bounce popup (…646) and the settings icon (…647).
const STILL_Z = 2147483627;
const GLASS_Z = 2147483630;

// Reel aspect, so a thumbnail is a scaled reel rather than a squashed one.
const THUMB_ASPECT = 9 / 16;

/** How many reels the glass offers at once. */
export const WINDOW_SIZE = 3;

// Row thumbnails are sized to the viewport rather than fixed. See rowThumbSize.
const ROW_THUMB_MIN_H_PX = 76;
/** Big, but still a row in a list. Past this the three stop reading as options
 *  to compare and start reading as three reels stacked on top of each other. */
const ROW_THUMB_MAX_H_PX = 168;
/** The narrowest column a 16px title can still set two readable lines in. */
const ROW_TEXT_MIN_W_PX = 200;

const GLASS_PAD_X_PX = 14;
const ROW_PAD_PX = 8;
/** Between a row's thumbnail and its text. */
const ROW_GAP_PX = 14;
/** Between rows. */
const LIST_GAP_PX = 6;
/** Everything the glass spends above and below the rows: the safe-area
 *  paddings, and enough slack that a row is never the thing that overflows.
 *  Small, because there is no longer anything on the glass but the rows. */
const GLASS_CHROME_PX = 72;

const SHRINK_MS = 320;
const EXIT_MS = 220;
/** The fade that hands the screen back to the real reel. */
const UNCOVER_MS = 180;
const EASE = 'cubic-bezier(0.22, 0.61, 0.36, 1)';

/** How far up a finger has to travel on the reel before the glass comes.
 *
 *  Short: this is the reel feed's own gesture and it should answer at the same
 *  point Instagram's would, which is early — you flick, and by the time you have
 *  finished flicking something has already happened. At 44px a quick flick
 *  outran the threshold and lifted before it was crossed, and the swipe did
 *  nothing at all. Still comfortably past a tap that drifts. */
const OPEN_SWIPE_PX = 26;
/** The same intent on a trackpad or wheel, which arrives in small increments. */
const WHEEL_OPEN_DELTA = 24;
/** Cooldown after a wheel-driven go-back. Momentum keeps arriving long after
 *  the intent, and each threshold crossing here is a whole reel of navigation —
 *  long enough to cover the synthetic swipe and its settle. */
const WHEEL_BACK_BLOCK_MS = 900;
/** After a dismissal, ignore the tail of the gesture that caused it — momentum
 *  scrolling and flick inertia both keep arriving well after the finger is up,
 *  and reopening the glass you just dismissed is the one thing they must not do. */
const REOPEN_BLOCK_MS = 450;

// Past this much downward travel, a drag on the glass dismisses it.
const SWIPE_COMMIT_PX = 56;
/** Movement past this is a drag, so the click that trails it isn't a pick. */
const DRAG_SLOP_PX = 8;

// ==================== State ====================

let host: SuggestHost | null = null;
let installed = false;

/** The reel the glass went up over. What it offers is measured from this, not
 *  from whatever the host currently calls "the reel on screen" — see
 *  windowRecords. */
let anchorId: string | null = null;

/** What each of the three slots is showing, by position. Index IS the slot.
 *
 *  This is the glass's memory, and it exists because re-rendering used to be
 *  free and isn't. `renderGlass` runs again every time the host rescans the
 *  feed, and it used to rebuild all three rows from `windowRecords()` — so a
 *  row could change which reel it stood for underneath a finger that was
 *  already reaching for it. Worse, `windowRecords()` falls back to the top of
 *  the feed when the anchor reel has been recycled out of the host's list, so
 *  a rescan at the wrong moment silently re-pointed all three rows at
 *  completely different reels. That is the "I picked one and got another"
 *  report, and it was never the journey going wrong — it was the row lying
 *  about where it went.
 *
 *  So a slot is assigned once and keeps its reel for as long as the glass is
 *  up. Re-renders may only refresh the FACTS of the reel a slot already holds
 *  (a description landing, a length arriving); they may never move a reel to
 *  another slot, swap one out, or reorder them. */
let slotRecords: (ReelRecord | null)[] = [];

/** Thumbnails already asked for, so a re-render doesn't re-request them. */
const thumbsRequested = new Set<string>();

// Gesture bookkeeping for the swipe that raises the glass.
let swipeStartY: number | null = null;
/** Where the current gesture began, whatever it began on — the swallow covers
 *  gestures on our own surfaces too, which `swipeStartY` deliberately doesn't. */
let gestureStartY: number | null = null;
let pointerStartY: number | null = null;
/** Whether this gesture has been taken from the page, so its end is taken too. */
let swallowedGesture = false;
/** Whether this gesture began inside something the page opened over the reel
 *  and can scroll — in which case it is entirely the page's. */
let overlayGesture = false;
/** Where a drag on the glass began, and until when the click that trails one is
 *  that drag's rather than a tap of its own. */
let glassDragStartY: number | null = null;
let tapDeadUntil = 0;
let wheelAccum = 0;
let wheelBackAccum = 0;
let reopenAfter = 0;

export interface SuggestHost {
  /** The reel on screen, followed by everything after it, in feed order.
   *
   *  Not everything ever seen. The chooser used to be handed the whole history
   *  and an index into it, because it could slide backwards through it; it
   *  can't any more, so reels behind you are neither rendered nor built. */
  records: () => ReelRecord[];
  /** Put `record`'s reel on screen. Expected to be instantaneous — a visible
   *  scroll would be a journey through reels the user didn't choose. */
  goTo: (record: ReelRecord) => void;
  /** Take the describer's own furniture off the screen while the glass is up.
   *  Nothing but the rows belongs on this surface, and the settings icon sits
   *  above everything by design — it would sit above the glass too. */
  setChromeHidden: (hidden: boolean) => void;
}

export interface Suggestions {
  /** Re-render whatever is showing (new reels discovered, lengths resolved). */
  refresh(): void;
  /** The feed moved under us. */
  onActiveReelChanged(): void;
  /** Put the glass away without moving. */
  close(): void;
  isOpen(): boolean;
  teardown(): void;
}

// ==================== Scroll lock ====================

// What was locked, and the inline styles each element had first, so the lock
// lifts exactly rather than approximately.
interface LockedEl {
  el: HTMLElement;
  touchAction: string;
  overscrollBehavior: string;
  overflowY: string;
  scrollSnapType: string;
  scrollBehavior: string;
  /** Where this element is held. See "Holding the feed still" below. */
  pin: number;
}
let locked: LockedEl[] = [];
// Membership test for scrollables(), below. Without it the lock would erase its
// own evidence: `overflow-y: hidden` is exactly what a non-scroller looks like,
// so the next detection pass would drop the elements we are holding and quietly
// hand the swipe back to the innermost one.
const lockedEls = new WeakSet<HTMLElement>();

// The element the feed actually moves in — the innermost of the above. Every
// programmatic move (goTo's scrollIntoView, restock below) happens in here.
let feedEl: HTMLElement | null = null;

/** Everything the feed could be scrolling in, innermost first.
 *
 *  Anchored on a `<video>`, NOT on a discovered reel. This used to take the
 *  first reachable ReelRecord and walk up from its card, which made the lock
 *  depend on cover-image discovery — and discovery is heuristic enough to come
 *  up empty on a page shape we haven't seen. When it did, `scrollables(null)`
 *  returned nothing, lockScroll took its "a miss changes nothing" early exit,
 *  and the feed was never locked at all. That is why scrolling still worked.
 *  A feed we failed to parse still has to stop moving, and Instagram mounts
 *  videos whether or not we recognise the cards around them.
 *
 *  The page's own scrollers are always included: on the phone layout the
 *  document itself is usually the thing that moves, and it scrolls with
 *  `overflow: visible`, so a computed-overflow test alone would miss it.
 *
 *  All of them, not just the nearest — a miss on an outer one leaves a scroll
 *  the inner lock can still be dragged inside of. */
function scrollables(): HTMLElement[] {
  const found: HTMLElement[] = [];
  const consider = (el: HTMLElement | null): void => {
    if (!el || found.includes(el)) return;
    if (el.scrollHeight <= el.clientHeight + 8) return;
    const overflowY = getComputedStyle(el).overflowY;
    const isPage = el === document.scrollingElement
      || el === document.documentElement
      || el === document.body;
    if (lockedEls.has(el) || /(auto|scroll|overlay)/.test(overflowY) || isPage) found.push(el);
  };

  // Both anchors, not either: a mounted <video> is there whether or not we
  // recognised the card around it, and a discovered card is there on the
  // route where Instagram hasn't mounted a video yet. Neither alone covers
  // both, and the walk is idempotent, so run it from each.
  const anchors = [
    document.querySelector('video')?.parentElement ?? null,
    host?.records().find((r) => r.reachable)?.card.parentElement ?? null,
  ];
  for (const anchor of anchors) {
    let el: HTMLElement | null = anchor;
    for (let i = 0; i < 25 && el; i++) {
      consider(el);
      el = el.parentElement;
    }
  }
  consider(document.scrollingElement as HTMLElement | null);
  consider(document.documentElement);
  consider(document.body);
  return found;
}

/** Something the page opened OVER the reel that scrolls on its own: the
 *  comments sheet, the share sheet, a profile preview.
 *
 *  These are the one place a vertical swipe is neither ours nor the feed's. The
 *  lock takes the swipe away from the whole page and the chooser reads what is
 *  left as "show me what's next" — so opening comments and scrolling down
 *  raised the glass instead of moving the comments, and there was no way to
 *  read them at all.
 *
 *  Found by walking up from whatever was touched, looking for a box that can
 *  scroll and has somewhere to scroll to. The walk stops at anything the lock
 *  is holding: that is the feed, and a gesture that reaches it is a gesture on
 *  the reel. `role="dialog"` is checked alongside because a sheet that has not
 *  yet overflowed is still a sheet, and swiping in one is still not a swipe on
 *  the reel behind it. */
function overlayFrom(target: EventTarget | null): HTMLElement | null {
  let el = target instanceof Element ? target : null;
  for (let i = 0; i < 20 && el && el !== document.body; i++) {
    if (el instanceof HTMLElement) {
      if (lockedEls.has(el)) return null;          // reached the feed
      if (el.getAttribute('role') === 'dialog') return el;
      const overflowY = getComputedStyle(el).overflowY;
      if (/(auto|scroll)/.test(overflowY) && el.scrollHeight > el.clientHeight + 8) return el;
    }
    el = el.parentElement;
  }
  return null;
}

/** Whether an event landed on something of ours, which the lock must not eat. */
function ours(e: Event): boolean {
  const target = e.target instanceof Element ? e.target : null;
  return target?.closest(
    `#${GLASS_ID}, #${COLLAPSED_ID}`,
  ) !== null && target !== null;
}

/** Take the swipe away.
 *
 *  `overflow-y: hidden` is the part that actually holds. `touch-action: none`
 *  and the document-level preventDefault were not enough on iOS, and the way
 *  they failed is worth recording: WebKit decides a drag is a scroll before it
 *  dispatches the first touchmove, so that event arrives already
 *  non-cancelable and preventDefault on it does nothing. The feed moved a
 *  half-swipe's worth — enough to see past the last reel, which is exactly
 *  where there is nothing to see. A clipped box has no user scroll to begin
 *  with, and stays scrollable from script, which is all goTo and restock need.
 *
 *  The other two stay: they suppress the rubber-band and the wheel, and they
 *  cost nothing.
 *
 *  A miss leaves the previous lock in place rather than clearing it — a lookup
 *  that comes up empty for a frame must not hand the swipe back. */
function lockScroll(): void {
  const found = scrollables();
  if (found.length === 0) return;
  if (found.length === locked.length && found.every((el, i) => el === locked[i].el)) return;

  unlockScroll();
  locked = found.map((el) => ({
    el,
    touchAction: el.style.touchAction,
    overscrollBehavior: el.style.overscrollBehavior,
    overflowY: el.style.overflowY,
    scrollSnapType: el.style.scrollSnapType,
    scrollBehavior: el.style.scrollBehavior,
    pin: el.scrollTop,
  }));
  for (const { el } of locked) {
    el.style.touchAction = 'none';
    el.style.overscrollBehavior = 'none';
    el.style.overflowY = 'hidden';
    // Snap is what turns a leaked half-swipe into a whole reel: the scroller
    // doesn't drift, it commits, animating to the next snap point and taking the
    // feed with it. Off, a leak is a few pixels the pin puts straight back.
    el.style.scrollSnapType = 'none';
    // And instantly: a `scroll-behavior: smooth` scroller animates the pin's
    // correction too, which is the pin racing the thing it is correcting.
    el.style.scrollBehavior = 'auto';
    lockedEls.add(el);
    // Straight on the element. A scroll event does not bubble, and relying on
    // the document's capture phase to see it is one more thing that has to
    // hold — this is the guarantee that stops the feed, so it listens directly.
    el.addEventListener('scroll', onFeedScroll, { passive: true });
  }
  feedEl = locked[0].el;
}

function unlockScroll(): void {
  for (const saved of locked) {
    saved.el.style.touchAction = saved.touchAction;
    saved.el.style.overscrollBehavior = saved.overscrollBehavior;
    saved.el.style.overflowY = saved.overflowY;
    saved.el.style.scrollSnapType = saved.scrollSnapType;
    saved.el.style.scrollBehavior = saved.scrollBehavior;
    saved.el.removeEventListener('scroll', onFeedScroll);
    lockedEls.delete(saved.el);
  }
  locked = [];
  feedEl = null;
}

// ==================== Holding the feed still ====================
//
// The lock above tries to stop the gesture ever reaching the scroller. This
// stops the scroller MOVING even when one gets through, which is a different
// guarantee and the one that actually matters: `overflow: hidden` and
// `touch-action: none` are both things WebKit can decide to have already
// committed to a scroll before we are consulted, and every remaining way the
// feed drifts under a swipe ends here regardless of which of them leaked.
//
// Scoped to gestures, and to the whole time the glass is up. Undoing EVERY
// scroll at every other moment would also undo Instagram's own — its route
// changes and snap corrections — and the two would fight. But there is no
// legitimate reason for the feed to move while you are choosing from it, so
// while the glass is open the hold is unconditional; our own moves (goTo,
// restock) run with `programmatic` raised and set the new resting place when
// they finish.

/** How long after a finger lifts iOS can still be flinging the feed.
 *
 *  Was 400ms, which is roughly how long a gentle swipe coasts and nothing like
 *  how long a hard one does. A flick's momentum outlived the window, the pin
 *  stopped holding part-way through it, and the rest of the fling landed on the
 *  next reel — "if I swipe too hard it still jumps". Momentum is what has to be
 *  outlasted, so the number is now the length of a long fling rather than an
 *  average one. Costs nothing: within the window we only undo scrolls we didn't
 *  ask for. */
const GESTURE_TAIL_MS = 1800;

/** How long our own moves get. Deliberately short and separate — this one is a
 *  licence for the feed to move, and a licence should expire quickly. */
const CLAIM_MS = 400;

/** Past this much travel, a gesture is a swipe rather than a tap — and a swipe
 *  on the reel is ours now, so Instagram's own handlers stop being told about
 *  it. Small, because the point is to get in before its swipe recogniser does. */
const SWALLOW_PX = 6;

let touching = false;
let gestureUntil = 0;

/** Until when a scroll is presumed to be ours rather than a swipe.
 *
 *  A deadline, not a counter. A counter that ever loses a decrement — an
 *  overlapping move, a teardown mid-flight, a throw — stays raised forever, and
 *  a permanently-raised flag means the pin silently stops holding and the feed
 *  scrolls freely again with nothing to show for it. A deadline can only be
 *  wrong for GESTURE_TAIL_MS and then heals itself. */
let programmaticUntil = 0;
/** Raised for the length of a restock or a pick — every move within it is ours. */
let driving = false;

function programmatic(): boolean {
  // `driving` covers a whole operation; the deadline covers a single move. Both,
  // because a synthetic swipe's effect arrives on Instagram's schedule, not
  // ours: the pager animates, settles, sometimes re-lays the list out, and any
  // of that can land after a 400ms claim has lapsed — at which point the pin
  // would helpfully undo the navigation we just asked for.
  return driving || performance.now() < programmaticUntil;
}

/** Claim the next stretch of scrolling as ours. */
function claimScroll(): void {
  programmaticUntil = performance.now() + CLAIM_MS;
}

/** Whether the feed is currently being held. */
function pinning(): boolean {
  return touching || performance.now() < gestureUntil || isOpen();
}

/** Adopt wherever everything currently sits as its resting place. */
function repin(): void {
  for (const l of locked) l.pin = l.el.scrollTop;
}

/** The first touch point of a touch event, whichever list it is carried in —
 *  `touches` is empty on the touchend that ends a gesture. */
function touchY(e: Event): number | null {
  const touch = e as TouchEvent;
  const list = touch.touches?.length ? touch.touches : touch.changedTouches;
  const first = list?.[0];
  return first ? first.clientY : null;
}

/** Every touch arms the pin, including one that lands on our own surfaces.
 *
 *  Those were exempt at first, on the reasoning that a drag on the glass is not
 *  a drag on the feed. It isn't — but the feed can move underneath it anyway:
 *  our surfaces are the one place the document-level preventDefault deliberately
 *  stays its hand (see onTouchMove), so a drag on the glass is precisely the
 *  gesture WebKit is free to hand to the scroller behind it. Exempting it left
 *  the feed unpinned for the whole of the one gesture that most wants it held,
 *  and dragging the glass down slid the reel behind it.
 *
 *  Only the swipe-to-open READING is scoped to the reel; the holding is not. */
function onTouchStart(e: Event): void {

  touching = true;
  repin();
  gestureStartY = touchY(e);
  // A gesture that starts on the glass belongs to the glass, and must not also
  // be measured as a swipe on the reel underneath.
  const mine = ours(e);
  overlayGesture = !mine && !isOpen() && overlayFrom(e.target) !== null;
  swipeStartY = mine || overlayGesture ? null : gestureStartY;
  glassDragStartY = mine && isOpen() ? gestureStartY : null;
}

/** The glass following a finger, and leaving when one commits.
 *
 *  Driven from the touch stream rather than from the pointer events the element
 *  itself listens for. Those are what a mouse produces and they work on a
 *  desktop, but on iOS the same drag can arrive as a pointercancel the moment
 *  WebKit decides the gesture might be a scroll — and a cancel springs the glass
 *  back instead of dismissing it, which is the "swiping up doesn't put it away"
 *  report. Touch events are not second-guessed like that. */
function dragGlassBy(dy: number): void {
  const glass = document.getElementById(GLASS_ID);
  if (!glass) return;
  glass.style.transition = 'none';
  glass.style.transform = `translateY(${dy * 0.5}px)`;
  glass.style.opacity = `${Math.max(0.3, 1 - Math.abs(dy) / 460)}`;
}

function endGlassDrag(dy: number): void {
  const glass = document.getElementById(GLASS_ID);
  if (!glass) return;
  if (Math.abs(dy) > DRAG_SLOP_PX) tapDeadUntil = performance.now() + 300;
  if (Math.abs(dy) >= SWIPE_COMMIT_PX) {
    close(dy > 0 ? 'down' : 'up');
    return;
  }
  glass.style.transition = `transform ${EXIT_MS}ms ${EASE}, opacity ${EXIT_MS}ms ease`;
  glass.style.transform = 'translateY(0)';
  glass.style.opacity = '1';
}

/** Take the swipe, and read it. Both, in one listener: the gesture we are
 *  taking away and the gesture we are giving back are the same gesture, and
 *  splitting them across two handlers only risks them disagreeing about which
 *  events count.
 *
 *  "Taking" is now stopPropagation as well as preventDefault, and the pair do
 *  different jobs against different opponents. preventDefault addresses the
 *  BROWSER's native scroll — and only when WebKit has not already committed to
 *  one, which on a hard flick it has. stopPropagation addresses INSTAGRAM's own
 *  swipe recogniser, which is a listener like ours and doesn't care what the
 *  browser decided: it reads the touch stream and advances the feed itself, and
 *  no amount of `overflow: hidden` reaches it. That is the leak that survived
 *  everything else — the feed jumped a whole reel rather than drifting, which is
 *  a page doing it on purpose, not a scroller slipping. */
function onTouchMove(e: Event): void {
  // A scroll inside the comments belongs to the comments: not cancelled, not
  // swallowed, not read as anything.
  if (overlayGesture) return;

  const mine = ours(e);
  // Only the reel's own gesture is cancelled outright; over our surfaces the
  // browser's default is harmless and cancelling it risks the pointer stream
  // the glass's own drag is built on.
  if (!mine && e.cancelable) e.preventDefault();

  const y = touchY(e);
  if (gestureStartY === null || y === null) return;
  const dy = gestureStartY - y;

  // Past the tap threshold this gesture is a swipe, and every swipe on this
  // screen is now ours — the ones on the glass too, because a recogniser
  // watching the touch stream does not care what the finger is over, and a drag
  // to dismiss would read to it as a swipe to the previous reel. Immediate as
  // well as ordinary propagation: its listener may be on the same node as ours.
  if (Math.abs(dy) > SWALLOW_PX) {
    e.stopPropagation();
    e.stopImmediatePropagation();
    swallowedGesture = true;
  }

  if (glassDragStartY !== null) {
    dragGlassBy(y - glassDragStartY);
    return;
  }

  if (mine || swipeStartY === null || isOpen() || !canOpen()) return;
  if (dy >= OPEN_SWIPE_PX) {
    swipeStartY = null;      // one opening per gesture
    open();
  } else if (dy <= -OPEN_SWIPE_PX) {
    swipeStartY = null;
    void goBack();
  }
}

/** A swipe DOWN on a reel means what it has always meant: the one before.
 *
 *  Only the forward direction is being replaced here. Going back was never the
 *  problem — the feed does not decide anything for you on the way back, it just
 *  returns something you have already chosen once — so taking it away bought
 *  nothing and cost the gesture everybody already has in their thumb.
 *
 *  It has to be re-sent rather than let through: by the time we know a gesture
 *  is a downward swipe we have already swallowed it (see onTouchMove), and a
 *  half-delivered gesture is worse than none. So the real one is suppressed and
 *  an identical synthetic one is handed to Instagram, which navigates itself. */
/** Go back by scrolling, on a feed that scrolls.
 *
 *  The synthetic swipe below exists for the stacked pager, whose own gesture
 *  recogniser reads the touch stream; on a scroller a dispatched touch event
 *  moves nothing at all — going back simply did nothing there. A pager parks
 *  its scrollTop at zero, so any real scroll offset is the scroller giving
 *  itself away, and the way back is the previous slide's own position. */
function goBackLocal(): boolean {
  const scroller = feedEl;
  if (!scroller || scroller.scrollTop <= 8) return false;
  const current = scroller.scrollTop;
  let target: number | null = null;
  for (const child of Array.from(scroller.children)) {
    if (!(child instanceof HTMLElement)) continue;
    const top = child.offsetTop;
    if (top < current - 8 && (target === null || top > target)) target = top;
  }
  // No slide-shaped child above (a single tall wrapper, say): one screen back
  // is still right on any scroller, and the snap point is a slide boundary.
  if (target === null || target < current - scroller.clientHeight * 1.5) {
    target = Math.max(0, current - scroller.clientHeight);
  }
  driveTo(scroller, target);
  return true;
}

async function goBack(): Promise<void> {
  const gen = ++restockGen;
  driving = true;
  try {
    // Scrolling is the ONLY way this moves. There used to be a synthetic-swipe
    // fallback here — fabricated touch events aimed at Instagram's own gesture
    // recogniser — and on the device it is exactly what "the reel gets forcibly
    // replaced" looks like. A feed whose scroller has nowhere to go simply
    // stays put now.
    if (!goBackLocal()) {
      console.debug('[Bouncer IG] back: no scroll position above to return to');
      return;
    }
    // Hold `driving` until the feed has actually stopped, exactly as arriveAt
    // does. The user's own touchend armed the pin for GESTURE_TAIL_MS, and the
    // scroller settles over several hundred milliseconds — released early, the
    // pin read the navigation we just asked for as a drift and yanked the feed
    // back, which is a swipe-down that jerks and lands nowhere.
    await settleAfterSwipe(null, gen);
  } finally {
    driving = false;
    repin();
  }
}

/** The end of a swallowed swipe is swallowed too. A recogniser that never saw
 *  the movement can still act on the release — "finger lifted, commit" — and it
 *  would commit to a swipe we spent the whole gesture refusing. */
function onTouchEnd(e: Event): void {

  if (swallowedGesture) {
    e.stopPropagation();
    e.stopImmediatePropagation();
  }

  const upY = touchY(e);
  if (glassDragStartY !== null) {
    if (upY !== null) endGlassDrag(upY - glassDragStartY);
    glassDragStartY = null;
    swallowedGesture = false;
    touching = false;
    gestureStartY = null;
    gestureUntil = performance.now() + GESTURE_TAIL_MS;
    return;
  }

  // Last chance to honour the swipe. A flick fast enough can be over before a
  // single touchmove reaches us — iOS takes the gesture for itself and sends a
  // touchcancel instead, which is exactly the "swiped too hard" case — and the
  // release still carries where the finger ended up. Measured from the start of
  // the gesture, so it is the same swipe by the same rule, just read later.
  const endY = touchY(e);
  if (swipeStartY !== null && endY !== null && swipeStartY - endY >= OPEN_SWIPE_PX
      && !isOpen() && canOpen()) {
    open();
  }

  swallowedGesture = false;
  overlayGesture = false;
  touching = false;
  swipeStartY = null;
  gestureStartY = null;
  gestureUntil = performance.now() + GESTURE_TAIL_MS;
}

/** The same swallow for pointer events, which are a second, parallel account of
 *  the same finger — blocking one stream and leaving the other open would leave
 *  the recogniser everything it needs. */
function onPointerDown(e: PointerEvent): void {

  pointerStartY = ours(e) ? null : e.clientY;
}

function onPointerMove(e: PointerEvent): void {
  if (overlayGesture) return;

  if (pointerStartY === null || ours(e)) return;
  if (Math.abs(e.clientY - pointerStartY) <= SWALLOW_PX) return;
  if (e.cancelable) e.preventDefault();
  e.stopPropagation();
  e.stopImmediatePropagation();
}

function onPointerUp(): void {
  pointerStartY = null;
}

function onWheel(e: WheelEvent): void {
  if (ours(e)) return;
  if (e.cancelable) e.preventDefault();
  if (isOpen() || !canOpen()) {
    wheelAccum = 0;
    wheelBackAccum = 0;
    return;
  }
  // Each direction accumulates only its own ticks, and an opposite tick resets
  // it — otherwise a jittery trackpad eventually sums its way to a threshold on
  // its own. Down is "what's next" (the glass); up is "the reel before", the
  // same meaning a downward touch swipe has — without this, a wheel or trackpad
  // had no way back at all.
  if (e.deltaY > 0) {
    wheelAccum += e.deltaY;
    wheelBackAccum = 0;
  } else if (e.deltaY < 0) {
    wheelBackAccum -= e.deltaY;
    wheelAccum = 0;
  }
  if (wheelAccum >= WHEEL_OPEN_DELTA) {
    wheelAccum = 0;
    open();
  } else if (wheelBackAccum >= WHEEL_OPEN_DELTA) {
    wheelBackAccum = 0;
    reopenAfter = performance.now() + WHEEL_BACK_BLOCK_MS;
    void goBack();
  }
}

function canOpen(): boolean {
  return performance.now() >= reopenAfter;
}

/** Put back anything a swipe just moved. Every locked element, not only the
 *  innermost — the drift can be in an outer one, and that looks identical to
 *  the user. */
function onFeedScroll(): void {
  if (programmatic() || !pinning()) return;
  for (const l of locked) {
    if (l.el.scrollTop !== l.pin) l.el.scrollTop = l.pin;
  }
}

/** Run a move that IS allowed to change where the feed sits, and adopt where it
 *  lands as the new resting place. The claim covers the move rather than just
 *  the call, because the scroll events it causes arrive after it returns. */
function moveFeed(fn: () => void): void {
  claimScroll();
  try {
    fn();
  } finally {
    setTimeout(repin, CLAIM_MS);
  }
}

// ==================== Keeping the feed stocked ====================
//
// Instagram's feed is infinite only as a consequence of scrolling: it appends
// the next batch when a scroll brings the end of the loaded list into view.
// Taking the swipe away takes that with it, so the feed quietly stops growing.
// The chooser can only offer reels that exist, so after a dozen or so it has
// nothing new to say and the feed ends in black — which is the whole bug, and
// it is caused by the lock rather than merely coinciding with it.
//
// So the chooser stocks the feed itself, while the glass is up.
//
// Two things keep that from being visible, because the reel shows through the
// glass and a feed scrolling past behind it would be the most distracting thing
// on screen:
//
//   it only runs when the feed is actually running low (RESTOCK_AHEAD_MIN), so
//   most openings move nothing at all;
//
//   and while it does run, a still of the reel you're on is pinned over the
//   feed (coverWith), so what shows through the glass is your reel, exactly
//   where you left it, for the second or two the walk takes.
//
// The walk has two halves, and they want opposite things.
//
// LOADING wants the very end of the list. Instagram appends when the end comes
// into view, and nothing short of that will do — which is what the first version
// of this got wrong. It hopped forward a screen at a time, six times, and gave
// up after two hops that didn't move; against a list a dozen reels long it never
// reached the end at all, and when it did reach it, 600ms was not long enough
// for a request to come back. It walked, found nothing, and put the feed back —
// so past the first dozen reels the chooser kept offering the same three, which
// is exactly the report. Now it JUMPS to the bottom and WAITS there, watching
// for the list to grow, and does it again if it does.
//
// DISCOVERY wants the reels in between. A reel is only found once Instagram has
// mounted its <video> (see cardFromCover in ../index.ts), and Instagram only
// mounts them near the viewport — so the jump that loads a batch discovers
// almost none of it. That is what the walk back is for: from the new end,
// homeward a screen at a time, mounting as it goes.
//
// Load, then discover, then home. The still frame is up for all of it.

/** Pause between steps of the walk back — long enough for Instagram to mount
 *  the videos it just scrolled to, which is what makes them discoverable. */
const RESTOCK_HOP_MS = 260;
/** How many screens of the newly-loaded tail to walk back through. The new
 *  reels are all at the end, so this only has to cover the batch. */
const RESTOCK_WALK_SCREENS = 8;
/** How long to sit at the end waiting for a batch to arrive, and how often to
 *  look. A request over a phone connection is most of a second on a good day. */
const RESTOCK_LOAD_WAIT_MS = 2500;
const RESTOCK_POLL_MS = 150;
/** How many batches to pull in one visit. Two is a couple of dozen reels — more
 *  than a session's worth of choosing, and a bounded amount of feed movement. */
const RESTOCK_ROUNDS = 2;
/** Reels still ahead of the one you're on, below which it's worth going to get
 *  more. The window offers three, so this is a couple of openings' worth of
 *  slack — enough that the walk is the exception rather than the rule. */
// Was 6, and that is why picking landed on random reels.
//
// Restocking WALKS THE FEED: four swipes forward to make Instagram load more,
// then four back. It hides that behind a still frame, which works right up
// until a pick interrupts it — the cover is replaced, the walk stops wherever
// it had got to, and the journey now starts several reels from where the user
// thought they were. Measured from the device log: `restocking=true` at pick
// time, then `step cap reached`, then a reel nobody chose.
//
// At 6 it ran on nearly every opening, because the signed-in feed reveals
// reels slowly enough that six ahead is rare (see ./durations.ts). At
// WINDOW_SIZE it runs only when the chooser genuinely cannot fill its three
// rows — which is the case it was written for.
const RESTOCK_AHEAD_MIN = WINDOW_SIZE;

// Bumped by anything that takes over where the feed should be, which is how an
// in-flight restock learns its restore is no longer wanted.
let restockGen = 0;
// Where to put the feed back, and the flag that one is in flight.
let restockHome: { scroller: HTMLElement; top: number } | null = null;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/** A full-screen still of one reel, held over the feed while the feed moves.
 *
 *  Two jobs, one mechanism. Restocking uses it to hide a walk to the end of the
 *  list behind a picture of the reel you're on. Picking uses it to hide the
 *  journey to the reel you chose behind a picture of THAT — because getting
 *  there is now a swipe per reel, and watching the feed flick through two reels
 *  you didn't ask for on the way to the one you did is worse than any wait. With
 *  the cover up it reads as what it is: you chose, and then you were there.
 *
 *  `from` grows it out of the row that was tapped, so the choice and the cover
 *  are one movement rather than a cut to a loading screen. */
function coverWith(record: ReelRecord | null, from?: DOMRect): HTMLElement | null {
  document.getElementById(STILL_ID)?.remove();
  if (!record) return null;
  const img = document.createElement('img');
  img.id = STILL_ID;
  img.src = record.thumbnailUrl;
  img.alt = '';
  img.style.cssText = [
    'position: fixed',
    'inset: 0',
    'width: 100%',
    'height: 100%',
    'object-fit: cover',
    // Opaque even when the picture never arrives. A thumbnail URL is a CDN
    // token with an expiry, and an <img> whose load failed paints NOTHING —
    // a transparent "cover" over a feed being walked, which from the outside
    // is reels flashing past unplayed. Black is what a reel's own letterbox
    // already is; a beat of it reads as loading.
    'background: #000',
    'pointer-events: none',
    `z-index: ${STILL_Z}`,
  ].join(';');
  (document.body ?? document.documentElement).appendChild(img);
  if (from) flipFrom(img, from, SHRINK_MS);
  return img;
}

/** Take the cover away, revealing wherever the feed has got to. */
function uncover(): void {
  const img = document.getElementById(STILL_ID);
  if (!img) return;
  img.removeAttribute('id');
  img.style.transition = `opacity ${UNCOVER_MS}ms ease`;
  img.style.opacity = '0';
  setTimeout(() => img.remove(), UNCOVER_MS);
}

/** End any restock in flight. `restore` is false when the caller has already
 *  decided where the feed belongs — picking a reel scrolls to it, and putting
 *  the feed "back" afterwards would undo the navigation. */
function endRestock(restore: boolean): void {
  restockGen++;
  const home = restockHome;
  restockHome = null;
  uncover();
  if (!restore || !home) return;
  moveFeed(() => {
    home.scroller.scrollTop = home.top;
    // And by the reel, not only by the number. A synthetic swipe moves
    // Instagram's own pager, which may have re-laid the feed out underneath the
    // coordinate we remembered — the card is the thing that has to be back on
    // screen, so it gets the last word.
    const anchor = host?.records()[0];
    if (anchor?.card.isConnected) {
      anchor.card.scrollIntoView({ behavior: 'auto', block: 'center' });
    }
  });
}

/** Whether the feed is close enough to running out to be worth going for more.
 *  Everything below this point moves the feed, so nothing below it runs unless
 *  this says so. */
function needsStock(): boolean {
  const ahead = Math.max(0, (host?.records().length ?? 0) - 1);
  return ahead < RESTOCK_AHEAD_MIN;
}

/** Put `scroller` where we say, without the pin treating it as a swipe. */
function driveTo(scroller: HTMLElement, top: number): void {
  claimScroll();
  scroller.scrollTop = top;
}

/** A beat for a programmatic scroll to start moving before the stillness
 *  polling below begins — otherwise the first two polls agree the feed is
 *  still because it has not started yet. */
const SIM_STEP_SETTLE_MS = 180;

/** How long to keep watching a feed that is still moving, and how often. The
 *  signed-in pager ANIMATES its snap — a fixed beat raced it and lost. */
const SETTLE_POLL_MS = 90;
const SETTLE_TIMEOUT_MS = 900;

/** Where the feed is, by the best measure available: the card being aimed at
 *  when it has real geometry, else the scroller. */
function motionProbe(record: ReelRecord | null): string {
  // The route first, because it is the one thing that always moves when this
  // feed does: every reel has its own address and the pager rewrites it on
  // arrival. Then the reel actually painted. Geometry last, for a feed laid
  // out in a line where a rectangle really does travel.
  //
  // This used to be `rect.top` alone, and on the stacked pager that is a
  // constant zero — so "has it stopped moving?" answered YES on the first poll
  // every single time. Swipes then went out every ~270ms into a pager still
  // animating the last one, it queued them, and the ones still in flight when
  // the walk decided it had arrived kept advancing the feed afterwards. That
  // is the drift after landing; the corrector then chased it, and the device
  // log ends "lost sight of the feed after 12 swipe(s)", 7920px from home.
  const painted = visibleRecord()?.reelId ?? '';
  let geometry = feedEl?.scrollTop ?? 0;
  if (record?.card.isConnected) {
    const rect = record.card.getBoundingClientRect();
    if (rect.height >= 1) geometry = rect.top;
  }
  return `${location.pathname}|${painted}|${Math.round(geometry)}`;
}

/** Wait until the feed has actually stopped moving — not a fixed beat.
 *
 *  The fixed beat is what made picking buggy signed in: that pager animates
 *  its own snap over several hundred milliseconds, so the next swipe launched
 *  into a feed mid-flight, and the pin re-armed against a position that was
 *  still changing — adopting a mid-animation scroll as "home" and then
 *  faithfully yanking the feed back to it. */
async function settleAfterSwipe(record: ReelRecord | null, gen: number): Promise<void> {
  await wait(SIM_STEP_SETTLE_MS);
  let last = motionProbe(record);
  // Two consecutive identical readings, not one. A single match can catch the
  // pager between two frames of its own animation; asking twice costs one poll
  // and means "still" actually means still.
  let stillFor = 0;
  for (let waited = 0; waited < SETTLE_TIMEOUT_MS; waited += SETTLE_POLL_MS) {
    if (gen !== restockGen) return;
    await wait(SETTLE_POLL_MS);
    const now = motionProbe(record);
    if (now === last) {
      if (++stillFor >= 2) return;
    } else {
      stillFor = 0;
      last = now;
    }
  }
}

/** The reel actually on screen, whatever the layout — by hit-testing rather
 *  than by measuring.
 *
 *  MEASURED ON DEVICE, and the reason this exists: every card on the signed-in
 *  feed reports the same rectangle, `660h@0`. Nine reels, one box, all stacked
 *  — which slide you are looking at is decided by paint order, not position.
 *  So every rectangle-based question was answering about the layout instead of
 *  about the feed: "is the chosen reel at the top of the screen" was true of
 *  all nine at once, which is how a pick could report ON SCREEN while plainly
 *  showing something else.
 *
 *  What is painted at the middle of the screen is the reel being watched, and
 *  hit-testing is the only thing that knows. `elementsFromPoint` rather than
 *  the singular form: the topmost thing at that point is often Instagram's own
 *  overlay or our cover, so the whole stack is walked and the first entry
 *  belonging to a known card wins — which, since the stack is ordered
 *  front-to-back, is the frontmost reel. Elements with `pointer-events: none`
 *  are skipped by hit-testing entirely, so our own still frame is invisible to
 *  this by construction. */
function visibleRecord(): ReelRecord | null {
  const stack = document.elementsFromPoint?.(
    Math.round(window.innerWidth / 2),
    Math.round(window.innerHeight / 2),
  ) ?? [];
  if (stack.length === 0) return null;
  const records = host?.records() ?? [];
  for (const el of stack) {
    for (const record of records) {
      if (record.card.isConnected && record.card.contains(el)) return record;
    }
  }
  return null;
}

/** Sit at the end of the list until it grows, or until it's clear it won't.
 *  Returns whether anything arrived. */
async function waitForGrowth(scroller: HTMLElement, was: number, gen: number): Promise<boolean> {
  for (let waited = 0; waited < RESTOCK_LOAD_WAIT_MS; waited += RESTOCK_POLL_MS) {
    await wait(RESTOCK_POLL_MS);
    if (gen !== restockGen) return false;
    if (scroller.scrollHeight > was + 8) return true;
    // Instagram loads when the end is IN VIEW, and a list that just grew leaves
    // us short of the new end. Stay pinned to the bottom while we wait.
    driveTo(scroller, scroller.scrollHeight);
  }
  return false;
}

async function restock(): Promise<void> {
  const scroller = feedEl;
  if (restockHome) return;
  const gen = ++restockGen;
  const home = scroller?.scrollTop ?? 0;
  restockHome = scroller ? { scroller, top: home } : null;
  // Before the first move, not after: the cover is what makes this invisible.
  // And WITHOUT one there is no first move. A feed nothing was discovered on
  // has no still to hide behind, and the walk in the open is reels flashing
  // past unplayed — strictly worse than a sheet with nothing new to offer.
  if (coverWith(host?.records()[0] ?? null) === null) {
    console.debug('[Bouncer IG] restock: no reel to cover the walk with — staying put');
    restockHome = null;
    return;
  }
  driving = true;

  try {
    // By scrolling, and only by scrolling. This used to lead with a walk of
    // fabricated touch gestures ("swipes first, because this is a pager") and
    // that walk is what "the feed flashes through reels nobody is playing"
    // looks like when anything lets it show. Instagram loads more when the end
    // of the list comes into view, and a scroll puts it there.
    if (scroller) {
      for (let round = 0; round < RESTOCK_ROUNDS; round++) {
        const was = scroller.scrollHeight;
        driveTo(scroller, scroller.scrollHeight);
        const arrived = await waitForGrowth(scroller, was, gen);
        if (gen !== restockGen) return;
        if (!arrived) break;
      }

      // Homeward a screen at a time, so the reels that just arrived get their
      // videos mounted and can be discovered.
      for (let hop = 0; hop < RESTOCK_WALK_SCREENS; hop++) {
        if (scroller.scrollTop <= home) break;
        driveTo(scroller, Math.max(home, scroller.scrollTop - Math.max(1, scroller.clientHeight)));
        await wait(RESTOCK_HOP_MS);
        if (gen !== restockGen) return;
      }
    }
  } finally {
    // Only when this restock is still the operation in charge. Superseded by a
    // pick, it would otherwise hand the hold back and adopt a resting place in
    // the middle of the pick's journey — re-arming the pin against a feed that
    // is deliberately moving, which is the other half of "it went back".
    if (gen === restockGen) {
      driving = false;
      repin();
    }
  }
  if (gen === restockGen) endRestock(true);
}

// ==================== Geometry ====================

/** Animate `el` as though it had started life filling `from`, and let it settle
 *  into wherever CSS has actually put it. Transform-only, so the browser never
 *  re-lays-out mid-flight. */
function flipFrom(el: HTMLElement, from: DOMRect, ms: number): void {
  const to = el.getBoundingClientRect();
  if (to.width < 1 || to.height < 1) return;
  const sx = from.width / to.width;
  const sy = from.height / to.height;
  el.style.transformOrigin = 'top left';
  el.style.transition = 'none';
  el.style.transform =
    `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(${sx}, ${sy})`;
  void el.offsetWidth;   // commit the start frame before transitioning off it
  el.style.transition = `transform ${ms}ms ${EASE}`;
  el.style.transform = 'none';
}

// ==================== Styles ====================

function injectStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = [
    // The glass arrives by fading in; the rows come up behind it, so the two
    // read as one surface settling rather than a panel being pushed on.
    '@keyframes bouncer-ig-glass-in {',
    '  from { opacity: 0; }',
    '  to { opacity: 1; }',
    '}',
    // The sheen's drift. Slow enough to be weather rather than animation: a
    // full cycle takes most of a minute, and the light never arrives anywhere
    // you were looking. Transform only, so it costs a composite and no layout.
    '@keyframes bouncer-ig-sheen-drift {',
    '  0% { transform: translate3d(-3%, -2%, 0); }',
    '  50% { transform: translate3d(3%, 2%, 0); }',
    '  100% { transform: translate3d(-3%, -2%, 0); }',
    '}',
    `#${GLASS_ID} .bouncer-ig-sheen {`,
    '  animation: bouncer-ig-sheen-drift 26s ease-in-out infinite;',
    '}',
    '@media (prefers-reduced-motion: reduce) {',
    `  #${GLASS_ID} .bouncer-ig-sheen { animation: none; }`,
    '}',
    '@keyframes bouncer-ig-fadein {',
    '  from { opacity: 0; }',
    '  to { opacity: 1; }',
    '}',
    '@keyframes bouncer-ig-rise {',
    '  from { opacity: 0; transform: translateY(18px); }',
    '  to { opacity: 1; transform: translateY(0); }',
    '}',
    `#${GLASS_ID} .bouncer-ig-opt {`,
    '  transition: background 0.15s ease, transform 0.15s ease;',
    '}',
    // The only fill anywhere on the glass, and only while a finger is on it: a
    // row is text and a picture floating on the reel until you touch it.
    `#${GLASS_ID} .bouncer-ig-opt:active {`,
    '  background: rgba(255,255,255,0.14); transform: scale(0.985);',
    '}',
  ].join('\n');
  (document.head ?? document.documentElement).appendChild(style);
}

// ==================== Arriving ====================

/** Go to a chosen reel, behind a picture of it.
 *
 *  The picture goes up first, growing out of the row that was tapped, and stays
 *  up for the whole journey — which is a swipe per reel between here and there.
 *  Then it fades, and what is underneath is the reel it was a picture of. From
 *  the outside: you chose, briefly saw the thing you chose, and then it started
 *  playing.
 *
 *  The alternative was showing the journey, and the journey is two reels you
 *  didn't ask for flicking past on the way to the one you did. */
/** How long to keep the reel we chose on screen after landing on it, and how
 *  often to check. Long enough to outlast the pager's own correction, short
 *  enough that it is plainly a landing and not a grip on the feed. */
const ARRIVAL_HOLD_MS = 2500;
const ARRIVAL_POLL_MS = 120;
/** How far the chosen reel may drift before it is put back. Generous, so a
 *  pager animating INTO place is left to finish rather than fought. */
const ARRIVAL_DRIFT = 0.35;
/** How many times a landing may be put back before we stop. If the feed is
 *  advancing on its own faster than this, holding it is a fight the user did
 *  not ask for — and the verdict line says so rather than pretending. */
const MAX_ARRIVAL_CORRECTIONS = 2;
/** The longest the still frame may stay up waiting for the pager to settle.
 *
 *  A correction the user can SEE is "it showed another reel and then moved to
 *  mine" — the report, exactly. Corrections behind the cover are invisible, so
 *  the cover waits for the feed to stop arguing. Bounded, because a still
 *  frame that outstays the pager is its own kind of wrong: past this the reel
 *  is revealed wherever it is, and the hold carries on quietly underneath. */
const SETTLE_UNDER_COVER_MS = 1500;
/** How many polls the chosen reel must hold the screen before the cover comes
 *  down. Two was too eager: the pager is still settling for a beat after the
 *  last swipe lands, so the cover lifted and the settling played out in the
 *  open. */
const STEADY_POLLS = 4;
/** How many polls a WRONG reel must hold the screen before it counts as drift.
 *
 *  Mid-animation a pager paints its neighbours — the outgoing slide, or the
 *  next one sliding in — and hit-testing the middle of the screen catches
 *  whichever is in front at that instant. Correcting on the first sighting
 *  meant correcting against a frame of somebody else's animation, and the
 *  device log shows what that produces: "drifted → one swipe back", then
 *  "drifted → one swipe forward", landing back where it started. An
 *  oscillation, which from the outside is "it scrolls up and then scrolls
 *  back down very obviously". Real drift persists; a transient does not. */
const WRONG_POLLS = 2;

/** Keep the reel we just arrived at on screen for a moment.
 *
 *  Arriving and staying are different things, and the report is about the
 *  second one: the chosen reel appears, plays for a second or two, then
 *  glitches back to the reel you came from.
 *
 *  Instagram's pager keeps its own idea of which slide is current, and neither
 *  a scrollIntoView nor a synthetic swipe it did not believe updates that. So
 *  it re-asserts — a beat later, on its own schedule, animating the feed back
 *  to where IT thinks you are. The same shape can come from our side too: a
 *  re-lock during the journey (refresh() calls lockScroll, and Instagram
 *  mutates constantly while navigating) can capture the pre-pick position as
 *  the pin's resting place, and the hold then undoes the arrival on the next
 *  scroll it sees.
 *
 *  Rather than guess which, this holds the OUTCOME: for a short window,
 *  anything that moves the chosen reel off screen is put back, and each
 *  correction re-pins so the destination becomes the resting place rather than
 *  the origin. It stands down the moment the user touches the screen — their
 *  swipe is not a drift — and expires on its own. */
async function holdArrival(record: ReelRecord, gen: number): Promise<void> {
  let corrections = 0;
  let steady = 0;
  let wrongFor = 0;

  // The cover stays up until the reel we chose has been the painted one for
  // two polls running — or until the deadline, because a still frame that
  // outstays the pager is its own kind of wrong. Only ever lifted while this
  // pick is still the current one: superseded, the cover on screen belongs to
  // the pick that replaced us.
  let uncovered = false;
  const reveal = (): void => {
    if (uncovered || gen !== restockGen) return;
    uncovered = true;
    uncover();
  };
  const coverUntil = performance.now() + SETTLE_UNDER_COVER_MS;

  // The one line that says whether picking a reel actually worked. Printed on
  // every exit, whatever the reason — without it the log says how the journey
  // was steered and then stops, which is the half that was never in doubt.
  const verdict = (why: string): void => {
    // Hit-testing first, for the same reason visibleRecord exists at all: on a
    // stacked pager a rectangle says ON SCREEN about every reel at once, which
    // is a verdict that cannot fail and therefore cannot be trusted. Naming
    // the reel actually painted is what makes this line worth reading.
    const seen = visibleRecord();
    let where: string;
    if (seen !== null) {
      where = seen.reelId === record.reelId
        ? 'ON SCREEN'
        : `WRONG REEL — showing ${seen.reelId}`;
    } else {
      const rect = record.card.isConnected ? record.card.getBoundingClientRect() : null;
      where = rect !== null && rect.height >= 1
        ? `cannot hit-test; card at top ${Math.round(rect.top)} of ${Math.round(rect.height)}`
        : 'cannot hit-test; card unmounted';
    }
    console.warn(`[Bouncer IG] pick: settled on ${record.reelId} — ${where};`
      + ` ${why}; ${corrections} correction(s)`);
    reveal();
  };

  for (let waited = 0; waited < ARRIVAL_HOLD_MS; waited += ARRIVAL_POLL_MS) {
    await wait(ARRIVAL_POLL_MS);
    // Superseded by another pick, or the user has taken the feed back.
    if (gen !== restockGen) { verdict('superseded by another move'); return; }
    if (touching) { verdict('user took the feed back'); return; }
    if (isOpen()) { verdict('chooser reopened'); return; }

    // Drift, asked the same way arriving was: which reel is PAINTED.
    //
    // This used to compare `rect.top` against the card's height, and on the
    // layout the device uses that is a test that can never fire — every card
    // sits at top 0, so the hold concluded "no drift" no matter what was on
    // screen. Its own verdict line said WRONG REEL and 0 corrections in the
    // same breath: the diagnosis had been converted to hit-testing and the
    // thing that acts on it had not.
    if (performance.now() >= coverUntil) reveal();

    const seen = visibleRecord();
    if (seen !== null) {
      if (seen.reelId === record.reelId) {
        wrongFor = 0;
        if (++steady >= STEADY_POLLS) reveal();         // settled: show it
        continue;
      }
      steady = 0;
      // Seen once is not drift — see WRONG_POLLS. Waiting one more poll costs
      // a tenth of a second and is the difference between correcting a real
      // drift and chasing a frame of the pager's own animation.
      if (++wrongFor < WRONG_POLLS) continue;
      // Measured and reported, never acted on. Acting meant navigation this
      // surface no longer performs (see arriveAt: scrolling only), and the
      // device logs showed the corrections themselves causing the visible
      // round trips they were meant to cure.
      verdict(`reported drift to ${seen.reelId}, not corrected`);
      return;
    }

    // No hit-test available: fall back to the geometry test, which is right on
    // a feed that lays its slides out in a line.
    if (!record.card.isConnected) { verdict('card recycled'); return; }
    const rect = record.card.getBoundingClientRect();
    if (rect.height < 1) { verdict('card unmounted'); return; }
    if (Math.abs(rect.top) <= rect.height * ARRIVAL_DRIFT) continue;

    corrections++;
    if (corrections > MAX_ARRIVAL_CORRECTIONS) {
      verdict('drifting faster than it can be held');
      return;
    }
    console.debug(`[Bouncer IG] pick: ${record.reelId} drifted to `
      + `${Math.round(rect.top)}px after landing — putting it back`);
    claimScroll();
    record.card.scrollIntoView?.({ behavior: 'auto', block: 'center' });
    repin();
  }
  verdict('hold expired');
}

/** How long to give Instagram's own router before deciding it ignored us, and
 *  how often to look while waiting.
 *
 *  Was a single 900ms check, and the reload it triggered was the jerk every
 *  pick produced. The router usually DOES respond to the pushState — the live
 *  log shows the feed container being torn down within a beat — but proving
 *  the target reel is on screen requires the rebuilt feed to be re-DISCOVERED
 *  (video mounted, scan debounce, cover matched), which takes well over 900ms.
 *  So jumpToReel declared failure mid-navigation and location.assign'd a full
 *  page load on top of it: a white flash, a several-second dead zone while the
 *  content script re-booted, and a landing in a shallower feed. Poll the whole
 *  window instead; the reload stays as the fallback for a router that truly
 *  did nothing. */
async function arriveAt(record: ReelRecord, from: DOMRect): Promise<void> {
  const gen = ++restockGen;
  coverWith(record, from);
  driving = true;
  try {
    // Scrolling, and NOTHING but scrolling. This used to have three levers —
    // scroll, a pushState into Instagram's router (with a full page load as
    // its own fallback), and a walk of fabricated touch gestures — and every
    // lever past the first is what "the reel gets forcibly replaced" looks
    // like from the device: the router route tears the whole feed down and
    // frequently ends in a white-flash reload, and the synthetic swipes flick
    // the pager through reels nobody is playing. goTo is Instagram's own
    // scroller moving to the chosen card; whatever it cannot reach, this
    // surface no longer pretends it can.
    claimScroll();
    host?.goTo(record);
    // Hold `driving` until the feed has actually stopped. The tap that picked
    // the row armed the pin's gesture tail, which outlives any fixed claim by
    // more than a second — and the signed-in pager is still animating its snap
    // when a 400ms claim lapses. Releasing early meant the pin adopted a
    // mid-flight position as home and then dutifully yanked the feed back to
    // it: the pick that "worked" and then undid itself.
    await settleAfterSwipe(record, gen);
  } finally {
    driving = false;
    // Wherever everything now sits is, by definition, home.
    repin();
  }
  // The cover comes down inside holdArrival, not here.
  //
  // It used to lift one frame after the journey, which put every correction
  // ON SCREEN — and a correction is exactly "it showed another reel and then
  // moved to mine", which is the report. The pager is still making up its
  // mind for a beat after the last swipe lands; that beat belongs behind the
  // still frame. Not awaited, so the hold's long tail stays in the background.
  void holdArrival(record, gen);
}

// ==================== The glass ====================

function meta(record: ReelRecord): string {
  const total = record.durationSec;
  if (total === null || !Number.isFinite(total) || total <= 0) return '';
  const secs = Math.round(total);
  return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
}

/** How big a row's thumbnail can be on this screen.
 *
 *  Three rows have a whole phone screen between them, so the thumbnails are the
 *  one element with room to spare — and a reel is a picture before it is a
 *  sentence, so spending that room on them is most of what makes the glass
 *  answerable at a glance.
 *
 *  Bounded from both directions, because either one alone goes wrong: by the
 *  height three rows can share (or the last row falls off the screen), and by
 *  the width the title needs left over (or the description sets one word per
 *  line and the row stops being readable at exactly the size that made it
 *  legible). Exported for tests. */
export function rowThumbSize(
  viewportWidth: number = window.innerWidth,
  viewportHeight: number = window.innerHeight,
): { width: number; height: number } {
  const byHeight =
    (viewportHeight - GLASS_CHROME_PX) / WINDOW_SIZE - ROW_PAD_PX * 2 - LIST_GAP_PX;

  const rowWidth = viewportWidth - GLASS_PAD_X_PX * 2 - ROW_PAD_PX * 2;
  const byWidth = (rowWidth - ROW_TEXT_MIN_W_PX - ROW_GAP_PX) / THUMB_ASPECT;

  const height = Math.round(Math.max(
    ROW_THUMB_MIN_H_PX,
    Math.min(ROW_THUMB_MAX_H_PX, byHeight, byWidth),
  ));
  return { width: Math.round(height * THUMB_ASPECT), height };
}

function resetSlots(): void {
  slotRecords = Array.from({ length: WINDOW_SIZE }, () => null);
}

/** Pull the picture down before anything needs it.
 *
 *  A row is held back until its words are ready, which takes a beat — and this
 *  spends that beat fetching the image, so the two finish together and the row
 *  arrives whole. Fire and forget: a failure here just means the row mounts
 *  with its thumbnail still arriving, into a box that was already the right
 *  size. */
function prefetchThumb(url: string): void {
  if (!url || thumbsRequested.has(url)) return;
  thumbsRequested.add(url);
  try {
    const pre = new Image();
    pre.decoding = 'async';
    pre.src = url;
  } catch {
    /* no Image in this environment; the row's own <img> will do the work */
  }
}

/** Give each slot its reel, once, and refresh the facts of the ones already
 *  placed. See the note on `slotRecords` for why nothing here may reorder. */
function assignSlots(): void {
  if (slotRecords.length !== WINDOW_SIZE) resetSlots();
  const offer = windowRecords();
  const live = host?.records() ?? [];

  for (let i = 0; i < WINDOW_SIZE; i++) {
    const held = slotRecords[i];
    if (!held) {
      slotRecords[i] = offer[i] ?? null;
      continue;
    }
    // Same slot, same reel — only its facts are allowed to move. Looked up by
    // id rather than by position precisely because position is the thing that
    // drifts.
    const inPlace = offer[i]?.reelId === held.reelId ? offer[i] : undefined;
    const fresh = inPlace
      ?? offer.find((r) => r.reelId === held.reelId)
      ?? live.find((r) => r.reelId === held.reelId);
    if (fresh) slotRecords[i] = fresh;
  }
}

/** An empty slot: the row's exact height, holding its place in the list while
 *  the reel that goes there is still being described. */
function buildSlot(height: number): HTMLElement {
  const slot = document.createElement('div');
  slot.setAttribute('data-ff-slot', '');
  slot.style.cssText = [
    'flex: 0 0 auto',
    `height: ${height}px`,
    'display: flex',
    'align-items: center',
  ].join(';');
  return slot;
}

/** What a slot shows before its row is ready. Quiet on purpose — it is holding
 *  space, not asking to be read. */
function buildSkeleton(thumbSize: { width: number; height: number }): HTMLElement {
  const skeleton = document.createElement('div');
  skeleton.className = 'bouncer-ig-skel';
  skeleton.setAttribute('aria-hidden', 'true');
  skeleton.style.cssText = [
    'display: flex',
    'align-items: center',
    `gap: ${ROW_GAP_PX}px`,
    `padding: ${ROW_PAD_PX}px`,
    'width: 100%',
    'box-sizing: border-box',
  ].join(';');

  const box = document.createElement('div');
  box.style.cssText = [
    'flex: 0 0 auto',
    `width: ${thumbSize.width}px`,
    `height: ${thumbSize.height}px`,
    'border-radius: 12px',
    'background: rgba(255,255,255,0.10)',
    'border: 1px solid rgba(255,255,255,0.14)',
  ].join(';');

  const lines = document.createElement('div');
  lines.style.cssText = 'flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 8px';
  for (const width of ['78%', '54%', '32%']) {
    const bar = document.createElement('div');
    bar.style.cssText = [
      'height: 12px',
      `width: ${width}`,
      'border-radius: 6px',
      'background: rgba(255,255,255,0.10)',
    ].join(';');
    lines.appendChild(bar);
  }

  skeleton.append(box, lines);
  return skeleton;
}

/** Put `record` in `slot` — but only once it is whole, and only ever in this
 *  slot. A row that is already mounted is never rebuilt: it is what the user is
 *  looking at and possibly already reaching for. */
function fillSlot(
  slot: HTMLElement,
  record: ReelRecord | null,
  thumbSize: { width: number; height: number },
): void {
  // Mounted, and it stays mounted — but its late facts may change IN PLACE.
  // The byline and the length routinely land after the row does (signed in,
  // the length may never come at all — see isRecordComplete), and both write
  // into elements whose size was fixed at build time, so nothing moves.
  if (slot.dataset.ffReel) {
    if (record && slot.dataset.ffReel === record.reelId) refreshRowFacts(slot, record);
    return;
  }

  if (!record) {
    if (!slot.querySelector('.bouncer-ig-skel')) {
      slot.replaceChildren(buildSkeleton(thumbSize));
    }
    return;
  }

  prefetchThumb(record.thumbnailUrl);

  if (!isRecordComplete(record)) {
    if (!slot.querySelector('.bouncer-ig-skel')) {
      slot.replaceChildren(buildSkeleton(thumbSize));
    }
    return;
  }

  slot.replaceChildren(buildRow(record, thumbSize));
  slot.dataset.ffReel = record.reelId;
}

/** Bring a mounted row's late-arriving facts up to date, in place. Text only,
 *  into elements whose geometry was fixed when the row was built — the byline
 *  is one line ellipsised, the time line has a min-height whether or not it
 *  has anything to say — so nothing shifts under a finger. */
function refreshRowFacts(slot: HTMLElement, record: ReelRecord): void {
  const by = slot.querySelector('.bouncer-ig-by');
  if (by instanceof HTMLElement && record.creator) {
    const text = `by ${record.creator}`;
    if (by.textContent !== text) by.textContent = text;
  }
  const time = slot.querySelector('.bouncer-ig-time');
  if (time instanceof HTMLElement) {
    const text = meta(record);
    if (text && time.textContent !== text) time.textContent = text;
  }
}

/** How many reels forward `record` is from the one the glass went up over,
 *  measured NOW rather than when the row was built.
 *
 *  It used to be the row's index, captured at render time and carried in the
 *  click handler. That is only the right number while the feed hasn't moved,
 *  and the feed moves — the restock walk runs while the glass is up. A stale
 *  count swipes the right number of times to the wrong place. */
function stepsTo(record: ReelRecord): number {
  const all = host?.records() ?? [];
  const anchor = anchorId === null ? -1 : all.findIndex((r) => r.reelId === anchorId);
  const target = all.findIndex((r) => r.reelId === record.reelId);
  if (anchor >= 0 && target > anchor) return target - anchor;
  // The reel has been recycled out of the list, so its distance can't be
  // measured any more. Its slot is the last thing that knew.
  const slot = slotRecords.findIndex((r) => r?.reelId === record.reelId);
  return slot >= 0 ? slot + 1 : 1;
}

function buildRow(
  record: ReelRecord,
  thumbSize: { width: number; height: number },
): HTMLElement {
  const row = document.createElement('div');
  row.className = 'bouncer-ig-opt';
  row.setAttribute('role', 'button');
  row.tabIndex = 0;
  row.style.cssText = [
    // It arrives whole, into space that was already being held for it, so the
    // entrance is a fade in place rather than anything that moves. Set inside
    // the cssText block: assigning cssText replaces the whole style attribute,
    // so an animation set before it was erased on the next line.
    'animation: bouncer-ig-fadein 200ms ease both',
    'display: flex',
    'align-items: center',
    `gap: ${ROW_GAP_PX}px`,
    `padding: ${ROW_PAD_PX}px`,
    'border-radius: 16px',
    'cursor: pointer',
    'user-select: none',
    '-webkit-user-select: none',
  ].join(';');

  const thumb = document.createElement('img');
  thumb.src = record.thumbnailUrl;
  thumb.alt = '';
  thumb.style.cssText = [
    'flex: 0 0 auto',
    `width: ${thumbSize.width}px`,
    `height: ${thumbSize.height}px`,
    'object-fit: cover',
    'border-radius: 12px',
    'background: rgba(255,255,255,0.12)',
    // The thumbnail is the only opaque thing on the glass, so it keeps an edge
    // and a top highlight or it reads as a hole cut in the pane. No cast shadow:
    // a card floating above a pane that is itself floating reads as two panes.
    'border: 1px solid rgba(255,255,255,0.22)',
    'box-shadow: inset 0 1px 0 rgba(255,255,255,0.18)',
  ].join(';');

  const body = document.createElement('div');
  body.style.cssText = 'flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px';

  const title = document.createElement('div');
  title.textContent = record.description;
  title.style.cssText = [
    'font-size: 16px',
    'font-weight: 650',
    'line-height: 1.3',
    'color: #ffffff',
    // Nothing behind the text but the reel, so the text carries its own
    // contrast. Two shadows rather than one, the way subtitles are set over
    // video: a tight dark one that sharpens the letterforms against anything,
    // and a wide soft one that darkens the field around them without ever
    // becoming an edge you can see. No text shadow: at this size it haloes
    // rather than separates, and the weight is doing the work already. If a
    // bright reel ever takes the words away, the fix is more tint in the pane —
    // one surface getting darker, rather than every glyph carrying its own.
    'display: -webkit-box',
    // Three, not two: the taller thumbnail bought the row the vertical room, and
    // a description clipped mid-phrase is the one thing the glass cannot afford.
    '-webkit-line-clamp: 3',
    '-webkit-box-orient: vertical',
    'overflow: hidden',
  ].join(';');
  body.appendChild(title);

  const by = document.createElement('div');
  by.className = 'bouncer-ig-by';
  by.textContent = record.creator ? `by ${record.creator}` : 'by —';
  by.style.cssText = [
    'font-size: 13px',
    // Brighter and better shadowed than the muted grey a panel would allow. On
    // glass this thin the secondary line is the first thing a bright frame takes
    // away, and "by whom" is half of what a row is for.
    'color: rgba(255,255,255,0.9)',
    'white-space: nowrap',
    'overflow: hidden',
    'text-overflow: ellipsis',
  ].join(';');
  body.appendChild(by);

  // Below the byline, not above it. The row reads top-down as what it is, who
  // made it, then how much of your time it wants — and the last of those is the
  // one you weigh the other two against, so it sits closest to the decision.
  //
  // Always mounted, even with nothing to say yet. Signed in, a length usually
  // arrives long after its row does — Instagram does not tell the page how
  // long a reel is until you are nearly on it (see ./durations.ts) — and a row
  // that GREW when the number landed shifted the whole centred list under the
  // reader's thumb. An empty line of the same height holds the place instead,
  // so the number appears without anything moving.
  const time = document.createElement('div');
  time.className = 'bouncer-ig-time';
  time.textContent = meta(record);
  time.style.cssText = [
    'font-size: 13px',
    'font-weight: 600',
    'font-variant-numeric: tabular-nums',
    'color: rgba(255,255,255,0.96)',
    'min-height: 17px',
  ].join(';');
  body.appendChild(time);

  row.appendChild(thumb);
  row.appendChild(body);

  row.addEventListener('click', () => {
    // A drag on the glass ends in an up the browser also reports as a click on
    // whatever was underneath it.
    if (row.dataset.ffDragged || performance.now() < tapDeadUntil) return;
    pick(record, row.getBoundingClientRect());
  });
  return row;
}

/** The three on offer: the reels after the one you're watching, and only those.
 *
 *  There used to be a window that slid, and a history behind it to slide back
 *  through. Both are gone. The glass answers one question — what's next — and a
 *  second axis of movement on a surface whose other gesture is "put this away"
 *  was a way to lose the reel you were on rather than a way to find one you had
 *  passed. */
function windowRecords(): ReelRecord[] {
  const all = host?.records() ?? [];
  // Measured from the reel this went up over, not from whatever is at index 0
  // now. Those are the same thing right up until they aren't: the restock walk
  // moves the feed while the glass is up, and anything watching the feed to
  // decide which reel is "current" will follow it. What the glass offers must
  // not depend on that — it was opened over one reel and it stays that reel's
  // answer until it closes.
  const anchor = anchorId === null ? -1 : all.findIndex((r) => r.reelId === anchorId);
  const from = anchor >= 0 ? anchor : 0;
  return all.slice(from + 1, from + 1 + WINDOW_SIZE);
}

function renderGlass(): void {
  const glass = document.getElementById(GLASS_ID);
  const list = glass?.querySelector('[data-ff-rows]');
  if (!glass || !(list instanceof HTMLElement)) return;

  assignSlots();

  // One measurement for the whole render — every row is the same size, and the
  // viewport can't change between them.
  const thumbSize = rowThumbSize();
  const slotHeight = thumbSize.height + ROW_PAD_PX * 2;

  if (slotRecords.every((record) => record === null)) {
    if (!list.querySelector('[data-ff-empty]')) {
      const empty = document.createElement('div');
      empty.setAttribute('data-ff-empty', '');
      empty.textContent = 'Nothing else loaded yet.';
      empty.style.cssText = [
        'padding: 24px 10px',
        'font-size: 15px',
        'color: rgba(255,255,255,0.7)',
      ].join(';');
      list.replaceChildren(empty);
    }
    return;
  }

  // The frame goes up once and then stays exactly where it is. Three slots of
  // a fixed height, from the first render — so the list is already its final
  // size while the rows are still being described, and nothing that lands
  // later can push anything that landed earlier.
  let slots = Array.from(list.querySelectorAll<HTMLElement>('[data-ff-slot]'));
  if (slots.length !== WINDOW_SIZE) {
    slots = Array.from({ length: WINDOW_SIZE }, () => buildSlot(slotHeight));
    list.replaceChildren(...slots);
  } else {
    for (const slot of slots) slot.style.height = `${slotHeight}px`;
  }

  slots.forEach((slot, i) => fillSlot(slot, slotRecords[i] ?? null, thumbSize));
}

/** The pane itself.
 *
 *  One element, covering the reel completely: there is no card behind the rows
 *  and no second surface to dim what's underneath. The tint and the blur ARE the
 *  background, the reel keeps playing through them, and every row, label and
 *  button sits directly on that. */
function buildGlass(): HTMLElement {
  const glass = document.createElement('div');
  glass.id = GLASS_ID;
  glass.className = GLASS_CLASS;
  glass.style.cssText = [
    'position: fixed',
    'inset: 0',
    `z-index: ${GLASS_Z}`,
    // Glass, and as little of it as will still hold type.
    //
    // The tint is not the point and never was — the blur is. A heavy blur throws
    // away exactly the high-frequency detail that makes text unreadable while
    // keeping the colour and the light, which is why this can afford to be as
    // thin as it is: 14% in the middle, where the rows are, deepening at the
    // ends to carry the safe-area edges. Saturation and a touch of brightness go
    // back in on top, because a blur alone leaves the reel looking washed out
    // and grey, and glass does not do that to what is behind it.
    'background: linear-gradient(180deg, rgba(6,6,10,0.34) 0%, rgba(6,6,10,0.14) 26%,'
      + ' rgba(6,6,10,0.14) 74%, rgba(6,6,10,0.34) 100%)',
    'backdrop-filter: blur(30px) saturate(185%) brightness(1.06)',
    '-webkit-backdrop-filter: blur(30px) saturate(185%) brightness(1.06)',
    // The hairline where the sheet meets the screen. A pane of glass has an
    // edge that catches the light, and without one a translucent overlay reads
    // as a filter applied to the video rather than as a thing lying on top of it.
    //
    // Cool at the top, warm at the bottom: an edge that bends light splits it,
    // and the two ends of a real pane never catch the same colour. It is a
    // couple of percent of hue on a one-pixel line and you would never name it,
    // but it is most of why the edge looks like glass rather than like a border.
    'box-shadow: inset 0 1px 0 rgba(214,236,255,0.26),'
      + ' inset 0 -1px 0 rgba(255,214,236,0.14)',
    `font-family: ${PANEL_FONT}`,
    'display: flex',
    'flex-direction: column',
    `padding: max(16px, env(safe-area-inset-top)) ${GLASS_PAD_X_PX}px`
      + ' max(14px, env(safe-area-inset-bottom))',
    'box-sizing: border-box',
    'gap: 10px',
    'pointer-events: auto',
    // The glass is the navigation now; a flick past it would hand the feed back.
    'touch-action: none',
    'animation: bouncer-ig-glass-in 0.24s ease',
  ].join(';');

  // The sheen: a broad, soft highlight lying across the pane, drifting slowly
  // enough that you would have to look for it. This is the "liquid" half — real
  // glass is never uniform, and a perfectly even sheet of tint is the thing that
  // reads as a screenshot with an effect applied. It sits under the rows and
  // takes no pointer events, so it changes nothing but the light.
  //
  // Two layers in one element. The white one is the specular: where the light
  // source is. The coloured one underneath it is dispersion — glass bends the
  // short wavelengths further than the long ones, so a thick pane fringes what
  // passes through it, and the fringe is a spectrum rather than a colour. Every
  // stop here is under 10% alpha, which is the whole trick: past that it stops
  // being glass and becomes a filter someone chose. It shows most over a dark
  // reel, which is right — a bright one is already washing the colour out, the
  // way a real pane's fringing disappears against a window.
  //
  // Both drift together, so the spectrum sweeps rather than sitting still —
  // which is what a hand-held sheet of glass does, and why it reads as liquid.
  const sheen = document.createElement('div');
  sheen.className = 'bouncer-ig-sheen';
  sheen.style.cssText = [
    'position: absolute',
    'inset: -20%',
    'pointer-events: none',
    'background:'
      + ' linear-gradient(146deg,'
      + ' rgba(255,255,255,0.14) 0%, rgba(255,255,255,0.04) 18%,'
      + ' rgba(255,255,255,0.00) 38%, rgba(255,255,255,0.00) 62%,'
      + ' rgba(255,255,255,0.04) 84%, rgba(255,255,255,0.11) 100%),'
      + ' linear-gradient(118deg,'
      + ' rgba(255,120,190,0.095) 0%, rgba(255,176,120,0.07) 17%,'
      + ' rgba(255,238,140,0.05) 32%, rgba(130,240,205,0.065) 50%,'
      + ' rgba(120,190,255,0.08) 68%, rgba(178,140,255,0.095) 85%,'
      + ' rgba(255,130,205,0.08) 100%)',
  ].join(';');

  const list = document.createElement('div');
  list.setAttribute('data-ff-rows', '');
  // Centred in the whole pane — there is no label above it and no button below
  // it any more, so the rows have the screen to themselves. `min-height: 0` so
  // that if a row ever does overrun its budget the list shrinks rather than
  // running off the bottom.
  list.style.cssText = [
    'flex: 1 1 auto',
    'min-height: 0',
    'overflow: hidden',
    'display: flex',
    'flex-direction: column',
    'justify-content: center',
    `gap: ${LIST_GAP_PX}px`,
    'animation: bouncer-ig-rise 0.3s ease both',
  ].join(';');

  glass.appendChild(sheen);
  glass.appendChild(list);
  wireDrag(glass);
  return glass;
}

/** The swipe, on the glass: whichever way it goes, it puts the glass away and
 *  gives you back the reel that has been playing behind it.
 *
 *  One gesture, one meaning. It briefly slid the three options instead — up for
 *  further ahead, down for reels already passed — and that made the surface
 *  answer two questions with the same movement, on top of a reel you could see
 *  but no longer get back to. The swipe you used to open this is now the swipe
 *  that closes it, and the glass has nothing else to say.
 *
 *  It follows the finger the whole way, so leaving is something you do rather
 *  than something that happens at the end — and an uncommitted drag springs
 *  back, which is what tells you the gesture was understood and declined. */
function wireDrag(glass: HTMLElement): void {
  let startY = 0;
  let dragging = false;
  let moved = false;

  const settle = (): void => {
    glass.style.transition = `transform ${EXIT_MS}ms ${EASE}, opacity ${EXIT_MS}ms ease`;
    glass.style.transform = 'translateY(0)';
    glass.style.opacity = '1';
  };

  glass.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    dragging = true;
    moved = false;
    startY = e.clientY;
    // NO pointer capture, and its absence is load-bearing. Capturing to the
    // glass retargets every later pointer AND compatibility mouse event to the
    // glass — and a click's target is the common ancestor of its down and up,
    // so a tap on a ROW delivered its click to the glass instead. The row's
    // handler never ran and the glass's own read it as a tap on the pane:
    // every pick was silently a dismiss. Capture bought nothing anyway — the
    // glass is inset:0, so there is nowhere for a drag to leave to; moves on
    // the rows bubble to these listeners regardless.
  });

  glass.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const dy = e.clientY - startY;
    if (Math.abs(dy) > DRAG_SLOP_PX) moved = true;
    // Following at half speed, and thinning as it goes: the reel is already
    // coming back before you let go.
    glass.style.transition = 'none';
    glass.style.transform = `translateY(${dy * 0.5}px)`;
    glass.style.opacity = `${Math.max(0.3, 1 - Math.abs(dy) / 460)}`;
  });

  glass.addEventListener('pointerup', (e) => {
    if (!dragging) return;
    dragging = false;
    const dy = e.clientY - startY;
    if (moved) {
      tapDeadUntil = performance.now() + 300;
      // Mark the row underneath so its click handler doesn't also fire.
      const row = (e.target instanceof Element ? e.target : null)?.closest('.bouncer-ig-opt');
      if (row instanceof HTMLElement) {
        row.dataset.ffDragged = '1';
        setTimeout(() => delete row.dataset.ffDragged, 0);
      }
    }
    if (Math.abs(dy) >= SWIPE_COMMIT_PX) close(dy > 0 ? 'down' : 'up');
    else settle();
  });

  glass.addEventListener('pointercancel', () => {
    if (!dragging) return;
    dragging = false;
    settle();
  });

  // A tap on the pane itself — not on a row and not on a control — is the same
  // "no thanks" the drag is, and on a surface this large it is the easier one.
  //
  // Guarded by a deadline rather than by `moved`, which is only cleared on the
  // NEXT pointerdown: a drag that springs back leaves it raised, and the tap
  // after it would have been swallowed as the tail of a gesture that had
  // already ended.
  glass.addEventListener('click', (e) => {
    if (performance.now() < tapDeadUntil) return;
    const target = e.target instanceof Element ? e.target : null;
    if (target?.closest('.bouncer-ig-opt')) return;
    close();
  });
}

// ==================== Open / close / pick ====================

function isOpen(): boolean {
  return document.getElementById(GLASS_ID) !== null;
}

function open(): void {
  if (isOpen() || !host) return;
  anchorId = host.records()[0]?.reelId ?? null;
  // A fresh set of slots per showing. They are the glass's memory of what it
  // offered, and last showing's answer is not this one's.
  resetSlots();

  // Re-resolved here as well as on refresh: the lock is what holds the feed
  // still for as long as this is up, and the one moment it must not be stale is
  // the moment it goes up. Repinned for the same reason — from here the hold is
  // unconditional, so "here" had better be where the feed actually is rather
  // than wherever it was the last time a finger touched the screen.
  lockScroll();
  repin();
  (document.body ?? document.documentElement).appendChild(buildGlass());
  host.setChromeHidden(true);
  renderGlass();
  // Only when the feed is running out, and behind a still of the reel you're on
  // — see "Keeping the feed stocked". Rows appear as reels are discovered: the
  // host's scan calls refresh(), which re-renders while we're open.
  if (needsStock()) void restock();
}

/** Send the glass away and let it finish leaving on its own. It gives up its id
 *  first, so isOpen() — and a swipe arriving in the same breath — sees it gone
 *  the moment close() returns rather than when the animation ends. */
function dismiss(el: HTMLElement | null, transform: string): void {
  if (!el) return;
  el.removeAttribute('id');
  el.style.transition = `transform ${EXIT_MS}ms ${EASE}, opacity ${EXIT_MS}ms ease`;
  el.style.animation = 'none';
  el.style.transform = transform;
  el.style.opacity = '0';
  setTimeout(() => el.remove(), EXIT_MS);
}

/** `how` carries a drag's direction through, so the glass leaves the way it was
 *  being pushed; a tap just lets it thin out in place. */
function close(how: 'fade' | 'down' | 'up' = 'fade'): void {
  if (!isOpen()) return;
  endRestock(true);
  // A restock superseded mid-walk skips its own cleanup (its finally is
  // generation-guarded so it can't clobber a pick that took over), and a
  // dismissal is the one superseder that doesn't set `driving` itself — left
  // raised, programmatic() stays true forever and the pin silently stops
  // holding. Safe here: close() no-ops when the glass is already gone, so it
  // can never land in the middle of a pick's journey.
  driving = false;
  const away = how === 'down' ? 'translateY(100%)' : how === 'up' ? 'translateY(-100%)' : 'none';
  dismiss(document.getElementById(GLASS_ID), away);
  host?.setChromeHidden(false);
  reopenAfter = performance.now() + REOPEN_BLOCK_MS;
  wheelAccum = 0;
  wheelBackAccum = 0;
}

function pick(record: ReelRecord, from: DOMRect): void {
  const steps = stepsTo(record);
  // What was chosen, and what it was chosen FROM. The anchor is the half that
  // is otherwise invisible: the glass offers the reels after the one it went
  // up over, so an anchor that is stale or unknown produces a perfectly
  // executed journey to a reel the user did not mean — which from the outside
  // is indistinguishable from the journey going wrong.
  console.warn(`[Bouncer IG] pick: chose ${record.reelId}, row ${steps} of `
    + `${windowRecords().length}, anchor=${anchorId ?? 'NONE'}, `
    + `reachable=${record.card.isConnected}, restocking=${restockHome !== null}, `
    // Whether this reel can be jumped to by address, or has to be swiped to.
    // Measured on device, every pick fell back to swiping — the hook had never
    // seen the payload for the reels actually on screen, so there was no code
    // to jump with. Named here so that is a fact in the log rather than an
    // absence of one.
    + `code=${record.code ?? 'NONE'}`);

  endRestock(false);
  // Straight off the screen rather than animated away: the cover coming up out
  // of the row is the transition, and glass fading through it would be a second.
  document.getElementById(GLASS_ID)?.remove();
  host?.setChromeHidden(false);
  reopenAfter = performance.now() + REOPEN_BLOCK_MS;

  // Disarm the hold, and this is what makes a pick STICK.
  //
  // The tap that chose this row is a gesture like any other, so its touchend
  // armed the pin for GESTURE_TAIL_MS — and the pin's whole job is to undo
  // movement nobody asked for. For a second and a half after the tap, every
  // scroll the arrival causes that lands outside a `programmatic()` claim is
  // faithfully reverted, which from the outside is the reel you picked
  // appearing and then sliding back to the one you were on. The signed-in
  // pager makes this near-certain rather than occasional: it animates its snap
  // over several hundred milliseconds, so the settling arrives late by design.
  //
  // A pick is the one movement on this surface that is unambiguously wanted,
  // so nothing about it needs holding down. arriveAt re-pins at the end, which
  // is what re-arms the hold for the next real gesture.
  touching = false;
  gestureUntil = 0;
  glassDragStartY = null;
  swallowedGesture = false;

  void arriveAt(record, from);
}

// ==================== Public API ====================

export function installSuggestions(next: SuggestHost): Suggestions {
  host = next;
  installed = true;
  injectStyles();
  lockScroll();
  // On `window`, not `document`, and in the capture phase: this is a race with
  // Instagram's own listeners and window-capture is the first place in the
  // dispatch order anything can be told about a touch. A listener on the
  // document loses that race to any listener the page put on the window.
  //
  // Not passive, because these both preventDefault and stopPropagation, and a
  // passive listener is a promise not to do the first of those.
  window.addEventListener('touchstart', onTouchStart, { capture: true, passive: true });
  window.addEventListener('touchmove', onTouchMove, { capture: true, passive: false });
  window.addEventListener('touchend', onTouchEnd, { capture: true, passive: false });
  window.addEventListener('touchcancel', onTouchEnd, { capture: true, passive: false });
  window.addEventListener('pointerdown', onPointerDown, { capture: true, passive: true });
  window.addEventListener('pointermove', onPointerMove, { capture: true, passive: false });
  window.addEventListener('pointerup', onPointerUp, { capture: true, passive: true });
  window.addEventListener('pointercancel', onPointerUp, { capture: true, passive: true });
  window.addEventListener('wheel', onWheel, { capture: true, passive: false });
  // Capture, because a scroll event from an element does not bubble.
  document.addEventListener('scroll', onFeedScroll, { capture: true, passive: true });

  return {
    refresh(): void {
      if (!installed) return;
      // Re-resolved every time: a route change builds a new scroll container,
      // and an unlocked one hands the swipe straight back.
      lockScroll();
      if (isOpen()) renderGlass();
    },
    onActiveReelChanged(): void {
      if (isOpen()) renderGlass();
    },
    close,
    isOpen,
    teardown(): void {
      installed = false;
      host?.setChromeHidden(false);
      host = null;
      anchorId = null;
      resetSlots();
      thumbsRequested.clear();
      swipeStartY = null;
      gestureStartY = null;
      glassDragStartY = null;
      pointerStartY = null;
      overlayGesture = false;
      tapDeadUntil = 0;
      swallowedGesture = false;
      wheelAccum = 0;
      wheelBackAccum = 0;
      reopenAfter = 0;
      endRestock(false);
      // By class, so a pane part-way through its exit animation — which has
      // already given up its id — goes too.
      for (const el of Array.from(
        document.querySelectorAll(`.${GLASS_CLASS}`),
      )) el.remove();
      window.removeEventListener('touchstart', onTouchStart, true);
      window.removeEventListener('touchmove', onTouchMove, true);
      window.removeEventListener('touchend', onTouchEnd, true);
      window.removeEventListener('touchcancel', onTouchEnd, true);
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('pointermove', onPointerMove, true);
      window.removeEventListener('pointerup', onPointerUp, true);
      window.removeEventListener('pointercancel', onPointerUp, true);
      window.removeEventListener('wheel', onWheel, true);
      document.removeEventListener('scroll', onFeedScroll, true);
      touching = false;
      gestureUntil = 0;
      programmaticUntil = 0;
      driving = false;
      unlockScroll();
    },
  };
}
