// Instagram's top chrome, on the Reels viewer only.
//
// The bar across the top of /reels/ carries the wordmark and a camera button.
// Neither does anything the describer does not already do better, and both cost
// the reel the strip of screen it most needs: the reel is sized to the viewport,
// so every pixel the bar occupies is a pixel taken off the bottom of the video —
// which is where the caption and the audio pill live.
//
// FOUND BY MEASUREMENT, not by selector. Instagram's class names are hashed and
// change without notice; "is there a short bar pinned across the top" is a
// question about the rendered page, and it keeps working when the markup moves.
// Same reasoning as ./promo.ts, and deliberately the same shape of code.
//
// REELS ONLY. On a profile or the home feed that bar is the navigation, and
// removing it would strand people on a page with no way out. The describer is
// already scoped to the reels routes; this matches it.

/** Marks what we hid, so it can all be handed back on teardown. */
const MARKER = 'data-bouncer-topbar';

/** Ours, and off limits. */
const OURS = '[id^="bouncer-"], [class^="bouncer-"]';

/** How far from the top edge still counts as "against" it. */
const TOP_SLACK_PX = 8;

/** A bar is a strip. Past this much of the screen it is a page, and something
 *  we have misidentified. */
const MAX_BAR_FRACTION = 0.18;

/** Below this it is a stray pinned pixel, not a bar. */
const MIN_BAR_HEIGHT_PX = 24;

function isPinned(el: Element): boolean {
  const position = getComputedStyle(el).position;
  return position === 'fixed' || position === 'sticky';
}

/** Whether this element is a bar across the top of the screen. */
function looksLikeTopBar(el: HTMLElement): boolean {
  const view = window.visualViewport?.height ?? window.innerHeight;
  const rect = el.getBoundingClientRect();
  if (rect.width < window.innerWidth * 0.6) return false;
  if (rect.height < MIN_BAR_HEIGHT_PX) return false;
  if (rect.height > view * MAX_BAR_FRACTION) return false;
  if (rect.top > TOP_SLACK_PX) return false;
  // A bar with a video in it is the reel, wearing a bar's dimensions because we
  // caught it mid-layout.
  return el.querySelector('video') === null;
}

/** Everything that could be a pinned bar, without walking the whole document.
 *  Instagram portals its chrome to the end of <body>, so a shallow sweep finds
 *  it and a deep one would only cost time. */
function candidates(): HTMLElement[] {
  const found: HTMLElement[] = [];
  for (const root of Array.from(document.body?.children ?? [])) {
    if (!(root instanceof HTMLElement) || root.matches(OURS)) continue;
    found.push(root);
    for (const child of Array.from(root.children)) {
      if (child instanceof HTMLElement && !child.matches(OURS)) found.push(child);
    }
  }
  // `<header>` is the one semantic hook Instagram has kept, so it is worth
  // asking for by name as well — it is often nested deeper than the sweep goes.
  for (const header of Array.from(document.querySelectorAll<HTMLElement>('header'))) {
    if (!header.matches(OURS)) found.push(header);
  }
  return found;
}

/** Hide the top bar. Returns how many were dealt with. */
export function hideTopBar(): number {
  let hidden = 0;
  for (const el of candidates()) {
    if (el.hasAttribute(MARKER)) continue;
    if (!isPinned(el) || !looksLikeTopBar(el)) continue;
    el.setAttribute(MARKER, '');
    el.style.setProperty('display', 'none', 'important');
    hidden++;
  }
  return hidden;
}

/** Give every hidden bar back. Called when leaving the reels routes, where that
 *  bar is the only navigation there is. */
export function showTopBar(): void {
  for (const el of Array.from(document.querySelectorAll<HTMLElement>(`[${MARKER}]`))) {
    el.style.removeProperty('display');
    el.removeAttribute(MARKER);
  }
}

/** Watch for it. The bar is re-rendered on route changes and after Instagram
 *  hydrates, so this is a standing job rather than a one-off.
 *
 *  Coalesced onto a timer for the same reason ./promo.ts is: Instagram mutates
 *  its DOM continuously, and "is there a bar at the top" does not need an
 *  answer more than a few times a second. */
export function installTopBarHider(isReels: () => boolean, everyMs = 400): () => void {
  const tick = (): void => {
    if (isReels()) hideTopBar();
    else showTopBar();
  };
  tick();
  const timer = setInterval(tick, everyMs);
  return () => {
    clearInterval(timer);
    showTopBar();
  };
}
