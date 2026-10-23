// Background half of "See more of <topic>": anonymous Bluesky search, mapped
// to BskyFeedPost (see shared/bluesky.ts).

import {
  BSKY_SEARCH_ENDPOINT, bskyPostUrl, facetsToLinks, isInjectableRawPost, rawMedia,
  type BskyFeedPost, type BskySearchResult, type RawPostView,
} from '../shared/bluesky';

const SEARCH_PAGE_SIZE = 25;
// Anonymous searchPosts 403s any request carrying a `cursor`, so instead of
// paginating we walk back through consecutive time windows: page N is the
// top posts from [now - (N+1)·window, now - N·window].
const SEARCH_WINDOW_DAYS = 2;
const MAX_SEARCH_WINDOWS = 15;
// Avatars come as /img/avatar/plain/…; the thumbnail variant is ~10x smaller.
function avatarThumb(url: string | undefined): string | undefined {
  return url?.replace('/img/avatar/plain/', '/img/avatar_thumbnail/plain/');
}

const httpsOrNull = (url: string | undefined) => (url?.startsWith('https://') ? url : null);

function mapPost(p: RawPostView, topic: string): BskyFeedPost {
  const text = p.record.text ?? '';
  const media = rawMedia(p);
  let domain = '';
  try { domain = media.external ? new URL(media.external.uri).hostname.replace(/^www\./, '') : ''; } catch { /* bad URI */ }
  return {
    uri: p.uri,
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
    images: media.images.flatMap(img => {
      const url = httpsOrNull(img.thumb);
      const ar = img.aspectRatio;
      const aspectRatio = ar && ar.width > 0 && ar.height > 0 ? ar.width / ar.height : null;
      return url ? [{ url, alt: img.alt ?? '', aspectRatio }] : [];
    }),
    isVideo: media.isVideo,
    external: media.external && /^https:\/\//.test(media.external.uri)
      ? { uri: media.external.uri, title: media.external.title ?? '', domain, thumbUrl: httpsOrNull(media.external.thumb) }
      : null,
    topic,
  };
}

/** One page of top Bluesky posts for `topic`. `cursor` is the opaque
 *  window index returned by the previous page (null for the first). */
export async function searchBlueskyPosts(topic: string, cursor: string | null): Promise<BskySearchResult> {
  const windowIndex = cursor ? Number(cursor) || 0 : 0;
  const windowMs = SEARCH_WINDOW_DAYS * 86400_000;
  const until = Date.now() - windowIndex * windowMs;
  const params = new URLSearchParams({
    q: topic,
    sort: 'top',
    limit: String(SEARCH_PAGE_SIZE),
    since: new Date(until - windowMs).toISOString(),
  });
  if (windowIndex > 0) params.set('until', new Date(until).toISOString());
  const res = await fetch(`${BSKY_SEARCH_ENDPOINT}?${params}`);
  if (!res.ok) throw new Error(`Bluesky search failed: HTTP ${res.status}`);
  const body = await res.json() as { posts?: RawPostView[] };
  const raw = (body.posts ?? []).filter(isInjectableRawPost);
  const posts = raw.map(p => mapPost(p, topic));
  const next = windowIndex + 1;
  return { posts, cursor: next < MAX_SEARCH_WINDOWS ? String(next) : null };
}
