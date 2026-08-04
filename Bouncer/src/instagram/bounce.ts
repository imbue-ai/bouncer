// "Remove similar content?" — the Instagram counterpart to X's trash-can button.
//
// On X you click the bin on a post and Bouncer asks the backend for reasons you
// might want it gone, then offers them as one-click filter phrases. Here the
// gesture is a swipe: drag a reel's description out of the describer panel and
// the same `suggestAnnoyingReasons` pipeline runs against that reel's caption
// and cover image, surfacing the same kind of suggestions.
//
// The popup is deliberately non-blocking — no backdrop, nothing captured, the
// reel keeps playing and the feed keeps scrolling behind it. It sits directly
// under the panel the swipe happened in, so the cause and the consequence are
// in the same place.
//
// Dismissal is forgiving: picking a phrase applies it silently, "No thanks"
// closes it, and simply scrolling on to another reel counts as "No thanks" —
// the caller drives that via dismissBouncePopup().

import { railAnchoredBox } from './layout';

const POPUP_ID = 'bouncer-ig-bounce';
const PANEL_ID = 'bouncer-ig-frame';
const ADD_PHRASE_EVENT = 'bouncer-add-filter-phrase';

const PANEL_FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';
const ACCENT = '#EA8554';

// Narrow on purpose: the suggestions stack one per line so the popup can live
// in the action rail's column instead of spanning the reel.
const POPUP_WIDTH_PX = 210;

let dismissTimer: number | null = null;

/** Close the popup if one is open. Called on "No thanks", after a pick, and
 *  whenever the user moves to a different reel. */
export function dismissBouncePopup(): void {
  if (dismissTimer !== null) {
    clearTimeout(dismissTimer);
    dismissTimer = null;
  }
  const existing = document.getElementById(POPUP_ID);
  if (!existing) return;
  existing.style.opacity = '0';
  existing.style.transform = 'translateY(-4px)';
  setTimeout(() => existing.remove(), 160);
}

function injectStyles(): void {
  if (document.getElementById('bouncer-ig-bounce-style')) return;
  const style = document.createElement('style');
  style.id = 'bouncer-ig-bounce-style';
  style.textContent = [
    '@keyframes bouncer-bounce-in {',
    '  from { opacity: 0; transform: translateY(-6px); }',
    '  to { opacity: 1; transform: translateY(0); }',
    '}',
    '#bouncer-ig-bounce .bouncer-bounce-chip {',
    '  transition: background 0.15s ease, border-color 0.15s ease;',
    '}',
    '#bouncer-ig-bounce .bouncer-bounce-chip:hover {',
    `  background: ${ACCENT}; border-color: ${ACCENT}; color: #ffffff;`,
    '}',
    '#bouncer-ig-bounce .bouncer-bounce-no:hover { color: #0a0a0a; }',
  ].join('\n');
  (document.head ?? document.documentElement).appendChild(style);
}

/** Anchor the popup to Instagram's like/comment rail, left edge aligned with the
 *  describer panel above it. Suggestions stack one per line, so it stays narrow
 *  enough to live in that column instead of spanning the reel. */
function position(popup: HTMLElement): void {
  const icon = document.querySelector('svg[aria-label="Like"], svg[aria-label="Unlike"]');
  const rail = icon?.closest('div[role="button"], button, span')?.getBoundingClientRect();
  const panel = document.getElementById(PANEL_ID)?.getBoundingClientRect();
  const left = rail?.left ?? panel?.left;
  if (left === undefined) {
    popup.style.left = 'auto';
    popup.style.right = '20px';
    popup.style.top = '20px';
  } else {
    // Clamped to the viewport: at phone width the rail is overlaid on the
    // reel's right edge, so its raw left would hang the popup off-screen.
    const box = railAnchoredBox(left, POPUP_WIDTH_PX);
    popup.style.left = `${box.left}px`;
    popup.style.right = 'auto';
    popup.style.width = `${box.width}px`;
    // Under the panel when it's up, otherwise level with the top of the rail.
    popup.style.top = `${panel ? panel.bottom + 10 : (rail?.top ?? 20)}px`;
    return;
  }
  popup.style.width = `${POPUP_WIDTH_PX}px`;
  popup.style.maxWidth = 'calc(100vw - 40px)';
}

function shell(): HTMLElement {
  injectStyles();
  dismissBouncePopup();

  const popup = document.createElement('div');
  popup.id = POPUP_ID;
  popup.style.cssText = [
    'position: fixed',
    'box-sizing: border-box',
    'padding: 12px 14px',
    'border-radius: 14px',
    'background: #ffffff',
    'box-shadow: 0 6px 24px rgba(0,0,0,0.18)',
    'border: 1px solid rgba(0,0,0,0.07)',
    'z-index: 2147483646',
    `font-family: ${PANEL_FONT}`,
    'color: #0a0a0a',
    'transition: opacity 0.16s ease, transform 0.16s ease',
    'animation: bouncer-bounce-in 0.2s ease',
  ].join(';');
  position(popup);
  (document.body ?? document.documentElement).appendChild(popup);
  return popup;
}

function title(text: string): HTMLElement {
  const el = document.createElement('div');
  el.textContent = text;
  el.style.cssText = 'font-size: 13px; font-weight: 700; margin-bottom: 10px';
  return el;
}

function noThanks(label = 'No thanks'): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'bouncer-bounce-no';
  btn.textContent = label;
  btn.style.cssText = [
    'margin-top: 10px',
    'padding: 0',
    'border: none',
    'background: none',
    'font-family: inherit',
    'font-size: 12px',
    'font-weight: 600',
    'color: #8a8f98',
    'cursor: pointer',
    'transition: color 0.15s ease',
  ].join(';');
  btn.onclick = () => dismissBouncePopup();
  return btn;
}

/** Suggestion chips. With `addEvent`, picking one hands the phrase to
 *  content.js, which owns the phrase list (dedupe, length budget, and the
 *  re-evaluation sweep that hides matching reels already on screen).
 *
 *  `addEvent` null is the tour's demo: the chips are there to be *shown*, and
 *  the tour taps one itself. They take no clicks at all — not even to dismiss —
 *  so a user clicking ahead can't derail the scripted sequence or be left
 *  wondering why picking one did nothing. */
function chipRow(reasons: readonly string[], addEvent: string | null): HTMLElement {
  const interactive = addEvent !== null;
  const chips = document.createElement('div');
  chips.style.cssText = 'display: flex; flex-direction: column; align-items: flex-start; gap: 6px';
  for (const reason of reasons) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'bouncer-bounce-chip';
    chip.textContent = reason;
    chip.style.cssText = [
      'padding: 5px 10px',
      'border-radius: 999px',
      'border: 1px solid rgba(0,0,0,0.14)',
      'background: rgba(0,0,0,0.03)',
      'font-family: inherit',
      'font-size: 12px',
      'font-weight: 600',
      'color: #0a0a0a',
      'text-align: left',
      // Also suppresses the :hover styling, so a demo chip doesn't advertise
      // itself as pressable.
      interactive ? 'cursor: pointer' : 'pointer-events: none',
    ].join(';');
    if (interactive) {
      chip.onclick = () => {
        window.dispatchEvent(new CustomEvent(addEvent, { detail: { phrase: reason } }));
        dismissBouncePopup();
      };
    } else {
      chip.disabled = true;
      chip.setAttribute('aria-disabled', 'true');
    }
    chips.appendChild(chip);
  }
  return chips;
}

export interface BounceRequest {
  /** The swiped reel's caption — the text the backend reasons over. */
  caption: string;
  /** Its cover image, so image-aware models can see what the reel looks like. */
  thumbnailUrl: string;
}

/** The tour's stand-in: the same popup with scripted suggestions and no
 *  backend round trip. Its chips only dismiss — a walk-through must not quietly
 *  add real filters to the user's list. */
export function showDemoBouncePopup(reasons: readonly string[]): void {
  const popup = shell();
  popup.append(title('Remove similar content?'), chipRow(reasons, null), noThanks());
}

/**
 * Ask the backend why this reel might be worth filtering and offer the answers
 * as one-click filter phrases. Fire-and-forget: everything is rendered into the
 * popup as it arrives.
 */
export function showBouncePopup(req: BounceRequest): void {
  const popup = shell();

  const loading = document.createElement('div');
  loading.textContent = 'Looking at what you just bounced…';
  loading.style.cssText = 'font-size: 12px; color: #8a8f98';
  popup.append(title('Remove similar content?'), loading, noThanks('Dismiss'));

  void (async () => {
    let reasons: string[] = [];
    try {
      const res: { reasons?: string[] } | undefined = await chrome.runtime.sendMessage({
        type: 'suggestAnnoyingReasons',
        post: req.caption,
        imageUrls: req.thumbnailUrl ? [req.thumbnailUrl] : [],
        siteId: 'instagram',
      });
      reasons = Array.isArray(res?.reasons) ? res.reasons.filter(r => typeof r === 'string') : [];
    } catch (err) {
      console.warn('[Bouncer IG] suggestAnnoyingReasons failed:', (err as Error).message);
    }

    // The user may have moved on (or dismissed) while the request was out.
    if (!popup.isConnected) return;

    if (reasons.length === 0) {
      loading.textContent = 'No suggestions for this one.';
      // Nothing to choose, so don't leave it sitting there.
      dismissTimer = window.setTimeout(dismissBouncePopup, 2600);
      return;
    }

    popup.replaceChildren(title('Remove similar content?'), chipRow(reasons, ADD_PHRASE_EVENT), noThanks());
  })();
}
