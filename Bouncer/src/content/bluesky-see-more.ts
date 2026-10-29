// "See more <topic>" on X: Bluesky and/or X posts about the user's topics
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
  SEE_MORE_SOURCE_KEY, SEE_MORE_SHOW_NSFW_KEY, clampSeeMoreSource, seeMoreSources,
  type BskyFeedPost, type BskyQuotedPost, type BskySearchResult, type SeeMoreSource,
} from '../shared/bluesky';
import { currentPauseScope } from './ui';

const READY_TARGET = 3;          // screened posts to keep on hand per topic
const HIDE_CHECK_CONCURRENCY = 4; // candidates screened against hide filters at once
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
// Posts placed in the timeline, by slot (slotKey): normally under their host
// tweet; introducePost can also put one above it, so a host has up to two.
// A recycled cell re-renders them from here in the same spots.
const postBySlot = new Map<string, BskyFeedPost>();
type Slot = 'above' | 'below';
const slotKey = (hostKey: string, slot: Slot) => `${slot}:${hostKey}`;
// "1 in N posts" (the popup's frequency slider): after N - 1 tweets, the
// next post shown is a Bluesky one.
let injectEvery = clampSeeMoreEvery(undefined);
// The popup's "Draw from" setting: Bluesky, X, or both.
let sourceSetting = clampSeeMoreSource(undefined);
// The popup's NSFW toggle; adult and graphic posts are skipped unless it's on.
let showNsfw = false;
const allowed = (post: BskyFeedPost) => showNsfw || !post.nsfw;
// A reply's parent counts as shown along with it: no second reply under the
// same parent, and no parent again as a post of its own.
const shownUris = (post: BskyFeedPost) => (post.parent ? [post.uri, post.parent.uri] : [post.uri]);
const alreadyShown = (post: BskyFeedPost) => shownUris(post).some(u => seenUris.has(u) || impressedUris.has(u));
const SOURCE_NAME: Record<SeeMoreSource, string> = { bluesky: 'Bluesky', x: 'X' };
// Tweets already counted toward injectEvery, so remounts and re-scrolls
// don't raise the injection rate.
const countedHostKeys = new Set<string>();
let tweetsSinceInject = 0;
let nextTopic = 0;
// Topics just added in this tab: their chip pulses until the first post is
// ready, and that post is then slid into view (introducePost) instead of
// waiting for the user to scroll to the next slot.
const introTopics = new Set<string>();
let sweepTimer: ReturnType<typeof setInterval> | null = null;
const topicRows = new Set<HTMLElement>();

export function initBlueskySeeMore(platformAdapter: PlatformAdapter): void {
  if (platformAdapter.siteId !== 'twitter') return;
  adapter = platformAdapter;
  void getStorage([SEE_MORE_TOPICS_KEY, SEE_MORE_EVERY_KEY, SEE_MORE_SEEN_KEY, SEE_MORE_SOURCE_KEY, SEE_MORE_SHOW_NSFW_KEY]).then(d => {
    injectEvery = clampSeeMoreEvery(d[SEE_MORE_EVERY_KEY]);
    sourceSetting = clampSeeMoreSource(d[SEE_MORE_SOURCE_KEY]);
    showNsfw = d[SEE_MORE_SHOW_NSFW_KEY] === true;
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
    if (changes[SEE_MORE_SHOW_NSFW_KEY]) {
      showNsfw = changes[SEE_MORE_SHOW_NSFW_KEY].newValue === true;
      if (!showNsfw) {
        // Take down NSFW posts already placed in the timeline.
        for (const [key, post] of postBySlot) if (post.nsfw) postBySlot.delete(key);
        document.querySelectorAll<HTMLElement>(`.${INJECTED_CLASS}[data-nsfw]`).forEach(el => el.remove());
      }
      // Pages fetched with the setting off dropped NSFW posts; start over so
      // turning it on can show them.
      pools.clear();
      setTopics(topics);
    }
    if (changes[SEE_MORE_TOPICS_KEY]) setTopics((changes[SEE_MORE_TOPICS_KEY].newValue as string[] | undefined) ?? []);
  });
}

function setTopics(next: string[]): void {
  topics = next.slice(0, MAX_SEE_MORE_TOPICS);
  for (const t of [...pools.keys()]) if (!topics.includes(t)) pools.delete(t);
  for (const t of [...introTopics]) if (!topics.includes(t)) introTopics.delete(t);
  for (const [key, post] of postBySlot) if (!topics.includes(post.topic)) postBySlot.delete(key);
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
        pool.unchecked.push(...shuffled(res.posts.filter(p => allowed(p) && !alreadyShown(p))));
        continue;
      }
      // A few at a time, in parallel; each post joins the pool as soon as it
      // passes, so a new topic's first post isn't held up by slower checks.
      const batch = pool.unchecked.splice(0, HIDE_CHECK_CONCURRENCY).filter(p => !alreadyShown(p) && allowed(p));
      await Promise.all(batch.map(async post => {
        if (await passesHideFilters(post) && pools.get(topic) === pool) {
          pool.ready.push(post);
          if (introTopics.has(topic)) endIntro(topic, introducePost(topic) ? null : 'no free gap in reach on screen');
        }
      }));
    }
  } catch (err) {
    console.warn('[Bouncer] See more: refill failed for', topic, err);
  } finally {
    pool.busy = false;
    // Nothing found (no results, or the search failed): stop the pulse. Only
    // for the topic's current pool: a removed topic's search can still be
    // running when the user adds it back, and must not end the new intro.
    if (pools.get(topic) === pool && introTopics.has(topic) && !pool.ready.length) endIntro(topic, 'search found no posts');
  }
}

/** `failure` says why the new topic's first post wasn't slid in (null: it was). */
function endIntro(topic: string, failure: string | null): void {
  introTopics.delete(topic);
  if (failure) console.log(`[Bouncer] See more: didn't slide in a post for new topic "${topic}": ${failure}`);
  topicRows.forEach(row => { if (row.isConnected) renderTopicChips(row); });
}

// Runs the candidate through the same pipeline as a real tweet, so the
// user's hide filters (and AI-content detection) apply to injected posts too.
// Anything other than a definite "hide" verdict lets the post through.
async function passesHideFilters(post: BskyFeedPost): Promise<boolean> {
  // Quoted text is folded in the way the X adapter does for quote tweets,
  // and a reply's parent (shown above it) the same way.
  const quoted = post.quote && post.quote !== 'unavailable' && post.quote.text ? ` [Quoted: ${post.quote.text}]` : '';
  const parent = post.parent?.text ? ` [Replying to: ${post.parent.text}]` : '';
  const content = {
    text: post.text + quoted + parent, author: post.authorName, handle: `@${post.authorHandle}`, avatarUrl: null,
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
            if (target.isConnected) {
              markImpressed(target.dataset.uri ?? '');
              markImpressed(target.dataset.parentUri ?? '');
            }
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
    while (post && (alreadyShown(post) || !allowed(post))) post = pool.ready.shift();
    void refill(topic);
    if (!post) continue;
    nextTopic = (nextTopic + i + 1) % topics.length;
    for (const uri of shownUris(post)) seenUris.add(uri);
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

  cell.querySelectorAll<HTMLElement>(`:scope > .${INJECTED_CLASS}`).forEach(e => {
    if (e.dataset.hostKey !== hostKey) e.remove();
  });
  let assigned = false;
  for (const slot of ['above', 'below'] as const) {
    const post = postBySlot.get(slotKey(hostKey, slot));
    if (!post) continue;
    assigned = true;
    if (!injectedIn(cell, slot)) placePost(cell, renderPost(post, hostKey, slot), slot);
  }
  if (assigned) return;

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
  postBySlot.set(slotKey(hostKey, 'below'), post);
  placePost(cell, renderPost(post, hostKey, 'below'), 'below');
}

function injectedIn(cell: Element, slot: Slot): boolean {
  return !!cell.querySelector(`:scope > .${INJECTED_CLASS}[data-slot="${slot}"]`);
}

function placePost(cell: Element, root: HTMLElement, slot: Slot): void {
  if (slot === 'above') cell.prepend(root);
  else cell.appendChild(root);
}

// Where a newly added topic's first post goes: the topmost gap between tweets
// (under a tweet, or above one) that is on screen with room left below it.
// When there's none — a tall post introduced moments earlier can fill the
// screen — the nearest gap further down is used and the page scrolls so the
// new post lands mid-screen.
const INTRO_MIN_Y_PX = 80;           // below X's sticky header
const INTRO_MIN_ROOM_PX = 240;       // visible space wanted below the gap
const INTRO_MAX_SCROLL_RATIO = 1.5;  // farthest fallback gap, in viewports
const INTRO_ANIMATION_MS = 450;

interface IntroSlot { cell: HTMLElement; hostKey: string; slot: Slot; y: number }

/** Free gaps between timeline tweets, top to bottom: above and below each
 *  tweet, where it doesn't have a See more post yet. */
function introSlots(): IntroSlot[] {
  const threaded = (adapter as unknown as { _isReplyInThread?: (el: Element) => boolean })._isReplyInThread;
  // Never wedge a foreign post between the tweets of a self-thread.
  const inThread = (cell: Element | null) => !!cell && !!threaded?.call(adapter, cell);
  const slots: IntroSlot[] = [];
  for (const article of document.querySelectorAll<HTMLElement>(adapter.selectors.post)) {
    const cell = adapter.getPostContainer(article);
    if (cell === article || cell.dataset.filteredByExtension) continue;
    const hostKey = adapter.getPostContentKey(article);
    if (!hostKey) continue;
    const free = (slot: Slot) => !postBySlot.has(slotKey(hostKey, slot)) && !injectedIn(cell, slot);
    const rect = cell.getBoundingClientRect();
    if (free('above') && !inThread(cell)) slots.push({ cell, hostKey, slot: 'above', y: rect.top });
    if (free('below') && !inThread(cell.nextElementSibling)) slots.push({ cell, hostKey, slot: 'below', y: rect.bottom });
  }
  return slots;
}

/** Put `topic`'s first ready post in view right away, in a gap between
 *  tweets, with a slide-in. Returns false when there's no gap within reach
 *  (not on the home timeline, say); the post then stays in the pool for the
 *  normal rotation. */
function introducePost(topic: string): boolean {
  if (!adapter || !onHomeTimeline()) return false;
  const pool = pools.get(topic);
  if (!pool) return false;
  const slots = introSlots().filter(s => s.y >= INTRO_MIN_Y_PX);
  const maxY = window.innerHeight - INTRO_MIN_ROOM_PX;
  const slot = slots.find(s => s.y <= maxY)
    ?? slots.find(s => s.y <= window.innerHeight * INTRO_MAX_SCROLL_RATIO);
  if (!slot) return false;

  let post = pool.ready.shift();
  while (post && (alreadyShown(post) || !allowed(post))) post = pool.ready.shift();
  void refill(topic);
  if (!post) return false;
  for (const uri of shownUris(post)) seenUris.add(uri);
  postBySlot.set(slotKey(slot.hostKey, slot.slot), post);
  tweetsSinceInject = 0;
  const root = renderPost(post, slot.hostKey, slot.slot);
  placePost(slot.cell, root, slot.slot);
  slideIn(root);
  if (slot.y > maxY) {
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    window.scrollBy({ top: slot.y - window.innerHeight / 2, behavior: reduceMotion ? 'auto' : 'smooth' });
  }
  return true;
}

/** Open a gap next to the host tweet and slide the post into it. */
function slideIn(root: HTMLElement): void {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const style = getComputedStyle(root);
  const full = { height: `${root.offsetHeight}px`, paddingTop: style.paddingTop, paddingBottom: style.paddingBottom };
  const easing = 'cubic-bezier(0.2, 0, 0, 1)';
  root.style.overflow = 'hidden';
  root.style.boxSizing = 'border-box';
  const grow = root.animate(
    [{ height: '0px', paddingTop: '0px', paddingBottom: '0px' }, full],
    { duration: INTRO_ANIMATION_MS, easing },
  );
  root.animate(
    [{ transform: 'translateX(-24px)', opacity: 0 }, { transform: 'translateX(0)', opacity: 1 }],
    { duration: INTRO_ANIMATION_MS, delay: INTRO_ANIMATION_MS / 3, easing, fill: 'backwards' },
  );
  root.animate(
    [{ backgroundColor: 'rgba(29, 155, 240, 0.12)' }, { backgroundColor: 'rgba(29, 155, 240, 0)' }],
    { duration: 1600, delay: INTRO_ANIMATION_MS, easing: 'ease-out' },
  );
  const done = () => { root.style.overflow = ''; root.style.boxSizing = ''; };
  grow.finished.then(done, done);
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
      const key = slotKey(hostKey, el.dataset.slot === 'above' ? 'above' : 'below');
      const post = postBySlot.get(key);
      postBySlot.delete(key);
      el.remove();
      if (post) {
        for (const uri of shownUris(post)) seenUris.delete(uri);
        pools.get(post.topic)?.ready.unshift(post);
        tweetsSinceInject = injectEvery;
      }
    }
  });
}

// ==================== Rendering ====================

const SVG_NS = 'http://www.w3.org/2000/svg';
const BLUESKY_LOGO_PATH = 'm135.72 44.03c66.496 49.921 138.02 151.14 164.28 205.46 26.262-54.316 97.782-155.54 164.28-205.46 47.98-36.021 125.72-63.892 125.72 24.795 0 17.712-10.155 148.79-16.111 170.07-20.703 73.984-96.144 92.854-163.25 81.433 117.3 19.964 147.14 86.092 82.697 152.22-122.39 125.59-175.91-31.511-189.63-71.766-2.514-7.3797-3.6904-10.832-3.7077-7.8964-0.0174-2.9357-1.1937 0.51669-3.7077 7.8964-13.714 40.255-67.233 197.36-189.63 71.766-64.444-66.128-34.605-132.26 82.697-152.22-67.108 11.421-142.55-7.4491-163.25-81.433-5.9562-21.282-16.111-152.36-16.111-170.07 0-88.687 77.742-60.816 125.72-24.795z';
// X's own action icons (filled glyphs, copied from x.com), so the actions
// row matches the real tweets around it. X has no "open" action; that one
// stays a stroked outline icon.
const ICONS = {
  reply: 'M1.751 10c0-4.42 3.584-8 8.005-8h4.366c4.49 0 8.129 3.64 8.129 8.13 0 2.96-1.607 5.68-4.196 7.11l-8.054 4.46v-3.69h-.067c-4.49.1-8.183-3.51-8.183-8.01zm8.005-6c-3.317 0-6.005 2.69-6.005 6 0 3.37 2.77 6.08 6.138 6.01l.351-.01h1.761v2.3l5.087-2.81c1.951-1.08 3.163-3.13 3.163-5.36 0-3.39-2.744-6.13-6.129-6.13H9.756z',
  repost: 'M4.5 3.88l4.432 4.14-1.364 1.46L5.5 7.55V16c0 1.1.896 2 2 2H13v2H7.5c-2.209 0-4-1.79-4-4V7.55L1.432 9.48.068 8.02 4.5 3.88zM16.5 6H11V4h5.5c2.209 0 4 1.79 4 4v8.45l2.068-1.93 1.364 1.46-4.432 4.14-4.432-4.14 1.364-1.46 2.068 1.93V8c0-1.1-.896-2-2-2z',
  like: 'M16.697 5.5c-1.222-.06-2.679.51-3.89 2.16l-.805 1.09-.806-1.09C9.984 6.01 8.526 5.44 7.304 5.5c-1.243.07-2.349.78-2.91 1.91-.552 1.12-.633 2.78.479 4.82 1.074 1.97 3.257 4.27 7.129 6.61 3.87-2.34 6.052-4.64 7.126-6.61 1.111-2.04 1.03-3.7.477-4.82-.561-1.13-1.666-1.84-2.908-1.91zm4.187 7.69c-1.351 2.48-4.001 5.12-8.379 7.67l-.503.3-.504-.3c-4.379-2.55-7.029-5.19-8.382-7.67-1.36-2.5-1.41-4.86-.514-6.67.887-1.79 2.647-2.91 4.601-3.01 1.651-.09 3.368.56 4.798 2.01 1.429-1.45 3.146-2.1 4.796-2.01 1.954.1 3.714 1.22 4.601 3.01.896 1.81.846 4.17-.514 6.67z',
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
 *  card is still on screen, and no dialog opened for routes X shows as a
 *  modal over the timeline, like /photo/N), that's logged and the page
 *  loads it in full. */
function openInX(url: string, from: HTMLElement, opensModal = false): void {
  const target = new URL(url);
  history.pushState(null, '', target.pathname + target.search);
  window.dispatchEvent(new PopStateEvent('popstate', { state: null }));
  setTimeout(() => {
    const modalOpen = opensModal && document.querySelector('[aria-modal="true"]');
    if (from.isConnected && !modalOpen && location.pathname === target.pathname) {
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
  return filledIcon(X_LOGO_PATH, className);
}

function filledIcon(d: string, className = ''): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  if (className) svg.setAttribute('class', className);
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', d);
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
// Until the image loads it carries IMG_PENDING_CLASS, which keeps it
// invisible (no broken-image icon during the retry wait) and lets its
// container show a skeleton instead.
const IMAGE_RETRY_DELAY_MS = 1500;
const IMG_PENDING_CLASS = 'bsky-x-img-pending';

function loadWithRetry(image: HTMLImageElement, url: string, onGiveUp: () => void): void {
  let retried = false;
  image.classList.add(IMG_PENDING_CLASS);
  image.addEventListener('load', () => image.classList.remove(IMG_PENDING_CLASS));
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

// ==================== Image preview (Bluesky posts) ====================

/** Full-screen image viewer for a Bluesky post's photos, modeled on X's: dark
 *  backdrop, close button top-left, arrows (and arrow keys) between photos,
 *  Escape or a click outside the image closes it. Opens on the thumbnail the
 *  timeline already loaded and swaps in the full-size image once it's in. */
function openLightbox(images: BskyFeedPost['images'], start: number, from: HTMLElement): void {
  let index = start;
  const overlay = el('div', 'bsky-x-lightbox');
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'Image preview');
  const image = el('img', 'bsky-x-lightbox-img');
  image.referrerPolicy = 'no-referrer';
  const button = (cls: string, label: string, d: string) => {
    const b = el('button', `bsky-x-lightbox-btn ${cls}`);
    b.type = 'button';
    b.setAttribute('aria-label', label);
    b.appendChild(strokeIcon(d));
    return b;
  };
  const close = button('bsky-x-lightbox-close', 'Close', LIGHTBOX_ICONS.close);
  const prev = button('bsky-x-lightbox-prev', 'Previous image', LIGHTBOX_ICONS.prev);
  const next = button('bsky-x-lightbox-next', 'Next image', LIGHTBOX_ICONS.next);
  overlay.append(image, close);
  if (images.length > 1) overlay.append(prev, next);

  const show = (i: number) => {
    index = i;
    const img = images[i];
    image.alt = img.alt;
    image.src = img.url;
    if (img.fullUrl !== img.url) {
      const full = new Image();
      full.referrerPolicy = 'no-referrer';
      full.onload = () => { if (index === i) image.src = img.fullUrl; };
      full.src = img.fullUrl;
    }
    prev.hidden = i === 0;
    next.hidden = i === images.length - 1;
  };
  const step = (delta: number) => {
    const i = index + delta;
    if (i >= 0 && i < images.length) show(i);
  };

  const prevOverflow = document.documentElement.style.overflow;
  const dismiss = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKey, true);
    document.documentElement.style.overflow = prevOverflow;
    if (from.isConnected) from.focus({ preventScroll: true });
  };
  // Capture phase, so X's own keyboard shortcuts (j/k, l, …) don't act on
  // the timeline behind the preview.
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') dismiss();
    else if (e.key === 'ArrowLeft') step(-1);
    else if (e.key === 'ArrowRight') step(1);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  overlay.addEventListener('click', (e) => {
    e.stopPropagation();
    if (e.target === overlay) dismiss();
  });
  close.addEventListener('click', dismiss);
  prev.addEventListener('click', () => step(-1));
  next.addEventListener('click', () => step(1));
  document.addEventListener('keydown', onKey, true);

  show(start);
  document.documentElement.style.overflow = 'hidden';
  document.body.appendChild(overlay);
  close.focus();
}

const LIGHTBOX_ICONS = {
  close: 'M6 6l12 12M18 6L6 18',
  prev: 'M15 18l-6-6 6-6',
  next: 'M9 18l6-6-6-6',
};

/** `postUrl` makes the images open a full-screen preview on click, the way a
 *  tweet's photos do: X's own photo viewer (…/status/<id>/photo/N) for X
 *  posts, Bouncer's lightbox for Bluesky ones. Without it (quoted posts,
 *  where X opens the quoted post instead) clicks fall through. Video
 *  thumbnails always fall through and open the post. */
function renderMedia(post: Pick<BskyFeedPost, 'images' | 'isVideo' | 'external'> & { source?: SeeMoreSource }, postUrl?: string): HTMLElement | null {
  if (post.images.length) {
    const grid = el('div', `bsky-x-media bsky-x-media-${Math.min(post.images.length, 4)}`);
    const previewable = postUrl && !post.isVideo;
    post.images.forEach((img, index) => {
      // The cell holds the tile's size and shows the skeleton while the image loads.
      const cell = el('div', 'bsky-x-media-cell');
      if (previewable) {
        cell.classList.add('bsky-x-media-previewable');
        cell.tabIndex = 0;
        cell.setAttribute('role', 'button');
        cell.setAttribute('aria-label', img.alt ? `Image: ${img.alt}` : 'Image');
        // Once the image has given up (the failed tile), clicks open the post.
        const open = () => {
          if (postUrl.startsWith('https://x.com/')) openInX(`${postUrl}/photo/${index + 1}`, cell, true);
          else openLightbox(post.images, index, cell);
        };
        cell.addEventListener('click', (e) => {
          if (!cell.querySelector('img')) return;
          e.stopPropagation();
          open();
        });
        cell.addEventListener('keydown', (e) => {
          if ((e.key !== 'Enter' && e.key !== ' ') || !cell.querySelector('img')) return;
          e.preventDefault();
          e.stopPropagation();
          open();
        });
      }
      // X-style single image: natural aspect, clamped between 3:4 and 2:1.
      if (post.images.length === 1) {
        cell.style.aspectRatio = String(Math.min(2, Math.max(0.75, img.aspectRatio ?? 16 / 9)));
      }
      const image = el('img', 'bsky-x-media-img');
      image.referrerPolicy = 'no-referrer';
      image.alt = img.alt;
      image.loading = 'lazy';
      // Keep the tile (same size and place) so the post never silently loses
      // its content; clicking it opens the post like the rest of the card.
      loadWithRetry(image, img.url, () => {
        image.replaceWith(el('div', 'bsky-x-media-failed', `Image couldn't load · open on ${SOURCE_NAME[post.source ?? 'bluesky']}`));
      });
      cell.appendChild(image);
      grid.appendChild(cell);
    });
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

/** A reply's parent, above the reply as X shows it in the timeline: same
 *  layout as a post, with a thread line from its avatar down to the
 *  reply's, and no action bar. Clicking it opens the parent. */
function renderParent(parent: BskyQuotedPost): HTMLElement {
  const isX = parent.url.startsWith('https://x.com/');
  const row = el('div', 'bsky-x-row bsky-x-parent');
  row.setAttribute('role', 'link');
  row.setAttribute('aria-label', `Replying to ${isX ? 'X' : 'Bluesky'} post by ${parent.authorName}`);
  const rail = el('div', 'bsky-x-rail');
  const avatar = link('bsky-x-avatar', parent.authorUrl);
  if (parent.avatarUrl) {
    const img = el('img', '');
    img.referrerPolicy = 'no-referrer';
    loadWithRetry(img, parent.avatarUrl, () => img.remove());
    img.alt = '';
    avatar.appendChild(img);
  }
  rail.append(avatar, el('div', 'bsky-x-thread-line'));
  row.appendChild(rail);

  const main = el('div', 'bsky-x-main bsky-x-parent-main');
  const header = el('div', 'bsky-x-header');
  header.appendChild(link('bsky-x-name', parent.authorUrl, parent.authorName));
  header.appendChild(link('bsky-x-handle', parent.authorUrl, `@${parent.authorHandle}`));
  header.appendChild(el('span', 'bsky-x-dot', '·'));
  const time = link('bsky-x-time', parent.url, formatRelativeTime(parent.createdAt));
  if (parent.createdAt) time.title = new Date(parent.createdAt).toLocaleString();
  header.appendChild(time);
  main.appendChild(header);
  if (parent.text) main.appendChild(el('div', 'bsky-x-text', parent.text));
  const media = renderMedia(parent, parent.url);
  if (media) main.appendChild(media);
  row.appendChild(main);

  row.addEventListener('click', (e) => {
    if ((e.target as Element).closest('a')) return;
    if (window.getSelection()?.toString()) return;
    e.stopPropagation();
    if (isX) openInX(parent.url, row);
    else window.open(parent.url, '_blank', 'noopener');
  });
  return row;
}

function renderPost(post: BskyFeedPost, hostKey: string, slot: Slot): HTMLElement {
  const root = el('div', INJECTED_CLASS);
  root.dataset.hostKey = hostKey;
  root.dataset.slot = slot;
  root.dataset.topic = post.topic;
  root.dataset.bouncerInjected = 'bluesky';
  root.dataset.source = post.source;
  root.dataset.uri = post.uri;
  if (post.parent) root.dataset.parentUri = post.parent.uri;
  if (post.nsfw) root.dataset.nsfw = '';
  observeImpression(root, post.uri);
  root.setAttribute('role', 'article');
  const sourceName = SOURCE_NAME[post.source];
  root.setAttribute('aria-label', `${sourceName} post by ${post.authorName}`);

  // Every injected post says which network it's from: logo + name here, and
  // a badge by the author's name.
  const context = el('div', `bsky-x-context bsky-x-source-${post.source}`);
  context.appendChild(sourceLogo(post.source, 'bsky-x-context-icon'));
  context.appendChild(el('span', '', `From ${sourceName} · See more ${post.topic}`));
  root.appendChild(context);
  if (post.parent) root.appendChild(renderParent(post.parent));

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
  const media = renderMedia(post, post.url);
  if (media) main.appendChild(media);
  if (post.quote) main.appendChild(renderQuote(post.quote));

  const actions = el('div', 'bsky-x-actions');
  const action = (kind: keyof typeof ICONS, count: number, label: string) => {
    const a = link(`bsky-x-action bsky-x-action-${kind}`, post.url);
    a.setAttribute('aria-label', `${label} on ${sourceName}`);
    a.appendChild(kind === 'open' ? strokeIcon(ICONS.open) : filledIcon(ICONS[kind]));
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

/** Fills the "See more …" row in an X filter box. It is built from the
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
  row.replaceChildren(el('span', 'filter-phrases-label', 'See more'), el('span', 'filter-phrases-list'), andInput);

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
    if (introTopics.has(t)) {
      chip.classList.add('bsky-see-more-loading');
      chip.setAttribute('aria-busy', 'true');
    }
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
  introTopics.add(topic);
  await setStorage({ [SEE_MORE_TOPICS_KEY]: [...current, topic] });
}

async function removeTopic(topic: string): Promise<void> {
  const current = (await getStorage([SEE_MORE_TOPICS_KEY]))[SEE_MORE_TOPICS_KEY] ?? [];
  await setStorage({ [SEE_MORE_TOPICS_KEY]: current.filter(t => t !== topic) });
}
