/**
 * @vitest-environment happy-dom
 *
 * X's rewritten web app ("x-web"). Fixtures are trimmed server-rendered
 * markup from logged-out x.com pages (classes, scripts and SVG paths
 * stripped), captured 2026-11-27.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import type { PlatformAdapter } from '../../src/types';

const fixtureDir = resolve(dirname(fileURLToPath(import.meta.url)), '../fixtures');
const load = (name: string) => {
  document.body.innerHTML = readFileSync(resolve(fixtureDir, name), 'utf8');
};

let TwitterAdapter: new () => PlatformAdapter;

function setURL(url: string) {
  (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL(url);
}

beforeEach(async () => {
  globalThis.chrome = {
    runtime: { getURL: (path: string) => `chrome-extension://test-id/${path}` } as unknown as typeof chrome.runtime,
  } as typeof chrome;
  // The legacy-mode adapter injects fiber-extractor.js; swallow the load.
  const origAppendChild = document.head.appendChild.bind(document.head);
  document.head.appendChild = function <T extends Node>(node: T): T {
    if (node instanceof HTMLScriptElement && node.src?.startsWith('chrome-extension://')) return node;
    return origAppendChild(node);
  };
  setURL('https://x.com/home');
  await import('../../adapters/twitter/TwitterAdapter.js');
  TwitterAdapter = window.BouncerAdapter;
  document.documentElement.setAttribute('data-app-version', 'test');
});

afterEach(() => {
  document.documentElement.removeAttribute('data-app-version');
});

const posts = (adapter: PlatformAdapter) =>
  Array.from(document.querySelectorAll<HTMLElement>(adapter.selectors.post));

describe('x-web timeline', () => {
  let adapter: PlatformAdapter;
  beforeEach(() => {
    setURL('https://x.com/elonmusk');
    load('x-web-timeline.html');
    adapter = new TwitterAdapter();
  });

  it('uses x-web selectors only when <html data-app-version> is present', () => {
    expect(adapter.selectors.post).not.toContain('data-testid');
    document.documentElement.removeAttribute('data-app-version');
    expect(new TwitterAdapter().selectors.post).toBe('article[data-testid="tweet"]');
  });

  it('finds top-level posts but not quoted posts', () => {
    // happy-dom ignores complex selectors inside :not(), so it can't evaluate
    // the exclusion (Chrome/Safari/Firefox do — checked in Chrome 2026-11-27).
    // Assert the selector's shape and that every top-level post matches.
    expect(adapter.selectors.post).toBe('li article:not([data-slot="embedded-tweet-frame"] article)');
    const topLevel = Array.from(document.querySelectorAll('li article'))
      .filter(a => !a.parentElement?.closest('[data-slot="embedded-tweet-frame"]'));
    expect(topLevel.length).toBe(4);
    for (const article of topLevel) expect(posts(adapter)).toContain(article);
  });

  it('extracts author, handle, avatar, time, text and url', () => {
    const c = adapter.extractPostContent(posts(adapter)[0]);
    expect(c.author).toBe('NASA');
    expect(c.handle).toBe('@NASA');
    expect(c.avatarUrl).toContain('profile_images');
    expect(c.timeText).toBeTruthy();
    expect(c.text).toMatch(/^LIVE: Watch the Progress 97/);
    expect(c.postUrl).toBe('https://x.com/NASA/status/2125915027819446402');
    expect(c.quote).toBeNull();
  });

  it('collects post images', () => {
    const withImage = posts(adapter).find(a => adapter.getPostUrl(a)?.endsWith('/2125620534318702696'))!;
    const c = adapter.extractPostContent(withImage);
    expect(c.imageUrls.some(u => u.includes('HX-4nBaWQAAdImU'))).toBe(true);
    expect(c.hasMediaContainer).toBe(true);
  });

  it('separates the quoted post from the outer post', () => {
    const outer = posts(adapter).find(a => adapter.getPostUrl(a)?.endsWith('/2126110344120762593'))!;
    const c = adapter.extractPostContent(outer);
    expect(c.author).toBe('Elon Musk');
    expect(c.handle).toBe('@elonmusk');
    expect(c.text).toMatch(/^Vital that children have a stake in the future \[Quoted: Elon has announced/);
    expect(c.textHtml).toContain('Vital that children');
    expect(c.quote).toMatchObject({ author: 'Sawyer Merritt', handle: '@SawyerMerritt' });
    expect(c.quote?.textHtml).toContain('Elon has announced');
    expect(c.quote?.avatarUrl).toContain('profile_images');
    expect(c.imageUrls.length).toBeGreaterThan(0);
  });

  it('returns DOM content from the store path (x-web has no store)', async () => {
    const article = posts(adapter)[0];
    const c = await adapter.extractPostContentFromStore(article);
    expect(c?.handle).toBe('@NASA');
  });

  it('uses the <li> as the post container and hides it', () => {
    const article = posts(adapter)[0];
    const li = adapter.getPostContainer(article);
    expect(li.tagName).toBe('LI');
    adapter.hidePost(article);
    expect(li.dataset.filteredByExtension).toBe('true');
    expect((li.nextElementSibling as HTMLElement).dataset.filteredByExtension).toBeUndefined();
  });

  it('finds the share button and inserts the action button beside it', () => {
    const article = posts(adapter)[0];
    const share = adapter.getShareButton(article)!;
    expect(share.getAttribute('data-engagement-action')).toBe('share');
    const btn = document.createElement('button');
    adapter.insertActionButton(article, btn);
    expect(share.nextElementSibling?.contains(btn)).toBe(true);
  });

  it('is not a permalink view', () => {
    expect(adapter.isPermalinkView()).toBe(false);
    expect(adapter.isMainPost(posts(adapter)[0])).toBe(false);
  });

  it('locates layout landmarks', () => {
    expect(document.querySelector(adapter.selectors.primaryColumn)?.tagName).toBe('MAIN');
    expect(document.querySelector(adapter.selectors.sidebar)?.tagName).toBe('ASIDE');
    expect(adapter.selectors.sidebar).toBe('main ~ aside');
    expect(document.querySelector(adapter.selectors.sidebarContent)).not.toBeNull();
  });
});

describe('x-web permalink', () => {
  let adapter: PlatformAdapter;
  beforeEach(() => {
    setURL('https://x.com/NASA/status/2125641758432284978');
    load('x-web-permalink.html');
    adapter = new TwitterAdapter();
  });

  it('identifies the main post and its replies', () => {
    const [main, reply] = posts(adapter);
    expect(adapter.isPermalinkView()).toBe(true);
    expect(adapter.isMainPost(main)).toBe(true);
    expect(adapter.isMainPost(reply)).toBe(false);
  });

  it('extracts the unwrapped main post', () => {
    const c = adapter.extractPostContent(posts(adapter)[0]);
    expect(c.handle).toBe('@NASA');
    expect(c.postUrl).toBe('https://x.com/NASA/status/2125641758432284978');
    expect(c.text).toMatch(/^Medicine or engineering\?/);
    expect(c.hasVideo).toBe(true);
    expect(c.imageUrls.some(u => u.includes('HX_L6d4WoAAWOU-'))).toBe(true);
  });

  it('extracts the reply url from its timestamp link', () => {
    expect(adapter.getPostUrl(posts(adapter)[1])).toBe('https://x.com/gothblu_/status/2125642258255060995');
  });
});
