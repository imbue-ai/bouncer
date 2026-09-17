// Feed-level reel removal — the pure half of the MAIN-world hook's response
// rewrite (see ./hook.ts, which owns the fetch/XHR plumbing).
//
// Skipping a reel hides its card, but the reel is still in Instagram's data:
// scroll back and it's there, reload and the feed may serve it again. Real
// removal means the page never receives it — so when the user bounces a reel,
// the hook starts dropping it from Instagram's own JSON before React reads the
// response. The feed then simply never contained it: no gap, no dead slide,
// pagination cursors untouched (they live in page_info, beside the edges).
//
// Everything here is pure string/JSON work with no DOM or page dependencies,
// so it can be unit-tested directly (tests/instagram/rewrite.test.ts). The
// only structural assumption about Instagram's payloads: reels batches live
// under a key matching /clips/i + /connection/i whose value has an `edges`
// array of { node: { media } } — verified live 2026-09 as
// `xdt_api__v1__clips__home__connection_v2`, matched by regex rather than by
// name so a version bump doesn't silently turn removal off.

export function fileNameOf(url: string): string | null {
  try {
    const p = new URL(url).pathname;
    const name = p.slice(p.lastIndexOf('/') + 1);
    return name || null;
  } catch {
    return null;
  }
}

// Every cover-image filename a media object goes by (image_versions2 on the
// app-API shape; display_url/thumbnail_src on older web-GraphQL shapes). These
// filenames are how the isolated world names reels (reelId is the cover's
// pathname), so they're both the harvest join key and the removal match key.
export function coverFilenames(obj: Record<string, unknown>): string[] {
  const filenames: string[] = [];
  const iv = obj.image_versions2 as { candidates?: { url?: string }[] } | undefined;
  for (const c of iv?.candidates ?? []) {
    const f = c?.url ? fileNameOf(c.url) : null;
    if (f) filenames.push(f);
  }
  for (const k of ['display_url', 'thumbnail_src', 'display_uri']) {
    const v = obj[k];
    if (typeof v === 'string') {
      const f = fileNameOf(v);
      if (f) filenames.push(f);
    }
  }
  return filenames;
}

// Everything a media object answers to: its shortcode, its numeric id, and
// every cover filename. Removal matches on ANY of these because the two sides
// name reels differently — the isolated world only knows the cover filename it
// scraped off the <img>, while a future payload is most stably identified by
// code. The hook bridges the two by alias-expanding filenames into codes as
// media objects flow past (see expandRemovedAliases in ./hook.ts).
export function mediaMatchKeys(media: Record<string, unknown>): string[] {
  const keys: string[] = [];
  if (typeof media.code === 'string' && media.code.length > 0) keys.push(media.code);
  for (const idKey of ['pk', 'id'] as const) {
    const v = media[idKey];
    if (typeof v === 'string' || typeof v === 'number') keys.push(String(v));
  }
  keys.push(...coverFilenames(media));
  return keys;
}

function isClipsConnectionKey(key: string): boolean {
  return /clips/i.test(key) && /connection/i.test(key);
}

function edgeMatches(edge: unknown, removed: ReadonlySet<string>): boolean {
  if (!edge || typeof edge !== 'object') return false;
  const node = (edge as { node?: unknown }).node;
  if (!node || typeof node !== 'object') return false;
  // Reels batches carry the media under node.media; be tolerant of the media
  // sitting directly on the node, which some sibling connections do.
  const rawMedia = (node as { media?: unknown }).media;
  const media = rawMedia && typeof rawMedia === 'object' ? rawMedia : node;
  return mediaMatchKeys(media as Record<string, unknown>).some(k => removed.has(k));
}

/**
 * Drop removed reels from every clips-connection in `root`, in place.
 * Returns how many edges were dropped (0 = payload untouched).
 *
 * Only `edges` shrinks — page_info and every other sibling stay bit-identical,
 * which is what keeps pagination alive (verified live: cursors sit outside the
 * edges array and survive arbitrary drops).
 */
export function filterClipsPayload(root: unknown, removed: ReadonlySet<string>): number {
  if (removed.size === 0) return 0;
  let dropped = 0;
  const stack: unknown[] = [root];
  // Same walk budget as the hook's harvest: a payload bigger than this is not
  // a reels batch, and an unbounded walk on one must never stall the page.
  let steps = 0;
  while (stack.length > 0 && steps < 200_000) {
    const node = stack.pop();
    steps++;
    if (!node || typeof node !== 'object') continue;
    if (Array.isArray(node)) {
      for (const v of node) if (v && typeof v === 'object') stack.push(v);
      continue;
    }
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      const conn = value as { edges?: unknown } | null;
      if (isClipsConnectionKey(key) && conn && Array.isArray(conn.edges)) {
        const edges: unknown[] = conn.edges;
        const kept = edges.filter(edge => !edgeMatches(edge, removed));
        conn.edges = kept;
        dropped += edges.length - kept.length;
        // The kept edges may themselves nest more media (e.g. carousels) but
        // no further clips connections — no need to descend into them.
      } else if (value && typeof value === 'object') {
        stack.push(value);
      }
    }
  }
  return dropped;
}

/** One reel as it sits in a clips-connection payload — everything the
 *  classifier needs before the reel has any DOM presence: the caption and
 *  cover for the model, a muxed progressive-MP4 URL for server-side audio,
 *  and every name the reel goes by so a verdict can be matched back. */
export interface ClipsMediaEntry {
  code?: string;
  caption: string;
  thumbnailUrl?: string;
  videoUrl?: string;
  filenames: string[];
}

function entryFromMedia(media: Record<string, unknown>): ClipsMediaEntry | null {
  const filenames = coverFilenames(media);
  if (filenames.length === 0) return null;   // nothing to match a verdict back on
  const code = typeof media.code === 'string' && media.code.length > 0 ? media.code : undefined;
  const captionObj = media.caption as { text?: unknown } | null | undefined;
  const caption = typeof captionObj?.text === 'string' ? captionObj.text : '';
  const iv = media.image_versions2 as { candidates?: { url?: unknown }[] } | undefined;
  const candidateUrl = iv?.candidates?.[0]?.url;
  const thumbnailUrl = typeof candidateUrl === 'string' && candidateUrl.startsWith('https:')
    ? candidateUrl
    : typeof media.display_url === 'string' && media.display_url.startsWith('https:')
      ? media.display_url
      : undefined;
  const versions = media.video_versions as { url?: unknown }[] | undefined;
  const versionUrl = Array.isArray(versions) ? versions[0]?.url : undefined;
  const videoUrl = typeof versionUrl === 'string' && versionUrl.startsWith('https:')
    ? versionUrl
    : undefined;
  return {
    ...(code ? { code } : {}),
    caption,
    ...(thumbnailUrl ? { thumbnailUrl } : {}),
    ...(videoUrl ? { videoUrl } : {}),
    filenames,
  };
}

/**
 * Every reel in every clips connection of `root`, in payload order — the
 * batch the hold-and-classify flow sends off for verdicts before the page is
 * allowed to read the response. Read-only: `root` is not modified.
 */
export function extractClipsEntries(root: unknown): ClipsMediaEntry[] {
  const entries: ClipsMediaEntry[] = [];
  const stack: unknown[] = [root];
  let steps = 0;
  while (stack.length > 0 && steps < 200_000) {
    const node = stack.pop();
    steps++;
    if (!node || typeof node !== 'object') continue;
    if (Array.isArray(node)) {
      for (const v of node) if (v && typeof v === 'object') stack.push(v);
      continue;
    }
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      const conn = value as { edges?: unknown } | null;
      if (isClipsConnectionKey(key) && conn && Array.isArray(conn.edges)) {
        for (const edge of conn.edges) {
          if (!edge || typeof edge !== 'object') continue;
          const edgeNode = (edge as { node?: unknown }).node;
          if (!edgeNode || typeof edgeNode !== 'object') continue;
          const rawMedia = (edgeNode as { media?: unknown }).media;
          const media = rawMedia && typeof rawMedia === 'object' ? rawMedia : edgeNode;
          const entry = entryFromMedia(media as Record<string, unknown>);
          if (entry) entries.push(entry);
        }
      } else if (value && typeof value === 'object') {
        stack.push(value);
      }
    }
  }
  return entries;
}

/**
 * The string-in/string-out form the XHR/fetch shadows use. Returns the
 * re-serialized body plus the drop count, or null when the body is not JSON,
 * plainly can't contain a clips connection, or contained nothing to drop —
 * null meaning "hand the page the original bytes untouched".
 */
export function rewriteClipsText(
  text: string,
  removed: ReadonlySet<string>,
): { text: string; dropped: number } | null {
  if (removed.size === 0) return null;
  // Cheap gate before the parse: every clips-connection key contains the word.
  if (typeof text !== 'string' || text.charAt(0) !== '{' || !/clips/i.test(text)) return null;
  try {
    const json: unknown = JSON.parse(text);
    const dropped = filterClipsPayload(json, removed);
    if (dropped === 0) return null;
    return { text: JSON.stringify(json), dropped };
  } catch {
    return null;
  }
}
