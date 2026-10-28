// "See more of <topic>" on X: Bluesky and/or X posts about the user's topics
// (the popup's "Draw from" setting; X posts come from the backend's xstream),
// rendered to look like tweets (Bluesky ones with a small Bluesky badge) and
// slotted into the home
// timeline.
//
// Placement: X's timeline is a virtualized list of absolutely-positioned
// cellInnerDiv nodes, so a sibling node would overlap its neighbours. Instead
// each injected post is appended INSIDE a real tweet's cell, below the tweet —
// X measures cells with a ResizeObserver, so the list makes room for it.
// Every Nth timeline tweet hosts one. The host's tweet URL maps to the
// injected post, so a cell that X unmounts and later remounts (scrolling
// back up) gets the same post again, and a cell X recycles for a different
// tweet drops it.
//
// The injected node is deliberately not an article[data-testid="tweet"], so
// the post observer, extractors and hidePost never mistake it for a tweet.
// Candidates are screened against the user's hide filters by sending them
// through the normal evaluatePost pipeline before they're shown.

import type { PlatformAdapter, PipelineResponse } from '../types';
import { getStorage, setStorage } from '../shared/storage';
import { formatPostForEvaluation } from '../shared/utils';
import {
  SEE_MORE_TOPICS_KEY, SEE_MORE_EVERY_KEY, SEE_MORE_SEEN_KEY, MAX_SEE_MORE_TOPICS, mergeSeenUris, MAX_SEE_MORE_TOPIC_LENGTH, clampSeeMoreEvery, formatCount, formatRelativeTime, normalizeTopic,
  SEE_MORE_SOURCE_KEY, clampSeeMoreSource, seeMoreSources,
  type BskyFeedPost, type BskySearchResult, type SeeMoreSource,
} from '../shared/bluesky';
import { currentPauseScope } from './ui';

const READY_TARGET = 3;          // screened posts to keep on hand per topic
const SWEEP_INTERVAL_MS = 1500;
const FILTER_CHECK_TIMEOUT_MS = 20000;
const SEARCH_RETRY_MS = 60000;
const INJECTED_CLASS = 'bsky-x-post';

interface TopicPool {
  ready: BskyFeedPost[];
  unchecked: BskyFeedPost[];
  cursor: string | null;
  exhausted: boolean;
  busy: boolean;
  /** After a failed search, don't hit Bluesky again before this time. */
  retryAt: number;
}

let adapter: PlatformAdapter;
let topics: string[] = [];
const pools = new Map<string, TopicPool>();
// Posts handed to the timeline in this page load (shown, or waiting for
// their host tweet), so none is placed twice.
const seenUris = new Set<string>();
// Posts the user has actually seen, in any tab and any earlier page load
// (SEE_MORE_SEEN_KEY). Candidates already in here are skipped.
const impressedUris = new Set<string>();
// Seen in this tab but not yet written to storage.
const pendingImpressions = new Set<string>();
// A post counts as seen once at least half of it has been on screen for this
// long — the usual definition of a feed impression. Fetched-but-never-shown
// posts are not marked, so they stay available.
const IMPRESSION_VISIBLE_RATIO = 0.5;
const IMPRESSION_DWELL_MS = 1000;
const IMPRESSION_FLUSH_MS = 5000;
let impressionObserver: IntersectionObserver | null = null;
const dwellTimers = new WeakMap<Element, ReturnType<typeof setTimeout>>();
// Observed post elements; sweep() unobserves the ones X or we have removed,
// since the observer would otherwise keep every discarded cell alive.
const observedRoots = new Set<HTMLElement>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
const postByHostKey = new Map<string, BskyFeedPost>();
// "1 in N posts" (the popup's frequency slider): after N - 1 tweets, the
// next post shown is a Bluesky one.
let injectEvery = clampSeeMoreEvery(undefined);
// The popup's "Draw from" setting: Bluesky, X, or both.
let sourceSetting = clampSeeMoreSource(undefined);
const SOURCE_NAME: Record<SeeMoreSource, string> = { bluesky: 'Bluesky', x: 'X' };
// Tweets already counted toward injectEvery, so remounts and re-scrolls
// don't raise the injection rate.
const countedHostKeys = new Set<string>();
let tweetsSinceInject = 0;
let nextTopic = 0;
let sweepTimer: ReturnType<typeof setInterval> | null = null;
const topicRows = new Set<HTMLElement>();

export function initBlueskySeeMore(platformAdapter: PlatformAdapter): void {
  if (platformAdapter.siteId !== 'twitter') return;
  adapter = platformAdapter;
  void getStorage([SEE_MORE_TOPICS_KEY, SEE_MORE_EVERY_KEY, SEE_MORE_SEEN_KEY, SEE_MORE_SOURCE_KEY]).then(d => {
    injectEvery = clampSeeMoreEvery(d[SEE_MORE_EVERY_KEY]);
    sourceSetting = clampSeeMoreSource(d[SEE_MORE_SOURCE_KEY]);
    for (const uri of d[SEE_MORE_SEEN_KEY] ?? []) impressedUris.add(uri);
    setTopics(d[SEE_MORE_TOPICS_KEY] ?? []);
  });
  // Save pending impressions when the tab is hidden or closed, rather than
  // losing up to IMPRESSION_FLUSH_MS of them.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void flushImpressions();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    // Impressions from other tabs, so they skip what this one has shown too.
    if (changes[SEE_MORE_SEEN_KEY]) for (const uri of (changes[SEE_MORE_SEEN_KEY].newValue as string[] | undefined) ?? []) impressedUris.add(uri);
    if (changes[SEE_MORE_EVERY_KEY]) injectEvery = clampSeeMoreEvery(changes[SEE_MORE_EVERY_KEY].newValue);
    if (changes[SEE_MORE_SOURCE_KEY]) {
      sourceSetting = clampSeeMoreSource(changes[SEE_MORE_SOURCE_KEY].newValue);
      // Candidates (and paging cursors) belong to the old source mix; start
      // every topic over. Posts already placed in the timeline stay.
      pools.clear();
      setTopics(topics);
    }
    if (changes[SEE_MORE_TOPICS_KEY]) setTopics((changes[SEE_MORE_TOPICS_KEY].newValue as string[] | undefined) ?? []);
  });
}

function setTopics(next: string[]): void {
  topics = next.slice(0, MAX_SEE_MORE_TOPICS);
  for (const t of [...pools.keys()]) if (!topics.includes(t)) pools.delete(t);
  for (const [key, post] of postByHostKey) if (!topics.includes(post.topic)) postByHostKey.delete(key);
  document.querySelectorAll<HTMLElement>(`.${INJECTED_CLASS}`).forEach(el => {
    if (!topics.includes(el.dataset.topic ?? '')) el.remove();
  });
  for (const t of topics) if (!pools.has(t)) pools.set(t, { ready: [], unchecked: [], cursor: null, exhausted: false, busy: false, retryAt: 0 });
  for (const t of topics) void refill(t);
  if (topics.length && !sweepTimer) sweepTimer = setInterval(sweep, SWEEP_INTERVAL_MS);
  if (!topics.length && sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
  topicRows.forEach(row => { if (row.isConnected) renderTopicChips(row); else topicRows.delete(row); });
}

// ==================== Candidate pool ====================

async function refill(topic: string): Promise<void> {
  const pool = pools.get(topic);
  if (!pool || pool.busy || Date.now() < pool.retryAt) return;
  pool.busy = true;
  try {
    while (pools.get(topic) === pool && pool.ready.length < READY_TARGET) {
      if (!pool.unchecked.length) {
        if (pool.exhausted) break;
        const res: (BskySearchResult & { error?: string }) | undefined = await chrome.runtime.sendMessage({ type: 'fetchBlueskyPosts', topic, cursor: pool.cursor, sources: seeMoreSources(sourceSetting) });
        if (!res?.posts || res.error) { pool.retryAt = Date.now() + SEARCH_RETRY_MS; break; }
        pool.cursor = res.cursor;
        // An empty window just means a quiet stretch; keep walking back.
        if (!res.cursor) pool.exhausted = true;
        pool.unchecked.push(...shuffled(res.posts.filter(p => !seenUris.has(p.uri) && !impressedUris.has(p.uri))));
        continue;
      }
      const post = pool.unchecked.shift()!;
      if (seenUris.has(post.uri) || impressedUris.has(post.uri)) continue;
      if (await passesHideFilters(post)) pool.ready.push(post);
    }
  } catch (err) {
    console.warn('[Bouncer] See more: refill failed for', topic, err);
  } finally {
    pool.busy = false;
  }
}

// Runs the candidate through the same pipeline as a real tweet, so the
// user's hide filters (and AI-content detection) apply to injected posts too.
// Anything other than a definite "hide" verdict lets the post through.
async function passesHideFilters(post: BskyFeedPost): Promise<boolean> {
  // Quoted text is folded in the way the X adapter does for quote tweets.
  const quoted = post.quote && post.quote !== 'unavailable' && post.quote.text ? ` [Quoted: ${post.quote.text}]` : '';
  const content = {
    text: post.text + quoted, author: post.authorName, handle: `@${post.authorHandle}`, avatarUrl: null,
    timeText: null, textHtml: '', quote: null, postUrl: post.url, imageUrls: [], hasMediaContainer: false,
  };
  try {
    const verdict: Promise<PipelineResponse | undefined> = chrome.runtime.sendMessage({
      type: 'evaluatePost',
      evaluationId: crypto.randomUUID(),
      post: formatPostForEvaluation(content),
      rawText: post.text,
      imageUrls: [],
      postUrl: post.url,
      siteId: 'twitter',
      pauseScope: currentPauseScope(),
      isReply: false,
    });
    // A torn-down message channel can leave sendMessage pending forever;
    // don't let that wedge the pool.
    const res = await Promise.race([verdict, new Promise<undefined>(r => setTimeout(r, FILTER_CHECK_TIMEOUT_MS))]);
    return !(res && typeof res === 'object' && 'shouldHide' in res && res.shouldHide === true);
  } catch {
    return true;
  }
}

/** A page of candidates in random order. Pages arrive best-first and every
 *  post on one has already passed the relevance check, so shuffling within
 *  a page keeps the overall order while two reloads don't serve exactly
 *  the same sequence. */
function shuffled<T>(items: T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// ==================== Impressions ====================

function observeImpression(root: HTMLElement, uri: string): void {
  if (impressedUris.has(uri) || typeof IntersectionObserver === 'undefined') return;
  impressionObserver ??= new IntersectionObserver(entries => {
    for (const entry of entries) {
      const target = entry.target as HTMLElement;
      if (entry.isIntersecting) {
        if (!dwellTimers.has(target)) {
          dwellTimers.set(target, setTimeout(() => {
            dwellTimers.delete(target);
            stopObserving(target);
            // Removed mid-dwell (X recycled the cell): not a full second on screen.
            if (target.isConnected) markImpressed(target.dataset.uri ?? '');
          }, IMPRESSION_DWELL_MS));
        }
      } else {
        clearTimeout(dwellTimers.get(target));
        dwellTimers.delete(target);
      }
    }
  }, { threshold: IMPRESSION_VISIBLE_RATIO });
  impressionObserver.observe(root);
  observedRoots.add(root);
}

function stopObserving(root: HTMLElement): void {
  impressionObserver?.unobserve(root);
  observedRoots.delete(root);
  clearTimeout(dwellTimers.get(root));
  dwellTimers.delete(root);
}

function markImpressed(uri: string): void {
  if (!uri || impressedUris.has(uri)) return;
  impressedUris.add(uri);
  pendingImpressions.add(uri);
  flushTimer ??= setTimeout(() => void flushImpressions(), IMPRESSION_FLUSH_MS);
}

// Batched, and merged with what's stored, so tabs don't overwrite each
// other's impressions.
async function flushImpressions(): Promise<void> {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  if (!pendingImpressions.size) return;
  const added = [...pendingImpressions];
  pendingImpressions.clear();
  try {
    const stored = (await getStorage([SEE_MORE_SEEN_KEY]))[SEE_MORE_SEEN_KEY] ?? [];
    await setStorage({ [SEE_MORE_SEEN_KEY]: mergeSeenUris(stored, added) });
  } catch (err) {
    console.warn('[Bouncer] See more: saving seen posts failed:', err);
    for (const uri of added) pendingImpressions.add(uri);
  }
}

function takePost(): BskyFeedPost | null {
  for (let i = 0; i < topics.length; i++) {
    const topic = topics[(nextTopic + i) % topics.length];
    const pool = pools.get(topic);
    if (!pool) continue;
    let post = pool.ready.shift();
    while (post && (seenUris.has(post.uri) || impressedUris.has(post.uri))) post = pool.ready.shift();
    void refill(topic);
    if (!post) continue;
    nextTopic = (nextTopic + i + 1) % topics.length;
    seenUris.add(post.uri);
    return post;
  }
  return null;
}

// ==================== Placement ====================

function onHomeTimeline(): boolean {
  return location.pathname === '/home';
}

/** Called for every tweet the post observer processes (including recycled ones). */
export function noteTimelinePost(article: HTMLElement): void {
  if (!adapter || !topics.length || !onHomeTimeline()) return;
  const cell = adapter.getPostContainer(article);
  if (cell === article) return;
  const hostKey = adapter.getPostContentKey(article);
  if (!hostKey) return;

  const existing = cell.querySelector<HTMLElement>(`:scope > .${INJECTED_CLASS}`);
  if (existing) {
    if (existing.dataset.hostKey === hostKey) return;
    existing.remove();
  }

  const assigned = postByHostKey.get(hostKey);
  if (assigned) { cell.appendChild(renderPost(assigned, hostKey)); return; }

  if (!countedHostKeys.has(hostKey)) {
    countedHostKeys.add(hostKey);
    tweetsSinceInject++;
  }
  if (tweetsSinceInject < injectEvery - 1) return;
  // Don't wedge a foreign post between the tweets of a self-thread.
  const next = cell.nextElementSibling;
  const threaded = (adapter as unknown as { _isReplyInThread?: (el: Element) => boolean })._isReplyInThread;
  if (next && threaded?.call(adapter, next)) return;
  if (cell.dataset.filteredByExtension) return;

  const post = takePost();
  if (!post) return;
  tweetsSinceInject = 0;
  postByHostKey.set(hostKey, post);
  cell.appendChild(renderPost(post, hostKey));
}

// X recycles cells and Bouncer hides filtered ones; drop injected posts whose
// host no longer matches, and give a hidden host's post to a later tweet.
function sweep(): void {
  for (const root of observedRoots) if (!root.isConnected) stopObserving(root);
  document.querySelectorAll<HTMLElement>(`.${INJECTED_CLASS}`).forEach(el => {
    const cell = el.parentElement;
    const article = cell?.querySelector<HTMLElement>(adapter.selectors.post);
    const hostKey = el.dataset.hostKey ?? '';
    if (!cell || !article || adapter.getPostContentKey(article) !== hostKey) {
      el.remove();
      return;
    }
    if (cell.dataset.filteredByExtension) {
      const post = postByHostKey.get(hostKey);
      postByHostKey.delete(hostKey);
      el.remove();
      if (post) {
        seenUris.delete(post.uri);
        pools.get(post.topic)?.ready.unshift(post);
        tweetsSinceInject = injectEvery;
      }
    }
  });
}

// ==================== Rendering ====================

const SVG_NS = 'http://www.w3.org/2000/svg';
const BLUESKY_LOGO_PATH = 'm135.72 44.03c66.496 49.921 138.02 151.14 164.28 205.46 26.262-54.316 97.782-155.54 164.28-205.46 47.98-36.021 125.72-63.892 125.72 24.795 0 17.712-10.155 148.79-16.111 170.07-20.703 73.984-96.144 92.854-163.25 81.433 117.3 19.964 147.14 86.092 82.697 152.22-122.39 125.59-175.91-31.511-189.63-71.766-2.514-7.3797-3.6904-10.832-3.7077-7.8964-0.0174-2.9357-1.1937 0.51669-3.7077 7.8964-13.714 40.255-67.233 197.36-189.63 71.766-64.444-66.128-34.605-132.26 82.697-152.22-67.108 11.421-142.55-7.4491-163.25-81.433-5.9562-21.282-16.111-152.36-16.111-170.07 0-88.687 77.742-60.816 125.72-24.795z';
const ICONS = {
  reply: 'M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5z',
  repost: 'M17 1l4 4-4 4M3 11V9a4 4 0 0 1 4-4h14M7 23l-4-4 4-4M21 13v2a4 4 0 0 1-4 4H3',
  like: 'M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8l1.1 1.1L12 21.2l7.8-7.8 1.1-1.1a5.5 5.5 0 0 0 0-7.8z',
  open: 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3',
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Open an x.com URL inside X's own app, the way X's links do: same tab, no
 *  reload, Back returns to the timeline. X's router follows history
 *  popstate. If X hasn't rendered the new page shortly after (the injected
 *  card is still on screen), that's logged and the page loads it in full. */
function openInX(url: string, from: HTMLElement): void {
  const target = new URL(url);
  history.pushState(null, '', target.pathname + target.search);
  window.dispatchEvent(new PopStateEvent('popstate', { state: null }));
  setTimeout(() => {
    if (from.isConnected && location.pathname === target.pathname) {
      console.warn('[Bouncer] See more: X did not route to', target.pathname, '- loading it in full');
      location.assign(target.href);
    }
  }, 1500);
}

/** Make an X post's x.com links open inside X (openInX) on a plain click;
 *  modified clicks (new tab, etc.) keep the browser's behavior. */
function routeLinksInX(root: HTMLElement): void {
  root.querySelectorAll<HTMLAnchorElement>('a[href^="https://x.com/"]').forEach(a => {
    a.removeAttribute('target');
    a.addEventListener('click', (e) => {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      e.stopPropagation();
      openInX(a.href, root);
    });
  });
}

function link(className: string, href: string, text?: string): HTMLAnchorElement {
  const a = el('a', className, text);
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  return a;
}

function strokeIcon(d: string): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', d);
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.75');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(path);
  return svg;
}

// The X logo, for posts drawn from X (the backend's xstream).
const X_LOGO_PATH = 'M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z';

function xLogo(className: string): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', className);
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', X_LOGO_PATH);
  path.setAttribute('fill', 'currentColor');
  svg.appendChild(path);
  return svg;
}

/** The logo of the network a post is from. */
function sourceLogo(source: SeeMoreSource, className: string): SVGSVGElement {
  return source === 'x' ? xLogo(className) : blueskyLogo(className);
}

function blueskyLogo(className: string): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 600 530');
  svg.setAttribute('class', className);
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', BLUESKY_LOGO_PATH);
  path.setAttribute('fill', 'currentColor');
  svg.appendChild(path);
  return svg;
}

function renderText(post: BskyFeedPost): HTMLElement {
  const body = el('div', 'bsky-x-text');
  let pos = 0;
  for (const l of post.links) {
    if (l.start > pos) body.append(post.text.slice(pos, l.start));
    body.appendChild(link('bsky-x-link', l.href, post.text.slice(l.start, l.end)));
    pos = l.end;
  }
  if (pos < post.text.length) body.append(post.text.slice(pos));
  return body;
}

// A load can fail transiently (network blip, a request Chrome cancels while
// X loads its own media, a momentary CDN error), so retry once with a
// cache-busting query before giving up. Some browsers (Safari, the iOS app)
// may also apply x.com's CSP to these images; that fails both attempts.
const IMAGE_RETRY_DELAY_MS = 1500;

function loadWithRetry(image: HTMLImageElement, url: string, onGiveUp: () => void): void {
  let retried = false;
  image.addEventListener('error', () => {
    if (!retried) {
      retried = true;
      setTimeout(() => { image.src = `${url}${url.includes('?') ? '&' : '?'}retry=1`; }, IMAGE_RETRY_DELAY_MS);
      return;
    }
    console.warn('[Bouncer] See more: image failed to load after a retry:', url);
    onGiveUp();
  });
  image.src = url;
}

function renderMedia(post: Pick<BskyFeedPost, 'images' | 'isVideo' | 'external'> & { source?: SeeMoreSource }): HTMLElement | null {
  if (post.images.length) {
    const grid = el('div', `bsky-x-media bsky-x-media-${Math.min(post.images.length, 4)}`);
    for (const img of post.images) {
      const image = el('img', 'bsky-x-media-img');
      image.referrerPolicy = 'no-referrer';
      // X-style single image: natural aspect, clamped between 3:4 and 2:1.
      if (post.images.length === 1) {
        image.style.aspectRatio = String(Math.min(2, Math.max(0.75, img.aspectRatio ?? 16 / 9)));
      }
      image.alt = img.alt;
      image.loading = 'lazy';
      // Keep the tile (same size and place) so the post never silently loses
      // its content; clicking it opens the post like the rest of the card.
      loadWithRetry(image, img.url, () => {
        const failed = el('div', 'bsky-x-media-img bsky-x-media-failed', `Image couldn't load · open on ${SOURCE_NAME[post.source ?? 'bluesky']}`);
        failed.style.aspectRatio = image.style.aspectRatio;
        image.replaceWith(failed);
      });
      grid.appendChild(image);
    }
    if (post.isVideo) grid.appendChild(el('span', 'bsky-x-play', '▶'));
    return grid;
  }
  if (post.external) {
    const card = link('bsky-x-card', post.external.uri);
    if (post.external.thumbUrl) {
      const thumb = el('img', 'bsky-x-card-thumb');
      thumb.referrerPolicy = 'no-referrer';
      loadWithRetry(thumb, post.external.thumbUrl, () => thumb.remove());
      thumb.alt = '';
      card.appendChild(thumb);
    }
    const meta = el('div', 'bsky-x-card-meta');
    meta.appendChild(el('div', 'bsky-x-card-domain', post.external.domain));
    if (post.external.title) meta.appendChild(el('div', 'bsky-x-card-title', post.external.title));
    card.appendChild(meta);
    return card;
  }
  return null;
}

// X's compact quote card: bordered box with a small avatar, the quoted
// author and time, the quoted text, and its media. Clicking it opens the
// quoted post rather than the outer one.
function renderQuote(quote: NonNullable<BskyFeedPost['quote']>): HTMLElement {
  if (quote === 'unavailable') return el('div', 'bsky-x-quote bsky-x-quote-unavailable', 'This post is unavailable.');
  const card = el('div', 'bsky-x-quote');
  card.setAttribute('role', 'link');
  const quoteIsX = quote.url.startsWith('https://x.com/');
  card.setAttribute('aria-label', `Quoted ${quoteIsX ? 'X' : 'Bluesky'} post by ${quote.authorName}`);

  const header = el('div', 'bsky-x-header bsky-x-quote-header');
  const avatar = el('span', 'bsky-x-quote-avatar');
  if (quote.avatarUrl) {
    const img = el('img', '');
    img.referrerPolicy = 'no-referrer';
    loadWithRetry(img, quote.avatarUrl, () => img.remove());
    img.alt = '';
    avatar.appendChild(img);
  }
  header.appendChild(avatar);
  header.appendChild(el('span', 'bsky-x-name', quote.authorName));
  header.appendChild(el('span', 'bsky-x-handle', `@${quote.authorHandle}`));
  header.appendChild(el('span', 'bsky-x-dot', '·'));
  const time = el('span', 'bsky-x-time', formatRelativeTime(quote.createdAt));
  if (quote.createdAt) time.title = new Date(quote.createdAt).toLocaleString();
  header.appendChild(time);
  card.appendChild(header);

  if (quote.text) card.appendChild(el('div', 'bsky-x-text bsky-x-quote-text', quote.text));
  const media = renderMedia(quote);
  if (media) card.appendChild(media);

  card.addEventListener('click', (e) => {
    if ((e.target as Element).closest('a')) return;
    if (window.getSelection()?.toString()) return;
    e.stopPropagation();
    if (quoteIsX) openInX(quote.url, card);
    else window.open(quote.url, '_blank', 'noopener');
  });
  return card;
}

function renderPost(post: BskyFeedPost, hostKey: string): HTMLElement {
  const root = el('div', INJECTED_CLASS);
  root.dataset.hostKey = hostKey;
  root.dataset.topic = post.topic;
  root.dataset.bouncerInjected = 'bluesky';
  root.dataset.source = post.source;
  root.dataset.uri = post.uri;
  observeImpression(root, post.uri);
  root.setAttribute('role', 'article');
  const sourceName = SOURCE_NAME[post.source];
  root.setAttribute('aria-label', `${sourceName} post by ${post.authorName}`);

  // Every injected post says which network it's from: logo + name here, and
  // a badge by the author's name.
  const context = el('div', `bsky-x-context bsky-x-source-${post.source}`);
  context.appendChild(sourceLogo(post.source, 'bsky-x-context-icon'));
  context.appendChild(el('span', '', `From ${sourceName} · See more of ${post.topic}`));
  root.appendChild(context);

  const row = el('div', 'bsky-x-row');
  const avatar = link('bsky-x-avatar', post.authorUrl);
  if (post.avatarUrl) {
    const img = el('img', '');
    img.referrerPolicy = 'no-referrer';
    loadWithRetry(img, post.avatarUrl, () => img.remove());
    img.alt = '';
    avatar.appendChild(img);
  }
  row.appendChild(avatar);

  const main = el('div', 'bsky-x-main');
  const header = el('div', 'bsky-x-header');
  const name = link('bsky-x-name', post.authorUrl, post.authorName);
  header.appendChild(name);
  const badge = el('span', `bsky-x-badge bsky-x-source-${post.source}`);
  badge.title = post.source === 'x'
    ? 'This post is from X (seen by other Bouncer users)'
    : 'This post is from Bluesky';
  badge.appendChild(sourceLogo(post.source, ''));
  header.appendChild(badge);
  header.appendChild(link('bsky-x-handle', post.authorUrl, `@${post.authorHandle}`));
  header.appendChild(el('span', 'bsky-x-dot', '·'));
  const time = link('bsky-x-time', post.url, formatRelativeTime(post.createdAt));
  if (post.createdAt) time.title = new Date(post.createdAt).toLocaleString();
  header.appendChild(time);
  main.appendChild(header);

  if (post.text) main.appendChild(renderText(post));
  const media = renderMedia(post);
  if (media) main.appendChild(media);
  if (post.quote) main.appendChild(renderQuote(post.quote));

  const actions = el('div', 'bsky-x-actions');
  const action = (kind: keyof typeof ICONS, count: number, label: string) => {
    const a = link(`bsky-x-action bsky-x-action-${kind}`, post.url);
    a.setAttribute('aria-label', `${label} on ${sourceName}`);
    a.appendChild(strokeIcon(ICONS[kind]));
    const c = formatCount(count);
    if (c) a.appendChild(el('span', '', c));
    return a;
  };
  actions.append(
    action('reply', post.replyCount, 'Reply'),
    action('repost', post.repostCount, 'Repost'),
    action('like', post.likeCount, 'Like'),
    action('open', 0, 'Open'),
  );
  main.appendChild(actions);
  row.appendChild(main);
  root.appendChild(row);

  // Like a tweet, a click anywhere that isn't a link opens the post — but
  // not when the user is selecting text.
  // X posts open natively, in X itself, where the replies are.
  if (post.source === 'x') routeLinksInX(root);
  root.addEventListener('click', (e) => {
    if ((e.target as Element).closest('a')) return;
    if (window.getSelection()?.toString()) return;
    if (post.source === 'x') openInX(post.url, root);
    else window.open(post.url, '_blank', 'noopener');
  });
  return root;
}

// ==================== Topic input (sidebar filter box) ====================

// Cycling examples in the empty topic field. Exactly as many as the "Filter
// out" placeholder has (PLACEHOLDER_PHRASES in ui.ts), because both tracks
// run on the same ff-placeholder-scroll keyframes, which step once per item.
const TOPIC_PLACEHOLDERS = ['optimism', 'cute animals', 'urban planning', 'space exploration', 'woodworking', 'local news',
  'birdwatching', 'people being kind', 'indie games', 'gardening', 'science breakthroughs', 'cooking'];

/** Fills the "See more of …" row in an X filter box. It is built from the
 *  same pieces as the "Filter out [phrases] and [input]" sentence above it,
 *  so it reads and behaves the same: chips with Oxford commas, "and", an
 *  auto-growing field whose cycling placeholder only shows with no topics,
 *  Enter or comma to add. Its own row class instead of .filter-phrases-header
 *  keeps the filter's pause dimming off it. */
export function mountSeeMoreRow(row: HTMLElement): void {
  if (!adapter) return;
  topicRows.add(row);

  const andInput = el('span', 'filter-phrases-and-input');
  andInput.appendChild(el('span', 'filter-phrases-and', 'and'));
  const wrapper = el('span', 'filter-input-wrapper');
  const input = el('textarea', 'filter-phrases-input bsky-see-more-input');
  input.rows = 1;
  input.maxLength = MAX_SEE_MORE_TOPIC_LENGTH;
  input.setAttribute('aria-label', 'See more posts about a topic');
  const cycle = el('span', 'filter-placeholder-cycle');
  cycle.setAttribute('aria-hidden', 'true');
  // bsky-see-more-track: excluded from setKeepOnlyMode's swap of the filter
  // examples into every placeholder track.
  const track = el('span', 'filter-placeholder-track bsky-see-more-track');
  for (const t of [...TOPIC_PLACEHOLDERS, TOPIC_PLACEHOLDERS[0]]) track.appendChild(el('span', '', t));
  cycle.appendChild(track);
  wrapper.append(input, cycle);
  andInput.appendChild(wrapper);
  row.replaceChildren(el('span', 'filter-phrases-label', 'See more of'), el('span', 'filter-phrases-list'), andInput);

  // Same auto-grow and "claim the whole row once it wraps" behavior as the
  // filter input (see autosizeInput in ui.ts).
  const autosize = () => {
    input.style.height = 'auto';
    const borderY = input.offsetHeight - input.clientHeight;
    input.style.height = `${input.scrollHeight + borderY}px`;
    if (input.value === '') { row.classList.remove('input-wraps'); return; }
    if (row.classList.contains('input-wraps')) return;
    const lineHeightPx = parseFloat(getComputedStyle(input).lineHeight) || 22;
    if (input.scrollHeight > lineHeightPx * 1.5) {
      row.classList.add('input-wraps');
      input.style.height = 'auto';
      input.style.height = `${input.scrollHeight + borderY}px`;
    }
  };
  const submit = (raw: string) => {
    const topic = normalizeTopic(raw);
    input.value = '';
    renderTopicChips(row);
    autosize();
    if (topic) void addTopic(topic);
  };
  input.addEventListener('input', () => { renderTopicChips(row); autosize(); });
  input.addEventListener('keydown', (e) => e.stopPropagation()); // keep X's keyboard shortcuts out of the field
  input.addEventListener('keypress', (e) => {
    if (e.key !== 'Enter' && e.key !== ',') return;
    e.preventDefault();
    submit(input.value);
  });
  input.addEventListener('paste', (e) => {
    const pasted = e.clipboardData?.getData('text') ?? '';
    if (!pasted.includes(',')) return;
    e.preventDefault();
    for (const t of pasted.split(',')) submit(t);
  });
  renderTopicChips(row);
}

function renderTopicChips(row: HTMLElement): void {
  const list = row.querySelector('.filter-phrases-list');
  const input = row.querySelector<HTMLTextAreaElement>('.bsky-see-more-input');
  if (!list) return;
  // Mirrors renderPhrasesInContainer in ui.ts: each chip and its trailing
  // comma share one wrapper, with a comma after every chip once there are two.
  list.replaceChildren(...topics.map(t => {
    const item = el('span', 'filter-phrase-item');
    const chip = el('span', 'filter-phrase-inline', t);
    chip.title = 'Click to remove';
    chip.addEventListener('click', () => void removeTopic(t));
    item.appendChild(chip);
    if (topics.length > 1) item.appendChild(el('span', 'filter-phrase-separator', ', '));
    return item;
  }));
  row.querySelector('.filter-placeholder-cycle')?.classList.toggle('hidden', topics.length > 0 || !!input?.value);
  const andInput = row.querySelector<HTMLElement>('.filter-phrases-and-input');
  if (andInput) andInput.style.display = topics.length >= MAX_SEE_MORE_TOPICS ? 'none' : '';
}

async function addTopic(topic: string): Promise<void> {
  const current = (await getStorage([SEE_MORE_TOPICS_KEY]))[SEE_MORE_TOPICS_KEY] ?? [];
  if (current.some(t => t.toLowerCase() === topic.toLowerCase())) return;
  if (current.length >= MAX_SEE_MORE_TOPICS) return;
  await setStorage({ [SEE_MORE_TOPICS_KEY]: [...current, topic] });
}

async function removeTopic(topic: string): Promise<void> {
  const current = (await getStorage([SEE_MORE_TOPICS_KEY]))[SEE_MORE_TOPICS_KEY] ?? [];
  await setStorage({ [SEE_MORE_TOPICS_KEY]: current.filter(t => t !== topic) });
}
