// Background half of "See more <topic>": candidate Bluesky posts from the
// backend's semantic index, mapped to BskyFeedPost (see shared/bluesky.ts).

import {
  BSKY_GET_POSTS_ENDPOINT, BSKY_GET_POSTS_MAX, bskyPostUrl, embedMedia, facetsToLinks, isInjectableRawPost, isNsfwRawPost, rawMedia,
  rawQuote, rawReplyParent, sourceOfUri, type BskyFeedPost, type BskyQuotedPost, type BskySearchResult, type RawMedia,
  type RawPostView, type RawQuotedRecord, type SeeMoreSource,
} from '../shared/bluesky';
import { callImbueBlueskySearch } from './providers';

// Avatars come as /img/avatar/plain/…; the thumbnail variant is ~10x smaller.
function avatarThumb(url: string | undefined): string | undefined {
  return url?.replace('/img/avatar/plain/', '/img/avatar_thumbnail/plain/');
}

const httpsOrNull = (url: string | undefined) => (url?.startsWith('https://') ? url : null);

function mapMedia(media: RawMedia): Pick<BskyFeedPost, 'images' | 'isVideo' | 'external'> {
  let domain = '';
  try { domain = media.external ? new URL(media.external.uri).hostname.replace(/^www\./, '') : ''; } catch { /* bad URI */ }
  return {
    images: media.images.flatMap(img => {
      const url = httpsOrNull(img.thumb);
      const ar = img.aspectRatio;
      const aspectRatio = ar && ar.width > 0 && ar.height > 0 ? ar.width / ar.height : null;
      return url ? [{ url, fullUrl: httpsOrNull(img.fullsize) ?? url, alt: img.alt ?? '', aspectRatio }] : [];
    }),
    isVideo: media.isVideo,
    external: media.external && /^https:\/\//.test(media.external.uri)
      ? { uri: media.external.uri, title: media.external.title ?? '', domain, thumbUrl: httpsOrNull(media.external.thumb) }
      : null,
  };
}

function mapQuote(p: RawPostView): BskyFeedPost['quote'] {
  const q = rawQuote(p);
  if (q === null || q === 'unavailable') return q;
  return mapRecord(q);
}

function mapParent(p: RawPostView): BskyFeedPost['parent'] {
  const r = rawReplyParent(p);
  return r ? mapRecord(r) : null;
}

/** A quoted post or a reply's parent (both viewRecords with uri and author
 *  set, per rawQuote and rawReplyParent). */
function mapRecord(q: RawQuotedRecord): BskyQuotedPost {
  const author = q.author!;
  // An X post (xstream builds the same viewRecord shape) links to x.com.
  const isX = sourceOfUri(q.uri!) === 'x';
  const quoted: BskyQuotedPost = {
    uri: q.uri!,
    url: isX ? `https://x.com/${author.handle}/status/${q.uri!.split('/').pop()}` : bskyPostUrl(q.uri!, author.handle),
    authorName: author.displayName?.trim() || author.handle,
    authorHandle: author.handle,
    authorUrl: isX ? `https://x.com/${author.handle}` : `https://bsky.app/profile/${author.handle}`,
    avatarUrl: httpsOrNull(avatarThumb(author.avatar)),
    text: q.value?.text ?? '',
    createdAt: q.value?.createdAt ?? '',
    ...mapMedia(embedMedia(q.embeds?.[0])),
  };
  return quoted;
}

/** X posts (from the backend's xstream) carry their x.com status URL; their
 *  text is what Bouncer captured, "<display name>: <tweet>", so the name
 *  prefix is dropped (the header shows it). xstream fills in avatar, like and
 *  reply counts and the post time from X's embed endpoint (`enrichment:
 *  'ok'`); X gives no repost count there, so none is shown. */
function mapXPost(p: RawPostView & { url?: string; enrichment?: string }, topic: string): BskyFeedPost | null {
  // No permalink means the post can't be opened; drop it loudly rather than
  // pointing it somewhere else.
  if (!p.url?.startsWith('https://x.com/')) {
    console.warn('[BlueskySearch] dropping X post without an x.com url:', p.uri, p.url);
    return null;
  }
  // Only xstream's lookup on X says whether a post is a reply (and gives
  // its parent) or sensitive; without it, neither is known.
  if (p.enrichment !== 'ok') {
    console.warn(`[BlueskySearch] dropping X post xstream couldn't look up on X (enrichment: ${p.enrichment}):`, p.uri);
    return null;
  }
  const name = p.author.displayName?.trim() || p.author.handle;
  const raw = p.record.text ?? '';
  const text = raw.startsWith(`${name}: `) ? raw.slice(name.length + 2) : raw;
  return {
    uri: p.uri,
    source: 'x',
    url: p.url,
    authorName: name,
    authorHandle: p.author.handle,
    authorUrl: `https://x.com/${p.author.handle}`,
    avatarUrl: httpsOrNull(p.author.avatar),
    text,
    links: [],
    createdAt: p.record.createdAt ?? '',
    replyCount: p.replyCount ?? 0,
    repostCount: 0,
    likeCount: p.likeCount ?? 0,
    ...mapMedia(rawMedia(p)),
    quote: mapQuote(p),
    parent: mapParent(p),
    topic,
    // xstream labels the posts X marks possibly_sensitive.
    nsfw: isNsfwRawPost(p),
  };
}

function mapPost(p: RawPostView, topic: string): BskyFeedPost | null {
  if (sourceOfUri(p.uri) === 'x') return mapXPost(p, topic);
  const text = p.record.text ?? '';
  return {
    uri: p.uri,
    source: 'bluesky',
    url: bskyPostUrl(p.uri, p.author.handle),
    authorName: p.author.displayName?.trim() || p.author.handle,
    authorHandle: p.author.handle,
    authorUrl: `https://bsky.app/profile/${p.author.handle}`,
    avatarUrl: httpsOrNull(avatarThumb(p.author.avatar)),
    text,
    links: facetsToLinks(text, p.record.facets),
    createdAt: p.record.createdAt ?? '',
    replyCount: p.replyCount ?? 0,
    repostCount: p.repostCount ?? 0,
    likeCount: p.likeCount ?? 0,
    ...mapMedia(rawMedia(p)),
    quote: mapQuote(p),
    parent: mapParent(p),
    topic,
    nsfw: isNsfwRawPost(p),
  };
}

/** One page of posts for `topic` from `sources` (Bluesky and/or X). `cursor` is the opaque value
 *  returned by the previous page (null for the first).
 *
 *  Every post comes from the backend's blueskySearch route, which only
 *  returns posts the filter model judged on-topic. There is deliberately no
 *  keyword-search fallback: its results never pass that check. When the
 *  route fails, the error propagates and the content script retries later,
 *  showing nothing new in the meantime. */
export async function searchBlueskyPosts(
  topic: string, cursor: string | null, sources: SeeMoreSource[],
): Promise<BskySearchResult> {
  const res = await callImbueBlueskySearch(topic, cursor ? Number(cursor) || 0 : 0, sources);
  // A forceLogin push settles the request with a filter-shaped placeholder.
  if (!Array.isArray(res?.uris)) throw new Error('blueskySearch returned no uris');
  // Bluesky posts hydrate from the public API; X posts arrive with the
  // response, since nothing public can hydrate them.
  const views = await getPosts(res.uris.filter(u => sourceOfUri(u) === 'bluesky'));
  for (const p of (res.posts ?? []) as RawPostView[]) {
    if (p && typeof p.uri === 'string' && sourceOfUri(p.uri) === 'x' && p.author && p.record) views.set(p.uri, p);
    else console.warn('[BlueskySearch] dropping malformed X post view:', p);
  }
  const missingX = res.uris.filter(u => sourceOfUri(u) === 'x' && !views.has(u));
  if (missingX.length) console.warn(`[BlueskySearch] ${missingX.length} X post(s) returned without a view:`, missingX);
  console.log(`[BlueskySearch] "${topic}" sources=${sources.join('+')} page stats:`, res.sourceStats ?? '(backend sent none)');
  const posts = res.uris.flatMap(uri => {
    const p = views.get(uri);
    const post = p && isInjectableRawPost(p) ? mapPost(p, topic) : null;
    return post ? [post] : [];
  });
  return { posts, cursor: res.cursor == null ? null : String(res.cursor) };
}

/** Hydrate post URIs (batches fetched in parallel); deleted posts are
 *  simply absent from the result. */
async function getPosts(uris: string[]): Promise<Map<string, RawPostView>> {
  const batches: string[][] = [];
  for (let i = 0; i < uris.length; i += BSKY_GET_POSTS_MAX) batches.push(uris.slice(i, i + BSKY_GET_POSTS_MAX));
  const pages = await Promise.all(batches.map(async batch => {
    const params = new URLSearchParams();
    for (const uri of batch) params.append('uris', uri);
    const res = await fetch(`${BSKY_GET_POSTS_ENDPOINT}?${params}`);
    if (!res.ok) throw new Error(`Bluesky getPosts failed: HTTP ${res.status}`);
    return (await res.json() as { posts?: RawPostView[] }).posts ?? [];
  }));
  return new Map(pages.flat().map(p => [p.uri, p]));
}
