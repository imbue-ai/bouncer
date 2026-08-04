import { describe, it, expect } from 'vitest';
import {
  railAnchoredBox, clampLeft, isNarrowViewport, VIEWPORT_MARGIN_PX,
} from '../../src/instagram/layout';

// Two viewports, one for each of the shapes the Instagram surfaces have to
// survive: a desktop browser, where the action rail has a wide empty column to
// its right, and the iOS app, where the reel fills the screen and the rail is
// overlaid on its right edge.
const DESKTOP = { width: 1440, railLeft: 900 };
const PHONE = { width: 390, railLeft: 344 };
const PANEL_WIDTH = 320;

const M = VIEWPORT_MARGIN_PX;

describe('railAnchoredBox', () => {
  it('keeps the rail column untouched when there is one', () => {
    const box = railAnchoredBox(DESKTOP.railLeft, PANEL_WIDTH, DESKTOP.width);
    expect(box).toEqual({ left: DESKTOP.railLeft, width: PANEL_WIDTH });
  });

  it('narrows to the column when the column is snug but usable', () => {
    // 1440 - 1200 - 20 = 220px of column: over the 180px floor, so the panel
    // stays anchored to the rail and gives up width instead.
    const box = railAnchoredBox(1200, PANEL_WIDTH, DESKTOP.width);
    expect(box).toEqual({ left: 1200, width: 220 });
  });

  it('abandons the column at phone width instead of overflowing', () => {
    const box = railAnchoredBox(PHONE.railLeft, PANEL_WIDTH, PHONE.width);
    // Full preferred width still fits between the margins here...
    expect(box.width).toBe(PANEL_WIDTH);
    // ...so the left edge slides back to make room, rather than tracking the
    // rail off the right of the screen.
    expect(box.left).toBe(PHONE.width - PANEL_WIDTH - M);
    expect(box.left + box.width).toBeLessThanOrEqual(PHONE.width - M);
  });

  it('never returns a box that leaves the viewport', () => {
    for (const viewport of [320, 390, 428, 768, 1024, 1440]) {
      for (const railLeft of [0, 100, viewport - 60, viewport - 10, viewport + 40]) {
        const box = railAnchoredBox(railLeft, PANEL_WIDTH, viewport);
        expect(box.left).toBeGreaterThanOrEqual(M);
        expect(box.left + box.width).toBeLessThanOrEqual(viewport - M + 0.001);
        expect(box.width).toBeGreaterThan(0);
      }
    }
  });

  it('falls back to the margin when the viewport is narrower than the box', () => {
    // 200px wide can't hold a 320px panel plus both margins; starting at the
    // margin is the least-bad answer and is what the outer clamp guarantees.
    const box = railAnchoredBox(150, PANEL_WIDTH, 200);
    expect(box.left).toBe(M);
    expect(box.width).toBe(200 - M * 2);
  });
});

// Which side of this line a viewport falls on decides which feature the
// describer IS: a panel standing beside the reel, or the fullscreen flow that
// puts a chooser between reels and a card over each paused one.
describe('isNarrowViewport', () => {
  it('puts every phone on the fullscreen flow', () => {
    // iPhone SE, 13 mini, 14, 15 Pro Max — portrait widths.
    for (const width of [320, 375, 390, 393, 428, 430]) {
      expect(isNarrowViewport(width)).toBe(true);
    }
  });

  it('leaves tablets and desktops on the floating panel', () => {
    // iPad portrait, iPad landscape, and ordinary browser windows.
    for (const width of [768, 834, 1024, 1180, 1440]) {
      expect(isNarrowViewport(width)).toBe(false);
    }
  });

  // A phone in landscape is wide enough for a column beside the reel, which is
  // exactly the case the panel was built for — so it gets the panel back.
  it('follows a rotation rather than the device', () => {
    expect(isNarrowViewport(390)).toBe(true);
    expect(isNarrowViewport(844)).toBe(false);
  });
});

describe('clampLeft', () => {
  it('leaves a fixed-size element on its anchor when it fits', () => {
    expect(clampLeft(DESKTOP.railLeft, 44, DESKTOP.width)).toBe(DESKTOP.railLeft);
  });

  it('pulls it back onto a phone-width screen', () => {
    expect(clampLeft(PHONE.railLeft, 44, PHONE.width)).toBe(PHONE.width - 44 - M);
  });

  it('never goes past the left margin', () => {
    expect(clampLeft(0, 400, 200)).toBe(M);
  });
});
