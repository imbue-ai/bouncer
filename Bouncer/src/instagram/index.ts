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
// anchor on structural/semantic signals (the cover <img>'s aria-hidden + empty
// alt + cdninstagram host; the longest non-link dir="auto" block for the
// caption). If IG changes its markup these heuristics are the first thing to
// revisit — they're all collected here at the top.

import type { ContentToBackgroundMessage } from '../types';
import { installAudioFilter, type AudioFilterController } from './audiofilter';
import { makeGearIcon } from '../shared/utils';
import { enabledStorageKey } from '../shared/platforms';

// Audio filter terms use their own storage key. (Bouncer filter topics for
// Instagram live under `descriptions_instagram` and are managed by the original
// Bouncer filter UI in content.js — surfaced here via the gear toggle.)
const AUDIO_TERMS_KEY = 'audioFilterTerms';
const GEAR_ORANGE = '#EA8554';

// Cross-content-script channel (both scripts share the same isolated world):
// we hand content.js an empty slot to render the real Bouncer filter box into
// (see mountExternalFilterBox in content/ui.ts), and content.js tells us to
// hide the whole panel while the filtered-posts view is up so it doesn't float
// over that overlay.
const MOUNT_FILTER_BOX_EVENT = 'bouncer-mount-filter-box';
const DESCRIBER_EVENT = 'bouncer-ig-describer';

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

// A reel cover thumbnail: empty alt + aria-hidden (decorative) + served from
// Instagram's media CDN. This deliberately excludes profile pictures (non-empty
// alt, not aria-hidden) and audio-cover images (served from fbcdn, alt="Audio
// image"), and home-feed photos (descriptive alt, not aria-hidden).
function isCoverImg(img: HTMLImageElement): boolean {
  return (
    img.getAttribute('aria-hidden') === 'true' &&
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

// Pastel accent, matching the Bouncer brand gradient — the little bar to the
// left of the currently-playing phrase.
const ACCENT_GRADIENT = 'linear-gradient(180deg, #ffc9de, #d9c2ff 55%, #b8e0ff)';

// Perimeter gradient: top + left edges solid black, right + bottom fading
// through the pastel iridescent arc. Painted as a masked 2px border.
const IRIDESCENT_BORDER = [
  'conic-gradient(from 90deg,',
  '  #ffc9de 0deg,',
  '  #ffe0b3 30deg,',
  '  #d9c2ff 65deg,',
  '  #b8e0ff 95deg,',
  '  #000000 140deg,',
  '  #000000 305deg,',
  '  #ffc9de 360deg',
  ')',
].join(' ');

const PANEL_FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';

// Upcoming rows fade with distance from the current reel (black on white).
const UPCOMING_OPACITIES = [0.7, 0.55, 0.42, 0.32];

// Fixed layout so the card never grows/shrinks with the number of resolved
// phrases: it always reserves room for the current phrase + UPCOMING_COUNT
// upcoming rows (five entries — the max). Empty slots stay blank but keep their
// height, and the gear sits in the bottom-right corner, in line with the last row.
const PANEL_WIDTH_PX = 320;
const UPCOMING_ROW_H_PX = 20;
const UPCOMING_GAP_PX = 8;
const UPCOMING_LIST_H_PX =
  UPCOMING_COUNT * UPCOMING_ROW_H_PX + (UPCOMING_COUNT - 1) * UPCOMING_GAP_PX;

let currentTextEl: HTMLElement | null = null;
let upcomingListEl: HTMLElement | null = null;
// Upcoming reel ids currently displayed — so only newly-arrived rows animate in.
let shownUpcomingIds = new Set<string>();
// Whether content.js has asked us to stay hidden (the filtered-posts view is
// up). Sticky across remounts so navigating within reels keeps it.
let describerHidden = false;

// The panel has two pages in the same card: the reel categorizer ('reels') and
// Bouncer's filter box ('filters'), which content.js renders into filtersPageEl.
// The gear flips to 'filters', the page's ✕ flips back. Nothing overlays the
// feed, so the reel keeps playing either way.
type PanelPage = 'reels' | 'filters';
let panelPage: PanelPage = 'reels';
let reelsPageEl: HTMLElement | null = null;
let filtersPageEl: HTMLElement | null = null;
let filtersSlotEl: HTMLElement | null = null;

function showPage(page: PanelPage): void {
  panelPage = page;
  if (reelsPageEl) reelsPageEl.style.display = page === 'reels' ? '' : 'none';
  if (filtersPageEl) filtersPageEl.style.display = page === 'filters' ? '' : 'none';
  // Ask content.js to (re)render the real filter box into our slot. It's
  // idempotent, so re-opening the page just refreshes counts.
  if (page === 'filters' && filtersSlotEl) {
    window.dispatchEvent(new CustomEvent(MOUNT_FILTER_BOX_EVENT, {
      detail: { host: filtersSlotEl },
    }));
  }
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
  ].join('\n');
  (document.head ?? document.documentElement).appendChild(style);
}

// Minimalist orange gear pinned to the card's bottom-right corner (in line with
// the last "up next" row). Clicking it flips the panel to the filters page.
function buildGear(): HTMLElement {
  const gear = document.createElement('button');
  gear.title = 'Open Bouncer filters';
  gear.setAttribute('aria-label', 'Open Bouncer filters');
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
  gear.appendChild(makeGearIcon(GEAR_ORANGE, 20));
  gear.onclick = () => showPage('filters');
  return gear;
}

// ✕ in the filters page's top-right corner — steps back to the categorizer.
function buildCloseButton(): HTMLElement {
  const close = document.createElement('button');
  close.title = 'Back to reel categories';
  close.setAttribute('aria-label', 'Back to reel categories');
  close.textContent = '✕';
  close.style.cssText = [
    'position: absolute',
    'top: 0',
    'right: 0',
    'width: 22px',
    'height: 22px',
    'padding: 0',
    'border: none',
    'background: transparent',
    'cursor: pointer',
    'pointer-events: auto',
    'font-size: 14px',
    'line-height: 1',
    'color: #667',
  ].join(';');
  close.onclick = () => showPage('reels');
  return close;
}

// content.js drives the describer's visibility: hidden while the settings popup
// or the filtered-posts view is open, shown again once they close.
window.addEventListener(DESCRIBER_EVENT, (e) => {
  const show = (e as CustomEvent<{ show?: boolean }>).detail?.show ?? true;
  describerHidden = !show;
  const panel = document.getElementById(FRAME_ID);
  if (panel) panel.style.display = show ? '' : 'none';
});

function mountPanel(): void {
  if (document.getElementById(FRAME_ID)) return;
  const parent = document.body ?? document.documentElement;
  if (!parent) return;
  injectPanelStyles();

  // White card. The frame has no CSS border-width, so the absolutely-positioned
  // gradient border below (inset: 0) sits flush at the card's outer edge while
  // padding insets only the text content.
  const panel = document.createElement('div');
  panel.id = FRAME_ID;
  panel.style.cssText = [
    'position: fixed',
    'top: 16px',
    'right: 16px',
    `width: ${PANEL_WIDTH_PX}px`,
    'box-sizing: border-box',
    'padding: 14px 16px',
    'border-radius: 16px',
    'background: #ffffff',
    'box-shadow: 0 6px 24px rgba(0,0,0,0.18)',
    'pointer-events: none',
    'z-index: 2147483647',
    `font-family: ${PANEL_FONT}`,
  ].join(';');

  // Masked black→iridescent gradient border (a 2px ring). Separate layer so the
  // mask trick doesn't clip the text.
  const border = document.createElement('div');
  border.style.cssText = [
    'position: absolute',
    'inset: 0',
    'border-radius: 16px',
    'padding: 2px',
    `background: ${IRIDESCENT_BORDER}`,
    '-webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)',
    'mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)',
    '-webkit-mask-composite: xor',
    'mask-composite: exclude',
    'pointer-events: none',
  ].join(';');

  // Content sits above the border layer.
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
    'color: #0a0a0a',
    'letter-spacing: 0.1px',
    'min-height: 22px',
    'min-width: 0',
    'flex: 1',
    'display: flex',
    'align-items: center',
  ].join(';');
  currentTextEl = currentText;
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

  // Page 1 — the reel categorizer.
  const reelsPage = document.createElement('div');
  reelsPage.appendChild(nowRow);
  reelsPage.appendChild(upcomingList);
  reelsPage.appendChild(buildGear());
  reelsPageEl = reelsPage;

  // Page 2 — Bouncer's own filter box, rendered by content.js into the slot.
  // The whole card is pointer-events:none so it never blocks the feed; the
  // filter box is interactive, so this page opts back in.
  const filtersPage = document.createElement('div');
  filtersPage.style.cssText = 'position: relative; pointer-events: auto';
  const filtersSlot = document.createElement('div');
  filtersPage.appendChild(filtersSlot);
  filtersPage.appendChild(buildCloseButton());
  filtersPageEl = filtersPage;
  filtersSlotEl = filtersSlot;

  content.appendChild(reelsPage);
  content.appendChild(filtersPage);
  panel.appendChild(border);
  panel.appendChild(content);
  // Respect a sticky hidden state so remounting during in-reels navigation
  // doesn't pop the panel back over the filtered-posts view.
  if (describerHidden) panel.style.display = 'none';
  parent.appendChild(panel);
  // Restore whichever page was open before a remount.
  showPage(panelPage);
}

function descriptionFor(reel: Reel): string | null {
  const entry = cache.get(reel.reelId);
  return entry && 'description' in entry ? entry.description : null;
}

// Skip re-renders (and the entrance animation) when nothing visible changed.
let lastRenderKey = '';
let lastCurrentDesc: string | null = null;

// Re-render the panel from current state: the active reel plus the RESOLVED
// phrases among the next UPCOMING_COUNT reels in feed order. Also kicks off
// inference for those reels (the per-reel cache dedupes). Called whenever the
// active reel changes and whenever any description resolves — so upcoming
// phrases pop in one by one as they return, with no placeholder bars.
function refreshPanel(): void {
  if (!currentTextEl || !upcomingListEl) return;

  const idx = activeReelId ? orderedReels.findIndex((r) => r.reelId === activeReelId) : -1;
  const current = idx >= 0 ? orderedReels[idx] : null;
  // The next reels to prefetch — kick off inference for all of them...
  const upcoming =
    idx >= 0
      ? orderedReels
          .slice(idx + 1)
          .filter((r) => r.card.isConnected)
          .slice(0, UPCOMING_COUNT)
      : [];

  for (const reel of [current, ...upcoming]) {
    if (reel) void describeReel(reel);
  }

  // ...but only render the ones that have resolved (added as they return).
  const currentDesc = current ? descriptionFor(current) : null;
  const upcomingResolved = upcoming
    .map((r) => ({ reel: r, desc: descriptionFor(r) }))
    .filter((x): x is { reel: Reel; desc: string } => x.desc !== null);

  const renderKey = JSON.stringify([
    current?.reelId ?? null,
    currentDesc,
    upcomingResolved.map((x) => [x.reel.reelId, x.desc]),
  ]);
  if (renderKey === lastRenderKey) return;
  lastRenderKey = renderKey;
  const currentChanged = currentDesc !== lastCurrentDesc;
  lastCurrentDesc = currentDesc;

  // Current phrase — blank until it resolves (no loading state).
  currentTextEl.textContent = currentDesc ?? '';
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
      `color: rgba(0,0,0,${UPCOMING_OPACITIES[i] ?? 0.3})`,
      'white-space: nowrap',
      'overflow: hidden',
      'text-overflow: ellipsis',
      'display: flex',
      'align-items: center',
      // The last slot sits at the gear's height — keep its text clear of it.
      ...(i === UPCOMING_COUNT - 1 ? ['padding-right: 30px'] : []),
    ].join(';');
    if (!entry) return row;   // blank placeholder slot

    const { reel, desc } = entry;
    row.textContent = desc;
    // Only animate rows that weren't shown last render, so already-visible
    // phrases don't re-flicker when a new one arrives.
    if (!shownUpcomingIds.has(reel.reelId)) {
      row.style.animation = 'bouncer-ig-enter 0.25s ease';
    }
    // The panel is pointer-events:none so it doesn't block the feed; resolved
    // rows opt back in so clicking a phrase jumps to that reel.
    row.classList.add('bouncer-ig-next');
    row.style.pointerEvents = 'auto';
    row.style.cursor = 'pointer';
    row.addEventListener('click', () => {
      reel.card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    nextShown.add(reel.reelId);
    return row;
  });
  shownUpcomingIds = nextShown;
  upcomingListEl.replaceChildren(...rows);
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
  const message: ContentToBackgroundMessage = {
    type: 'analyzeReel',
    caption,
    thumbnailUrl: reel.thumbnailUrl,
  };

  const pending = (async (): Promise<string> => {
    try {
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
  reelsPageEl = null;
  filtersPageEl = null;
  filtersSlotEl = null;
  lastRenderKey = '';
  lastCurrentDesc = null;
  shownUpcomingIds = new Set();
  observer.disconnect();
  ratios.clear();
  orderedReels.length = 0;
  cards = new WeakSet<HTMLElement>();
  activeReelId = null;
}

let lastPath = location.pathname;
function syncForLocation(): void {
  if (onReelsPage()) {
    mountPanel();      // idempotent — no-ops if already mounted
    refreshPanel();
    scan();
  } else if (document.getElementById(FRAME_ID)) {
    removePanel();
  }
}

async function boot(): Promise<void> {
  // Respect the Instagram master switch, same key content/index.ts gates on.
  // Without this the panel would still mount when the platform is toggled off
  // — and its gear would be dead, because content.js returns before wiring the
  // filter-box bridge. Re-enabling reloads, matching content/index.ts.
  const platformKey = enabledStorageKey('instagram');
  const stored = await chrome.storage.local.get(platformKey);
  if (stored[platformKey] === false) {
    chrome.storage.onChanged.addListener((changes) => {
      if (changes[platformKey] && changes[platformKey].newValue !== false) {
        location.reload();
      }
    });
    return;
  }

  // Install the audio filter once (its hook listener is harmless when idle) and
  // seed it with any persisted terms; scan() then feeds it discovered reels.
  audioController = installAudioFilter();
  void (async () => {
    const data = await chrome.storage.local.get(AUDIO_TERMS_KEY);
    const stored = data[AUDIO_TERMS_KEY];
    audioTerms = Array.isArray(stored) ? stored.filter((x): x is string => typeof x === 'string') : [];
    audioController?.setCategories(audioTerms);
  })();

  syncForLocation();

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
