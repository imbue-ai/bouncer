// Posts the user likes on X, kept on the device (SEE_MORE_LIKED_KEY) as the
// main signal for which "See more" topics to suggest them (getSeeMorePicks in
// background/index.ts). Tapping X's heart records the post; un-liking it
// removes it again. Injected "See more" posts have no real like button (theirs
// opens the post), so only tweets count.

import type { PlatformAdapter } from '../types';
import { getStorage, setStorage } from '../shared/storage';
import { MAX_SEE_MORE_LIKED, MAX_SEE_MORE_LIKED_CHARS, SEE_MORE_LIKED_KEY } from '../shared/bluesky';
import { formatPostForEvaluation } from '../shared/utils';

const MIN_TEXT = 15;               // image-only and one-word posts say little about taste

let adapter: PlatformAdapter | null = null;
// Serializes the read-modify-write of the stored list across quick taps.
let writing: Promise<void> = Promise.resolve();

export function initLikedPosts(platformAdapter: PlatformAdapter): void {
  if (platformAdapter.siteId !== 'twitter') return;
  adapter = platformAdapter;
  // Capture phase: X handles the tap and swaps the button (like → unlike)
  // before a bubbling listener would see which one it was.
  document.addEventListener('click', e => {
    const button = (e.target as Element | null)?.closest?.('[data-testid="like"], [data-testid="unlike"]');
    const article = button?.closest<HTMLElement>('article');
    if (!button || !article) return;
    const entry = likedEntry(article);
    if (!entry) return;
    const liked = button.getAttribute('data-testid') === 'like';
    writing = writing.then(() => record(entry, liked))
      .catch(err => console.warn('[Bouncer] liked-post record failed:', err));
  }, true);
}

function likedEntry(article: HTMLElement): string | null {
  const content = adapter!.extractPostContent(article);
  if ((content.text ?? '').trim().length < MIN_TEXT) return null;
  // X's author text runs on into "@handle·2h"; the display name is enough.
  const at = content.handle ? content.author.indexOf(content.handle) : -1;
  const author = (at > 0 ? content.author.slice(0, at) : content.author).trim();
  return formatPostForEvaluation({ ...content, author }).replace(/\s+/g, ' ').trim().slice(0, MAX_SEE_MORE_LIKED_CHARS);
}

async function record(entry: string, liked: boolean): Promise<void> {
  const stored = (await getStorage([SEE_MORE_LIKED_KEY]))[SEE_MORE_LIKED_KEY] ?? [];
  const rest = stored.filter(e => e !== entry);
  if (!liked && rest.length === stored.length) return;
  const next = liked ? [...rest, entry].slice(-MAX_SEE_MORE_LIKED) : rest;
  await setStorage({ [SEE_MORE_LIKED_KEY]: next });
}
