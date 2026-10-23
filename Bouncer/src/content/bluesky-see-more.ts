// "See more of <topic>" on X: Bluesky posts about the user's topics, rendered
// to look like tweets (with a small Bluesky badge) and slotted into the home
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
  SEE_MORE_TOPICS_KEY, MAX_SEE_MORE_TOPICS, formatCount, formatRelativeTime, normalizeTopic,
  type BskyFeedPost, type BskySearchResult,
} from '../shared/bluesky';
import { currentPauseScope } from './ui';

const INJECT_EVERY = 5;          // one Bluesky post per this many timeline tweets
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
const seenUris = new Set<string>();
const postByHostKey = new Map<string, BskyFeedPost>();
// Tweets already counted toward INJECT_EVERY, so remounts and re-scrolls
// don't raise the injection rate.
const countedHostKeys = new Set<string>();
let tweetsSinceInject = 0;
let nextTopic = 0;
let sweepTimer: ReturnType<typeof setInterval> | null = null;
const topicRows = new Set<HTMLElement>();

export function initBlueskySeeMore(platformAdapter: PlatformAdapter): void {
  if (platformAdapter.siteId !== 'twitter') return;
  adapter = platformAdapter;
  void getStorage([SEE_MORE_TOPICS_KEY]).then(d => setTopics(d[SEE_MORE_TOPICS_KEY] ?? []));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[SEE_MORE_TOPICS_KEY]) return;
    setTopics((changes[SEE_MORE_TOPICS_KEY].newValue as string[] | undefined) ?? []);
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
        const res: (BskySearchResult & { error?: string }) | undefined = await chrome.runtime.sendMessage({ type: 'fetchBlueskyPosts', topic, cursor: pool.cursor });
        if (!res?.posts || res.error) { pool.retryAt = Date.now() + SEARCH_RETRY_MS; break; }
        pool.cursor = res.cursor;
        // An empty window just means a quiet stretch; keep walking back.
        if (!res.cursor) pool.exhausted = true;
        pool.unchecked.push(...res.posts.filter(p => !seenUris.has(p.uri)));
        continue;
      }
      const post = pool.unchecked.shift()!;
      if (seenUris.has(post.uri)) continue;
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
  const content = {
    text: post.text, author: post.authorName, handle: `@${post.authorHandle}`, avatarUrl: null,
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

function takePost(): BskyFeedPost | null {
  for (let i = 0; i < topics.length; i++) {
    const topic = topics[(nextTopic + i) % topics.length];
    const pool = pools.get(topic);
    if (!pool) continue;
    let post = pool.ready.shift();
    while (post && seenUris.has(post.uri)) post = pool.ready.shift();
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
  if (tweetsSinceInject < INJECT_EVERY) return;
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
        tweetsSinceInject = INJECT_EVERY;
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

function renderMedia(post: BskyFeedPost): HTMLElement | null {
  if (post.images.length) {
    const grid = el('div', `bsky-x-media bsky-x-media-${Math.min(post.images.length, 4)}`);
    for (const img of post.images) {
      const image = el('img', 'bsky-x-media-img');
      image.referrerPolicy = 'no-referrer';
      // Some browsers (Safari, the iOS app) may still apply x.com's CSP to
      // these; drop a broken grid rather than show empty boxes.
      image.addEventListener('error', () => grid.remove(), { once: true });
      // X-style single image: natural aspect, clamped between 3:4 and 2:1.
      if (post.images.length === 1) {
        image.style.aspectRatio = String(Math.min(2, Math.max(0.75, img.aspectRatio ?? 16 / 9)));
      }
      image.src = img.url;
      image.alt = img.alt;
      image.loading = 'lazy';
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
      thumb.addEventListener('error', () => thumb.remove(), { once: true });
      thumb.src = post.external.thumbUrl;
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

function renderPost(post: BskyFeedPost, hostKey: string): HTMLElement {
  const root = el('div', INJECTED_CLASS);
  root.dataset.hostKey = hostKey;
  root.dataset.topic = post.topic;
  root.dataset.bouncerInjected = 'bluesky';
  root.setAttribute('role', 'article');
  root.setAttribute('aria-label', `Bluesky post by ${post.authorName}`);

  const context = el('div', 'bsky-x-context');
  context.appendChild(blueskyLogo('bsky-x-context-icon'));
  context.appendChild(el('span', '', `From Bluesky · See more of ${post.topic}`));
  root.appendChild(context);

  const row = el('div', 'bsky-x-row');
  const avatar = link('bsky-x-avatar', post.authorUrl);
  if (post.avatarUrl) {
    const img = el('img', '');
    img.referrerPolicy = 'no-referrer';
    img.addEventListener('error', () => img.remove(), { once: true });
    img.src = post.avatarUrl;
    img.alt = '';
    avatar.appendChild(img);
  }
  row.appendChild(avatar);

  const main = el('div', 'bsky-x-main');
  const header = el('div', 'bsky-x-header');
  const name = link('bsky-x-name', post.authorUrl, post.authorName);
  header.appendChild(name);
  const badge = el('span', 'bsky-x-badge');
  badge.title = 'This post is from Bluesky';
  badge.appendChild(blueskyLogo(''));
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

  const actions = el('div', 'bsky-x-actions');
  const action = (kind: keyof typeof ICONS, count: number, label: string) => {
    const a = link(`bsky-x-action bsky-x-action-${kind}`, post.url);
    a.setAttribute('aria-label', `${label} on Bluesky`);
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
  root.addEventListener('click', (e) => {
    if ((e.target as Element).closest('a')) return;
    if (window.getSelection()?.toString()) return;
    window.open(post.url, '_blank', 'noopener');
  });
  return root;
}

// ==================== Topic input (sidebar filter box) ====================

/** Fills the "See more of …" row in an X filter box. */
export function mountSeeMoreRow(row: HTMLElement): void {
  if (!adapter) return;
  topicRows.add(row);
  row.replaceChildren(
    el('span', 'bsky-see-more-label', 'See more of'),
    el('span', 'bsky-see-more-list'),
  );
  const input = el('input', 'bsky-see-more-input');
  input.type = 'text';
  input.placeholder = 'a topic, from Bluesky';
  input.maxLength = 60;
  input.setAttribute('aria-label', 'See more posts about a topic, from Bluesky');
  input.addEventListener('keydown', (e) => {
    e.stopPropagation(); // keep X's keyboard shortcuts out of the field
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const topic = normalizeTopic(input.value);
    if (!topic) return;
    input.value = '';
    void addTopic(topic);
  });
  row.appendChild(input);
  renderTopicChips(row);
}

function renderTopicChips(row: HTMLElement): void {
  const list = row.querySelector('.bsky-see-more-list');
  const input = row.querySelector<HTMLInputElement>('.bsky-see-more-input');
  if (!list) return;
  list.replaceChildren(...topics.map((t, i) => {
    const item = el('span', 'bsky-see-more-item');
    const chip = el('span', 'filter-phrase-inline bsky-see-more-topic', t);
    chip.title = 'Click to remove';
    chip.addEventListener('click', () => void removeTopic(t));
    item.appendChild(chip);
    if (i < topics.length - 1) item.appendChild(el('span', 'filter-phrase-separator', ', '));
    return item;
  }));
  if (input) input.style.display = topics.length >= MAX_SEE_MORE_TOPICS ? 'none' : '';
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
