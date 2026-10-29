// "See more <topic>" — Bluesky posts injected into the X timeline.
//
// The background gets candidate posts from the backend's semantic index: the
// blueskySearch WebSocket route returns URIs of posts the filter model judged
// on-topic, hydrated through the public getPosts API (no Bluesky login
// needed: api.bsky.app allows anonymous getPosts with
// `Access-Control-Allow-Origin: *`). Each post is mapped to the flat shape
// below. Media stays as cdn.bsky.app URLs: that CDN sends no CORS
// headers, so the extension can't fetch it, but <img> elements created by a
// content script are exempt from x.com's CSP img-src in Chrome (verified;
// the same load from the page's own world is blocked).

export const BSKY_GET_POSTS_ENDPOINT = 'https://api.bsky.app/xrpc/app.bsky.feed.getPosts';
/** getPosts accepts at most this many URIs per request. */
export const BSKY_GET_POSTS_MAX = 25;
export const SEE_MORE_TOPICS_KEY = 'seeMoreTopics_twitter';
export const MAX_SEE_MORE_TOPICS = 10;
export const MAX_SEE_MORE_TOPIC_LENGTH = 60;
/** One Bluesky post per this many timeline tweets. Set from the desktop
 *  popup's slider, from 1 in 10 up to 1 in 2. */
export const SEE_MORE_EVERY_KEY = 'seeMoreEvery_twitter';
export const DEFAULT_SEE_MORE_EVERY = 5;
export const MIN_SEE_MORE_EVERY = 2;
export const MAX_SEE_MORE_EVERY = 10;

/** Where "See more" draws posts from (the desktop popup's "Draw from"
 *  setting): Bluesky, X, or both. X posts come from the backend's xstream,
 *  a feed of X posts Bouncer users see; their URIs are at://x:<handle>/... */
export type SeeMoreSource = 'bluesky' | 'x';
export type SeeMoreSourceSetting = SeeMoreSource | 'both';
export const SEE_MORE_SOURCE_KEY = 'seeMoreSource_twitter';
export const DEFAULT_SEE_MORE_SOURCE: SeeMoreSourceSetting = 'bluesky';

/** The stored setting; unset means the default (Bluesky). Anything else
 *  unrecognized also falls back to the default, but says so. */
export function clampSeeMoreSource(v: unknown): SeeMoreSourceSetting {
  if (v === 'bluesky' || v === 'x' || v === 'both') return v;
  if (v !== undefined) console.warn('[See more] unrecognized source setting, using default:', v, '→', DEFAULT_SEE_MORE_SOURCE);
  return DEFAULT_SEE_MORE_SOURCE;
}

/** The blueskySearch request's `sources` for a setting. */
export function seeMoreSources(setting: SeeMoreSourceSetting): SeeMoreSource[] {
  return setting === 'both' ? ['bluesky', 'x'] : [setting];
}

export function sourceOfUri(uri: string): SeeMoreSource {
  return uri.startsWith('at://x:') ? 'x' : 'bluesky';
}

/** URIs of Bluesky posts the user has actually seen in their X timeline
 *  (on screen, not just fetched), oldest first, so a reload doesn't show
 *  them again. Capped: the backend only indexes a few days of posts, and
 *  this is far more than anyone scrolls past in that time. */
export const SEE_MORE_SEEN_KEY = 'seeMoreSeen_twitter';
export const MAX_SEE_MORE_SEEN = 3000;

/** Append newly seen URIs to the stored list: no duplicates, oldest dropped
 *  beyond `cap`. */
export function mergeSeenUris(stored: string[], added: Iterable<string>, cap = MAX_SEE_MORE_SEEN): string[] {
  const merged = new Set(stored);
  for (const uri of added) {
    merged.delete(uri); // re-seen moves to the newest end
    merged.add(uri);
  }
  const all = [...merged];
  return all.length > cap ? all.slice(all.length - cap) : all;
}

/** Whether "See more" may show adult or graphic posts (the desktop popup's
 *  toggle). Off unless the user turns it on. */
export const SEE_MORE_SHOW_NSFW_KEY = 'seeMoreShowNsfw_twitter';

/** Moderation labels that make a post NSFW: Bluesky's adult-content and
 *  graphic-media values (self-applied by the author, or applied by
 *  Bluesky's moderation service; getPosts returns both), plus the label
 *  xstream sets on X posts X marks possibly_sensitive. */
export const X_SENSITIVE_LABEL = 'x-possibly-sensitive';
const NSFW_LABELS = new Set(['porn', 'sexual', 'nudity', 'graphic-media', 'gore', 'nsfl', X_SENSITIVE_LABEL]);
/** Labels that mean a post should never be shown here: moderation hides and
 *  takedowns, and authors who asked not to be shown to logged-out viewers
 *  (anyone reading it in X is not logged in to Bluesky). */
const NEVER_SHOW_LABELS = new Set(['!hide', '!takedown', '!no-unauthenticated']);

/** Label values in effect: a negation (`neg`) cancels an earlier label with
 *  the same value from the same labeler. */
function activeLabels(labels: RawLabel[] | undefined): Set<string> {
  const active = new Map<string, string>();
  for (const l of labels ?? []) {
    const key = `${l.src}|${l.val}`;
    if (l.neg) active.delete(key);
    else active.set(key, l.val);
  }
  return new Set(active.values());
}

const hasAny = (labels: RawLabel[] | undefined, wanted: Set<string>) =>
  [...activeLabels(labels)].some(v => wanted.has(v));

/** NSFW per the post's labels, its author's account labels, or those of
 *  the post it quotes or replies to. */
export function isNsfwRawPost(p: RawPostView): boolean {
  const q = rawQuote(p);
  const related = [q && q !== 'unavailable' ? q : null, rawReplyParent(p)];
  return hasAny(p.labels, NSFW_LABELS) || hasAny(p.author.labels, NSFW_LABELS)
    || related.some(r => hasAny(r?.labels, NSFW_LABELS) || hasAny(r?.author?.labels, NSFW_LABELS));
}

export function clampSeeMoreEvery(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return DEFAULT_SEE_MORE_EVERY;
  return Math.min(MAX_SEE_MORE_EVERY, Math.max(MIN_SEE_MORE_EVERY, Math.round(v)));
}

/** A link span over `text`, in UTF-16 offsets (converted from the AT
 *  Protocol's UTF-8 byte offsets in the background). */
export interface BskyLink {
  start: number;
  end: number;
  href: string;
}

export interface BskyFeedPost {
  uri: string;
  /** Which network the post is from; X posts render with X branding and
   *  link to x.com. */
  source: SeeMoreSource;
  /** https://bsky.app/profile/<handle>/post/<rkey>, or the x.com status URL */
  url: string;
  authorName: string;
  authorHandle: string;
  authorUrl: string;
  avatarUrl: string | null;
  text: string;
  links: BskyLink[];
  createdAt: string;
  replyCount: number;
  repostCount: number;
  likeCount: number;
  /** aspectRatio is width / height when Bluesky reports it, so the layout
   *  can reserve space before the image loads. url is the feed thumbnail;
   *  fullUrl the full-size image for the preview (the thumbnail when there
   *  is none). */
  images: Array<{ url: string; fullUrl: string; alt: string; aspectRatio: number | null }>;
  isVideo: boolean;
  external: { uri: string; title: string; domain: string; thumbUrl: string | null } | null;
  /** The quoted post, for a quote post. 'unavailable' when it was deleted,
   *  blocked, or detached by its author (shown as a placeholder, like X
   *  does). */
  quote: BskyQuotedPost | 'unavailable' | null;
  /** For a reply, the post it replies to, shown above it the way X shows
   *  a reply in the timeline. Replies only come with their parent. */
  parent: BskyQuotedPost | null;
  /** The "See more …" topic this post was found for. */
  topic: string;
  /** Adult or graphic (isNsfwRawPost). Shown only with
   *  SEE_MORE_SHOW_NSFW_KEY on. */
  nsfw: boolean;
}

/** The post inside a quote post: enough to render X's compact quote card. */
export type BskyQuotedPost = Pick<BskyFeedPost,
  'uri' | 'url' | 'authorName' | 'authorHandle' | 'authorUrl' | 'avatarUrl' | 'text' | 'createdAt' | 'images' | 'isVideo' | 'external'>;

export interface BskySearchResult {
  posts: BskyFeedPost[];
  cursor: string | null;
}

// ---- Raw AT Protocol shapes (only the fields we read) ----

interface RawAspectRatio { width: number; height: number }
interface RawImageView { thumb: string; fullsize?: string; alt?: string; aspectRatio?: RawAspectRatio }
/** com.atproto.label.defs#label (only the fields we read). */
export interface RawLabel { src: string; val: string; neg?: boolean }
interface RawAuthor { did: string; handle: string; displayName?: string; avatar?: string; labels?: RawLabel[] }
/** app.bsky.embed.record#viewRecord, or one of its unavailable variants
 *  (#viewNotFound, #viewBlocked, #viewDetached), or a quoted feed/list. */
export interface RawQuotedRecord {
  $type: string;
  uri?: string;
  author?: RawAuthor;
  value?: { text?: string; createdAt?: string };
  labels?: RawLabel[];
  /** The quoted post's own embeds, already as views. */
  embeds?: RawEmbedView[];
}
export interface RawEmbedView {
  $type: string;
  images?: RawImageView[];
  thumbnail?: string;
  aspectRatio?: RawAspectRatio;
  external?: { uri: string; title?: string; thumb?: string };
  media?: RawEmbedView;
  /** record#view: the quoted record. recordWithMedia#view: { record }. */
  record?: RawQuotedRecord & { record?: RawQuotedRecord };
}
interface RawFacet {
  index: { byteStart: number; byteEnd: number };
  features: Array<{ $type: string; uri?: string; did?: string; tag?: string }>;
}
export interface RawPostView {
  uri: string;
  author: RawAuthor;
  record: { text?: string; createdAt?: string; reply?: unknown; facets?: RawFacet[]; langs?: string[] };
  embed?: RawEmbedView;
  labels?: RawLabel[];
  /** X replies only: the parent, which xstream adds as a viewRecord. Bluesky
   *  views never have it (getPosts doesn't return parents). */
  reply?: { parent?: RawQuotedRecord };
  replyCount?: number;
  repostCount?: number;
  likeCount?: number;
}

/** Whether a raw search hit is fit to show: top-level or a reply that came
 *  with its parent, has content, not hidden by moderation or its author.
 *  NSFW is decided separately (isNsfwRawPost), since the user can opt in
 *  to it. */
export function isInjectableRawPost(p: RawPostView): boolean {
  if (p.record.reply && !rawReplyParent(p)) return false;
  if (hasAny(p.labels, NEVER_SHOW_LABELS) || hasAny(p.author.labels, NEVER_SHOW_LABELS)) return false;
  const text = (p.record.text ?? '').trim();
  return text.length >= 15 || !!p.embed;
}

/** at://did/app.bsky.feed.post/<rkey> → bsky.app permalink. */
export function bskyPostUrl(uri: string, handle: string): string {
  const rkey = uri.split('/').pop() ?? '';
  return `https://bsky.app/profile/${handle}/post/${rkey}`;
}

/** Convert facets (UTF-8 byte ranges) into UTF-16 link spans over `text`. */
export function facetsToLinks(text: string, facets: RawFacet[] | undefined): BskyLink[] {
  if (!facets?.length) return [];
  const bytes = new TextEncoder().encode(text);
  const dec = new TextDecoder();
  const toUtf16 = (byteOffset: number) => dec.decode(bytes.slice(0, byteOffset)).length;
  const links: BskyLink[] = [];
  for (const f of facets) {
    const feat = f.features[0];
    if (!feat) continue;
    let href: string | null = null;
    if (feat.$type === 'app.bsky.richtext.facet#link' && feat.uri) href = feat.uri;
    else if (feat.$type === 'app.bsky.richtext.facet#mention' && feat.did) href = `https://bsky.app/profile/${feat.did}`;
    else if (feat.$type === 'app.bsky.richtext.facet#tag' && feat.tag) href = `https://bsky.app/hashtag/${encodeURIComponent(feat.tag)}`;
    if (!href || !/^https:\/\//.test(href)) continue;
    const { byteStart, byteEnd } = f.index;
    if (byteStart < 0 || byteEnd > bytes.length || byteStart >= byteEnd) continue;
    links.push({ start: toUtf16(byteStart), end: toUtf16(byteEnd), href });
  }
  links.sort((a, b) => a.start - b.start);
  // Drop overlaps so rendering can walk the spans linearly.
  return links.filter((l, i) => i === 0 || l.start >= links[i - 1].end);
}

export interface RawMedia { images: RawImageView[]; isVideo: boolean; external: RawEmbedView['external'] | null }

/** A post's own media (photos, video poster, or link card). A quoted post's
 *  media is not included; see rawQuote. */
export function rawMedia(p: RawPostView): RawMedia {
  return embedMedia(p.embed);
}

/** The post a quote post quotes: the record view, 'unavailable' when it
 *  can't or shouldn't be shown, or null for a post that quotes nothing (or
 *  quotes a feed, list or other non-post record). */
export function rawQuote(p: RawPostView): RawQuotedRecord | 'unavailable' | null {
  const embed = p.embed;
  let record: RawQuotedRecord | undefined;
  if (embed?.$type === 'app.bsky.embed.record#view') record = embed.record;
  else if (embed?.$type === 'app.bsky.embed.recordWithMedia#view') record = embed.record?.record;
  if (!record) return null;
  if (record.$type === 'app.bsky.embed.record#viewRecord') {
    if (!record.uri || !record.author) return 'unavailable';
    return record;
  }
  if (/#view(NotFound|Blocked|Detached)$/.test(record.$type)) return 'unavailable';
  return null;
}

/** The post a reply replies to, when the view includes it (X replies). */
export function rawReplyParent(p: RawPostView): RawQuotedRecord | null {
  const parent = p.reply?.parent;
  return parent?.$type === 'app.bsky.embed.record#viewRecord' && parent.uri && parent.author ? parent : null;
}

/** Media of an embed view: the post's own, or a quoted post's embeds[0]. */
export function embedMedia(view: RawEmbedView | undefined): RawMedia {
  let embed = view;
  if (embed?.$type === 'app.bsky.embed.recordWithMedia#view') embed = embed.media;
  if (!embed) return { images: [], isVideo: false, external: null };
  if (embed.$type === 'app.bsky.embed.images#view') return { images: (embed.images ?? []).slice(0, 4), isVideo: false, external: null };
  if (embed.$type === 'app.bsky.embed.video#view' && embed.thumbnail) return { images: [{ thumb: embed.thumbnail, aspectRatio: embed.aspectRatio }], isVideo: true, external: null };
  if (embed.$type === 'app.bsky.embed.external#view' && embed.external) return { images: [], isVideo: false, external: embed.external };
  return { images: [], isVideo: false, external: null };
}

/** X-style relative timestamp: "45s", "12m", "3h", "Oct 4". */
export function formatRelativeTime(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** X-style compact count: 999, 1.2K, 34K, 1.5M. Zero renders empty. */
export function formatCount(n: number): string {
  if (!n) return '';
  if (n < 1000) return String(n);
  if (n < 10000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}K`;
  if (n < 1e6) return `${Math.floor(n / 1000)}K`;
  return `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M`;
}

export function normalizeTopic(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().slice(0, MAX_SEE_MORE_TOPIC_LENGTH);
}
