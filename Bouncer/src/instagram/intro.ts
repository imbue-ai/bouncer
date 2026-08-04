// Instagram welcome tour — the first-run walk-through of what Bouncer does here.
//
// Shown over the Reels feed once per "Instagram was switched on": the popup
// toggle sets `pendingInstagramIntro` before opening instagram.com/reels, and
// src/instagram/index.ts consumes the flag. Toggling the platform off and on
// again plays it again, by design — it's the toggle's welcome, not a
// lifetime once-ever.
//
// It annotates the REAL UI rather than standing in front of it: the page dims,
// but the describer panel and the settings panel sit above the dim, lit up,
// while the copy and a hand-drawn arrow point at whichever part the current
// step is about. Steps drive the UI too — reaching the filters step opens the
// settings panel, and stepping back closes it — so the thing being described
// is always the thing on screen. index.ts owns both surfaces and passes the
// controls in; this module owns nothing but the overlay.
//
// Advance by clicking the copy, the button, or → / space; leave via Skip,
// Escape, or the final "Get started".
//
// COPY: the four steps are exactly the strings below and nothing generates
// them — edit STEPS to change the tour.

import { VIEWPORT_MARGIN_PX } from './layout';

const OVERLAY_ID = 'bouncer-ig-intro';

const PANEL_FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';
// The arrows cross from the dimmed page onto the white panels they point into,
// so they can't be white — the tip would vanish exactly where it matters. The
// brand orange (the panel gear's colour) reads on both.
const ARROW_COLOR = '#EA8554';

// Below the panels (2147483647) so they stay lit above the dim, above
// everything Instagram renders. The arrow alone matches the panels and wins on
// document order — see raiseArrow().
const BACKDROP_Z = 2147483640;
const CONTENT_Z = 2147483641;
const ARROW_Z = 2147483647;

interface Step {
  /** One entry per line — the copy reads a sentence at a time. */
  readonly body: readonly string[];
  /** Which surface this step is about. Reaching it puts that surface up. */
  readonly surface: 'panel' | 'settings';
  /** Arrow target. A selector list, tried in order — the settings pane is
   *  rebuilt per open, and its contents depend on sign-in state, so a step
   *  points at the first thing that's actually there. Null draws no arrow. */
  readonly target: readonly string[] | null;
  /** Runs a scripted demonstration in the live UI on arrival. */
  readonly demo?: 'swipe' | 'addFilter' | 'removeFilter';
  /** The demonstration opens the settings panel itself, as part of its own
   *  sequence — so the step must not also open it up front. */
  readonly demoDrivesSurface?: boolean;
}

const PANEL_SELECTOR = '#bouncer-ig-frame';
const FILTERS_SELECTOR = '.settings-modal-filters';

const STEPS: readonly Step[] = [
  {
    body: [
      'By default, Bouncer has intentional scrolling on, revealing future '
        + 'content and allowing you to pick what to watch.',
      'You can toggle this in settings.',
    ],
    surface: 'panel',
    target: [PANEL_SELECTOR],
  },
  {
    body: [
      'Swipe away content to remove it, and we’ll suggest filters to add to '
        + 'prevent similar content in the future.',
    ],
    surface: 'panel',
    // No arrow: the demo swipe running in the panel is what the eye should
    // follow, and a second pointer competing with it just muddles the moment.
    target: null,
    demo: 'swipe',
  },
  {
    body: [
      'Bouncer also lets you specify categories of content to remove from your feed.',
      'Filter on anything— by content or audio.',
    ],
    surface: 'settings',
    target: [`${FILTERS_SELECTOR} .filter-phrases-header`, FILTERS_SELECTOR],
    demo: 'addFilter',
    demoDrivesSurface: true,
  },
  {
    body: ['You can also opt in to removing AI slop.'],
    surface: 'settings',
    demo: 'removeFilter',
    target: [`${FILTERS_SELECTOR} .filter-ai-indicator`, FILTERS_SELECTOR],
  },
  {
    body: [
      'Worried you missed something?',
      'All bounced content can be seen under “View filtered”.',
    ],
    surface: 'settings',
    // The filtered-reels button may not be built yet on Instagram; falling
    // back to the section keeps the arrow pointing the right way regardless.
    target: [`${FILTERS_SELECTOR} .filtered-toggle-btn`, FILTERS_SELECTOR],
  },
];

export interface IntroControls {
  /** Put the settings panel up (the gear's action). */
  openSettings(): void;
  /** Take it back down. */
  closeSettings(): void;
  /** Act out a swipe-to-bounce in the describer panel, suggestions and all.
   *  Resolving signals the animation is done, so the arrow can be drawn after
   *  it rather than over it. */
  runSwipeDemo(): void | Promise<void>;
  /** Act out picking a suggestion, then open settings showing it as a filter. */
  runAddFilterDemo(): void | Promise<void>;
  /** Act out removing that filter again, leaving settings as they really are. */
  runRemoveFilterDemo(): void | Promise<void>;
  /** Clear anything a demonstration left on screen. */
  endDemo(): void;
  /** Runs once, whichever way the tour is left. */
  onClose(): void;
}

interface Point { x: number; y: number }

let index = 0;
let controls: IntroControls | null = null;
let surfaceShown: Step['surface'] = 'panel';

let bodyEl: HTMLElement | null = null;
let dotsEl: HTMLElement | null = null;
let copyEl: HTMLElement | null = null;
let arrowSvg: SVGSVGElement | null = null;
// Arrow placement chases a moving target: the settings panel fades in, its
// iframe reports its height a beat later, and the page can be resized
// throughout. Rather than guess when the layout settles, re-measure on a few
// timers after each step and on resize.
let arrowTimers: number[] = [];
// Step indices whose demo has already played this run.
const demosRun = new Set<number>();
// True while a demonstration is mid-flight. Advancing is held off until it
// finishes: a click landing halfway through would swap the copy out from under
// an animation that's still explaining itself, which reads as a glitch.
let animating = false;

function injectStyles(): void {
  if (document.getElementById('bouncer-ig-intro-style')) return;
  const style = document.createElement('style');
  style.id = 'bouncer-ig-intro-style';
  style.textContent = [
    '@keyframes bouncer-intro-in {',
    '  from { opacity: 0; transform: translateY(8px); }',
    '  to { opacity: 1; transform: translateY(0); }',
    '}',
    '@keyframes bouncer-intro-fade {',
    '  from { opacity: 0; }',
    '  to { opacity: 1; }',
    '}',
    // The arrow draws itself on, like it's being sketched.
    '@keyframes bouncer-intro-draw {',
    '  from { stroke-dashoffset: var(--bouncer-arrow-len); }',
    '  to { stroke-dashoffset: 0; }',
    '}',
  ].join('\n');
  (document.head ?? document.documentElement).appendChild(style);
}

// ==================== Arrows ====================
//
// One shape everywhere: a small spiral that unwinds into a run at the target.
// Sampled off a smooth Archimedean spiral with no jitter — an earlier version
// wobbled every point to look sketched, which read as scruffy rather than
// playful at this size.

function polyline(points: readonly Point[]): string {
  return points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
}

// Lead in, loop back over yourself once, then one long sweep into the target.
// Three joined pieces rather than a true spiral: a tightening spiral reads as a
// snail shell, while a single crossing loop reads as a drawn flourish.
function spiralPoints(from: Point, to: Point): Point[] {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.hypot(dx, dy) || 1;
  const ux = dx / dist, uy = dy / dist;     // along the run
  const nx = -uy, ny = ux;                  // perpendicular, to one side
  // Floored as well as capped: the copy sits close to the panel it points at,
  // and a loop scaled purely off that short run collapses into a blob.
  const r = Math.max(13, Math.min(dist * 0.15, 26));

  const points: Point[] = [];

  // 1. A short straight run out of the text.
  const lead = { x: from.x + ux * dist * 0.14, y: from.y + uy * dist * 0.14 };
  const leadSteps = 6;
  for (let i = 0; i <= leadSteps; i++) {
    const t = i / leadSteps;
    points.push({ x: from.x + (lead.x - from.x) * t, y: from.y + (lead.y - from.y) * t });
  }

  // 2. Slightly more than a full turn, centred off to one side, so the curve
  //    crosses back over the lead-in — the crossing is what makes it a loop
  //    rather than a bend.
  const cx = lead.x + nx * r;
  const cy = lead.y + ny * r;
  const a0 = Math.atan2(lead.y - cy, lead.x - cx);
  const sweep = Math.PI * 2 * 1.06;
  const loopSteps = 44;
  for (let i = 1; i <= loopSteps; i++) {
    points.push({
      x: cx + Math.cos(a0 - sweep * (i / loopSteps)) * r,
      y: cy + Math.sin(a0 - sweep * (i / loopSteps)) * r,
    });
  }

  // 3. One broad arc out to the target, bowed away from the loop so the whole
  //    figure opens up instead of doubling back on itself.
  const exit = points[points.length - 1];
  const cpx = exit.x + ux * dist * 0.5 - nx * r * 1.5;
  const cpy = exit.y + uy * dist * 0.5 - ny * r * 1.5;
  const outSteps = 32;
  for (let i = 1; i <= outSteps; i++) {
    const t = i / outSteps;
    const mt = 1 - t;
    points.push({
      x: mt * mt * exit.x + 2 * mt * t * cpx + t * t * to.x,
      y: mt * mt * exit.y + 2 * mt * t * cpy + t * t * to.y,
    });
  }
  return points;
}

function arrowHead(points: readonly Point[]): string {
  const tip = points[points.length - 1];
  const prev = points[Math.max(0, points.length - 4)];
  const angle = Math.atan2(tip.y - prev.y, tip.x - prev.x);
  const len = 12;
  const spread = 0.42;
  const a = { x: tip.x - Math.cos(angle - spread) * len, y: tip.y - Math.sin(angle - spread) * len };
  const b = { x: tip.x - Math.cos(angle + spread) * len, y: tip.y - Math.sin(angle + spread) * len };
  return `M${a.x.toFixed(1)},${a.y.toFixed(1)} L${tip.x.toFixed(1)},${tip.y.toFixed(1)} L${b.x.toFixed(1)},${b.y.toFixed(1)}`;
}

/** Where the arrowhead should land for a given target: just outside its edge,
 *  aimed into its span rather than at a corner.
 *
 *  Clamping straight onto the rect sends the tip to the nearest corner whenever
 *  the copy sits diagonally from the target — which it usually does. On a wide,
 *  short control like "View filtered" that put the arrow beyond the button's
 *  bottom-left, close enough to be geometrically right and to still read as a
 *  miss. Insetting the clamp pulls the aim point in along each axis, so the
 *  arrow lands against the edge itself. */
function anchorPoint(rect: DOMRect, from: Point): Point {
  const insetX = Math.min(24, rect.width / 3);
  const insetY = Math.min(14, rect.height / 3);
  const x = Math.max(rect.left + insetX, Math.min(from.x, rect.right - insetX));
  const y = Math.max(rect.top + insetY, Math.min(from.y, rect.bottom - insetY));
  const dx = x - from.x;
  const dy = y - from.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 1) return { x, y };
  // Just enough clearance for the arrowhead to sit beside the target, not on it.
  const back = 6;
  return { x: x - (dx / dist) * back, y: y - (dy / dist) * back };
}

function findTarget(step: Step): Element | null {
  if (!step.target) return null;
  for (const selector of step.target) {
    const el = document.querySelector(selector);
    if (el && el.getBoundingClientRect().width > 0) return el;
  }
  return null;
}

// Steps point at controls INSIDE the settings panel (the AI sparkle, the
// filtered-reels button), and the panel sits at the maximum z-index — which the
// arrow can match but not beat. At equal z-index, document order decides, so
// keep the arrow last in <body>. Only move it when it isn't already there:
// re-inserting a node restarts its CSS animations, and this runs on a timer.
function raiseArrow(): void {
  if (!arrowSvg) return;
  if (document.body.lastElementChild !== arrowSvg) {
    document.body.appendChild(arrowSvg);
  }
}

/** The panel this step is about — what the copy tucks under and the arrow
 *  points at. Falls back to the describer panel. */
function surfaceRect(): DOMRect | null {
  const el = document.querySelector(surfaceShown === 'settings' ? FILTERS_SELECTOR : PANEL_SELECTOR)
    ?? document.querySelector(PANEL_SELECTOR);
  const rect = el?.getBoundingClientRect();
  return rect && rect.width > 0 ? rect : null;
}

// Which side of the described panel the copy sits on. The describer panel sits
// in the action rail with the reel to its LEFT, so the copy goes right of it or
// it lands on top of the video. The settings panel is pinned to the right edge
// with nothing but empty page to its left, so from that step on the copy goes
// left.
const COPY_GAP = 30;
const COPY_MIN_WIDTH = 260;
/** Width the copy block wants when there's room for it. */
const COPY_WIDTH_PX = 330;

function copySide(): 'left' | 'right' {
  return surfaceShown === 'settings' ? 'left' : 'right';
}

// Park the copy immediately beside the panel it describes, so the text and the
// UI read as one unit instead of sitting at opposite edges of the page.
function positionCopy(): void {
  if (!copyEl) return;
  const rect = surfaceRect();
  const margin = VIEWPORT_MARGIN_PX;
  if (!rect) {
    // Inset from the right edge, but never so far that the block starts off the
    // left of a phone-width viewport.
    copyEl.style.left = 'auto';
    copyEl.style.right = `${Math.min(380, Math.max(margin, window.innerWidth - COPY_MIN_WIDTH - margin))}px`;
    copyEl.style.top = '96px';
    return;
  }

  // Right unless the step says otherwise — or unless there isn't room, in which
  // case overlapping the empty left side beats running off the viewport.
  const roomOnRight = window.innerWidth - (rect.right + COPY_GAP) - margin;
  if (copySide() === 'right' && roomOnRight >= COPY_MIN_WIDTH) {
    copyEl.style.left = `${rect.right + COPY_GAP}px`;
    copyEl.style.right = 'auto';
    copyEl.style.width = `${Math.min(COPY_WIDTH_PX, roomOnRight)}px`;
  } else {
    // Width resolved here rather than left to CSS `min()` so the right inset
    // below can be clamped against it: at phone width the surface being
    // described is itself near the right edge, and the naive inset would push
    // the block's left edge past the viewport.
    const width = Math.min(COPY_WIDTH_PX, Math.max(1, window.innerWidth - margin * 2));
    copyEl.style.left = 'auto';
    copyEl.style.width = `${width}px`;
    copyEl.style.right = `${Math.max(
      margin,
      Math.min(window.innerWidth - rect.left + COPY_GAP, window.innerWidth - width - margin),
    )}px`;
  }

  // Keep the whole block on screen when the settings panel runs tall.
  const height = copyEl.offsetHeight || 220;
  const top = Math.min(rect.bottom + 34, window.innerHeight - height - margin);
  copyEl.style.top = `${Math.max(margin, top)}px`;
}

function positionArrow(): void {
  const step = STEPS[index];
  if (!arrowSvg || !copyEl || !step) return;
  raiseArrow();
  positionCopy();

  const target = findTarget(step);
  const rect = target?.getBoundingClientRect();
  if (!rect || rect.width === 0) {
    arrowSvg.style.display = 'none';
    return;
  }
  arrowSvg.style.display = '';

  // Start just off the copy's top-right corner, heading for the target.
  const copyRect = copyEl.getBoundingClientRect();
  // Leave from whichever top corner faces the target, so the spiral travels
  // toward the panel rather than doubling back across the copy.
  const onRight = copyRect.left > rect.left;
  const from: Point = {
    x: onRight ? copyRect.left + 34 : copyRect.right - 34,
    y: copyRect.top - 10,
  };
  const to = anchorPoint(rect, from);

  const points = spiralPoints(from, to);

  const path = arrowSvg.querySelector<SVGPathElement>('.bouncer-arrow-line');
  const head = arrowSvg.querySelector<SVGPathElement>('.bouncer-arrow-head');
  if (!path || !head) return;
  path.setAttribute('d', polyline(points));
  head.setAttribute('d', arrowHead(points));

  // Re-run the draw-on animation only when the shape actually changed, so the
  // re-measure timers don't restart it three times per step.
  const len = Math.ceil(path.getTotalLength());
  if (path.dataset.len !== String(len)) {
    path.dataset.len = String(len);
    path.style.setProperty('--bouncer-arrow-len', String(len));
    path.style.strokeDasharray = String(len);
    path.style.animation = 'none';
    void path.getBoundingClientRect();
    path.style.animation = 'bouncer-intro-draw 0.5s ease forwards';
    head.style.animation = 'none';
    void head.getBoundingClientRect();
    head.style.animation = 'bouncer-intro-fade 0.2s ease 0.45s backwards';
  }
}

/** Take the arrow off screen and stop any pending re-measures — used while a
 *  demonstration has the stage. */
function hideArrow(): void {
  arrowTimers.forEach(clearTimeout);
  arrowTimers = [];
  if (arrowSvg) arrowSvg.style.display = 'none';
}

function scheduleArrow(): void {
  arrowTimers.forEach(clearTimeout);
  // 0 for the common case; the rest cover the settings panel's fade and its
  // iframe reporting a height. The long tail is for demo-driven steps: those
  // open the panel from inside their own animation — a tap, then the panel —
  // so the target doesn't exist for well over a second and the early samples
  // all find nothing.
  arrowTimers = [0, 160, 420, 900, 1500, 2100, 2700].map(ms =>
    window.setTimeout(positionArrow, ms));
}

// ==================== Steps ====================

function applySurface(step: Step): void {
  if (step.surface === surfaceShown) return;
  surfaceShown = step.surface;
  if (step.surface === 'settings') controls?.openSettings();
  else controls?.closeSettings();
}

/** Put the step's copy on screen, one sentence per line. Split out because
 *  demo steps hold it back until their animation has finished. */
function paintCopy(step: Step): void {
  if (!bodyEl) return;
  bodyEl.replaceChildren(...step.body.map((line, i) => {
    const el = document.createElement('div');
    el.textContent = line;
    if (i > 0) el.style.marginTop = '10px';
    return el;
  }));
  bodyEl.style.animation = 'none';
  void bodyEl.offsetWidth;
  bodyEl.style.animation = 'bouncer-intro-in 0.28s ease';
}

function render(): void {
  const step = STEPS[index];
  if (!step || !bodyEl || !dotsEl) return;

  // A demonstration that drives its own transition opens the panel as part of
  // its sequence; marking the surface here keeps later steps from reopening it.
  if (step.demoDrivesSurface) surfaceShown = step.surface;
  else applySurface(step);

  // On a demo step the order is: show the gesture, THEN name it. The PREVIOUS
  // step's copy stays on screen throughout — blanking it would leave a hole
  // beside the animation and draw the eye to the wrong place. It simply swaps
  // for this step's copy once the demonstration is done.
  // Demos are one-shot per visit: stepping back and forward shouldn't replay an
  // animation on top of UI it already changed.
  const playing = step.demo && !demosRun.has(index);
  if (playing) {
    demosRun.add(index);
    animating = true;
    const demo = step.demo;
    const at = index;
    // A beat first, so the eye has time to reach the panel.
    setTimeout(() => {
      const done = demo === 'swipe' ? controls?.runSwipeDemo()
        : demo === 'addFilter' ? controls?.runAddFilterDemo()
        : controls?.runRemoveFilterDemo();
      // One thing at a time: copy first, then the arrow — neither plays over
      // the demonstration. The index check drops both if the user moved on.
      void Promise.resolve(done).then(() => {
        animating = false;
        if (index !== at) return;
        paintCopy(step);
        scheduleArrow();
      });
    }, 260);
  } else {
    paintCopy(step);
  }

  dotsEl.replaceChildren();
  STEPS.forEach((_, i) => {
    const dot = document.createElement('span');
    dot.style.cssText = [
      'width: 6px',
      'height: 6px',
      'border-radius: 50%',
      'transition: background 0.2s ease',
      `background: ${i === index ? '#ffffff' : 'rgba(255,255,255,0.3)'}`,
    ].join(';');
    dotsEl!.appendChild(dot);
  });

  // Demo steps schedule their own arrow once the animation completes.
  if (playing) hideArrow();
  else scheduleArrow();
}

function advance(step: number): void {
  // Let the current step's demonstration finish before the copy moves on.
  if (animating) return;
  const next = index + step;
  if (next < 0) return;
  // Anything a demonstration put on screen belongs to that step — except when
  // the NEXT step's demonstration is the thing that consumes it. Step 3 taps a
  // chip in step 2's popup and step 4 removes the phrase step 3 added, so those
  // hand-offs must not be swept up here; each demo clears its own predecessor.
  if (STEPS[index]?.demo && !STEPS[next]?.demo) controls?.endDemo();
  if (next >= STEPS.length) { dismiss(); return; }
  index = next;
  render();
}

function dismiss(): void {
  animating = false;
  arrowTimers.forEach(clearTimeout);
  arrowTimers = [];
  document.getElementById(OVERLAY_ID)?.remove();
  arrowSvg?.remove();   // lives on <body>, not inside the overlay
  document.removeEventListener('keydown', onKeydown, true);
  window.removeEventListener('resize', positionArrow);
  bodyEl = dotsEl = copyEl = null;
  arrowSvg = null;
  const cb = controls;
  controls = null;
  // Hand the screen back to the describer panel the tour opened on, rather than
  // leaving the user parked in settings they didn't navigate to themselves.
  if (surfaceShown === 'settings') cb?.closeSettings();
  surfaceShown = 'panel';
  cb?.onClose();
}

function onKeydown(e: KeyboardEvent): void {
  if (!document.getElementById(OVERLAY_ID)) return;
  if (e.key === 'Escape') { e.preventDefault(); dismiss(); return; }
  if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'Enter') {
    e.preventDefault();
    advance(1);
  } else if (e.key === 'ArrowLeft') {
    e.preventDefault();
    advance(-1);
  }
}

/** Build and show the tour. */
export function showIntro(opts: IntroControls): void {
  if (document.getElementById(OVERLAY_ID)) return;
  const parent = document.body ?? document.documentElement;
  if (!parent) return;
  injectStyles();
  index = 0;
  controls = opts;
  demosRun.clear();
  animating = false;
  // The panel is already up when the tour starts; the first step is about it.
  surfaceShown = 'panel';

  const overlay = document.createElement('div');
  overlay.id = OVERLAY_ID;
  overlay.style.cssText = [
    'position: fixed',
    'inset: 0',
    'z-index: ' + BACKDROP_Z,
    `font-family: ${PANEL_FONT}`,
    'animation: bouncer-intro-fade 0.25s ease',
  ].join(';');

  // Dim layer. Separate from the overlay so the copy sits above it at full
  // opacity, and so the panels (higher z) stay lit through the whole tour.
  const scrim = document.createElement('div');
  scrim.style.cssText = 'position: absolute; inset: 0; background: rgba(0,0,0,0.62)';
  // Hold the feed still: a reel scrolling by mid-tour would swap the phrases
  // the first step is pointing at.
  scrim.addEventListener('wheel', (e) => e.preventDefault(), { passive: false });
  scrim.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });

  // Lives directly on <body>, not inside the overlay: raiseArrow() keeps it the
  // last element in the document so it draws over the panels it points into.
  // pointer-events:none throughout, so being on top costs no interactivity.
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('aria-hidden', 'true');
  svg.style.cssText = [
    'position: fixed',
    'inset: 0',
    'width: 100vw',
    'height: 100vh',
    'overflow: visible',
    'pointer-events: none',
    'z-index: ' + ARROW_Z,
  ].join(';');
  const line = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  line.setAttribute('class', 'bouncer-arrow-line');
  line.setAttribute('fill', 'none');
  line.setAttribute('stroke', ARROW_COLOR);
  line.setAttribute('stroke-width', '2.6');
  line.setAttribute('stroke-linecap', 'round');
  line.setAttribute('stroke-linejoin', 'round');
  const head = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  head.setAttribute('class', 'bouncer-arrow-head');
  head.setAttribute('fill', 'none');
  head.setAttribute('stroke', ARROW_COLOR);
  head.setAttribute('stroke-width', '2.6');
  head.setAttribute('stroke-linecap', 'round');
  head.setAttribute('stroke-linejoin', 'round');
  svg.append(line, head);
  arrowSvg = svg;

  // The copy block — text straight on the dim, no card. Left of centre, well
  // clear of the top-right corner both panels occupy.
  const copy = document.createElement('div');
  // left/top are set by positionCopy() against the panel this step is about.
  copy.style.cssText = [
    'position: fixed',
    'width: min(330px, calc(100vw - 48px))',
    'z-index: ' + CONTENT_Z,
    'color: #ffffff',
    'cursor: pointer',
  ].join(';');
  copy.onclick = () => advance(1);
  copyEl = copy;

  // Logo alone — no wordmark, no accent bar. The copy is the point; the mark
  // is just enough to say who's talking.
  const logo = document.createElement('img');
  logo.src = chrome.runtime.getURL('icons/icon48.png');
  logo.alt = 'Bouncer';
  logo.style.cssText = 'width: 26px; height: 26px; border-radius: 8px; display: block; margin-bottom: 14px';

  const body = document.createElement('div');
  body.style.cssText = [
    'font-size: 17px',
    'font-weight: 600',
    'line-height: 1.45',
    'letter-spacing: -0.1px',
    // Reserve the tallest step's height so the block doesn't jump per step.
    'min-height: 100px',
  ].join(';');
  bodyEl = body;

  // Progress dots only. There are no Next/Back/Skip buttons: clicking anywhere
  // advances, ← steps back and Escape leaves, so the copy stays the whole UI.
  const dots = document.createElement('div');
  dots.style.cssText = 'display: flex; align-items: center; gap: 5px; margin-top: 18px';
  dotsEl = dots;

  copy.append(logo, body, dots);
  // The dim itself advances too, so a click anywhere on the page moves on.
  scrim.addEventListener('click', () => advance(1));
  overlay.append(scrim, copy);
  parent.appendChild(overlay);
  parent.appendChild(svg);

  document.addEventListener('keydown', onKeydown, true);
  window.addEventListener('resize', positionArrow);
  render();
}
