/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  desktopVideoLockup,
  desktopShortLockup,
  mobileWatchCard,
  mobileShort,
} from '../fixtures/youtube-dom';
import type { PlatformAdapter } from '../../src/types';

let YouTubeAdapter: new () => PlatformAdapter;

function setURL(url: string) {
  (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL(url);
}

beforeEach(async () => {
  // chrome APIs the adapter touches at construction (_initPlaceholderSetting).
  globalThis.chrome = {
    runtime: {
      getURL: (path: string) => `chrome-extension://test-id/${path}`,
    },
    storage: {
      local: { get: () => Promise.resolve({}) },
      onChanged: { addListener: () => {} },
    },
  } as unknown as typeof chrome;

  // Stub head.appendChild so happy-dom doesn't reject the chrome-extension://
  // lockup-extractor script the adapter injects on construction.
  const origAppendChild = document.head.appendChild.bind(document.head);
  document.head.appendChild = function <T extends Node>(node: T): T {
    if (node instanceof HTMLScriptElement && node.src?.startsWith('chrome-extension://')) {
      setTimeout(() => node.onload?.(new Event('load')), 0);
      return node;
    }
    return origAppendChild(node);
  };

  // matchMedia is consulted by getThemeMode's mobile fallback.
  if (!window.matchMedia) {
    (window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia =
      (() => ({ matches: false }) as MediaQueryList);
  }

  // The adapter only claims window.BouncerAdapter on a youtube.com host (see
  // the hostname guard at the bottom of YouTubeAdapter.ts). Point happy-dom at
  // youtube.com before the module's import-time guard runs.
  setURL('https://www.youtube.com/');
  await import('../../adapters/youtube/YouTubeAdapter.js');
  YouTubeAdapter = window.BouncerAdapter;
});

// A fresh adapter reads `location.hostname` in its constructor to decide
// mobile vs desktop, so set the URL before constructing.
function makeAdapter(url = 'https://www.youtube.com/'): PlatformAdapter {
  setURL(url);
  return new YouTubeAdapter();
}

// ==================== shouldProcessCurrentPage ====================

describe('shouldProcessCurrentPage', () => {
  it('returns true on the home feed', () => {
    const adapter = makeAdapter('https://www.youtube.com/');
    expect(adapter.shouldProcessCurrentPage()).toBe(true);
  });

  it('returns true on a watch page', () => {
    const adapter = makeAdapter('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    expect(adapter.shouldProcessCurrentPage()).toBe(true);
  });

  it('returns false on subscriptions / results / channel pages', () => {
    expect(makeAdapter('https://www.youtube.com/feed/subscriptions').shouldProcessCurrentPage()).toBe(false);
    expect(makeAdapter('https://www.youtube.com/results?search_query=x').shouldProcessCurrentPage()).toBe(false);
    expect(makeAdapter('https://www.youtube.com/@SomeChannel').shouldProcessCurrentPage()).toBe(false);
  });
});

// ==================== getThemeMode ====================

describe('getThemeMode', () => {
  it('returns light on desktop by default', () => {
    const adapter = makeAdapter('https://www.youtube.com/');
    document.documentElement.removeAttribute('dark');
    expect(adapter.getThemeMode()).toBe('light');
  });

  it('returns dark on desktop when <html dark> is present', () => {
    const adapter = makeAdapter('https://www.youtube.com/');
    document.documentElement.setAttribute('dark', '');
    expect(adapter.getThemeMode()).toBe('dark');
    document.documentElement.removeAttribute('dark');
  });

  it('stays light on desktop even with darker-dark-theme (light-mode regression guard)', () => {
    // Desktop carries `darker-dark-theme` even in light mode, so it must NOT
    // be treated as a dark signal off mobile.
    const adapter = makeAdapter('https://www.youtube.com/');
    document.documentElement.removeAttribute('dark');
    document.documentElement.setAttribute('darker-dark-theme', '');
    expect(adapter.getThemeMode()).toBe('light');
    document.documentElement.removeAttribute('darker-dark-theme');
  });

  it('returns dark on mobile when <html darker-dark-theme> is present', () => {
    const adapter = makeAdapter('https://m.youtube.com/');
    document.documentElement.setAttribute('darker-dark-theme', '');
    expect(adapter.getThemeMode()).toBe('dark');
    document.documentElement.removeAttribute('darker-dark-theme');
  });
});

// ==================== getPostUrl ====================

describe('getPostUrl', () => {
  it('derives the watch URL from the content-id class', () => {
    const adapter = makeAdapter('https://www.youtube.com/');
    const article = desktopVideoLockup();
    expect(adapter.getPostUrl(article)).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  });

  it('returns null when there is no video id or link', () => {
    const adapter = makeAdapter('https://www.youtube.com/');
    document.body.innerHTML = '<yt-lockup-view-model></yt-lockup-view-model>';
    const article = document.body.firstElementChild as HTMLElement;
    expect(adapter.getPostUrl(article)).toBeNull();
  });
});

// ==================== extractPostContent: desktop ====================

describe('extractPostContent (desktop lockup)', () => {
  it('extracts title, channel, handle, metadata, avatar, and thumbnails', () => {
    const adapter = makeAdapter('https://www.youtube.com/');
    const content = adapter.extractPostContent(desktopVideoLockup());

    expect(content.text).toBe('Never Gonna Give You Up');
    expect(content.author).toBe('Rick Astley');
    expect(content.handle).toBe('/@RickAstley');
    expect(content.timeText).toBe('1.4B views 15 years ago');
    expect(content.avatarUrl).toBe('https://yt3.ggpht.com/abc/avatar.jpg');
    expect(content.postUrl).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    // Classifier payload uses the canonical (JPEG) mqdefault thumbnail...
    expect(content.imageUrls).toEqual(['https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg']);
    // ...while the panel display URL is the original lockup thumbnail.
    expect(content.displayImageUrls).toEqual(['https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg']);
    expect(content.quote).toBeNull();
  });

  it('extracts a desktop Short (links to /shorts/, no channel)', () => {
    const adapter = makeAdapter('https://www.youtube.com/');
    const content = adapter.extractPostContent(desktopShortLockup());

    expect(content.text).toBe('A Wild Desktop Short');
    expect(content.postUrl).toBe('https://www.youtube.com/watch?v=shortID12345');
    expect(content.imageUrls).toEqual(['https://i.ytimg.com/vi/shortID12345/mqdefault.jpg']);
  });
});

// ==================== extractPostContent: mobile ====================

describe('extractPostContent (mobile)', () => {
  it('extracts a mobile watch-page card', () => {
    const adapter = makeAdapter('https://m.youtube.com/watch?v=abc123XYZ_-');
    const content = adapter.extractPostContent(mobileWatchCard());

    expect(content.text).toBe('Some Mobile Video Title');
    expect(content.author).toBe('Some Channel');
    expect(content.handle).toBe('/@SomeChannel');
    expect(content.timeText).toBe('2.3M views • 1 year ago');
    expect(content.avatarUrl).toBe('https://yt3.ggpht.com/m/avatar.jpg');
    expect(content.postUrl).toBe('https://www.youtube.com/watch?v=abc123XYZ_-');
  });

  it('extracts a mobile Short (no channel, /shorts/ url)', () => {
    const adapter = makeAdapter('https://m.youtube.com/');
    const content = adapter.extractPostContent(mobileShort());

    expect(content.text).toBe('A Funny Mobile Short');
    expect(content.author).toBe('Short');
    expect(content.handle).toBe('');
    expect(content.timeText).toBeNull();
    expect(content.postUrl).toBe('https://www.youtube.com/shorts/mShort99XYZ');
    expect(content.imageUrls).toEqual(['https://i.ytimg.com/vi/mShort99XYZ/mqdefault.jpg']);
  });
});

// ==================== getPostContainer / hidePost ====================

describe('hidePost', () => {
  it('marks and removes a desktop card outright (placeholder off by default)', () => {
    const adapter = makeAdapter('https://www.youtube.com/');
    const article = desktopVideoLockup();
    adapter.hidePost(article);
    const container = adapter.getPostContainer(article);
    expect(container.dataset.filteredByExtension).toBe('true');
    expect(container.style.display).toBe('none');
  });
});
