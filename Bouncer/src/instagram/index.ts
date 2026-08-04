// Instagram "un-blackbox-er" — describe the reel you're watching.
//
// A standalone content script (intentionally separate from the X/LinkedIn feed
// pipeline) that, as you scroll the Instagram Reels feed:
//   1. scrapes each reel's preloaded cover thumbnail + caption,
//   2. asks the backend (imbue `instagramAnalyze` action, via the background
//      service worker) for a <=5-word phrase describing the reel,
//   3. shows the current reel's phrase (emphasized) plus the phrases of the
//      next four upcoming reels in the "up next" panel pinned top-right.
//
// Inference is run AHEAD of scroll: any reel within `PREFETCH_MARGIN_PX` below
// the viewport is analyzed before it becomes the active reel, so the phrase is
// usually ready the moment you land on it. Results are cached per reel id.
//
// NOTE ON SELECTORS: Instagram's class names are hashed and unstable, so we
// anchor on structural/semantic signals (the cover <img>'s empty alt +
// cdninstagram host; the longest non-link dir="auto" block for the caption). If
// IG changes its markup these heuristics are the first thing to revisit — they're
// all collected here at the top, and reportDiscovery() below says which of them
// stopped matching.

import type { ContentToBackgroundMessage } from '../types';
import { installAudioFilter, type AudioFilterController } from './audiofilter';
import { showIntro } from './intro';
import { showBouncePopup, showDemoBouncePopup, dismissBouncePopup } from './bounce';
import { captureMidFrame, installFrameSources } from './frame';
import { playSwipe, playTap, addDemoPhrase, removeDemoPhrase, clearDemoArtifacts } from './demo';
import { railAnchoredBox, clampLeft, isNarrowViewport } from './layout';
import { installDurationSource } from './durations';
import { installReelGate, type ReelGate } from './gate';
import { makeSettingsIcon } from '../shared/utils';
import { enabledStorageKey } from '../shared/platforms';

// Audio filter terms use their own storage key. (Bouncer filter topics for
// Instagram live under `descriptions_instagram` and are managed by the original
// Bouncer filter UI in content.js — surfaced here via the gear's settings modal.)
const AUDIO_TERMS_KEY = 'audioFilterTerms';
// Settings toggle: "intentional scrolling" (the describer panel). See
// StorageSchema in src/types.ts.
const INTENTIONAL_SCROLL_KEY = 'instagramIntentionalScroll';
// One-shot flag set by the popup when Instagram is switched on.
const INTRO_PENDING_KEY = 'pendingInstagramIntro';
// Matches .filter-settings-btn in content.css, so the "…" reads the same here
// as it does in the filter box on every other platform.
const SETTINGS_GREY = 'rgb(113, 118, 123)';

// Cross-content-script channel (both scripts share the same isolated world):
// the gear asks content.js to open the Bouncer settings modal — which on
// Instagram also carries the filter box, since Reels has no in-page one (see
// showSettingsModal in content/ui.ts) — and content.js tells us to hide the
// whole panel while that modal or the filtered-posts view is up, so we don't
// float over either overlay.
const OPEN_SETTINGS_EVENT = 'bouncer-open-settings';
const CLOSE_SETTINGS_EVENT = 'bouncer-close-settings';
// Fired when a reel is swiped out of the panel, so content.js can file it under
// "View filtered" (and let the user restore it) the same way a reel the
// classifier removed would be.
const BOUNCE_REEL_EVENT = 'bouncer-bounce-reel';
const DESCRIBER_EVENT = 'bouncer-ig-describer';

// Mid-reel frames describe a reel far better than its cover thumbnail (which is
// often a title card), and the capture path is verified working end to end —
// see src/instagram/frame.ts. It's OFF while we chase a delivery problem:
// descriptions were landing only intermittently with a frame attached, and
// caption + thumbnail URL is the payload known to work. Flip this back to true
// to re-enable; nothing else needs changing, and frame.ts stays intact.
const USE_MID_REEL_FRAME = false;

// Scripted phrases for the welcome tour — five, matching the panel's one
// current + UPCOMING_COUNT upcoming rows. Concrete and varied on purpose: the
// point of the panel is "you can tell what's coming", which a row of lorem
// ipsum wouldn't demonstrate.
const DEMO_DESCRIPTIONS = [
  'Viral tomato pasta recipe',
  'Spain vs Argentina World Cup clip',
  'Career advice for new graduates',
  'Funny cat knocking over vase',
  'Ranked review of budget headphones',
] as const;

let audioController: AudioFilterController | null = null;
let audioTerms: string[] = [];

// ==================== Tunables / selectors ====================

const FRAME_ID = 'bouncer-ig-frame';

// How far below the viewport to start analyzing upcoming reels (px).
const PREFETCH_MARGIN_PX = 1500;
// A reel must be at least this visible to be considered "active" (shown in box).
const ACTIVE_RATIO = 0.5;
// Re-scan the DOM at most this often (ms) when Instagram mutates the feed.
const SCAN_DEBOUNCE_MS = 250;
// Defensive cap on caption length sent (server truncates at 2000 too).
const MAX_CAPTION_CHARS = 2200;

// A reel cover thumbnail: empty alt + served from Instagram's media CDN. That
// pair is what separates a cover from everything else on the page — profile
// pictures carry the account name in `alt`, audio covers carry "Audio image",
// and home-feed photos carry a description.
//
// It USED to also require aria-hidden="true", and that one condition switched
// the whole feature off in the iOS app: Instagram's mobile web sets aria-hidden
// on none of its images, so nothing ever matched, no reels were discovered, and
// every surface downstream went quiet at once. Measured on device — of 19
// images on a reels page, 19 were on the CDN and 0 were aria-hidden.
//
// The empty-alt test is the load-bearing one; aria-hidden was only ever
// corroborating it on desktop. cardFromCover() is the second filter — an image
// with no single-<video> ancestor isn't a reel however it's labelled.
function isCoverImg(img: HTMLImageElement): boolean {
  return (
    (img.getAttribute('alt') ?? '') === '' &&
    /cdninstagram\.com/.test(img.src)
  );
}

// ==================== Panel UI ====================
//
// A minimal white card pinned top-right, framed by a black→iridescent gradient
// border (the "un-blackbox-er" look). The active reel's phrase is shown large
// with a pastel gradient bar to its left; the phrases of the next few reels sit
// beneath it, dimmer. No labels, no loading placeholders — each upcoming phrase
// simply fades in the moment its description returns.

const UPCOMING_COUNT = 4;

// The little bar to the left of the currently-playing phrase: pastel pink
// easing into a soft orange. Two neighbouring hues, so sRGB interpolates
// cleanly between them and a couple of intermediate stops are enough to keep it
// smooth across a 3px-wide sliver.
const ACCENT_GRADIENT = 'linear-gradient(180deg, #ffc9de 0%, #ffc4d0 25%, #ffc0bd 50%, #fbb694 75%, #f7a76b 100%)';

const PANEL_FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';

// Upcoming rows fade with distance from the current reel.
const UPCOMING_OPACITIES = [0.7, 0.55, 0.42, 0.32];

// With the card gone, the text sits directly on Instagram's own background —
// so it has to follow Instagram's theme or it's black-on-black in dark mode.
// Same luminance test the adapter uses in getThemeMode().
function isDarkPage(): boolean {
  const m = window.getComputedStyle(document.body).backgroundColor
    .match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!m) return false;
  return Number(m[1]) + Number(m[2]) + Number(m[3]) < 384;
}
const textPrimary = (): string => isDarkPage() ? '#f5f5f5' : '#0a0a0a';
const textMuted = (): string => isDarkPage() ? 'rgba(255,255,255,0.4)' : 'rgba(0,0,0,0.35)';
const textUpcoming = (i: number): string => {
  const op = UPCOMING_OPACITIES[i] ?? 0.3;
  return isDarkPage() ? `rgba(255,255,255,${op})` : `rgba(0,0,0,${op})`;
};

// Fixed layout so the card never grows/shrinks with the number of resolved
// phrases: it always reserves room for the current phrase + UPCOMING_COUNT
// upcoming rows (five entries — the max). Empty slots stay blank but keep their
// height, and the gear sits in the bottom-right corner, in line with the last row.
const PANEL_WIDTH_PX = 320;
const UPCOMING_ROW_H_PX = 20;
const UPCOMING_GAP_PX = 8;
const UPCOMING_LIST_H_PX =
  UPCOMING_COUNT * UPCOMING_ROW_H_PX + (UPCOMING_COUNT - 1) * UPCOMING_GAP_PX;

// Collapsed form: a 40px round-square button wearing the extension icon.
const COLLAPSED_SIZE_PX = 40;

let currentTextEl: HTMLElement | null = null;
let upcomingListEl: HTMLElement | null = null;
// Upcoming reel ids currently displayed — so only newly-arrived rows animate in.
let shownUpcomingIds = new Set<string>();
// Whether content.js has asked us to stay hidden (the filtered-posts view is
// up). Sticky across remounts so navigating within reels keeps it.
let describerHidden = false;
// "Intentional scrolling" (settings toggle, on by default). Off collapses the
// panel to the floating icon and stops describing reels altogether — with no
// currentTextEl/upcomingListEl mounted, refreshPanel() returns before it can
// kick off inference, so nothing is analyzed and nothing is spent.
let intentionalScrolling = true;
// Whether the welcome tour has the panel spotlit, so a remount keeps the glow.
let tourRunning = false;

// ==================== Phone-width flow ====================
//
// On a viewport too narrow to stand the panel beside the reel (the iOS app),
// arriving at a reel doesn't start it. The reel is held at a still frame under a
// card carrying its description and length, and it plays only once you hold on
// it for a second — see ./gate.ts for the gestures and why they're split that
// way. The card carries the settings gear too, so nothing has to sit over the
// video between reels.
//
// Above that width nothing here runs and the panel is byte-for-byte what it was.

// Whether the describer has a surface mounted, in either shape. This is tracked
// rather than derived from the DOM because what gets mounted now varies, and
// "is #bouncer-ig-frame in the DOM" can no longer answer it on its own.
let describerActive = false;

let gate: ReelGate | null = null;

/** Whether the phone-width flow — held reels wearing a description card — is
 *  what's driving. Requires the describer to be on: turning intentional
 *  scrolling off restores the plain feed, autoplay included. */
function fullscreenFlow(): boolean {
  return intentionalScrolling && isNarrowViewport();
}

function injectPanelStyles(): void {
  // Guard so a remount (after navigating away from and back to reels) doesn't
  // append a duplicate <style>.
  if (document.getElementById('bouncer-ig-style')) return;
  const style = document.createElement('style');
  style.id = 'bouncer-ig-style';
  style.textContent = [
    '@keyframes bouncer-ig-enter {',
    '  from { opacity: 0; transform: translateY(4px); }',
    '  to { opacity: 1; transform: translateY(0); }',
    '}',
    // Hover affordance for clickable upcoming rows. !important beats the
    // per-row inline opacity color.
    '.bouncer-ig-next { transition: color 0.15s ease, transform 0.15s ease; }',
    '.bouncer-ig-next:hover { color: #000000 !important; transform: translateX(2px); }',
    '#bouncer-ig-frame.bouncer-ig-dark .bouncer-ig-next:hover { color: #ffffff !important; }',
    // Tour spotlight. The panel has no card to outline any more, so the glow
    // goes on the glyphs themselves — drop-shadow follows the rendered text and
    // bar rather than a box.
    '#bouncer-ig-frame.bouncer-ig-tour {',
    '  filter: drop-shadow(0 0 6px rgba(255,255,255,0.95))',
    '         drop-shadow(0 0 18px rgba(255,255,255,0.75))',
    '         drop-shadow(0 0 36px rgba(255,255,255,0.45));',
    '  transition: filter 0.3s ease;',
    '}',
  ].join('\n');
  (document.head ?? document.documentElement).appendChild(style);
}

// Minimalist orange gear pinned to the card's bottom-right corner (in line with
// the last "up next" row). Clicking it opens Bouncer's settings modal, which on
// Instagram leads with the filter box (content.js hides this panel meanwhile).
function buildGear(): HTMLElement {
  const gear = document.createElement('button');
  gear.title = 'Open Bouncer settings';
  gear.setAttribute('aria-label', 'Open Bouncer settings');
  gear.style.cssText = [
    'position: absolute',
    'right: 0',
    'bottom: 0',
    'width: 24px',
    'height: 24px',
    'padding: 0',
    'border: none',
    'background: transparent',   // no circle around the gear
    'cursor: pointer',
    'pointer-events: auto',      // opt back in (card is pointer-events:none)
    'display: flex',
    'align-items: center',
    'justify-content: center',
  ].join(';');
  gear.appendChild(makeSettingsIcon(isDarkPage() ? 'rgb(160, 166, 173)' : SETTINGS_GREY, 20));
  gear.onclick = () => window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_EVENT));
  return gear;
}

// Apply the current hidden state to whichever form is mounted (full panel or
// collapsed icon). The tour deliberately does NOT hide the panel — it points at
// it — so this is driven only by content.js's overlays.
function applyPanelVisibility(): void {
  const panel = document.getElementById(FRAME_ID);
  if (panel) panel.style.display = describerHidden ? 'none' : '';
}

// content.js drives the describer's visibility: hidden while the settings popup
// or the filtered-posts view is open, shown again once they close.
window.addEventListener(DESCRIBER_EVENT, (e) => {
  const show = (e as CustomEvent<{ show?: boolean }>).detail?.show ?? true;
  describerHidden = !show;
  applyPanelVisibility();
  // The card has no persistent element for applyPanelVisibility to toggle —
  // it's raised per arrival — so it's pulled down and put back explicitly. The
  // reel stays held throughout: closing settings shouldn't drop you into a reel
  // that started playing behind the modal.
  if (!fullscreenFlow()) return;
  if (describerHidden) {
    gate?.hideCard();
    return;
  }
  const reel = activeReel();
  if (reel) showPausedCard(reel);
});

// First-run tour, armed by the popup's Instagram toggle. Consume the flag
// before showing so a second reels tab racing through here can't play it twice.
//
// The tour annotates the live UI rather than replacing it, so it needs to drive
// the two surfaces it points at: the describer panel (which it fills with demo
// phrases) and the settings panel (which it opens on the filters step). Both
// are handed over as callbacks — intro.ts owns none of this state.
async function maybeShowIntro(): Promise<void> {
  const data = await chrome.storage.local.get(INTRO_PENDING_KEY);
  if (!data[INTRO_PENDING_KEY]) return;
  // Every step of the tour points at the floating panel — arrows anchored to it,
  // demonstrations played inside its rows — and the fullscreen flow doesn't
  // mount one. Bail BEFORE consuming the flag, so it stays armed: a tour built
  // for the chooser screen, or simply a wider viewport, will still get to play
  // it. (A tour for the phone-width flow is its own piece of work.)
  if (fullscreenFlow()) return;
  await chrome.storage.local.remove(INTRO_PENDING_KEY);
  // Nothing to point at when the panel is collapsed to its icon; the tour is
  // about the panel, so let the user meet it on their own terms next time.
  if (!intentionalScrolling) return;

  setDemoDescriptions(DEMO_DESCRIPTIONS);
  tourRunning = true;
  document.getElementById(FRAME_ID)?.classList.add('bouncer-ig-tour');
  showIntro({
    openSettings: () => window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_EVENT)),
    closeSettings: () => window.dispatchEvent(new CustomEvent(CLOSE_SETTINGS_EVENT)),
    runSwipeDemo,
    runAddFilterDemo,
    runRemoveFilterDemo,
    endDemo: () => { dismissBouncePopup(); clearDemoArtifacts(); },
    // Hand the panel back to reality. The real phrases were fetched while the
    // tour played, so this render usually lands fully populated.
    onClose: () => {
      // Everything the demonstrations put on screen goes with the tour.
      dismissBouncePopup();
      clearDemoArtifacts();
      tourRunning = false;
      document.getElementById(FRAME_ID)?.classList.remove('bouncer-ig-tour');
      setDemoDescriptions(null);
    },
  });
}

// Collapsed panel: just the extension icon, same corner, click opens settings.
// This is what "intentional scrolling off" looks like — Bouncer is still
// filtering the feed, it just isn't narrating what's coming.
function mountCollapsed(parent: HTMLElement): void {
  const button = document.createElement('button');
  button.id = FRAME_ID;
  button.title = 'Open Bouncer settings';
  button.setAttribute('aria-label', 'Open Bouncer settings');
  button.style.cssText = [
    'position: fixed',
    'top: 20px',
    'right: 20px',
    `width: ${COLLAPSED_SIZE_PX}px`,
    `height: ${COLLAPSED_SIZE_PX}px`,
    'padding: 0',
    'border: none',
    'border-radius: 12px',
    'overflow: hidden',
    'background: transparent',
    'box-shadow: 0 4px 14px rgba(0,0,0,0.18)',
    'cursor: pointer',
    'z-index: 2147483647',
    'display: block',
  ].join(';');

  const img = document.createElement('img');
  img.src = chrome.runtime.getURL('icons/icon48.png');
  img.alt = '';
  img.style.cssText = 'width: 100%; height: 100%; display: block';
  button.appendChild(img);

  button.onclick = () => window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_EVENT));
  parent.appendChild(button);
  describerActive = true;
  // Same anchor as the full panel: above the like button, in the action rail's
  // column, so turning intentional scrolling off moves the icon rather than
  // relocating it to an unrelated corner.
  positionPanel();
  applyPanelVisibility();
}

// Instagram's action rail — the like/comment/share column beside the reel. It's
// the one bit of the page's furniture we can find reliably: the class names are
// hashed, but the buttons carry stable aria-labels.
//
// There is one rail PER REEL in the DOM, so this has to pick the one belonging
// to the reel on screen. Taking the first match meant that once you scrolled
// past the first reel, its rail — now far above the viewport — kept being used,
// and the panel was positioned off the top of the screen. That's why the panel
// only ever appeared on the first reel.
function actionRailRect(): DOMRect | null {
  const middle = window.innerHeight / 2;
  let best: DOMRect | null = null;
  for (const icon of document.querySelectorAll('svg[aria-label="Like"], svg[aria-label="Unlike"]')) {
    const rect = icon.closest('div[role="button"], button, span')?.getBoundingClientRect();
    if (!rect || rect.width === 0) continue;
    // Must actually be on screen — an off-screen rail is a reel we've left.
    if (rect.bottom < 0 || rect.top > window.innerHeight) continue;
    // Of those, the one nearest the middle belongs to the reel being watched.
    if (!best || Math.abs(rect.top - middle) < Math.abs(best.top - middle)) best = rect;
  }
  return best;
}

/** Sit the panel just above the like button and share its column, so it reads
 *  as part of the page's own layout rather than something bolted to the corner.
 *  Falls back to the top-right inset when the rail can't be found (a non-reels
 *  route, or markup that's moved on). */
function positionPanel(): void {
  const panel = document.getElementById(FRAME_ID);
  if (!panel) return;
  const rail = actionRailRect();
  if (!rail) {
    panel.style.left = 'auto';
    panel.style.right = '20px';
    panel.style.top = '20px';
    panel.style.bottom = 'auto';
    return;
  }
  // Only the expanded panel is text-width; the collapsed form is a fixed-size
  // button and must not be stretched by a resize or a scroll — so it is clamped
  // at its own width instead of being measured for one.
  let left: number;
  if (panel.tagName !== 'BUTTON') {
    const box = railAnchoredBox(rail.left, PANEL_WIDTH_PX);
    panel.style.width = `${box.width}px`;
    left = box.left;
  } else {
    left = clampLeft(rail.left, panel.offsetWidth || COLLAPSED_SIZE_PX);
  }
  panel.style.left = `${left}px`;
  panel.style.right = 'auto';
  panel.style.top = 'auto';
  // Clamped at BOTH ends. The lower bound keeps it off the bottom edge; the
  // upper bound is the safety net that stops a stale or oddly-placed rail from
  // parking the panel above the viewport where it silently vanishes.
  const desired = window.innerHeight - rail.top + 16;
  const maxBottom = Math.max(20, window.innerHeight - (panel.offsetHeight || 120) - 20);
  panel.style.bottom = `${Math.min(maxBottom, Math.max(20, desired))}px`;
}

function mountPanel(): void {
  if (describerActive) return;
  const parent = document.body ?? document.documentElement;
  if (!parent) return;
  injectPanelStyles();

  if (!intentionalScrolling) {
    mountCollapsed(parent);
    return;
  }

  // Phone width: nothing is pinned over the reel at all. The description card
  // is raised per arrival by onArrive() and carries its own gear, so settings
  // stay one tap away without a permanent overlay — which is the whole
  // complaint this flow exists to answer.
  if (isNarrowViewport()) {
    gate = installReelGate({
      onSettings: () => window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_EVENT)),
      ownsVideo: (video) => cardForVideo(video) !== null,
      // No second surface on this branch — the card is the only one.
      otherSurfaceUp: () => false,
    });
    describerActive = true;
    return;
  }

  // No card: the panel is just its bar and text, sitting on Instagram's own
  // background. It's positioned against the page's furniture rather than the
  // viewport corner — see positionPanel().
  const panel = document.createElement('div');
  panel.id = FRAME_ID;
  panel.style.cssText = [
    'position: fixed',
    'box-sizing: border-box',
    `width: min(${PANEL_WIDTH_PX}px, calc(100vw - 40px))`,
    'pointer-events: none',
    'z-index: 2147483647',
    `font-family: ${PANEL_FONT}`,
  ].join(';');

  const content = document.createElement('div');
  content.style.cssText = 'position: relative';

  // Current reel: pastel accent bar + large phrase.
  const nowRow = document.createElement('div');
  nowRow.style.cssText = 'display: flex; gap: 10px; align-items: stretch';

  const accent = document.createElement('div');
  accent.style.cssText = `flex: 0 0 3px; border-radius: 2px; background: ${ACCENT_GRADIENT}`;

  const currentText = document.createElement('div');
  currentText.style.cssText = [
    'font-size: 17px',
    'font-weight: 650',
    'line-height: 1.3',
    `color: ${textPrimary()}`,
    'letter-spacing: 0.1px',
    'min-height: 22px',
    'min-width: 0',
    'flex: 1',
    'display: flex',
    'align-items: center',
  ].join(';');
  currentTextEl = currentText;
  // Wired once, for the life of the panel: the element is reused across renders
  // and reads whichever reel is currently playing via the getter.
  makeSwipeable(currentText, () => currentSwipeReel);
  nowRow.appendChild(accent);
  nowRow.appendChild(currentText);

  // Fixed-height upcoming list: always UPCOMING_COUNT slots tall regardless of
  // how many have resolved, so the card doesn't jump as phrases pop in.
  const upcomingList = document.createElement('div');
  upcomingList.style.cssText = [
    'display: flex',
    'flex-direction: column',
    `gap: ${UPCOMING_GAP_PX}px`,
    'margin-top: 12px',
    `height: ${UPCOMING_LIST_H_PX}px`,
  ].join(';');
  upcomingListEl = upcomingList;

  content.appendChild(nowRow);
  content.appendChild(upcomingList);
  content.appendChild(buildGear());
  panel.appendChild(content);
  if (isDarkPage()) panel.classList.add('bouncer-ig-dark');
  if (tourRunning) panel.classList.add('bouncer-ig-tour');
  parent.appendChild(panel);
  describerActive = true;
  positionPanel();
  // Respect a sticky hidden state so remounting during in-reels navigation
  // doesn't pop the panel back over the filtered-posts view or the tour.
  applyPanelVisibility();
}

function descriptionFor(reel: Reel): string | null {
  const entry = cache.get(reel.reelId);
  return entry && 'description' in entry ? entry.description : null;
}

// Skip re-renders (and the entrance animation) when nothing visible changed.
let lastRenderKey = '';
let lastCurrentDesc: string | null = null;

// Stand-in phrases shown while the welcome tour runs, so the panel is worth
// looking at from the first frame instead of blank-until-the-backend-answers.
// The REAL reels are still described underneath the whole time (refreshPanel
// kicks off inference before consulting this), so clicking through the tour is
// exactly the warm-up the panel needs: by the time it clears, the genuine
// phrases are cached and the next render shows them.
let demoDescriptions: readonly string[] | null = null;

// ==================== Tour demo ====================

// Which scripted row the tour has "swiped away", so refreshPanel drops it. The
// index is into DEMO_DESCRIPTIONS; null once the tour ends.
let demoSwipedIndex: number | null = null;

// The scripted row the demo throws away, and what it then pretends the backend
// suggested. Index 2 is "Career advice for new graduates" — the suggestions
// only land as a demonstration if they obviously follow from the phrase.
const DEMO_SWIPE_INDEX = 2;
const DEMO_SUGGESTIONS = ['arrogance', 'unsolicited life advice', 'engagement bait'] as const;

// The suggestion the tour adds and then removes, and the popup it comes from.
const DEMO_PICKED_FILTER = 'arrogance';

/**
 * Step 2's demonstration: sweep a scripted row out of the panel and raise the
 * suggestions it would have produced. No reel is touched and no request is
 * made — showDemoBouncePopup's chips are inert.
 */
async function runSwipeDemo(): Promise<void> {
  if (!upcomingListEl || demoSwipedIndex !== null) return;
  // Upcoming rows are DEMO_DESCRIPTIONS[1..]; the first is the "now playing" line.
  const row = upcomingListEl.children[DEMO_SWIPE_INDEX - 1];
  if (!(row instanceof HTMLElement)) return;

  await playSwipe(row);

  // Drop the row for real, so the gap left behind matches what a genuine swipe
  // does, then make the offer it would have raised.
  demoSwipedIndex = DEMO_SWIPE_INDEX;
  lastRenderKey = '';
  refreshPanel();
  showDemoBouncePopup(DEMO_SUGGESTIONS);
}

/**
 * Step 3's demonstration, which is also its transition: tap a suggestion, watch
 * the popup close, and land in settings with that phrase now in "Filter out".
 * Driving the surface change from here is what makes the two feel causally
 * linked rather than sequential.
 */
async function runAddFilterDemo(): Promise<void> {
  const chip = [...document.querySelectorAll<HTMLElement>('#bouncer-ig-bounce .bouncer-bounce-chip')]
    .find(c => c.textContent === DEMO_PICKED_FILTER);
  if (chip) await playTap(chip);
  dismissBouncePopup();

  window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_EVENT));
  // The panel fades in and its iframe reports a height a beat later; the phrase
  // row exists from the first frame, but give the panel a moment to settle so
  // the pill doesn't appear mid-animation.
  await new Promise(resolve => setTimeout(resolve, 420));
  addDemoPhrase(DEMO_PICKED_FILTER);
}

/** Step 4's demonstration: tap the phrase the last step added, strike it
 *  through and take it away, leaving settings as the user will actually find
 *  them. */
async function runRemoveFilterDemo(): Promise<void> {
  const pill = document.querySelector<HTMLElement>(
    '.settings-modal-filters .filter-phrases-list [data-bouncer-demo]');
  if (!pill) return;
  await playTap(pill);
  await removeDemoPhrase();
}

/** Swap the panel onto scripted phrases (tour) or back onto real ones. */
export function setDemoDescriptions(phrases: readonly string[] | null): void {
  demoDescriptions = phrases;
  if (phrases === null) demoSwipedIndex = null;
  lastRenderKey = '';   // force the next render past the memo guard
  refreshPanel();
}

// ==================== Swipe to bounce ====================
//
// Drag a description to the RIGHT and it leaves the panel, taking that reel's
// row with it and asking the backend what you might want to filter (see
// ./bounce.ts). The reel itself is untouched — this removes it from the list of
// things you're being offered, not from the feed. Only picking one of the
// suggested phrases changes what gets filtered.

// How far right before the drag counts as a bounce rather than a stray drag.
const SWIPE_COMMIT_PX = 56;
// Reels swiped out of the panel. refreshPanel() skips these, so a row doesn't
// reappear on the next render (or when its neighbours resolve).
const swipedAway = new Set<string>();
// The reel the "now playing" row is showing, for its permanently-wired swipe
// handler. Kept in step by refreshPanel().
let currentSwipeReel: Reel | null = null;

// Set when WE move the feed, so the active-reel watcher can tell "the user
// scrolled past the offer" (a no-thanks) from "we advanced them because they
// bounced what they were watching" (the offer still stands).
let suppressBounceDismissOnce = false;

/** Remove a bounced reel from the feed.
 *
 *  Uses exactly the markers the Instagram adapter's own filtering uses —
 *  `display: none` plus `data-filtered-by-extension` — so the adapter's
 *  scroll observer treats it identically to a reel the classifier removed, and
 *  the restore path in the filtered-posts panel can find and un-hide it. */
function hideReelCard(reel: Reel): void {
  const card = reel.card;
  if (!card.isConnected) return;
  card.dataset.filteredByExtension = 'true';
  card.style.display = 'none';
  // Hand it to content.js so it lands in "View filtered" and stays restorable.
  window.dispatchEvent(new CustomEvent(BOUNCE_REEL_EVENT, { detail: { card } }));
}

/** Scroll to the first reel after `fromReelId` that's still in the feed and
 *  hasn't been bounced. Same mechanism as clicking an upcoming phrase. */
function advanceToNextReel(fromReelId: string): void {
  const idx = orderedReels.findIndex(r => r.reelId === fromReelId);
  if (idx < 0) return;
  const next = orderedReels
    .slice(idx + 1)
    .find(r => r.card.isConnected && !swipedAway.has(r.reelId));
  if (!next) return;
  suppressBounceDismissOnce = true;
  next.card.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

/** Wire a rendered row so it can be dragged out to the right. `getReel` is a
 *  getter rather than a value because the "now playing" row is a single element
 *  reused across renders — it must always bounce whatever reel it currently
 *  shows, and re-wiring it per render would stack duplicate listeners. */
function makeSwipeable(row: HTMLElement, getReel: () => Reel | null): void {
  // The panel is pointer-events:none so it never blocks the feed; a draggable
  // row has to opt back in.
  row.style.pointerEvents = 'auto';
  row.style.touchAction = 'pan-y';

  let startX = 0;
  let dragging = false;

  const move = (e: PointerEvent): void => {
    if (!dragging) return;
    // Right only: a leftward drag just does nothing rather than fighting back.
    const dx = Math.max(0, e.clientX - startX);
    // Past a few pixels this is a drag, not a click. The row's click handler
    // reads this so a drag that springs back doesn't also jump to the reel.
    if (dx > 4) row.dataset.ffDragged = '1';
    row.style.transform = `translateX(${dx}px)`;
    row.style.opacity = String(Math.max(0, 1 - dx / (SWIPE_COMMIT_PX * 2.2)));
  };

  const end = (e: PointerEvent): void => {
    if (!dragging) return;
    dragging = false;
    const reel = getReel();
    row.releasePointerCapture?.(e.pointerId);
    row.removeEventListener('pointermove', move);
    row.removeEventListener('pointerup', end);
    row.removeEventListener('pointercancel', end);

    const dx = e.clientX - startX;
    if (!reel || dx < SWIPE_COMMIT_PX) {
      // Not far enough — spring back.
      row.style.transition = 'transform 0.18s ease, opacity 0.18s ease';
      row.style.transform = '';
      row.style.opacity = '';
      setTimeout(() => { row.style.transition = ''; }, 200);
      return;
    }

    // Committed: finish the throw, then drop the row and ask why.
    row.style.transition = 'transform 0.16s ease, opacity 0.16s ease';
    row.style.transform = 'translateX(120px)';
    row.style.opacity = '0';
    swipedAway.add(reel.reelId);
    setTimeout(() => {
      lastRenderKey = '';   // the entry list changed shape; force a re-render
      refreshPanel();
    }, 160);

    // Take the reel out of the feed, not just out of the panel. Bouncing is a
    // "don't show me this" — leaving the reel in place meant you still scrolled
    // straight into it a moment later.
    hideReelCard(reel);

    // And if it's the one PLAYING, move off it: the card collapsing under the
    // viewport would otherwise dump the user mid-way into the next reel.
    if (reel.reelId === activeReelId) advanceToNextReel(reel.reelId);

    showBouncePopup({
      caption: captionFromCard(reel.card),
      thumbnailUrl: reel.thumbnailUrl,
    });
  };

  row.addEventListener('pointerdown', (e) => {
    // Left button / touch only, and nothing to bounce on an empty slot.
    if (e.button !== 0 || !getReel()) return;
    dragging = true;
    startX = e.clientX;
    delete row.dataset.ffDragged;
    row.setPointerCapture?.(e.pointerId);
    row.style.transition = '';
    row.addEventListener('pointermove', move);
    row.addEventListener('pointerup', end);
    row.addEventListener('pointercancel', end);
  });
}

/** One rendered row: a real reel, or a scripted phrase with no reel behind it. */
interface PanelEntry {
  /** Identity for the "already on screen, don't re-animate" set. */
  key: string;
  desc: string;
  /** Null for demo rows — nothing to scroll to. */
  reel: Reel | null;
}

// Re-render the panel from current state: the active reel plus the RESOLVED
// phrases among the next UPCOMING_COUNT reels in feed order. Also kicks off
// inference for those reels (the per-reel cache dedupes). Called whenever the
// active reel changes and whenever any description resolves — so upcoming
// phrases pop in one by one as they return, with no placeholder bars.
/** The reel being watched plus the next few still in the feed — the slice both
 *  the floating panel and the chooser screen are built from, and the set that
 *  gets described ahead of scroll. */
function feedSlice(): { current: Reel | null; upcoming: Reel[] } {
  const idx = activeReelId ? orderedReels.findIndex((r) => r.reelId === activeReelId) : -1;
  const currentReel = idx >= 0 ? orderedReels[idx] : null;
  // A swiped-away reel keeps its slot in the feed but loses it here.
  const current = currentReel && !swipedAway.has(currentReel.reelId) ? currentReel : null;
  const upcoming =
    idx >= 0
      ? orderedReels
          .slice(idx + 1)
          .filter((r) => r.card.isConnected && !swipedAway.has(r.reelId))
          .slice(0, UPCOMING_COUNT)
      : [];
  return { current, upcoming };
}

function refreshPanel(): void {
  const { current, upcoming } = feedSlice();

  // Kicked off before the panel renders, and deliberately outside the guard
  // below: the slice is what gets described ahead of scroll whether or not
  // there is a panel mounted to show the result in. Skipped entirely while the
  // phone-width flow is on placeholders — no request is made, so working on the
  // interaction costs nothing.
  if (describingReels()) {
    for (const reel of [current, ...upcoming]) {
      if (reel) void describeReel(reel);
    }
  }
  refreshHeldReel(current);

  if (!currentTextEl || !upcomingListEl) return;
  // Before the memo guard below: the panel's *position* has to track the page
  // even when its *text* hasn't changed. Instagram mounts the action rail after
  // we mount, and reflows it on every route change — gating re-anchoring on a
  // text change left the panel stuck in its fallback corner for as long as the
  // phrases were unresolved.
  positionPanel();

  // Only render the ones that have resolved (added as they return) —
  // unless the tour is driving, in which case its script takes the screen while
  // the inference kicked off above keeps filling the cache behind it.
  const currentDesc = demoDescriptions
    ? demoDescriptions[0] ?? null
    : current ? descriptionFor(current) : null;
  const upcomingResolved: PanelEntry[] = demoDescriptions
    ? demoDescriptions
        .map((desc, i) => ({ key: `demo-${i}`, desc, reel: null, i }))
        .filter(x => x.i > 0 && x.i !== demoSwipedIndex)
        .slice(0, UPCOMING_COUNT)
    : upcoming.flatMap((r): PanelEntry[] => {
        const desc = descriptionFor(r);
        return desc === null ? [] : [{ key: r.reelId, desc, reel: r }];
      });

  const renderKey = JSON.stringify([
    demoDescriptions !== null,
    current?.reelId ?? null,
    currentDesc,
    upcomingResolved.map((x) => [x.key, x.desc]),
  ]);
  if (renderKey === lastRenderKey) return;
  lastRenderKey = renderKey;
  const currentChanged = currentDesc !== lastCurrentDesc;
  lastCurrentDesc = currentDesc;

  // Keep the now-playing row's swipe target in step with what it displays.
  // Demo rows (the tour) have no reel, so they can't be bounced.
  currentSwipeReel = demoDescriptions ? null : current;
  currentTextEl.style.transform = '';
  currentTextEl.style.opacity = '';
  currentTextEl.style.cursor = current && !demoDescriptions ? 'grab' : '';
  currentTextEl.title = current && !demoDescriptions ? 'Drag right to bounce' : '';

  // Current phrase. An entirely empty card reads as broken rather than busy, so
  // when nothing at all has come back yet the first line says so; once any
  // phrase resolves the panel speaks for itself and the placeholder goes.
  const nothingResolved = !currentDesc && upcomingResolved.length === 0;
  currentTextEl.textContent = currentDesc ?? (nothingResolved ? 'Loading...' : '');
  // Set explicitly rather than cleared: '' would inherit Instagram's own text
  // colour, which is not what these rows use.
  currentTextEl.style.color = nothingResolved ? textMuted() : textPrimary();
  if (currentDesc && currentChanged) {
    // Restart the entrance animation for the new phrase.
    currentTextEl.style.animation = 'none';
    void currentTextEl.offsetWidth;
    currentTextEl.style.animation = 'bouncer-ig-enter 0.25s ease';
  }

  // Always render UPCOMING_COUNT fixed-height slots: resolved phrases fill from
  // the top, the rest stay blank placeholders so the card height never changes.
  const nextShown = new Set<string>();
  const rows = Array.from({ length: UPCOMING_COUNT }, (_, i) => {
    const entry = upcomingResolved[i];
    const row = document.createElement('div');
    row.style.cssText = [
      'font-size: 13px',
      'font-weight: 500',
      `height: ${UPCOMING_ROW_H_PX}px`,
      'line-height: 1.35',
      `color: ${textUpcoming(i)}`,
      'white-space: nowrap',
      'overflow: hidden',
      'text-overflow: ellipsis',
      'display: flex',
      'align-items: center',
      // The last slot sits at the gear's height — keep its text clear of it.
      ...(i === UPCOMING_COUNT - 1 ? ['padding-right: 30px'] : []),
    ].join(';');
    if (!entry) return row;   // blank placeholder slot

    const { key, reel, desc } = entry;
    row.textContent = desc;
    // Only animate rows that weren't shown last render, so already-visible
    // phrases don't re-flicker when a new one arrives.
    if (!shownUpcomingIds.has(key)) {
      row.style.animation = 'bouncer-ig-enter 0.25s ease';
    }
    // The panel is pointer-events:none so it doesn't block the feed; resolved
    // rows opt back in so clicking a phrase jumps to that reel. Demo rows have
    // no reel behind them, so they stay inert.
    if (reel) {
      row.classList.add('bouncer-ig-next');
      row.style.pointerEvents = 'auto';
      row.style.cursor = 'pointer';
      row.title = 'Click to jump here — drag right to bounce';
      row.addEventListener('click', () => {
        // A committed swipe ends with a pointerup on this row, which the
        // browser also reports as a click; ignore it so bouncing a reel
        // doesn't also scroll to it.
        if (swipedAway.has(reel.reelId) || row.dataset.ffDragged) return;
        reel.card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
      makeSwipeable(row, () => reel);
    }
    nextShown.add(key);
    return row;
  });
  shownUpcomingIds = nextShown;
  upcomingListEl.replaceChildren(...rows);
  // Re-anchor after the block changes height.
  positionPanel();
}

// ==================== Held reels ====================

// Placeholder labels while the description pipeline is being sorted out.
//
// Waiting on inference makes the card impossible to judge: it either resolves
// or it doesn't, and what you're looking at is latency rather than layout. With
// this on, no inference is requested at all and the card is labelled by
// position, so nothing is spent while the interaction is being worked out.
//
// Flip to false to put real descriptions back; nothing else changes. The
// desktop panel is unaffected either way — it has been on real inference
// throughout, and this only ever applies to the phone-width flow.
const PLACEHOLDER_DESCRIPTIONS = true;

/** What the card labels a reel with: its description, or — while
 *  PLACEHOLDER_DESCRIPTIONS is on — a stand-in. */
function displayDescription(reel: Reel): string | null {
  return PLACEHOLDER_DESCRIPTIONS ? 'This reel' : descriptionFor(reel);
}

/** Whether reels should actually be sent for description right now. */
function describingReels(): boolean {
  return !(fullscreenFlow() && PLACEHOLDER_DESCRIPTIONS);
}

function activeReel(): Reel | null {
  if (activeReelId === null) return null;
  return orderedReels.find((r) => r.reelId === activeReelId) ?? null;
}

/** Land on a reel: held at a still frame, wearing its description and length,
 *  playing only once held. */
function showPausedCard(reel: Reel): void {
  // content.js has the screen (settings, or the filtered-posts list) — the reel
  // stays held either way, we just don't stack a card over their overlay.
  if (describerHidden) return;
  gate?.showCard(reel.card, {
    thumbnailUrl: reel.thumbnailUrl,
    description: displayDescription(reel),
  });
}

/** Fold a newly-resolved description into the card. Driven from refreshPanel,
 *  so it runs on every arrival and again as each phrase returns. */
function refreshHeldReel(current: Reel | null): void {
  if (!fullscreenFlow() || !current) return;
  gate?.setDescription(current.card, displayDescription(current));
}

/** The active reel changed while the phone-width flow is driving. */
function onArrive(reel: Reel): void {
  gate?.hold(reel.card);
  showPausedCard(reel);
}

// ==================== Reel scraping ====================

interface Reel {
  reelId: string;
  card: HTMLElement;
  thumbnailUrl: string;
}

// Stable id for a reel: the thumbnail URL's pathname (the media filename),
// which survives query-string token refreshes. e.g.
// /v/t51.../723238673_17877465735611947_..._n.jpg
function reelIdFromUrl(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

// Walk up from a cover img to the reel "card" — the LARGEST ancestor that still
// contains exactly one <video> (i.e. the single-reel slide). The caption lives
// in a sibling branch of the <video>, not inside the tight media wrapper, so we
// must climb past that wrapper; but we stop before the ancestor that merges
// multiple reels together (the feed's <main>), which scopes caption lookup to
// just this reel. Returns null if no single-video ancestor exists yet (e.g. the
// reel's <video> hasn't lazy-mounted) — the caller re-scans on later mutations.
//
// The <main>/<body>/<html> guard is load-bearing: the "merges multiple reels"
// stop only fires once a SECOND <video> is mounted. On a freshly-loaded feed —
// and permanently on a /reel/<id>/ permalink — there is exactly one <video>, so
// every ancestor up to <html> holds exactly one and the climb would hand back
// the whole document as the card (scraping the entire page's text as the
// caption, and registering <html> as a reel).
function cardFromCover(img: HTMLImageElement): HTMLElement | null {
  let el: HTMLElement | null = img.parentElement;
  let card: HTMLElement | null = null;
  for (let i = 0; i < 20 && el; i++) {
    if (el === document.body || el === document.documentElement || el.tagName === 'MAIN') break;
    const videos = el.querySelectorAll('video').length;
    if (videos === 1) card = el; // remember the largest single-video ancestor
    else if (videos > 1) break; // next level up merges reels — stop
    el = el.parentElement;
  }
  return card;
}

// The caption is the longest text block in the card that isn't itself a link
// (username, audio attribution, and the "Follow"/counter chrome are all short
// and/or wrapped in <a>). Hashtag <a>s live *inside* the caption div, so we key
// off `closest('a')` being null for the container itself. Empty/spam captions
// are fine — the server prompt handles them.
function captionFromCard(card: HTMLElement): string {
  let best = '';
  for (const el of Array.from(card.querySelectorAll<HTMLElement>('[dir="auto"]'))) {
    if (el.closest('a')) continue;
    const text = (el.textContent ?? '').trim();
    if (text.length > best.length) best = text;
  }
  return best.slice(0, MAX_CAPTION_CHARS);
}

// ==================== Inference (via background → imbue) ====================

type CacheEntry = { description: string } | { pending: Promise<string> };
const cache = new Map<string, CacheEntry>();

async function describeReel(reel: Reel): Promise<string> {
  const existing = cache.get(reel.reelId);
  if (existing) return 'description' in existing ? existing.description : existing.pending;

  const caption = captionFromCard(reel.card);

  const pending = (async (): Promise<string> => {
    try {
      // Only reels the user ISN'T watching may be seeked — seeking the active
      // one would visibly jump the video under them. Skipped entirely when the
      // flag is off, so there's no capture cost and no seeking at all.
      const frame = USE_MID_REEL_FRAME
        ? await captureMidFrame(reel.card, {
            allowSeek: reel.reelId !== activeReelId,
            thumbnailUrl: reel.thumbnailUrl,
          })
        : null;
      // Falling back to the thumbnail is fine; falling back QUIETLY is not.
      // Instagram's markup and buffering are both out of our hands, so if
      // mid-reel capture ever stops working this is the only place it would
      // show — say so, loudly, every time.
      if (frame?.ok) {
        console.debug(
          `[Bouncer IG] mid-reel frame: ${frame.chars} b64 chars @ q${frame.quality}`,
          reel.reelId);
      } else if (frame) {
        console.warn(
          `[Bouncer IG] NO mid-reel frame (${frame.reason}) — describing `
          + `${reel.reelId} from the cover thumbnail instead`);
      }
      const message: ContentToBackgroundMessage = {
        type: 'analyzeReel',
        caption,
        thumbnailUrl: reel.thumbnailUrl,
        ...(frame?.ok ? { frameBase64: frame.base64 } : {}),
      };
      const res: { description?: string; error?: string } | undefined = await chrome.runtime.sendMessage(message);
      const description = (res?.description ?? '').trim();
      if (res?.error || !description) {
        // Drop the cache entry so a later scroll-by can retry.
        cache.delete(reel.reelId);
        // Both arms log: a well-formed response carrying no description (the
        // backend answered but the action isn't wired up) is otherwise
        // indistinguishable from "nothing is happening" — the panel just stays
        // blank with an empty console.
        if (res?.error) console.warn('[Bouncer IG] analyzeReel error:', res.error);
        else console.warn('[Bouncer IG] analyzeReel returned no description for', reel.reelId);
        return '';
      }
      cache.set(reel.reelId, { description });
      // A visible slot may have been waiting on this phrase.
      refreshPanel();
      return description;
    } catch (err) {
      cache.delete(reel.reelId);
      console.warn('[Bouncer IG] analyzeReel send failed:', (err as Error).message);
      return '';
    }
  })();

  cache.set(reel.reelId, { pending });
  return pending;
}

// ==================== Active-reel tracking ====================

let cards = new WeakSet<HTMLElement>();              // cards already observed (reset on nav away)
const cardToReel = new WeakMap<HTMLElement, Reel>();
const ratios = new Map<HTMLElement, number>();      // current visibility per card
let activeReelId: string | null = null;

// All discovered reels in feed (document) order, so the panel can answer
// "which reels come after the active one". Cards that Instagram has
// virtualized out of the DOM are skipped at read time via card.isConnected.
const orderedReels: Reel[] = [];

function insertOrdered(reel: Reel): void {
  let i = orderedReels.length;
  while (
    i > 0 &&
    !(orderedReels[i - 1].card.compareDocumentPosition(reel.card) & Node.DOCUMENT_POSITION_FOLLOWING)
  ) {
    i--;
  }
  orderedReels.splice(i, 0, reel);
}

/** The discovered reel card a <video> sits inside, if any. The gate asks this
 *  before holding anything: a video the scraper never claimed (a DM preview, an
 *  ad, a surface whose markup we don't recognise) is none of our business and
 *  must keep playing normally. */
function cardForVideo(video: HTMLVideoElement): HTMLElement | null {
  let el: HTMLElement | null = video.parentElement;
  for (let i = 0; i < 25 && el; i++) {
    if (cards.has(el)) return el;
    el = el.parentElement;
  }
  return null;
}

const observer = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      const card = entry.target as HTMLElement;
      ratios.set(card, entry.intersectionRatio);

      // Prefetch anything that's entered the (expanded) root — including reels
      // still below the fold thanks to PREFETCH_MARGIN_PX.
      if (entry.isIntersecting) {
        const reel = cardToReel.get(card);
        if (reel) void describeReel(reel);
      }
    }
    updateActive();
  },
  // Negative top margin keeps "active" tied to what's actually on screen, while
  // the large bottom margin pulls upcoming reels in early for prefetch.
  { threshold: [0, 0.25, 0.5, 0.75, 1], rootMargin: `0px 0px ${PREFETCH_MARGIN_PX}px 0px` },
);

// Pick the most-visible card as the active reel and re-render the panel around
// it. refreshPanel kicks off inference for the active reel and the next
// UPCOMING_COUNT, and re-runs itself as each phrase resolves.
function updateActive(): void {
  let bestCard: HTMLElement | null = null;
  let bestRatio = ACTIVE_RATIO;
  for (const [card, ratio] of ratios) {
    if (ratio >= bestRatio) {
      bestRatio = ratio;
      bestCard = card;
    }
  }
  if (!bestCard) return;

  const reel = cardToReel.get(bestCard);
  if (!reel || reel.reelId === activeReelId) return;
  activeReelId = reel.reelId;
  // Scrolling on to another reel is an answer: the "Remove similar content?"
  // offer was about the reel you just left, so moving on means "no thanks".
  // Unless we're the ones who moved them — bouncing the reel you're watching
  // advances the feed, and that must not dismiss the offer it just raised.
  if (suppressBounceDismissOnce) suppressBounceDismissOnce = false;
  else dismissBouncePopup();
  // Before refreshPanel: the card is raised here, and refreshHeldReel (called
  // from refreshPanel) is what then keeps it in step with a description still
  // on its way.
  if (fullscreenFlow()) onArrive(reel);
  refreshPanel();
}

// ==================== Scan loop ====================

function scan(): void {
  if (!onReelsPage()) return;   // debounced scans can fire just after nav away
  for (const img of Array.from(document.images)) {
    if (!isCoverImg(img)) continue;
    const card = cardFromCover(img);
    if (!card || cards.has(card)) continue;

    const reel: Reel = { reelId: reelIdFromUrl(img.src), card, thumbnailUrl: img.src };
    cards.add(card);
    cardToReel.set(card, reel);
    insertOrdered(reel);
    observer.observe(card);
    // Feed the same discovery to the audio filter (it prefetches + hides on a
    // match before the reel is reached).
    audioController?.onReelDiscovered(reel.reelId, reel.card, reel.thumbnailUrl);
  }
  // Newly discovered reels may fill empty "up next" slots.
  refreshPanel();
}

// ==================== Diagnostics ====================

// Reel discovery is heuristic all the way down: Instagram's class names are
// hashed, so a cover image is identified by SHAPE (decorative + served from the
// IG CDN, see isCoverImg) rather than by selector, and the card around it by
// counting <video> descendants. When either heuristic stops matching, every
// surface downstream goes quiet at once and the whole feature looks like it
// simply isn't running — with nothing to say which half broke.
//
// So it says so itself, once per page. The iOS app forwards console.* to the
// Xcode console (see the bridge in ChromePolyfill.js), which is the only place
// this is readable on device.
const DISCOVERY_REPORT_MS = 5000;
let reportedDiscovery = false;

function reportDiscovery(): void {
  if (reportedDiscovery || !onReelsPage()) return;
  reportedDiscovery = true;

  const images = Array.from(document.images);
  let decorative = 0;
  let onCdn = 0;
  let covers = 0;
  let carded = 0;
  const samples: string[] = [];
  for (const img of images) {
    const isDecorative = img.getAttribute('aria-hidden') === 'true'
      && (img.getAttribute('alt') ?? '') === '';
    const isCdn = /cdninstagram\.com/.test(img.src);
    if (isDecorative) decorative++;
    if (isCdn) onCdn++;
    if (isDecorative && isCdn) {
      covers++;
      if (cardFromCover(img)) carded++;
    }
    // Enough of a fingerprint to tell which half of the test each image failed.
    if (samples.length < 8 && img.src) {
      let host = '?';
      try { host = new URL(img.src, location.href).host; } catch { /* keep '?' */ }
      samples.push(
        `${host} aria-hidden=${img.getAttribute('aria-hidden') ?? '-'}`
        + ` alt="${(img.getAttribute('alt') ?? '').slice(0, 24)}"`);
    }
  }

  console.warn(
    `[Bouncer IG] discovery: ${orderedReels.length} reels tracked, `
    + `active=${activeReelId ?? 'none'}, `
    + `${document.querySelectorAll('video').length} <video> on page. `
    + `Of ${images.length} images — ${decorative} decorative, ${onCdn} on the IG CDN, `
    + `${covers} passed the cover test, ${carded} of those resolved to a card. `
    + `Flow: width=${window.innerWidth} narrow=${isNarrowViewport()} `
    + `intentional=${intentionalScrolling} active=${describerActive} `
    + `hidden=${describerHidden} path=${location.pathname}`);

  if (orderedReels.length === 0) {
    console.warn('[Bouncer IG] no reels matched. Image sample:', samples.join('  |  '));
  }
}

let scanTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleScan(): void {
  if (scanTimer) return;
  scanTimer = setTimeout(() => {
    scanTimer = null;
    scan();
  }, SCAN_DEBOUNCE_MS);
}

// ==================== Boot ====================

// The describer UI is only for the Reels viewer — the vertical /reels/ feed and
// individual /reel/<id>/ permalinks. On every other Instagram surface (home
// feed, profiles, explore, DMs) the panel stays hidden.
function onReelsPage(): boolean {
  const p = location.pathname;
  return p === '/reels' || p.startsWith('/reels/') || p.startsWith('/reel/');
}

// Remove the panel and drop all reel tracking, so a later return to reels
// starts clean (Instagram virtualizes cards away on route change anyway).
function removePanel(): void {
  document.getElementById(FRAME_ID)?.remove();
  currentTextEl = null;
  upcomingListEl = null;
  lastRenderKey = '';
  lastCurrentDesc = null;
  shownUpcomingIds = new Set();
  // The gate especially: leaving it installed would keep pausing video on
  // whatever Instagram page comes next.
  gate?.teardown();
  gate = null;
  describerActive = false;
  observer.disconnect();
  ratios.clear();
  orderedReels.length = 0;
  cards = new WeakSet<HTMLElement>();
  activeReelId = null;
}

// Which side of the threshold the describer last built itself for. A rotation,
// or an iPad leaving split view, changes which surface the feature IS — not just
// where it sits — so crossing it rebuilds rather than re-anchoring.
let wasNarrow = isNarrowViewport();

function onViewportResize(): void {
  const narrow = isNarrowViewport();
  if (narrow === wasNarrow) {
    positionPanel();
    return;
  }
  wasNarrow = narrow;
  if (describerActive) removePanel();
  syncForLocation();
}

let lastPath = location.pathname;
function syncForLocation(): void {
  if (onReelsPage()) {
    mountPanel();      // idempotent — no-ops if already mounted
    refreshPanel();
    positionPanel();
    scan();
  } else if (describerActive) {
    removePanel();
  }
}

async function boot(): Promise<void> {
  // Respect the Instagram master switch, same key content/index.ts gates on.
  // Without this the panel would still mount when the platform is toggled off
  // — and its gear would be dead, because content.js returns before wiring the
  // settings bridge. Re-enabling reloads, matching content/index.ts.
  const platformKey = enabledStorageKey('instagram');
  const stored = await chrome.storage.local.get([platformKey, INTENTIONAL_SCROLL_KEY]);
  if (stored[platformKey] === false) {
    chrome.storage.onChanged.addListener((changes) => {
      if (changes[platformKey] && changes[platformKey].newValue !== false) {
        location.reload();
      }
    });
    return;
  }
  // Missing means on — the panel is the default experience.
  intentionalScrolling = stored[INTENTIONAL_SCROLL_KEY] !== false;

  // Flipping the toggle swaps the panel for the icon (or back) live, with no
  // reload: tear the mount down and let syncForLocation rebuild in the new
  // shape. removePanel() also clears the reel bookkeeping, so re-expanding
  // re-describes the reels on screen rather than showing a stale list.
  chrome.storage.onChanged.addListener((changes) => {
    const change = changes[INTENTIONAL_SCROLL_KEY];
    if (!change) return;
    const next = change.newValue !== false;
    if (next === intentionalScrolling) return;
    intentionalScrolling = next;
    // describerActive rather than the element: at phone width the describer
    // mounts nothing persistent, so switching it off there has to tear down the
    // gate and the fullscreen surfaces via this path too — otherwise reels stay
    // held with no card left to release them.
    if (describerActive) removePanel();
    syncForLocation();
  });

  // First run after the platform toggle was switched on: play the welcome
  // carousel. Deliberately not awaited — the panel and scanning shouldn't wait
  // on it, and the overlay sits above them either way.
  void maybeShowIntro();

  // Both of these listen to the MAIN-world hook: the audio filter for each
  // reel's soundtrack, the frame grabber for its video track (which is how it
  // describes reels the page hasn't mounted a <video> for). Installed before
  // the first scan so no manifest goes past unheard — but only when frames are
  // actually being sent, so a disabled feature costs nothing.
  if (USE_MID_REEL_FRAME) installFrameSources();

  // Reel lengths, for the chooser's rows and the paused card. Installed
  // unconditionally: it's one passive listener, and collecting lengths from the
  // first response on means a rotation into the fullscreen flow finds them
  // already there rather than starting blank.
  installDurationSource();

  // Install the audio filter once (its hook listener is harmless when idle) and
  // seed it with any persisted terms; scan() then feeds it discovered reels.
  audioController = installAudioFilter();
  const applyAudioTerms = (stored: unknown): void => {
    audioTerms = Array.isArray(stored) ? stored.filter((x): x is string => typeof x === 'string') : [];
    audioController?.setCategories(audioTerms);
  };
  void (async () => {
    const data = await chrome.storage.local.get(AUDIO_TERMS_KEY);
    applyAudioTerms(data[AUDIO_TERMS_KEY]);
  })();
  // Terms are edited in the settings panel, which is a different content script
  // in this same page. Storage is the channel between them: pick up edits live
  // so a newly-added term starts filtering the reels already on screen
  // (setCategories re-runs analysis for anything not yet hidden).
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[AUDIO_TERMS_KEY]) return;
    applyAudioTerms(changes[AUDIO_TERMS_KEY].newValue);
  });

  syncForLocation();
  // Long enough for Instagram to have mounted its first screenful, short enough
  // that it's still on screen when the report lands.
  setTimeout(reportDiscovery, DISCOVERY_REPORT_MS);
  window.addEventListener('resize', onViewportResize);
  // The rail scrolls with the reel it belongs to.
  window.addEventListener('scroll', positionPanel, { passive: true, capture: true });

  // Instagram lazy-mounts reels as you scroll AND swaps routes client-side with
  // no reload. One observer covers both: re-sync when the path changed, then
  // (only on a reels page) rescan for newly mounted reels.
  new MutationObserver(() => {
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      syncForLocation();
    }
    if (onReelsPage()) scheduleScan();
  }).observe(document.documentElement, {
    childList: true,
    subtree: true,
  });

  // Back/forward navigation may not mutate the DOM immediately.
  window.addEventListener('popstate', () => {
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      syncForLocation();
    }
  });
}

// Self-guard by hostname. The extension manifest already scopes this bundle to
// instagram.com, but the iOS app injects every platform's scripts into one
// WKWebView regardless of site — without this the observer and audio filter
// would run on X and LinkedIn too.
// Regex mirrors src/shared/platforms.ts PLATFORM_RUNTIME.instagram.hostPattern.
if (/(^|\.)instagram\.com$/i.test(location.hostname)) {
  void boot().catch(err => console.error('[Bouncer IG] boot failed:', err));
}
