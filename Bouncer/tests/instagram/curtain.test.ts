/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  rideInOffset, revealTarget, dismissTarget, liftAction, installCurtain, type Curtain,
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

describe('whether a released row dismisses', () => {
  it('commits once dragged past the fraction of its width', () => {
    expect(dismissTarget(0.4, 0)).toBe('dismissed');
    expect(dismissTarget(0.2, 0)).toBe('kept');
  });

  it('lets an outward flick dismiss from any distance', () => {
    expect(dismissTarget(0.05, 0.8)).toBe('dismissed');
  });

  it('lets a flick back keep the row even after a long pull', () => {
    expect(dismissTarget(0.7, -0.8)).toBe('kept');
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
function touchOn(el: HTMLElement, type: string, clientY: number, clientX = 200): void {
  const e = new Event(type, { bubbles: true, cancelable: true });
  const list = [{ clientX, clientY }];
  const ended = type === 'touchend' || type === 'touchcancel';
  Object.defineProperty(e, 'touches', { value: ended ? [] : list });
  Object.defineProperty(e, 'changedTouches', { value: list });
  el.dispatchEvent(e);
}

/** A sideways swipe across a row. Distance-judged: rows in this document have
 *  no laid-out width, so the handler falls back to window.innerWidth — the dx
 *  here must clear DISMISS_FRACTION of that to commit. */
function touchSwipe(el: HTMLElement, dx: number): void {
  touchOn(el, 'touchstart', 300, 200);
  touchOn(el, 'touchmove', 300, 200 + Math.round(dx / 2));
  touchOn(el, 'touchmove', 300, 200 + dx);
  touchOn(el, 'touchend', 300, 200 + dx);
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

describe('swiping a row aside on the cover', () => {
  let api: Curtain | null = null;
  let goTo: ReturnType<typeof vi.fn>;
  let onDismiss: ReturnType<typeof vi.fn>;
  let route = 0;

  async function coverUp(): Promise<void> {
    window.history.pushState({}, '', `/reels/route_${++route}/`);
    await vi.advanceTimersByTimeAsync(600);
  }

  beforeEach(async () => {
    vi.useFakeTimers();
    document.body.replaceChildren();
    window.history.pushState({}, '', `/reels/route_${++route}/`);
    goTo = vi.fn();
    onDismiss = vi.fn();
    const records = [record(0), record(1), record(2)];
    api = installCurtain({ records: () => records, goTo, onDismiss });
    await coverUp();
  });

  afterEach(() => {
    api?.teardown();
    api = null;
    vi.useRealTimers();
  });

  it('dismisses the swiped row; the cover stays, the reel is gone from it', async () => {
    touchSwipe(coverRows()[1], 500);
    await vi.advanceTimersByTimeAsync(250);     // the exit animation's commit
    expect(goTo).not.toHaveBeenCalled();
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect((onDismiss.mock.calls[0][0] as ReelRecord).reelId).toBe('reel_1');
    expect(api!.isOpen()).toBe(true);
    expect(coverRows()).toHaveLength(2);
    expect(cover()?.textContent).not.toContain('Reel 2 description');
  });

  it('swiping the reel underneath aside journeys to the next kept reel, still covered', async () => {
    touchSwipe(coverRows()[0], 500);
    await vi.advanceTimersByTimeAsync(250);
    expect(goTo).toHaveBeenCalledTimes(1);
    expect((goTo.mock.calls[0][0] as ReelRecord).reelId).toBe('reel_1');
    // Not a reveal: the cover went down for the journey, to rise on arrival.
    expect(api!.isOpen()).toBe(false);
  });

  it('swiping left dismisses the same as swiping right', async () => {
    touchSwipe(coverRows()[1], -500);
    await vi.advanceTimersByTimeAsync(250);
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(coverRows()).toHaveLength(2);
  });

  it('a dismissed reel arriving back under the sheet is skipped, never revealed', async () => {
    touchSwipe(coverRows()[0], 500);            // decline reel_0, journey begins
    await vi.advanceTimersByTimeAsync(250);
    goTo.mockClear();
    await coverUp();                            // the feed lands on reel_0 again
    expect(goTo).toHaveBeenCalledTimes(1);
    expect((goTo.mock.calls[0][0] as ReelRecord).reelId).toBe('reel_1');
    expect(api!.isOpen()).toBe(false);
  });

  it('stays dismissed on every later cover', async () => {
    touchSwipe(coverRows()[2], 500);            // decline reel_2
    await vi.advanceTimersByTimeAsync(250);
    api!.close();
    await coverUp();
    expect(coverRows()).toHaveLength(2);
    expect(cover()?.textContent).not.toContain('Reel 3 description');
  });

  // Slow and short, like the vertical settle test: a fast pull is a flick and
  // a flick commits from any distance.
  it('settles the row back after a slow pull that stops short', async () => {
    vi.useRealTimers();
    const row = coverRows()[1];
    touchOn(row, 'touchstart', 300, 200);
    touchOn(row, 'touchmove', 300, 230);
    await new Promise((r) => setTimeout(r, 40));
    touchOn(row, 'touchmove', 300, 240);        // 10px in 40ms: nobody's flick
    touchOn(row, 'touchend', 300, 240);
    expect(onDismiss).not.toHaveBeenCalled();
    expect(coverRows()).toHaveLength(3);
    expect(api!.isOpen()).toBe(true);
  });

  it('never dismisses out of a cancelled gesture', async () => {
    const row = coverRows()[1];
    touchOn(row, 'touchstart', 300, 200);
    touchOn(row, 'touchmove', 300, 500);
    touchOn(row, 'touchcancel', 300, 500);
    await vi.advanceTimersByTimeAsync(250);
    expect(onDismiss).not.toHaveBeenCalled();
    expect(coverRows()).toHaveLength(3);
  });

  it('a sideways drag does not read as a tap on release', async () => {
    touchSwipe(coverRows()[1], 500);
    coverRows()[1]?.click();                    // the trailing click, if any
    await vi.advanceTimersByTimeAsync(250);
    expect(goTo).not.toHaveBeenCalled();
  });
});

// The host refreshes the curtain on every rescan and description arrival —
// which on a live feed is constantly, including mid-gesture. Rebuilding the
// rows for that detached the element the finger was dragging: iOS keeps
// delivering the rest of the stream to the detached node, where it no longer
// bubbles to the cover — the row "loses grip", and the stuck mode then ate the
// next swipe's start.
describe('holding the rows steady under a finger', () => {
  let api: Curtain | null = null;
  let goTo: ReturnType<typeof vi.fn>;
  let onDismiss: ReturnType<typeof vi.fn>;
  let records: ReelRecord[] = [];
  let route = 1000;

  async function coverUp(): Promise<void> {
    window.history.pushState({}, '', `/reels/route_${++route}/`);
    await vi.advanceTimersByTimeAsync(600);
  }

  beforeEach(async () => {
    vi.useFakeTimers();
    document.body.replaceChildren();
    window.history.pushState({}, '', `/reels/route_${++route}/`);
    goTo = vi.fn();
    onDismiss = vi.fn();
    records = [record(0), record(1), record(2)];
    api = installCurtain({ records: () => records, goTo, onDismiss });
    await coverUp();
  });

  afterEach(() => {
    api?.teardown();
    api = null;
    vi.useRealTimers();
  });

  it('keeps its grip on the dragged row through a mid-drag refresh', async () => {
    const row = coverRows()[1];
    touchOn(row, 'touchstart', 300, 200);
    touchOn(row, 'touchmove', 300, 260);        // past the slop: the drag owns the row

    api!.refresh();                             // a description landing mid-gesture
    expect(row.isConnected).toBe(true);         // same element, still under the finger
    expect(coverRows()[1]).toBe(row);

    touchOn(row, 'touchmove', 300, 200 + 500);
    touchOn(row, 'touchend', 300, 200 + 500);
    await vi.advanceTimersByTimeAsync(250);
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect((onDismiss.mock.calls[0][0] as ReelRecord).reelId).toBe('reel_1');
  });

  it('updates a mounted row in place when its facts arrive', () => {
    const row = coverRows()[1];
    records[1] = { ...records[1], description: 'Fresh words for reel two' };
    api!.refresh();
    expect(coverRows()[1]).toBe(row);           // never rebuilt
    expect(row.textContent).toContain('Fresh words for reel two');
  });

  // The device sequence behind "then the next one doesn't even move": the
  // first drag's end went to a detached node, the mode stuck, and the second
  // gesture's start was ignored. A new finger down is proof the old gesture is
  // over — it must reset and be heard.
  it('recovers from a drag whose end was never delivered', async () => {
    const first = coverRows()[1];
    const second = coverRows()[2];
    touchOn(first, 'touchstart', 300, 200);
    touchOn(first, 'touchmove', 300, 260);      // mid-drag...
    first.remove();                             // ...the row leaves the document;
                                                // its touchend dies with it

    touchSwipe(second, 500);                    // a fresh swipe on another row
    await vi.advanceTimersByTimeAsync(250);
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect((onDismiss.mock.calls[0][0] as ReelRecord).reelId).toBe('reel_2');
  });

  it('applies a deferred reshape once the finger lifts', async () => {
    const row = coverRows()[1];
    touchOn(row, 'touchstart', 300, 200);
    touchOn(row, 'touchmove', 300, 230);        // a drag in flight
    records.splice(2, 1);                       // reel_2 vanishes from the host
    api!.refresh();                             // reshape wanted — but held back
    expect(coverRows()).toHaveLength(3);

    touchOn(row, 'touchmove', 300, 235);
    touchOn(row, 'touchend', 300, 235);         // stops short: the row settles
    await vi.advanceTimersByTimeAsync(250);
    expect(coverRows()).toHaveLength(2);        // the owed render, paid on lift
    expect(onDismiss).not.toHaveBeenCalled();
  });
});

// Swiping a reel away doesn't remove it from Instagram's feed — the DOM still
// holds it, and every journey past it would otherwise show its opening frame.
// The shield is the opaque stand-in planted INSIDE the dismissed reel's own
// card, at dismissal time — attached, it scrolls with the reel and is simply
// already there whenever the feed brings the reel by. (A fixed overlay raised
// on arrival showed the declined frame for as long as settle detection took.)
describe('shielding a dismissed reel', () => {
  let api: Curtain | null = null;
  let goTo: ReturnType<typeof vi.fn>;
  let onDismiss: ReturnType<typeof vi.fn>;
  let records: ReelRecord[] = [];
  let route = 2000;

  function shieldOn(card: HTMLElement): HTMLElement | null {
    return card.querySelector('.bouncer-ig-shield');
  }

  async function coverUp(): Promise<void> {
    window.history.pushState({}, '', `/reels/route_${++route}/`);
    await vi.advanceTimersByTimeAsync(600);
  }

  beforeEach(async () => {
    vi.useFakeTimers();
    document.body.replaceChildren();
    window.history.pushState({}, '', `/reels/route_${++route}/`);
    goTo = vi.fn();
    onDismiss = vi.fn();
    records = [record(0), record(1), record(2)];
    api = installCurtain({ records: () => records, goTo, onDismiss });
    await coverUp();
  });

  afterEach(() => {
    api?.teardown();
    api = null;
    vi.useRealTimers();
  });

  it("plants the shield on the reel's card the moment it is dismissed", async () => {
    touchSwipe(coverRows()[1], 500);            // decline a FUTURE reel
    await vi.advanceTimersByTimeAsync(250);     // the exit animation's commit
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(shieldOn(records[1].card)).not.toBeNull();   // attached, before any journey
    expect(shieldOn(records[0].card)).toBeNull();
    expect(shieldOn(records[2].card)).toBeNull();
  });

  it('shields the reel underneath before the journey away from it', async () => {
    touchSwipe(coverRows()[0], 500);            // decline the reel underneath
    await vi.advanceTimersByTimeAsync(250);
    expect(goTo).toHaveBeenCalledTimes(1);
    expect(shieldOn(records[0].card)).not.toBeNull();   // its frame never had the screen
  });

  it('keeps the shield standing when the feed lands on the reel again', async () => {
    touchSwipe(coverRows()[0], 500);
    await vi.advanceTimersByTimeAsync(250);
    await coverUp();                            // the feed arrives on reel_0 anyway
    expect(shieldOn(records[0].card)).not.toBeNull();
  });

  it('follows the reel to a replacement card', async () => {
    touchSwipe(coverRows()[1], 500);
    await vi.advanceTimersByTimeAsync(250);
    const oldCard = records[1].card;
    const newCard = document.createElement('div');
    document.body.appendChild(newCard);
    oldCard.remove();                           // Instagram remounts the slide
    records[1] = { ...records[1], card: newCard };

    api!.refresh();
    expect(shieldOn(newCard)).not.toBeNull();
  });

  it('evicts a shield from a card recycled to a reel the user keeps', async () => {
    touchSwipe(coverRows()[1], 500);
    await vi.advanceTimersByTimeAsync(250);
    const recycled = records[1].card;
    // Instagram hands reel_1's element to a NEW, kept reel; reel_1 is gone
    // from the feed the host can see.
    records = [records[0], { ...record(9), card: recycled }, records[2]];

    api!.refresh();
    expect(shieldOn(recycled)).toBeNull();      // the kept reel is not blacked out
  });

  it('takes its shields with it on teardown', async () => {
    touchSwipe(coverRows()[1], 500);
    await vi.advanceTimersByTimeAsync(250);
    const card = records[1].card;
    api!.teardown();
    api = null;
    expect(shieldOn(card)).toBeNull();
  });
});
