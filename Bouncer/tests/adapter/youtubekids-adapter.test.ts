/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  homeTile,
  watchTile,
  unhydratedTile,
  ariaOnlyTile,
} from '../fixtures/youtubekids-dom';
import type { PlatformAdapter } from '../../src/types';

let YouTubeKidsAdapter: new () => PlatformAdapter;

function setURL(url: string) {
  (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL(url);
}

beforeEach(async () => {
  // The adapter only claims window.BouncerAdapter on a youtubekids.com host
  // (see the hostname guard at the bottom of YouTubeKidsAdapter.ts). Point
  // happy-dom there before the module's import-time guard runs.
  setURL('https://www.youtubekids.com/');
  await import('../../adapters/youtubekids/YouTubeKidsAdapter.js');
  YouTubeKidsAdapter = window.BouncerAdapter;
});

function makeAdapter(url = 'https://www.youtubekids.com/'): PlatformAdapter {
  setURL(url);
  return new YouTubeKidsAdapter();
}

// ==================== shouldProcessCurrentPage ====================

describe('shouldProcessCurrentPage', () => {
  it('returns true on home, watch, and search', () => {
    expect(makeAdapter('https://www.youtubekids.com/').shouldProcessCurrentPage()).toBe(true);
    expect(makeAdapter('https://www.youtubekids.com/watch?v=dQw4w9WgXcQ').shouldProcessCurrentPage()).toBe(true);
    expect(makeAdapter('https://www.youtubekids.com/search?q=trains').shouldProcessCurrentPage()).toBe(true);
  });

  it('returns false on onboarding/profile pages', () => {
    expect(makeAdapter('https://www.youtubekids.com/onboarding').shouldProcessCurrentPage()).toBe(false);
    expect(makeAdapter('https://www.youtubekids.com/profile-switcher').shouldProcessCurrentPage()).toBe(false);
  });
});

// ==================== getPostUrl / getPostContentKey ====================

describe('getPostUrl', () => {
  it('derives the watch URL from the tile element id on home (ids with - and _ survive)', () => {
    const adapter = makeAdapter();
    const article = homeTile('a-b_c1234-Z');
    expect(adapter.getPostUrl(article)).toBe('https://www.youtubekids.com/watch?v=a-b_c1234-Z');
  });

  it('derives the watch URL from the anchor href on watch-page tiles (no id attribute)', () => {
    const adapter = makeAdapter('https://www.youtubekids.com/watch?v=other');
    const article = watchTile('dQw4w9WgXcQ');
    expect(adapter.getPostUrl(article)).toBe('https://www.youtubekids.com/watch?v=dQw4w9WgXcQ');
  });

  it('returns null for an unhydrated tile', () => {
    const adapter = makeAdapter();
    expect(adapter.getPostUrl(unhydratedTile())).toBeNull();
  });
});

describe('getPostContentKey', () => {
  it('keys on the video id when available', () => {
    const adapter = makeAdapter();
    expect(adapter.getPostContentKey(homeTile('a-b_c1234-Z'))).toBe('yt:a-b_c1234-Z');
    expect(adapter.getPostContentKey(watchTile('dQw4w9WgXcQ'))).toBe('yt:dQw4w9WgXcQ');
  });

  it('falls back to empty string for an unhydrated tile', () => {
    const adapter = makeAdapter();
    expect(adapter.getPostContentKey(unhydratedTile())).toBe('');
  });
});

// ==================== extractPostContent ====================

describe('extractPostContent', () => {
  it('extracts title, canonical classifier thumbnail, and display thumbnail', () => {
    const adapter = makeAdapter();
    const content = adapter.extractPostContent(homeTile('a-b_c1234-Z'));
    expect(content.text).toBe('Fun Learning Video');
    expect(content.textHtml).toBe('Fun Learning Video');
    // Classifier payload is the canonical JPEG-guaranteed mqdefault URL...
    expect(content.imageUrls).toEqual(['https://i.ytimg.com/vi/a-b_c1234-Z/mqdefault.jpg']);
    // ...while the panel keeps the original lockup thumbnail.
    expect(content.displayImageUrls).toEqual(['https://i.ytimg.com/vi/a-b_c1234-Z/hqdefault.jpg']);
    expect(content.postUrl).toBe('https://www.youtubekids.com/watch?v=a-b_c1234-Z');
    expect(content.hasMediaContainer).toBe(true);
    // Kids tiles render no channel byline.
    expect(content.author).toBe('');
    expect(content.handle).toBe('');
    expect(content.avatarUrl).toBeNull();
    expect(content.timeText).toBeNull();
  });

  it('falls back to the anchor aria-label when the title has not rendered', () => {
    const adapter = makeAdapter();
    const content = adapter.extractPostContent(ariaOnlyTile());
    expect(content.text).toBe('Play Aria Label Title');
  });
});

// ==================== extractPostContentFromStore (hydration gate) ====================

describe('extractPostContentFromStore', () => {
  it('resolves content for a hydrated tile', async () => {
    const adapter = makeAdapter();
    const content = await adapter.extractPostContentFromStore(homeTile());
    expect(content).not.toBeNull();
    expect(content!.text).toBe('Fun Learning Video');
    // Not from a page-world store — the DOM-preferred merge must stay active.
    expect(content!.fromStore).toBeUndefined();
  });

  it('resolves null for an unhydrated tile so the observer retry loop kicks in', async () => {
    const adapter = makeAdapter();
    expect(await adapter.extractPostContentFromStore(unhydratedTile())).toBeNull();
  });
});

// ==================== hidePost / getPostContainer ====================

describe('hidePost', () => {
  it('marks and fully hides the tile itself (no placeholder)', () => {
    const adapter = makeAdapter();
    const article = homeTile();
    expect(adapter.getPostContainer(article)).toBe(article);
    adapter.hidePost(article);
    expect(article.dataset.filteredByExtension).toBe('true');
    expect(article.style.display).toBe('none');
    expect(article.querySelector('.bouncer-yt-placeholder')).toBeNull();
  });
});

// ==================== cleanupFilteredPostHtml ====================

describe('cleanupFilteredPostHtml', () => {
  it('un-hides the clone, strips the menu, and swaps the thumbnail for a fresh img', () => {
    const adapter = makeAdapter();
    const article = homeTile('a-b_c1234-Z');
    adapter.hidePost(article);
    const clone = article.cloneNode(true) as HTMLElement;
    const wrapper = document.createElement('div');
    wrapper.appendChild(clone);

    adapter.cleanupFilteredPostHtml(wrapper, ['https://i.ytimg.com/vi/a-b_c1234-Z/hqdefault.jpg']);

    expect(clone.style.display).toBe('');
    expect(clone.hasAttribute('data-filtered-by-extension')).toBe(false);
    expect(wrapper.querySelector('.menu')).toBeNull();
    expect(wrapper.querySelector('yt-img-shadow')).toBeNull();
    const img = wrapper.querySelector<HTMLImageElement>('.slop-media-container img.slop-media-image');
    expect(img?.src).toBe('https://i.ytimg.com/vi/a-b_c1234-Z/hqdefault.jpg');
  });
});

// ==================== banner placement ====================

describe('getFilterBoxAnchor', () => {
  it('anchors above the home screen renderer on home', () => {
    const adapter = makeAdapter('https://www.youtubekids.com/');
    document.body.innerHTML = '<div id="page"><ytk-kids-home-screen-renderer></ytk-kids-home-screen-renderer></div>';
    const home = document.querySelector('ytk-kids-home-screen-renderer')!;
    const anchor = adapter.getFilterBoxAnchor!();
    expect(anchor).not.toBeNull();
    expect(anchor!.parent).toBe(home.parentElement);
    expect(anchor!.insertBefore).toBe(home);
  });

  it('returns null on the watch page and before home hydration', () => {
    document.body.innerHTML = '';
    expect(makeAdapter('https://www.youtubekids.com/').getFilterBoxAnchor!()).toBeNull();
    document.body.innerHTML = '<ytk-kids-home-screen-renderer></ytk-kids-home-screen-renderer>';
    expect(makeAdapter('https://www.youtubekids.com/watch?v=x').getFilterBoxAnchor!()).toBeNull();
  });
});

// ==================== misc contract ====================

describe('adapter contract', () => {
  it('identifies as the youtubekids banner platform', () => {
    const adapter = makeAdapter();
    expect(adapter.siteId).toBe('youtubekids');
    expect(adapter.filterBoxPlacement).toBe('banner');
  });

  it('never treats tiles as main posts or pages as permalink views', () => {
    const adapter = makeAdapter('https://www.youtubekids.com/watch?v=x');
    expect(adapter.isMainPost(watchTile())).toBe(false);
    expect(adapter.isPermalinkView()).toBe(false);
  });

  it('exposes no share button or search form (no Bouncer chrome on kid tiles)', () => {
    const adapter = makeAdapter();
    expect(adapter.getShareButton(homeTile())).toBeNull();
    expect(adapter.getSearchForm()).toBeNull();
  });

  it('defaults to light theme', () => {
    const adapter = makeAdapter();
    expect(adapter.getThemeMode()).toBe('light');
  });
});
