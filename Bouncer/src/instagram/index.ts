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
import {
  clipForDescribe, installAudioFilter, type AudioFilterController,
} from './audiofilter';
import { showIntro } from './intro';
import { showBouncePopup, showDemoBouncePopup, dismissBouncePopup } from './bounce';
import { captureMidFrame, installFrameSources } from './frame';
import { playSwipe, playTap, addDemoPhrase, removeDemoPhrase, clearDemoArtifacts } from './demo';
import { railAnchoredBox, clampLeft, isNarrowViewport } from './layout';
import { fitReels, installFitWatcher, unfitAll, fitReport, visibleHeight } from './fit';
import { installPromoDismisser } from './promo';
import { installTopBarHider } from './topbar';
import {
  durationFor, noteDuration, probeDuration, onDurationResolved, durationReport,
  installDurationSource, requestHookReplay,
} from './durations';
import { buildRecords, creatorReport, forgetAll, remember, type ReelRecord } from './library';
import { installSuggestions, type Suggestions } from './suggest';
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

// DEMO SWITCH. Set back to false to return to AI descriptions everywhere.
//
// While it is on, every surface that would show an inferred phrase shows the
// poster's own caption instead, and no reel is sent for description at all —
// so there is no backend spend, no audio clip fetched per reel, and nothing to
// wait for. A row is right the first time it is painted.
//
// The one thing it costs is what the descriptions were FOR: a caption is what
// the poster wanted to say, not what the reel is, and a reel posted with no
// caption has nothing to show. Both are fine for a demo and neither is fine
// as the product, which is why this is a switch rather than a deletion.
const SHOW_CAPTIONS_NOT_DESCRIPTIONS = true;

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

// A reel cover thumbnail: empty alt + served from Instagram's media CDN, and
// not the audio chip. The first two separate a cover from most of the page —
// profile pictures carry the account name in `alt` and home-feed photos carry a
// description.
//
// It USED to also require aria-hidden="true", and that one condition switched
// the whole feature off in the iOS app: Instagram's mobile web sets aria-hidden
// on none of its images, so nothing ever matched, no reels were discovered, and
// every surface downstream went quiet at once. Measured on device — of 19
// images on a reels page, 19 were on the CDN and 0 were aria-hidden.
//
// The audio clause is the newer scar, and a subtler one. The little disc in the
// "original audio" pill at the foot of every reel is also an unlabelled CDN
// image — the comment here used to claim it carries alt="Audio image", and on
// mobile web it does not; that text is the LINK's, not the image's. So it
// passed, and being earlier in document order than the cover on some cards, it
// became the reel's thumbnail.
//
// Nothing looked wrong: for original audio the disc is the reel's own artwork,
// so the rows showed the right picture. But it is a different ASSET with a
// different id, and every id in this pipeline is derived from that filename —
// so the reel's length, which Instagram had already told us and which is keyed
// by the real cover, could never be found. The report read "9 lengths known, 0
// of 6 reels have one" with two unrelated filenames side by side.
//
// The audio disc is handled by RANKING rather than by exclusion — see
// coverRank. A card that somehow has nothing else is still better discovered
// with the wrong thumbnail than not discovered at all.
//
// cardFromCover() is the second filter — an image with no single-<video>
// ancestor isn't a reel however it's labelled — and coverRank is the third.
function isCoverImg(img: HTMLImageElement): boolean {
  return (
    (img.getAttribute('alt') ?? '') === '' &&
    /cdninstagram\.com/.test(img.src)
  );
}

/** How much this image looks like the reel's own cover rather than a chip on
 *  top of it. Higher wins; compared only against other candidates on the same
 *  card.
 *
 *  Two signals, in order. The audio pill's disc is disqualifying on its own —
 *  it is structurally identifiable, sitting inside a link to the sound. Size
 *  settles everything else: the cover fills the card and every other image on a
 *  reel is a chip. Rendered size where there is one, the file's own dimensions
 *  where there isn't, because a reel below the fold may not be laid out yet. */
function coverRank(img: HTMLImageElement): number {
  const chip = img.closest('a[href*="/reels/audio/"], a[href*="/explore/tags/"]') !== null;
  const rect = img.getBoundingClientRect();
  const area = rect.width * rect.height > 1
    ? rect.width * rect.height
    : img.naturalWidth * img.naturalHeight;
  return (chip ? 0 : 1e9) + area;
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

// Collapsed form: a round-square button wearing the extension icon. Sized to sit
// in the action rail's column without out-weighing the like/comment/share glyphs
// it stacks on top of — at 40px it read as a badge stuck over the reel rather
// than as one more control in Instagram's own column.
const COLLAPSED_SIZE_PX = 28;
/** How close to the edge the collapsed icon may sit. See positionPanel. */
const ICON_MARGIN_PX = 4;

let currentTextEl: HTMLElement | null = null;
let upcomingListEl: HTMLElement | null = null;
// Upcoming reel ids currently displayed — so only newly-arrived rows animate in.
let shownUpcomingIds = new Set<string>();
// Whether content.js has asked us to stay hidden (the filtered-posts view is
// up). Sticky across remounts so navigating within reels keeps it.
let describerHidden = false;
// Whether the chooser's glass is up. The settings icon is pinned above
// everything else we mount, which includes the glass — and the glass is meant to
// carry nothing but the three rows.
let chooserOpen = false;
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
// scrolling doesn't hand you the next reel — it raises a sheet of what's next
// to choose from, over the reel you're watching. See ./suggest.ts. The panel
// isn't mounted at that width; its collapsed icon holds the top-right corner so
// settings stay reachable, and the "Up next" pill sits at the bottom.
//
// Above that width nothing here runs and the panel is byte-for-byte what it was.

// Whether the describer has a surface mounted, in either shape. This is tracked
// rather than derived from the DOM because what gets mounted now varies, and
// "is #bouncer-ig-frame in the DOM" can no longer answer it on its own.
let describerActive = false;

let suggestions: Suggestions | null = null;

/** How long a description may wait on its soundtrack before going without one.
 *
 *  Short on purpose. Reel categorization moved onto the audio queue, which is
 *  one worker on one GPU also carrying the filter-terms traffic — so queue wait
 *  is now the dominant cost and anything we add in front of it is felt twice.
 *  Extraction that misses this deadline is not wasted: it finishes into the
 *  cache and the next describe of that reel picks it up. */
const AUDIO_CLIP_DEADLINE_MS = 1_200;

// How much caption to keep. The row line-clamps to three lines and does the
// real fitting, so this only has to be comfortably more than can show — enough
// that CSS decides where to stop, without holding a 2,200-character caption in
// a text node to display sixty characters of it.
const CAPTION_SNIPPET_MAX = 160;

/** The caption, tidied enough to stand in as a row's description.
 *
 *  A caption is not a description — it's what the poster wanted to say, not
 *  what the reel is — but it is written about this reel by someone who watched
 *  it, and a row carrying the poster's own first sentence is a far better
 *  answer to "what is this" than a row that says it's still thinking. */
function captionSnippet(card: HTMLElement): string | null {
  const raw = captionFromCard(card);
  if (!raw) return null;

  // Captions are written with hard line breaks, and each one would eat one of
  // the three lines the row has.
  let text = raw.replace(/\s+/g, ' ').trim();
  // Instagram's own "… more" expander sits INSIDE the caption block, so it
  // arrives as part of its text — and on a row it reads as though the poster
  // had typed it. Measured on the live feed: five of seven captions ended
  // "… more". The ellipsis is kept, because at that point the caption really
  // is cut short; only the word that was a button goes.
  text = text.replace(/\s*(?:…|\.\.\.)\s*more\s*$/i, '…').trim();
  // The trailing hashtag pile says less about the reel than the words in front
  // of it, and those are what there's room for. Only stripped from the END —
  // a hashtag mid-sentence is part of the sentence.
  text = text.replace(/(?:\s*#[^\s#]+)+$/u, '').trim();
  if (!text) return null;
  if (text.length <= CAPTION_SNIPPET_MAX) return text;

  // Cut on a word boundary so the clamp doesn't land mid-word.
  const cut = text.slice(0, CAPTION_SNIPPET_MAX);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > CAPTION_SNIPPET_MAX / 2 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

// Captions, kept once read. Same reason ./library.ts keeps creators: Instagram
// recycles a card as you move away from it, and a caption read late describes
// a different reel or nothing at all. Filled lazily rather than on a sweep —
// the first surface that asks for a reel it can still see is the cheapest
// possible moment, and costs nothing for reels nobody looks at.
const captions = new Map<string, string>();

/** The poster's own words for this reel, from the card while it is still there
 *  and from memory once it isn't. */
function captionFor(reel: Reel): string | null {
  const kept = captions.get(reel.reelId);
  if (kept !== undefined) return kept;
  const fresh = reel.card.isConnected ? captionSnippet(reel.card) : null;
  if (fresh !== null) captions.set(reel.reelId, fresh);
  return fresh;
}

/** What a chooser row says this reel is.
 *
 *  Which of the two comes first is SHOW_CAPTIONS_NOT_DESCRIPTIONS's whole job;
 *  either way the other is the fallback, so a reel with no caption still shows
 *  a phrase if one happens to be cached, and vice versa. */
function describeOrCaption(reel: Reel): string | null {
  if (!SHOW_CAPTIONS_NOT_DESCRIPTIONS) return descriptionFor(reel) ?? captionFor(reel);
  // Never null in captions mode. A row given nothing falls back to
  // "Describing…" (see ./library.ts), which with inference switched off would
  // be a row promising something that is never coming — and plenty of reels
  // are posted with no caption at all.
  return captionFor(reel) ?? descriptionFor(reel) ?? 'No caption';
}

/** The same choice for the floating panel, which shows one phrase per row and
 *  no fallback: with the switch on it is the caption, off it is the inferred
 *  phrase and a row stays blank until that arrives. */
function panelPhrase(reel: Reel): string | null {
  return SHOW_CAPTIONS_NOT_DESCRIPTIONS ? captionFor(reel) : descriptionFor(reel);
}

/** The reels the chooser can offer, resolved into rows it can render.
 *
 *  From the one you're watching onward, and no further back. The chooser used to
 *  be a window you could slide back through your own history, which is why every
 *  reel ever seen was kept renderable; it isn't any more, and a row for a reel
 *  behind you is a row nothing will ever show. Reels Instagram has recycled out
 *  of the DOM are still listed — they're ahead of you, they just can't be
 *  navigated to — and are marked unreachable. */
function suggestionRecords(): ReelRecord[] {
  // Lengths first. A row's length can only come from a source that has answered
  // by the time it renders, and the cheapest of them — a mounted <video>'s own
  // `duration` — becomes readable at an arbitrary moment with no event we are
  // guaranteed to see. Re-reading here costs a property access per known reel
  // and means a row shows a length the first render after one exists.
  harvestDurations();
  // Anything still missing was already asked for at discovery — see
  // warmDurations — so there is nothing to kick off here.
  //
  // Sliced at the reel on screen: everything behind it is history the chooser
  // has no way to show, and building a row for it means scraping a byline off a
  // card Instagram recycled long ago.
  return buildRecords(orderedReels.slice(Math.max(0, activeIndex())), describeOrCaption);
}

/** Where the reel on screen sits in the feed, or -1 before one is known. */
function activeIndex(): number {
  return activeReelId === null
    ? -1
    : orderedReels.findIndex((r) => r.reelId === activeReelId);
}

function mountSuggestions(): void {
  suggestions = installSuggestions({
    records: suggestionRecords,
    // Instant, not smooth: a smooth scroll would be a journey through reels the
    // user didn't choose — each one becoming active in turn on the way past —
    // and the chooser's own flight animation is what covers the jump.
    goTo: (record) => {
      suppressBounceDismissOnce = true;
      record.card.scrollIntoView({ behavior: 'auto', block: 'center' });
    },
    setChromeHidden: (hidden) => {
      chooserOpen = hidden;
      applyPanelVisibility();
    },
  });
  suggestions.refresh();
  describerActive = true;
}

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
  if (panel) panel.style.display = describerHidden || chooserOpen ? 'none' : '';
}

// content.js drives the describer's visibility: hidden while the settings popup
// or the filtered-posts view is open, shown again once they close.
window.addEventListener(DESCRIBER_EVENT, (e) => {
  const show = (e as CustomEvent<{ show?: boolean }>).detail?.show ?? true;
  describerHidden = !show;
  applyPanelVisibility();
  // The chooser's sheet has no persistent element for applyPanelVisibility to
  // toggle, so it's pulled down explicitly rather than left floating over
  // content.js's own overlay.
  if (fullscreenFlow() && describerHidden) suggestions?.close();
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

/** Whether Bouncer's own chrome is already on screen, native and below the page.
 *
 *  In the iOS app the reel is a WebView with a real toolbar under it, carrying
 *  the Bouncer button that opens the filter sheet. A second Bouncer button
 *  floating over the reel is then the same door twice — and the floating one is
 *  the worse of the two: it sits on top of the video, it duplicates a control
 *  the platform already gave us, and the settings page it opens is a web
 *  rendering of a sheet the app draws properly.
 *
 *  On the desktop extension there is no toolbar and no sheet, so the icon is the
 *  only way in and it stays. The message handler is the iOS bridge (see
 *  ChromePolyfill.js) — its presence IS the native app. */
function hasNativeChrome(): boolean {
  const bridge = (window as unknown as {
    webkit?: { messageHandlers?: Record<string, unknown> };
  }).webkit?.messageHandlers;
  return typeof bridge?.feedfilterLog !== 'undefined';
}

// Collapsed panel: just the extension icon, same corner, click opens settings.
// This is what "intentional scrolling off" looks like — Bouncer is still
// filtering the feed, it just isn't narrating what's coming.
function mountCollapsed(parent: HTMLElement): void {
  // Not in the app: the toolbar under the page already has this button, wired
  // to the native filter sheet. See hasNativeChrome.
  if (hasNativeChrome()) {
    describerActive = true;
    return;
  }
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
    'border-radius: 8px',
    'overflow: hidden',
    'background: transparent',
    'box-shadow: 0 2px 8px rgba(0,0,0,0.18)',
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
interface RailAnchor {
  /** The like button's box — what the panel is placed against. */
  rect: DOMRect;
  /** The centre line of the like GLYPH itself.
   *
   *  Not the same as the button's centre, and that difference is the whole
   *  reason this is measured separately: the tappable box around the heart is
   *  padded, and not always evenly — it is a flex child with its own margins in
   *  a column that also holds a count. Centring on the box put the icon a few
   *  pixels off the line every other glyph in the rail sits on, which is exactly
   *  the kind of miss that reads as sloppy rather than as a bug. The <svg> is
   *  the drawn thing, so the <svg> is what to line up with. */
  glyphCenterX: number;
}

/** The like glyph, however Instagram has labelled it this week.
 *
 *  Was an exact match on `aria-label="Like"`. That label is localised — and
 *  changes to "Unlike" the moment you tap it, and to other wordings on other
 *  surfaces — so on any account not running in English the rail was simply never
 *  found. See `positionPanel` for what that looked like. */
const LIKE_LABEL = /^(un)?like$/i;

function likeGlyphs(): Element[] {
  const found: Element[] = [];
  for (const svg of document.querySelectorAll('svg[aria-label]')) {
    const label = svg.getAttribute('aria-label')?.trim() ?? '';
    if (LIKE_LABEL.test(label)) found.push(svg);
  }
  return found;
}

function actionRailRect(): RailAnchor | null {
  const middle = window.innerHeight / 2;
  let best: RailAnchor | null = null;
  for (const icon of likeGlyphs()) {
    const rect = icon.closest('div[role="button"], button, span')?.getBoundingClientRect();
    if (!rect || rect.width === 0) continue;
    // Must actually be on screen — an off-screen rail is a reel we've left.
    if (rect.bottom < 0 || rect.top > window.innerHeight) continue;
    const glyph = icon.getBoundingClientRect();
    const glyphCenterX = glyph.width > 0 ? glyph.left + glyph.width / 2 : rect.left + rect.width / 2;
    // Of those, the one nearest the middle belongs to the reel being watched.
    if (!best || Math.abs(rect.top - middle) < Math.abs(best.rect.top - middle)) {
      best = { rect, glyphCenterX };
    }
  }
  return best;
}

/** Sit the panel just above the like button and share its column, so it reads
 *  as part of the page's own layout rather than something bolted to the corner.
 *  Falls back to the top-right inset when the rail can't be found (a non-reels
 *  route, or markup that's moved on). */
/** Whether the panel has ever been placed against a real rail.
 *
 *  Instagram recycles the action rail constantly — on every scroll, every route
 *  change, every re-render — so `actionRailRect` returns null for a frame or two
 *  at a time in the ordinary course of things. Jumping to the corner on each of
 *  those and back again is what made the icon look like it was wandering around
 *  the screen under its own power. A momentary loss of the anchor is not news;
 *  the last good position is still the best guess, and staying put is what the
 *  page itself appears to do. */
let hasBeenAnchored = false;

function positionPanel(): void {
  const panel = document.getElementById(FRAME_ID);
  if (!panel) return;
  const anchor = actionRailRect();
  if (!anchor) {
    // Only fall back to the corner if we have never had anywhere better. After
    // that, hold the last placement and wait for the rail to come back.
    if (hasBeenAnchored) return;
    panel.style.left = 'auto';
    panel.style.right = '20px';
    panel.style.top = '20px';
    panel.style.bottom = 'auto';
    return;
  }
  hasBeenAnchored = true;
  // Only the expanded panel is text-width; the collapsed form is a fixed-size
  // button and must not be stretched by a resize or a scroll — so it is clamped
  // at its own width instead of being measured for one.
  const rail = anchor.rect;
  let left: number;
  if (panel.tagName !== 'BUTTON') {
    const box = railAnchoredBox(rail.left, PANEL_WIDTH_PX);
    panel.style.width = `${box.width}px`;
    left = box.left;
  } else {
    // Centred on the like GLYPH rather than sharing the button's left edge. The
    // panel is text and wants the column's left margin; the icon is a glyph
    // among glyphs, and one that doesn't share their centre line reads as
    // misaligned however close it is.
    //
    // Clamped to a hairline margin rather than the viewport inset the panel
    // uses. On a phone the rail is overlaid on the reel's right edge, so the
    // like glyph sits within the 20px inset — and the clamp, meant to keep a
    // wide panel on screen, was quietly pushing the icon left off the centre
    // line it had just been placed on. The only thing that matters for a 28px
    // button is that it is all on screen.
    const width = panel.offsetWidth || COLLAPSED_SIZE_PX;
    left = clampLeft(anchor.glyphCenterX - width / 2, width, window.innerWidth, ICON_MARGIN_PX);
  }
  panel.style.left = `${left}px`;
  panel.style.right = 'auto';
  panel.style.top = 'auto';
  // Sat just above the like button, and clamped at BOTH ends. The upper bound
  // is the safety net that stops a stale or oddly-placed rail from parking the
  // panel above the viewport where it silently vanishes.
  //
  // The lower bound is measured against what you can SEE, not against
  // `innerHeight`. `bottom` resolves against the layout viewport, which on iOS
  // runs behind Safari's chrome and behind Bouncer's own bottom bar — so a flat
  // 20px lower bound was a promise about a strip of screen that is covered up.
  // Anything clamped to it landed underneath the bar, which looks exactly like
  // the icon having wandered off on its own.
  const hidden = Math.max(0, window.innerHeight - visibleHeight());
  const minBottom = hidden + 20;
  const desired = window.innerHeight - rail.top + 16;
  const maxBottom = Math.max(minBottom, window.innerHeight - (panel.offsetHeight || 120) - 20);
  panel.style.bottom = `${Math.min(maxBottom, Math.max(minBottom, desired))}px`;
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

  // Phone width: the panel gives way to the collapsed icon (settings, top-right)
  // and the "Up next" pill (navigation, bottom-centre). Between them nothing
  // sits over the reel until you ask for it.
  if (isNarrowViewport()) {
    mountCollapsed(parent);
    mountSuggestions();
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
  // there is a panel mounted to show the result in. Skipped entirely at phone
  // width: the chooser's rows are fed by the prefetch the IntersectionObserver
  // already does, so pushing the slice again would only duplicate it.
  if (!fullscreenFlow()) {
    for (const reel of [current, ...upcoming]) {
      if (reel) void describeReel(reel);
    }
  }

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
    : current ? panelPhrase(current) : null;
  const upcomingResolved: PanelEntry[] = demoDescriptions
    ? demoDescriptions
        .map((desc, i) => ({ key: `demo-${i}`, desc, reel: null, i }))
        .filter(x => x.i > 0 && x.i !== demoSwipedIndex)
        .slice(0, UPCOMING_COUNT)
    : upcoming.flatMap((r): PanelEntry[] => {
        const desc = panelPhrase(r);
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
  // Nothing to ask for while captions are what's on screen. This is the line
  // that makes the switch free rather than merely invisible: no request per
  // reel, no audio clip fetched and transcoded to go with it, and no queue to
  // wait behind. Every caller already treats an empty answer as "no phrase".
  if (SHOW_CAPTIONS_NOT_DESCRIPTIONS) return '';

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
      // The third modality. Raced against a short deadline rather than
      // awaited: the backend's own guidance is to send without audio rather
      // than delay, and a description the user is waiting to read is the wrong
      // place to block on a CDN fetch. A clip that misses this window is still
      // cached, so the same reel described again gets it.
      const clip = await clipForDescribe(reel.thumbnailUrl, AUDIO_CLIP_DEADLINE_MS);
      if (clip) {
        console.debug(
          `[Bouncer IG] audio: ${clip.base64.length} b64 chars (${clip.format})`,
          reel.reelId);
      }

      const message: ContentToBackgroundMessage = {
        type: 'analyzeReel',
        caption,
        thumbnailUrl: reel.thumbnailUrl,
        ...(frame?.ok ? { frameBase64: frame.base64 } : {}),
        ...(clip ? { audioBase64: clip.base64, audioFormat: clip.format } : {}),
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
      // A visible slot may have been waiting on this phrase. Both surfaces:
      // refreshPanel returns early in the phone-width flow (no panel is
      // mounted there), so without the second call a chooser row that opened
      // saying "Describing…" would still say it once the phrase had arrived.
      refreshPanel();
      suggestions?.refresh();
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

// ==================== Which feed these reels belong to ====================
//
// The element the tracked cards hang from — and the answer to "the preview
// pulls from the wrong page".
//
// Instagram's own bottom navigation (Home, Reels, Search, Profile) is a
// client-side route change: leaving Reels UNMOUNTS the whole reels list and
// coming back builds a new one. Every card discovered before that belongs to
// the list we left, and nothing was dropping them — so the chooser went on
// offering reels from a feed that no longer existed, with lengths and bylines
// scraped from it. Seen on device: "2 reels tracked, active=none, 0 <video> on
// page" while the byline scraper was reading a home-feed post out of the
// leftovers ("24 minutes ago", "Boston, Massachusetts").
//
// The URL cannot answer this. On the reels feed the path changes on EVERY
// swipe — each reel has its own permalink — so resetting on a route change
// would forget the feed continuously as you watched it. The container does
// answer it: it is stable for the life of one feed and a different object for
// the next one.
let feedRoot: HTMLElement | null = null;

/** Drop everything known about the feed, leaving the surfaces mounted.
 *
 *  Lighter than removePanel(): the panel, the chooser and the listeners all
 *  survive, because the feature is not going away — only the list it is
 *  describing is. */
function forgetReels(reason: string): void {
  console.warn(`[Bouncer IG] feed reset (${reason}): dropping ${orderedReels.length} tracked reel(s)`);
  observer.disconnect();
  for (const reel of orderedReels) cards.delete(reel.card);
  ratios.clear();
  orderedReels.length = 0;
  activeReelId = null;
  forgetAll();
  captions.clear();
  lastRenderKey = '';
  lastCurrentDesc = null;
  shownUpcomingIds = new Set();
}

/** Let go of reels whose card Instagram has taken out of the document, when
 *  the feed they belonged to has gone with them.
 *
 *  Deliberately NOT every disconnected card: Instagram recycles cards
 *  constantly within a live feed, and a reel a few places ahead is usually
 *  unmounted while still being a perfectly good thing to offer — the chooser
 *  can reach it by swiping without ever touching its card. Only when the
 *  container itself is gone is the reel unreachable rather than merely
 *  unmounted. */
function pruneDeadReels(): void {
  if (feedRoot?.isConnected !== false) return;
  forgetReels('the feed container left the document');
  feedRoot = null;
}

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

/** The reel card actually painted at the middle of the screen, or null when
 *  the page will not say.
 *
 *  The IntersectionObserver cannot answer this on the layout the device
 *  actually uses, and its own logs are what showed it: every reel card reports
 *  the same 660h@0 box, so all nine of them are fully intersecting the viewport
 *  at once, every ratio is 1, and "the most visible card" quietly degrades to
 *  whichever the Map happens to yield last — a constant, unrelated to what is
 *  on screen.
 *
 *  That is what anchored the chooser to a reel the user was not watching. Five
 *  picks in a row reported the same anchor while the feed had plainly moved on,
 *  so the three rows it offered were not what came next, and picking one
 *  travelled somewhere nobody had asked to go — including backwards, which is
 *  what "it goes back to the original reel" was.
 *
 *  Hit-testing is the only thing that knows which of a stack is in front. Same
 *  primitive the chooser steers by (visibleRecord in ./suggest.ts), asked here
 *  about the feed rather than about a journey. */
function paintedCard(): HTMLElement | null {
  const stack = document.elementsFromPoint?.(
    Math.round(window.innerWidth / 2),
    Math.round(window.innerHeight / 2),
  ) ?? [];
  for (const el of stack) {
    for (const reel of orderedReels) {
      if (reel.card.isConnected && reel.card.contains(el)) return reel.card;
    }
  }
  return null;
}

// Pick the most-visible card as the active reel and re-render the panel around
// it. refreshPanel kicks off inference for the active reel and the next
// UPCOMING_COUNT, and re-runs itself as each phrase resolves.
function updateActive(): void {
  // Nothing that happens while the chooser is up changes which reel you are on.
  //
  // It can't: the feed is pinned, and the only thing moving it is the chooser
  // itself, walking to the end of the list to make Instagram load more. But the
  // observer doesn't know that — it sees the last reel in the feed fill the
  // screen and reports it as the one being watched, and since the chooser offers
  // what comes AFTER the reel you're on, "the last one" leaves nothing to offer.
  // The glass said "Nothing else loaded yet" within a second of every opening.
  //
  // You change reels by picking one, which closes the chooser first.
  if (chooserOpen) return;

  let bestCard: HTMLElement | null = null;
  let bestRatio = ACTIVE_RATIO;
  let claiming = 0;
  for (const [card, ratio] of ratios) {
    if (ratio < ACTIVE_RATIO) continue;
    claiming++;
    if (ratio >= bestRatio) {
      bestRatio = ratio;
      bestCard = card;
    }
  }
  // More than one card claiming the screen means the ratios cannot tell them
  // apart, and on the layout the device actually uses that is every card at
  // once — so ask what is PAINTED instead. See paintedCard.
  if (claiming > 1) bestCard = paintedCard() ?? bestCard;
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
  if (fullscreenFlow()) suggestions?.onActiveReelChanged();
  refreshPanel();
}

// ==================== Scan loop ====================

function scan(): void {
  if (!onReelsPage()) return;   // debounced scans can fire just after nav away

  // Before anything is read: is the feed we are describing still there? See
  // feedRoot — Instagram's own navigation unmounts it wholesale.
  pruneDeadReels();

  // The BIGGEST qualifying image on each card, not the first one in document
  // order. A card can carry more than one unlabelled CDN image and the reel's
  // cover is the one that fills it — everything else on a reel is a chip. Taking
  // whichever came first is how the audio disc got to be a reel's thumbnail (see
  // isCoverImg); size is the property that can't be confused.
  const best = new Map<HTMLElement, HTMLImageElement>();
  for (const img of Array.from(document.images)) {
    if (!isCoverImg(img)) continue;
    const card = cardFromCover(img);
    if (!card || cards.has(card)) continue;
    const rival = best.get(card);
    if (!rival || coverRank(img) > coverRank(rival)) best.set(card, img);
  }

  // Whose feed are these? A new card in a subtree unrelated to the one we have
  // been tracking is Instagram having rebuilt the list under us — the tab
  // switch again, caught on the way back in rather than on the way out.
  // Relatedness rather than equality, so a wrapper appearing or disappearing
  // between the card and the list is not mistaken for a new feed.
  const container = best.size > 0 ? [...best.keys()][0].parentElement : null;
  if (container && feedRoot && container !== feedRoot
      && !feedRoot.contains(container) && !container.contains(feedRoot)) {
    forgetReels('Instagram rebuilt the reels list');
  }
  if (container) feedRoot = container;

  for (const [card, img] of best) {
    const reel: Reel = { reelId: reelIdFromUrl(img.src), card, thumbnailUrl: img.src };
    cards.add(card);
    cardToReel.set(card, reel);
    insertOrdered(reel);
    observer.observe(card);
    // Feed the same discovery to the audio filter (it prefetches + hides on a
    // match before the reel is reached).
    audioController?.onReelDiscovered(reel.reelId, reel.card, reel.thumbnailUrl);
    // Read the creator off the card NOW: Instagram recycles cards as you move,
    // so a later read may be describing a different reel, or nothing at all.
    remember(reel);
  }
  // Bring any reel that stands taller than the screen back inside it. Done
  // here because a reel is laid out when Instagram mounts it, which is the same
  // beat that makes it discoverable. See ./fit.ts.
  fitReels(orderedReels.map((r) => r.card));
  harvestDurations();
  warmDurations();
  // Which reel is on screen, re-asked on every scan.
  //
  // The IntersectionObserver is the only other thing that asks, and it fires
  // on threshold CROSSINGS — which on a stacked pager never happen: every card
  // sits in the same box, so moving between slides changes nobody's ratio and
  // the callback is simply never called again. The active reel would then be
  // whatever it was when the cards were first observed, for the rest of the
  // session. Instagram mutates the DOM heavily when it changes slide (it mounts
  // and recycles videos), so the scan loop is exactly the beat that notices.
  updateActive();
  suggestions?.refresh();
  // Newly discovered reels may fill empty "up next" slots.
  refreshPanel();
}

// ==================== Reel lengths, from the DOM ====================
//
// ./durations.ts documents two sources for a reel's length: Instagram's API
// payloads via the MAIN-world hook, and a mounted <video>'s own `duration`.
// Only the first was ever wired up — `noteDuration` had no caller outside the
// tests — so on a feed whose payloads carry no `video_duration` (which is what
// the on-device report showed: 0 of 2 reels had a length) there was nowhere
// else for a length to come from, and the chooser rendered every row without
// one.
//
// This is the missing half. It's a sweep rather than a per-video listener
// because Instagram mounts and recycles <video> elements constantly: a listener
// per element would have to be tracked and torn down, whereas re-reading the
// reels we already know about costs a property read each and is idempotent.
// `durationFor` is checked first so a reel is only read until it has an answer.

/** Go and get the lengths we don't have yet, before anything asks for them.
 *
 *  The chooser's rows are always reels you have NOT reached, which is exactly
 *  the set with no mounted <video> to measure — so asking at render time meant
 *  the first time you opened it there was nothing to show, and the lengths
 *  turned up only once you had moved on and come back. That was the report:
 *  "the times only appear after I've clicked another reel".
 *
 *  So the asking moves to discovery. Each reel is probed once, ever, the moment
 *  we learn it exists — which is many seconds before the glass can show it —
 *  and by the time it does the number is already in hand. */
function warmDurations(): void {
  for (const reel of orderedReels) {
    if (durationFor(reel.thumbnailUrl) !== null) continue;
    void probeDuration(reel.thumbnailUrl).then((found: boolean) => {
      if (found) suggestions?.refresh();
    });
  }
}

/** Read `duration` off any mounted reel <video> we don't have a length for. */
function harvestDurations(): void {
  for (const reel of orderedReels) {
    if (durationFor(reel.thumbnailUrl) !== null) continue;
    if (!reel.card.isConnected) continue;
    const video = reel.card.querySelector('video');
    if (!(video instanceof HTMLVideoElement)) continue;
    // NaN until metadata lands, Infinity for a live stream — both are "not yet".
    if (!Number.isFinite(video.duration) || video.duration <= 0) continue;
    noteDuration(reel.thumbnailUrl, video.duration);
  }
}

/** A reel's metadata arriving is the moment its length becomes readable, and it
 *  may land without any DOM mutation to trigger the scan loop. Capture-phase on
 *  document because media events do not bubble. */
function watchForDurations(): void {
  const onReadable = (): void => {
    harvestDurations();
    suggestions?.refresh();
    refreshPanel();
  };
  document.addEventListener('loadedmetadata', onReadable, true);
  document.addEventListener('durationchange', onReadable, true);
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
/** When to print the lengths timing line, in ms after boot. */
const LENGTH_REPORT_MS = [8_000, 20_000, 45_000] as const;
let reportedDiscovery = false;

/** Just the lengths, repeatedly. `durationReport` carries the wait statistics:
 *  how many rows rendered with a blank where the time goes, how long they
 *  stayed that way, and which source eventually answered. */
function reportLengths(): void {
  if (!onReelsPage()) return;
  const withLength = orderedReels.filter((r) => durationFor(r.thumbnailUrl) !== null).length;
  console.warn(
    `[Bouncer IG] lengths: ${withLength}/${orderedReels.length} reels have one. `
    + durationReport(orderedReels.map((r) => r.thumbnailUrl)));
}

function reportDiscovery(): void {
  if (reportedDiscovery || !onReelsPage()) return;
  reportedDiscovery = true;

  const images = Array.from(document.images);
  let unlabelled = 0;
  let onCdn = 0;
  let covers = 0;
  let carded = 0;
  // Unlabelled CDN images inside the audio pill: they pass the cover test and
  // are never the cover. See coverRank.
  let audioChips = 0;
  const samples: string[] = [];
  for (const img of images) {
    // Both halves reported separately, but the verdict is isCoverImg ITSELF.
    // This used to re-implement the test with an extra `aria-hidden="true"`
    // clause that isCoverImg dropped long ago, so the report announced "0
    // passed the cover test" on a page where discovery was in fact working —
    // sending us after a discovery bug that did not exist. A diagnostic that
    // paraphrases the thing it measures is worse than no diagnostic.
    const isUnlabelled = (img.getAttribute('alt') ?? '') === '';
    const isCdn = /cdninstagram\.com/.test(img.src);
    if (isUnlabelled) unlabelled++;
    if (isCdn) onCdn++;
    if (isCoverImg(img)) {
      covers++;
      if (cardFromCover(img)) carded++;
      if (img.closest('a[href*="/reels/audio/"]')) audioChips++;
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

  // Lengths have two independent sources — Instagram's API payloads via the
  // hook, and mounted <video> elements — so when one is missing, which of them
  // came up short is the whole question.
  const withLength = orderedReels.filter((r) => durationFor(r.thumbnailUrl) !== null).length;
  const active = activeReelId === null
    ? null
    : orderedReels.find((r) => r.reelId === activeReelId) ?? null;
  const activeVideo = active?.card.querySelector('video');
  const activeState = activeVideo instanceof HTMLVideoElement
    ? `duration=${activeVideo.duration} readyState=${activeVideo.readyState}`
    : 'no <video> mounted';

  console.warn(
    `[Bouncer IG] lengths: ${withLength}/${orderedReels.length} reels have one. `
    + `${durationReport(orderedReels.map((r) => r.thumbnailUrl))}. `
    + `Active reel's <video>: ${activeState}`);

  console.warn(`[Bouncer IG] fit: ${fitReport(active?.card ?? orderedReels[0]?.card ?? null)}`);

  // The byline, with its working out shown — see creatorReport.
  const bylineCard = active?.card ?? orderedReels[0]?.card ?? null;
  console.warn(
    `[Bouncer IG] byline: ${bylineCard ? creatorReport(bylineCard) : 'no reel card to read'}`);

  console.warn(
    `[Bouncer IG] discovery: ${orderedReels.length} reels tracked, `
    + `active=${activeReelId ?? 'none'}, `
    + `${document.querySelectorAll('video').length} <video> on page. `
    + `Of ${images.length} images — ${unlabelled} with no alt, ${onCdn} on the IG CDN, `
    + `${covers} passed the cover test (${audioChips} were audio chips), `
    + `${carded} resolved to a card. `
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
  // The remembered placement belongs to the page being torn down.
  hasBeenAnchored = false;
  document.getElementById(FRAME_ID)?.remove();
  currentTextEl = null;
  upcomingListEl = null;
  lastRenderKey = '';
  lastCurrentDesc = null;
  shownUpcomingIds = new Set();
  suggestions?.teardown();
  suggestions = null;
  unfitAll();
  forgetAll();
  captions.clear();
  describerActive = false;
  observer.disconnect();
  ratios.clear();
  orderedReels.length = 0;
  cards = new WeakSet<HTMLElement>();
  activeReelId = null;
  // The feed this was describing is not the one we will come back to.
  feedRoot = null;
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
    // back-nav surfaces via this path too — otherwise the arrow outlives the
    // feature that owns it.
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

  // Reel lengths, for the paused card. Installed unconditionally: it's one
  // passive listener, and collecting lengths from the first response on means a
  // rotation into the phone-width flow finds them already there rather than
  // starting blank.
  installDurationSource();
  // A length arriving is a reason to re-render whatever is showing: the chooser
  // asks for these before it needs them, and the answers land on their own.
  onDurationResolved(() => {
    suggestions?.refresh();
    refreshPanel();
  });
  watchForDurations();

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

  // Every consumer of the MAIN-world hook is listening by now, so ask it for
  // what it harvested before we booted — the server-rendered first screenful,
  // which is exactly the reel the user is looking at.
  requestHookReplay();

  // Instagram's "use the app" bar, closed the way you would close it. Installed
  // outside the reels flow: it turns up on other routes too, and it is a
  // standing job rather than something the feed triggers. See ./promo.ts.
  // Instagram's own bar across the top of the Reels viewer. Removed here rather
  // than in CSS because its class names are hashed — see ./topbar.ts — and
  // scoped to the reels routes, where it is the strip of screen the reel most
  // needs and carries nothing the describer does not already offer. Elsewhere
  // that bar is the navigation, so it is put straight back.
  installTopBarHider(onReelsPage);

  // A rotation, or iOS's own chrome sliding in and out, changes how much room a
  // reel has — and the reel was sized for the old number.
  installFitWatcher(() => {
    fitReels(orderedReels.map((r) => r.card));
    positionPanel();
  });

  syncForLocation();
  // Long enough for Instagram to have mounted its first screenful, short enough
  // that it's still on screen when the report lands.
  setTimeout(reportDiscovery, DISCOVERY_REPORT_MS);
  // Lengths keep arriving long after the discovery report has printed — that is
  // the entire subject of the complaint — so the timing line repeats. Three
  // samples: one with the first screenful, one after a batch or two has landed,
  // one late enough to include anything that had to be fetched or probed.
  for (const at of LENGTH_REPORT_MS) setTimeout(reportLengths, at);
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
  // Started here rather than inside boot(), and this placement is the whole
  // fix for "the open-in-app banner is still there when I arrive".
  //
  // `boot` is async and awaits a `chrome.storage.local.get` before it reaches
  // anything — a round trip that on iOS crosses the native bridge — so the
  // banner had several hundred milliseconds of clear air on every cold open.
  // Worse, boot returns early when Instagram's platform toggle is off, and the
  // dismisser then never installed at all.
  //
  // Nothing about closing that banner depends on the toggle, the storage read,
  // or the reels route: it is a nuisance on every Instagram page, and the
  // earliest possible moment is the right one to start watching for it.
  installPromoDismisser();

  void boot().catch(err => console.error('[Bouncer IG] boot failed:', err));
}
