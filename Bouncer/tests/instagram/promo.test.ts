/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { dismissAppPromos, reportAppPromos } from '../../src/instagram/promo';

const SCREEN_H = 800;
const SCREEN_W = 390;

/** A pinned bar across the foot of the screen, the shape Instagram's is. */
function banner(text: string, options: {
  position?: string;
  height?: number;
  width?: number;
  bottom?: number;
} = {}): HTMLElement {
  const el = document.createElement('div');
  const height = options.height ?? 60;
  const width = options.width ?? SCREEN_W;
  const bottom = options.bottom ?? SCREEN_H;
  el.style.position = options.position ?? 'fixed';
  el.textContent = text;
  el.getBoundingClientRect = () => ({
    width, height, bottom, top: bottom - height, left: 0, right: width,
    x: 0, y: bottom - height, toJSON: () => ({}),
  }) as DOMRect;
  document.body.appendChild(el);
  return el;
}

function closeButton(parent: HTMLElement, label = 'Close'): HTMLElement {
  const button = document.createElement('button');
  button.setAttribute('aria-label', label);
  parent.appendChild(button);
  return button;
}

beforeEach(() => {
  document.body.replaceChildren();
  window.innerHeight = SCREEN_H;
  window.innerWidth = SCREEN_W;
});

describe('the "use the app" bar', () => {
  // Closed, not deleted: Instagram remembers a dismissal and stops offering.
  // Something merely hidden comes back on the next route, forever.
  it('clicks the close button rather than deleting the bar', () => {
    const bar = banner('Use the app to see more');
    const close = closeButton(bar);
    const clicked = vi.fn();
    close.addEventListener('click', clicked);

    expect(dismissAppPromos()).toBe(1);
    expect(clicked).toHaveBeenCalledTimes(1);
    expect(bar.style.display).toBe('');       // still there — Instagram's to remove
  });

  it('hides one with nothing to click', () => {
    const bar = banner('Open the Instagram app');
    expect(dismissAppPromos()).toBe(1);
    expect(bar.style.display).toBe('none');
  });

  it('takes the label off the svg and clicks the button around it', () => {
    const bar = banner('See more on the app');
    const button = document.createElement('button');
    const glyph = document.createElement('span');
    glyph.setAttribute('aria-label', 'Close');
    button.appendChild(glyph);
    bar.appendChild(button);
    const clicked = vi.fn();
    button.addEventListener('click', clicked);

    dismissAppPromos();
    expect(clicked).toHaveBeenCalledTimes(1);
  });

  it('recognises a "Not now" refusal', () => {
    const bar = banner('Get the app for a better experience');
    const button = document.createElement('button');
    button.textContent = 'Not now';
    bar.appendChild(button);
    const clicked = vi.fn();
    button.addEventListener('click', clicked);

    dismissAppPromos();
    expect(clicked).toHaveBeenCalledTimes(1);
  });

  it('deals with each bar once', () => {
    banner('Use the app');
    expect(dismissAppPromos()).toBe(1);
    expect(dismissAppPromos()).toBe(0);
  });
});

// Three things have to be true at once, and each of these has only two.
describe('what it leaves alone', () => {
  it('a caption that happens to mention the app', () => {
    const caption = banner('honestly you should use the app for this one lol', {
      position: 'static',
    });
    expect(dismissAppPromos()).toBe(0);
    expect(caption.style.display).toBe('');
  });

  it('Instagram\'s own pinned navigation', () => {
    const nav = banner('HomeSearchReelsProfile');
    expect(dismissAppPromos()).toBe(0);
    expect(nav.style.display).toBe('');
  });

  it('a pinned thing that is most of the screen', () => {
    const sheet = banner('Open the app', { height: 600 });
    expect(dismissAppPromos()).toBe(0);
    expect(sheet.style.display).toBe('');
  });

  it('a pinned thing nowhere near the bottom', () => {
    const header = banner('Open the app', { height: 60, bottom: 60 });
    expect(dismissAppPromos()).toBe(0);
    expect(header.style.display).toBe('');
  });

  it('a long block of prose containing the phrase', () => {
    const wall = banner(`Open the app. ${'and then some more text '.repeat(20)}`);
    expect(dismissAppPromos()).toBe(0);
    expect(wall.style.display).toBe('');
  });

  it('our own surfaces', () => {
    const ours = banner('Use the app');
    ours.id = 'bouncer-ig-glass';
    expect(dismissAppPromos()).toBe(0);
    expect(ours.style.display).toBe('');
  });
});

/** A centred modal asking the same question, the shape Instagram's interstitial
 *  is: explicitly a dialog, most of the screen but not all of it. */
function dialog(text: string, options: { height?: number; role?: string } = {}): HTMLElement {
  const el = document.createElement('div');
  const height = options.height ?? 420;
  const top = (SCREEN_H - height) / 2;
  el.style.position = 'fixed';
  el.setAttribute('role', options.role ?? 'dialog');
  el.textContent = text;
  el.getBoundingClientRect = () => ({
    width: SCREEN_W, height, bottom: top + height, top, left: 0, right: SCREEN_W,
    x: 0, y: top, toJSON: () => ({}),
  }) as DOMRect;
  document.body.appendChild(el);
  return el;
}

describe('the "use the app" modal', () => {
  it('closes a centred dialog that a bottom-bar test would miss', () => {
    const el = dialog('Open in the app');
    const close = closeButton(el);
    const clicked = vi.fn();
    close.addEventListener('click', clicked);

    expect(dismissAppPromos()).toBe(1);
    expect(clicked).toHaveBeenCalled();
  });

  it('accepts an alertdialog, and a dialog role on a child', () => {
    const outer = dialog('Continue in the app', { role: 'alertdialog' });
    closeButton(outer);
    expect(dismissAppPromos()).toBe(1);
  });

  // Hiding it would take the backdrop and scroll lock with it and leave the
  // page inert — worse than the dialog, and harder to explain.
  it('leaves a dialog it cannot close alone', () => {
    const el = dialog('Get the app');
    expect(dismissAppPromos()).toBe(0);
    expect(el.style.display).toBe('');
    expect(el.dataset.bouncerPromo).toBeUndefined();
  });

  // The interstitial after onboarding: full-screen, so not a bar, and taller
  // than a dialog has any business being, so not a dialog either. It was the
  // first thing anyone saw and nothing touched it. Pressing the page's own
  // close button is safe at any size — the size rules exist to stop us HIDING
  // something structural, which is a different act.
  it('clicks the close button on a full-page takeover', () => {
    const el = dialog('Open in the app', { height: SCREEN_H });
    const close = closeButton(el);
    const clicked = vi.fn();
    close.addEventListener('click', clicked);

    expect(dismissAppPromos()).toBe(1);
    expect(clicked).toHaveBeenCalled();
    expect(el.style.display).toBe('');    // clicked, never hidden
  });

  it('still leaves a full-page takeover it cannot close alone', () => {
    const el = dialog('Open in the app', { height: SCREEN_H });
    expect(dismissAppPromos()).toBe(0);
    expect(el.style.display).toBe('');
  });

  it('still ignores a dialog that is not about the app', () => {
    const el = dialog('Log in to continue');
    closeButton(el);
    expect(dismissAppPromos()).toBe(0);
  });
});

describe('the per-reel "watch this in the app" prompt', () => {
  // Offered per reel rather than per session, so it returns on every route
  // change — the one a user meets immediately on arriving at /reels/.
  it('closes "Watch this reel in the app"', () => {
    const el = banner('Watch this reel in the app');
    const close = closeButton(el);
    const clicked = vi.fn();
    close.addEventListener('click', clicked);

    expect(dismissAppPromos()).toBe(1);
    expect(clicked).toHaveBeenCalled();
  });

  it('closes the same offer worded for video, and as a dialog', () => {
    expect(dismissAppPromos()).toBe(0);
    banner('Watch videos in the Instagram app');
    expect(dismissAppPromos()).toBe(1);
  });

  it('still leaves a caption mentioning reels alone', () => {
    banner('this reel is about my trip to the app store');
    expect(dismissAppPromos()).toBe(0);
  });
});

// "It's still there" is the same sentence whichever of the four tests it fell
// at. This turns it into a number.
describe('reporting what survived', () => {
  it('says nothing when the page has no app promo on it', () => {
    banner('HomeSearchReelsProfile');
    expect(reportAppPromos()).toContain('nothing on the page mentions the app');
  });

  it('names the test a promo fell at', () => {
    banner('Watch this reel in the app', { position: 'static' });
    const report = reportAppPromos();
    expect(report).toContain('position:static');
    expect(report).toContain('Watch this reel in the app');
  });

  it('reports a bar that is too tall, with both numbers', () => {
    banner('Open the app', { height: 600 });
    const report = reportAppPromos();
    expect(report).toMatch(/height 600 > bar max \d+/);
  });

  it('flags one that has no close control', () => {
    banner('Use the app');
    expect(reportAppPromos()).toContain('close=NO');
  });

  it('marks one it already dealt with', () => {
    const bar = banner('Use the app');
    closeButton(bar);
    dismissAppPromos();
    expect(reportAppPromos()).toContain('ALREADY HANDLED');
  });
});

// MEASURED ON DEVICE. The one that survived everything was not a bar and not a
// dialog: two `position: relative` spans sitting inside the reel, mid-screen,
// with no close control anywhere near them. Every rule asked about pinned
// chrome, so it was never a candidate.
describe('promo copy sitting inside the reel', () => {
  /** A card of promo text in normal flow, the shape Instagram's is. */
  function inReelPromo(lines: string[]): HTMLElement {
    const card = document.createElement('div');
    card.style.position = 'relative';
    card.getBoundingClientRect = () => ({
      width: 250, height: 96, top: 265, bottom: 361, left: 70, right: 320,
      x: 70, y: 265, toJSON: () => ({}),
    }) as DOMRect;
    for (const line of lines) {
      const span = document.createElement('span');
      span.textContent = line;
      span.style.position = 'relative';
      card.appendChild(span);
    }
    document.body.appendChild(card);
    return card;
  }

  it('hides the card the words live in', () => {
    const card = inReelPromo([
      'Watch this reel in the app',
      'Use the app to view all comments and discover more reels.',
    ]);
    expect(dismissAppPromos()).toBeGreaterThan(0);
    expect(card.style.display).toBe('none');
  });

  // The walk up stops at the last box whose text is still only the promo —
  // which is what makes hiding safe. An ancestor holding the reel as well must
  // never be taken with it.
  it('never climbs into something holding the reel', () => {
    const reel = document.createElement('div');
    const video = document.createElement('video');
    reel.appendChild(video);
    const promo = document.createElement('span');
    promo.textContent = 'Watch this reel in the app';
    promo.getBoundingClientRect = () => ({
      width: 250, height: 40, top: 265, bottom: 305, left: 70, right: 320,
      x: 70, y: 265, toJSON: () => ({}),
    }) as DOMRect;
    reel.appendChild(promo);
    document.body.appendChild(reel);

    dismissAppPromos();
    expect(reel.style.display).toBe('');
    expect(video.isConnected).toBe(true);
  });
});

// After a sweep the log showed all three matches at 0x0 with the popup still on
// screen and visibly SMALLER: the words had gone and the shell they sat in —
// backdrop, buttons, the X in its corner — had not. A promo is not its
// sentence, and the control that dismisses it never belongs to the span
// carrying the text.
describe('pressing the popup\'s own X', () => {
  /** A modal: an X in the corner, a heading, a line of copy. */
  function modal(): { root: HTMLElement; x: HTMLElement } {
    const root = document.createElement('div');
    root.style.position = 'fixed';
    root.getBoundingClientRect = () => ({
      width: 320, height: 260, top: 220, bottom: 480, left: 36, right: 356,
      x: 36, y: 220, toJSON: () => ({}),
    }) as DOMRect;

    const x = document.createElement('div');
    x.setAttribute('role', 'button');
    const glyph = document.createElement('span');
    glyph.setAttribute('aria-label', 'Close');
    x.appendChild(glyph);
    root.appendChild(x);

    const body = document.createElement('div');
    const title = document.createElement('span');
    title.textContent = 'Watch this reel in the app';
    const copy = document.createElement('span');
    copy.textContent = 'Use the app to view all comments and discover more reels.';
    body.appendChild(title);
    body.appendChild(copy);
    root.appendChild(body);

    document.body.appendChild(root);
    return { root, x };
  }

  it('clicks the X rather than hiding the words inside it', () => {
    const { root, x } = modal();
    const clicked = vi.fn();
    x.addEventListener('click', clicked);

    expect(dismissAppPromos()).toBeGreaterThan(0);
    expect(clicked).toHaveBeenCalled();
    // Left standing for Instagram to remove: pressing its own control is the
    // whole point, and hiding on top of that would fight its animation.
    expect(root.style.display).toBe('');
  });

  it('presses it once, not once per line of copy', () => {
    const { x } = modal();
    const clicked = vi.fn();
    x.addEventListener('click', clicked);

    dismissAppPromos();
    dismissAppPromos();
    expect(clicked).toHaveBeenCalledTimes(1);
  });

  // The comments sheet has an X too, and closing that instead would be a worse
  // bug than the one being fixed.
  it('will not reach into the reel for a control', () => {
    const reel = document.createElement('div');
    reel.style.position = 'fixed';
    const video = document.createElement('video');
    const closeReel = document.createElement('button');
    closeReel.setAttribute('aria-label', 'Close');
    const clicked = vi.fn();
    closeReel.addEventListener('click', clicked);
    reel.appendChild(video);
    reel.appendChild(closeReel);

    const promo = document.createElement('span');
    promo.textContent = 'Watch this reel in the app';
    promo.getBoundingClientRect = () => ({
      width: 250, height: 40, top: 265, bottom: 305, left: 70, right: 320,
      x: 70, y: 265, toJSON: () => ({}),
    }) as DOMRect;
    reel.appendChild(promo);
    document.body.appendChild(reel);

    dismissAppPromos();
    expect(clicked).not.toHaveBeenCalled();
  });
});

// The one that actually greets you, photographed on device: the Instagram logo,
// an "Open Instagram" button, a "Sign up" link, over a dimmed backdrop with an X
// in its corner. Not one word of it is "app" — which is what every pattern had
// been written around — so it was never a candidate for any rule.
describe('the "Open Instagram" interstitial', () => {
  /** Backdrop with the X, holding a card with the buttons: the real shape,
   *  where the close control is a SIBLING of the card rather than inside it. */
  function interstitial(): { root: HTMLElement; x: HTMLElement; card: HTMLElement } {
    const root = document.createElement('div');
    root.style.position = 'fixed';
    root.getBoundingClientRect = () => ({
      width: SCREEN_W, height: SCREEN_H, top: 0, bottom: SCREEN_H, left: 0, right: SCREEN_W,
      x: 0, y: 0, toJSON: () => ({}),
    }) as DOMRect;

    const x = document.createElement('button');
    x.setAttribute('aria-label', 'Close');
    root.appendChild(x);

    const card = document.createElement('div');
    card.getBoundingClientRect = () => ({
      width: 300, height: 380, top: 240, bottom: 620, left: 45, right: 345,
      x: 45, y: 240, toJSON: () => ({}),
    }) as DOMRect;
    const open = document.createElement('button');
    open.textContent = 'Open Instagram';
    const signup = document.createElement('a');
    signup.textContent = 'Sign up';
    card.appendChild(open);
    card.appendChild(signup);
    root.appendChild(card);

    document.body.appendChild(root);
    return { root, x, card };
  }

  it('presses the X on the backdrop, not something inside the card', () => {
    const { x } = interstitial();
    const clicked = vi.fn();
    x.addEventListener('click', clicked);

    expect(dismissAppPromos()).toBeGreaterThan(0);
    expect(clicked).toHaveBeenCalledTimes(1);
  });

  // It must never press "Open Instagram" itself — that is the button whose
  // whole purpose is to leave.
  it('never presses the button that opens the app', () => {
    const { card } = interstitial();
    const open = card.querySelector('button')!;
    const opened = vi.fn();
    open.addEventListener('click', opened);

    dismissAppPromos();
    expect(opened).not.toHaveBeenCalled();
  });

  it('still leaves a caption that merely says the words', () => {
    banner('you should open instagram on your phone for this one', { position: 'static' });
    expect(dismissAppPromos()).toBe(0);
  });
});

// MEASURED ON THE LIVE PAGE, and the reason the climb got deeper. On the
// logged-out reels interstitial the X hangs off the full-screen fixed overlay
// TEN levels above "Watch this reel in the app": words in a card, card in a
// centring stack, stack in the overlay, every layer a bare div. A six-level
// climb stopped mid-stack and found nothing; the fallback then hid the words,
// and the shell — backdrop, logo, X — stood on screen wordless. The reel's own
// <video> lives in a SIBLING branch of the overlay's parent, which is what the
// video guard must stop at without stopping the climb short of the X.
describe('the deeply-nested reels interstitial', () => {
  function deepInterstitial(): { overlay: HTMLElement; x: HTMLElement; open: HTMLElement } {
    const mount = document.createElement('div');       // holds reel AND overlay

    const reel = document.createElement('div');
    reel.appendChild(document.createElement('video'));
    const caption = document.createElement('span');
    caption.textContent = 'a caption long enough that the mount is plainly the page: '
      + 'lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod.';
    reel.appendChild(caption);
    mount.appendChild(reel);

    const overlay = document.createElement('div');     // 390x664 fixed, textlen 109
    overlay.style.position = 'fixed';
    overlay.getBoundingClientRect = () => ({
      width: SCREEN_W, height: SCREEN_H, top: 0, bottom: SCREEN_H, left: 0, right: SCREEN_W,
      x: 0, y: 0, toJSON: () => ({}),
    }) as DOMRect;
    const x = document.createElement('button');
    x.setAttribute('aria-label', 'Close');
    overlay.appendChild(x);

    // The centring stack between the overlay and the words: bare divs all the
    // way down, as many as the live page has.
    let level: HTMLElement = overlay;
    for (let i = 0; i < 7; i++) {
      const wrap = document.createElement('div');
      level.appendChild(wrap);
      level = wrap;
    }
    const heading = document.createElement('span');
    heading.textContent = 'Watch this reel in the app';
    const copy = document.createElement('span');
    copy.textContent = 'Use the app to view all comments and discover more reels.';
    level.appendChild(heading);
    level.appendChild(copy);

    const buttons = document.createElement('div');
    const open = document.createElement('a');
    open.textContent = 'Open Instagram';
    buttons.appendChild(open);
    level.appendChild(buttons);

    mount.appendChild(overlay);
    document.body.appendChild(mount);
    return { overlay, x, open };
  }

  it('climbs all the way to the overlay\'s X and presses it once', () => {
    const { x } = deepInterstitial();
    const clicked = vi.fn();
    x.addEventListener('click', clicked);

    dismissAppPromos();
    expect(clicked).toHaveBeenCalledTimes(1);
  });

  it('leaves the overlay for Instagram to take down', () => {
    const { overlay } = deepInterstitial();
    dismissAppPromos();
    expect(overlay.style.display).toBe('');
  });

  it('never presses "Open Instagram" on the way up', () => {
    const { open } = deepInterstitial();
    const opened = vi.fn();
    open.addEventListener('click', opened);
    dismissAppPromos();
    expect(opened).not.toHaveBeenCalled();
  });
});
