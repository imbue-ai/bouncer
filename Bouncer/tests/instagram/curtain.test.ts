/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  rideInOffset, revealTarget, liftAction, installCurtain, type Curtain,
} from '../../src/instagram/curtain';
import type { ReelRecord } from '../../src/instagram/library';

describe('riding in with the incoming reel', () => {
  it('glues the cover to the next slide top when slides are knowable', () => {
    // Revealed at 750; slides at 0/750/1500. Mid-scroll at 1100, the incoming
    // slide (1500) is 400px below the viewport top — so is the cover.
    expect(rideInOffset(1100, 750, [0, 750, 1500], 750)).toBe(400);
    // Arrived: the cover sits flush.
    expect(rideInOffset(1500, 750, [0, 750, 1500], 750)).toBe(0);
  });

  it('never overshoots above the viewport top', () => {
    expect(rideInOffset(1600, 750, [0, 750, 1500], 750)).toBe(0);
  });

  it('falls back to one viewport below the departed rest when slides are opaque', () => {
    // The phone feed nests its slides a level deeper than the scroller, so
    // child geometry is unusable — the cover approximates the incoming slide
    // as a viewport below where the last reveal happened.
    expect(rideInOffset(1100, 750, [], 724)).toBe(374);
  });
});

describe('whether a released cover reveals', () => {
  it('commits once dragged far enough', () => {
    expect(revealTarget(0.4, 0)).toBe('revealed');
    expect(revealTarget(0.2, 0)).toBe('covered');
  });

  it('lets a flick reveal from anywhere — a flick means "show me", however short', () => {
    expect(revealTarget(0.05, 0.8)).toBe('revealed');
  });

  it('lets a downward flick keep the cover even after a long drag', () => {
    expect(revealTarget(0.7, -0.8)).toBe('covered');
  });
});

describe('what a lifted finger meant', () => {
  // A thumb drifts 10–20px on an ordinary tap, and its last few pixels can
  // carry flick-grade instantaneous velocity. Neither may cost the tap.
  it('reads a lift within the slop as a tap, whatever its velocity', () => {
    expect(liftAction(0.01, 0, 0, false)).toBe('tap');
    expect(liftAction(0.02, 0.3, 18, false)).toBe('tap');
    expect(liftAction(0.02, 0.9, 18, false)).toBe('tap');
  });

  it('still lets a flick past the slop reveal from any distance', () => {
    expect(liftAction(0.05, 0.8, 60, false)).toBe('reveal');
  });

  it('commits a drag past the fraction and settles one short of it', () => {
    expect(liftAction(0.4, 0, 400, false)).toBe('reveal');
    expect(liftAction(0.1, 0, 60, false)).toBe('settle');
  });

  it('never taps out of a cancelled gesture', () => {
    expect(liftAction(0.01, 0, 4, true)).toBe('settle');
  });
});

// ==================== The cover in a document ====================

function record(i: number): ReelRecord {
  const card = document.createElement('div');
  document.body.appendChild(card);
  return {
    index: i, reelId: `reel_${i}`, card,
    thumbnailUrl: `https://cdn/x/reel_${i}.jpg`,
    description: `Reel ${i + 1} description`,
    durationSec: 10 + i, creator: `creator_${i}`, reachable: true,
  } as ReelRecord;
}

function cover(): HTMLElement | null {
  return document.getElementById('bouncer-ig-curtain');
}

function coverRows(): HTMLElement[] {
  return Array.from(cover()?.querySelectorAll<HTMLElement>('.bouncer-ig-crow') ?? []);
}

/** A touch on `el` carrying one point — happy-dom has no TouchEvent
 *  constructor that takes touches, so the lists are attached by hand. */
function touchOn(el: HTMLElement, type: string, clientY: number): void {
  const e = new Event(type, { bubbles: true, cancelable: true });
  const list = [{ clientX: 200, clientY }];
  const ended = type === 'touchend' || type === 'touchcancel';
  Object.defineProperty(e, 'touches', { value: ended ? [] : list });
  Object.defineProperty(e, 'changedTouches', { value: list });
  el.dispatchEvent(e);
}

/** A touch tap with the drift of a real finger. Deliberately produces NO
 *  click: WebKit only synthesizes one for a finger that barely moved, which is
 *  exactly the case the cover cannot rely on. */
function touchTap(el: HTMLElement, drift = 0, end: 'touchend' | 'touchcancel' = 'touchend'): void {
  touchOn(el, 'touchstart', 300);
  if (drift !== 0) touchOn(el, 'touchmove', 300 - drift);   // negative = upward
  touchOn(el, end, 300 - drift);
}

describe('tapping a row on the cover', () => {
  let api: Curtain | null = null;
  let goTo: ReturnType<typeof vi.fn>;
  let route = 0;

  /** Scroll never fires in this document, so the cover goes up the way the
   *  pager layout raises it: the address changes and holds for a tick. */
  async function coverUp(): Promise<void> {
    window.history.pushState({}, '', `/reels/route_${++route}/`);
    await vi.advanceTimersByTimeAsync(600);    // two path ticks: hold, then cover
  }

  beforeEach(async () => {
    vi.useFakeTimers();
    document.body.replaceChildren();
    window.history.pushState({}, '', `/reels/route_${++route}/`);
    goTo = vi.fn();
    const records = [record(0), record(1), record(2)];
    api = installCurtain({ records: () => records, goTo });
    await coverUp();
  });

  afterEach(() => {
    api?.teardown();
    api = null;
    vi.useRealTimers();
  });

  it('arrives covered, rows rendered', () => {
    expect(api!.isOpen()).toBe(true);
    expect(coverRows()).toHaveLength(3);
  });

  // THE ROW THAT TOOK SEVERAL TAPS. The cover preventDefaults every touchmove
  // (that is the architecture), and WebKit answers a cancelled move by never
  // synthesizing a click — so a click-driven row only ever heard from a
  // perfectly still finger. The tap is read off the touch stream instead.
  it('acts on the tap at touchend, without waiting for a click', () => {
    touchTap(coverRows()[1]);
    expect(goTo).toHaveBeenCalledTimes(1);
    expect((goTo.mock.calls[0][0] as ReelRecord).reelId).toBe('reel_1');
    expect(api!.isOpen()).toBe(false);
  });

  it('still picks under the drift of a real finger', () => {
    touchTap(coverRows()[2], 18);
    expect(goTo).toHaveBeenCalledTimes(1);
    expect((goTo.mock.calls[0][0] as ReelRecord).reelId).toBe('reel_2');
  });

  it('reveals when the tapped row is the reel underneath', () => {
    touchTap(coverRows()[0]);
    expect(goTo).not.toHaveBeenCalled();
    expect(api!.isOpen()).toBe(false);
  });

  it('does not act twice when a click does trail the tap', () => {
    const row = coverRows()[1];
    touchTap(row);
    row.click();
    expect(goTo).toHaveBeenCalledTimes(1);
  });

  // Slow, because a FAST 40px drag is a flick and a flick reveals; only the
  // deliberate drag that stops short settles.
  it('settles back without tapping after a slow drag past the slop', async () => {
    vi.useRealTimers();
    const row = coverRows()[1];
    touchOn(row, 'touchstart', 300);
    touchOn(row, 'touchmove', 270);
    await new Promise((r) => setTimeout(r, 40));
    touchOn(row, 'touchmove', 260);      // 10px in 40ms: nobody's flick
    touchOn(row, 'touchend', 260);

    expect(goTo).not.toHaveBeenCalled();
    expect(api!.isOpen()).toBe(true);
  });

  it('never taps out of a cancelled touch', () => {
    touchTap(coverRows()[1], 0, 'touchcancel');
    expect(goTo).not.toHaveBeenCalled();
    expect(api!.isOpen()).toBe(true);
  });

  // The mouse still picks by clicking — reading taps off the touch stream must
  // not cost the desktop its rows.
  it('still picks from a plain click', () => {
    coverRows()[1].click();
    expect(goTo).toHaveBeenCalledTimes(1);
  });
});
