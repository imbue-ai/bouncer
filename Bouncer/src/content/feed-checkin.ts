// Feed check-in card (X home timeline and tweet replies: browser extension
// and apps): every so often a card slots into the timeline. Cards alternate
// between two kinds: filters for the posts around it (suggested phrases for
// them, about half topics and half tones; see fetchSuggestions), and a field
// to add a "See more" topic. Among a tweet's replies only filter cards go
// in ("See more" posts only show on Home), and one with no suggestions is
// dropped.
//
// On Home a third kind joins the rotation once enough posts have been
// filtered since the last one: a gallery of them (blurred, labeled with the
// filter that caught them) that opens the "View filtered" panel.
//
// A filter card's buttons line up with the posts around it, top to bottom:
// the post directly above, then posts two or more notches above (up to
// MIDDLE_SOURCES of them), then the post directly below. One phrase per post.
//
// Placement follows bluesky-see-more.ts: the card is appended INSIDE a real
// tweet's cellInnerDiv, below the tweet, so X's virtualized list makes room
// for it. One becomes due every checkinEvery() posts (tweets and "See more"
// posts alike): often at first, backing off as cards are placed. Once it comes within PLACE_AHEAD_MARGIN of the viewport the
// card goes in — a filter card with placeholder buttons that fill in when
// the suggestions arrive (or turn it into a See-more card if there are
// none) — but only while its spot is still below the screen, so nothing
// pops in where the user is looking; a slot already on screen passes to the
// next tweet. Cards also go in at most once per MIN_CARD_GAP_MS; a slot
// that comes near sooner waits it out. The card element itself is kept by the tweet it hangs off, so
// a remounted cell gets it back as the user left it.
//
// Hiding a tweet hides its whole cell, card included — and the tweet above
// the card is one of its own suggestions' sources. So when the card's cell
// is hidden, the card moves to the top of the next visible tweet's cell
// (keepCardVisible), which keeps it in the same spot on screen.

import type { FilteredPost, PlatformAdapter, PostContent } from '../types';
import { getDescriptions, getStorage } from '../shared/storage';
import { SEE_MORE_TOPICS_KEY, roundRobin } from '../shared/bluesky';
import { formatPostForEvaluation, isEmbeddedApp } from '../shared/utils';
import {
  addTopic, removeTopic, isInjectedPost, isTopicLoading, onTopicLoadingChange, INJECTED_POST_SELECTOR, getTopicSuggestions,
  warmBackend,
} from './bluesky-see-more';
import { bouncePost } from './bounce-quote';
import {
  addFilterPhrase, removeFilterPhrase, getFilteredPosts, toggleFilteredTab, updateFilteredToggleButtons,
} from './ui';

// Posts between cards: FIRST_EVERY after the startup card, up to MAX_EVERY.
const FIRST_EVERY = 10;
// const STEP_EVERY = 5;           // backoff, off for now: 10, 15, 20, 25, 25…
const MAX_EVERY = 25;
const MIDDLE_SOURCES = 2;          // posts two or more notches above
const MIN_SOURCE_TEXT = 20;        // shorter text-only posts get poor suggestions
const MAX_CELLS_WALKED = 12;
const PLACE_AHEAD_MARGIN = '0px 0px 200% 0px';
// Cards go in at most this often, however fast the user scrolls: a due slot
// waits out the rest of it (and passes down if it reaches the screen first).
const MIN_CARD_GAP_MS = 10000;
// The startup card: placed this long after the first Home post is seen
// (once the timeline has laid out a screenful), retried while there isn't
// a screenful yet.
const STARTUP_DELAY_MS = 1000;
const STARTUP_TRIES = 5;
const HEADER_PX = 120;             // X's sticky header (and then some)
const SEE_MORE_CHOICES = 4;        // preselected topics on a See-more card
const SEE_MORE_PICKED_CHOICES = 3; // of them from the user's picks; one left to explore
const CARD_CLASS = 'bouncer-checkin';
const GALLERY_MIN_NEW = 2;         // filtered posts since the last gallery for another one
const GALLERY_MAX = 10;            // tiles on a gallery card

/** A post a suggestion is about: its key, content, and cellInnerDiv (the
 *  post's own root for a "See more" post). */
interface SourcePost { key: string; content: PostContent; cell: HTMLElement }
/** A phrase and the post it was suggested for (and validated against). */
interface Suggestion { phrase: string; source: SourcePost }
type CardKind = 'filter' | 'seeMore' | 'filtered';
// Home's rotation; among replies every card is a filter card.
const NEXT_KIND: Record<CardKind, CardKind> = { filter: 'seeMore', seeMore: 'filtered', filtered: 'filter' };

let adapter: PlatformAdapter | null = null;
const countedKeys = new Set<string>();
let tweetsSince = 0;
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- read by the backoff (STEP_EVERY), off for now
let cardsPlaced = 0;              // since the startup card
let startupScheduled = false;
let lastCardAt = 0;
let cooldownTimer: ReturnType<typeof setTimeout> | null = null;
const checkinEvery = () => Math.min(MAX_EVERY, FIRST_EVERY /* + STEP_EVERY * cardsPlaced */);
let slot: { key: string; cell: HTMLElement } | null = null;
// Placed cards by the tweet they hang off (below it, or above it once
// moved); null once dismissed, so a remount doesn't bring it back.
const cards = new Map<string, HTMLElement | null>();
// Watches the cells holding cards for being hidden.
let hideObserver: MutationObserver | null = null;
let observer: IntersectionObserver | null = null;
let slotNear = false;
let nextKind: CardKind = 'filter';
// When the newest post on the last gallery card was filtered.
let galleryShownUpTo = 0;

export function initFeedCheckin(platformAdapter: PlatformAdapter): void {
  if (platformAdapter.siteId !== 'twitter') return;
  adapter = platformAdapter;
  onTopicLoadingChange(syncTopicChipsLoading);
  document.addEventListener('bouncer:filtered-count-changed', syncGalleries);
  console.log('[Checkin] enabled');
}

const onHomeTimeline = () => location.pathname === '/home';
const onCheckinPage = () => onHomeTimeline() || !!adapter?.isPermalinkView();

const hostKeyOf = (cell: HTMLElement): string | null => {
  const article = cell.isConnected && adapter ? cell.querySelector<HTMLElement>(adapter.selectors.post) : null;
  return article ? adapter!.getPostContentKey(article) : null;
};

/** Called for every post the post observer processes (including recycled ones). */
export function noteCheckinPost(article: HTMLElement): void {
  if (!adapter || !onCheckinPage()) return;
  // "See more" posts count toward the interval but don't host a card: they
  // sit inside a tweet's cell themselves.
  const injected = isInjectedPost(article);
  const cell = adapter.getPostContainer(article);
  if (cell === article && !injected) return;
  const key = adapter.getPostContentKey(article);
  if (!key) return;
  if (!startupScheduled) {
    startupScheduled = true;
    setTimeout(() => placeStartupCard(STARTUP_TRIES), STARTUP_DELAY_MS);
  }
  if (injected) { count(key); return; }

  cell.querySelectorAll<HTMLElement>(`:scope > .${CARD_CLASS}`).forEach(e => {
    if (e.dataset.hostKey !== key) e.remove();
  });
  if (cards.has(key)) {
    const card = cards.get(key);
    if (card && card.parentElement !== cell) attachCard(card, cell);
    return;
  }
  if (slot?.key === key) { slot.cell = cell; watch(cell); return; }

  count(key);
  // A slot whose tweet got filtered never comes near (hidden cells don't
  // intersect): pass it down. One the user never scrolled to is stale.
  if (slot && hostKeyOf(slot.cell) === slot.key && slot.cell.dataset.filteredByExtension) passSlotDown();
  if (slot && tweetsSince >= checkinEvery()) releaseSlot(true);
  if (slot || tweetsSince < checkinEvery()) return;
  if (!canHost(cell)) return;

  tweetsSince = 0;
  slot = { key, cell };
  console.log('[Checkin] slot due under', key);
  watch(cell);
}

/** Whether a card can go under this cell's tweet: it's visible, has no card
 *  (or dismissed one) yet, doesn't already host a "See more" post, and
 *  isn't followed by the rest of a self-thread. */
function canHost(cell: Element): cell is HTMLElement {
  const key = cell instanceof HTMLElement ? hostKeyOf(cell) : null;
  if (!key || cards.has(key) || (cell as HTMLElement).dataset.filteredByExtension) return false;
  if (cell.querySelector(':scope > .bsky-x-post')) return false;
  const next = cell.nextElementSibling;
  const threaded = (adapter as unknown as { _isReplyInThread?: (el: Element) => boolean })._isReplyInThread;
  return !(next && threaded?.call(adapter, next));
}

/** Moves the slot to the first tweet below it that X has already rendered
 *  and that's below the screen. Waiting for the next newly rendered tweet
 *  instead would skip everything X renders ahead (several posts). */
function passSlotDown(): void {
  let cell = slot?.cell.nextElementSibling ?? null;
  for (let i = 0; cell && i < MAX_CELLS_WALKED * 2; i++, cell = cell.nextElementSibling) {
    if (!canHost(cell) || cell.getBoundingClientRect().bottom <= window.innerHeight) continue;
    const key = hostKeyOf(cell)!;
    slot = { key, cell };
    console.log('[Checkin] slot moved down to', key);
    watch(cell);
    return;
  }
  releaseSlot(true);
}

function count(key: string): void {
  if (countedKeys.has(key)) return;
  countedKeys.add(key);
  tweetsSince++;
}

/** Whether a "See more" post should stay out of this cell (it hosts, or is
 *  about to host, a check-in card). */
export function hostsCheckin(cell: Element): boolean {
  return !!cell.querySelector(`:scope > .${CARD_CLASS}`) || (!!slot && slot.cell === cell);
}

function watch(cell: HTMLElement): void {
  if (typeof IntersectionObserver === 'undefined') return;
  observer ??= new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (entry.target !== slot?.cell) { observer!.unobserve(entry.target); continue; }
      slotNear = entry.isIntersecting;
    }
    tryPlace();
  }, { rootMargin: PLACE_AHEAD_MARGIN });
  observer.disconnect();
  slotNear = false;
  observer.observe(cell);
}

function releaseSlot(nextTweetTakesOver: boolean): void {
  observer?.disconnect();
  slot = null;
  slotNear = false;
  if (nextTweetTakesOver) tweetsSince = checkinEvery();
}

// ==================== Source posts ====================

const POST_OR_INJECTED = () => `${adapter!.selectors.post}, ${INJECTED_POST_SELECTOR}`;

/** The posts in a cell, in document order: its tweet and any "See more"
 *  posts placed above or below it. */
const postsIn = (cell: Element): HTMLElement[] => [...cell.querySelectorAll<HTMLElement>(POST_OR_INJECTED())];

// Hidden by a filter: the X adapter marks the cell, a "See more" post itself.
const isHidden = (post: HTMLElement) => !!post.closest('[data-filtered-by-extension]');

function toSource(post: HTMLElement): SourcePost | null {
  if (isHidden(post)) return null;
  const content = adapter!.extractPostContent(post);
  if (content.text.trim().length < MIN_SOURCE_TEXT && !content.imageUrls?.length) return null;
  const key = adapter!.getPostContentKey(post);
  return key ? { key, content, cell: adapter!.getPostContainer(post) } : null;
}

/** The posts a filter card under `hostCell` is about: directly above (the
 *  host tweet), two or more notches above, and directly below. Hidden posts
 *  don't count as neighbors; the next visible one stands in. */
function sourcesAround(hostCell: HTMLElement): { above: SourcePost | null; middle: SourcePost[]; below: SourcePost | null } {
  const host = hostCell.querySelector<HTMLElement>(adapter!.selectors.post);
  const above = host ? toSource(host) : null;

  const middle: SourcePost[] = [];
  let cell = hostCell.previousElementSibling;
  for (let i = 0; cell && i < MAX_CELLS_WALKED && middle.length < MIDDLE_SOURCES; i++, cell = cell.previousElementSibling) {
    for (const post of postsIn(cell).reverse()) {
      const source = toSource(post);
      if (source) middle.push(source);
      if (middle.length >= MIDDLE_SOURCES) break;
    }
  }

  // The first visible post below; if it's too short to ask about, there's
  // no bottom button rather than one about a post further down.
  let belowPost: HTMLElement | undefined;
  cell = hostCell.nextElementSibling;
  for (let i = 0; cell && i < MAX_CELLS_WALKED && !belowPost; i++, cell = cell.nextElementSibling) {
    belowPost = postsIn(cell).find(post => !isHidden(post));
  }
  return { above, middle, below: belowPost ? toSource(belowPost) : null };
}

interface Choices { topics: string[]; tones: string[] }

/** Topic and tone phrases for a post (lowercase, best first), from the
 *  check-in prompt — not the trash-can's (pipeline.ts suggestCheckinReasons). */
async function suggestFor(source: SourcePost): Promise<Choices> {
  try {
    const reply: Partial<Choices> | undefined = await chrome.runtime.sendMessage({
      type: 'suggestCheckinReasons',
      post: source.content.text,
      imageUrls: source.content.imageUrls || [],
      siteId: adapter!.siteId,
    });
    return { topics: reply?.topics ?? [], tones: reply?.tones ?? [] };
  } catch (err) {
    console.warn('[Bouncer] check-in suggestions failed:', err);
    return { topics: [], tones: [] };
  }
}

/** One phrase per source post, in card order (above, middle, below). The
 *  direct neighbors pick first, so a phrase they share with a middle post
 *  stays on the neighbor's button. Each pick goes to whichever kind the card
 *  has fewer of so far (topics on a tie), falling back to the other kind, so
 *  a card comes out about half topics, half tones. */
async function fetchSuggestions(hostCell: HTMLElement): Promise<Suggestion[]> {
  const { above, middle, below } = sourcesAround(hostCell);
  const ordered = [above, ...middle, below];
  console.log(`[Checkin] fetching suggestions (above: ${!!above}, middle: ${middle.length}, below: ${!!below})`);
  const none: Choices = { topics: [], tones: [] };
  const replies = await Promise.all(ordered.map(s => (s ? suggestFor(s) : Promise.resolve(none))));
  const existing = new Set((await getDescriptions(`descriptions_${adapter!.siteId}`)).map(d => d.toLowerCase()));
  const picked = new Map<number, string>();
  const used = new Set<string>();
  let topics = 0, tones = 0;
  const last = ordered.length - 1;
  for (const i of [0, last, ...middle.map((_, j) => j + 1)]) {
    const fresh = (list: string[]) => list.find(p => !existing.has(p) && !used.has(p));
    const preferTopic = topics <= tones;
    const { topics: t, tones: q } = replies[i];
    const phrase = preferTopic ? fresh(t) ?? fresh(q) : fresh(q) ?? fresh(t);
    if (!phrase) continue;
    picked.set(i, phrase);
    used.add(phrase);
    if (t.includes(phrase)) topics++; else tones++;
  }
  const result: Suggestion[] = [];
  ordered.forEach((source, i) => {
    const phrase = picked.get(i);
    if (source && phrase) result.push({ phrase, source });
  });
  console.log(`[Checkin] suggestions (${topics} topics, ${tones} tones):`, result.map(r => r.phrase));
  return result;
}

function tryPlace(): void {
  if (!slot || !slotNear) return;
  const { key, cell } = slot;
  if (hostKeyOf(cell) !== key) return; // recycled; the tweet comes back via noteCheckinPost
  if (cell.dataset.filteredByExtension || cell.getBoundingClientRect().bottom <= window.innerHeight) {
    console.log('[Checkin] slot already on screen; moving it down');
    passSlotDown();
    return;
  }
  const wait = lastCardAt + MIN_CARD_GAP_MS - Date.now();
  if (wait > 0) {
    cooldownTimer ??= setTimeout(() => { cooldownTimer = null; tryPlace(); }, wait);
    return;
  }
  placeCard(key, cell);
  cardsPlaced++;
  console.log(`[Checkin] next card in ${checkinEvery()} posts`);
  releaseSlot(false);
}

/** The first card of a page load goes in right away, in view or just below
 *  it: under the last tweet that ends on screen, so the card shows at the
 *  bottom of the screen — or, when that tweet can't hold it, under the tweet
 *  crossing the bottom edge, just below the screen. It doesn't count toward
 *  the backoff; the count starts over from it. */
function placeStartupCard(triesLeft: number): void {
  if (!adapter || !onCheckinPage()) return;
  const seen = new Set<HTMLElement>();
  const cells: HTMLElement[] = [];
  for (const article of document.querySelectorAll<HTMLElement>(adapter.selectors.post)) {
    const cell = adapter.getPostContainer(article);
    if (cell === article || seen.has(cell) || isCellHidden(cell)) continue;
    seen.add(cell);
    cells.push(cell);
  }
  const fold = cells.findIndex(c => c.getBoundingClientRect().bottom >= window.innerHeight);
  if (fold === -1) {
    // Not a screenful of tweets yet.
    if (triesLeft > 1) setTimeout(() => placeStartupCard(triesLeft - 1), STARTUP_DELAY_MS);
    return;
  }
  const inView = cells.slice(0, fold).reverse()
    .find(c => c.getBoundingClientRect().bottom > HEADER_PX && canHost(c));
  const host = inView ?? cells.slice(fold).find(c => canHost(c));
  if (!host) return;
  if (slot) releaseSlot(false);
  placeCard(hostKeyOf(host)!, host);
  tweetsSince = 0;
  console.log(`[Checkin] startup card placed; next in ${checkinEvery()} posts`);
}

function placeCard(key: string, cell: HTMLElement): void {
  let kind: CardKind = onHomeTimeline() ? nextKind : 'filter';
  // Not enough newly filtered posts for a gallery: a filter card instead.
  if (kind === 'filtered' && unseenFiltered().length < GALLERY_MIN_NEW) kind = 'filter';
  let card: HTMLElement;
  if (kind === 'filtered') {
    card = renderGalleryCard(key);
  } else if (kind === 'filter') {
    const filterCard = renderFilterCard(key, !onHomeTimeline());
    card = filterCard;
    void fetchSuggestions(cell)
      .then(result => fillFilterCard(filterCard, result))
      .catch(err => console.error('[Bouncer] check-in fetch failed:', err));
  } else {
    card = renderSeeMoreCard(key);
  }
  cards.set(key, card);
  attachCard(card, cell);
  lastCardAt = Date.now();
  console.log(`[Checkin] ${kind} card placed under ${key}`);
  if (onHomeTimeline()) nextKind = NEXT_KIND[kind];
}

// ==================== Keeping cards visible ====================

const isCellHidden = (cell: HTMLElement) => !!cell.dataset.filteredByExtension || cell.style.display === 'none';

/** Puts a card in its cell — below the tweet, or above it once moved — and
 *  starts watching the cell for being hidden. */
function attachCard(card: HTMLElement, cell: HTMLElement): void {
  if (card.dataset.slot === 'above') {
    cell.prepend(card);
  } else {
    // Above a See-more post placed below the tweet (a topic added from this
    // card puts its first post right after it), whichever comes back first
    // when X remounts the cell.
    const post = cell.querySelector(`:scope > ${INJECTED_POST_SELECTOR}[data-slot="below"]`);
    if (post) post.before(card);
    else cell.appendChild(card);
  }
  hideObserver ??= new MutationObserver(records => {
    for (const { target } of records) {
      const watched = target as HTMLElement;
      const held = watched.querySelector<HTMLElement>(`:scope > .${CARD_CLASS}`);
      if (held && isCellHidden(watched)) keepCardVisible(held, watched);
    }
  });
  hideObserver.observe(cell, { attributes: true, attributeFilter: ['style', 'data-filtered-by-extension'] });
  if (isCellHidden(cell)) keepCardVisible(card, cell);
}

/** Moves a card out of a hidden cell: to the top of the next visible
 *  tweet's cell, or, at the end of what X has rendered, below the previous
 *  visible tweet. */
function keepCardVisible(card: HTMLElement, from: HTMLElement): void {
  const visible = (c: Element | null): c is HTMLElement =>
    c instanceof HTMLElement && !isCellHidden(c) && !!hostKeyOf(c);
  let to: Element | null = from.nextElementSibling;
  let slot: 'above' | 'below' = 'above';
  for (let i = 0; to && !visible(to) && i < MAX_CELLS_WALKED; i++) to = to.nextElementSibling;
  if (!visible(to)) {
    slot = 'below';
    to = from.previousElementSibling;
    for (let i = 0; to && !visible(to) && i < MAX_CELLS_WALKED; i++) to = to.previousElementSibling;
  }
  if (!visible(to)) return;
  const oldKey = card.dataset.hostKey;
  const newKey = hostKeyOf(to)!;
  if (oldKey && cards.get(oldKey) === card) cards.delete(oldKey);
  // A tweet that already has a card keeps it; this one goes.
  if (cards.get(newKey)) { card.remove(); return; }
  card.dataset.hostKey = newKey;
  card.dataset.slot = slot;
  cards.set(newKey, card);
  console.log(`[Checkin] card's tweet hidden; moved ${slot} ${newKey}`);
  attachCard(card, to);
}

// ==================== Card ====================

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function renderCard(hostKey: string, title: string, body: HTMLElement): HTMLElement {
  const card = el('div', CARD_CLASS);
  card.dataset.hostKey = hostKey;
  card.setAttribute('role', 'region');
  card.setAttribute('aria-label', title);
  // Keep taps inside the card from reaching X's cell handlers.
  card.addEventListener('click', e => e.stopPropagation());

  const header = el('div', 'bouncer-checkin-header');
  header.appendChild(el('span', 'bouncer-checkin-title', title));
  const close = el('button', 'bouncer-checkin-close', '×');
  close.type = 'button';
  close.setAttribute('aria-label', 'Dismiss');
  close.addEventListener('click', () => {
    cards.set(card.dataset.hostKey ?? hostKey, null);
    card.remove();
  });
  header.appendChild(close);
  body.classList.add('bouncer-checkin-body');
  card.append(header, body);
  return card;
}

const LOADING_PLACEHOLDERS = 2 + MIDDLE_SOURCES;

/** A filter card whose buttons are placeholders until fillFilterCard.
 *  `inReplies`: it's among a tweet's replies rather than on Home. */
function renderFilterCard(hostKey: string, inReplies: boolean): HTMLElement {
  // A row of topic-sized chips, like the See-more card's.
  const filters = el('div', 'bouncer-checkin-chips bouncer-checkin-filters');
  filters.setAttribute('aria-busy', 'true');
  for (let i = 0; i < LOADING_PLACEHOLDERS; i++) {
    filters.appendChild(el('div', 'bouncer-checkin-pill bouncer-checkin-chip bouncer-checkin-pill--loading'));
  }
  const card = renderCard(hostKey, inReplies ? 'Hide replies like these?' : 'Hide posts like these?', filters);
  if (inReplies) card.dataset.inReplies = 'true';
  return card;
}

function fillFilterCard(card: HTMLElement, suggestions: Suggestion[]): void {
  const body = card.querySelector<HTMLElement>('.bouncer-checkin-body');
  if (!body) return;
  if (!suggestions.length && card.dataset.inReplies) {
    // Nothing to filter, and See more doesn't apply to replies: drop it.
    cards.set(card.dataset.hostKey!, null);
    card.remove();
    return;
  }
  if (!suggestions.length) {
    // Nothing to filter after all: the card offers See more instead, and
    // the next one goes back to filters.
    const title = 'Want more posts about…?';
    card.setAttribute('aria-label', title);
    const titleEl = card.querySelector('.bouncer-checkin-title');
    if (titleEl) titleEl.textContent = title;
    const form = seeMoreForm();
    form.classList.add('bouncer-checkin-body');
    body.replaceWith(form);
    nextKind = NEXT_KIND.seeMore;
    return;
  }
  body.removeAttribute('aria-busy');
  body.replaceChildren(...suggestions.map(filterButton), phraseField());
  packChips(body);
}

function renderSeeMoreCard(hostKey: string): HTMLElement {
  return renderCard(hostKey, 'Want more posts about…?', seeMoreForm());
}

// ==================== Filtered-posts gallery ====================

const filteredKey = (fp: FilteredPost) => fp.post.postUrl || fp.evaluationText.substring(0, 200);
const unseenFiltered = () => getFilteredPosts().filter(fp => fp.timestamp > galleryShownUpTo);

const PANEL_CONTENT = '.filtered-modal-content, .ff-ios-filtered-modal-content';

/** Opens the "View filtered" panel (the apps' in-page sheet, else the
 *  desktop modal) scrolled to the post with `key`. */
function openFilteredPanel(key: string): void {
  const showAppModal = (window as Window & { __ff_showFilteredModal?: () => void }).__ff_showFilteredModal;
  if (isEmbeddedApp() && showAppModal) {
    showAppModal();
  } else {
    toggleFilteredTab(true);
    updateFilteredToggleButtons();
  }
  scrollPanelTo(key);
}

const PANEL_POST_GAP_PX = 12;      // between the panel's top edge and the post
const PANEL_PIN_MS = 3000;         // longest the post is held in place while the panel settles

/** Layout position (offsetTop chain): unlike getBoundingClientRect it
 *  ignores the desktop panel's scale-in transform. */
const layoutTop = (node: HTMLElement): number => {
  let y = 0;
  for (let n: HTMLElement | null = node; n; n = n.offsetParent as HTMLElement | null) y += n.offsetTop;
  return y;
};

/** Scrolls the open panel so the post with `key` sits just below its top,
 *  and flashes it so it's easy to spot. Both panels render synchronously,
 *  but the images above the post load afterwards and push it down, so it's
 *  pinned there as the panel resizes, until the user scrolls or touches it
 *  (or PANEL_PIN_MS passes). */
function scrollPanelTo(key: string): void {
  const selector = `[data-filtered-key="${CSS.escape(key)}"]`;
  const content = [...document.querySelectorAll<HTMLElement>(PANEL_CONTENT)].find(c => c.querySelector(selector));
  const post = content?.querySelector<HTMLElement>(selector);
  if (!content || !post) return;
  const pin = () => {
    // Looked up again: the panel re-renders its posts when the count changes.
    const target = content.querySelector<HTMLElement>(selector);
    if (!target) return;
    content.scrollTop = layoutTop(target) - layoutTop(content) - content.clientTop - PANEL_POST_GAP_PX;
  };
  pin();
  const resizes = new ResizeObserver(pin);
  resizes.observe(content);
  const list = content.firstElementChild;
  if (list) resizes.observe(list);
  const userEvents = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const;
  const release = () => {
    resizes.disconnect();
    clearTimeout(timer);
    userEvents.forEach(type => content.removeEventListener(type, release));
  };
  const timer = setTimeout(release, PANEL_PIN_MS);
  userEvents.forEach(type => content.addEventListener(type, release, { passive: true }));
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  post.animate([
    { backgroundColor: 'rgba(139, 92, 246, 0.22)' },
    { backgroundColor: 'rgba(139, 92, 246, 0)' },
  ], { duration: 1600, delay: 250, easing: 'ease-out', fill: 'backwards' });
}

/** A row of the most recently filtered posts, newest first. Each tile shows
 *  who posted it and the filter that caught it; the post itself stays
 *  blurred (the user asked not to see it), and a tap opens the panel. */
function renderGalleryCard(hostKey: string): HTMLElement {
  const unseen = unseenFiltered().length;
  const all = getFilteredPosts();
  const shown = all.slice(-GALLERY_MAX).reverse();
  const title = `Bouncer hid ${unseen}${galleryShownUpTo ? ' more' : ''} post${unseen === 1 ? '' : 's'}`;
  galleryShownUpTo = all[all.length - 1]?.timestamp ?? galleryShownUpTo;

  const row = el('div', 'bouncer-checkin-gallery');
  row.append(...shown.map(galleryTile));
  return renderCard(hostKey, title, row);
}

function galleryTile(fp: FilteredPost): HTMLButtonElement {
  const { post } = fp;
  const tile = el('button', 'bouncer-checkin-tile');
  tile.type = 'button';
  tile.dataset.filteredKey = filteredKey(fp);
  tile.setAttribute('aria-label', `Post by ${post.author || post.handle} hidden${fp.category ? ` for ${fp.category}` : ''}`);
  tile.addEventListener('click', () => openFilteredPanel(filteredKey(fp)));

  const author = el('div', 'bouncer-checkin-tile-author');
  if (post.avatarUrl) {
    const avatar = el('img', '');
    avatar.src = post.avatarUrl;
    avatar.alt = '';
    author.appendChild(avatar);
  }
  author.appendChild(el('span', '', post.author || post.handle || 'Post'));

  const content = el('div', 'bouncer-checkin-tile-body');
  content.setAttribute('aria-hidden', 'true');
  const image = (post.displayImageUrls ?? post.imageUrls)?.[0];
  if (image) {
    const img = el('img', '');
    img.src = image;
    img.alt = '';
    img.loading = 'lazy';
    content.appendChild(img);
  }
  if (post.text) content.appendChild(el('div', 'bouncer-checkin-tile-text', post.text));

  tile.append(author, content);
  const reason = fp.category?.split(',')[0]?.trim();
  if (reason) tile.appendChild(el('span', 'bouncer-checkin-tile-reason', reason));
  return tile;
}

/** Keeps placed galleries current: drops tiles of posts restored (or
 *  evicted) since. */
function syncGalleries(): void {
  const tiles = document.querySelectorAll<HTMLElement>('.bouncer-checkin-tile');
  if (!tiles.length) return;
  const keys = new Set(getFilteredPosts().map(filteredKey));
  tiles.forEach(tile => { if (!keys.has(tile.dataset.filteredKey ?? '')) tile.remove(); });
}

/** The source post's element if it's still mounted, else null. */
function sourceArticle({ key, cell }: SourcePost): HTMLElement | null {
  if (!cell.isConnected) return null;
  if (isInjectedPost(cell)) return cell;
  return hostKeyOf(cell) === key ? cell.querySelector<HTMLElement>(adapter!.selectors.post) : null;
}

/** Toggles the phrase as a filter. Adding it hides its source post right
 *  away, the way the trash-can does; removing it restores that post. */
function filterButton({ phrase, source }: Suggestion): HTMLButtonElement {
  const btn = el('button', 'bouncer-checkin-pill bouncer-checkin-chip');
  btn.type = 'button';
  // Just the phrase until it's added; then a ✓ in front of it.
  const setAdded = (added: boolean) => {
    btn.classList.toggle('bouncer-checkin-pill--done', added);
    btn.setAttribute('aria-pressed', String(added));
    btn.replaceChildren(...(added ? [markIcon('check')] : []), el('span', 'bouncer-checkin-pill-label', phrase));
  };
  setAdded(false);
  btn.addEventListener('click', () => {
    const adding = !btn.classList.contains('bouncer-checkin-pill--done');
    btn.disabled = true;
    void (async () => {
      const siteId = adapter!.siteId;
      if (adding) {
        // addFilterPhrase is false both for "already there" and for the
        // length limit (which shows its own warning); only hide the post
        // once the filter is in.
        await addFilterPhrase(phrase);
        if (!(await getDescriptions(`descriptions_${siteId}`)).includes(phrase)) return;
        const article = sourceArticle(source);
        bouncePost(article && !article.dataset.filteredByExtension ? article : null,
          source.content, `User blocked: ${phrase}`, phrase, [phrase]);
        setAdded(true);
        flyToBouncer(btn);
      } else {
        // The descriptions listener restores posts hidden under the phrase,
        // the source among them (its matches are just this phrase). Its
        // cache pin goes too, or the next evaluation would re-hide it.
        await chrome.runtime.sendMessage({
          type: 'clearSinglePost',
          siteId,
          post: formatPostForEvaluation(source.content),
          imageUrls: source.content.imageUrls || [],
          postUrl: source.content.postUrl || null,
        });
        await removeFilterPhrase(phrase);
        setAdded(false);
      }
    })().catch(err => console.error('[Bouncer] check-in filter toggle failed:', err))
      .finally(() => { btn.disabled = false; });
  });
  return btn;
}

/** A filter the user typed into the card (phraseField): tap to remove it,
 *  tap again to add it back. No source post to hide right away; the filter
 *  itself takes care of the feed. */
function ownPhraseButton(phrase: string): HTMLButtonElement {
  const btn = el('button', 'bouncer-checkin-pill bouncer-checkin-chip');
  btn.type = 'button';
  const setAdded = (added: boolean) => {
    btn.classList.toggle('bouncer-checkin-pill--done', added);
    btn.setAttribute('aria-pressed', String(added));
    btn.replaceChildren(...(added ? [markIcon('check')] : []), el('span', 'bouncer-checkin-pill-label', phrase));
  };
  setAdded(true);
  btn.addEventListener('click', () => {
    const adding = !btn.classList.contains('bouncer-checkin-pill--done');
    btn.disabled = true;
    void (async () => {
      if (adding) {
        await addFilterPhrase(phrase);
        const added = (await getDescriptions(`descriptions_${adapter!.siteId}`)).includes(phrase);
        setAdded(added);
        if (added) flyToBouncer(btn);
      } else {
        await removeFilterPhrase(phrase);
        setAdded(false);
      }
    })().catch(err => console.error('[Bouncer] check-in filter toggle failed:', err))
      .finally(() => { btn.disabled = false; });
  });
  return btn;
}

// ==================== Flying to the Bouncer UI ====================

const GHOST_CORNER_PX = 32;        // how far in from the screen's corner the ghost lands
const GHOST_MS = 750;

/** Where the main Bouncer UI is: the filter box in X's sidebar (desktop)
 *  when it's on screen, else the bottom-right corner — next to the apps'
 *  Bouncer button, just below the web view. */
function bouncerTarget(): { x: number; y: number } {
  const box = document.querySelector<HTMLElement>('.filter-phrases-sidebar')?.getBoundingClientRect();
  if (box && box.width > 0 && box.bottom > 0 && box.top < window.innerHeight) {
    return { x: box.left + box.width / 2, y: box.top + Math.min(box.height / 2, 60) };
  }
  return { x: window.innerWidth - GHOST_CORNER_PX, y: window.innerHeight - GHOST_CORNER_PX };
}

/** A ghost of a just-added chip flies off to the main Bouncer UI, to show
 *  where the filter or topic now lives. */
function flyToBouncer(chip: HTMLElement): void {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const from = chip.getBoundingClientRect();
  if (!from.width) return;
  // Wrapped in a card-classed box so it keeps the card's colors (and theme).
  const ghost = el('div', `${CARD_CLASS} bouncer-checkin-ghost`);
  ghost.setAttribute('aria-hidden', 'true');
  const copy = chip.cloneNode(true) as HTMLElement;
  copy.classList.remove('bouncer-checkin-chip--loading');
  copy.style.width = `${from.width}px`;
  copy.style.height = `${from.height}px`;
  ghost.appendChild(copy);
  ghost.style.left = `${from.left}px`;
  ghost.style.top = `${from.top}px`;
  document.body.appendChild(ghost);
  const to = bouncerTarget();
  const dx = to.x - (from.left + from.width / 2);
  const dy = to.y - (from.top + from.height / 2);
  // A slight lift first, then off into the corner, shrinking and fading.
  const flight = ghost.animate([
    { transform: 'translate(0, 0) scale(1)', opacity: 0.9 },
    { transform: `translate(${dx * 0.25}px, ${dy * 0.25 - 24}px) scale(0.9)`, opacity: 0.9, offset: 0.3 },
    { transform: `translate(${dx}px, ${dy}px) scale(0.2)`, opacity: 0 },
  ], { duration: GHOST_MS, easing: 'cubic-bezier(0.45, 0, 0.55, 1)' });
  const done = () => ghost.remove();
  flight.finished.then(done, done);
}

// Drawn rather than typed, to match X's icon weight.
const MARK_PATHS = { plus: 'M12 5v14M5 12h14', check: 'M5 12.5l4.5 4.5L19 7.5' };

function markIcon(kind: keyof typeof MARK_PATHS): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('class', 'bouncer-checkin-mark');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', MARK_PATHS[kind]);
  svg.appendChild(path);
  return svg;
}

const TOPIC_LOADING_CLASS = 'bouncer-checkin-chip--loading';

/** Pulses the topic chips whose topic was just added and is still loading
 *  its first post, like the desktop filter box's See-more chips. */
function setChipLoading(chip: HTMLElement, topic: string): void {
  const loading = isTopicLoading(topic);
  chip.classList.toggle(TOPIC_LOADING_CLASS, loading);
  if (loading) chip.setAttribute('aria-busy', 'true');
  else chip.removeAttribute('aria-busy');
}

function syncTopicChipsLoading(): void {
  document.querySelectorAll<HTMLElement>('.bouncer-checkin-chip[data-topic]').forEach(chip => {
    setChipLoading(chip, chip.dataset.topic ?? '');
  });
  flyLoadedTopics();
}

// Just-added topics' chips waiting for their pulse (first post loading) to
// end before their ghost flies to the Bouncer UI.
const pendingFlights = new Map<string, HTMLElement>();

/** Sends `chip`'s ghost to the Bouncer UI once `topic` stops loading. */
function flyAfterLoading(chip: HTMLElement, topic: string): void {
  pendingFlights.set(topic, chip);
  // The chip may not be in place yet (a typed topic's), nor loading yet.
  requestAnimationFrame(flyLoadedTopics);
}

function flyLoadedTopics(): void {
  for (const [topic, chip] of [...pendingFlights]) {
    if (isTopicLoading(topic)) continue;
    pendingFlights.delete(topic);
    if (chip.isConnected) flyToBouncer(chip);
  }
}

/** A See-more topic as a toggle: tap to add it, tap again to remove it. */
function topicChip(topic: string, added: boolean, status: HTMLElement): HTMLButtonElement {
  const chip = el('button', 'bouncer-checkin-pill bouncer-checkin-chip');
  chip.type = 'button';
  chip.dataset.topic = topic;
  const setAdded = (on: boolean) => {
    chip.classList.toggle('bouncer-checkin-pill--done', on);
    chip.setAttribute('aria-pressed', String(on));
    chip.replaceChildren(markIcon(on ? 'check' : 'plus'), el('span', '', topic)); // + marks it as "add this"

    setChipLoading(chip, topic);
  };
  setAdded(added);
  chip.addEventListener('click', () => {
    const adding = !chip.classList.contains('bouncer-checkin-pill--done');
    chip.disabled = true;
    status.textContent = '';
    void (async () => {
      if (!adding) { pendingFlights.delete(topic); await removeTopic(topic); setAdded(false); return; }
      // Its first post goes right below this card.
      if (await addTopic(topic, chip.closest<HTMLElement>(`.${CARD_CLASS}`) ?? undefined)) {
        setAdded(true);
        flyAfterLoading(chip, topic);
      }
      else status.textContent = 'Topic list is full';
    })().catch(err => console.error('[Bouncer] check-in topic toggle failed:', err))
      .finally(() => { chip.disabled = false; });
  });
  return chip;
}

function seeMoreForm(): HTMLElement {
  const wrapper = el('div', 'bouncer-checkin-see-more-body');
  // Topics are about to be tapped: have the backend connection ready (again
  // on a touch, in case it dropped since).
  warmBackend();
  wrapper.addEventListener('pointerdown', warmBackend);
  const status = el('div', 'bouncer-checkin-status');

  // A few topics to tap, leaving out ones already followed: most from the
  // picks for this user, one from each of a few of their interests (chosen at
  // random, so cards vary and no one interest takes over), the rest at random
  // from the suggestions (the backend's, else the field's examples), which
  // also fill in while there are no picks yet.
  const chips = el('div', 'bouncer-checkin-chips');
  void Promise.all([getStorage([SEE_MORE_TOPICS_KEY]), getTopicSuggestions()]).then(([d, { topics, pickGroups }]) => {
    const current = new Set((d[SEE_MORE_TOPICS_KEY] ?? []).map(t => t.toLowerCase()));
    const shuffle = <T,>(list: T[]) => list.map(t => ({ t, r: Math.random() })).sort((a, b) => a.r - b.r).map(x => x.t);
    const unfollowed = (list: string[]) => list.filter(t => !current.has(t.toLowerCase()));
    const personal = roundRobin(shuffle(pickGroups.map(g => shuffle(unfollowed(g))).filter(g => g.length)))
      .slice(0, SEE_MORE_PICKED_CHOICES);
    const taken = new Set(personal.map(t => t.toLowerCase()));
    const choices = [...personal, ...shuffle(unfollowed(topics)).filter(t => !taken.has(t.toLowerCase()))].slice(0, SEE_MORE_CHOICES);
    chips.prepend(...choices.map(t => topicChip(t, false, status)));
    packChips(chips);
  });
  // The field sits at the end of the topic row, shaped like a topic.
  chips.appendChild(topicField(chips, status));
  wrapper.append(chips, status);
  return wrapper;
}

const CHIP_GAP_PX = 8;              // .bouncer-checkin-chips gap

/** Reorders a card's chips (and its text field) so the rows they wrap into
 *  come out as full as they'll go: first-fit, widest first, the field into
 *  the first row with room for it. Chips keep their natural size, the same
 *  on both cards. Needs the row laid out (waits a frame if it isn't yet). */
function packChips(row: HTMLElement, retried = false): void {
  const width = row.clientWidth;
  const items = [...row.children] as HTMLElement[];
  if (!width || items.some(i => !i.offsetWidth)) {
    if (!retried) requestAnimationFrame(() => packChips(row, true));
    return;
  }
  const field = items.find(i => i.tagName === 'FORM');
  const chips = items.filter(i => i !== field).sort((a, b) => b.offsetWidth - a.offsetWidth);
  const rows: { left: number; items: HTMLElement[] }[] = [];
  const place = (item: HTMLElement) => {
    const w = item.offsetWidth + CHIP_GAP_PX;
    const fit = rows.find(r => r.left >= w - CHIP_GAP_PX);
    if (fit) { fit.items.push(item); fit.left -= w; }
    else rows.push({ left: width - w, items: [item] });
  };
  chips.forEach(place);
  if (field) place(field);
  row.append(...rows.flatMap(r => r.items));
}

/** A topic-shaped text field. What's typed in it is added on Enter / the
 *  keyboard's Done key, or on tapping away; the field then turns into that
 *  topic's chip, switched on, and a fresh field follows it. */
function topicField(chips: HTMLElement, status: HTMLElement): HTMLElement {
  return entryField('bouncer-checkin-see-more', 'See more posts about a topic', async topic => {
    status.textContent = '';
    if (await addTopic(topic, status.closest<HTMLElement>(`.${CARD_CLASS}`) ?? undefined)) {
      const chip = topicChip(topic, true, status);
      flyAfterLoading(chip, topic);
      return chip;
    }
    status.textContent = 'Already added or list full';
    return null;
  }, () => topicField(chips, status), 'plus'); // + like the topic chips beside it
}

/** A filter card's field for a phrase of the user's own, shaped like its
 *  chips (as topicField is). What's typed is added as a filter the same way
 *  as topicField's topics; it then turns into that phrase's chip, switched on. */
function phraseField(): HTMLElement {
  return entryField('bouncer-checkin-see-more', 'Hide posts about something else', async phrase => {
    await addFilterPhrase(phrase);
    // Already a filter counts as added; the length limit shows its own warning.
    if (!(await getDescriptions(`descriptions_${adapter!.siteId}`)).includes(phrase)) return null;
    const btn = ownPhraseButton(phrase);
    requestAnimationFrame(() => flyToBouncer(btn)); // once it's taken the field's place
    return btn;
  }, phraseField);
}

/** A text field that adds what's typed in it on Enter / the keyboard's Done
 *  key, or on tapping away: `add` returns the element that replaces the
 *  field (null keeps it, to try again), and `next()` a fresh field after it. */
function entryField(className: string, label: string, add: (text: string) => Promise<HTMLElement | null>,
  next: () => HTMLElement, mark?: keyof typeof MARK_PATHS): HTMLElement {
  const form = el('form', className);
  const input = el('input', 'bouncer-checkin-input');
  input.type = 'text';
  input.enterKeyHint = 'done';
  input.setAttribute('aria-label', label);
  input.addEventListener('keydown', e => e.stopPropagation()); // keep X's keyboard shortcuts out of the field
  // 16px from the first touch, before focus, so iOS doesn't zoom in on it
  // (it's the chips' 15px otherwise; see .bouncer-checkin-input--editing).
  input.addEventListener('touchstart', () => input.classList.add('bouncer-checkin-input--editing'), { passive: true });
  const notEditing = () => input.classList.remove('bouncer-checkin-input--editing');
  input.addEventListener('blur', notEditing);
  // A touch that scrolled the page instead never focuses it.
  const settle = () => setTimeout(() => { if (document.activeElement !== input) notEditing(); }, 300);
  input.addEventListener('touchend', settle, { passive: true });
  input.addEventListener('touchcancel', settle, { passive: true });
  input.placeholder = 'something else';
  // As wide as its text, like a chip: CSS field-sizing where the browser has
  // it (older WebKit doesn't), else the size attribute, kept up as it's typed.
  const fit = () => { input.size = Math.max(input.placeholder.length, input.value.length) + 1; };
  fit();
  input.addEventListener('input', fit);
  const field = el('span', 'bouncer-checkin-field');
  field.appendChild(input);
  // The chips' leading mark, drawn over the field's padding (a field can't
  // hold an icon itself).
  if (mark) {
    field.classList.add('bouncer-checkin-field--marked');
    field.appendChild(markIcon(mark));
  }
  // No submit button: a lone text field submits on Enter (implicit submission).
  form.appendChild(field);

  let committing = false;
  const commit = () => {
    const text = input.value.trim();
    if (!text || committing) return;
    committing = true;
    void add(text).then(added => {
      if (!added) { committing = false; return; }
      form.replaceWith(added);
      added.after(next());
    }).catch(err => {
      console.error('[Bouncer] check-in add failed:', err);
      committing = false;
    });
  };
  form.addEventListener('submit', e => {
    e.preventDefault();
    input.blur(); // dismisses the keyboard; the blur handler commits
    commit();
  });
  input.addEventListener('blur', commit);
  return form;
}
