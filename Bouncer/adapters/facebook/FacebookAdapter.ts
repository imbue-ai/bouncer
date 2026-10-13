// facebook adaptation
//
// Facebook platform adapter for the desktop web feed (www.facebook.com).
//
// Facebook's class names are atomic CSS hashes that churn on every deploy, so
// everything here anchors on the few semantic hooks the Comet UI keeps stable
// (verified against the live feed, October 2026):
//
//   - The home feed is the sibling list that follows a visually-hidden
//     <h3>Feed posts</h3> inside [role="main"]. Each child of that list is a
//     virtualization slot holding a `[data-virtualized]` wrapper. Facebook
//     flips the wrapper to "true" and UNMOUNTS the post's contents when it
//     scrolls far off-screen, then mounts a fresh subtree when it comes back.
//     So the post element we hand the content script is the wrapper's child —
//     present only while mounted — and a remount simply surfaces as a new
//     post (the background's verdict cache makes re-evaluation free).
//   - Authored posts carry ad-rendering roles (Facebook reuses its ads markup
//     for organic posts): data-ad-rendering-role="profile_name" for the
//     author block and data-ad-preview="message" for the body text.
//   - The header's "…" menu is a button labelled "Actions for this post by
//     <Name>", next to an "X" link labelled "Hide post by <Name>". These
//     labels are the cleanest source of the author's name (the visible name
//     block also carries "Verified account", "· Follow", co-author suffixes).
//   - Comments rendered inline under a post are [role="article"]; everything
//     we extract skips those so a comment never leaks into the post text.
//
// Non-post feed units (People You May Know, Reels / Pages carousels) have no
// author header. extractPostContent returns empty content for them, which the
// content script records as "nothing to evaluate", and getShareButton returns
// null so no Bounce control is injected.
//
// Facebook obfuscates the timestamp and "Sponsored" label text (characters
// are shuffled in the DOM and re-ordered visually), so timeText is left null
// rather than surfacing garbage.

import type { PlatformAdapter, PlatformSelectors, PostContent, QuoteContent } from '../../src/types';
// NOTE: adapters are built with esbuild bundle:false (standalone IIFE per
// manifest content_scripts entry), so we CANNOT import shared/platforms
// here. Keep the hostname check inline. Must match the `facebook` entry in
// src/shared/platforms.ts (PLATFORM_RUNTIME.facebook.hostPattern).

/** Feed post: the mounted child of a virtualization wrapper in the list that
 *  follows the "Feed posts" heading. The `h3 ~ div` scope keeps out the one
 *  other `[data-virtualized]` region in [role="main"], above the feed. */
const POST_SELECTOR = '[role="main"] h3 ~ div [data-virtualized="false"] > div';

const ACTIONS_BUTTON_SELECTOR = '[aria-label^="Actions for this post by "]';
const HIDE_BUTTON_SELECTOR = '[aria-label^="Hide post by "]';
const MESSAGE_SELECTOR = '[data-ad-preview="message"]';
const PROFILE_NAME_SELECTOR = '[data-ad-rendering-role="profile_name"]';
const COMMENT_SELECTOR = '[role="article"]';

/** Paths that show Facebook's main News Feed. */
const FEED_PATHS = new Set(['/', '/home.php']);

/** Permalink-ish link patterns that identify a single post. */
const PERMALINK_RE = /\/(posts|videos|reel)\/|\/permalink\.php|story_fbid=|\/photo\/?\?fbid=|\/watch\/?\?v=/;

const BouncerFacebookAdapter = class FacebookAdapter implements PlatformAdapter {
  siteId = 'facebook' as const;

  selectors: PlatformSelectors = {
    post: POST_SELECTOR,
    // Right-hand rail ("Sponsored", "Friend requests", "Contacts"). It is a
    // sticky, viewport-tall box whose content scrolls inside an inner
    // overflow container; sidebarContent targets that scroller's content so
    // the filter box lands at the top of the rail's own scroll flow, where
    // facebook.css pins it with position: sticky.
    sidebar: '#right_rail_container, [role="complementary"]',
    sidebarContent: ':scope > div > div > div',
    // Main feed column.
    primaryColumn: '[role="main"]',
    // Top bar. Used only to anchor the narrow-window filter box.
    nav: '[role="banner"]',
    bottomBar: '',
    // Post body text — a re-render here inside a still-mounted post triggers
    // a content-key check (see getPostContentKey).
    mutations: MESSAGE_SELECTOR,
    textContent: MESSAGE_SELECTOR,
  };

  constructor() {
    this._initFilteredPostObserver();
  }

  // Fade filtered posts once scrolled fully above the viewport (posts hidden
  // while visible are display:none'd immediately in hidePost).
  private _initFilteredPostObserver() {
    const fadingOut = new Set<Element>();
    const scrollHandler = () => {
      const marked = document.querySelectorAll('[data-filtered-by-extension="true"]');
      for (const el of marked) {
        if (!(el instanceof HTMLElement)) continue;
        if (el.style.display === 'none' || fadingOut.has(el)) continue;
        const rect = el.getBoundingClientRect();
        if (rect.bottom < -50) {
          fadingOut.add(el);
          el.style.transition = 'opacity 0.3s ease';
          el.style.opacity = '0';
          setTimeout(() => {
            el.style.display = 'none';
            fadingOut.delete(el);
          }, 300);
        }
      }
    };
    window.addEventListener('scroll', scrollHandler, { passive: true });
  }

  // ===========================================================================
  // Extraction
  // ===========================================================================

  /** True for posts with an author header — excludes carousels and
   *  suggestion units, which share the feed list. */
  private _isAuthoredPost(article: HTMLElement): boolean {
    return article.querySelector(PROFILE_NAME_SELECTOR) !== null
      || article.querySelector(HIDE_BUTTON_SELECTOR) !== null;
  }

  /** querySelectorAll, minus matches inside inline comments. */
  private _queryOutsideComments<T extends Element>(article: HTMLElement, selector: string): T[] {
    return Array.from(article.querySelectorAll<T>(selector)).filter(el => {
      const comment = el.closest(COMMENT_SELECTOR);
      return comment === null || !article.contains(comment);
    });
  }

  private _cleanText(raw: string): string {
    return raw.replace(/\s+/g, ' ').trim();
  }

  /** Body text without Facebook's inline "See more" / "See less" toggles. */
  private _messageText(el: Element | null): string {
    if (!el) return '';
    const clone = el.cloneNode(true) as Element;
    clone.querySelectorAll('[role="button"], button').forEach(b => b.remove());
    return this._cleanText(clone.textContent ?? '');
  }

  /** innerHTML snapshot for the filtered-posts panel, minus interactive
   *  controls (the static snapshot has no JS, so they'd be dead anyway). */
  private _messageHtml(el: Element | null): string {
    if (!el) return '';
    const clone = el.cloneNode(true) as Element;
    clone.querySelectorAll('[role="button"], button').forEach(b => b.remove());
    return clone.innerHTML;
  }

  private _emptyContent(): PostContent {
    return {
      text: '',
      author: '',
      handle: '',
      avatarUrl: null,
      timeText: null,
      textHtml: '',
      quote: null,
      postUrl: null,
      imageUrls: [],
      hasMediaContainer: false,
    };
  }

  extractPostContent(article: HTMLElement): PostContent {
    if (!this._isAuthoredPost(article)) return this._emptyContent();

    const messages = this._queryOutsideComments<HTMLElement>(article, MESSAGE_SELECTOR);
    const mainMsg = messages[0] ?? null;
    const imageUrls = this._extractImageUrls(article);
    const hasVideo = article.querySelector('video') !== null;

    return {
      text: this._messageText(mainMsg),
      author: this._extractAuthor(article),
      handle: '',
      avatarUrl: this._extractAvatarUrl(article),
      timeText: null,
      textHtml: this._messageHtml(mainMsg),
      quote: this._extractQuote(messages),
      postUrl: this.getPostUrl(article),
      imageUrls,
      hasMediaContainer: imageUrls.length > 0 || hasVideo,
      hasVideo,
    };
  }

  /** "Hide post by Jane Doe" / "Actions for this post by Jane Doe" → "Jane
   *  Doe". Falls back to the header's profile link text. */
  private _extractAuthor(article: HTMLElement): string {
    for (const sel of [HIDE_BUTTON_SELECTOR, ACTIONS_BUTTON_SELECTOR]) {
      const label = article.querySelector(sel)?.getAttribute('aria-label') ?? '';
      const name = label.replace(/^.*?\bby\s+/i, '').trim();
      if (name) return name;
    }
    const nameLink = article.querySelector(`${PROFILE_NAME_SELECTOR} a, h4 a`);
    return this._cleanText(nameLink?.textContent ?? '');
  }

  /** Author avatar: the header renders it as an SVG <image> in a circular
   *  mask. The first one outside comments belongs to the author. */
  private _extractAvatarUrl(article: HTMLElement): string | null {
    const imgs = this._queryOutsideComments<SVGImageElement>(article, 'svg image');
    for (const img of imgs) {
      const href = img.getAttribute('xlink:href') || img.getAttribute('href') || '';
      if (href && !href.startsWith('data:')) return href;
    }
    return null;
  }

  /** A share ("X shared a post") renders the original post's body as a
   *  second message block. Its author isn't exposed by a stable hook, so
   *  only the text is carried. */
  private _extractQuote(messages: HTMLElement[]): QuoteContent | null {
    if (messages.length < 2) return null;
    const qMsg = messages[messages.length - 1];
    return {
      textHtml: this._messageHtml(qMsg),
      author: '',
      handle: '',
      avatarUrl: null,
      timeText: null,
    };
  }

  /** Post media: photos (fbcdn <img>, skipping emoji and tiny UI glyphs),
   *  link-preview images, and video poster frames. */
  private _extractImageUrls(article: HTMLElement): string[] {
    const urls: string[] = [];
    const add = (u: string) => {
      if (u && !u.startsWith('data:') && !urls.includes(u)) urls.push(u);
    };
    for (const img of this._queryOutsideComments<HTMLImageElement>(article, 'img')) {
      const src = img.currentSrc || img.src;
      if (!src || src.startsWith('data:')) continue;
      if (!/(^|\.)fbcdn\.net$/i.test(this._host(src))) continue;
      if (src.includes('/images/emoji.php')) continue;
      // Rendered size filters reaction glyphs and inline icons; photos are
      // hundreds of px. Fall back to intrinsic size before layout.
      const w = img.width || img.naturalWidth;
      const h = img.height || img.naturalHeight;
      if (w && h && (w < 64 || h < 64)) continue;
      add(src);
    }
    for (const v of this._queryOutsideComments<HTMLVideoElement>(article, 'video[poster]')) {
      add(v.poster || v.getAttribute('poster') || '');
    }
    return urls;
  }

  private _host(url: string): string {
    try {
      return new URL(url).hostname;
    } catch {
      return '';
    }
  }

  // ===========================================================================
  // Page / identity
  // ===========================================================================

  shouldProcessCurrentPage(): boolean {
    return FEED_PATHS.has(window.location.pathname);
  }

  // Comments are not feed posts here, so there's no reply view to gate.
  isPermalinkView(): boolean {
    return false;
  }

  isMainPost(): boolean {
    return false;
  }

  getPostUrl(article: HTMLElement): string | null {
    // Facebook writes the real permalink into the timestamp link only on
    // hover; before that it is a bare "/?__cft__…" placeholder. Take the
    // first link outside comments that already points at a post, photo, or
    // video, and drop the tracking query (keeping ids that live in it).
    const links = this._queryOutsideComments<HTMLAnchorElement>(article, 'a[href]');
    for (const a of links) {
      const href = a.href;
      if (!PERMALINK_RE.test(href)) continue;
      try {
        const u = new URL(href);
        const keep = new URLSearchParams();
        for (const k of ['story_fbid', 'id', 'fbid', 'v']) {
          const val = u.searchParams.get(k);
          if (val) keep.set(k, val);
        }
        const qs = keep.toString();
        return u.origin + u.pathname + (qs ? `?${qs}` : '');
      } catch {
        return href.split('?')[0];
      }
    }
    return null;
  }

  getPostContentKey(article: HTMLElement): string {
    // Posts unmount and remount rather than being recycled in place, so
    // author + the start of the body is a sufficient identity for detecting
    // an in-place re-render with different content.
    const author = this._extractAuthor(article);
    const msg = this._queryOutsideComments<HTMLElement>(article, MESSAGE_SELECTOR)[0];
    const body = this._messageText(msg ?? null).substring(0, 200);
    return this.getPostUrl(article) || `${author}|${body}`;
  }

  getPostContainer(article: HTMLElement): HTMLElement {
    // Hide the whole virtualization slot — the feed list's direct child — so
    // no card margin is left behind. The list is the element whose parent
    // also holds the "Feed posts" <h3>.
    let el: HTMLElement = article;
    for (let depth = 0; depth < 25 && el.parentElement; depth++) {
      const parent = el.parentElement;
      if (parent.parentElement?.querySelector(':scope > h3') && parent.tagName !== 'H3') {
        return el;
      }
      el = parent;
    }
    // Layout drift fallback: the virtualization wrapper's parent.
    return article.closest<HTMLElement>('[data-virtualized]')?.parentElement ?? article;
  }

  hidePost(article: HTMLElement): void {
    const element = this.getPostContainer(article);
    const rect = element.getBoundingClientRect();
    element.dataset.filteredByExtension = 'true';
    if (rect.bottom > 0) {
      element.style.display = 'none';
    }
    // If entirely above the viewport, the scroll handler fades it later so
    // the feed doesn't jump under the reader.
  }

  showPost(article: HTMLElement): void {
    const element = this.getPostContainer(article);
    delete element.dataset.filteredByExtension;
    element.style.display = '';
    element.style.visibility = '';
    element.style.opacity = '';
    element.style.transition = '';
    article.style.opacity = '';
    article.style.transition = '';
  }

  getThemeMode(): 'light' | 'dim' | 'dark' {
    // Facebook toggles __fb-dark-mode / __fb-light-mode on <html>. No dim.
    const html = document.documentElement;
    if (html.classList.contains('__fb-dark-mode')) return 'dark';
    if (html.classList.contains('__fb-light-mode')) return 'light';
    const bg = window.getComputedStyle(document.body).backgroundColor;
    const m = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (m) {
      const [, r, g, b] = m.map(Number);
      if (r + g + b < 384) return 'dark';
    }
    return 'light';
  }

  async extractPostContentFromStore(article: HTMLElement): Promise<PostContent | null> {
    // No client-side store hook; the DOM is the source of truth. Never return
    // null — the content script would retry and then give up on the post.
    return Promise.resolve(this.extractPostContent(article));
  }

  cleanupFilteredPostHtml(postContent: HTMLElement, imageUrls: string[]): void {
    postContent.style.display = '';
    postContent.style.opacity = '1';
    postContent.removeAttribute('data-filtered-by-extension');
    // blob: video sources don't survive outside the live feed.
    postContent.querySelectorAll('video').forEach(v => v.remove());
    if (imageUrls && imageUrls.length > 0) {
      const container = document.createElement('div');
      container.className = 'slop-media-container';
      imageUrls.forEach(url => {
        const img = document.createElement('img');
        img.src = url;
        img.className = 'slop-media-image';
        img.loading = 'lazy';
        container.appendChild(img);
      });
      postContent.appendChild(container);
    }
  }

  // ===========================================================================
  // Bounce control
  // ===========================================================================

  /** Climb from a header control to its slot in the header row: the chain
   *  above each control is single-child wrappers up to the row itself. */
  private _headerCell(control: HTMLElement): HTMLElement {
    let el = control;
    while (el.parentElement && el.parentElement.children.length === 1) {
      el = el.parentElement;
    }
    return el;
  }

  getShareButton(article: HTMLElement): HTMLElement | null {
    // Anchor on the header's "…" menu. Only authored posts have the
    // "…by <Name>" variant, so carousels never get a Bounce control.
    return article.querySelector<HTMLElement>(ACTIONS_BUTTON_SELECTOR);
  }

  insertActionButton(article: HTMLElement, button: HTMLElement): void {
    const actions = this.getShareButton(article);
    if (!actions) {
      article.appendChild(button);
      return;
    }
    const actionsCell = this._headerCell(actions);
    button.classList.add('ff-why-annoying-btn--facebook-header');
    // Our control takes the place of Facebook's "X" (Hide post), matching
    // its box so the header row keeps its rhythm.
    const hide = article.querySelector<HTMLElement>(HIDE_BUTTON_SELECTOR);
    const ref = hide ? this._headerCell(hide) : actionsCell;
    const rect = ref.getBoundingClientRect();
    if (rect.width && rect.height) {
      button.style.width = `${rect.width}px`;
      button.style.height = `${rect.height}px`;
    }
    if (hide) this._headerCell(hide).style.display = 'none';
    actionsCell.insertAdjacentElement('afterend', button);
  }

  getSearchForm(): HTMLElement | null {
    return document.querySelector<HTMLElement>('input[type="search"]')
      ?? document.querySelector<HTMLElement>('[role="search"]');
  }
};

// Self-guard by hostname. On iOS all platform adapter scripts inject on every
// page; without this guard Facebook would clobber other adapters.
// Regex mirrors src/shared/platforms.ts PLATFORM_RUNTIME.facebook.hostPattern.
if (/(^|\.)facebook\.com$/i.test(location.hostname)) {
  window.BouncerAdapter = BouncerFacebookAdapter;
}
