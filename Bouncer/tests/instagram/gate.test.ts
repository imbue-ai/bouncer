/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { installReelGate, isControlSized, type ReelGate } from '../../src/instagram/gate';
import { noteDuration } from '../../src/instagram/durations';

const OVERLAY_ID = 'bouncer-ig-paused';

let gate: ReelGate | null = null;
// Reels the describer has "discovered" — the gate only holds video in these.
let owned = new Set<HTMLVideoElement>();
let otherSurface = false;

function install(): ReelGate {
  return installReelGate({
    onSettings: vi.fn(),
    ownsVideo: (video) => owned.has(video),
    otherSurfaceUp: () => otherSurface,
  });
}

/** A reel card with a stubbed <video>: happy-dom has the element but not the
 *  playback, so play/pause are spies and `duration` is defined on the instance. */
function makeCard(opts: { duration?: number; owned?: boolean } = {}): {
  card: HTMLElement;
  video: HTMLVideoElement;
  play: ReturnType<typeof vi.fn>;
  pause: ReturnType<typeof vi.fn>;
} {
  const card = document.createElement('div');
  const video = document.createElement('video');
  const play = vi.fn().mockResolvedValue(undefined);
  const pause = vi.fn();
  video.play = play as unknown as HTMLVideoElement['play'];
  video.pause = pause as unknown as HTMLVideoElement['pause'];
  Object.defineProperty(video, 'duration', {
    value: opts.duration ?? NaN,
    configurable: true,
  });
  card.appendChild(video);
  document.body.appendChild(card);
  if (opts.owned !== false) owned.add(video);
  return { card, video, play, pause };
}

function overlay(): HTMLElement | null {
  return document.getElementById(OVERLAY_ID);
}

const AT = { clientX: 100, clientY: 200, bubbles: true, isPrimary: true };

/** A quick press and release in one place — the sound gesture. */
function tap(target: Element): void {
  target.dispatchEvent(new PointerEvent('pointerdown', AT));
  target.dispatchEvent(new PointerEvent('pointerup', AT));
}

/** A press held past the one-second threshold — the playback gesture. Requires
 *  fake timers, since that second is what distinguishes it from a tap. */
function hold(target: Element, ms = 1000): void {
  target.dispatchEvent(new PointerEvent('pointerdown', AT));
  vi.advanceTimersByTime(ms);
  target.dispatchEvent(new PointerEvent('pointerup', AT));
}

/** A press that travels — a scroll, which must do nothing at all. */
function drag(target: Element): void {
  target.dispatchEvent(new PointerEvent('pointerdown', AT));
  target.dispatchEvent(new PointerEvent('pointermove', {
    ...AT, clientY: AT.clientY - 200,
  }));
  target.dispatchEvent(new PointerEvent('pointerup', { ...AT, clientY: AT.clientY - 200 }));
}

beforeEach(() => {
  document.body.replaceChildren();
  owned = new Set();
  otherSurface = false;
  gate = install();
});

afterEach(() => {
  gate?.teardown();
  gate = null;
  vi.useRealTimers();
});

describe('isControlSized', () => {
  const VIEWPORT = 390 * 844;

  // Instagram wraps the reel surface in the same role="button" it uses for the
  // like and comment buttons, so only size separates them.
  it('calls a thumb-sized target a control', () => {
    expect(isControlSized({ width: 40, height: 40 }, VIEWPORT)).toBe(true);
  });

  it('does not call the full-bleed reel surface a control', () => {
    expect(isControlSized({ width: 390, height: 844 }, VIEWPORT)).toBe(false);
  });

  it('treats a degenerate viewport as all-controls, so a stray tap never plays', () => {
    expect(isControlSized({ width: 40, height: 40 }, 0)).toBe(true);
  });
});

describe('the autoplay gate', () => {
  it('pauses a reel that tries to start on its own', () => {
    const { video, pause } = makeCard();
    video.dispatchEvent(new Event('play'));
    expect(pause).toHaveBeenCalled();
  });

  it('keeps pausing reels other than the one released', () => {
    const a = makeCard();
    const b = makeCard();
    gate!.showCard(a.card, { thumbnailUrl: 'https://cdn/x/a.jpg', description: 'A' });
    gate!.release();

    a.pause.mockClear();
    b.pause.mockClear();
    a.video.dispatchEvent(new Event('play'));
    b.video.dispatchEvent(new Event('play'));

    expect(a.pause).not.toHaveBeenCalled();
    expect(b.pause).toHaveBeenCalled();
  });

  // Watching one reel is not standing permission for the next one.
  it('revokes the release on arrival at another reel', () => {
    const a = makeCard();
    const b = makeCard();
    gate!.showCard(a.card, { thumbnailUrl: 'https://cdn/x/a2.jpg', description: 'A' });
    gate!.release();

    gate!.hold(b.card);
    a.pause.mockClear();
    a.video.dispatchEvent(new Event('play'));
    expect(a.pause).toHaveBeenCalled();
  });

  // The reel being left has already started, so no further `play` event is
  // coming for the capture listener to catch — it has to be stopped outright.
  it('stops the reel being left rather than only un-releasing it', () => {
    const a = makeCard();
    const b = makeCard();
    gate!.showCard(a.card, { thumbnailUrl: 'https://cdn/x/a3.jpg', description: 'A' });
    gate!.release();

    a.pause.mockClear();
    gate!.hold(b.card);
    expect(a.pause).toHaveBeenCalled();
  });

  it('lets every reel play again once torn down', () => {
    const { video, pause } = makeCard();
    gate!.teardown();
    gate = null;
    video.dispatchEvent(new Event('play'));
    expect(pause).not.toHaveBeenCalled();
  });
});

// Reel discovery is heuristic, and every surface that could hand a held reel
// back to the user is downstream of it. Both guards below exist so that a
// discovery failure degrades to plain autoplay rather than to a feed of frozen
// video with no way to start it.
describe('when the machinery upstream fails', () => {
  it('never holds video the describer has not claimed', () => {
    const { video, pause } = makeCard({ owned: false });
    video.dispatchEvent(new Event('play'));
    expect(pause).not.toHaveBeenCalled();
  });

  it('stands down after holding a reel with nothing on screen to release it', () => {
    vi.useFakeTimers();
    const { video, pause } = makeCard();

    video.dispatchEvent(new Event('play'));
    expect(pause).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(3000);

    pause.mockClear();
    video.dispatchEvent(new Event('play'));
    expect(pause).not.toHaveBeenCalled();
  });

  it('keeps holding once a card is up', () => {
    vi.useFakeTimers();
    const { card, video, pause } = makeCard();

    video.dispatchEvent(new Event('play'));
    gate!.showCard(card, { thumbnailUrl: 'https://cdn/x/watchdog.jpg', description: 'x' });
    vi.advanceTimersByTime(3000);

    const other = makeCard();
    other.video.dispatchEvent(new Event('play'));
    expect(other.pause).toHaveBeenCalled();
    expect(pause).toHaveBeenCalled();
  });

  // A full-screen surface of ours has no paused card behind it, and one that
  // outlasts the watchdog must not switch the gate off.
  it('keeps holding while another surface has the screen', () => {
    vi.useFakeTimers();
    otherSurface = true;
    const { video, pause } = makeCard();

    video.dispatchEvent(new Event('play'));
    vi.advanceTimersByTime(3000);

    pause.mockClear();
    video.dispatchEvent(new Event('play'));
    expect(pause).toHaveBeenCalled();
  });
});

describe('the paused card', () => {
  it('shows the description and the length', () => {
    const { card } = makeCard();
    noteDuration('https://cdn/x/card_len.jpg', 31);
    gate!.showCard(card, {
      thumbnailUrl: 'https://cdn/x/card_len.jpg',
      description: 'Viral tomato pasta recipe',
    });

    const text = overlay()?.textContent ?? '';
    expect(text).toContain('Viral tomato pasta recipe');
    expect(text).toContain('0:31');
    // Both gestures are named on the card — neither is discoverable otherwise.
    expect(text).toContain('Hold to play');
    expect(text).toContain('Tap for sound');
  });

  it('measures the length off the mounted <video> when it has one', () => {
    const { card } = makeCard({ duration: 47 });
    gate!.showCard(card, { thumbnailUrl: 'https://cdn/x/measured.jpg', description: 'x' });
    expect(overlay()?.textContent).toContain('0:47');
  });

  // The description usually lands after the card does; a blank line would read
  // as broken, and a wrong length is worse than none.
  it('stands in for a description that has not resolved, and fills it in later', () => {
    const { card } = makeCard();
    gate!.showCard(card, { thumbnailUrl: 'https://cdn/x/pending.jpg', description: null });
    expect(overlay()?.querySelector('.bouncer-ig-skeleton')).not.toBeNull();

    gate!.setDescription(card, 'Career advice for new graduates');
    expect(overlay()?.textContent).toContain('Career advice for new graduates');
    expect(overlay()?.querySelector('.bouncer-ig-skeleton')).toBeNull();
  });

  it('ignores a description meant for a reel that is no longer on screen', () => {
    const a = makeCard();
    const b = makeCard();
    gate!.showCard(b.card, { thumbnailUrl: 'https://cdn/x/b.jpg', description: 'B' });
    gate!.setDescription(a.card, 'A — stale');
    expect(overlay()?.textContent).toContain('B');
    expect(overlay()?.textContent).not.toContain('stale');
  });

  it('drops the length rather than guessing when none is known', () => {
    const { card } = makeCard();
    gate!.showCard(card, { thumbnailUrl: 'https://cdn/x/no_length.jpg', description: 'x' });
    expect(overlay()?.textContent).toContain('Hold to play');
    expect(overlay()?.textContent).not.toMatch(/\d:\d\d/);
  });

  // A fixed overlay that accepts pointer events sits outside Instagram's scroll
  // container, and dragging on it would scroll nothing at all.
  it('lets touches through so the feed still scrolls', () => {
    const { card } = makeCard();
    gate!.showCard(card, { thumbnailUrl: 'https://cdn/x/scroll.jpg', description: 'x' });
    expect(overlay()?.style.pointerEvents).toBe('none');
  });
});

// The two gestures are split so the deliberate one can't happen by accident:
// holding for a second starts a reel, tapping only moves sound in and out.
describe('holding to play', () => {
  beforeEach(() => { vi.useFakeTimers(); });

  it('starts the reel and takes the card down', () => {
    const { card, play } = makeCard();
    gate!.showCard(card, { thumbnailUrl: 'https://cdn/x/hold.jpg', description: 'x' });

    hold(document.body);
    expect(play).toHaveBeenCalled();
  });

  it('does not start on a press let go too soon', () => {
    const { card, play } = makeCard();
    gate!.showCard(card, { thumbnailUrl: 'https://cdn/x/short.jpg', description: 'x' });

    hold(document.body, 600);
    expect(play).not.toHaveBeenCalled();
  });

  it('abandons the hold if the finger travels — that is a scroll', () => {
    const { card, play } = makeCard();
    gate!.showCard(card, { thumbnailUrl: 'https://cdn/x/scrolled.jpg', description: 'x' });

    card.dispatchEvent(new PointerEvent('pointerdown', AT));
    document.body.dispatchEvent(new PointerEvent('pointermove', { ...AT, clientY: 20 }));
    vi.advanceTimersByTime(2000);
    expect(play).not.toHaveBeenCalled();
  });

  it('leaves Instagram\'s own controls alone', () => {
    const { card, play } = makeCard();
    gate!.showCard(card, { thumbnailUrl: 'https://cdn/x/like.jpg', description: 'x' });

    const like = document.createElement('div');
    like.setAttribute('role', 'button');
    like.getBoundingClientRect = () => ({ width: 44, height: 44 }) as DOMRect;
    document.body.appendChild(like);

    hold(like);
    expect(play).not.toHaveBeenCalled();
  });

  // Same gesture both ways, and the same one Instagram itself uses to pause.
  it('stops a playing reel and brings its card back', () => {
    const { card, video, play, pause } = makeCard();
    gate!.showCard(card, { thumbnailUrl: 'https://cdn/x/toggle.jpg', description: 'Roundtrip' });

    hold(document.body);
    expect(play).toHaveBeenCalled();
    Object.defineProperty(video, 'paused', { value: false, configurable: true });

    pause.mockClear();
    play.mockClear();
    hold(document.body);

    expect(pause).toHaveBeenCalled();
    // And crucially not re-started by the pointerup retry a moment later.
    expect(play).not.toHaveBeenCalled();
    expect(overlay()?.textContent).toContain('Roundtrip');
  });

  it('does nothing while another surface has the screen', () => {
    const { card, play } = makeCard();
    gate!.showCard(card, { thumbnailUrl: 'https://cdn/x/covered.jpg', description: 'x' });
    otherSurface = true;

    hold(document.body);
    expect(play).not.toHaveBeenCalled();
  });
});

describe('tapping for sound', () => {
  it('moves sound in and out without ever starting the reel', () => {
    const { card, video, play } = makeCard();
    video.muted = true;
    gate!.showCard(card, { thumbnailUrl: 'https://cdn/x/sound.jpg', description: 'x' });

    tap(document.body);
    expect(video.muted).toBe(false);
    expect(play).not.toHaveBeenCalled();

    tap(document.body);
    expect(video.muted).toBe(true);
    expect(play).not.toHaveBeenCalled();
  });

  it('says which way it went', () => {
    const { card, video } = makeCard();
    video.muted = true;
    gate!.showCard(card, { thumbnailUrl: 'https://cdn/x/toast.jpg', description: 'x' });

    tap(document.body);
    expect(document.getElementById('bouncer-ig-sound-toast')?.textContent).toBe('Sound on');
  });

  it('ignores a drag', () => {
    const { card, video } = makeCard();
    video.muted = true;
    gate!.showCard(card, { thumbnailUrl: 'https://cdn/x/dragged.jpg', description: 'x' });

    drag(document.body);
    expect(video.muted).toBe(true);
  });

  it('does nothing before any reel has been arrived at', () => {
    const { video } = makeCard();
    video.muted = true;
    tap(document.body);
    expect(video.muted).toBe(true);
  });
});
