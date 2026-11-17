// Feed check-in card (X home timeline: browser extension and apps): every so often a
// card slots into the timeline. Cards alternate between two kinds: filters
// for the posts around it (the trash-can's "Why is this annoying?"
// suggestions for them), and a field to add a "See more" topic.
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
// next tweet. The card element itself is kept by the tweet it hangs off, so
// a remounted cell gets it back as the user left it.
//
// Hiding a tweet hides its whole cell, card included — and the tweet above
// the card is one of its own suggestions' sources. So when the card's cell
// is hidden, the card moves to the top of the next visible tweet's cell
// (keepCardVisible), which keeps it in the same spot on screen.

import type { PlatformAdapter, PostContent } from '../types';
import { getDescriptions, getStorage } from '../shared/storage';
import { SEE_MORE_TOPICS_KEY } from '../shared/bluesky';
import { formatPostForEvaluation } from '../shared/utils';
import {
  addTopic, removeTopic, isInjectedPost, isTopicLoading, onTopicLoadingChange, INJECTED_POST_SELECTOR, TOPIC_PLACEHOLDERS,
} from './bluesky-see-more';
import { bouncePost } from './bounce-quote';
import { addFilterPhrase, removeFilterPhrase } from './ui';

// Posts between cards: FIRST_EVERY after the startup card, STEP_EVERY more
// after each card placed since, up to MAX_EVERY (10, 15, 20, 25, 25…).
const FIRST_EVERY = 10;
const STEP_EVERY = 5;
const MAX_EVERY = 25;
const MIDDLE_SOURCES = 2;          // posts two or more notches above
const MIN_SOURCE_TEXT = 20;        // shorter text-only posts get poor suggestions
const MAX_CELLS_WALKED = 12;
const PLACE_AHEAD_MARGIN = '0px 0px 200% 0px';
// The startup card: placed this long after the first Home post is seen
// (once the timeline has laid out a screenful), retried while there isn't
// a screenful yet.
const STARTUP_DELAY_MS = 1000;
const STARTUP_TRIES = 5;
const HEADER_PX = 120;             // X's sticky header (and then some)
const SEE_MORE_CHOICES = 4;        // preselected topics on a See-more card
const CARD_CLASS = 'bouncer-checkin';

/** A post a suggestion is about: its key, content, and cellInnerDiv (the
 *  post's own root for a "See more" post). */
interface SourcePost { key: string; content: PostContent; cell: HTMLElement }
/** A phrase and the post it was suggested for (and validated against). */
interface Suggestion { phrase: string; source: SourcePost }
type CardKind = 'filter' | 'seeMore';

let adapter: PlatformAdapter | null = null;
const countedKeys = new Set<string>();
let tweetsSince = 0;
let cardsPlaced = 0;              // since the startup card
let startupScheduled = false;
const checkinEvery = () => Math.min(MAX_EVERY, FIRST_EVERY + STEP_EVERY * cardsPlaced);
let slot: { key: string; cell: HTMLElement } | null = null;
// Placed cards by the tweet they hang off (below it, or above it once
// moved); null once dismissed, so a remount doesn't bring it back.
const cards = new Map<string, HTMLElement | null>();
// Watches the cells holding cards for being hidden.
let hideObserver: MutationObserver | null = null;
let observer: IntersectionObserver | null = null;
let slotNear = false;
let nextKind: CardKind = 'filter';

export function initFeedCheckin(platformAdapter: PlatformAdapter): void {
  if (platformAdapter.siteId !== 'twitter') return;
  adapter = platformAdapter;
  onTopicLoadingChange(syncTopicChipsLoading);
  console.log('[Checkin] enabled');
}

const onHomeTimeline = () => location.pathname === '/home';

const hostKeyOf = (cell: HTMLElement): string | null => {
  const article = cell.isConnected && adapter ? cell.querySelector<HTMLElement>(adapter.selectors.post) : null;
  return article ? adapter!.getPostContentKey(article) : null;
};

/** Called for every post the post observer processes (including recycled ones). */
export function noteCheckinPost(article: HTMLElement): void {
  if (!adapter || !onHomeTimeline()) return;
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

async function suggestFor(source: SourcePost): Promise<string[]> {
  try {
    const reply: { reasons?: string[] } | undefined = await chrome.runtime.sendMessage({
      type: 'suggestAnnoyingReasons',
      post: source.content.text,
      imageUrls: source.content.imageUrls || [],
      siteId: adapter!.siteId,
      quiet: true,
    });
    return reply?.reasons ?? [];
  } catch (err) {
    console.warn('[Bouncer] check-in suggestions failed:', err);
    return [];
  }
}

/** One phrase per source post, in card order (above, middle, below). The
 *  direct neighbors pick first, so a phrase they share with a middle post
 *  stays on the neighbor's button. */
async function fetchSuggestions(hostCell: HTMLElement): Promise<Suggestion[]> {
  const { above, middle, below } = sourcesAround(hostCell);
  const ordered = [above, ...middle, below];
  console.log(`[Checkin] fetching suggestions (above: ${!!above}, middle: ${middle.length}, below: ${!!below})`);
  const replies = await Promise.all(ordered.map(s => (s ? suggestFor(s) : Promise.resolve([]))));
  const existing = new Set((await getDescriptions(`descriptions_${adapter!.siteId}`)).map(d => d.toLowerCase()));
  const picked = new Map<number, string>();
  const last = ordered.length - 1;
  for (const i of [0, last, ...middle.map((_, j) => j + 1)]) {
    const phrase = replies[i].find(p => !existing.has(p.toLowerCase())
      && ![...picked.values()].some(q => q.toLowerCase() === p.toLowerCase()));
    if (phrase) picked.set(i, phrase);
  }
  const result: Suggestion[] = [];
  ordered.forEach((source, i) => {
    const phrase = picked.get(i);
    if (source && phrase) result.push({ phrase, source });
  });
  console.log('[Checkin] suggestions:', result.map(r => r.phrase));
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
  if (!adapter || !onHomeTimeline()) return;
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
  let card: HTMLElement;
  if (nextKind === 'filter') {
    const filterCard = renderFilterCard(key);
    card = filterCard;
    void fetchSuggestions(cell)
      .then(result => fillFilterCard(filterCard, result))
      .catch(err => console.error('[Bouncer] check-in fetch failed:', err));
  } else {
    card = renderSeeMoreCard(key);
  }
  cards.set(key, card);
  attachCard(card, cell);
  console.log(`[Checkin] ${nextKind} card placed under ${key}`);
  nextKind = nextKind === 'filter' ? 'seeMore' : 'filter';
}

// ==================== Keeping cards visible ====================

const isCellHidden = (cell: HTMLElement) => !!cell.dataset.filteredByExtension || cell.style.display === 'none';

/** Puts a card in its cell — below the tweet, or above it once moved — and
 *  starts watching the cell for being hidden. */
function attachCard(card: HTMLElement, cell: HTMLElement): void {
  if (card.dataset.slot === 'above') cell.prepend(card);
  else cell.appendChild(card);
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

/** A filter card whose buttons are placeholders until fillFilterCard. */
function renderFilterCard(hostKey: string): HTMLElement {
  const filters = el('div', 'bouncer-checkin-actions');
  filters.setAttribute('aria-busy', 'true');
  for (let i = 0; i < LOADING_PLACEHOLDERS; i++) {
    filters.appendChild(el('div', 'bouncer-checkin-pill bouncer-checkin-pill--loading'));
  }
  return renderCard(hostKey, 'Hide posts like these?', filters);
}

function fillFilterCard(card: HTMLElement, suggestions: Suggestion[]): void {
  const body = card.querySelector<HTMLElement>('.bouncer-checkin-body');
  if (!body) return;
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
    nextKind = 'filter';
    return;
  }
  body.removeAttribute('aria-busy');
  body.replaceChildren(...suggestions.map(filterButton));
}

function renderSeeMoreCard(hostKey: string): HTMLElement {
  return renderCard(hostKey, 'Want more posts about…?', seeMoreForm());
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
  const btn = el('button', 'bouncer-checkin-pill');
  btn.type = 'button';
  btn.append(markIcon('minus'), el('span', 'bouncer-checkin-pill-label', phrase));
  // − marks the button as "hide this" (the + on topic chips is "add this"), ✓ that it's done.
  const setAdded = (added: boolean) => {
    btn.classList.toggle('bouncer-checkin-pill--done', added);
    btn.setAttribute('aria-pressed', String(added));
    btn.firstElementChild!.replaceWith(markIcon(added ? 'check' : 'minus'));
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

// Drawn rather than typed: X's font sets − as a short, thin dash next to +.
const MARK_PATHS = { minus: 'M5 12h14', plus: 'M12 5v14M5 12h14', check: 'M5 12.5l4.5 4.5L19 7.5' };

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
      if (!adding) { await removeTopic(topic); setAdded(false); return; }
      if (await addTopic(topic)) setAdded(true);
      else status.textContent = 'Topic list is full';
    })().catch(err => console.error('[Bouncer] check-in topic toggle failed:', err))
      .finally(() => { chip.disabled = false; });
  });
  return chip;
}

function seeMoreForm(): HTMLElement {
  const wrapper = el('div', 'bouncer-checkin-see-more-body');
  const status = el('div', 'bouncer-checkin-status');

  // A few topics to tap, picked at random from the field's examples,
  // leaving out ones already followed.
  const chips = el('div', 'bouncer-checkin-chips');
  void getStorage([SEE_MORE_TOPICS_KEY]).then(d => {
    const current = new Set((d[SEE_MORE_TOPICS_KEY] ?? []).map(t => t.toLowerCase()));
    const choices = TOPIC_PLACEHOLDERS.filter(t => !current.has(t.toLowerCase()))
      .map(t => ({ t, r: Math.random() })).sort((a, b) => a.r - b.r).slice(0, SEE_MORE_CHOICES).map(x => x.t);
    chips.prepend(...choices.map(t => topicChip(t, false, status)));
  });
  // The field sits at the end of the topic row, shaped like a topic.
  chips.appendChild(topicField(chips, status));
  wrapper.append(chips, status);
  return wrapper;
}

/** A topic-shaped text field. What's typed in it is added on Enter / the
 *  keyboard's Done key, or on tapping away; the field then turns into that
 *  topic's chip, switched on, and a fresh field follows it. */
function topicField(chips: HTMLElement, status: HTMLElement): HTMLElement {
  const form = el('form', 'bouncer-checkin-see-more');
  const input = el('input', 'bouncer-checkin-input');
  input.type = 'text';
  input.enterKeyHint = 'done';
  input.setAttribute('aria-label', 'See more posts about a topic');
  input.addEventListener('keydown', e => e.stopPropagation()); // keep X's keyboard shortcuts out of the field
  input.placeholder = 'something else';
  const field = el('span', 'bouncer-checkin-field');
  field.appendChild(input);
  // No submit button: a lone text field submits on Enter (implicit submission).
  form.appendChild(field);

  let committing = false;
  const commit = () => {
    const topic = input.value.trim();
    if (!topic || committing) return;
    committing = true;
    status.textContent = '';
    void addTopic(topic).then(added => {
      if (!added) {
        status.textContent = 'Already added or list full';
        committing = false;
        return;
      }
      form.replaceWith(topicChip(topic, true, status));
      chips.appendChild(topicField(chips, status));
    }).catch(err => {
      console.error('[Bouncer] check-in add topic failed:', err);
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
