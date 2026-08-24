// Horizontal placement for the fixed-position surfaces the Instagram scripts
// pin to the page — the describer panel, the bounce popup, the welcome tour's
// copy block.
//
// All three anchor to Instagram's like/comment rail so they read as part of the
// page's own layout. On desktop that works because the rail sits at the right
// edge of the reel with a wide empty column beyond it. On a phone-width
// viewport — which is what the iOS app is — the reel fills the screen and the
// rail is OVERLAID on its right edge, so there is no column to sit in: anchoring
// straight to `rail.left` puts most of the surface past the right edge, where it
// is silently unreachable.
//
// Hence one helper both platforms go through. It keeps the rail column when the
// column exists (desktop is byte-for-byte unchanged) and falls back to a
// viewport-inset box when it doesn't.

/** Inset kept between any of these surfaces and the viewport edge. */
export const VIEWPORT_MARGIN_PX = 20;

/** Below this, the rail's column isn't a column any more — it's a sliver. */
const MIN_COLUMN_WIDTH_PX = 180;

/** Below this viewport width the reel IS the screen: there is no column beside
 *  it, and anything pinned over it is taken out of the video you came to watch.
 *  At or above it there's room to stand a panel next to the reel.
 *
 *  Sized off the widest phone in landscape-less portrait use (~430pt) with room
 *  to spare, and comfortably under a landscape iPad or any desktop window. */
const NARROW_MAX_WIDTH_PX = 700;

/** Whether this viewport is too narrow to hold UI beside the reel — the signal
 *  that swaps the floating "up next" panel for the fullscreen flow (a transition
 *  chooser between reels, and a description card over the paused reel). */
export function isNarrowViewport(viewportWidth: number = window.innerWidth): boolean {
  return viewportWidth < NARROW_MAX_WIDTH_PX;
}

/** Where to put a surface of `preferredWidth` that wants its left edge on
 *  `anchorLeft` (the rail's left edge).
 *
 *  Returns the width to use and a left that guarantees the whole box stays
 *  within the viewport. When the rail's column is too narrow to hold the
 *  surface, the column is abandoned and the box is laid out against the
 *  viewport instead — wider and fully visible beats narrow and half off-screen.
 */
export function railAnchoredBox(
  anchorLeft: number,
  preferredWidth: number,
  viewportWidth: number = window.innerWidth,
): { left: number; width: number } {
  const margin = VIEWPORT_MARGIN_PX;
  const column = viewportWidth - anchorLeft - margin;
  const available = column >= MIN_COLUMN_WIDTH_PX
    ? column
    : Math.max(1, viewportWidth - margin * 2);
  const wanted = Math.min(preferredWidth, available);
  // Clamp order matters: on a viewport too narrow for even `wanted` + margins,
  // the outer max wins and the box starts at the margin rather than off-screen
  // to the left.
  const left = Math.max(margin, Math.min(anchorLeft, viewportWidth - wanted - margin));
  // That max may have pushed the box right of where its width was measured for
  // (an anchor hard against the left edge), so re-fit against the final left —
  // otherwise the box would run past the opposite margin instead.
  const width = Math.min(wanted, Math.max(1, viewportWidth - left - margin));
  return { left, width };
}

/** Same clamp for a fixed-width surface (one that must not be resized to fit,
 *  like the collapsed panel's icon button). Width is taken as given.
 *
 *  `margin` is how much edge to keep. It defaults to the inset the panels use,
 *  but a small glyph placed on a centre line wants far less: the clamp exists to
 *  keep a surface on screen, and for anything narrow enough to already be on
 *  screen it should not be moving it at all. */
export function clampLeft(
  anchorLeft: number,
  width: number,
  viewportWidth: number = window.innerWidth,
  margin: number = VIEWPORT_MARGIN_PX,
): number {
  return Math.max(margin, Math.min(anchorLeft, viewportWidth - width - margin));
}
