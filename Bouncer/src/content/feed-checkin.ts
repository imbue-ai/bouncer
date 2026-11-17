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
// for it. Every CHECKIN_EVERY posts (tweets and "See more" posts alike) one
// becomes due. Once it comes within PLACE_AHEAD_MARGIN of the viewport the
// card goes in — a filter card with placeholder buttons that fill in when
// the suggestions arrive (or turn it into a See-more card if there are
// none) — but only while its spot is still below the screen, so nothing
// pops in where the user is looking; a slot already on screen passes to the
// next tweet. The card element itself is kept by host tweet, so a remounted
// cell gets it back as the user left it.

import type { PlatformAdapter, PostContent } from '../types';
import { getDescriptions } from '../shared/storage';
import { formatPostForEvaluation } from '../shared/utils';
import { addTopic, isInjectedPost, INJECTED_POST_SELECTOR, TOPIC_PLACEHOLDERS } from './bluesky-see-more';
import { bouncePost } from './bounce-quote';
import { addFilterPhrase, removeFilterPhrase } from './ui';

const CHECKIN_EVERY = 25;          // posts between cards
const MIDDLE_SOURCES = 2;          // posts two or more notches above
const MIN_SOURCE_TEXT = 20;        // shorter text-only posts get poor suggestions
const MAX_CELLS_WALKED = 12;
const PLACE_AHEAD_MARGIN = '0px 0px 200% 0px';
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
let slot: { key: string; cell: HTMLElement } | null = null;
// Placed cards by host tweet; null once dismissed, so a remount doesn't
// bring it back.
const cards = new Map<string, HTMLElement | null>();
let observer: IntersectionObserver | null = null;
let slotNear = false;
let nextKind: CardKind = 'filter';

export function initFeedCheckin(platformAdapter: PlatformAdapter): void {
  if (platformAdapter.siteId !== 'twitter') return;
  adapter = platformAdapter;
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
  if (injected) { count(key); return; }

  cell.querySelectorAll<HTMLElement>(`:scope > .${CARD_CLASS}`).forEach(e => {
    if (e.dataset.hostKey !== key) e.remove();
  });
  if (cards.has(key)) {
    const card = cards.get(key);
    if (card && card.parentElement !== cell) cell.appendChild(card);
    return;
  }
  if (slot?.key === key) { slot.cell = cell; watch(cell); return; }

  count(key);
  // A slot whose tweet got filtered never comes near (hidden cells don't
  // intersect), and one the user never scrolled to is stale: pass it on.
  if (slot && ((hostKeyOf(slot.cell) === slot.key && slot.cell.dataset.filteredByExtension) || tweetsSince >= CHECKIN_EVERY)) {
    releaseSlot(true);
  }
  if (slot || tweetsSince < CHECKIN_EVERY) return;
  if (cell.dataset.filteredByExtension) return;
  // Not under a tweet that already hosts a "See more" post, and not wedged
  // between the tweets of a self-thread.
  if (cell.querySelector(':scope > .bsky-x-post')) return;
  const next = cell.nextElementSibling;
  const threaded = (adapter as unknown as { _isReplyInThread?: (el: Element) => boolean })._isReplyInThread;
  if (next && threaded?.call(adapter, next)) return;

  tweetsSince = 0;
  slot = { key, cell };
  console.log('[Checkin] slot due under', key);
  watch(cell);
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
  if (nextTweetTakesOver) tweetsSince = CHECKIN_EVERY;
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
    console.log('[Checkin] slot already on screen; passing to the next tweet');
    releaseSlot(true);
    return;
  }
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
  cell.appendChild(card);
  console.log(`[Checkin] ${nextKind} card placed under`, key);
  nextKind = nextKind === 'filter' ? 'seeMore' : 'filter';
  releaseSlot(false);
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
    cards.set(hostKey, null);
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
  return renderCard(hostKey, 'Filter out?', filters);
}

function fillFilterCard(card: HTMLElement, suggestions: Suggestion[]): void {
  const body = card.querySelector<HTMLElement>('.bouncer-checkin-body');
  if (!body) return;
  if (!suggestions.length) {
    // Nothing to filter after all: the card offers See more instead, and
    // the next one goes back to filters.
    const title = 'See more of?';
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
  return renderCard(hostKey, 'See more of?', seeMoreForm());
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
  const label = el('span', 'bouncer-checkin-pill-label', phrase);
  btn.appendChild(label);
  const setAdded = (added: boolean) => {
    btn.classList.toggle('bouncer-checkin-pill--done', added);
    btn.setAttribute('aria-pressed', String(added));
    label.textContent = added ? `✓ ${phrase}` : phrase;
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

function seeMoreForm(): HTMLElement {
  const form = el('form', 'bouncer-checkin-see-more');
  const input = el('input', 'bouncer-checkin-input');
  input.type = 'text';
  input.enterKeyHint = 'done';
  input.setAttribute('aria-label', 'See more posts about a topic');
  input.addEventListener('keydown', e => e.stopPropagation()); // keep X's keyboard shortcuts out of the field
  // Cycling examples in the empty field, like the desktop "See more" row:
  // the same topics, on the ff-placeholder-scroll keyframes ui.ts injects.
  // bsky-see-more-track keeps setKeepOnlyMode from swapping its contents.
  const field = el('span', 'bouncer-checkin-field');
  const cycle = el('span', 'filter-placeholder-cycle bouncer-checkin-cycle');
  cycle.setAttribute('aria-hidden', 'true');
  const track = el('span', 'filter-placeholder-track bsky-see-more-track');
  for (const t of [...TOPIC_PLACEHOLDERS, TOPIC_PLACEHOLDERS[0]]) track.appendChild(el('span', '', t));
  cycle.appendChild(track);
  field.append(input, cycle);
  input.addEventListener('input', () => cycle.classList.toggle('hidden', input.value !== ''));
  const submit = el('button', 'bouncer-checkin-pill bouncer-checkin-submit', 'Add');
  submit.type = 'submit';
  const status = el('div', 'bouncer-checkin-status');
  form.append(field, submit, status);
  form.addEventListener('submit', e => {
    e.preventDefault();
    const topic = input.value.trim();
    if (!topic) { input.focus(); return; }
    submit.disabled = true;
    void addTopic(topic).then(added => {
      if (added) {
        input.blur();
        form.replaceChildren(el('div', 'bouncer-checkin-status', `✓ ${topic}`));
      } else {
        submit.disabled = false;
        status.textContent = 'Already added or list full';
      }
    }).catch(err => {
      console.error('[Bouncer] check-in add topic failed:', err);
      submit.disabled = false;
    });
  });
  return form;
}
