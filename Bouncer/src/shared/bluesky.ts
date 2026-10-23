// "See more of <topic>" — Bluesky posts injected into the X timeline.
//
// The background fetches public Bluesky search results (no login needed:
// api.bsky.app allows anonymous searchPosts with `Access-Control-Allow-Origin: *`;
// the cached public.api.bsky.app host 403s search) and maps each post to the
// flat shape below. Media stays as cdn.bsky.app URLs: that CDN sends no CORS
// headers, so the extension can't fetch it, but <img> elements created by a
// content script are exempt from x.com's CSP img-src in Chrome (verified;
// the same load from the page's own world is blocked).

export const BSKY_SEARCH_ENDPOINT = 'https://api.bsky.app/xrpc/app.bsky.feed.searchPosts';
export const SEE_MORE_TOPICS_KEY = 'seeMoreTopics_twitter';
export const MAX_SEE_MORE_TOPICS = 3;
export const MAX_SEE_MORE_TOPIC_LENGTH = 60;

/** A link span over `text`, in UTF-16 offsets (converted from the AT
 *  Protocol's UTF-8 byte offsets in the background). */
export interface BskyLink {
  start: number;
  end: number;
  href: string;
}

export interface BskyFeedPost {
  uri: string;
  /** https://bsky.app/profile/<handle>/post/<rkey> */
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
   *  can reserve space before the image loads. */
  images: Array<{ url: string; alt: string; aspectRatio: number | null }>;
  isVideo: boolean;
  external: { uri: string; title: string; domain: string; thumbUrl: string | null } | null;
  /** The "See more of …" topic this post was found for. */
  topic: string;
}

export interface BskySearchResult {
  posts: BskyFeedPost[];
  cursor: string | null;
}

// Self-labels and moderation labels that should never be injected into
// someone's X feed uninvited.
const BLOCKED_LABELS = new Set(['porn', 'sexual', 'nudity', 'graphic-media', 'gore', '!hide', '!warn', 'spam']);

// ---- Raw AT Protocol shapes (only the fields we read) ----

interface RawLabel { val: string }
interface RawAspectRatio { width: number; height: number }
interface RawImageView { thumb: string; alt?: string; aspectRatio?: RawAspectRatio }
interface RawEmbedView {
  $type: string;
  images?: RawImageView[];
  thumbnail?: string;
  aspectRatio?: RawAspectRatio;
  external?: { uri: string; title?: string; thumb?: string };
  media?: RawEmbedView;
}
interface RawFacet {
  index: { byteStart: number; byteEnd: number };
  features: Array<{ $type: string; uri?: string; did?: string; tag?: string }>;
}
export interface RawPostView {
  uri: string;
  author: { did: string; handle: string; displayName?: string; avatar?: string; labels?: RawLabel[] };
  record: { text?: string; createdAt?: string; reply?: unknown; facets?: RawFacet[]; langs?: string[] };
  embed?: RawEmbedView;
  replyCount?: number;
  repostCount?: number;
  likeCount?: number;
  labels?: RawLabel[];
}

/** Whether a raw search hit is fit to show: top-level, unlabeled, has content. */
export function isInjectableRawPost(p: RawPostView): boolean {
  if (p.record.reply) return false;
  const labels = [...(p.labels ?? []), ...(p.author.labels ?? [])];
  if (labels.some(l => BLOCKED_LABELS.has(l.val))) return false;
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

/** Media URLs (still remote) a post wants converted to data: URLs. */
export function rawMedia(p: RawPostView): { images: RawImageView[]; isVideo: boolean; external: RawEmbedView['external'] | null } {
  let embed = p.embed;
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
