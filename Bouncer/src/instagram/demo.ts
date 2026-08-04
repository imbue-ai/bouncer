// Scripted UI demonstrations for the welcome tour.
//
// The tour doesn't just describe Bouncer's gestures, it performs them: a grey
// puck stands in for the user's finger, swiping a description out of the panel
// and tapping suggestions in the popup, while the real UI reacts as it would to
// a real hand. This module owns the puck and the timing; index.ts owns what
// each demonstration actually does to the panel.
//
// Everything here is theatre. No reel is filtered, no request is made, and the
// filter phrases these animations appear to add and remove never touch storage
// — see the `data-bouncer-demo` marker on the pill.

const CURSOR_ID = 'bouncer-ig-demo-cursor';

/** Deliberately unhurried: a demonstration that outpaces the eye teaches
 *  nothing, and the first run is the only chance to land the gesture. */
export const SWIPE_HOLD_MS = 520;      // puck sits on the row before moving
export const SWIPE_TRAVEL_MS = 1150;   // the throw itself
export const TAP_MS = 620;             // press + release on a target

/** The stand-in pointer. One at a time; a second call replaces the first. */
function cursor(x: number, y: number): HTMLElement {
  document.getElementById(CURSOR_ID)?.remove();
  const dot = document.createElement('div');
  dot.id = CURSOR_ID;
  dot.style.cssText = [
    'position: fixed',
    `left: ${x - 11}px`,
    `top: ${y - 11}px`,
    'width: 22px',
    'height: 22px',
    'border-radius: 50%',
    'background: rgba(90,95,105,0.55)',
    'filter: blur(1px)',
    'pointer-events: none',
    'z-index: 2147483647',
    'opacity: 0',
    'transition: opacity 0.22s ease',
  ].join(';');
  (document.body ?? document.documentElement).appendChild(dot);
  requestAnimationFrame(() => { dot.style.opacity = '1'; });
  return dot;
}

export function clearCursor(): void {
  document.getElementById(CURSOR_ID)?.remove();
}

const wait = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Sweep `row` off to the right, puck leading it, as though thrown by hand.
 * Resolves once the row is gone.
 */
export async function playSwipe(row: HTMLElement): Promise<void> {
  const rect = row.getBoundingClientRect();
  const dot = cursor(rect.left + 14, rect.top + rect.height / 2);
  await wait(SWIPE_HOLD_MS);

  const distance = Math.round(rect.width * 0.72);
  const ease = 'cubic-bezier(0.33, 0, 0.2, 1)';
  // Motion blur smeared along X only, so it reads as speed rather than fog.
  dot.style.transition =
    `transform ${SWIPE_TRAVEL_MS}ms ${ease}, filter ${SWIPE_TRAVEL_MS}ms ease, `
    + `opacity 0.3s ease ${SWIPE_TRAVEL_MS - 260}ms`;
  row.style.transition =
    `transform ${SWIPE_TRAVEL_MS}ms ${ease}, opacity ${SWIPE_TRAVEL_MS - 150}ms ease`;
  requestAnimationFrame(() => {
    dot.style.transform = `translateX(${distance}px)`;
    dot.style.filter = 'blur(3px)';
    dot.style.opacity = '0';
    row.style.transform = `translateX(${distance}px)`;
    row.style.opacity = '0';
  });

  await wait(SWIPE_TRAVEL_MS + 80);
  clearCursor();
}

/** Move the puck onto `target` and press it: a quick shrink and release, with
 *  the target dipping under the touch. Resolves after the release. */
export async function playTap(target: HTMLElement): Promise<void> {
  const rect = target.getBoundingClientRect();
  const dot = cursor(rect.left + rect.width / 2, rect.top + rect.height / 2);
  dot.style.transition = 'opacity 0.22s ease, transform 0.16s ease';
  await wait(TAP_MS * 0.55);

  dot.style.transform = 'scale(0.62)';
  target.style.transition = 'transform 0.14s ease';
  target.style.transform = 'scale(0.94)';
  await wait(160);

  dot.style.transform = 'scale(1)';
  target.style.transform = '';
  await wait(TAP_MS * 0.35);
  clearCursor();
}

// ==================== Demo filter phrase ====================
//
// The tour shows a suggestion becoming a filter, then being removed again. Both
// are faked against the settings panel's live DOM: writing the phrase to
// storage for real would leave the user with a filter they never chose, and
// would survive the tour. The pill carries `data-bouncer-demo` so it's
// unmistakable and so cleanup can find it.

const DEMO_PHRASE_ATTR = 'data-bouncer-demo';

// The settings panel repopulates "Filter out" from storage asynchronously
// (syncFilterPhrases -> renderPhrasesInContainer -> replaceChildren), which
// lands after the demo pill is inserted and wipes it. Rather than race the
// timing, watch the row and put the pill back until the demo is done with it.
let demoPhraseGuard: MutationObserver | null = null;
let demoPhraseText: string | null = null;

function stopPhraseGuard(): void {
  demoPhraseGuard?.disconnect();
  demoPhraseGuard = null;
  demoPhraseText = null;
}

function phraseList(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.settings-modal-filters .filter-phrases-list');
}

/** Drop a phrase pill into the settings panel's "Filter out" row, styled
 *  exactly like a real one. Returns it, or null if the panel isn't up. */
export function addDemoPhrase(text: string): HTMLElement | null {
  const list = phraseList();
  if (!list) return null;
  list.querySelector(`[${DEMO_PHRASE_ATTR}]`)?.remove();

  const pill = document.createElement('span');
  pill.className = 'filter-phrase-inline';
  pill.setAttribute(DEMO_PHRASE_ATTR, 'true');
  pill.textContent = text;
  pill.style.animation = 'bouncer-ig-enter 0.3s ease';
  list.appendChild(pill);
  // The animated placeholder hides itself once there are phrases; match that,
  // or the demo pill and "e.g. ..." would sit side by side.
  list.parentElement?.querySelector('.filter-placeholder-cycle')?.classList.add('hidden');

  demoPhraseText = text;
  stopPhraseGuardObserverOnly();
  demoPhraseGuard = new MutationObserver(() => {
    const row = phraseList();
    if (!row || demoPhraseText === null) return;
    if (row.querySelector(`[${DEMO_PHRASE_ATTR}]`)) return;
    const again = document.createElement('span');
    again.className = 'filter-phrase-inline';
    again.setAttribute(DEMO_PHRASE_ATTR, 'true');
    again.textContent = demoPhraseText;
    row.appendChild(again);
    row.parentElement?.querySelector('.filter-placeholder-cycle')?.classList.add('hidden');
  });
  demoPhraseGuard.observe(list, { childList: true });
  return pill;
}

function stopPhraseGuardObserverOnly(): void {
  demoPhraseGuard?.disconnect();
  demoPhraseGuard = null;
}

/** Strike the demo pill through, then take it away — the visual grammar of
 *  removing a filter. Leaves the panel exactly as it was found. */
export async function removeDemoPhrase(): Promise<void> {
  // Stop putting it back before taking it away.
  stopPhraseGuard();
  const pill = phraseList()?.querySelector<HTMLElement>(`[${DEMO_PHRASE_ATTR}]`);
  if (!pill) return;
  pill.style.transition = 'opacity 0.35s ease';
  pill.style.textDecoration = 'line-through';
  await wait(520);
  pill.style.opacity = '0';
  await wait(360);
  const list = phraseList();
  pill.remove();
  // Only restore the placeholder if nothing real is left behind it.
  if (list && list.children.length === 0) {
    list.parentElement?.querySelector('.filter-placeholder-cycle')?.classList.remove('hidden');
  }
}

/** Tear down anything a demonstration left on screen. */
export function clearDemoArtifacts(): void {
  stopPhraseGuard();
  clearCursor();
  phraseList()?.querySelector(`[${DEMO_PHRASE_ATTR}]`)?.remove();
}
