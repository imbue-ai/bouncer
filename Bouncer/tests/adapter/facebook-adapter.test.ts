/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { PlatformAdapter } from '../../src/types';

let FacebookAdapter: new () => PlatformAdapter;

beforeEach(async () => {
  // The adapter only claims `window.BouncerAdapter` on a facebook.com host.
  (window as unknown as { happyDOM: { setURL(url: string): void } })
    .happyDOM.setURL('https://www.facebook.com/');
  await import('../../adapters/facebook/FacebookAdapter.js');
  FacebookAdapter = window.BouncerAdapter;
});

// Skeleton of the live desktop feed (October 2026), atomic class names
// dropped. Each feed-list child is a virtualization slot; the post content is
// the child of the [data-virtualized] wrapper. The header row holds the
// avatar, the name block, the "…" menu, and the "X" (Hide post) link, each
// behind single-child wrapper divs.
function postHtml(opts: { name: string; message?: string; shared?: string; extra?: string }): string {
  const { name, message = '', shared, extra = '' } = opts;
  return `
<div><div><div data-virtualized="false"><div class="post">
  <div class="header-row">
    <div><div><svg><mask></mask><g><image xlink:href="https://scontent.xx.fbcdn.net/v/avatar.jpg"></image></g></svg></div></div>
    <div><div data-ad-rendering-role="profile_name"><h4><a href="https://www.facebook.com/jane"><b><span>${name}</span></b></a></h4></div></div>
    <div><div><div role="button" aria-label="Actions for this post by ${name}"></div></div></div>
    <div><div><a href="#" role="link" aria-label="Hide post by ${name}"></a></div></div>
  </div>
  <div data-ad-rendering-role="story_message"><div data-ad-preview="message">${message}<div role="button">See more</div></div></div>
  ${shared ? `<div><div data-ad-preview="message">${shared}</div></div>` : ''}
  ${extra}
  <div role="article"><div data-ad-preview="message">a comment</div><img src="https://scontent.xx.fbcdn.net/v/comment.jpg" width="300" height="300"></div>
</div></div></div></div>`;
}

const CAROUSEL = `
<div><div><div data-virtualized="false"><div class="carousel">
  <div role="button" aria-label="Actions for this post"></div>
  <img src="https://scontent.xx.fbcdn.net/v/pymk.jpg" width="192" height="192">
</div></div></div></div>`;

function mountFeed(slots: string[]): HTMLElement[] {
  document.body.replaceChildren();
  const main = document.createElement('div');
  main.setAttribute('role', 'main');
  const section = document.createElement('div');
  const h3 = document.createElement('h3');
  h3.textContent = 'Feed posts';
  const hidden = document.createElement('div');
  hidden.setAttribute('aria-hidden', 'true');
  const list = document.createElement('div');
  list.className = 'feed-list';
  for (const slot of slots) {
    const tpl = document.createElement('template');
    tpl.innerHTML = slot.trim();  // test fixture only — never in product code
    list.appendChild(tpl.content.firstElementChild!);
  }
  section.append(h3, hidden, list);
  main.appendChild(section);
  document.body.appendChild(main);
  return Array.from(document.querySelectorAll<HTMLElement>('[role="main"] h3 ~ div [data-virtualized="false"] > div'));
}

describe('Facebook feed adapter', () => {
  let adapter: PlatformAdapter;
  beforeEach(() => {
    adapter = new FacebookAdapter();
  });

  it('matches feed posts through the post selector', () => {
    const posts = mountFeed([postHtml({ name: 'Jane Doe', message: 'hi' }), CAROUSEL]);
    expect(posts).toHaveLength(2);
    expect(posts.every(p => p.matches(adapter.selectors.post))).toBe(true);
  });

  it('extracts author from the Hide post label, and text without See more', () => {
    const [post] = mountFeed([postHtml({ name: 'Jane Doe', message: 'Outside my work.' })]);
    const c = adapter.extractPostContent(post);
    expect(c.author).toBe('Jane Doe');
    expect(c.text).toBe('Outside my work.');
    expect(c.textHtml).not.toContain('See more');
    expect(c.handle).toBe('');
    expect(c.avatarUrl).toBe('https://scontent.xx.fbcdn.net/v/avatar.jpg');
  });

  it('ignores inline comments when extracting text and images', () => {
    const [post] = mountFeed([postHtml({ name: 'Jane Doe', message: 'body' })]);
    const c = adapter.extractPostContent(post);
    expect(c.text).toBe('body');
    expect(c.imageUrls).toEqual([]);
    expect(c.quote).toBeNull();
  });

  it('collects photos and video posters, skipping emoji and small glyphs', () => {
    const extra = `
      <img src="https://scontent.xx.fbcdn.net/v/photo.jpg" width="500" height="400">
      <img src="https://static.xx.fbcdn.net/images/emoji.php/v9/x.png" width="16" height="16">
      <img src="https://scontent.xx.fbcdn.net/v/glyph.png" width="18" height="18">
      <img src="https://example.com/tracker.png" width="500" height="400">
      <video poster="https://scontent.xx.fbcdn.net/v/poster.jpg"></video>`;
    const [post] = mountFeed([postHtml({ name: 'Jane Doe', message: 'pics', extra })]);
    const c = adapter.extractPostContent(post);
    expect(c.imageUrls).toEqual([
      'https://scontent.xx.fbcdn.net/v/photo.jpg',
      'https://scontent.xx.fbcdn.net/v/poster.jpg',
    ]);
    expect(c.hasVideo).toBe(true);
    expect(c.hasMediaContainer).toBe(true);
  });

  it('carries a shared post body as the quote', () => {
    const [post] = mountFeed([postHtml({ name: 'Jane Doe', message: 'look', shared: 'original text' })]);
    expect(adapter.extractPostContent(post).quote?.textHtml).toBe('original text');
  });

  it('returns empty content and no Bounce anchor for carousels', () => {
    const [, carousel] = mountFeed([postHtml({ name: 'Jane Doe', message: 'hi' }), CAROUSEL]);
    const c = adapter.extractPostContent(carousel);
    expect(c.text).toBe('');
    expect(c.imageUrls).toEqual([]);
    expect(adapter.getShareButton(carousel)).toBeNull();
  });

  it('hides the whole feed slot, not just the post', () => {
    const [post] = mountFeed([postHtml({ name: 'Jane Doe', message: 'hi' })]);
    const slot = document.querySelector<HTMLElement>('.feed-list')!.firstElementChild as HTMLElement;
    expect(adapter.getPostContainer(post)).toBe(slot);
  });

  it('stops at the slot even when the feed list holds a single post', () => {
    const [post] = mountFeed([postHtml({ name: 'Jane Doe', message: 'hi' })]);
    const container = adapter.getPostContainer(post);
    expect(container.classList.contains('feed-list')).toBe(false);
    expect(container.parentElement?.classList.contains('feed-list')).toBe(true);
  });

  it('puts the Bounce control after the … menu and hides the native X', () => {
    const [post] = mountFeed([postHtml({ name: 'Jane Doe', message: 'hi' })]);
    const btn = document.createElement('div');
    adapter.insertActionButton(post, btn);
    const row = post.querySelector('.header-row')!;
    const cells = Array.from(row.children);
    expect(cells.indexOf(btn)).toBe(3);
    const hideCell = cells[4] as HTMLElement;
    expect(hideCell.querySelector('[aria-label^="Hide post by"]')).not.toBeNull();
    expect(hideCell.style.display).toBe('none');
  });

  it('only processes the home feed', () => {
    expect(adapter.shouldProcessCurrentPage()).toBe(true);
    (window as unknown as { happyDOM: { setURL(url: string): void } })
      .happyDOM.setURL('https://www.facebook.com/groups/feed/');
    expect(adapter.shouldProcessCurrentPage()).toBe(false);
  });

  it('reads the theme from the html class', () => {
    document.documentElement.className = '__fb-dark-mode';
    expect(adapter.getThemeMode()).toBe('dark');
    document.documentElement.className = '__fb-light-mode';
    expect(adapter.getThemeMode()).toBe('light');
  });
});
