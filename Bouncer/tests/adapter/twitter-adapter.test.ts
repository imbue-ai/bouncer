/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { loadTwitterFixture } from '../fixtures/twitter-dom';
import { formatPostForEvaluation } from '../../src/shared/utils';
import type { PlatformAdapter } from '../../src/types';

let TwitterAdapter: new () => PlatformAdapter;

beforeEach(async () => {
  // Mock IntersectionObserver (not available in happy-dom)
  globalThis.IntersectionObserver = class {
    _cb: IntersectionObserverCallback;
    _opts: IntersectionObserverInit | undefined;
    constructor(cb: IntersectionObserverCallback, opts?: IntersectionObserverInit) { this._cb = cb; this._opts = opts; }
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords(): IntersectionObserverEntry[] { return []; }
    get root(): Element | Document | null { return null; }
    get rootMargin(): string { return ''; }
    get thresholds(): readonly number[] { return []; }
  } as unknown as typeof IntersectionObserver;

  // Mock chrome extension API before importing the adapter
  globalThis.chrome = {
    runtime: {
      getURL: (path: string) => `chrome-extension://test-id/${path}`,
    } as unknown as typeof chrome.runtime,
  } as typeof chrome;

  // Stub head.appendChild to prevent happy-dom from rejecting chrome-extension:// script loads
  const origAppendChild = document.head.appendChild.bind(document.head);
  document.head.appendChild = function <T extends Node>(node: T): T {
    if (node instanceof HTMLScriptElement && node.src?.startsWith('chrome-extension://')) {
      // Simulate successful load without actually loading
      setTimeout(() => node.onload?.(new Event('load')), 0);
      return node;
    }
    return origAppendChild(node);
  };

  await import('../../adapters/twitter/TwitterAdapter.js');
  TwitterAdapter = window.BouncerAdapter;
});

// ==================== finding tweets ====================

describe('finding tweets', () => {
  let adapter: PlatformAdapter;
  beforeEach(() => {
    loadTwitterFixture();
    adapter = new TwitterAdapter();
  });

  it('finds all tweet articles using the post selector', () => {
    const articles = document.querySelectorAll(adapter.selectors.post);
    expect(articles).toHaveLength(5);
  });

});

// ==================== extractPostContent ====================

describe('extractPostContent', () => {
  let adapter: PlatformAdapter;
  let articles: HTMLElement[];
  beforeEach(() => {
    loadTwitterFixture();
    adapter = new TwitterAdapter();
    articles = [...document.querySelectorAll(adapter.selectors.post)] as HTMLElement[];
  });

  it('extracts text and author from a text + video tweet', () => {
    // Article 0: Thariq's Claude Code voice mode tweet
    const result = adapter.extractPostContent(articles[0]);
    expect(result.author).toContain('Thariq');
    expect(result.author).toContain('@trq212');
    expect(result.text).toContain('Voice mode is rolling out now in Claude Code');
    expect(result.text).toContain('/voice to toggle it on!');
    const evalText = formatPostForEvaluation(result);
    expect(evalText).toContain('Thariq');
    expect(evalText).toContain('Voice mode');
  });

  it('returns empty text when tweet has no tweetText element', () => {
    // Article 1: Dimitris's image-only tweet (no tweetText)
    const result = adapter.extractPostContent(articles[1]);
    expect(result.text).toBe('');
    expect(result.author).toContain('Dimitris');
    expect(result.author).toContain('@DimitrisPapail');
  });

  it('extracts short tweet text', () => {
    // Article 2: Notion's short tweet
    const result = adapter.extractPostContent(articles[2]);
    expect(result.text).toBe('Allow us to reintroduce ourselves.');
    expect(result.author).toContain('Notion');
    expect(result.author).toContain('@NotionHQ');
  });

  it('extracts truncated tweet text as-is', () => {
    // Article 3: chiefofautism's long tweet (truncated by Twitter's "Show more")
    const result = adapter.extractPostContent(articles[3]);
    expect(result.text).toContain('someone connected LIVING BRAIN CELLS to an LLM');
    expect(result.text).toContain('Cortical Labs');
    expect(result.author).toContain('chiefofautism');
  });

  it('extracts post URL from the timestamp link', () => {
    const result = adapter.extractPostContent(articles[0]);
    expect(result.postUrl).toBe('https://x.com/trq212/status/2028628570692890800');
  });

  it('extracts post URLs for all articles', () => {
    const expectedUrls = [
      'https://x.com/trq212/status/2028628570692890800',
      'https://x.com/DimitrisPapail/status/2028669695344148946',
      'https://x.com/NotionHQ/status/2028533326966088188',
      'https://x.com/chiefofautism/status/2028800881932505187',
      'https://x.com/omarsar0/status/2028823724196343923',
    ];
    articles.forEach((article, i) => {
      const result = adapter.extractPostContent(article);
      expect(result.postUrl).toBe(expectedUrls[i]);
    });
  });

  it('picks up video poster as image URL (amplify_video_thumb)', () => {
    // Article 0: has a video with amplify_video_thumb poster
    const result = adapter.extractPostContent(articles[0]);
    expect(result.imageUrls).toContain(
      'https://pbs.twimg.com/amplify_video_thumb/2028628068517183489/img/pqaAS9fN8tZTs8fY.jpg'
    );
  });

  it('picks up video poster as image URL (pbs.twimg.com/media)', () => {
    // Article 2: Notion's video has a pbs.twimg.com/media poster
    const result = adapter.extractPostContent(articles[2]);
    expect(result.imageUrls).toContain(
      'https://pbs.twimg.com/media/HCbNLTubkAABOG8.jpg'
    );
  });

  it('detects media for tweets with tweetPhoto and videoPlayer', () => {
    // Articles 0, 2, 3 have tweetPhoto + videoPlayer
    for (const idx of [0, 2, 3]) {
      const result = adapter.extractPostContent(articles[idx]);
      expect(result.hasMediaContainer).toBe(true);
    }
  });

  it('detects media for tweet with tweetPhoto only (no video)', () => {
    // Article 4: has tweetPhoto but no videoPlayer
    const result = adapter.extractPostContent(articles[4]);
    expect(result.hasMediaContainer).toBe(true);
  });

  it('reports no media when tweet has no media containers or matching images', () => {
    // Article 1: no tweetPhoto, no videoPlayer, no card.wrapper,
    // and images are local paths (not pbs.twimg.com)
    const result = adapter.extractPostContent(articles[1]);
    expect(result.hasMediaContainer).toBe(false);
  });
});

// ==================== shouldProcessCurrentPage ====================

describe('shouldProcessCurrentPage', () => {
  let adapter: PlatformAdapter;
  beforeEach(() => {
    adapter = new TwitterAdapter();
    document.body.innerHTML = '';
  });

  function setPath(path: string) {
    window.location.href = `https://x.com${path}`;
  }

  function addTabList(tabs: Array<{ text: string; selected: boolean }>) {
    const tabBar = document.createElement('div');
    tabBar.setAttribute('role', 'tablist');
    for (const { text, selected } of tabs) {
      const tab = document.createElement('div');
      tab.setAttribute('role', 'tab');
      tab.textContent = text;
      tab.setAttribute('aria-selected', selected ? 'true' : 'false');
      tabBar.appendChild(tab);
    }
    document.body.appendChild(tabBar);
    return tabBar;
  }

  it('returns true on the fixture /home page with For you tab selected', () => {
    loadTwitterFixture();
    setPath('/home');
    expect(adapter.shouldProcessCurrentPage()).toBe(true);
  });

  it('returns true on /home with Following tab selected', () => {
    setPath('/home');
    addTabList([
      { text: 'For you', selected: false },
      { text: 'Following', selected: true },
    ]);
    expect(adapter.shouldProcessCurrentPage()).toBe(true);
  });

  it('returns false on /home with no matching tab selected', () => {
    setPath('/home');
    addTabList([
      { text: 'For you', selected: false },
      { text: 'Following', selected: false },
      { text: 'Lists', selected: true },
    ]);
    expect(adapter.shouldProcessCurrentPage()).toBe(false);
  });

  it('returns false on /home with no tablist', () => {
    setPath('/home');
    expect(adapter.shouldProcessCurrentPage()).toBe(false);
  });

  it('returns true on status pages', () => {
    setPath('/user/status/12345');
    expect(adapter.shouldProcessCurrentPage()).toBe(true);
  });

  it('returns true on /explore', () => {
    setPath('/explore');
    expect(adapter.shouldProcessCurrentPage()).toBe(true);
  });

  it('returns true on /search paths', () => {
    setPath('/search?q=test');
    expect(adapter.shouldProcessCurrentPage()).toBe(true);
  });

  it('returns false on profile pages', () => {
    setPath('/someuser');
    expect(adapter.shouldProcessCurrentPage()).toBe(false);
  });

  it('returns false on /notifications', () => {
    setPath('/notifications');
    expect(adapter.shouldProcessCurrentPage()).toBe(false);
  });
});

// ==================== getPostContainer ====================

describe('getPostContainer', () => {
  let adapter: PlatformAdapter;
  beforeEach(() => {
    loadTwitterFixture();
    adapter = new TwitterAdapter();
  });

  it('returns cellInnerDiv wrapper for fixture articles', () => {
    const articles = document.querySelectorAll(adapter.selectors.post);
    for (const article of articles) {
      const container = adapter.getPostContainer(article as HTMLElement);
      expect(container.dataset.testid).toBe('cellInnerDiv');
    }
  });

  it('returns article itself when no cellInnerDiv', () => {
    const article = document.createElement('article');
    article.setAttribute('data-testid', 'tweet');
    document.body.appendChild(article);
    expect(adapter.getPostContainer(article)).toBe(article);
    article.remove();
  });
});

// ==================== getThemeMode ====================

describe('getThemeMode', () => {
  let adapter: PlatformAdapter;
  beforeEach(() => {
    adapter = new TwitterAdapter();
  });

  it('detects light mode from the fixture page', () => {
    loadTwitterFixture();
    expect(adapter.getThemeMode()).toBe('light');
  });

  it('returns dark for black background', () => {
    document.body.style.backgroundColor = 'rgb(0, 0, 0)';
    expect(adapter.getThemeMode()).toBe('dark');
  });

  it('returns dim for Twitter dim mode', () => {
    document.body.style.backgroundColor = 'rgb(21, 32, 43)';
    expect(adapter.getThemeMode()).toBe('dim');
  });

  it('defaults to dark when no bg color parseable', () => {
    document.body.style.backgroundColor = '';
    expect(adapter.getThemeMode()).toBe('dark');
  });
});

// ==================== isMainPost ====================

describe('isMainPost', () => {
  let adapter: PlatformAdapter;
  beforeEach(() => {
    adapter = new TwitterAdapter();
    document.body.innerHTML = '';
  });

  function setPath(path: string) {
    window.location.href = `https://x.com${path}`;
  }

  function buildConversationTimeline(articleCount: number) {
    const timeline = document.createElement('div');
    timeline.setAttribute('aria-label', 'Timeline: Conversation');
    const articles: HTMLElement[] = [];
    for (let i = 0; i < articleCount; i++) {
      const article = document.createElement('article');
      article.setAttribute('data-testid', 'tweet');
      timeline.appendChild(article);
      articles.push(article);
    }
    document.body.appendChild(timeline);
    return articles;
  }

  it('returns true for the first article on a status page', () => {
    setPath('/user/status/12345');
    const articles = buildConversationTimeline(3);
    expect(adapter.isMainPost(articles[0])).toBe(true);
  });

  it('returns false for a reply (not first article) on a status page', () => {
    setPath('/user/status/12345');
    const articles = buildConversationTimeline(3);
    expect(adapter.isMainPost(articles[1])).toBe(false);
    expect(adapter.isMainPost(articles[2])).toBe(false);
  });

  it('returns false on the home page regardless of article', () => {
    setPath('/home');
    const articles = buildConversationTimeline(2);
    expect(adapter.isMainPost(articles[0])).toBe(false);
  });

  it('returns false on a status page with no conversation timeline', () => {
    setPath('/user/status/12345');
    const article = document.createElement('article');
    article.setAttribute('data-testid', 'tweet');
    document.body.appendChild(article);
    expect(adapter.isMainPost(article)).toBe(false);
  });
});

// ==================== hidePost ====================

describe('hidePost', () => {
  let adapter: PlatformAdapter;
  beforeEach(() => {
    adapter = new TwitterAdapter();
    document.body.innerHTML = '';
  });

  function createPostWithContainer(rectTop: number) {
    const container = document.createElement('div');
    container.setAttribute('data-testid', 'cellInnerDiv');
    const article = document.createElement('article');
    article.setAttribute('data-testid', 'tweet');
    container.appendChild(article);
    document.body.appendChild(container);

    // Mock getBoundingClientRect on the container
    container.getBoundingClientRect = () => ({
      top: rectTop, bottom: rectTop + 200, left: 0, right: 400, width: 400, height: 200,
      x: 0, y: rectTop, toJSON() {},
    });

    return { article, container };
  }

  it('marks posts entirely above viewport without hiding', () => {
    const { article, container } = createPostWithContainer(-300);
    adapter.hidePost(article);
    expect(container.dataset.filteredByExtension).toBe('true');
    expect(container.style.display).not.toBe('none');
    expect(container.style.visibility).not.toBe('hidden');
  });

  it('uses display:none for posts partially above viewport (overlapping)', () => {
    const { article, container } = createPostWithContainer(-100);
    adapter.hidePost(article);
    expect(container.style.display).toBe('none');
  });

  it('uses display:none for posts at or below viewport', () => {
    const { article, container } = createPostWithContainer(0);
    adapter.hidePost(article);
    expect(container.style.display).toBe('none');
  });

  it('uses display:none for posts well below viewport', () => {
    const { article, container } = createPostWithContainer(500);
    adapter.hidePost(article);
    expect(container.style.display).toBe('none');
  });

  it('sets data-filtered-by-extension attribute', () => {
    const { article, container } = createPostWithContainer(100);
    adapter.hidePost(article);
    expect(container.dataset.filteredByExtension).toBe('true');
  });
});
