/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  installSuggestions, rowThumbSize, WINDOW_SIZE, type Suggestions,
} from '../../src/instagram/suggest';
import type { ReelRecord } from '../../src/instagram/library';

const GLASS_ID = 'bouncer-ig-glass';
const STILL_ID = 'bouncer-ig-hold';

let nav: Suggestions | null = null;
let goTo: ReturnType<typeof vi.fn>;
let setChromeHidden: ReturnType<typeof vi.fn>;
let current = 0;
let all: ReelRecord[] = [];

/** A feed of `n` reels, numbered the way the user counts them (reel 1 is
 *  index 0). */
function feed(n: number): ReelRecord[] {
  return Array.from({ length: n }, (_, i) => {
    const card = document.createElement('div');
    document.body.appendChild(card);
    return {
      index: i,
      reelId: `reel_${i}`,
      card,
      thumbnailUrl: `https://cdn/x/reel_${i}.jpg`,
      description: `Reel ${i + 1} description`,
      durationSec: 10 + i,
      creator: `creator_${i}`,
      reachable: true,
    };
  });
}

function glass(): HTMLElement | null {
  return document.getElementById(GLASS_ID);
}

function rows(): HTMLElement[] {
  return Array.from(glass()?.querySelectorAll<HTMLElement>('.bouncer-ig-opt') ?? []);
}

/** The fixed slots the glass reserves, mounted or not. */
function slots(): HTMLElement[] {
  return Array.from(glass()?.querySelectorAll<HTMLElement>('[data-ff-slot]') ?? []);
}

/** Which reels the glass is offering, as the user would number them. */
function offered(): number[] {
  return rows().map((row) => {
    const src = row.querySelector('img')?.getAttribute('src') ?? '';
    return Number(/reel_(\d+)\.jpg/.exec(src)?.[1] ?? -1) + 1;
  });
}

/** A touch event carrying one point. happy-dom has no TouchEvent constructor
 *  that takes touches, so the lists are attached by hand — the handlers only
 *  ever read `clientY` off the first of them. */
function touch(type: string, clientY: number): void {
  const e = new Event(type, { bubbles: true, cancelable: true });
  const list = [{ clientY }];
  // The finger is gone by the time the gesture ends, so only `changedTouches`
  // carries a point — which is why the handlers read both.
  const ended = type === 'touchend' || type === 'touchcancel';
  Object.defineProperty(e, 'touches', { value: ended ? [] : list });
  Object.defineProperty(e, 'changedTouches', { value: list });
  (document.querySelector('video') ?? document.body).dispatchEvent(e);
}

/** A swipe on the reel itself. Negative dy is upward — the gesture that used to
 *  hand you the next reel. */
function swipeReel(dy: number): void {
  touch('touchstart', 500);
  touch('touchmove', 500 + dy);
  touch('touchend', 500 + dy);
}

/** A flick so fast the system takes the gesture before a single touchmove is
 *  delivered, and cancels ours. What "swiping too hard" looks like from here. */
function flickReel(dy: number): void {
  touch('touchstart', 500);
  touch('touchcancel', 500 + dy);
}

/** A drag on the glass. */
function dragGlass(dy: number): void {
  const target = glass();
  if (!target) throw new Error('nothing open');
  target.dispatchEvent(new PointerEvent('pointerdown', { clientY: 300, button: 0, bubbles: true }));
  target.dispatchEvent(new PointerEvent('pointermove', { clientY: 300 + dy, button: 0, bubbles: true }));
  target.dispatchEvent(new PointerEvent('pointerup', { clientY: 300 + dy, button: 0, bubbles: true }));
}

beforeEach(() => {
  document.body.replaceChildren();
  goTo = vi.fn();
  setChromeHidden = vi.fn();
  all = feed(10);
  current = 0;
  nav = installSuggestions({
    // What index.ts hands over: the reel on screen, followed by the rest.
    // Nothing behind it — the chooser has no way to show a reel you've passed.
    records: () => all.slice(Math.max(0, current)),
    goTo,
    setChromeHidden,
  });
  nav.refresh();
});

afterEach(() => {
  nav?.teardown();
  nav = null;
});

describe('raising the glass', () => {
  it('leaves the reel alone until it is asked for', () => {
    expect(glass()).toBeNull();
    expect(document.body.children).toHaveLength(all.length);   // just the cards
  });

  it('comes up when you swipe up on the reel', () => {
    swipeReel(-80);
    expect(glass()).not.toBeNull();
    expect(rows()).toHaveLength(WINDOW_SIZE);
  });

  it('ignores a swipe too small to be one', () => {
    swipeReel(-12);
    expect(glass()).toBeNull();
  });

  // Down is not ours. Going back a reel is the one thing the feed does that
  // doesn't decide anything for you, so it keeps working exactly as it always
  // has — by way of a synthetic swipe, since the real one was swallowed on the
  // way past.
  it('leaves a downward swipe meaning what it always meant', async () => {
    vi.useFakeTimers();
    let back = 0;
    let startY: number | null = null;
    const onStart = (e: Event): void => {
      startY = (e as TouchEvent).touches[0]?.clientY ?? null;
    };
    const onMove = (e: Event): void => {
      const y = (e as TouchEvent).touches[0]?.clientY;
      if (startY === null || y === undefined || Math.abs(startY - y) < 60) return;
      if (y > startY) back++;
      startY = null;
    };
    document.addEventListener('touchstart', onStart);
    document.addEventListener('touchmove', onMove);

    swipeReel(120);
    await vi.advanceTimersByTimeAsync(1000);
    document.removeEventListener('touchstart', onStart);
    document.removeEventListener('touchmove', onMove);
    vi.useRealTimers();

    expect(glass()).toBeNull();     // no chooser for the back direction
    expect(back).toBe(1);           // Instagram was asked to go back, once
  });

  // Instagram opens things OVER the reel that scroll on their own — comments,
  // most of all. The lock takes the swipe away from the whole page and the
  // chooser read what was left as "show me what's next", so opening comments
  // and scrolling raised the glass instead of moving the comments, and there
  // was no way to read them at all.
  describe('a sheet the page opened over the reel', () => {
    /** A comments sheet: scrollable, with somewhere to scroll to. */
    function sheet(): HTMLElement {
      const el = document.createElement('div');
      el.setAttribute('role', 'dialog');
      el.style.overflowY = 'auto';
      Object.defineProperty(el, 'clientHeight', { value: 400, configurable: true });
      Object.defineProperty(el, 'scrollHeight', { value: 2000, configurable: true });
      const comment = document.createElement('div');
      el.appendChild(comment);
      document.body.appendChild(el);
      return comment;
    }

    /** The same swipe, but starting inside the sheet. */
    function swipeInSheet(dy: number): void {
      const target = sheet();
      for (const [type, y] of [['touchstart', 500], ['touchmove', 500 + dy], ['touchend', 500 + dy]] as const) {
        const e = new Event(type, { bubbles: true, cancelable: true });
        const list = [{ clientY: y }];
        const ended = type === 'touchend';
        Object.defineProperty(e, 'touches', { value: ended ? [] : list });
        Object.defineProperty(e, 'changedTouches', { value: list });
        target.dispatchEvent(e);
      }
    }

    it('scrolls rather than raising the glass', () => {
      swipeInSheet(-120);
      expect(glass()).toBeNull();
    });

    // And the page has to be told about it, or the sheet cannot scroll either:
    // suppression that stops the chooser opening would also stop the comments
    // moving, which is the same bug wearing a different hat.
    it('is left entirely to the page', () => {
      const seen: string[] = [];
      const onMove = (e: Event): void => {
        seen.push(e.defaultPrevented ? 'prevented' : 'through');
      };
      document.addEventListener('touchmove', onMove);
      swipeInSheet(-120);
      document.removeEventListener('touchmove', onMove);

      expect(seen).toEqual(['through']);
    });
  });

  // The complaint this answers: swipe hard and the feed jumped a reel instead.
  // A flick can be over before one touchmove arrives, and the release is then
  // the only evidence there was a swipe at all.
  it('comes up for a flick too fast to send a single move', () => {
    flickReel(-140);
    expect(glass()).not.toBeNull();
  });

  // One pane, covering the reel, with nothing behind the rows but the reel
  // itself — no card, no second surface. That is the whole look.
  it('covers the reel with a single pane the reel shows through', () => {
    swipeReel(-80);
    const pane = glass()!;
    expect(pane.style.position).toBe('fixed');
    expect(pane.style.cssText).toContain('inset: 0');
    expect(pane.style.backdropFilter).toContain('blur');
    // Translucent, not a background colour: `rgba(...)` stops at less than 1.
    expect(pane.style.background).toContain('rgba');
    expect(document.querySelectorAll('.bouncer-ig-glass-pane')).toHaveLength(1);
  });

  // Rows sit on the glass, so their contrast has to come from the type itself —
  // white at weight, and the pane's own tint behind it. Not a shadow per glyph:
  // at this size that haloes rather than separates. If a bright reel ever takes
  // the words away, the pane gets darker, not the letters heavier.
  it('sets its rows in white with no panel and no shadow behind them', () => {
    swipeReel(-80);
    const row = rows()[0];
    expect(row.style.background).toBe('');
    const title = row.querySelector('div')!.querySelector('div')!;
    expect(title.style.color).toBe('#ffffff');
    expect(title.style.textShadow).toBe('');
  });

  // The describer's settings icon is pinned above everything we mount, which
  // includes the glass — and the glass carries nothing but the three rows.
  it('takes the describer\'s own furniture off the screen while it is up', () => {
    swipeReel(-80);
    expect(setChromeHidden).toHaveBeenLastCalledWith(true);
    nav!.close();
    expect(setChromeHidden).toHaveBeenLastCalledWith(false);
  });
});

describe('what the glass offers', () => {
  // The user's own example: watching reel 3, swipe up, choose from 4/5/6.
  it('offers the three reels after the one you are watching', () => {
    current = 2;
    swipeReel(-80);
    expect(offered()).toEqual([4, 5, 6]);
  });

  it('starts at the top of the feed when you have not moved yet', () => {
    current = 0;
    swipeReel(-80);
    expect(offered()).toEqual([2, 3, 4]);
  });

  // Never the reel you're on, and never one behind it.
  it('offers only what is ahead, however far in you are', () => {
    current = 6;
    swipeReel(-80);
    expect(offered()).toEqual([8, 9, 10]);
  });

  it('runs out gracefully at the end of the feed', () => {
    current = 8;
    swipeReel(-80);
    expect(offered()).toEqual([10]);
  });

  it('shows each reel\'s label, length and creator', () => {
    current = 0;
    swipeReel(-80);
    const first = rows()[0].textContent ?? '';
    expect(first).toContain('Reel 2 description');
    expect(first).toContain('0:11');
    expect(first).toContain('by creator_1');
  });

  it('says so rather than showing an empty pane when nothing else is loaded', () => {
    all = [];
    current = -1;
    swipeReel(-80);
    expect(rows()).toHaveLength(0);
    expect(glass()?.textContent).toContain('Nothing else loaded yet');
  });
});

describe('rows arrive whole', () => {
  // The three facts a row is made of land at different times — the description
  // is a round trip, the length arrives when Instagram feels like it. Rendered
  // as they come, a row rewrites itself under the reader and shoves the rows
  // below it around while it does.
  it('holds a row back until it has its description, creator and length', () => {
    all[1] = { ...all[1], description: 'Describing…' };
    current = 0;
    swipeReel(-80);
    expect(offered()).toEqual([3, 4]);
  });

  it('still reserves the space, so nothing moves when the row lands', () => {
    all[1] = { ...all[1], description: 'Describing…' };
    current = 0;
    swipeReel(-80);
    expect(slots()).toHaveLength(WINDOW_SIZE);
    expect(rows()).toHaveLength(2);
  });

  // And it lands in the slot that was being held for it, not on the end.
  it('drops the finished row into its own slot rather than after the others', () => {
    all[1] = { ...all[1], description: 'Describing…' };
    current = 0;
    swipeReel(-80);

    all[1] = { ...all[1], description: 'Reel 2 description' };
    nav!.refresh();

    expect(offered()).toEqual([2, 3, 4]);
    expect(slots()[0].querySelector('.bouncer-ig-opt')).not.toBeNull();
  });

  it('waits for a length as well as a description', () => {
    all[1] = { ...all[1], durationSec: null };
    current = 0;
    swipeReel(-80);
    expect(offered()).toEqual([3, 4]);
  });

  it('waits for a creator too', () => {
    all[1] = { ...all[1], creator: null };
    current = 0;
    swipeReel(-80);
    expect(offered()).toEqual([3, 4]);
  });
});

describe('the offer does not move once the glass is up', () => {
  // The bug this is here for: the host rescans the feed while the glass is
  // open, the anchor reel gets recycled out of records(), and every row
  // silently re-points at a different reel — so the row you were reaching for
  // is not the reel you get.
  it('keeps offering what it opened with when the anchor is recycled away', () => {
    current = 2;
    swipeReel(-80);
    expect(offered()).toEqual([4, 5, 6]);

    current = 5;          // the anchor, reel_2, is no longer in records()
    nav!.refresh();

    expect(offered()).toEqual([4, 5, 6]);
  });

  it('takes new facts for a reel without moving it to another slot', () => {
    all[3] = { ...all[3], description: 'Describing…' };
    current = 2;
    swipeReel(-80);
    expect(offered()).toEqual([5, 6]);

    all[3] = { ...all[3], description: 'Reel 4 description' };
    nav!.refresh();

    expect(offered()).toEqual([4, 5, 6]);
    expect(slots()[0].textContent).toContain('Reel 4 description');
  });
});

describe('putting the glass away', () => {
  beforeEach(() => {
    current = 2;
    swipeReel(-80);
  });

  it('stays for a drag too small to be a gesture', () => {
    dragGlass(20);
    expect(glass()).not.toBeNull();
  });

  // The drag that sprang back is over; the tap after it is its own gesture.
  it('still takes a tap after a drag that sprang back', async () => {
    dragGlass(20);
    await new Promise((r) => setTimeout(r, 320));
    glass()!.click();
    expect(glass()).toBeNull();
  });

  it('goes away when you tap the pane itself', () => {
    glass()!.click();
    expect(glass()).toBeNull();
  });

  // Momentum keeps arriving after the finger is up, and reopening the sheet the
  // user just dismissed is the one thing it must not do.
  it('does not come straight back on the tail of the gesture that closed it', () => {
    nav!.close();
    swipeReel(-80);
    expect(glass()).toBeNull();
  });
});

describe('picking a reel', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  /** What Instagram's own recogniser would see of a synthetic gesture. */
  function watchSwipes(): { count: () => number; stop: () => void } {
    let startY: number | null = null;
    let count = 0;
    const onStart = (e: Event): void => {
      startY = (e as TouchEvent).touches[0]?.clientY ?? null;
    };
    const onMove = (e: Event): void => {
      const y = (e as TouchEvent).touches[0]?.clientY;
      if (startY === null || y === undefined) return;
      if (Math.abs(startY - y) < 60) return;
      startY = null;
      count++;
    };
    document.addEventListener('touchstart', onStart);
    document.addEventListener('touchmove', onMove);
    return {
      count: () => count,
      stop: () => {
        document.removeEventListener('touchstart', onStart);
        document.removeEventListener('touchmove', onMove);
      },
    };
  }

  // A pick is a journey, not a jump: one swipe per reel between here and there,
  // so Instagram's own pager ends up agreeing about where you are.
  it('swipes its way there, one reel at a time', async () => {
    current = 2;
    swipeReel(-80);
    const ig = watchSwipes();

    rows()[2].click();                       // the third row: three reels along
    await vi.advanceTimersByTimeAsync(4000);
    ig.stop();

    expect(ig.count()).toBe(3);
    expect(glass()).toBeNull();
  });

  // And nobody watches the journey. Two reels you didn't ask for flicking past
  // on the way to the one you did is worse than any wait, so a picture of the
  // destination covers the whole thing and lifts when you're there.
  it('covers the journey with a picture of where you are going', async () => {
    current = 2;
    swipeReel(-80);
    rows()[2].click();

    const cover = document.getElementById(STILL_ID);
    expect(cover?.getAttribute('src')).toBe('https://cdn/x/reel_5.jpg');
    expect(cover?.style.position).toBe('fixed');

    // Still there while the swiping happens.
    await vi.advanceTimersByTimeAsync(300);
    expect(document.getElementById(STILL_ID)).not.toBeNull();

    await vi.advanceTimersByTimeAsync(4000);
    expect(document.getElementById(STILL_ID)).toBeNull();
  });

  // Same bug as "the offer does not move", seen from the other end: the cover
  // is a picture of where we are going, so it names the reel the pick actually
  // chose. Before slots were stable this landed on reel 8.
  it('goes to the reel the row is showing after the feed moved under it', async () => {
    current = 2;
    swipeReel(-80);
    current = 5;
    nav!.refresh();

    rows()[2].click();
    expect(document.getElementById(STILL_ID)?.getAttribute('src'))
      .toBe('https://cdn/x/reel_5.jpg');

    await vi.advanceTimersByTimeAsync(4000);
  });

  it('goes there and puts the glass away', async () => {
    current = 2;
    swipeReel(-80);
    rows()[1].click();                       // reel 5 of 4/5/6
    await vi.advanceTimersByTimeAsync(4000);

    // The scroll still happens last, as a finisher, in case the pager ignored us.
    expect(goTo).toHaveBeenCalledTimes(1);
    expect((goTo.mock.calls[0][0] as ReelRecord).reelId).toBe('reel_4');
    expect(glass()).toBeNull();
    expect(setChromeHidden).toHaveBeenLastCalledWith(false);
  });

  // A drag ends in an up the browser also reports as a click on whatever was
  // underneath it; dragging the glass must not also navigate.
  it('ignores the click that trails a drag', async () => {
    current = 2;
    swipeReel(-80);
    const row = rows()[0];
    row.dataset.ffDragged = '1';
    row.click();
    await vi.advanceTimersByTimeAsync(4000);
    expect(goTo).not.toHaveBeenCalled();
  });

  /** Give every card real geometry, laid out as slides of a pager that
   *  advances one slide per synthetic swipe. `slideOf` maps a record's index
   *  to its slide — letting a test put an undiscovered slide (an ad) between
   *  records, which is exactly what the signed-in feed does. */
  function layoutFeed(slideOf: (i: number) => number): { stop: () => void } {
    let pager = slideOf(current);
    let startY: number | null = null;
    const onStart = (e: Event): void => {
      startY = (e as TouchEvent).touches[0]?.clientY ?? null;
    };
    const onMove = (e: Event): void => {
      const y = (e as TouchEvent).touches[0]?.clientY;
      if (startY === null || y === undefined) return;
      const dy = startY - y;
      if (Math.abs(dy) < 60) return;
      startY = null;
      pager += dy > 0 ? 1 : -1;
    };
    document.addEventListener('touchstart', onStart);
    document.addEventListener('touchmove', onMove);
    for (const [i, record] of all.entries()) {
      record.card.getBoundingClientRect = () => ({
        top: (slideOf(i) - pager) * 660, bottom: (slideOf(i) - pager) * 660 + 660,
        height: 660, width: 390, left: 0, right: 390,
        x: 0, y: (slideOf(i) - pager) * 660, toJSON: () => ({}),
      }) as DOMRect;
    }
    return {
      stop: () => {
        document.removeEventListener('touchstart', onStart);
        document.removeEventListener('touchmove', onMove);
      },
    };
  }

  // THE SIGNED-IN BUG. That feed interleaves slides this pipeline never
  // discovers — ads, "suggested for you" — so "the next row" can be two
  // slides away, and a counted journey landed on the wrong slide. The walk
  // now measures where the chosen card is after every swipe and keeps going
  // until it is the one on screen.
  it('steers by where the reel actually is, not by counting rows', async () => {
    current = 2;
    // An undiscovered slide sits right after the current reel: records and
    // slides disagree by one from there on.
    const pager = layoutFeed((i) => (i <= 2 ? i : i + 1));
    swipeReel(-80);
    const ig = watchSwipes();

    rows()[0].click();                       // the next record — TWO slides away
    await vi.advanceTimersByTimeAsync(8000);
    ig.stop();
    pager.stop();

    expect(ig.count()).toBe(2);
    expect(goTo).toHaveBeenCalledTimes(1);
    expect(glass()).toBeNull();
  });

  // A pager that ignores the synthetic gesture entirely must not be swiped at
  // forever — two swipes with no movement is the answer, and goTo's scroll is
  // the remaining way to arrive.
  it('stands down against a pager that ignores it and lets goTo finish', async () => {
    current = 2;
    for (const [i, record] of all.entries()) {
      record.card.getBoundingClientRect = () => ({
        top: (i - 2) * 660, bottom: (i - 2) * 660 + 660, height: 660,
        width: 390, left: 0, right: 390, x: 0, y: (i - 2) * 660, toJSON: () => ({}),
      }) as DOMRect;
    }
    swipeReel(-80);
    const ig = watchSwipes();

    rows()[2].click();                       // three records along, nothing moves
    await vi.advanceTimersByTimeAsync(8000);
    ig.stop();

    expect(ig.count()).toBe(2);              // tried twice, then stood down
    expect(goTo).toHaveBeenCalledTimes(1);
    expect(glass()).toBeNull();
  });

  // A reel has its own address, and that is the one way to reach it that
  // cannot miscount, cannot be interrupted half way, and does not care how the
  // pager lays its slides out. Verified against the live feed before it was
  // built: every media object carries `code`, and the code of the reel on
  // screen is exactly what the address bar reads.
  it('jumps straight to a reel by its own address, without swiping', async () => {
    current = 2;
    all[3] = { ...all[3], code: 'ABC123' };

    // Instagram's router, answering a pushState by painting that reel.
    let painted = 2;
    const doc = document as Document & {
      elementsFromPoint?: (x: number, y: number) => Element[];
    };
    doc.elementsFromPoint = () => [all[painted].card];
    const onPop = (): void => {
      if (location.pathname === '/reels/ABC123/') painted = 3;
    };
    window.addEventListener('popstate', onPop);

    swipeReel(-80);
    const ig = watchSwipes();
    rows()[0].click();
    await vi.advanceTimersByTimeAsync(6000);
    ig.stop();
    window.removeEventListener('popstate', onPop);
    delete doc.elementsFromPoint;

    expect(ig.count()).toBe(0);                    // no journey at all
    expect(all[painted].reelId).toBe('reel_3');    // exactly the reel chosen
    expect(location.pathname).toBe('/reels/ABC123/');
  });

  // And a reel the hook never saw has no address to jump to, so the journey is
  // still there underneath.
  it('falls back to swiping for a reel with no known address', async () => {
    current = 2;
    swipeReel(-80);
    const ig = watchSwipes();
    rows()[0].click();
    await vi.advanceTimersByTimeAsync(6000);
    ig.stop();

    expect(ig.count()).toBeGreaterThan(0);
    expect(goTo).toHaveBeenCalledTimes(1);
  });

  // THE LAYOUT THE DEVICE ACTUALLY USES, measured from its own logs: every
  // card reports the same rectangle — nine reels stacked in one box — so which
  // one you are looking at is decided by paint order and nothing else. Every
  // rectangle-based question answered about the layout instead of the feed,
  // which is how a pick reported "ON SCREEN (top 0 of 660)" while showing a
  // completely different reel. Steering has to ask what is painted.
  it('swipes until the chosen reel is the one painted, on a stacked pager', async () => {
    current = 2;
    for (const r of all) {
      r.card.getBoundingClientRect = () => ({
        top: 0, bottom: 660, height: 660, width: 390, left: 0, right: 390,
        x: 0, y: 0, toJSON: () => ({}),
      }) as DOMRect;
    }

    // Paint order is the feed position here, and a swipe is what moves it.
    // One undiscovered slide — an ad — sits after slide 2, so counting rows
    // lands one short and only watching what is painted gets there.
    const slideOf = (i: number): number => (i <= 2 ? i : i + 1);
    let painted = 2;
    const recordAt = (slide: number): ReelRecord | undefined =>
      all.find((_, i) => slideOf(i) === slide);
    const doc = document as Document & {
      elementsFromPoint?: (x: number, y: number) => Element[];
    };
    doc.elementsFromPoint = () => {
      const here = recordAt(painted);
      return here ? [here.card] : [document.createElement('div')];
    };

    swipeReel(-80);                        // opens the glass

    // Attached after the user's own swipe, which is not the pager moving.
    let startY: number | null = null;
    const onStart = (e: Event): void => {
      startY = (e as TouchEvent).touches[0]?.clientY ?? null;
    };
    const onMove = (e: Event): void => {
      const y = (e as TouchEvent).touches[0]?.clientY;
      if (startY === null || y === undefined) return;
      const dy = startY - y;
      if (Math.abs(dy) < 60) return;
      startY = null;
      painted += dy > 0 ? 1 : -1;
    };
    document.addEventListener('touchstart', onStart);
    document.addEventListener('touchmove', onMove);

    rows()[1].click();                     // two reels ahead of the anchor
    await vi.advanceTimersByTimeAsync(8000);

    document.removeEventListener('touchstart', onStart);
    document.removeEventListener('touchmove', onMove);
    delete doc.elementsFromPoint;

    // Counting rows would have stopped a slide short, on the ad.
    expect(recordAt(painted)?.reelId).toBe('reel_4');
  });

  // THE HOLD THAT WATCHED THE WRONG THING. On the stacked layout the drift
  // test compared rect.top against the card height — and every card sits at
  // top 0, so it could never fire. The device log said it outright: "WRONG
  // REEL — showing <other>; 0 correction(s)". The diagnosis had been converted
  // to hit-testing and the thing that acts on it had not.
  it('leaves the feed alone when it drifts after landing', async () => {
    current = 2;
    for (const r of all) {
      r.card.getBoundingClientRect = () => ({
        top: 0, bottom: 660, height: 660, width: 390, left: 0, right: 390,
        x: 0, y: 0, toJSON: () => ({}),
      }) as DOMRect;
    }

    let painted = 2;
    const doc = document as Document & {
      elementsFromPoint?: (x: number, y: number) => Element[];
    };
    doc.elementsFromPoint = () => [all[painted].card];

    swipeReel(-80);

    let swipes = 0;
    let startY: number | null = null;
    const onStart = (e: Event): void => {
      swipes++;
      startY = (e as TouchEvent).touches[0]?.clientY ?? null;
    };
    const onMove = (e: Event): void => {
      const y = (e as TouchEvent).touches[0]?.clientY;
      if (startY === null || y === undefined) return;
      const dy = startY - y;
      if (Math.abs(dy) < 60) return;
      startY = null;
      painted += dy > 0 ? 1 : -1;
    };
    document.addEventListener('touchstart', onStart);
    document.addEventListener('touchmove', onMove);

    rows()[0].click();                       // reel_3, one slide along
    await vi.advanceTimersByTimeAsync(1200);
    expect(all[painted].reelId).toBe('reel_3');

    const settled = swipes;
    painted = 5;                             // the pager wanders off on its own
    await vi.advanceTimersByTimeAsync(3000);

    document.removeEventListener('touchstart', onStart);
    document.removeEventListener('touchmove', onMove);
    delete doc.elementsFromPoint;

    // Reported, never chased — see CORRECT_DRIFT_AFTER_LANDING. Chasing it is
    // what produced the visible round trip to the previous reel.
    expect(swipes).toBe(settled);
    expect(all[painted].reelId).toBe('reel_5');
  });

  // THE OVERSHOOT THAT RAN AWAY. When the feed carries past the chosen reel,
  // the app re-anchors on where it landed — which drops the chosen reel out of
  // "the reel you're on and everything after". The old direction test read a
  // missing target as "unknown, go forward" and drove further away, so every
  // correction made it worse. The device log: drifted to a reel two AHEAD,
  // then "one swipe forward" toward a target behind it, twice.
  it('swipes back when the journey itself overshoots the chosen reel', async () => {
    current = 2;
    for (const r of all) {
      r.card.getBoundingClientRect = () => ({
        top: 0, bottom: 660, height: 660, width: 390, left: 0, right: 390,
        x: 0, y: 0, toJSON: () => ({}),
      }) as DOMRect;
    }
    let painted = 2;
    let back = 0;
    const doc = document as Document & {
      elementsFromPoint?: (x: number, y: number) => Element[];
    };
    doc.elementsFromPoint = () => [all[painted].card];

    swipeReel(-80);

    let startY: number | null = null;
    const onStart = (e: Event): void => {
      startY = (e as TouchEvent).touches[0]?.clientY ?? null;
    };
    const onMove = (e: Event): void => {
      const y = (e as TouchEvent).touches[0]?.clientY;
      if (startY === null || y === undefined) return;
      const dy = startY - y;
      if (Math.abs(dy) < 60) return;
      startY = null;
      // A forward swipe carries TWO slides — the queued momentum that makes a
      // journey overshoot. Coming back is one at a time.
      if (dy > 0) painted += 2; else { painted -= 1; back++; }
      // The app re-anchors on whatever it is showing — see updateActive — so
      // "what's ahead" follows the feed. Modelled, because it is precisely
      // what drops an overshot target out of the list.
      current = painted;
    };
    document.addEventListener('touchstart', onStart);
    document.addEventListener('touchmove', onMove);

    rows()[0].click();                         // reel_3, one slide along
    await vi.advanceTimersByTimeAsync(6000);

    document.removeEventListener('touchstart', onStart);
    document.removeEventListener('touchmove', onMove);
    delete doc.elementsFromPoint;

    expect(back).toBeGreaterThan(0);           // it really did come back
    expect(all[painted].reelId).toBe('reel_3');
  });

  // NO SWIPE IS EVER SEEN. The journey was always hidden behind the still
  // frame, but the cover used to lift one frame after it — which put every
  // CORRECTION on screen. A correction is precisely "it showed another reel
  // and then moved to mine", which is what the reports describe. The cover now
  // waits for the pager to stop arguing.
  it('hides every swipe behind the cover, and lifts it once settled', async () => {
    current = 2;
    for (const r of all) {
      r.card.getBoundingClientRect = () => ({
        top: 0, bottom: 660, height: 660, width: 390, left: 0, right: 390,
        x: 0, y: 0, toJSON: () => ({}),
      }) as DOMRect;
    }

    let painted = 2;
    const doc = document as Document & {
      elementsFromPoint?: (x: number, y: number) => Element[];
    };
    doc.elementsFromPoint = () => [all[painted].card];

    swipeReel(-80);

    const coverUp: boolean[] = [];
    let startY: number | null = null;
    const onStart = (e: Event): void => {
      coverUp.push(document.getElementById(STILL_ID) !== null);
      startY = (e as TouchEvent).touches[0]?.clientY ?? null;
    };
    const onMove = (e: Event): void => {
      const y = (e as TouchEvent).touches[0]?.clientY;
      if (startY === null || y === undefined) return;
      const dy = startY - y;
      if (Math.abs(dy) < 60) return;
      startY = null;
      painted += dy > 0 ? 1 : -1;
      current = painted;
    };
    document.addEventListener('touchstart', onStart);
    document.addEventListener('touchmove', onMove);

    rows()[1].click();                              // two reels along
    await vi.advanceTimersByTimeAsync(8000);

    document.removeEventListener('touchstart', onStart);
    document.removeEventListener('touchmove', onMove);
    delete doc.elementsFromPoint;

    expect(coverUp.length).toBeGreaterThan(1);      // a real multi-step journey
    expect(coverUp.every(Boolean)).toBe(true);      // and none of it was seen
    expect(document.getElementById(STILL_ID)).toBeNull();   // the cover does lift
    expect(all[painted].reelId).toBe('reel_4');
  });

  // THE OSCILLATION. A pager mid-animation paints its neighbours, so
  // hit-testing catches whichever slide is in front at that instant. Acting on
  // the first sighting meant correcting against a frame of somebody else's
  // animation — the device log reads "drifted → one swipe back" and then
  // "drifted → one swipe forward", landing back where it started, which from
  // the outside is "it scrolls up then scrolls back down very obviously".
  it('ignores a flicker rather than correcting against it', async () => {
    current = 2;
    for (const r of all) {
      r.card.getBoundingClientRect = () => ({
        top: 0, bottom: 660, height: 660, width: 390, left: 0, right: 390,
        x: 0, y: 0, toJSON: () => ({}),
      }) as DOMRect;
    }

    let painted = 2;
    let look = 0;
    const doc = document as Document & {
      elementsFromPoint?: (x: number, y: number) => Element[];
    };
    // Once we have landed, every other look shows a neighbour — a flicker that
    // never persists, exactly like a slide caught mid-transition.
    doc.elementsFromPoint = () => {
      look++;
      if (painted === 3 && look % 2 === 0) return [all[4].card];
      return [all[painted].card];
    };

    swipeReel(-80);

    let swipes = 0;
    let startY: number | null = null;
    const onStart = (e: Event): void => {
      swipes++;
      startY = (e as TouchEvent).touches[0]?.clientY ?? null;
    };
    const onMove = (e: Event): void => {
      const y = (e as TouchEvent).touches[0]?.clientY;
      if (startY === null || y === undefined) return;
      const dy = startY - y;
      if (Math.abs(dy) < 60) return;
      startY = null;
      painted += dy > 0 ? 1 : -1;
      current = painted;
    };
    document.addEventListener('touchstart', onStart);
    document.addEventListener('touchmove', onMove);

    rows()[0].click();                         // reel_3, one slide along
    await vi.advanceTimersByTimeAsync(800);    // the journey itself
    const afterJourney = swipes;
    await vi.advanceTimersByTimeAsync(6000);   // the whole hold

    document.removeEventListener('touchstart', onStart);
    document.removeEventListener('touchmove', onMove);
    delete doc.elementsFromPoint;

    expect(swipes).toBe(afterJourney);         // the flicker moved nothing
    expect(all[painted].reelId).toBe('reel_3');
  });

  // ARRIVING AND STAYING ARE DIFFERENT THINGS, and this is the second one.
  // Reported from device: the chosen reel appears, plays for a second or two,
  // then glitches back to the reel you came from. Instagram's pager keeps its
  // own idea of which slide is current, and re-asserts it a beat after we have
  // moved the feed some way it did not believe.
  it('puts the chosen reel back when something drags it away after landing', async () => {
    current = 2;
    const chosen = all[3];                 // the first row offered
    let top = 660;                         // one slide ahead of us
    chosen.card.getBoundingClientRect = () => ({
      top, bottom: top + 660, height: 660, width: 390, left: 0, right: 390,
      x: 0, y: top, toJSON: () => ({}),
    }) as DOMRect;
    const putBack = vi.fn(() => { top = 0; });
    chosen.card.scrollIntoView = putBack;

    swipeReel(-80);
    rows()[0].click();
    await vi.advanceTimersByTimeAsync(1200);   // journey done, reel on screen
    const settled = putBack.mock.calls.length;

    top = 1400;                                // the pager re-asserts
    await vi.advanceTimersByTimeAsync(600);

    expect(putBack.mock.calls.length).toBeGreaterThan(settled);
    expect(top).toBe(0);                       // and the reel is back on screen
  });

  // The hold is a landing, not a grip: the moment the user takes the feed back
  // it stands down, or their own swipe away would be undone as drift.
  it('stops holding as soon as a finger touches the screen', async () => {
    current = 2;
    const chosen = all[3];
    let top = 0;
    chosen.card.getBoundingClientRect = () => ({
      top, bottom: top + 660, height: 660, width: 390, left: 0, right: 390,
      x: 0, y: top, toJSON: () => ({}),
    }) as DOMRect;
    const putBack = vi.fn(() => { top = 0; });
    chosen.card.scrollIntoView = putBack;

    swipeReel(-80);
    rows()[0].click();
    await vi.advanceTimersByTimeAsync(1200);
    const settled = putBack.mock.calls.length;

    touch('touchstart', 500);                  // the user takes over
    top = 1400;                                // and swipes away
    await vi.advanceTimersByTimeAsync(600);

    expect(putBack.mock.calls.length).toBe(settled);
    expect(top).toBe(1400);                    // left exactly where they put it
  });

  // Instagram recycles cards, and a reel whose card is gone used to be a dead
  // row. Swiping there doesn't need the card, so it isn't dead any more.
  it('will still go to a reel Instagram has recycled away', async () => {
    all[3] = { ...all[3], reachable: false };
    current = 2;
    swipeReel(-80);
    const ig = watchSwipes();

    rows()[0].click();
    await vi.advanceTimersByTimeAsync(4000);
    ig.stop();

    expect(ig.count()).toBe(1);
    expect(glass()).toBeNull();
  });
});

// Instagram's feed only grows as a consequence of moving through it, so the
// lock that makes this feature work is also what makes the feed run dry — the
// user's report was a last reel with black below it and a chooser with nothing
// new on it.
describe('the scroll lock', () => {
  // How many screenfuls the feed currently holds. The thing restocking is meant
  // to grow, and the thing Instagram stops growing once we take the swipe away.
  let loadedScreens = 10;
  // The furthest the feed was driven, so a restore can't hide a walk that never
  // happened.
  let reached = 0;

  /** A feed of `n` reels inside a scroller of the shape lockScroll looks for:
   *  content that overflows, in a box that says it scrolls. happy-dom has no
   *  layout, so the metrics are declared. */
  function scroller(n: number): HTMLElement {
    const box = document.createElement('div');
    box.style.overflowY = 'auto';
    document.body.appendChild(box);

    const screen = 800;
    let top = 0;
    Object.defineProperty(box, 'clientHeight', { value: screen, configurable: true });
    Object.defineProperty(box, 'scrollHeight', {
      get: () => screen * loadedScreens, configurable: true,
    });
    Object.defineProperty(box, 'scrollTop', {
      get: () => top,
      set: (v: number) => {
        // A real scroller clamps at the end of its content — which is what tells
        // restock the feed has stopped growing.
        top = Math.max(0, Math.min(v, screen * loadedScreens - screen));
        reached = Math.max(reached, top);
      },
      configurable: true,
    });

    all = Array.from({ length: n }, (_, i) => {
      const card = document.createElement('div');
      box.appendChild(card);
      return {
        index: i, reelId: `reel_${i}`, card,
        thumbnailUrl: `https://cdn/x/reel_${i}.jpg`,
        description: `Reel ${i + 1} description`,
        durationSec: 10 + i, creator: `creator_${i}`, reachable: true,
      };
    });
    return box;
  }

  beforeEach(() => {
    loadedScreens = 10;
    reached = 0;
    nav?.teardown();
    document.body.replaceChildren();
    goTo = vi.fn();
    setChromeHidden = vi.fn();
    current = 0;
    nav = installSuggestions({
      records: () => all.slice(Math.max(0, current)), goTo, setChromeHidden,
    });
  });

  it('clips the scroller rather than trusting touch-action alone', () => {
    const box = scroller(10);
    nav!.refresh();
    // touch-action and the wheel blocker are advisory on iOS: WebKit decides a
    // drag is a scroll before it dispatches a cancelable touchmove, which is
    // how a half-swipe still moved the feed. A clipped box cannot be dragged.
    expect(box.style.overflowY).toBe('hidden');
    expect(box.style.touchAction).toBe('none');
  });

  it('leaves the feed scrollable from script, which is how goTo works', () => {
    const box = scroller(10);
    nav!.refresh();
    box.scrollTop = 400;
    expect(box.scrollTop).toBe(400);
  });

  it('keeps holding the scroller across re-detection', () => {
    const box = scroller(10);
    nav!.refresh();
    // The second pass sees our own `overflow: hidden`, which is indistinguishable
    // from a box that never scrolled — it must not conclude it can let go.
    nav!.refresh();
    expect(box.style.overflowY).toBe('hidden');
  });

  // The lock tries to stop the gesture reaching the scroller; this stops the
  // scroller moving when one gets through anyway. On iOS it always does — the
  // feed drifted a half-swipe's worth no matter what the styles said.
  it('puts the feed back when a swipe moves it anyway', () => {
    const box = scroller(10);
    nav!.refresh();
    box.scrollTop = 1600;

    touch('touchstart', 500);
    box.scrollTop = 2400;                    // a gesture leaked past the lock
    box.dispatchEvent(new Event('scroll'));

    expect(box.scrollTop).toBe(1600);
  });

  // Instagram scrolls its own feed too — on route changes, and to correct snap.
  // Undoing those as well would put us in a fight with the page.
  it('leaves alone a scroll no finger caused', () => {
    const box = scroller(10);
    nav!.refresh();
    box.scrollTop = 1600;
    box.dispatchEvent(new Event('scroll'));
    expect(box.scrollTop).toBe(1600);
  });

  // THE PICK THAT WOULD NOT STICK. The tap that chooses a row is a gesture like
  // any other, so its touchend armed the pin for a second and a half — and for
  // that whole time the pin faithfully undid the movement the pick had just
  // asked for. From the outside: the reel you chose appears, then slides back
  // to the one you were on. Signed in it is near-certain rather than
  // occasional, because that pager animates its snap and so settles late, well
  // outside any claim the arrival held.
  it('lets the feed stay where a pick put it', async () => {
    vi.useFakeTimers();
    try {
      const box = scroller(10);
      nav!.refresh();
      box.scrollTop = 800;

      swipeReel(-80);                       // glass up — and the tail armed
      rows()[0].click();                    // pick
      // Long enough for the arrival to finish, short enough that the tap's
      // gesture tail is still live — which is the window the bug lived in.
      await vi.advanceTimersByTimeAsync(1000);

      // Instagram settles its pager, late, the way the signed-in one does.
      box.scrollTop = 2400;
      box.dispatchEvent(new Event('scroll'));

      expect(box.scrollTop).toBe(2400);
    } finally {
      vi.useRealTimers();
    }
  });

  // And the hold comes back for the next real gesture — a pick disarms it, it
  // does not switch it off for good.
  it('holds the feed again once a finger returns', async () => {
    vi.useFakeTimers();
    try {
      const box = scroller(10);
      nav!.refresh();
      box.scrollTop = 800;
      swipeReel(-80);
      rows()[0].click();
      await vi.advanceTimersByTimeAsync(6000);

      touch('touchstart', 500);             // a new gesture, a new hold
      box.scrollTop = 3200;
      box.dispatchEvent(new Event('scroll'));

      expect(box.scrollTop).not.toBe(3200);
    } finally {
      vi.useRealTimers();
    }
  });

  // `overflow: hidden` only stops the BROWSER scrolling the feed. Instagram
  // advances its own feed from the touch stream, which no amount of clipping
  // reaches — that is the leak that made a hard swipe jump a whole reel rather
  // than drift a few pixels. So a swipe stops being delivered to the page.
  describe('taking the swipe from the page', () => {
    /** What Instagram's own swipe recogniser would see. Registered on the
     *  document, where a page listener lives — ours is on the window, ahead of
     *  it in the capture order. */
    function pageSees(): string[] {
      const seen: string[] = [];
      for (const type of ['touchmove', 'touchend']) {
        document.addEventListener(type, () => seen.push(type));
      }
      return seen;
    }

    it('stops telling the page about a gesture once it is a swipe', () => {
      scroller(10);
      nav!.refresh();
      const seen = pageSees();

      swipeReel(-120);
      expect(seen).toEqual([]);
    });

    // A recogniser that missed the movement can still act on the release.
    it('takes the end of a swallowed swipe too', () => {
      scroller(10);
      nav!.refresh();
      const seen = pageSees();

      touch('touchstart', 500);
      touch('touchmove', 380);
      touch('touchend', 380);
      expect(seen).toEqual([]);
    });

    // A tap is not a swipe, and the page still owns taps — that is how liking,
    // muting and everything else on the reel keeps working.
    it('leaves a tap alone', () => {
      scroller(10);
      nav!.refresh();
      const seen = pageSees();

      touch('touchstart', 500);
      touch('touchmove', 498);          // the drift in a still finger
      touch('touchend', 498);
      expect(seen).toEqual(['touchmove', 'touchend']);
    });

    // Including a drag on the glass: a recogniser watching the touch stream
    // doesn't care what the finger is over, and would read the dismissal as a
    // swipe back to the previous reel.
    it('takes a drag on the glass as well', () => {
      scroller(10);
      nav!.refresh();
      swipeReel(-80);
      const seen = pageSees();

      const start = new Event('touchstart', { bubbles: true, cancelable: true });
      Object.defineProperty(start, 'touches', { value: [{ clientY: 300 }] });
      Object.defineProperty(start, 'changedTouches', { value: [{ clientY: 300 }] });
      glass()!.dispatchEvent(start);
      const move = new Event('touchmove', { bubbles: true, cancelable: true });
      Object.defineProperty(move, 'touches', { value: [{ clientY: 420 }] });
      Object.defineProperty(move, 'changedTouches', { value: [{ clientY: 420 }] });
      glass()!.dispatchEvent(move);

      expect(seen).toEqual([]);
    });
  });

  // Snap is what turns a leaked half-swipe into a whole reel.
  it('turns off scroll snapping while it holds the feed', () => {
    const box = scroller(10);
    box.style.scrollSnapType = 'y mandatory';
    nav!.refresh();
    expect(box.style.scrollSnapType).toBe('none');
    nav!.teardown();
    nav = null;
    expect(box.style.scrollSnapType).toBe('y mandatory');
  });

  // Momentum outlives the finger. The window used to be 400ms, which a hard
  // fling coasts straight past — and the rest of the fling landed on the next
  // reel.
  it('keeps holding after the finger has lifted', () => {
    const box = scroller(10);
    nav!.refresh();
    box.scrollTop = 1600;

    touch('touchstart', 500);
    touch('touchend', 300);
    box.scrollTop = 2400;                    // the tail of the fling
    box.dispatchEvent(new Event('scroll'));

    expect(box.scrollTop).toBe(1600);
  });

  // While the glass is up there is no such thing as a legitimate move — not a
  // fling, not a snap correction, not Instagram deciding to advance.
  it('holds the feed with no finger down at all while the glass is up', () => {
    const box = scroller(10);
    current = 0;                             // no restock: nothing else moves it
    nav!.refresh();
    box.scrollTop = 1600;
    swipeReel(-80);

    box.scrollTop = 4000;
    box.dispatchEvent(new Event('scroll'));
    expect(box.scrollTop).toBe(1600);
  });

  // A drag on the glass is the one gesture the preventDefault deliberately lets
  // through — so it is exactly the gesture that can leak into the scroller
  // behind it, and the pin has to be armed for it too.
  it('holds the feed still while the glass itself is being dragged', () => {
    const box = scroller(10);
    nav!.refresh();
    box.scrollTop = 1600;
    swipeReel(-80);

    // A finger going down on the glass, and the feed sliding underneath anyway.
    const start = new Event('touchstart', { bubbles: true, cancelable: true });
    Object.defineProperty(start, 'touches', { value: [{ clientY: 400 }] });
    glass()!.dispatchEvent(start);
    box.scrollTop = 2400;
    box.dispatchEvent(new Event('scroll'));

    expect(box.scrollTop).toBe(1600);
  });

  it('gives the feed back on teardown', () => {
    const box = scroller(10);
    nav!.refresh();
    nav!.teardown();
    nav = null;
    expect(box.style.overflowY).toBe('auto');
    expect(box.style.touchAction).toBe('');
  });

  describe('restocking behind the glass', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    // The end of the list is the only place Instagram loads from, so that is
    // where this goes — not six screens along, which is where the first version
    // stopped and why the chooser ran out of reels to offer.
    it('goes all the way to the end of the list, then puts the feed back', async () => {
      const box = scroller(20);         // far more than six screens of feed
      current = 17;                     // only two reels left ahead
      nav!.refresh();
      box.scrollTop = 1600;
      reached = 0;

      swipeReel(-80);
      await vi.advanceTimersByTimeAsync(9000);

      const end = 800 * loadedScreens - 800;
      expect(reached).toBe(end);               // the very end, not part-way
      expect(box.scrollTop).toBe(1600);        // and it put the feed back
    });

    // THE PICK THAT WENT BACKWARDS. A pick cancels the restock by definition,
    // and cancelling used to mean returning from the middle of a gesture — a
    // touchstart and half a screen of travel with no touchend behind it. A
    // pager handed that springs back to the slide it came from, which is
    // exactly "picking a reel just goes back to the one I started on". Signed
    // in it happens on nearly every pick, because the feed reveals reels
    // slowly enough that a restock is running almost every time the glass
    // opens.
    it('finishes every synthetic gesture when a pick interrupts a restock', async () => {
      const box = scroller(20);
      current = 17;                          // two ahead — a restock will run
      nav!.refresh();
      box.scrollTop = 1600;

      let starts = 0;
      let ends = 0;
      let picked = false;
      const onStart = (): void => { starts++; };
      const onEnd = (): void => { ends++; };
      // Pick from inside the restock's gesture — after its touchstart, before
      // its touchend. Waiting a fixed interval instead would usually land in
      // the settle BETWEEN gestures, where cancelling is harmless and the bug
      // does not reproduce.
      const onMove = (): void => {
        if (picked || starts === 0) return;
        picked = true;
        rows()[0].click();
      };

      swipeReel(-80);                        // glass up, restock under way
      // Counted from here, so only SYNTHETIC gestures are measured: a real
      // one's touchend is deliberately swallowed on its way past (see
      // onTouchEnd), and would look like an abandoned gesture from out here.
      document.addEventListener('touchstart', onStart);
      document.addEventListener('touchend', onEnd);
      document.addEventListener('touchmove', onMove);
      await vi.advanceTimersByTimeAsync(9000);

      document.removeEventListener('touchstart', onStart);
      document.removeEventListener('touchend', onEnd);
      document.removeEventListener('touchmove', onMove);

      expect(picked).toBe(true);              // the collision really happened
      expect(starts).toBeGreaterThan(1);      // the restock really was running
      expect(ends).toBe(starts);              // and nothing was left hanging
      expect(goTo).toHaveBeenCalledTimes(1);  // the pick still arrived
    });

    // Reaching the end is only half of it: the request takes as long as it
    // takes. The old walk gave up after two dead hops — 600ms — and left.
    it('waits at the end for a batch to arrive, and goes back for another', async () => {
      const box = scroller(20);
      current = 17;
      nav!.refresh();
      box.scrollTop = 1600;

      // Instagram appending, a second after we get there. Twice.
      let batches = 0;
      const grow = (): void => {
        if (box.scrollTop < 800 * loadedScreens - 1600) return;   // not at the end
        if (batches >= 2) return;
        batches++;
        loadedScreens += 5;
      };
      const timer = setInterval(grow, 100);

      swipeReel(-80);
      await vi.advanceTimersByTimeAsync(12000);
      clearInterval(timer);

      expect(batches).toBe(2);                 // it stayed long enough, twice
      expect(box.scrollTop).toBe(1600);
    });

    // And the reels it loaded have to be FOUND, which only happens where
    // Instagram mounts their videos — so it comes home a screen at a time
    // rather than jumping back.
    it('walks home in steps so the new reels get discovered', async () => {
      const box = scroller(20);
      current = 17;
      nav!.refresh();
      box.scrollTop = 1600;

      const seen = new Set<number>();
      swipeReel(-80);
      for (let i = 0; i < 90; i++) {
        seen.add(box.scrollTop);
        await vi.advanceTimersByTimeAsync(130);
      }

      const end = 800 * loadedScreens - 800;
      const between = [...seen].filter((top) => top > 1600 && top < end);
      expect(between.length).toBeGreaterThan(2);   // stops on the way, not one jump
      expect(box.scrollTop).toBe(1600);
    });

    // Scrolling to the end asks a SCROLLER for more. Instagram's reels feed is
    // a pager driven by its own swipe recogniser, and its loader hangs off that
    // — so when the scroll produced nothing, the ask is repeated in touch.
    describe('asking in touch when scrolling gets nothing', () => {
      /** A stand-in for Instagram's recogniser: counts swipes, records their
       *  direction, and — once it has seen `loadsAfter` of them — appends reels
       *  the way the real one would.
       *
       *  Torn down after each test. A listener left on the document outlives the
       *  test that added it, and one of these still appending reels during the
       *  next test is a very confusing way to fail. */
      function pager(loadsAfter: number): { swipes: () => string[]; stop: () => void } {
        let startY: number | null = null;
        const swipes: string[] = [];
        const onStart = (e: Event): void => {
          startY = (e as TouchEvent).touches[0]?.clientY ?? null;
        };
        const onMove = (e: Event): void => {
          const y = (e as TouchEvent).touches[0]?.clientY;
          if (startY === null || y === undefined) return;
          if (Math.abs(startY - y) < 60) return;
          swipes.push(startY > y ? 'up' : 'down');
          startY = null;
          if (swipes.length < loadsAfter) return;
          all = [...all, ...feed(3).map((r, i) => ({ ...r, index: all.length + i }))];
        };
        document.addEventListener('touchstart', onStart);
        document.addEventListener('touchmove', onMove);
        return {
          swipes: () => swipes,
          stop: () => {
            document.removeEventListener('touchstart', onStart);
            document.removeEventListener('touchmove', onMove);
          },
        };
      }

      it('swipes the reel until Instagram hands over more', async () => {
        scroller(10);
        current = 7;
        nav!.refresh();
        const ig = pager(2);
        const before = all.length;

        swipeReel(-80);
        await vi.advanceTimersByTimeAsync(12000);
        ig.stop();

        expect(ig.swipes().length).toBeGreaterThan(1);   // it really did ask
        expect(all.length).toBeGreaterThan(before);      // and got an answer
      });

      // Our own suppression would otherwise eat the one swipe we want the page
      // to see.
      it('does not swallow the swipes it sends', async () => {
        scroller(10);
        current = 7;
        nav!.refresh();
        const ig = pager(99);            // never loads, so it keeps asking

        swipeReel(-80);
        await vi.advanceTimersByTimeAsync(12000);
        ig.stop();

        expect(ig.swipes().filter((d) => d === 'up')).toHaveLength(4);
      });

      // Every swipe forward is answered by one back, so the pager ends where it
      // started rather than a few reels along.
      it('comes back the same way it went', async () => {
        scroller(10);
        current = 7;
        nav!.refresh();
        const ig = pager(99);

        swipeReel(-80);
        await vi.advanceTimersByTimeAsync(12000);
        ig.stop();

        const up = ig.swipes().filter((d) => d === 'up').length;
        const down = ig.swipes().filter((d) => d === 'down').length;
        expect(up).toBeGreaterThan(0);
        expect(down).toBeGreaterThanOrEqual(up);
      });
    });

    // The feed moving is the one thing that must not show, so the walk happens
    // under a still of the reel you're on — and only while it is walking.
    it('holds a still of your reel over the feed while it walks', async () => {
      const box = scroller(10);
      current = 7;
      nav!.refresh();
      box.scrollTop = 1600;

      swipeReel(-80);
      await vi.advanceTimersByTimeAsync(300);
      const still = document.getElementById(STILL_ID);
      expect(still?.getAttribute('src')).toBe('https://cdn/x/reel_7.jpg');
      expect(still?.style.position).toBe('fixed');

      await vi.advanceTimersByTimeAsync(9000);
      expect(document.getElementById(STILL_ID)).toBeNull();
    });

    // Most openings have plenty of feed ahead of them. Moving it then would be
    // motion behind the glass bought for nothing.
    it('does not move the feed at all when there is plenty ahead', async () => {
      const box = scroller(10);
      current = 0;                      // nine reels still to come
      nav!.refresh();
      box.scrollTop = 800;
      reached = 0;

      swipeReel(-80);
      await vi.advanceTimersByTimeAsync(9000);

      expect(reached).toBe(0);
      expect(box.scrollTop).toBe(800);
      expect(document.getElementById(STILL_ID)).toBeNull();
    });

    it('stops walking once the feed has nothing more to give', async () => {
      loadedScreens = 2;                // a feed already at its end
      const box = scroller(10);
      current = 7;
      nav!.refresh();
      box.scrollTop = 800;

      swipeReel(-80);
      await vi.advanceTimersByTimeAsync(9000);
      expect(box.scrollTop).toBe(800);
    });

    // Picking a reel scrolls to it. A restock that "restores" afterwards would
    // undo the navigation the user just asked for.
    it('does not drag the feed back after a pick', async () => {
      const box = scroller(10);
      current = 7;
      nav!.refresh();
      box.scrollTop = 800;

      swipeReel(-80);
      await vi.advanceTimersByTimeAsync(300);
      rows()[0].click();
      await vi.advanceTimersByTimeAsync(1000);
      box.scrollTop = 5000;             // stand-in for goTo's scrollIntoView
      await vi.advanceTimersByTimeAsync(9000);

      expect(box.scrollTop).toBe(5000);
      expect(goTo).toHaveBeenCalledTimes(1);
      expect(document.getElementById(STILL_ID)).toBeNull();
    });

    it('puts the feed back when the glass is dismissed instead', async () => {
      const box = scroller(10);
      current = 7;
      nav!.refresh();
      box.scrollTop = 800;

      swipeReel(-80);
      // Past the swiping, into the scroll walk that follows when it found
      // nothing — which is where the feed is somewhere other than home.
      await vi.advanceTimersByTimeAsync(4500);
      expect(box.scrollTop).toBeGreaterThan(800);
      nav!.close();
      expect(box.scrollTop).toBe(800);
    });
  });
});

// Three rows have the whole screen between them, so the thumbnails are the one
// element with room to grow — and a reel is a picture before it is a sentence.
describe('row thumbnails', () => {
  it('fills the room the glass leaves on a phone, at reel aspect', () => {
    const { width, height } = rowThumbSize(390, 844);
    expect(height).toBeGreaterThan(120);
    expect(Math.abs(width / height - 9 / 16)).toBeLessThan(0.02);
  });

  // A tall narrow screen has the vertical room for a huge thumbnail and no
  // horizontal room to spend it — the width bound, not the height, is what has
  // to stop it.
  it('never takes so much width that the description cannot be read', () => {
    const { width } = rowThumbSize(340, 1400);
    // 340 - 28 pane padding - 16 row padding = 296 of row; the title keeps 200,
    // less the gap between them.
    expect(width).toBeLessThanOrEqual(296 - 200 - 14);
  });

  it('stays legible on a short screen rather than collapsing', () => {
    const { height } = rowThumbSize(390, 400);
    expect(height).toBeGreaterThanOrEqual(76);
  });
});

describe('teardown', () => {
  it('takes every surface with it', () => {
    swipeReel(-80);
    nav!.teardown();
    nav = null;
    expect(glass()).toBeNull();
    expect(document.querySelector('.bouncer-ig-glass-pane')).toBeNull();
    expect(document.getElementById(STILL_ID)).toBeNull();
  });
});
