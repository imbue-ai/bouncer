/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { fitReel, fitReels, unfitAll, visibleHeight, fitReport } from '../../src/instagram/fit';

/** What `100vh` resolves to: the layout viewport, chrome included. */
const LAYOUT = 800;
/** What you can actually see. The gap between the two is the whole subject. */
const VISIBLE = 700;

/** happy-dom has no layout, so every box says how big it is. */
function box(width: number, height: number, top = 0): HTMLElement {
  const el = document.createElement('div');
  el.getBoundingClientRect = () => ({
    width, height, top, left: 0, right: width, bottom: top + height, x: 0, y: top,
    toJSON: () => ({}),
  }) as DOMRect;
  return el;
}

/** A box that obeys the clamp it is given, the way a real one does. The plain
 *  `box` helper reports a fixed height forever, which hides an entire class of
 *  bug: a clamped element measures at its clamp. */
function responsiveBox(width: number, natural: number): HTMLElement {
  const el = document.createElement('div');
  el.getBoundingClientRect = () => {
    const capped = parseInt(el.style.maxHeight || '', 10);
    const height = Number.isFinite(capped) ? Math.min(natural, capped) : natural;
    return {
      width, height, top: 0, left: 0, right: width, bottom: height, x: 0, y: 0,
      toJSON: () => ({}),
    } as DOMRect;
  };
  return el;
}

/** Pretend the visible viewport is smaller than the layout one, which on iOS it
 *  almost always is. */
function withVisible<T>(height: number, run: () => T): T {
  const original = Object.getOwnPropertyDescriptor(window, 'visualViewport');
  Object.defineProperty(window, 'visualViewport', {
    value: { height, addEventListener() { /* unused */ }, removeEventListener() { /* unused */ } },
    configurable: true,
  });
  try {
    return run();
  } finally {
    if (original) Object.defineProperty(window, 'visualViewport', original);
  }
}

beforeEach(() => {
  document.body.replaceChildren();
  window.innerHeight = LAYOUT;
  window.innerWidth = 390;
});

afterEach(() => { unfitAll(); });

describe('fitting a reel to the screen', () => {
  // The bug: Instagram sizes a reel to `100vh`, which on iOS is the height the
  // viewport reaches once the browser chrome has gone — bigger than what you can
  // see. The foot of the card, where the audio pill lives, hangs below the fold.
  it('pins a viewport-tall card to what you can see', () => {
    const card = box(390, LAYOUT);
    document.body.appendChild(card);

    expect(fitReel(card, VISIBLE)).toBe(1);
    expect(card.style.maxHeight).toBe('700px');
    // Both bounds: `min-height: 100vh` beats a max-height on its own, and
    // Instagram uses it as freely as it uses height.
    expect(card.style.minHeight).toBe('700px');
  });

  it('leaves a card that already fits completely alone', () => {
    const card = box(390, 680);
    document.body.appendChild(card);

    expect(fitReel(card, VISIBLE)).toBe(0);
    expect(card.getAttribute('style')).toBeNull();
  });

  // The card is rarely the only offender — the media wrapper inside it is
  // usually sized to the same 100vh.
  it('reaches the overgrown elements inside it too', () => {
    const card = box(390, LAYOUT);
    const media = box(390, LAYOUT);
    const pill = box(200, 40);
    card.appendChild(media);
    card.appendChild(pill);
    document.body.appendChild(card);

    expect(fitReel(card, VISIBLE)).toBe(2);
    expect(media.style.maxHeight).toBe('700px');
    expect(pill.getAttribute('style')).toBeNull();
  });

  // THE REGRESSION THIS GUARDS. Clamping anything merely taller than the
  // visible area caught scroll containers and flex parents whose height is a
  // consequence of their children. Forcing a min-height onto those is how the
  // page ends up shoved sideways with a gutter down one edge. Only boxes that
  // are A VIEWPORT TALL are `100vh` boxes; the rest are somebody's layout.
  it('leaves a tall scroll container alone', () => {
    const card = box(390, LAYOUT);
    const scroller = box(390, 2400);
    card.appendChild(scroller);
    document.body.appendChild(card);

    expect(fitReel(card, VISIBLE)).toBe(1);
    expect(scroller.getAttribute('style')).toBeNull();
  });

  // MEASURED ON DEVICE, and the reason the rule changed. The card was 660
  // against a 705 layout viewport with 621 visible: forty-five pixels short of
  // "a viewport", so the old exact-match rule skipped it entirely — while
  // thirty-nine pixels of it, carrying everything Instagram pins to the bottom
  // edge, sat below the fold. Sized to the screen is not the same as equal to
  // it; the page subtracts its own chrome first.
  it('clamps a card sized to the screen but not equal to it', () => {
    const card = box(390, 660);
    document.body.appendChild(card);

    expect(fitReel(card, 621)).toBe(1);
    expect(card.style.maxHeight).toBe('621px');
    expect(card.style.minHeight).toBe('621px');
  });

  // A tall narrow box is a rail or a scrollbar, and squashing it would be a
  // visible bug of our own making.
  it('ignores slivers', () => {
    const card = box(390, LAYOUT);
    const rail = box(40, LAYOUT);
    card.appendChild(rail);
    document.body.appendChild(card);

    fitReel(card, VISIBLE);
    expect(rail.getAttribute('style')).toBeNull();
  });

  // A page mid-layout reports nonsense; acting on it would pin a reel to 40px.
  it('does nothing when the screen measurement is not credible', () => {
    const card = box(390, LAYOUT);
    document.body.appendChild(card);
    expect(fitReel(card, 40)).toBe(0);
    expect(card.getAttribute('style')).toBeNull();
  });

  it('skips cards Instagram has already recycled', () => {
    const live = box(390, LAYOUT);
    const gone = box(390, LAYOUT);
    document.body.appendChild(live);
    expect(withVisible(VISIBLE, () => fitReels([live, gone]))).toBe(1);
  });

  // Whatever we changed, we change back — this is somebody else's page.
  it('gives every element back exactly what it had', () => {
    const card = box(390, LAYOUT);
    const media = box(390, LAYOUT);
    card.appendChild(media);
    document.body.appendChild(card);
    fitReel(card, VISIBLE);

    unfitAll();
    expect(card.style.maxHeight).toBe('');
    expect(card.style.minHeight).toBe('');
    expect(media.style.maxHeight).toBe('');
    expect(document.querySelectorAll('[data-bouncer-fit]')).toHaveLength(0);
  });
});

describe('when the viewport changes size', () => {
  // iOS slides Safari's chrome in and out constantly, and the keyboard shrinks
  // the viewport further. Every one of those is a re-fit at a new height.
  it('lets a reel grow back when there is more room', () => {
    const card = responsiveBox(390, LAYOUT);
    document.body.appendChild(card);

    fitReel(card, 600);
    expect(card.style.maxHeight).toBe('600px');

    // The chrome slides away: more room than before.
    fitReel(card, 780);
    expect(card.style.maxHeight).toBe('780px');
    expect(card.style.minHeight).toBe('780px');
  });

  // The regression this guards: a clamped element measures at its clamp, so it
  // looks like it fits and keeps last time's smaller height. Each shrink
  // ratcheted the reel down and no growth ever let it back up, leaving the
  // bottom of the card — and the UI pinned to it — clipped for the session.
  it('does not ratchet downward across repeated fits', () => {
    const card = responsiveBox(390, LAYOUT);
    document.body.appendChild(card);

    fitReel(card, 780);   // chrome hidden
    fitReel(card, 500);   // keyboard up
    fitReel(card, 780);   // keyboard down again

    expect(card.style.maxHeight).toBe('780px');
  });

  it('releases a card that no longer needs clamping at all', () => {
    const card = responsiveBox(390, LAYOUT);
    document.body.appendChild(card);

    fitReel(card, 600);
    expect(card.style.maxHeight).toBe('600px');

    // Rotated, or the chrome went away: the card fits on its own now.
    expect(fitReel(card, 900)).toBe(0);
    expect(card.style.maxHeight).toBe('');
    expect(card.style.minHeight).toBe('');
    expect(card.hasAttribute('data-bouncer-fit')).toBe(false);
  });

  it('re-fits descendants too, not just the card', () => {
    const card = responsiveBox(390, LAYOUT);
    const inner = responsiveBox(390, LAYOUT);
    card.appendChild(inner);
    document.body.appendChild(card);

    fitReel(card, 500);
    fitReel(card, 780);

    expect(card.style.maxHeight).toBe('780px');
    expect(inner.style.maxHeight).toBe('780px');
  });
});

describe('measuring the room', () => {
  /** Pretend something is stacked at the bottom-centre of the screen, which is
   *  how bottomChromeTop asks its question. happy-dom has no hit-testing. */
  function withBottomStack<T>(els: Element[], run: () => T): T {
    const doc = document as Document & { elementsFromPoint?: (x: number, y: number) => Element[] };
    const original = doc.elementsFromPoint;
    doc.elementsFromPoint = () => els;
    try {
      return run();
    } finally {
      if (original) doc.elementsFromPoint = original;
      else delete doc.elementsFromPoint;
    }
  }

  /** Instagram's Home/Reels navigation: pinned, full width, short. */
  function navBar(view: number, height = 45): HTMLElement {
    const bar = box(390, height, view - height);
    bar.style.position = 'fixed';
    document.body.appendChild(bar);
    return bar;
  }

  // `innerHeight` is what CSS thinks you can see; visualViewport is what you
  // can. The gap between them is the entire subject of this file.
  it('prefers the visual viewport over the layout one', () => {
    expect(withVisible(720, () => visibleHeight())).toBe(720);
  });

  // THE REGRESSION THIS GUARDS. The room used to be the viewport less a flat
  // 84px, held back for chrome JavaScript supposedly could not see. But the
  // thing at the foot of a reel is Instagram's own nav bar, which it can see —
  // and Instagram already ends its cards above it. The constant shrank cards
  // the page had sized correctly, and what it bought was a white band between
  // the reel and the nav bar with the caption sliced mid-letter above it.
  it('holds nothing back when nothing is pinned over the page', () => {
    expect(withVisible(664, () => visibleHeight())).toBe(664);
  });

  it('stops at the top of a bar pinned across the bottom', () => {
    const room = withVisible(664, () =>
      withBottomStack([navBar(664)], () => visibleHeight()));
    expect(room).toBe(664 - 45);
  });

  it('does not mistake the reel behind the bar for the bar', () => {
    // The stack at the bottom-centre holds the card too — full height, and not
    // pinned chrome however it is positioned.
    const card = box(390, 664, 0);
    card.style.position = 'fixed';
    document.body.appendChild(card);
    const room = withVisible(664, () => withBottomStack([card], () => visibleHeight()));
    expect(room).toBe(664);
  });

  it('ignores our own surfaces in the stack', () => {
    const glass = navBar(664);
    glass.id = 'bouncer-ig-glass';
    const room = withVisible(664, () => withBottomStack([glass], () => visibleHeight()));
    expect(room).toBe(664);
  });

  // Whatever the reserve is, it has to be the same number the clamp uses, or
  // the reel is sized against one budget and measured against another.
  it('sizes a reel to the room it reports', () => {
    const card = box(390, LAYOUT);
    document.body.appendChild(card);
    const room = withVisible(720, () => {
      fitReels([card]);
      return visibleHeight();
    });
    expect(card.style.maxHeight).toBe(`${room}px`);
  });
});

describe('the report', () => {
  it('says whether the audio pill ended up somewhere you can see it', () => {
    const card = box(390, LAYOUT);
    const pill = document.createElement('a');
    pill.href = 'https://instagram.com/reels/audio/123/';
    pill.getBoundingClientRect = () => ({ bottom: 950, height: 40, width: 200, top: 910 }) as DOMRect;
    card.appendChild(pill);
    document.body.appendChild(card);

    expect(fitReport(card)).toContain('BELOW THE FOLD');
  });

  it('has something to say with no reel on screen', () => {
    expect(fitReport(null)).toContain('no reel to measure');
  });
});

// SEEN ON DEVICE. The card measured a perfect 621 of 621 — fitted exactly — and
// the caption line under the author row was sliced through the middle of its
// letters. "The card fits" and "you can read the card" are different claims:
// clipping the box the chrome lives in does not move the chrome, it cuts it.
describe('making room for the chrome under the video', () => {
  /** A reel: a video with an author row and a caption stacked under it, in a
   *  card whose contents want more room than the card has. */
  function reelCard(options: {
    cardHeight: number;
    contentHeight: number;
    videoHeight: number;
  }): { card: HTMLElement; video: HTMLElement } {
    const card = box(390, options.cardHeight);
    // What the content WANTS, versus what the box gives it — the gap is what
    // `overflow` is eating.
    Object.defineProperty(card, 'scrollHeight', {
      value: options.contentHeight, configurable: true,
    });
    Object.defineProperty(card, 'clientHeight', {
      value: options.cardHeight, configurable: true,
    });

    const video = document.createElement('video');
    video.getBoundingClientRect = () => {
      const capped = parseInt(video.style.maxHeight || '', 10);
      const h = Number.isFinite(capped) ? Math.min(options.videoHeight, capped) : options.videoHeight;
      return { width: 390, height: h, top: 0, bottom: h, left: 0, right: 390,
               x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
    };
    card.appendChild(video);
    document.body.appendChild(card);
    return { card, video };
  }

  it('takes the clipped pixels off the video', () => {
    // 40px of content has nowhere to go.
    const { card, video } = reelCard({ cardHeight: 621, contentHeight: 661, videoHeight: 560 });
    fitReel(card, 621);
    expect(video.style.maxHeight).toBe('520px');   // 560 - 40
  });

  it('does nothing when the content already fits', () => {
    const { card, video } = reelCard({ cardHeight: 621, contentHeight: 621, videoHeight: 560 });
    fitReel(card, 621);
    expect(video.getAttribute('style')).toBeNull();
  });

  // MEASURED ON DEVICE, twice, and the reason the rule changed shape twice.
  // Content wanting 936 against a 621 card is 315px clipped — and 315px is not
  // a caption, it is the comments preview and the promo blocks and everything
  // else Instagram's web reel stacks below the fold. The old floor squeezed the
  // video to half the screen chasing that; the cap that replaced it still gave
  // up the full 72 — a 660 card wanting 1252 had its video cut to 588 with
  // 592px still clipped. Either way the reel deformed and nothing was gained.
  // A shrink that cannot cure the clip buys nothing, so it is not made.
  it('leaves the video whole when shrinking could not cure the clip', () => {
    const { card, video } = reelCard({ cardHeight: 621, contentHeight: 936, videoHeight: 560 });
    fitReel(card, 621);
    expect(video.getAttribute('style')).toBeNull();
  });

  // Which is to say: a page with a fold stays a page with a fold.
  it('leaves the video at full height when the overflow is a whole page', () => {
    const { card, video } = reelCard({ cardHeight: 621, contentHeight: 2000, videoHeight: 600 });
    fitReel(card, 621);
    expect(video.getAttribute('style')).toBeNull();
  });

  it('still gives the full budget when the clip is exactly the budget', () => {
    const { card, video } = reelCard({ cardHeight: 621, contentHeight: 621 + 72, videoHeight: 560 });
    fitReel(card, 621);
    expect(video.style.maxHeight).toBe('488px');   // 560 - 72
  });

  // Same reason the clamp releases before measuring: a video capped last time
  // measures at its cap, so the shrink would compound on every re-fit until the
  // floor caught it.
  it('does not compound across repeated fits', () => {
    const { card, video } = reelCard({ cardHeight: 621, contentHeight: 661, videoHeight: 560 });
    fitReel(card, 621);
    fitReel(card, 621);
    fitReel(card, 621);
    expect(video.style.maxHeight).toBe('520px');
  });
});

// MEASURED ON DEVICE: the iOS app gets the layout that STACKS the byline and
// caption under the video, inside a card sized to the screen — a 660px card
// whose content wants 1324, video 660, and everything a person reads about the
// reel below the fold. A flat shrink bought a sliced author row; no shrink
// buried the byline entirely. The when-to-shrink question belongs to the
// pieces themselves: are the byline and caption below the card's visible
// bottom, and by how much.
describe('the layout that stacks the byline under the video', () => {
  function rectStub(el: HTMLElement, rect: { top: number; bottom: number; width?: number }): void {
    el.getBoundingClientRect = () => ({
      width: rect.width ?? 390, height: rect.bottom - rect.top,
      top: rect.top, bottom: rect.bottom, left: 0, right: rect.width ?? 390,
      x: 0, y: rect.top, toJSON: () => ({}),
    }) as DOMRect;
  }

  /** The device's card: a full-height video, then byline and caption in normal
   *  flow below the fold. */
  function stackedCard(options: { captionBottom: number }): {
    card: HTMLElement; video: HTMLElement;
  } {
    const card = document.createElement('div');
    rectStub(card, { top: 0, bottom: 660 });
    Object.defineProperty(card, 'scrollHeight', { value: 1324, configurable: true });
    Object.defineProperty(card, 'clientHeight', { value: 660, configurable: true });

    const video = document.createElement('video');
    rectStub(video, { top: 0, bottom: 660 });
    card.appendChild(video);

    const byline = document.createElement('a');
    byline.href = '/someone/reels/';
    byline.appendChild(document.createElement('img'));
    rectStub(byline, { top: 668, bottom: 700, width: 120 });
    card.appendChild(byline);

    const caption = document.createElement('div');
    caption.setAttribute('dir', 'auto');
    caption.textContent = 'a caption long enough to be the caption';
    rectStub(caption, { top: 708, bottom: options.captionBottom });
    card.appendChild(caption);

    document.body.appendChild(card);
    return { card, video };
  }

  it('shrinks the video by exactly what the buried pieces need', () => {
    const { card, video } = stackedCard({ captionBottom: 748 });
    fitReel(card, 660);
    // Deepest buried piece ends at 748, fold at 660: 88px lifts it clear.
    expect(video.style.maxHeight).toBe('572px');
  });

  // A piece deeper than the budget could ever lift is not a sliced row — it is
  // another layer of the page, and it must not count toward the rescue. Only
  // the byline (40px down, liftable) is paid for here.
  it('ignores a piece buried deeper than the budget could lift', () => {
    const { card, video } = stackedCard({ captionBottom: 1200 });
    fitReel(card, 660);
    expect(video.style.maxHeight).toBe('620px');   // byline's 40px, nothing more
  });

  // MEASURED ON DEVICE, and the regression this guards. The card carries a
  // DUPLICATE of the byline and caption a full viewport below the fold (byline
  // 1062..1094 against a fold of 660) while the copy the user reads is a
  // position:fixed overlay outside the card. Rescuing the duplicate squeezed
  // the playing video 180px up its slide — "you've held the captions in place
  // but moved the video too high" — while fixing nothing, because the visible
  // captions were never the card's.
  it('leaves the video whole when only the duplicate layer is buried', () => {
    const { card, video } = stackedCard({ captionBottom: 1120 });
    const links = card.querySelectorAll('a');
    rectStub(links[0] as HTMLElement, { top: 1062, bottom: 1094, width: 120 });
    rectStub(card.querySelector('[dir="auto"]') as HTMLElement, { top: 1102, bottom: 1120 });
    fitReel(card, 660);
    expect(video.getAttribute('style')).toBeNull();
    // The clip still stands: the duplicate must not paint over the next reel.
    expect(card.style.overflowY).toBe('clip');
  });

  it('clips the card so the leftover stack cannot paint over the next reel', () => {
    const { card } = stackedCard({ captionBottom: 748 });
    fitReel(card, 660);
    expect(card.style.overflowY).toBe('clip');
  });

  it('does not shrink when the byline and caption already sit on the video', () => {
    const { card, video } = stackedCard({ captionBottom: 748 });
    // Overlay layout: same elements, above the fold.
    const links = card.querySelectorAll('a');
    rectStub(links[0] as HTMLElement, { top: 582, bottom: 614, width: 120 });
    rectStub(card.querySelector('[dir="auto"]') as HTMLElement, { top: 622, bottom: 640 });
    fitReel(card, 660);
    expect(video.getAttribute('style')).toBeNull();
  });

  it('hands the clip back with everything else', () => {
    const { card } = stackedCard({ captionBottom: 748 });
    fitReel(card, 660);
    unfitAll();
    expect(card.style.overflowY).toBe('');
    expect(card.hasAttribute('data-bouncer-fit')).toBe(false);
  });
});

// SEEN ON DEVICE, in the screenshot that finally settled it. The byline,
// caption and audio pill a person reads are pinned in a position:fixed layer on
// the VIEWPORT, outside every card — and on the iOS app that layer is sized to
// the full 705px layout viewport while the visible area ends at 660, so its
// bottom-anchored caption line is sliced through its letters just above the
// nav bar. No card-level fitting can reach it; this is the layer's own fix.
describe('the viewport-pinned UI layer', () => {
  const VIEW = 705;

  function withStack<T>(els: Element[], run: () => T): T {
    const doc = document as Document & { elementsFromPoint?: (x: number, y: number) => Element[] };
    const original = doc.elementsFromPoint;
    doc.elementsFromPoint = () => els;
    try {
      return run();
    } finally {
      if (original) doc.elementsFromPoint = original;
      else delete doc.elementsFromPoint;
    }
  }

  /** Instagram's bottom nav: what pins the visible area to 660 of 705. */
  function navBar(): HTMLElement {
    const bar = document.createElement('div');
    bar.style.position = 'fixed';
    bar.getBoundingClientRect = () => ({
      width: 390, height: 45, top: 660, bottom: 705, left: 0, right: 390,
      x: 0, y: 660, toJSON: () => ({}),
    }) as DOMRect;
    document.body.appendChild(bar);
    return bar;
  }

  /** A pinned layer that honors a max-height clamp, like the real one. */
  function overlay(options: { top: number; natural: number }): HTMLElement {
    const el = document.createElement('div');
    el.style.position = 'fixed';
    el.getBoundingClientRect = () => {
      const capped = parseInt(el.style.maxHeight || '', 10);
      const height = Number.isFinite(capped) ? Math.min(options.natural, capped) : options.natural;
      return {
        width: 390, height, top: options.top, bottom: options.top + height,
        left: 0, right: 390, x: 0, y: options.top, toJSON: () => ({}),
      } as DOMRect;
    };
    document.body.appendChild(el);
    return el;
  }

  function fitWith(els: Element[]): void {
    window.innerHeight = VIEW;
    withVisible(VIEW, () => withStack([...els, navBar()], () => fitReels([])));
  }

  // A translate rather than a height clamp, and the difference was visible on
  // device: clamping the box only moves children anchored to its bottom edge,
  // and this layer positions its rows with top offsets — the box shrank and
  // the caption stayed under the nav bar. Moving the rendered layer moves its
  // rows however they are positioned.
  it('lifts a layer sized to the layout viewport back into the visible area', () => {
    const layer = overlay({ top: 0, natural: 705 });
    fitWith([layer]);
    expect(layer.style.transform).toBe('translateY(-45px)');
    expect(layer.style.maxHeight).toBe('');
  });

  it('lifts a bottom-anchored layer whose clamp cannot move its bottom', () => {
    const layer = overlay({ top: 45, natural: 660 });
    fitWith([layer]);
    expect(layer.style.transform).toBe('translateY(-45px)');
  });

  it('never touches the layer holding the reel itself', () => {
    const scroller = overlay({ top: 0, natural: 705 });
    scroller.appendChild(document.createElement('video'));
    fitWith([scroller]);
    expect(scroller.getAttribute('style')).toBe('position: fixed;');
  });

  it('never touches a dialog', () => {
    const sheet = overlay({ top: 0, natural: 705 });
    sheet.setAttribute('role', 'dialog');
    fitWith([sheet]);
    expect(sheet.style.maxHeight).toBe('');
  });

  it('leaves a layer that already fits alone', () => {
    const layer = overlay({ top: 0, natural: 660 });
    fitWith([layer]);
    expect(layer.style.maxHeight).toBe('');
    expect(layer.style.transform).toBe('');
  });

  it('re-measures rather than ratcheting across refits', () => {
    const layer = overlay({ top: 0, natural: 705 });
    fitWith([layer]);
    fitWith([layer]);
    expect(layer.style.transform).toBe('translateY(-45px)');
  });

  // On the layout where the UI layer is an ABSOLUTE sibling of the slides
  // inside the fixed scroller, neither hit-testing (the stack is stubbed
  // empty of it) nor a fixed-only walk reaches it — the byline walk must stop
  // at the first screen-sized ancestor whatever its position.
  it('lifts an absolute layer found through its byline', () => {
    const layer = overlay({ top: 0, natural: 705 });
    layer.style.position = 'absolute';
    const byline = document.createElement('a');
    byline.href = '/someone/reels/';
    byline.appendChild(document.createElement('img'));
    layer.appendChild(byline);
    window.innerHeight = VIEW;
    withVisible(VIEW, () => withStack([navBar()], () => fitReels([])));
    expect(layer.style.transform).toBe('translateY(-45px)');
  });

  // The other byline copy — the below-fold duplicate inside a reel card —
  // must never lead anywhere: walking up from it reaches the card's own
  // caption stack, and lifting THAT would drag it over the video.
  it('never follows the in-card duplicate byline', () => {
    const card = box(390, 660);
    card.appendChild(document.createElement('video'));
    const stack = overlay({ top: 660, natural: 664 });
    stack.style.position = 'absolute';
    const dup = document.createElement('a');
    dup.href = '/someone/reels/';
    dup.appendChild(document.createElement('img'));
    stack.appendChild(dup);
    card.appendChild(stack);
    document.body.appendChild(card);
    window.innerHeight = VIEW;
    withVisible(VIEW, () => withStack([navBar()], () => fitReels([card])));
    expect(stack.style.transform).toBe('');
  });

  it('gives the layer back what it had', () => {
    const layer = overlay({ top: 45, natural: 660 });
    fitWith([layer]);
    unfitAll();
    expect(layer.style.transform).toBe('');
    expect(layer.hasAttribute('data-bouncer-fit')).toBe(false);
  });

  // A layer that turns pointer-events off is invisible to hit-testing — and a
  // UI layer floating over a video does exactly that, so taps reach the reel.
  // The byline it carries is the way back to it.
  it('finds a layer hit-testing misses through its byline', () => {
    const layer = overlay({ top: 45, natural: 660 });
    const byline = document.createElement('a');
    byline.href = '/someone/reels/';
    byline.appendChild(document.createElement('img'));
    layer.appendChild(byline);
    window.innerHeight = VIEW;
    // The stub stack holds only the nav bar: the layer is NOT hit-testable.
    withVisible(VIEW, () => withStack([navBar()], () => fitReels([])));
    expect(layer.style.transform).toBe('translateY(-45px)');
  });
});
