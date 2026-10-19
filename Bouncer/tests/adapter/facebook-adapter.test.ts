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
    // The video's first frame (poster) comes first.
    expect(c.imageUrls).toEqual([
      'https://scontent.xx.fbcdn.net/v/poster.jpg',
      'https://scontent.xx.fbcdn.net/v/photo.jpg',
    ]);
    expect(c.hasVideo).toBe(true);
    expect(c.hasMediaContainer).toBe(true);
  });

  it('waits briefly for a lazily-mounted video poster before extracting', async () => {
    const [post] = mountFeed([postHtml({ name: 'Jane Doe', message: 'clip', extra: '<video></video>' })]);
    setTimeout(() => {
      post.querySelector('video')!.setAttribute('poster', 'https://scontent.xx.fbcdn.net/v/late.jpg');
    }, 200);
    const c = await adapter.extractPostContentFromStore(post);
    expect(c!.imageUrls).toEqual(['https://scontent.xx.fbcdn.net/v/late.jpg']);
  });

  it('changes the content key when a video frame appears, so the post is re-evaluated', () => {
    const [post] = mountFeed([postHtml({ name: 'Jane Doe', message: 'clip' })]);
    const before = adapter.getPostContentKey(post);
    const v = document.createElement('video');
    v.setAttribute('poster', 'https://scontent.xx.fbcdn.net/v/frame.jpg');
    post.appendChild(v);
    expect(adapter.getPostContentKey(post)).not.toBe(before);
    expect(v.matches(adapter.selectors.mutations)).toBe(true);
  });

  it('ignores posters off the photo CDN (the backend would reject them)', () => {
    const extra = '<video poster="https://static.xx.fbcdn.net/rsrc.php/placeholder.png"></video>';
    const [post] = mountFeed([postHtml({ name: 'Jane Doe', message: 'clip', extra })]);
    expect(adapter.extractPostContent(post).imageUrls).toEqual([]);
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

// Skeleton of the m.facebook.com html-renderer feed (iPhone UA, October 2026):
// units are direct children of the vscroller carrying a tracking id; each
// authored post is header / body / reaction-footer blocks. Text runs embed
// private-use-area icon glyphs and LTR marks.
function mobileUnit(opts: { id: number; header: string; body: string }): string {
  return `
<div data-mcomponent="MContainer" data-type="container" data-tracking-duration-id="${opts.id}" class="m displayed">
  <div data-mcomponent="MContainer" class="header">${opts.header}</div>
  <div data-mcomponent="MContainer">${opts.body}</div>
  <div data-mcomponent="MContainer">
    <div aria-label="Rob Bryant and 6 others reacted. Tap to see comments and reactions">
      <div data-mcomponent="TextArea" data-type="text">Rob Bryant and 6 others</div>
    </div>
    <div aria-label="7like, double tap and hold for more reactions">
      <img src="https://static.xx.fbcdn.net/rsrc.php/like.webp" width="16" height="16">
    </div>
  </div>
</div>`;
}

function mobileHeader(opts: { pic?: string; more: string; time?: string }): string {
  return `
<div data-mcomponent="MContainer" class="row">
  ${opts.pic ? `<div data-mcomponent="MContainer" aria-label="${opts.pic} Profile Picture"><img src="https://scontent.xx.fbcdn.net/v/avatar.jpg" width="48" height="48"></div>` : ''}
  <div data-mcomponent="MContainer">
    <div data-mcomponent="TextArea" data-type="text">Name</div>
    <div data-mcomponent="TextArea" data-type="text" aria-label="${opts.time ?? '6 hours ago, Public'}">\u200E6h\u200E\u{F212D}</div>
  </div>
  <div data-mcomponent="MContainer" aria-label="More options for ${opts.more}"><div data-mcomponent="TextArea" data-type="text">\u{F0123}</div></div>
</div>`;
}

const SUGGESTED_GROUPS = `
<div data-mcomponent="MContainer" data-type="container" data-tracking-duration-id="9" class="m displayed">
  <div data-mcomponent="TextArea" data-type="text">Suggested for you</div>
  <img src="https://scontent.xx.fbcdn.net/v/group.jpg" width="200" height="200">
</div>`;

function mountMobileFeed(units: string[]): HTMLElement[] {
  document.body.replaceChildren();
  const screen = document.createElement('div');
  screen.dataset.mcomponent = 'MScreen';
  const scroller = document.createElement('div');
  scroller.dataset.type = 'vscroller';
  scroller.className = 'mobile-feed';
  for (const u of units) {
    const tpl = document.createElement('template');
    tpl.innerHTML = u.trim();
    scroller.appendChild(tpl.content.firstElementChild!);
  }
  screen.appendChild(scroller);
  document.body.appendChild(screen);
  return Array.from(document.querySelectorAll<HTMLElement>('[data-type="vscroller"] > [data-tracking-duration-id]'));
}

describe('Facebook mobile-web (m.facebook.com) adapter', () => {
  let adapter: PlatformAdapter;
  beforeEach(() => {
    (window as unknown as { happyDOM: { setURL(url: string): void } })
      .happyDOM.setURL('https://m.facebook.com/');
    adapter = new FacebookAdapter();
  });

  const body = `
    <div data-mcomponent="MContainer"><div data-mcomponent="TextArea" data-type="text">Outside my work.\u{F0001}</div></div>
    <div data-mcomponent="ImageArea" aria-label="No photo description available"><img src="https://scontent.xx.fbcdn.net/v/photo.jpg" width="440" height="586"></div>`;

  it('matches feed units through the post selector', () => {
    const units = mountMobileFeed([
      mobileUnit({ id: 1, header: mobileHeader({ pic: 'Kerry Bubb', more: 'Kerry Bubb' }), body }),
      SUGGESTED_GROUPS,
    ]);
    expect(units).toHaveLength(2);
    expect(units.every(u => u.matches(adapter.selectors.post))).toBe(true);
  });

  it('uses the poster of an autoplaying video (its thumbnail img is gone)', () => {
    const videoBody = `
      <div data-mcomponent="MContainer"><div data-mcomponent="TextArea" data-type="text">Cable car ride</div></div>
      <div data-mcomponent="MVideo"><video poster="https://scontent.xx.fbcdn.net/v/t15.5256-10/frame.jpg"></video></div>`;
    const [post] = mountMobileFeed([
      mobileUnit({ id: 1, header: mobileHeader({ pic: 'DJ', more: 'DJ' }), body: videoBody }),
    ]);
    const c = adapter.extractPostContent(post);
    expect(c.imageUrls).toEqual(['https://scontent.xx.fbcdn.net/v/t15.5256-10/frame.jpg']);
    expect(c.hasVideo).toBe(true);
  });

  it('extracts author, time, body text (glyphs stripped), photo, and avatar', () => {
    const [post] = mountMobileFeed([
      mobileUnit({ id: 1, header: mobileHeader({ pic: 'Kerry Bubb', more: 'Kerry Bubb' }), body }),
    ]);
    const c = adapter.extractPostContent(post);
    expect(c.author).toBe('Kerry Bubb');
    expect(c.timeText).toBe('6 hours ago');
    expect(c.text).toBe('Outside my work.');
    expect(c.textHtml).toBe('<p>Outside my work.</p>');
    expect(c.imageUrls).toEqual(['https://scontent.xx.fbcdn.net/v/photo.jpg']);
    expect(c.avatarUrl).toBe('https://scontent.xx.fbcdn.net/v/avatar.jpg');
  });

  it('never reads the reaction footer as body text', () => {
    const [post] = mountMobileFeed([
      mobileUnit({ id: 1, header: mobileHeader({ pic: 'Kerry Bubb', more: 'Kerry Bubb' }), body }),
    ]);
    expect(adapter.extractPostContent(post).text).not.toContain('Rob Bryant');
  });

  it('cuts an activity sentence off the More options label when there is no profile picture', () => {
    const [post] = mountMobileFeed([
      mobileUnit({ id: 1, header: mobileHeader({ more: 'Rob Bryant is at The CORE.' }), body }),
    ]);
    expect(adapter.extractPostContent(post).author).toBe('Rob Bryant');
  });

  it('keeps a page name that merely contains a connector word', () => {
    const [post] = mountMobileFeed([
      mobileUnit({ id: 1, header: mobileHeader({ more: 'Friends in Need' }), body }),
    ]);
    expect(adapter.extractPostContent(post).author).toBe('Friends in Need');
  });

  it('finds the "ago" segment in a group-post time label', () => {
    const [post] = mountMobileFeed([
      mobileUnit({ id: 1, header: mobileHeader({ pic: 'Monica Walden', more: 'Monica Walden', time: 'Monica Walden, 2 days ago, Public group' }), body }),
    ]);
    expect(adapter.extractPostContent(post).timeText).toBe('2 days ago');
  });

  it('strips the See more expander from the end of the body', () => {
    const seeMore = '<div data-mcomponent="TextArea" data-type="text">The study was ISIS-2... See more</div>';
    const [post] = mountMobileFeed([
      mobileUnit({ id: 1, header: mobileHeader({ pic: 'X', more: 'X' }), body: seeMore }),
    ]);
    expect(adapter.extractPostContent(post).text).toBe('The study was ISIS-2');
  });

  it('skips suggestion units', () => {
    const [, groups] = mountMobileFeed([
      mobileUnit({ id: 1, header: mobileHeader({ pic: 'Kerry Bubb', more: 'Kerry Bubb' }), body }),
      SUGGESTED_GROUPS,
    ]);
    const c = adapter.extractPostContent(groups);
    expect(c.text).toBe('');
    expect(c.imageUrls).toEqual([]);
    expect(adapter.getShareButton(groups)).toBeNull();
  });

  it('hides the unit itself, with an attribute that survives inline-style rewrites', () => {
    const [post] = mountMobileFeed([
      mobileUnit({ id: 1, header: mobileHeader({ pic: 'K', more: 'K' }), body }),
    ]);
    expect(adapter.getPostContainer(post)).toBe(post);
    // happy-dom reports zero-size rects; force the "visible" branch.
    post.getBoundingClientRect = () => ({ bottom: 100 } as DOMRect);
    adapter.hidePost(post);
    expect(post.hasAttribute('data-ff-fb-hidden')).toBe(true);
    adapter.showPost!(post);
    expect(post.hasAttribute('data-ff-fb-hidden')).toBe(false);
    expect(post.style.display).toBe('');
  });

  // The renderer rebuilds runs of units as fresh elements with new tracking
  // ids (observed live, October 2026), filtered ones included.
  function rebuild(old: HTMLElement, id: number, header: string): HTMLElement {
    const tpl = document.createElement('template');
    tpl.innerHTML = mobileUnit({ id, header, body }).trim();
    const fresh = tpl.content.firstElementChild as HTMLElement;
    old.replaceWith(fresh);
    return fresh;
  }

  it('keeps a filtered post hidden when the renderer rebuilds it', async () => {
    const header = mobileHeader({ pic: 'K', more: 'K' });
    const [post, other] = mountMobileFeed([
      mobileUnit({ id: 1, header, body }),
      mobileUnit({ id: 2, header: mobileHeader({ pic: 'J', more: 'J' }), body }),
    ]);
    post.getBoundingClientRect = () => ({ bottom: 100 } as DOMRect);
    adapter.hidePost(post);
    const fresh = rebuild(post, 40, header);
    const freshOther = rebuild(other, 41, mobileHeader({ pic: 'J', more: 'J' }));
    await Promise.resolve();
    expect(fresh.hasAttribute('data-ff-fb-hidden')).toBe(true);
    expect(fresh.dataset.filteredByExtension).toBe('true');
    expect(freshOther.dataset.filteredByExtension).toBeUndefined();
  });

  it('carries a marked-only (above viewport) post across a rebuild without hiding it', async () => {
    // Distinct author per test: adapters from earlier tests keep observing.
    const header = mobileHeader({ pic: 'M', more: 'M' });
    const [post] = mountMobileFeed([mobileUnit({ id: 1, header, body })]);
    post.getBoundingClientRect = () => ({ top: -700, bottom: -10, width: 400, height: 690 } as DOMRect);
    adapter.hidePost(post);
    const fresh = rebuild(post, 40, header);
    await Promise.resolve();
    expect(fresh.dataset.filteredByExtension).toBe('true');
    expect(fresh.hasAttribute('data-ff-fb-hidden')).toBe(false);
  });

  it("records a hidden unit as collapsed and zero-height for the renderer, and restores it", async () => {
    const [post] = mountMobileFeed([
      mobileUnit({ id: 1, header: mobileHeader({ pic: 'E', more: 'E' }), body }),
    ]);
    post.setAttribute('data-actual-height', '694');
    post.style.height = '694px';
    post.getBoundingClientRect = () => ({ bottom: 100, width: 400, height: 600 } as DOMRect);
    adapter.hidePost(post);
    expect(post.classList.contains('displayed')).toBe(false);
    expect(post.getAttribute('data-actual-height')).toBe('0');
    expect(post.style.height).toBe('0px');
    // The renderer rewrites its record as the unit nears the viewport.
    post.classList.add('displayed');
    post.setAttribute('data-actual-height', '694');
    await Promise.resolve();
    expect(post.classList.contains('displayed')).toBe(false);
    expect(post.getAttribute('data-actual-height')).toBe('0');
    // Content-script restore: clears the marker and inline display only.
    delete post.dataset.filteredByExtension;
    post.style.display = '';
    await Promise.resolve();
    expect(post.classList.contains('displayed')).toBe(true);
    expect(post.getAttribute('data-actual-height')).toBe('694');
    expect(post.style.height).toBe('694px');
  });

  it('hides a post the renderer has collapsed, wherever it is', () => {
    const [post] = mountMobileFeed([
      mobileUnit({ id: 1, header: mobileHeader({ pic: 'C', more: 'C' }), body }),
    ]);
    // Collapsed by the renderer (display:none until the reader is close):
    // an all-zero rect, which reads as "above the viewport".
    post.getBoundingClientRect = () => ({ top: 0, bottom: 0, width: 0, height: 0 } as DOMRect);
    adapter.hidePost(post);
    expect(post.hasAttribute('data-ff-fb-hidden')).toBe(true);
  });

  it('hides a marked post once the renderer collapses it', () => {
    const [post] = mountMobileFeed([
      mobileUnit({ id: 1, header: mobileHeader({ pic: 'D', more: 'D' }), body }),
    ]);
    post.getBoundingClientRect = () => ({ top: -700, bottom: -10, width: 400, height: 690 } as DOMRect);
    adapter.hidePost(post);
    expect(post.hasAttribute('data-ff-fb-hidden')).toBe(false);
    post.getBoundingClientRect = () => ({ top: 0, bottom: 0, width: 0, height: 0 } as DOMRect);
    document.dispatchEvent(new Event('scroll'));
    expect(post.hasAttribute('data-ff-fb-hidden')).toBe(true);
  });

  it('re-hides a filtered post the renderer re-mounts long after dropping it', async () => {
    const header = mobileHeader({ pic: 'L', more: 'L' });
    const [post] = mountMobileFeed([mobileUnit({ id: 1, header, body })]);
    post.getBoundingClientRect = () => ({ bottom: 100 } as DOMRect);
    adapter.hidePost(post);
    const scroller = post.parentElement!;
    post.remove();
    await Promise.resolve();
    await new Promise(r => setTimeout(r, 10));
    const tpl = document.createElement('template');
    tpl.innerHTML = mobileUnit({ id: 70, header, body }).trim();
    const fresh = tpl.content.firstElementChild as HTMLElement;
    scroller.prepend(fresh);
    await Promise.resolve();
    expect(fresh.hasAttribute('data-ff-fb-hidden')).toBe(true);
  });

  it('does not re-hide a restored post when the renderer rebuilds it', async () => {
    // Distinct author: earlier tests' filtered units are torn down by the
    // next mount, which the guard sees as removals.
    const header = mobileHeader({ pic: 'R', more: 'R' });
    const [post] = mountMobileFeed([mobileUnit({ id: 1, header, body })]);
    post.getBoundingClientRect = () => ({ bottom: 100 } as DOMRect);
    adapter.hidePost(post);
    // The content script's restore path clears the marker and inline display.
    delete post.dataset.filteredByExtension;
    post.style.display = '';
    const fresh = rebuild(post, 40, header);
    await Promise.resolve();
    expect(fresh.dataset.filteredByExtension).toBeUndefined();
    expect(fresh.hasAttribute('data-ff-fb-hidden')).toBe(false);
  });

  it('adds the Bounce control to the header row without entering its flow', () => {
    const [post] = mountMobileFeed([
      mobileUnit({ id: 1, header: mobileHeader({ pic: 'K', more: 'K' }), body }),
    ]);
    const btn = document.createElement('div');
    adapter.insertActionButton(post, btn);
    const row = post.querySelector('.row')!;
    expect(btn.parentElement).toBe(row);
    expect(btn.classList.contains('ff-why-annoying-btn--facebook-mobile')).toBe(true);
    // The "…" button stays where it was relative to its siblings.
    expect(row.querySelector('[aria-label^="More options for"]')!.nextElementSibling).toBe(btn);
  });

  // happy-dom has no layout: give the "…" button and our button the live
  // header's boxes ("…" at x=408, y=4, 28x33; button 32x32).
  function layOutHeader(post: HTMLElement): HTMLElement {
    const more = post.querySelector<HTMLElement>('[aria-label^="More options for"]')!;
    Object.defineProperties(more, {
      offsetLeft: { value: 408 }, offsetTop: { value: 4 },
      offsetWidth: { value: 28 }, offsetHeight: { value: 33 },
    });
    const btn = document.createElement('div');
    Object.defineProperty(btn, 'offsetWidth', { value: 32 });
    return btn;
  }

  it('sits just left of the … button, level with it', () => {
    const [post] = mountMobileFeed([
      mobileUnit({ id: 1, header: mobileHeader({ pic: 'K', more: 'K' }), body }),
    ]);
    const btn = layOutHeader(post);
    adapter.insertActionButton(post, btn);
    expect(btn.style.left).toBe('372px');   // 408 - 32 - 4
    expect(btn.style.top).toBe('4.5px');    // 4 + (33 - 32) / 2
  });

  it('goes below the … button when the name line reaches into that spot', () => {
    const [post] = mountMobileFeed([
      mobileUnit({ id: 1, header: mobileHeader({ pic: 'K', more: 'K' }), body }),
    ]);
    const btn = layOutHeader(post);
    // The name runs up to x=380 on the first line.
    const name = post.querySelector<HTMLElement>('.row [data-mcomponent="TextArea"]')!;
    name.getBoundingClientRect = () => ({ left: 63, top: 6, width: 317, height: 21 } as DOMRect);
    adapter.insertActionButton(post, btn);
    expect(btn.style.left).toBe('406px');   // 408 + (28 - 32) / 2
    expect(btn.style.top).toBe('37px');     // 4 + 33
  });

  it('opts the button back into pointer events the renderer turns off', () => {
    const [post] = mountMobileFeed([
      mobileUnit({ id: 1, header: mobileHeader({ pic: 'K', more: 'K' }), body }),
    ]);
    const btn = document.createElement('div');
    adapter.insertActionButton(post, btn);
    expect(btn.style.pointerEvents).toBe('auto');
  });

  it('keeps taps on the Bounce control from Facebook and activates it instead', () => {
    const [post] = mountMobileFeed([
      mobileUnit({ id: 1, header: mobileHeader({ pic: 'K', more: 'K' }), body }),
    ]);
    const btn = document.createElement('div');
    btn.className = 'ff-why-annoying-btn';
    adapter.insertActionButton(post, btn);

    // Stand-ins for Facebook's tap router: a capture listener on document
    // (runs before anything on the button) and a bubble listener on the post.
    const seenByPage: string[] = [];
    const docCapture = (e: Event) => { seenByPage.push(`doc:${e.type}`); };
    document.addEventListener('click', docCapture, true);
    document.addEventListener('touchend', docCapture, true);
    post.addEventListener('click', e => { seenByPage.push(`post:${e.type}`); });
    let activated = 0;
    btn.addEventListener('ff-bounce-activate', () => { activated++; });

    btn.dispatchEvent(new Event('touchend', { bubbles: true }));
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    btn.dispatchEvent(click);

    expect(seenByPage).toEqual([]);
    expect(activated).toBe(1);
    expect(click.defaultPrevented).toBe(true);
    document.removeEventListener('click', docCapture, true);
    document.removeEventListener('touchend', docCapture, true);
  });

  it('leaves taps elsewhere in the post alone', () => {
    const [post] = mountMobileFeed([
      mobileUnit({ id: 1, header: mobileHeader({ pic: 'K', more: 'K' }), body }),
    ]);
    adapter.insertActionButton(post, document.createElement('div'));
    let seen = 0;
    const docCapture = () => { seen++; };
    document.addEventListener('click', docCapture, true);
    post.querySelector('[data-mcomponent="TextArea"]')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(seen).toBe(1);
    document.removeEventListener('click', docCapture, true);
  });
});
