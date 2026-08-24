// Making a reel fit the screen it is on.
//
// Instagram's mobile web sizes a reel to `100vh`, and on iOS `100vh` is a
// promise about the LARGEST the viewport could be — the height it reaches once
// the browser chrome has scrolled away. The visible area is smaller than that
// almost all the time, so the foot of every reel hangs below the fold: the audio
// pill, and whatever else Instagram pins to the bottom of the card.
//
// On the web that is a shrug — you nudge the page and it comes up. Here it is a
// bug we introduced, because scrolling is exactly what the chooser takes away
// (see ./suggest.ts). There is no nudge available, so the bottom of the reel is
// simply gone.
//
// The fix is to stop the reel being taller than the screen. Every element in the
// card that stands taller than the visible viewport is pinned to it — both
// bounds, because `min-height: 100vh` is as common as `height: 100vh` and beats
// a max-height on its own. Nothing is ever made bigger: an element is only
// touched when it already overflows, and pinning it can only shrink it.
//
// Measured rather than matched. Instagram's class names are hashed and its
// markup changes; "is this box taller than the screen" is a question about the
// rendered page, and it stays true however the page is built.

import { creatorLinkFromCard } from './library';

/** Marks what we've resized, so it can all be handed back on teardown. */
const MARKER = 'data-bouncer-fit';

/** Below this, a measurement is a page mid-layout rather than a screen. */
const MIN_SENSIBLE_HEIGHT_PX = 200;

/** Ignore overflow smaller than this. A pixel or two is rounding, and clamping
 *  it would churn styles on every scan for no visible gain. */
const SLOP_PX = 2;

/** The most a plain clip may cost the video when nothing nameable is buried —
 *  about two lines of caption, the classic sliced-caption case. */
const CAPTION_SLICE_PX = 72;

/** The most the video may give up to bring a buried byline or caption back on
 *  screen — enough for an author row, a couple of caption lines and the audio
 *  pill, and no more.
 *
 *  Doubly a boundary: it caps what a rescue may cost, and it defines which
 *  buried pieces are rescuable at all. A piece within this distance of the
 *  fold is a sliced row the video can lift back; a piece further down is a
 *  different layer of the page (see makeRoomForChrome for the one that burned
 *  us), and shrinking the video toward it only deforms the reel. */
const MAX_VIDEO_SHRINK_PX = 180;

/** Skip slivers: a tall, narrow element is a scrollbar or a rail, not the reel. */
const MIN_WIDTH_PX = 80;

/** The tallest an element can be and still be a box sized to the screen.
 *
 *  There are two kinds of too-tall on this page and they want opposite
 *  treatment. A box sized to the SCREEN — `100vh`, or `100dvh`, or whatever
 *  Instagram computed once and cached — overflows by the difference between
 *  the layout viewport and the visible one, and wants clamping. A scroll
 *  container is taller than the screen because its CONTENTS are, by hundreds or
 *  thousands of pixels, and forcing a height onto one is how a reel ends up
 *  shoved sideways with a gutter down one edge.
 *
 *  This used to demand a height within a few pixels of `innerHeight` exactly,
 *  and that was too literal: measured on device, the reel card was 660 against
 *  a 705 layout viewport and 621 visible. Forty-five pixels short of "a
 *  viewport", so nothing matched — while thirty-nine pixels of it, including
 *  everything Instagram pins to its bottom edge, sat below the fold. Sized to
 *  the screen does not mean equal to it; the page has its own chrome to
 *  subtract first.
 *
 *  A ceiling rather than a window, then: anything from "taller than you can
 *  see" up to a little over one layout viewport. That still excludes a scroll
 *  container by a wide margin, and stops assuming Instagram's arithmetic
 *  matches ours. */
const MAX_CLAMP_FRACTION = 1.05;

// A probe for env(safe-area-inset-bottom), which is not otherwise readable from
// script. Kept between measurements — it is one detached-looking div with no
// size, and creating it per call would be a layout flush per call.
let insetProbe: HTMLElement | null = null;

/** The home indicator's strip at the foot of the screen. Content under it is
 *  technically visible and practically isn't. */
function safeInsetBottom(): number {
  if (!insetProbe?.isConnected) {
    insetProbe = document.createElement('div');
    insetProbe.setAttribute(MARKER, 'probe');
    insetProbe.style.cssText = [
      'position: fixed',
      'left: 0',
      'bottom: 0',
      'width: 0',
      'height: env(safe-area-inset-bottom)',
      'pointer-events: none',
      'visibility: hidden',
    ].join(';');
    (document.body ?? document.documentElement).appendChild(insetProbe);
  }
  return Math.round(insetProbe.getBoundingClientRect().height);
}

/** What a bar pinned to the bottom of the screen may measure and still be a
 *  bar. Instagram's Home/Reels navigation is ~45px tall and full width; the
 *  reel card behind it is neither. */
const MAX_BOTTOM_BAR_FRACTION = 0.25;
const MIN_BOTTOM_BAR_HEIGHT_PX = 20;
const MIN_BOTTOM_BAR_WIDTH_FRACTION = 0.6;

/** Ours, and not an obstruction — the glass and the popup come and go. */
const OURS = '[id^="bouncer-"], [class^="bouncer-"]';

/** Where the pinned chrome at the foot of the screen begins, in viewport
 *  coordinates — `view` itself when there is none.
 *
 *  This used to be a constant: 84px held back at the foot of every reel, on
 *  the theory that native chrome JavaScript cannot see was covering it. But the
 *  thing actually covering the foot of a reel is Instagram's own bottom
 *  navigation, which JavaScript can see perfectly well — and Instagram already
 *  sizes its cards to end above it (measured: a 619px card over a nav bar at
 *  620, in a 664 viewport). So on any screen where the page's own arithmetic
 *  was right, the constant took 84px the layout had already accounted for, and
 *  what it bought was a white band between the reel and the nav bar with the
 *  caption sliced mid-letter above it.
 *
 *  Measured with `elementsFromPoint` at the bottom-centre of the visible area:
 *  whatever is stacked there IS the bottom of the screen, so the walk is a few
 *  elements long instead of a page-wide sweep. Anything pinned, wide and short
 *  in that stack is a bar, and the card must stop at the highest one. Chrome
 *  the viewport already excludes — Safari's toolbar — never appears here,
 *  because `view` is the visual viewport and ends above it. */
function bottomChromeTop(view: number): number {
  const probe = document.elementsFromPoint?.(window.innerWidth / 2, view - 2) ?? [];
  let top = view;
  for (const el of probe) {
    if (!(el instanceof HTMLElement) || el.matches(OURS)) continue;
    const position = getComputedStyle(el).position;
    if (position !== 'fixed' && position !== 'sticky') continue;
    const rect = el.getBoundingClientRect();
    if (rect.height < MIN_BOTTOM_BAR_HEIGHT_PX) continue;
    if (rect.height > view * MAX_BOTTOM_BAR_FRACTION) continue;
    if (rect.width < window.innerWidth * MIN_BOTTOM_BAR_WIDTH_FRACTION) continue;
    top = Math.min(top, Math.max(0, Math.round(rect.top)));
  }
  return top;
}

/** How much room a reel actually has.
 *
 *  `visualViewport` rather than `innerHeight`: the first is what you can see,
 *  the second is what CSS thinks you can see, and the gap between them is the
 *  whole subject of this file. Bounded twice more: above the home indicator's
 *  strip, and above whatever bar the page has pinned across the bottom of the
 *  screen — see bottomChromeTop. */
export function visibleHeight(): number {
  const viewport = window.visualViewport;
  const height = Math.round(viewport?.height ?? window.innerHeight);
  return Math.min(height - safeInsetBottom(), bottomChromeTop(height));
}

/** Pin one card, and everything in it, to the visible height.
 *
 *  Returns how many elements had to be brought in — zero on a reel that already
 *  fitted, which is the common case once this has run. */
export function fitReel(card: HTMLElement, height: number = visibleHeight()): number {
  if (height < MIN_SENSIBLE_HEIGHT_PX) return 0;

  // Let go of everything we clamped last time, BEFORE measuring anything.
  //
  // This is the whole reason a reel could end up permanently short. The clamp
  // is decided by measurement, and a clamped element measures at exactly the
  // height we gave it — so on the next pass it looks like it fits, and keeps
  // whatever it was given. That is fine while the viewport only ever shrinks,
  // and wrong the moment it grows again, which on iOS it does constantly as
  // Safari's chrome slides in and out. Each shrink ratcheted the reel down; no
  // growth ever let it back up. A reel measured once against a keyboard-sized
  // viewport stayed that size for the rest of the session, with its bottom —
  // and any UI pinned to it — clipped away.
  //
  // Releasing first costs one reflow per re-fit, on a path that only runs on
  // discovery and on viewport changes. The alternative is a one-way ratchet.
  release(card);
  for (const el of Array.from(card.querySelectorAll<HTMLElement>(`[${MARKER}]`))) release(el);

  // What `100vh` currently resolves to. The layout viewport, not the visible
  // one — that gap is the bug, and this is the number the offending elements
  // were sized against.
  const layout = window.innerHeight;

  let clamped = 0;
  const consider = (el: HTMLElement): void => {
    const rect = el.getBoundingClientRect();
    if (rect.height <= height + SLOP_PX || rect.width < MIN_WIDTH_PX) return;
    // Sized to the screen, not merely taller than it. See MAX_CLAMP_FRACTION.
    if (rect.height > layout * MAX_CLAMP_FRACTION) return;
    // Both bounds. A min-height beats a max-height when they disagree, so
    // setting only the max leaves `min-height: 100vh` exactly as it was.
    el.style.setProperty('max-height', `${height}px`, 'important');
    el.style.setProperty('min-height', `${height}px`, 'important');
    el.setAttribute(MARKER, '');
    clamped++;
  };

  consider(card);
  for (const el of Array.from(card.querySelectorAll<HTMLElement>('*'))) consider(el);
  clamped += makeRoomForChrome(card);
  clamped += clipOverflow(card);
  return clamped;
}

/** Stop a card's below-fold content painting over its neighbours.
 *
 *  A card whose content wants more height than it has, with `overflow:
 *  visible`, does not clip that content — it paints it straight down over
 *  whatever comes next in the scroller, which on this feed is the next reel.
 *  Everything below the fold is by definition not part of the reel being
 *  watched, so clipping it costs nothing visible and buys the next slide its
 *  own pixels.
 *
 *  `clip` rather than `hidden`: hidden turns the card into a scroll container,
 *  and a stray scrollIntoView or drag could then shift the reel inside its own
 *  box. clip clips and nothing else. */
function clipOverflow(card: HTMLElement): number {
  if (card.scrollHeight - card.clientHeight <= SLOP_PX) return 0;
  const overflowY = getComputedStyle(card).overflowY;
  if (overflowY && overflowY !== 'visible') return 0;   // already contained
  card.style.setProperty('overflow-y', 'clip', 'important');
  card.setAttribute(MARKER, '');
  return 1;
}

/** The caption block, as an element: the longest [dir="auto"] text in the card
 *  that isn't itself a link. The same heuristic index.ts scrapes caption TEXT
 *  with, asked here for the box the text sits in. */
function captionBlock(card: HTMLElement): HTMLElement | null {
  let best: HTMLElement | null = null;
  let bestLength = 0;
  for (const el of Array.from(card.querySelectorAll<HTMLElement>('[dir="auto"]'))) {
    if (el.closest('a')) continue;
    const length = (el.textContent ?? '').trim().length;
    if (length > bestLength) {
      bestLength = length;
      best = el;
    }
  }
  return best;
}

/** The parts of a reel a person actually reads — the byline, the caption, the
 *  audio pill — measured where they currently sit. */
function chromePieces(card: HTMLElement): { name: string; rect: DOMRect }[] {
  const pieces: { name: string; rect: DOMRect }[] = [];
  const byline = creatorLinkFromCard(card);
  if (byline) pieces.push({ name: 'byline', rect: byline.getBoundingClientRect() });
  const caption = captionBlock(card);
  if (caption) pieces.push({ name: 'caption', rect: caption.getBoundingClientRect() });
  const pill = card.querySelector('a[href*="/reels/audio/"]');
  if (pill) pieces.push({ name: 'pill', rect: pill.getBoundingClientRect() });
  return pieces.filter((p) => p.rect.height > 0);
}

/** Give a byline or caption sliced AT the fold back its pixels — and only one
 *  sliced at the fold.
 *
 *  What a reel's card holds is not what a person reads. Instagram's mobile
 *  reels pin the byline, caption and action rail the user actually sees in a
 *  position:fixed overlay on the viewport, outside every card; the card often
 *  carries its own copy of those pieces, sometimes laid out a full viewport
 *  BELOW the video. Card-level measurements see the copy, not the overlay —
 *  which is how this function once shrank a playing video by 180px to "rescue"
 *  a byline duplicate 400px below the fold while the real byline sat on
 *  screen untouched.
 *
 *  So the rule is anchored to the fold: a piece within MAX_VIDEO_SHRINK_PX of
 *  it is a row the fold sliced, and the video gives up exactly enough to lift
 *  it clear — the video is the one element that can afford pixels, being
 *  already cropped by object-fit. A piece further down is another layer and is
 *  left where it is. When nothing nameable is near the fold, the small-clip
 *  rule still applies: a clip under a caption's height gets given back (the
 *  sliced-last-line case), and anything bigger stays where Instagram put it.
 */
function makeRoomForChrome(card: HTMLElement): number {
  const clipped = card.scrollHeight - card.clientHeight;
  if (clipped <= SLOP_PX) return 0;

  const cardRect = card.getBoundingClientRect();
  const fold = cardRect.top + cardRect.height;
  const buried = chromePieces(card).filter((p) => p.rect.bottom > fold + SLOP_PX);

  // Only pieces the video could actually lift back to the fold. A piece
  // hundreds of pixels down is not a sliced row at the fold — it is another
  // LAYER, and rescuing it is how the video got squeezed while the caption
  // was on screen the whole time. Measured on device: the card carries a
  // duplicate of the byline and caption in flow below the video (byline at
  // 1062 against a fold of 660), while the copy the user actually reads is a
  // position:fixed overlay pinned to the viewport, which no card-level
  // arithmetic touches. Shrinking the video 180px "for" that duplicate moved
  // the playing reel up its slide and cured nothing — the user's own theory,
  // and the report's numbers, in exact agreement.
  const reachable = buried.filter((p) => p.rect.bottom - fold <= MAX_VIDEO_SHRINK_PX);

  let give: number;
  if (reachable.length > 0) {
    // Enough to lift the deepest reachable piece just above the fold — the
    // stack above it rises with it, since this layout is in normal flow.
    give = Math.max(...reachable.map((p) => p.rect.bottom)) - fold;
  } else if (buried.length === 0 && clipped <= CAPTION_SLICE_PX) {
    give = clipped;
  } else {
    // Nothing at the fold worth paying for: either the clip is the page's own
    // below-fold stack, or the buried pieces are the other layer's duplicates.
    return 0;
  }

  // The biggest video in the card: the reel itself, not a preview thumbnail of
  // the next one.
  let video: HTMLVideoElement | null = null;
  let tallest = 0;
  for (const candidate of Array.from(card.querySelectorAll('video'))) {
    const box = candidate.getBoundingClientRect().height;
    if (box > tallest) {
      tallest = box;
      video = candidate;
    }
  }
  if (!video || tallest <= 0) return 0;

  const target = tallest - give;
  if (target >= tallest - SLOP_PX || target <= 0) return 0;

  video.style.setProperty('max-height', `${Math.round(target)}px`, 'important');
  video.style.setProperty('min-height', '0', 'important');
  video.setAttribute(MARKER, '');
  return 1;
}

/** Hand one element back what it had. The probe is not ours to release — it is
 *  a measuring instrument, and removing it here would cost a rebuild per call. */
function release(el: HTMLElement): void {
  if (!el.hasAttribute(MARKER) || el.getAttribute(MARKER) === 'probe') return;
  el.style.removeProperty('max-height');
  el.style.removeProperty('min-height');
  el.style.removeProperty('overflow-y');
  el.style.removeProperty('transform');
  el.removeAttribute(MARKER);
}

// ==================== The viewport-pinned UI layer ====================
//
// The byline, caption and audio pill a person actually reads are NOT the
// card's. Instagram pins the active reel's UI in a position:fixed layer on the
// viewport, outside every card — which is why nothing done to cards ever moved
// the caption the user was looking at. On a healthy page that layer is sized
// to the VISIBLE area (measured live: 660 in a 705 viewport, ending exactly at
// the nav bar) and its bottom-anchored rows sit clear of the nav. On the iOS
// app it is sized to the full layout viewport instead, so the same
// bottom-anchored rows land 45px lower: the author row still shows, and the
// caption line under it is sliced through its letters just above the nav bar —
// the "bottom of the reel is cut off" every report was pointing at.

/** Shorter than this and a pinned element is a bar or a toast, not the reel's
 *  UI layer. */
const MIN_OVERLAY_FRACTION = 0.5;

/** The pinned layers stacked over the reel, found by hit-testing the middle of
 *  the screen — the layer covers the reel, so the reel's own pixels are where
 *  to ask. A page-wide sweep would find the same elements at many times the
 *  cost, and this runs on every scan. */
function overlayCandidates(view: number, cards: readonly HTMLElement[]): HTMLElement[] {
  const x = window.innerWidth / 2;
  const found = new Set<HTMLElement>();
  for (const y of [view * 0.5, Math.max(0, view - 40)]) {
    for (const el of document.elementsFromPoint?.(x, y) ?? []) {
      if (el instanceof HTMLElement && !el.matches(OURS)) found.add(el);
    }
  }
  // Hit-testing cannot see a layer that turns pointer-events off — and a UI
  // layer floating over a video is exactly the kind that does, so taps fall
  // through to the reel. The byline is the one thing the layer reliably
  // carries, so also walk up from every byline-shaped link (a profile link
  // wrapping an avatar <img>) to the layer holding it: the first ancestor
  // that is screen-sized or pinned, stopping cold at anything holding the
  // reel's <video> — that subtree's geometry is the reel's, not the layer's.
  //
  // Two byline copies exist and only one leads anywhere. The copy inside a
  // reel CARD is the below-fold duplicate (see makeRoomForChrome), and
  // walking up from it would offer up the card's own caption stack; the
  // caller knows the cards, so those links are skipped outright.
  //
  // "Holds the reel's video" is asked with a SET, not a query. This used to be
  // `node.querySelector('video')` at every level of every walk, which near the
  // root is a scan of the entire page — and the signed-in feed is dense with
  // avatar-wrapping links (every comment row is one), so the sweep multiplied
  // out to page-sized scans dozens of times per tick and made the chooser
  // unusable. The ancestors of the few mounted videos are computed once
  // instead, and a chain any earlier link already walked is not walked again.
  const videoAncestors = new Set<HTMLElement>();
  for (const video of Array.from(document.querySelectorAll('video'))) {
    let node: HTMLElement | null = video.parentElement;
    while (node) {
      videoAncestors.add(node);
      node = node.parentElement;
    }
  }
  const walked = new Set<HTMLElement>();
  for (const a of Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]'))) {
    if (!a.querySelector('img')) continue;
    if (cards.some((card) => card.contains(a))) continue;
    let node: HTMLElement | null = a;
    for (let i = 0; i < 25 && node && node !== document.body; i++) {
      if (videoAncestors.has(node) || walked.has(node)) break;
      walked.add(node);
      const rect = node.getBoundingClientRect();
      const screenSized = rect.height >= view * MIN_OVERLAY_FRACTION
        && rect.width >= window.innerWidth * 0.6;
      if (screenSized || getComputedStyle(node).position === 'fixed') {
        if (!node.matches(OURS)) found.add(node);
        break;
      }
      node = node.parentElement;
    }
  }
  return [...found];
}

/** Bring the pinned UI layer's bottom back inside the visible area.
 *
 *  One correction, chosen for being position-agnostic: translate the whole
 *  layer up by its overflow. The first version clamped an oversized layer's
 *  HEIGHT instead, and the on-device screenshot showed why that isn't a fix —
 *  a shorter box only lifts children anchored to its bottom edge, and this
 *  layer positions its rows with top offsets, so the box shrank and every row
 *  stayed exactly where it was, caption still under the nav bar. Moving the
 *  rendered layer moves its rows no matter how they are positioned. The 45px
 *  that scrolls off the layer's top is the strip Instagram's own top bar
 *  occupied, which ./topbar.ts already blanks on the reels routes.
 *
 *  What it will not touch: anything holding a <video> (the feed scroller is
 *  pinned and screen-sized too, and moving it moves the reel), dialogs and
 *  scrollable sheets (the comments drawer is pinned, tall and full of text),
 *  anything not sized-to-screen, and anything of ours. */
/** The farthest a layer may be lifted. The miss being corrected is chrome
 *  sitting one nav-bar's height too low; a layer overflowing by hundreds of
 *  pixels is not slightly-low chrome, it is a different element — a below-fold
 *  stack, a half-scrolled slide — and lifting it would drag real content over
 *  the reel. */
const MAX_CHROME_LIFT_PX = 120;

function fitViewportChrome(view: number, cards: readonly HTMLElement[]): number {
  let corrected = 0;
  for (const el of overlayCandidates(view, cards)) {
    // Release first so a layer corrected last pass is re-measured fresh — the
    // same anti-ratchet rule the cards follow.
    release(el);
    const position = getComputedStyle(el).position;
    if (position !== 'fixed' && position !== 'absolute') continue;
    const rect = el.getBoundingClientRect();
    // An overlay hangs from the top of the screen; something starting lower is
    // a slide or a sheet mid-arrival, and not this correction's business.
    if (rect.top > view * 0.1) continue;
    if (rect.width < window.innerWidth * 0.6) continue;
    if (rect.height < view * MIN_OVERLAY_FRACTION) continue;
    if (rect.height > window.innerHeight * MAX_CLAMP_FRACTION) continue;
    const overflow = Math.round(rect.bottom - view);
    if (overflow <= SLOP_PX) continue;                    // already fits
    if (overflow > MAX_CHROME_LIFT_PX) continue;
    if (el.querySelector('video')) continue;
    if (el.getAttribute('role') === 'dialog' || el.querySelector('[role="dialog"]')) continue;
    if (el.scrollHeight > el.clientHeight + 8) continue;  // a sheet, not chrome

    el.style.setProperty('transform', `translateY(-${overflow}px)`, 'important');
    el.setAttribute(MARKER, '');
    corrected++;
  }
  return corrected;
}

/** The same for every card we know about, plus the pinned UI layer over them.
 *  One measurement for all of it. */
export function fitReels(cards: Iterable<HTMLElement>): number {
  const height = visibleHeight();
  const live = [...cards].filter((card) => card.isConnected);
  let clamped = 0;
  for (const card of live) {
    clamped += fitReel(card, height);
  }
  clamped += fitViewportChrome(height, live);
  return clamped;
}

/** Give every resized element back exactly what it had. */
export function unfitAll(): void {
  for (const el of Array.from(document.querySelectorAll<HTMLElement>(`[${MARKER}]`))) {
    if (el.getAttribute(MARKER) === 'probe') {
      el.remove();
      continue;
    }
    el.style.removeProperty('max-height');
    el.style.removeProperty('min-height');
    el.style.removeProperty('overflow-y');
    el.style.removeProperty('transform');
    el.removeAttribute(MARKER);
  }
  insetProbe = null;
}

/** Re-fit when the room changes: a rotation, the keyboard, iOS's own chrome
 *  sliding in and out. `onChange` is the caller's cue to re-measure anything
 *  positioned against the reel. */
export function installFitWatcher(onChange: () => void): () => void {
  const run = (): void => { onChange(); };
  window.addEventListener('resize', run);
  window.addEventListener('orientationchange', run);
  window.visualViewport?.addEventListener('resize', run);
  return () => {
    window.removeEventListener('resize', run);
    window.removeEventListener('orientationchange', run);
    window.visualViewport?.removeEventListener('resize', run);
  };
}

/** One line for the on-device report: whether the reel fits, and if the thing
 *  at the bottom of it — the audio pill — is somewhere you could actually see. */
export function fitReport(card: HTMLElement | null): string {
  const height = visibleHeight();
  const layout = window.innerHeight;
  if (!card) return `no reel to measure; visible ${height} of ${layout}`;
  const rect = card.getBoundingClientRect();
  const pill = card.querySelector('a[href*="/reels/audio/"]');
  const pillBottom = pill ? Math.round(pill.getBoundingClientRect().bottom) : null;
  // scrollHeight vs clientHeight: what the content wants versus what it got.
  // A card can measure a perfect fit while slicing its last line in half, and
  // this is the only number that says so.
  const clipped = card.scrollHeight - card.clientHeight;
  const video = card.querySelector('video');
  const videoHeight = video ? Math.round(video.getBoundingClientRect().height) : null;
  // Where the readable pieces sit relative to the card's visible bottom — the
  // question makeRoomForChrome decides by, answered in the same terms it asks.
  const fold = Math.round(rect.top + rect.height);
  const pieces = chromePieces(card)
    .map((p) => {
      const depth = p.rect.bottom - fold;
      const state = depth <= SLOP_PX ? ''
        : depth <= MAX_VIDEO_SHRINK_PX ? ' BURIED'
        : ' BURIED beyond reach — another layer, left alone';
      return `${p.name} ${Math.round(p.rect.top)}..${Math.round(p.rect.bottom)}${state}`;
    })
    .join(', ');
  // The pinned UI layer, in the same terms fitViewportChrome judges it — with
  // the guard that skipped an overflowing layer named, so "still wrong" comes
  // back as a reason rather than a mystery.
  const overlays = overlayCandidates(height, card ? [card] : [])
    .map((el) => ({ el, r: el.getBoundingClientRect(), position: getComputedStyle(el).position }))
    .filter(({ r }) => r.width >= window.innerWidth * 0.6 && r.height >= height * MIN_OVERLAY_FRACTION)
    .slice(0, 4)
    .map(({ el, r, position }) => {
      const skip = [
        position !== 'fixed' && position !== 'absolute' ? `pos=${position}` : '',
        el.querySelector('video') ? 'video' : '',
        el.getAttribute('role') === 'dialog' || el.querySelector('[role="dialog"]') ? 'dialog' : '',
        el.scrollHeight > el.clientHeight + 8 ? 'scrollable' : '',
        r.top > height * 0.1 ? 'starts low' : '',
        r.height > window.innerHeight * MAX_CLAMP_FRACTION ? 'oversized' : '',
        r.bottom - height > MAX_CHROME_LIFT_PX ? 'too deep to lift' : '',
      ].filter(Boolean);
      const state = el.hasAttribute(MARKER) ? 'corrected'
        : r.bottom <= height + SLOP_PX ? 'fits'
        : skip.length ? `OVERFLOWS, skipped (${skip.join(', ')})`
        : 'OVERFLOWS uncorrected';
      return `${Math.round(r.height)}@${Math.round(r.top)}..${Math.round(r.bottom)} ${state}`;
    });
  return `visible ${height} of ${layout} (inset ${safeInsetBottom()});`
    + ` card ${Math.round(rect.height)} tall, bottom at ${Math.round(rect.bottom)};`
    + ` content wants ${card.scrollHeight} (${clipped > 0 ? `${clipped} CLIPPED` : 'fits'});`
    + ` video ${videoHeight ?? 'none'};`
    + ` fold ${fold}, ${pieces || 'no byline/caption/pill found'};`
    + ` UI layer ${overlays.length ? overlays.join(' | ') : 'not found'};`
    + ` audio pill ${pillBottom === null
      ? 'not found'
      : `ends at ${pillBottom} — ${pillBottom <= height ? 'on screen' : 'BELOW THE FOLD'}`}`;
}
