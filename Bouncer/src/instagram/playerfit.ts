// Sizing the reel player to its slot instead of to the screen.
//
// Instagram's mobile Reels viewer gives each slide a slot of
// `calc(100% - var(--mobile-nav-height) - env(safe-area-inset-bottom))` — the
// screen minus its bottom tab bar — but sizes the player inside it `100dvh`.
// The player therefore hangs a tab bar's height (45px) past the foot of its
// slot, and the bar, once on screen, covers the bottom of the reel: the audio
// pill and the last caption line. Safari shows the same overlap whenever its
// toolbar collapses; the iOS app's WebView sits in that state permanently.
//
// The fix, verified by hand in Web Inspector: `height: 100%` on the player and
// on every box between it and the slot, so the player follows the slot rather
// than the viewport. Where the slot already equals the viewport the two agree
// and nothing is touched.
//
// The reel's UI layer (byline, caption, audio pill) is the video's next
// sibling, and it needs pinning too. Instagram's classes make it
// `position: absolute; top: 0; height: 100%` over the video, but an inline
// `position: relative` on it overrides them, so the layer falls back into
// normal flow below the video, collapses to zero height, and its
// bottom-anchored rows land a tab bar's height under the slot. Pinning the
// sibling to the player box (`position: absolute; inset: 0`) lays the layer
// exactly over the video: measured on device, a 0px layer at 679 became 0..679
// with the pill ending 20px above the box bottom. No pixel offsets involved,
// so it stays right as the viewport changes.
//
// Measured rather than matched: Instagram's class names are hashed and change
// without notice. The pattern looked for is "a chain of viewport-tall boxes
// whose top sits inside a shorter box" — the slot.

/** Marks what we've changed, so it can all be handed back on teardown. The
 *  value says what was done: '' = height chain, 'overlay' = pinned a UI layer
 *  over the video. */
const MARKER = 'data-bouncer-playerfit';

/** Separate from MARKER because the player box is also in the height chain:
 *  one attribute can't record both changes. Marks a box we made a positioned
 *  container for its pinned overlays. */
const ANCHOR = 'data-bouncer-playerfit-anchor';

/** Heights within this of each other are the same height (subpixel rounding). */
const SLOP_PX = 1.5;

/** Below this, a slot is a page mid-layout rather than a reel's room. */
const MIN_SLOT_HEIGHT_PX = 200;

/** A slot shorter than the player by more than this is not "the screen minus a
 *  tab bar" but some other box — a thumbnail, a sheet — and not ours to fit. */
const MAX_OVERHANG_PX = 150;

/** Fit every mounted player that overhangs its slot. Returns how many were
 *  fitted this pass — zero once they all have been, which is the common case. */
export function fitPlayersToSlots(): number {
  const view = window.innerHeight;
  let fitted = 0;
  for (const video of Array.from(document.querySelectorAll('video'))) {
    // The video itself is left alone: it fills its box, and its box is what
    // gets fixed.
    const chain: HTMLElement[] = [];
    let el = video.parentElement;
    while (el && el !== document.body) {
      const height = el.getBoundingClientRect().height;
      if (Math.abs(height - view) > SLOP_PX) break;   // left the viewport-tall run
      chain.push(el);
      const slot = el.parentElement;
      if (!slot) break;
      const slotHeight = slot.getBoundingClientRect().height;
      const overhang = height - slotHeight;
      if (overhang > SLOP_PX) {
        if (overhang <= MAX_OVERHANG_PX && slotHeight >= MIN_SLOT_HEIGHT_PX) {
          for (const box of chain) {
            box.style.setProperty('height', '100%', 'important');
            box.setAttribute(MARKER, '');
          }
          fitted++;
        }
        break;
      }
      el = slot;
    }
    // Its own pass, not part of the chain fit: the UI layer can mount after
    // the player was fitted, and a fitted chain is never re-found (it no
    // longer overhangs).
    const box = video.parentElement;
    if (box?.getAttribute(MARKER) === '') pinOverlays(box, video);
  }
  return fitted;
}

/** Lay every in-flow sibling after the video over it. Already-positioned
 *  siblings (absolute/fixed) are left alone: they are laid over the video by
 *  Instagram's own CSS. */
function pinOverlays(box: HTMLElement, video: HTMLVideoElement): void {
  for (let sib = video.nextElementSibling; sib; sib = sib.nextElementSibling) {
    if (!(sib instanceof HTMLElement) || sib.hasAttribute(MARKER)) continue;
    const position = getComputedStyle(sib).position;
    if (position !== 'static' && position !== 'relative') continue;
    if (getComputedStyle(box).position === 'static') {
      box.style.setProperty('position', 'relative', 'important');
      box.setAttribute(ANCHOR, '');
    }
    sib.style.setProperty('position', 'absolute', 'important');
    sib.style.setProperty('inset', '0', 'important');
    sib.setAttribute(MARKER, 'overlay');
  }
}

/** Give every resized box back what it had. */
export function unfitPlayers(): void {
  for (const el of Array.from(document.querySelectorAll<HTMLElement>(`[${ANCHOR}]`))) {
    el.style.removeProperty('position');
    el.removeAttribute(ANCHOR);
  }
  for (const el of Array.from(document.querySelectorAll<HTMLElement>(`[${MARKER}]`))) {
    const kind = el.getAttribute(MARKER);
    if (kind === 'overlay') {
      el.style.removeProperty('position');
      el.style.removeProperty('inset');
    } else {
      el.style.removeProperty('height');
    }
    el.removeAttribute(MARKER);
  }
}
