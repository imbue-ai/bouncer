// Reels arrive paused, and starting one takes a deliberate press.
//
// Instagram starts a reel the instant it scrolls into view, which is the whole
// mechanism the feed runs on: you are watching before you have decided to. This
// module inverts that on phone-width viewports — scrolling to a reel gets you a
// still frame with its description and length, and it plays only once you hold
// on it for a full second.
//
// THE GESTURES are split so the deliberate one can't happen by accident:
//
//   HOLD (1s)  toggles playback. Long enough that it can't be a mis-tap while
//              scrolling, with a ring that fills as you hold so the second is
//              visible rather than guessed at. Holding a playing reel pauses it
//              again and brings its card back — the same gesture both ways, and
//              the same one Instagram itself uses to pause.
//   TAP        toggles sound. The cheap gesture does the cheap, reversible
//              thing; it can never start a reel.
//
// Both suppress the `click` that follows them, so Instagram's own tap-to-play
// handler doesn't fire behind ours and undo the gate.
//
// TWO HALVES, deliberately independent:
//
//   The gate is a single capture-phase `play` listener on the document. Every
//   <video> that tries to start is paused again unless it is the one element the
//   user has released. Media events don't bubble, but they do run the capture
//   phase, so one listener at the top covers every reel Instagram mounts —
//   including the ones it starts off-screen — with no per-card bookkeeping and
//   nothing to unwire when Instagram virtualizes a card away.
//
//   The card is a fixed overlay that is `pointer-events: none` everywhere except
//   its own gear. That is load-bearing rather than cosmetic: a fixed element that
//   accepts pointer events sits outside Instagram's scroll container, so dragging
//   on it scrolls nothing and the feed becomes unscrollable. Letting touches fall
//   through keeps scrolling native, at the cost of having to recognise the
//   gestures ourselves — hence the pointer handlers below rather than a click
//   handler on the overlay.
//
// Playback starts from the hold timer, which is NOT a user gesture as far as
// WebKit is concerned. That works only because the iOS app clears
// `mediaTypesRequiringUserActionForPlayback` (see FilteredWebView.swift); the
// pointerup path retries as a gesture-backed fallback if it didn't take.

import { durationFor, formatDuration, noteDuration } from './durations';
import { makeSettingsIcon } from '../shared/utils';

const OVERLAY_ID = 'bouncer-ig-paused';
const STYLE_ID = 'bouncer-ig-paused-style';
const TOAST_ID = 'bouncer-ig-sound-toast';

const PANEL_FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';

// Under the bounce popup (…646) and the welcome tour, over the reel.
const OVERLAY_Z = 2147483639;

/** How long a press has to last to count as "play this". */
const HOLD_MS = 1000;
// Past this the finger is scrolling, not pressing, and the hold is abandoned.
const HOLD_SLOP_PX = 12;

// How long the gate will hold a reel with nothing on screen to release it
// before concluding that something upstream didn't run and standing down.
const STUCK_MS = 2500;

// Geometry of the ring that fills while you hold. r is the play glyph's radius
// less half the stroke, so the ring sits ON the button's edge.
const RING_R = 37;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_R;

/** Fraction of the viewport above which a tapped `[role=button]` is taken to be
 *  the reel surface itself rather than one of Instagram's controls. */
const CONTROL_MAX_AREA_RATIO = 0.5;

/** Instagram wraps the reel's own video surface in a `role="button"` — the same
 *  selector as the like and comment buttons beside it — so "did the press land
 *  on a control?" can't be answered by tag name alone. Size answers it: a
 *  control is a thumb-sized target, the reel surface is most of the screen.
 *
 *  Exported for tests; `viewportArea` is width * height in CSS pixels. */
export function isControlSized(
  rect: { width: number; height: number },
  viewportArea: number,
): boolean {
  if (viewportArea <= 0) return true;
  return rect.width * rect.height < viewportArea * CONTROL_MAX_AREA_RATIO;
}

export interface ReelGate {
  /** Hold this reel at a still frame. Safe to call repeatedly. */
  hold(card: HTMLElement): void;
  /** Put the description card over `card`'s reel. */
  showCard(card: HTMLElement, info: { thumbnailUrl: string; description: string | null }): void;
  /** Fill in a description that resolved after the card went up. No-op unless
   *  `card` is the one currently showing. */
  setDescription(card: HTMLElement, description: string | null): void;
  /** Take the card down without starting playback (something else is taking
   *  the screen, or the feature is being switched off). */
  hideCard(): void;
  /** Let the held reel play, and drop the card. */
  release(): void;
  /** Stop gating entirely and let every reel play again. */
  teardown(): void;
}

// ==================== State ====================

let installed = false;
let onSettings: () => void = () => { /* replaced at install */ };
// Whether a <video> belongs to a reel the describer has actually discovered,
// and whether any describer surface is currently on screen. Both are supplied
// by index.ts at install; both exist to keep the gate from acting on video it
// has no business touching — see the guards in onPlayAttempt and onPointerDown.
let ownsVideo: (video: HTMLVideoElement) => boolean = () => false;
let otherSurfaceUp: () => boolean = () => false;

// The one video allowed to play. Everything else is paused on sight.
let releasedVideo: HTMLVideoElement | null = null;

// The reel the feed is parked on, and what its card said — kept so holding a
// playing reel can pause it and put its card back without the caller's help.
let currentCard: HTMLElement | null = null;
let currentVideo: HTMLVideoElement | null = null;
let currentInfo: { thumbnailUrl: string; description: string | null } | null = null;

// The reel the card is currently describing, if any.
let cardCard: HTMLElement | null = null;
// Element handles into the mounted card, so a late description or duration can
// be dropped in without a rebuild.
let descEl: HTMLElement | null = null;
let metaEl: HTMLElement | null = null;
let ringEl: SVGCircleElement | null = null;

// Press tracking.
let pressX = 0;
let pressY = 0;
let pressLive = false;
let holdFired = false;
// Which way the hold went, so the pointerup retry below can't re-start a reel
// the very same hold just paused.
let holdAction: 'play' | 'pause' | null = null;
let holdTimer: ReturnType<typeof setTimeout> | null = null;

// Fires when a reel has been held with nothing on screen to release it.
let stuckTimer: ReturnType<typeof setTimeout> | null = null;

// ==================== Video helpers ====================

function videoOf(card: HTMLElement): HTMLVideoElement | null {
  const video = card.querySelector('video');
  return video instanceof HTMLVideoElement ? video : null;
}

function onPlayAttempt(e: Event): void {
  const video = e.target;
  if (!(video instanceof HTMLVideoElement)) return;
  if (video === releasedVideo) return;
  // Only ever hold a reel the describer has discovered. Reel discovery is
  // heuristic (Instagram's class names are hashed, so cover images are found by
  // shape — see isCoverImg in ./index.ts), and when it comes up empty this
  // listener would otherwise freeze every video on the page while no card is
  // ever raised to release them: a feed you can't play and can't escape. A gate
  // that can't identify what it's holding has to let go.
  if (!ownsVideo(video)) return;
  video.pause();
  armStuckWatchdog();
}

/** The same failure one level up: discovery worked, so the video is held, but
 *  no surface came up to offer it back — the arrival hook didn't run, or an
 *  overlay was suppressed. Rather than leave a frozen feed, the gate stands
 *  down entirely and says why. Autoplay returning is a far better failure than
 *  video that can't be started. */
function armStuckWatchdog(): void {
  if (stuckTimer !== null || cardCard !== null || otherSurfaceUp()) return;
  stuckTimer = setTimeout(() => {
    stuckTimer = null;
    if (cardCard !== null || otherSurfaceUp()) return;   // a surface arrived after all
    console.warn(
      `[Bouncer IG] autoplay gate held a reel for ${STUCK_MS}ms with nothing on `
      + 'screen to release it — standing down so the feed still plays. The '
      + 'arrival hook never ran; see the discovery report above.');
    teardown();
  }, STUCK_MS);
}

function clearStuckWatchdog(): void {
  if (stuckTimer === null) return;
  clearTimeout(stuckTimer);
  stuckTimer = null;
}

// ==================== Gestures ====================

/** Swallow the click the browser synthesises after our press, so Instagram's
 *  own tap-to-play handler doesn't run behind the gesture and undo it. */
function suppressNextClick(): void {
  const swallow = (e: Event): void => {
    e.stopPropagation();
    e.preventDefault();
  };
  document.addEventListener('click', swallow, { capture: true, once: true });
  // If no click follows (a cancelled press), don't leave the listener armed for
  // the next unrelated one.
  setTimeout(() => document.removeEventListener('click', swallow, true), 400);
}

function ringTo(offset: number, seconds: number): void {
  if (!ringEl) return;
  ringEl.style.transition = `stroke-dashoffset ${seconds}s linear`;
  ringEl.style.strokeDashoffset = String(offset);
}

function cancelPress(): void {
  pressLive = false;
  if (holdTimer !== null) {
    clearTimeout(holdTimer);
    holdTimer = null;
  }
  ringTo(RING_CIRCUMFERENCE, 0.18);
}

function onPointerDown(e: PointerEvent): void {
  holdFired = false;
  holdAction = null;
  pressLive = false;
  if (!installed || !e.isPrimary) return;
  // Nothing to act on, or a surface of ours already owns the screen.
  if (!currentVideo || otherSurfaceUp()) return;
  // Instagram's own controls keep working. Liking a reel you haven't started
  // shouldn't start it, and our gear is excluded by the same rule.
  const target = e.target instanceof Element ? e.target : null;
  const control = target?.closest('a, button, input, textarea, [role="button"]') ?? null;
  if (control && isControlSized(
    control.getBoundingClientRect(),
    window.innerWidth * window.innerHeight,
  )) return;

  pressLive = true;
  pressX = e.clientX;
  pressY = e.clientY;
  ringTo(0, HOLD_MS / 1000);
  holdTimer = setTimeout(() => {
    holdTimer = null;
    if (!pressLive) return;
    holdFired = true;
    togglePlayback();
  }, HOLD_MS);
}

function onPointerMove(e: PointerEvent): void {
  if (!pressLive) return;
  if (Math.hypot(e.clientX - pressX, e.clientY - pressY) > HOLD_SLOP_PX) cancelPress();
}

function onPointerUp(e: PointerEvent): void {
  const wasLive = pressLive;
  cancelPress();
  if (!wasLive) return;

  if (holdFired) {
    // The hold already did the work at the one-second mark. If a hold that
    // meant "play" didn't take — a WebKit gesture requirement we couldn't
    // satisfy from a timer — this pointerup IS a gesture, so try once more.
    // Guarded on the direction: without that, a hold that PAUSED would be
    // undone here a moment later.
    if (holdAction === 'play' && currentVideo && currentVideo !== releasedVideo) release();
    suppressNextClick();
    return;
  }
  if (Math.hypot(e.clientX - pressX, e.clientY - pressY) > HOLD_SLOP_PX) return;
  toggleSound();
  suppressNextClick();
}

/** The hold gesture: start a held reel, or stop a playing one and put its card
 *  back. Same gesture both ways. */
function togglePlayback(): void {
  if (!currentVideo) return;
  if (currentVideo === releasedVideo && !currentVideo.paused) {
    holdAction = 'pause';
    releasedVideo = null;
    currentVideo.pause();
    if (currentCard && currentInfo) showCard(currentCard, currentInfo);
    return;
  }
  holdAction = 'play';
  release();
}

/** The tap gesture. Deliberately the reversible one: it can never start a reel,
 *  so a stray touch while scrolling costs nothing. */
function toggleSound(): void {
  if (!currentVideo) return;
  currentVideo.muted = !currentVideo.muted;
  showSoundToast(!currentVideo.muted);
}

function showSoundToast(on: boolean): void {
  document.getElementById(TOAST_ID)?.remove();
  const toast = document.createElement('div');
  toast.id = TOAST_ID;
  toast.textContent = on ? 'Sound on' : 'Sound off';
  toast.style.cssText = [
    'position: fixed',
    'top: 84px',
    'left: 50%',
    'transform: translateX(-50%)',
    'padding: 8px 16px',
    'border-radius: 999px',
    'background: rgba(0,0,0,0.62)',
    'backdrop-filter: blur(8px)',
    '-webkit-backdrop-filter: blur(8px)',
    'color: #ffffff',
    `font-family: ${PANEL_FONT}`,
    'font-size: 13px',
    'font-weight: 600',
    'letter-spacing: 0.3px',
    'pointer-events: none',
    `z-index: ${OVERLAY_Z + 1}`,
    'transition: opacity 0.25s ease',
  ].join(';');
  (document.body ?? document.documentElement).appendChild(toast);
  setTimeout(() => { toast.style.opacity = '0'; }, 700);
  setTimeout(() => toast.remove(), 1000);
}

// ==================== Card ====================

function injectStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = [
    '@keyframes bouncer-ig-paused-in {',
    '  from { opacity: 0; }',
    '  to { opacity: 1; }',
    '}',
    // The description often lands a moment after the card does; a bar that
    // breathes reads as "coming" rather than "broken".
    '@keyframes bouncer-ig-shimmer {',
    '  0%, 100% { opacity: 0.25; }',
    '  50% { opacity: 0.5; }',
    '}',
    `#${OVERLAY_ID} .bouncer-ig-skeleton {`,
    '  animation: bouncer-ig-shimmer 1.4s ease-in-out infinite;',
    '}',
  ].join('\n');
  (document.head ?? document.documentElement).appendChild(style);
}

/** The play triangle, ringed by the progress arc that fills as you hold. Built
 *  as SVG rather than a glyph so it renders identically wherever the app runs. */
function playGlyph(): HTMLElement {
  const NS = 'http://www.w3.org/2000/svg';
  const wrap = document.createElement('div');
  wrap.style.cssText = [
    'position: relative',
    'width: 80px',
    'height: 80px',
    'display: flex',
    'align-items: center',
    'justify-content: center',
  ].join(';');

  const ringSvg = document.createElementNS(NS, 'svg');
  ringSvg.setAttribute('width', '80');
  ringSvg.setAttribute('height', '80');
  ringSvg.setAttribute('viewBox', '0 0 80 80');
  ringSvg.setAttribute('aria-hidden', 'true');
  ringSvg.style.cssText = 'position: absolute; inset: 0';

  const track = document.createElementNS(NS, 'circle');
  track.setAttribute('cx', '40');
  track.setAttribute('cy', '40');
  track.setAttribute('r', String(RING_R));
  track.setAttribute('fill', 'rgba(255,255,255,0.14)');
  track.setAttribute('stroke', 'rgba(255,255,255,0.5)');
  track.setAttribute('stroke-width', '2');

  // Starts empty (fully offset) and is animated to 0 over HOLD_MS while held.
  // Rotated so it fills from the top rather than from three o'clock.
  const progress = document.createElementNS(NS, 'circle');
  progress.setAttribute('cx', '40');
  progress.setAttribute('cy', '40');
  progress.setAttribute('r', String(RING_R));
  progress.setAttribute('fill', 'none');
  progress.setAttribute('stroke', '#ffffff');
  progress.setAttribute('stroke-width', '3');
  progress.setAttribute('stroke-linecap', 'round');
  progress.style.strokeDasharray = String(RING_CIRCUMFERENCE);
  progress.style.strokeDashoffset = String(RING_CIRCUMFERENCE);
  progress.style.transform = 'rotate(-90deg)';
  progress.style.transformOrigin = '40px 40px';
  ringEl = progress;

  ringSvg.appendChild(track);
  ringSvg.appendChild(progress);

  const triSvg = document.createElementNS(NS, 'svg');
  triSvg.setAttribute('width', '28');
  triSvg.setAttribute('height', '32');
  triSvg.setAttribute('viewBox', '0 0 30 34');
  triSvg.setAttribute('aria-hidden', 'true');
  // Optically centre the triangle inside the circle.
  triSvg.style.cssText = 'position: relative; left: 3px';
  const tri = document.createElementNS(NS, 'path');
  tri.setAttribute('d', 'M2 2.5 L28 17 L2 31.5 Z');
  tri.setAttribute('fill', '#ffffff');
  tri.setAttribute('stroke', '#ffffff');
  tri.setAttribute('stroke-width', '4');
  tri.setAttribute('stroke-linejoin', 'round');
  triSvg.appendChild(tri);

  wrap.appendChild(ringSvg);
  wrap.appendChild(triSvg);
  return wrap;
}

/** The blank bar shown in place of a description that hasn't resolved. */
function skeleton(): HTMLElement {
  const bar = document.createElement('div');
  bar.className = 'bouncer-ig-skeleton';
  bar.style.cssText = [
    'width: 180px',
    'height: 15px',
    'border-radius: 8px',
    'background: rgba(255,255,255,0.75)',
  ].join(';');
  return bar;
}

function renderDescription(description: string | null): void {
  if (!descEl) return;
  if (description) {
    descEl.textContent = description;
    descEl.style.color = '#ffffff';
  } else {
    descEl.replaceChildren(skeleton());
  }
}

/** Length line under the description. Reads the mounted <video> when it can —
 *  it's the only source that's certainly about the reel on screen — and falls
 *  back to whatever the hook harvested. */
function renderMeta(card: HTMLElement, thumbnailUrl: string): void {
  if (!metaEl) return;
  const video = videoOf(card);
  if (video && Number.isFinite(video.duration) && video.duration > 0) {
    noteDuration(thumbnailUrl, video.duration);
  } else if (video) {
    // Metadata not in yet — fill the line in when it arrives, but only if this
    // card is still the one on screen.
    video.addEventListener('loadedmetadata', () => {
      if (cardCard !== card) return;
      noteDuration(thumbnailUrl, video.duration);
      renderMeta(card, thumbnailUrl);
    }, { once: true });
  }
  const length = formatDuration(durationFor(thumbnailUrl));
  metaEl.textContent = length ? `${length}  ·  Hold to play` : 'Hold to play';
}

function buildCard(): HTMLElement {
  injectStyles();

  const overlay = document.createElement('div');
  overlay.id = OVERLAY_ID;
  overlay.style.cssText = [
    'position: fixed',
    'inset: 0',
    // Everything but the gear lets touches through, so the feed still scrolls.
    'pointer-events: none',
    `z-index: ${OVERLAY_Z}`,
    `font-family: ${PANEL_FONT}`,
    'display: flex',
    'flex-direction: column',
    'align-items: center',
    'justify-content: center',
    'gap: 16px',
    'padding: 0 28px',
    'box-sizing: border-box',
    'text-align: center',
    // Darkened top and bottom so white text holds against any frame, with the
    // middle left comparatively clear — you can still see what you're deciding on.
    'background: linear-gradient(180deg,'
      + ' rgba(0,0,0,0.55) 0%, rgba(0,0,0,0.18) 35%,'
      + ' rgba(0,0,0,0.18) 60%, rgba(0,0,0,0.68) 100%)',
    'animation: bouncer-ig-paused-in 0.2s ease',
    'transition: opacity 0.18s ease',
  ].join(';');

  overlay.appendChild(playGlyph());

  const desc = document.createElement('div');
  desc.style.cssText = [
    'font-size: 20px',
    'font-weight: 700',
    'line-height: 1.3',
    'letter-spacing: 0.1px',
    'color: #ffffff',
    'text-shadow: 0 2px 10px rgba(0,0,0,0.6)',
    'max-width: 460px',
    // Long descriptions shouldn't push the length line off the screen.
    'display: -webkit-box',
    '-webkit-line-clamp: 3',
    '-webkit-box-orient: vertical',
    'overflow: hidden',
  ].join(';');
  descEl = desc;

  const meta = document.createElement('div');
  meta.style.cssText = [
    'font-size: 13px',
    'font-weight: 600',
    'letter-spacing: 0.4px',
    'color: rgba(255,255,255,0.78)',
    'text-shadow: 0 1px 6px rgba(0,0,0,0.6)',
  ].join(';');
  metaEl = meta;

  const hint = document.createElement('div');
  hint.textContent = 'Tap for sound';
  hint.style.cssText = [
    'font-size: 12px',
    'font-weight: 500',
    'letter-spacing: 0.3px',
    'color: rgba(255,255,255,0.5)',
    'text-shadow: 0 1px 6px rgba(0,0,0,0.6)',
    'margin-top: -8px',
  ].join(';');

  overlay.appendChild(desc);
  overlay.appendChild(meta);
  overlay.appendChild(hint);

  // The only part of the card that takes a touch: without it, settings would be
  // unreachable on a phone, since the floating panel that used to carry the gear
  // isn't mounted at this width.
  const gear = document.createElement('button');
  gear.title = 'Open Bouncer settings';
  gear.setAttribute('aria-label', 'Open Bouncer settings');
  gear.style.cssText = [
    'position: absolute',
    'top: 18px',
    'right: 18px',
    'width: 36px',
    'height: 36px',
    'padding: 0',
    'border: none',
    'border-radius: 50%',
    'background: rgba(0,0,0,0.28)',
    'pointer-events: auto',
    'cursor: pointer',
    'display: flex',
    'align-items: center',
    'justify-content: center',
  ].join(';');
  gear.appendChild(makeSettingsIcon('rgba(255,255,255,0.9)', 20));
  gear.onclick = (e) => {
    e.stopPropagation();
    onSettings();
  };
  overlay.appendChild(gear);

  return overlay;
}

// ==================== Public API ====================

export function installReelGate(opts: {
  onSettings: () => void;
  /** Whether this <video> sits inside a reel card the describer has discovered.
   *  The gate holds nothing else. */
  ownsVideo: (video: HTMLVideoElement) => boolean;
  /** Whether a describer surface other than the paused card is on screen.
   *  Suppresses the gestures and the stuck watchdog while one is up, so a
   *  full-screen surface of ours never gets pressed through to the reel. */
  otherSurfaceUp: () => boolean;
}): ReelGate {
  onSettings = opts.onSettings;
  ownsVideo = opts.ownsVideo;
  otherSurfaceUp = opts.otherSurfaceUp;
  if (!installed) {
    installed = true;
    document.addEventListener('play', onPlayAttempt, true);
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('pointermove', onPointerMove, true);
    document.addEventListener('pointerup', onPointerUp, true);
    document.addEventListener('pointercancel', cancelPress, true);
  }
  return { hold, showCard, setDescription, hideCard, release, teardown };
}

function hold(card: HTMLElement): void {
  const video = videoOf(card);
  if (!video) return;
  currentCard = card;
  currentVideo = video;
  // Arriving anywhere revokes the previous release: watching one reel is not
  // permission to autoplay the next. The reel being left is stopped rather than
  // just un-released — it has already started, so no further `play` event is
  // coming for the gate to catch.
  if (releasedVideo !== video) {
    releasedVideo?.pause();
    releasedVideo = null;
  }
  video.pause();
}

function showCard(
  card: HTMLElement,
  info: { thumbnailUrl: string; description: string | null },
): void {
  hold(card);
  clearStuckWatchdog();
  currentInfo = info;
  document.getElementById(OVERLAY_ID)?.remove();
  cardCard = card;
  const overlay = buildCard();
  (document.body ?? document.documentElement).appendChild(overlay);
  renderDescription(info.description);
  renderMeta(card, info.thumbnailUrl);
}

function setDescription(card: HTMLElement, description: string | null): void {
  if (cardCard !== card) return;
  if (currentInfo) currentInfo = { ...currentInfo, description };
  renderDescription(description);
}

function hideCard(): void {
  cardCard = null;
  descEl = null;
  metaEl = null;
  ringEl = null;
  const overlay = document.getElementById(OVERLAY_ID);
  if (!overlay) return;
  overlay.style.opacity = '0';
  setTimeout(() => overlay.remove(), 180);
}

function release(): void {
  const card = cardCard ?? currentCard;
  hideCard();
  if (!card) return;
  const video = videoOf(card);
  if (!video) return;
  releasedVideo = video;
  void video.play().catch(() => { /* the user can hold again */ });
}

function teardown(): void {
  hideCard();
  cancelPress();
  clearStuckWatchdog();
  releasedVideo = null;
  currentCard = null;
  currentVideo = null;
  currentInfo = null;
  if (!installed) return;
  installed = false;
  document.removeEventListener('play', onPlayAttempt, true);
  document.removeEventListener('pointerdown', onPointerDown, true);
  document.removeEventListener('pointermove', onPointerMove, true);
  document.removeEventListener('pointerup', onPointerUp, true);
  document.removeEventListener('pointercancel', cancelPress, true);
}
