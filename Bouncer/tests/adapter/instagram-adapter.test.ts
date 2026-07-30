/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { PlatformAdapter } from '../../src/types';

let InstagramAdapter: new () => PlatformAdapter;

beforeEach(async () => {
  globalThis.chrome = {
    runtime: {
      getURL: (path: string) => `chrome-extension://test-id/${path}`,
    } as unknown as typeof chrome.runtime,
  } as typeof chrome;

  // The adapter only claims `window.BouncerAdapter` on an instagram.com host
  // (see InstagramAdapter.ts). happy-dom defaults to localhost, so point it at
  // instagram.com before the module's hostname guard runs on import.
  (window as unknown as { happyDOM: { setURL(url: string): void } })
    .happyDOM.setURL('https://www.instagram.com/reels/');

  await import('../../adapters/instagram/InstagramAdapter.js');
  InstagramAdapter = window.BouncerAdapter;
});

// A reel slide as Instagram renders it: a decorative cover <img> (aria-hidden +
// empty alt, cdninstagram host) inside nested wrappers, a <video>, the author
// link, and the caption as the longest non-link dir="auto" block. Hashtag <a>s
// live *inside* the caption div, which is why the adapter keys off the
// container itself not being a link.
function reel(id: string, handle: string, file: string, caption: string): string {
  return `
    <div id="${id}">
      <div class="media">
        <div id="cover-${id}">
          <img aria-hidden="true" alt="" src="https://scontent.cdninstagram.com/v/t51.x/${file}?token=abc">
        </div>
        <video src="blob:https://www.instagram.com/${id}"></video>
      </div>
      <div class="chrome">
        <a href="/${handle}/reels/"><span dir="auto">${handle}</span></a>
        <img alt="${handle}'s profile picture" src="https://scontent.cdninstagram.com/v/t51.x/avatar.jpg">
        <div dir="auto">${caption} <a href="/explore/tags/pasta/">#pasta</a></div>
        <a href="/reels/audio/999/"><span dir="auto">original audio</span></a>
      </div>
    </div>`;
}

// Two reels in the scroller — the realistic feed shape. It matters: the climb
// from cover to card stops at the ancestor holding more than one <video>, so a
// single-reel fixture would hand back the scroller itself.
const FEED = `
<main role="main">
  <div id="scroller">
    ${reel('card', 'jennynomzz', '723238673_17877465735611947_n.jpg', 'Three easy weeknight pasta recipes')}
    ${reel('card2', 'someoneelse', '999_n.jpg', 'A second reel')}
  </div>
</main>
`;

function mountReel(): { adapter: PlatformAdapter; post: HTMLElement } {
  document.body.innerHTML = FEED;
  const adapter = new InstagramAdapter();
  const post = document.querySelector<HTMLElement>(adapter.selectors.post)!;
  return { adapter, post };
}

describe('InstagramAdapter', () => {
  it('matches exactly one post element per reel — the cover img parent', () => {
    document.body.innerHTML = FEED;
    const adapter = new InstagramAdapter();
    const matches = document.querySelectorAll(adapter.selectors.post);
    expect(matches).toHaveLength(2);
    expect([...matches].map(m => m.id)).toEqual(['cover-card', 'cover-card2']);
  });

  it('extracts the caption, author and cover thumbnail', () => {
    const { adapter, post } = mountReel();
    const content = adapter.extractPostContent(post);

    expect(content.text).toBe('Three easy weeknight pasta recipes #pasta');
    expect(content.author).toBe('jennynomzz');
    expect(content.handle).toBe('@jennynomzz');
    expect(content.imageUrls).toHaveLength(1);
    expect(content.imageUrls[0]).toContain('723238673_17877465735611947_n.jpg');
    expect(content.hasMediaContainer).toBe(true);
  });

  it('resolves the container to the reel slide, not the whole document', () => {
    const { adapter, post } = mountReel();
    // #scroller holds both reels' videos, so the climb stops one level below
    // it — the single-reel slide.
    expect(adapter.getPostContainer(post).id).toBe('card');
  });

  it('keys posts on the thumbnail pathname so query-token refreshes still hit', () => {
    const { adapter, post } = mountReel();
    const key = adapter.getPostContentKey(post);
    expect(key).toBe('/v/t51.x/723238673_17877465735611947_n.jpg');
    expect(key).not.toContain('token=');
  });

  it('hides and restores the whole reel slide', () => {
    const { adapter, post } = mountReel();
    const card = document.getElementById('card')!;
    // happy-dom reports an all-zero rect, which hidePost reads as "entirely
    // above the viewport" and leaves to the scroll-fade path. Put the card
    // on screen so the immediate-hide branch runs.
    card.getBoundingClientRect = () => ({ top: 0, bottom: 600 }) as DOMRect;

    adapter.hidePost(post);
    expect(card.dataset.filteredByExtension).toBe('true');
    expect(card.style.display).toBe('none');

    adapter.showPost(post);
    expect(card.dataset.filteredByExtension).toBeUndefined();
    expect(card.style.display).toBe('');
  });

  it('defers hiding a reel already scrolled above the viewport', () => {
    const { adapter, post } = mountReel();
    const card = document.getElementById('card')!;
    card.getBoundingClientRect = () => ({ top: -900, bottom: -300 }) as DOMRect;

    adapter.hidePost(post);
    // Marked, but left visible — the adapter's scroll handler fades it out
    // later, so the feed doesn't jump under the user mid-scroll.
    expect(card.dataset.filteredByExtension).toBe('true');
    expect(card.style.display).toBe('');
  });

  it('ignores non-cover images (avatars, non-CDN)', () => {
    document.body.innerHTML = `
      <main role="main"><div id="card">
        <img alt="Someone's profile picture" src="https://scontent.cdninstagram.com/avatar.jpg">
        <div id="decorative"><img aria-hidden="true" alt="" src="https://example.com/not-instagram.jpg"></div>
        <video></video>
      </div></main>`;
    const adapter = new InstagramAdapter();
    // The selector is structural so it still matches, but the cdninstagram
    // check in _coverImg rejects it and extraction yields nothing usable.
    const post = document.querySelector<HTMLElement>(adapter.selectors.post)!;
    const content = adapter.extractPostContent(post);
    expect(content.text).toBe('');
    expect(content.imageUrls).toEqual([]);
  });

  it('mounts no filter box of its own — the describer panel owns the entry point', () => {
    document.body.innerHTML = FEED;
    const adapter = new InstagramAdapter();
    expect(adapter.filterBoxPlacement).toBe('external');
    // A never-matching but VALID sidebar selector: the pipeline calls
    // querySelector() on it unguarded, and querySelector('') throws.
    expect(() => document.querySelector(adapter.selectors.sidebar)).not.toThrow();
    expect(document.querySelector(adapter.selectors.sidebar)).toBeNull();
  });

  it('skips DMs and account pages, processes reels surfaces', () => {
    document.body.innerHTML = FEED;
    const adapter = new InstagramAdapter();
    const setPath = (p: string) =>
      (window as unknown as { happyDOM: { setURL(url: string): void } })
        .happyDOM.setURL(`https://www.instagram.com${p}`);

    setPath('/reels/');
    expect(adapter.shouldProcessCurrentPage()).toBe(true);
    setPath('/direct/inbox/');
    expect(adapter.shouldProcessCurrentPage()).toBe(false);
    setPath('/accounts/edit/');
    expect(adapter.shouldProcessCurrentPage()).toBe(false);
  });

  it('has no permalink/main-post notion', () => {
    document.body.innerHTML = FEED;
    const adapter = new InstagramAdapter();
    expect(adapter.isPermalinkView()).toBe(false);
    expect(adapter.isMainPost(document.getElementById('card')!)).toBe(false);
  });
});
