// Getting rid of "use the app".
//
// Instagram's mobile web parks a bar at the foot of the page telling you to go
// and use the app instead. It is not part of the page you asked for, it costs a
// strip of a screen that is mostly reel, and on the routes where it appears it
// covers the very chrome ./fit.ts just went to the trouble of bringing back into
// view. So it gets closed, the way you would close it.
//
// Closed rather than deleted, wherever there is something to click. Instagram
// remembers a dismissal and stops offering; a banner merely hidden comes back
// on the next route, and we would be hiding it forever. Deleting is the
// fallback for a banner with no close control.
//
// Identified by shape, not by selector — the class names are hashed and change.
// Three things have to be true at once, and together they are hard to hit by
// accident:
//
//   it is PINNED (fixed or sticky), so it is chrome rather than content;
//   it is SHORT and sits against the bottom of the screen, which is a bar;
//   it TALKS about the app, in one of the handful of ways Instagram words it.
//
// The last one alone would be a caption that mentions the app; the first two
// alone would be Instagram's own navigation bar. A caption is not pinned and
// the nav bar does not mention the app.

/** How Instagram words it. Deliberately several, because the copy varies by
 *  route and by whether it thinks the app is installed. */
const PROMO_TEXT = new RegExp([
  'use the app',
  'open (the )?(instagram )?app',
  'open in (the )?app',
  'continue (in|with) (the )?app',
  'see more on the app',
  'switch to the app',
  'get the app',
  'view in app',
  // The reels-specific wording, which is the one that greets you on arrival:
  // Instagram offers it per-reel rather than per-session, so it comes back on
  // every route change and has to be matched as its own phrase.
  'watch (this )?(reel|video)s? (in|on) (the )?app',
  '(see|view|watch) (this )?(reel|video)s? in (the )?(instagram )?app',
  // The interstitial that actually greets you, and the one every pattern above
  // missed: a card with the Instagram logo, an "Open Instagram" button and a
  // "Sign up" link, over a dimmed backdrop with an X in its corner.
  //
  // Not one word of it is "app". Every phrase here had been written around that
  // word — "use the app", "open the app", "watch this reel in the app" — and
  // Instagram's most prominent prompt simply names itself instead. It was never
  // a matching problem or a positioning problem; the popup was never a
  // candidate in the first place.
  'open instagram',
  'continue (to|on) instagram',
].join('|'), 'i');

/** The same phrases, but only when the text BEGINS with one.
 *
 *  The stricter test, for promo copy found by its words rather than by its
 *  position. A pinned bar at the foot of the screen can afford the loose match
 *  — being pinned is most of the evidence. Something sitting inline in the reel
 *  has no such alibi, and the sentence people write in captions is exactly the
 *  sentence being looked for: "honestly you should use the app for this one".
 *
 *  Instagram's own copy leads with the offer — "Watch this reel in the app",
 *  "Use the app to view all comments" — and a caption almost never does. Where
 *  the phrase falls in the sentence is the whole difference. */
const PROMO_TEXT_LEADING = new RegExp(`^(${PROMO_TEXT.source})`, 'i');

/** A bar is a strip. Past this much of the screen it is a page, and something we
 *  have misidentified. */
const MAX_BANNER_FRACTION = 0.34;
/** A dialog may be most of the screen — that is what makes it a dialog — but
 *  something taller than this is the page wearing a dialog's clothes. */
const MAX_DIALOG_FRACTION = 0.75;
/** How far from the bottom of the screen still counts as "against" it. */
const BOTTOM_SLACK_PX = 140;
/** Below this it is a stray pinned pixel, not a banner. */
const MIN_BANNER_HEIGHT_PX = 28;

/** Text on a banner is short. A long block that happens to contain the phrase is
 *  a caption, a comment, or a page. */
const MAX_BANNER_TEXT = 200;

/** When to report anything still standing. Late enough that Instagram has
 *  finished putting its promos up, early enough to still be on the screen the
 *  user is looking at. */
const PROMO_REPORT_MS = 6_000;

/** Ours, and off limits. */
const OURS = '[id^="bouncer-"], [class^="bouncer-"]';

function isPinned(el: Element): boolean {
  const position = getComputedStyle(el).position;
  return position === 'fixed' || position === 'sticky';
}

/** Whether this element is a bar across the bottom of the screen. */
function looksLikeBanner(el: HTMLElement): boolean {
  // Pinned is half of what makes a bar a bar. This used to be checked by the
  // caller and is checked here now, because the caller also has an unpinned
  // path — and the moment that appeared, a static caption sitting low on the
  // page passed every remaining test.
  if (!isPinned(el)) return false;
  const view = window.visualViewport?.height ?? window.innerHeight;
  const rect = el.getBoundingClientRect();
  if (rect.width < window.innerWidth * 0.5) return false;
  if (rect.height < MIN_BANNER_HEIGHT_PX) return false;
  if (rect.height > view * MAX_BANNER_FRACTION) return false;
  return rect.bottom > view - BOTTOM_SLACK_PX && rect.top < view;
}

/** Whether this is a modal asking the same question in the middle of the
 *  screen rather than along the bottom of it.
 *
 *  Held to a stricter standard than a bar, and deliberately so. A bar is
 *  identifiable by its shape — a short strip pinned to the bottom edge is not
 *  something else — but a centred panel is the same shape as a login sheet, a
 *  comment thread, or the page itself. So this asks for an explicit dialog role
 *  AND a close control, and `dismissAppPromos` refuses to hide a dialog it
 *  cannot close properly. Getting a bar wrong hides a strip; getting this wrong
 *  blanks Instagram. */
function looksLikeDialog(el: HTMLElement): boolean {
  const view = window.visualViewport?.height ?? window.innerHeight;
  const rect = el.getBoundingClientRect();
  // Not the whole page, not a sliver.
  if (rect.height > view * MAX_DIALOG_FRACTION) return false;
  if (rect.height < MIN_BANNER_HEIGHT_PX) return false;
  if (rect.width < window.innerWidth * 0.4) return false;
  const role = el.getAttribute('role');
  return role === 'dialog' || role === 'alertdialog'
    || el.querySelector('[role="dialog"], [role="alertdialog"]') !== null;
}

/** Whether this element is the whole promo rather than a chunk of the page that
 *  happens to contain one.
 *
 *  The guard on clicking a full-screen thing: it has to be pinned (already
 *  checked), mention the app, and be mostly ABOUT that — a takeover is short on
 *  words. A feed that scrolled past a caption saying "open in the app" is long
 *  on them, and would fail this even if it were somehow pinned. */
function isAppPromoRoot(el: HTMLElement): boolean {
  const text = (el.textContent ?? '').trim();
  return text.length <= MAX_BANNER_TEXT;
}

/** Press a close control at most once, ever.
 *
 *  One popup is reached by two routes — its words, by climbing to the X, and
 *  its shell, by the shallow sweep — and it has a heading AND a line of copy,
 *  each of which leads with the phrase. Without this, a single popup takes four
 *  clicks: the first closes it and the rest land on whatever is underneath. */
function pressOnce(close: HTMLElement): boolean {
  if (close.dataset.bouncerPromo) return false;
  close.dataset.bouncerPromo = 'clicked';
  close.click();
  return true;
}

/** The X, wherever it is — searched from the promo's words outward.
 *
 *  Hiding the text was not enough and the log said so plainly: after a sweep,
 *  all three matches measured 0x0 while the popup was still on screen, visibly
 *  SMALLER. The words had gone and the shell they sat in — backdrop, buttons,
 *  the X in its corner — had not. A promo is not its sentence.
 *
 *  So: climb, and at each level look for something that closes. The close
 *  control belongs to the card, never to the span carrying the text, which is
 *  why searching inside the text found nothing every time.
 *
 *  The DEPTH is measured, not guessed. On the logged-out reels interstitial —
 *  dim backdrop, logo card, X in the corner — the X hangs off the full-screen
 *  fixed overlay TEN levels above "Watch this reel in the app": the words sit in
 *  a card in a centring stack in the overlay, every layer of it a bare div. A
 *  cap of six stopped mid-stack, found nothing, and the fallback then hid the
 *  words — which is how the shell stood on screen wordless, logo and X and all.
 *
 *  What keeps a deeper climb from grabbing someone else's X is not the level
 *  count, it is the two guards at every level: an ancestor holding the reel's
 *  <video> ends the search (its controls are not ours to press), and so does an
 *  ancestor with more than a popup's worth of text — the comments sheet has an
 *  X too, and it is text-heavy long before the climb could reach it. */
function closeControlNear(el: HTMLElement): HTMLElement | null {
  let node: HTMLElement | null = el;
  for (let level = 0; level < 14 && node && node !== document.body; level++) {
    if (node.matches(OURS)) return null;
    // Never reach into something holding the reel: its controls are not ours
    // to press. Checked at every level including the first — an anchor can be a
    // wrapper that inherited the text from a child.
    if (node.querySelector('video')) return null;
    if ((node.textContent ?? '').trim().length > MAX_DIALOG_TEXT) return null;
    const close = closeControl(node);
    if (close) return close;
    node = node.parentElement;
  }
  return null;
}

/** How much text a thing can hold and still be a popup rather than the page.
 *  Larger than a bar's budget: a modal has a heading, a paragraph and two
 *  buttons, and all of that is still a popup. */
const MAX_DIALOG_TEXT = 400;

/** The button that closes it, if it has one. Instagram labels these, which is
 *  the one durable thing about them. */
function closeControl(el: HTMLElement): HTMLElement | null {
  const labelled = el.querySelector<HTMLElement>(
    '[aria-label="Close" i], [aria-label="Dismiss" i], [aria-label*="not now" i]',
  );
  if (labelled) {
    // The label often sits on the <svg>; the thing that takes the click is the
    // button around it.
    const clickable = labelled.closest<HTMLElement>('button, [role="button"], a');
    return clickable ?? labelled;
  }
  // Failing a label, a button whose whole text is a refusal.
  for (const button of Array.from(el.querySelectorAll<HTMLElement>('button, [role="button"]'))) {
    if (/^(not now|dismiss|close|×|✕)$/i.test((button.textContent ?? '').trim())) return button;
  }
  return null;
}

/** The card a promo phrase lives in — the biggest box that still contains the
 *  promo AND NOTHING ELSE.
 *
 *  Walking up from the words rather than down from the body, because the thing
 *  that needs dismissing is never the element carrying the text. Measured on
 *  device, the survivor was two `<span>`s at `position: relative` sitting inside
 *  the reel — "Watch this reel in the app" and "Use the app to view all
 *  comments and discover more reels." Not pinned, so not a bar; no role, so not
 *  a dialog; and a close button, if there is one, belongs to the card around
 *  them rather than to a span. Every test I had asked about the wrong element.
 *
 *  The walk stops at the moment the text grows: an ancestor whose text is
 *  longer than the promo's has picked up something that is not promo, and
 *  hiding it would take real content with it. That single rule is what makes
 *  hiding safe here — whatever it returns says nothing but "use the app". */
function promoCard(el: HTMLElement): HTMLElement | null {
  const promoText = (el.textContent ?? '').trim();
  let best = el;
  let node = el.parentElement;

  for (let i = 0; i < 8 && node && node !== document.body; i++) {
    if (node.matches(OURS)) return null;
    const text = (node.textContent ?? '').trim();
    // Grown past the promo: this ancestor holds other things too.
    if (text.length > promoText.length + 8) break;
    // Never take something holding the reel itself with it.
    if (node.querySelector('video')) break;
    best = node;
    node = node.parentElement;
  }
  return best;
}

/** The innermost elements whose text leads with a promo phrase.
 *
 *  Found by walking TEXT NODES, not by reading `.textContent` off every
 *  element. The old sweep did the latter, and `.textContent` is a subtree
 *  concatenation — asked of every element it re-reads the page once per level
 *  of nesting, on a 300ms debounce, forever. On the logged-out DOM that was
 *  survivable; the signed-in feed's DOM is several times the size and the
 *  sweep became most of a frame every tick.
 *
 *  A text node carrying the phrase climbs at most a few levels to the first
 *  ancestor whose aggregate text LEADS with it — the same innermost-match
 *  the old sweep selected, at O(text nodes) instead of O(elements × depth).
 *  The one case this trades away is a phrase split across sibling text nodes
 *  with no single node containing it; Instagram's promo copy is measured to
 *  arrive in whole nodes. */
function promoAnchors(): HTMLElement[] {
  const root = document.body;
  if (!root) return [];
  const anchors = new Set<HTMLElement>();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const value = node.nodeValue ?? '';
    if (value.length > MAX_BANNER_TEXT || !PROMO_TEXT.test(value)) continue;
    let el: HTMLElement | null = node.parentElement;
    for (let i = 0; i < 6 && el && el !== root; i++) {
      if (el.matches(OURS)) { el = null; break; }
      const text = (el.textContent ?? '').trim();
      if (text.length > MAX_BANNER_TEXT) { el = null; break; }
      if (PROMO_TEXT_LEADING.test(text)) break;
      el = el.parentElement;
    }
    if (el && el !== root && PROMO_TEXT_LEADING.test((el.textContent ?? '').trim())) {
      anchors.add(el);
    }
  }
  return [...anchors];
}

/** Promo cards found by their words, wherever they sit in the tree. */
function textPromoCards(): { cards: HTMLElement[]; anchors: HTMLElement[] } {
  const anchors = promoAnchors();
  const cards = new Set<HTMLElement>();
  for (const anchor of anchors) {
    const card = promoCard(anchor);
    if (card && !card.matches(OURS)) cards.add(card);
  }
  return { cards: [...cards], anchors };
}

/** Everything that could be a pinned bar, without walking the whole document.
 *  Instagram portals these to the end of <body>, so a shallow sweep finds them
 *  and a deep one would only cost time. */
function candidates(): HTMLElement[] {
  const found: HTMLElement[] = [];
  const roots = Array.from(document.body?.children ?? []);
  for (const root of roots) {
    if (!(root instanceof HTMLElement) || root.matches(OURS)) continue;
    found.push(root);
    for (const child of Array.from(root.children)) {
      if (child instanceof HTMLElement && !child.matches(OURS)) found.push(child);
    }
  }
  return found;
}

/** Close every app-install bar on the page. Returns how many were dealt with. */
export function dismissAppPromos(): number {
  let dismissed = 0;
  const { cards, anchors } = textPromoCards();

  // The X first, before anything is hidden. Pressing the page's own control
  // takes the whole popup — shell, backdrop and all — where hiding the text
  // leaves the shell standing and the popup merely smaller.
  for (const anchor of anchors) {
    if (anchor.dataset.bouncerPromo) continue;
    const close = closeControlNear(anchor);
    if (!close) continue;
    anchor.dataset.bouncerPromo = 'closed';
    // Marked on the CONTROL, not only on the words. One popup has a heading and
    // a line of copy, both of which lead with the phrase and both of which find
    // the same X — pressing it once per line would be two clicks on a thing
    // that is already closing, and on a route change it would be four.
    if (!pressOnce(close)) continue;
    dismissed++;
  }

  for (const el of [...candidates(), ...cards]) {
    if (el.dataset.bouncerPromo) continue;          // already handled this one
    const text = (el.textContent ?? '').trim();
    if (text.length > MAX_BANNER_TEXT || !PROMO_TEXT.test(text)) continue;

    // Never anything holding the reel. Its controls are Instagram's own — the
    // close button on a comments sheet is an X like any other, and pressing it
    // would be a worse bug than the popup it was aimed at.
    if (el.querySelector('video')) continue;

    const close = closeControl(el);
    // In-reel promo copy: not pinned, no role, frequently nothing to click.
    // Safe to hide precisely because promoCard stopped at the last box whose
    // text is still only the promo — see promoCard. Size-capped so a runaway
    // walk can never take the page with it.
    const view = window.visualViewport?.height ?? window.innerHeight;
    const height = el.getBoundingClientRect().height;
    // Leading phrase required, not merely present: an unpinned box has no
    // structural evidence behind it, and "honestly you should use the app for
    // this one" is a caption. Where the phrase falls in the sentence is the
    // only thing separating the two.
    const isInReel = !isPinned(el)
      && PROMO_TEXT_LEADING.test(text)
      && height > 0
      && height <= view * MAX_BANNER_FRACTION;
    const isBar = looksLikeBanner(el);
    const isDialog = !isBar && looksLikeDialog(el);
    // A takeover with a close button on it is still a takeover, and clicking
    // its own close button is safe at any size — the size rules exist to stop
    // us HIDING something structural, and this presses the page's own control
    // rather than reaching past it. The one that gets past the other two tests
    // is the interstitial after onboarding: it fills the screen, so it is not a
    // bar, and it is taller than a dialog has any business being, so it was not
    // a dialog either. It was the first thing anyone saw and nothing touched it.
    const isTakeover = !isBar && !isDialog && close !== null && isAppPromoRoot(el);
    if (!isBar && !isDialog && !isTakeover && !isInReel) continue;
    // A dialog we cannot close is left alone. Hiding it would take the backdrop
    // and the scroll lock with it and leave the page inert — worse than the
    // dialog, and harder to explain.
    if ((isDialog || isTakeover) && !close) continue;

    el.dataset.bouncerPromo = 'dismissed';
    if (close) {
      // Through the same gate as the anchor pass. Both passes can arrive at one
      // popup — the words find its X by climbing, the shallow sweep finds the
      // shell directly — and a control pressed twice is a control pressed once
      // on something already closing.
      if (!pressOnce(close)) continue;
      // If the click was decorative, the bar is still here a frame later.
      setTimeout(() => {
        if (el.isConnected && looksLikeBanner(el)) el.style.setProperty('display', 'none', 'important');
      }, 120);
    } else {
      el.style.setProperty('display', 'none', 'important');
    }
    dismissed++;
  }
  return dismissed;
}

/** Why nothing was dismissed, in the page's own words.
 *
 *  The dismisser is four tests joined by AND, and a promo that survives fails
 *  exactly one of them — but from the outside every failure looks identical: a
 *  popup that is still there. This finds anything on the page that MENTIONS the
 *  app and reports which test it fell at, so "it's still there" becomes "it was
 *  0.42 of the screen and the dialog ceiling is 0.34".
 *
 *  Deliberately a wider net than the dismisser's own: it walks the whole
 *  document rather than the shallow sweep, because "we never even looked at it"
 *  is one of the answers it has to be able to give. */
export function reportAppPromos(): string {
  const view = window.visualViewport?.height ?? window.innerHeight;
  const found: string[] = [];

  for (const el of Array.from(document.querySelectorAll<HTMLElement>('body *'))) {
    const text = (el.textContent ?? '').trim();
    if (!PROMO_TEXT.test(text)) continue;
    // The innermost element carrying the phrase, not every ancestor of it: if a
    // child says the same thing, the child is the better description of where
    // the promo actually lives.
    const deeper = Array.from(el.children)
      .some((child) => PROMO_TEXT.test((child.textContent ?? '').trim()));
    if (deeper) continue;

    const rect = el.getBoundingClientRect();
    const position = getComputedStyle(el).position;
    const close = closeControl(el);
    const reasons: string[] = [];
    if (el.dataset.bouncerPromo) reasons.push('ALREADY HANDLED');
    if (text.length > MAX_BANNER_TEXT) reasons.push(`text ${text.length} > ${MAX_BANNER_TEXT}`);
    if (position !== 'fixed' && position !== 'sticky') reasons.push(`position:${position}`);
    if (!close) reasons.push('no close control');
    if (rect.height > view * MAX_BANNER_FRACTION) {
      reasons.push(`height ${Math.round(rect.height)} > bar max ${Math.round(view * MAX_BANNER_FRACTION)}`);
    }
    if (rect.bottom <= view - BOTTOM_SLACK_PX) reasons.push(`bottom ${Math.round(rect.bottom)} too high`);
    if (el.matches(OURS)) reasons.push('ours');

    found.push(
      `<${el.tagName.toLowerCase()}> ${Math.round(rect.width)}x${Math.round(rect.height)}`
      + ` @${Math.round(rect.top)}..${Math.round(rect.bottom)} pos=${position}`
      + ` role=${el.getAttribute('role') ?? '-'} close=${close ? 'yes' : 'NO'}`
      + ` — ${reasons.length ? reasons.join('; ') : 'should have been dismissed'}`
      + ` — "${text.slice(0, 60)}"`);
  }

  // One line, however many matches. The iOS console bridge posts each
  // console.* call as a single string and the native side prints it — a
  // multi-line report arrives with everything after the first newline gone,
  // which is how this last reported "3 match(es)" and then nothing at all.
  return found.length === 0
    ? `nothing on the page mentions the app (viewport ${Math.round(view)})`
    : `${found.length} match(es), viewport ${Math.round(view)} :: ${found.join(' :: ')}`;
}

/** Watch for it. The bar arrives after the page does, and again on every route
 *  change, so this is a standing job rather than a one-off.
 *
 *  Coalesced onto a timer: Instagram mutates its DOM continuously, and the
 *  question being asked here — "is there a bar at the bottom" — does not need an
 *  answer more than a few times a second. */
export function installPromoDismisser(): () => void {
  let pending = 0;
  const sweep = (): void => {
    pending = 0;
    dismissAppPromos();
  };
  const schedule = (): void => {
    if (pending) return;
    pending = window.setTimeout(sweep, 300);
  };

  // Say what was left behind, once the page has settled. A promo we did not
  // dismiss is invisible from here otherwise — dismissAppPromos returning 0 is
  // the same number whether there was nothing to do or four tests failed.
  setTimeout(() => {
    const report = reportAppPromos();
    if (!report.startsWith('nothing')) console.warn(`[Bouncer IG] promos: ${report}`);
  }, PROMO_REPORT_MS);

  const observer = new MutationObserver(schedule);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener('popstate', schedule);
  schedule();

  return () => {
    observer.disconnect();
    window.removeEventListener('popstate', schedule);
    if (pending) clearTimeout(pending);
  };
}
