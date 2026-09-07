// linkedin adaptation
//
// LinkedIn platform adapter supporting BOTH of LinkedIn's feed layouts:
//
//   1. Desktop web (the SDUI / server-driven UI served to the Chrome extension
//      on www.linkedin.com). Class names are hashed/obfuscated, so we rely on
//      stable semantic hooks: role, aria-label, data-testid, componentkey.
//      Posts are `div[role="listitem"]` cards keyed by a componentkey
//      containing "FeedType". LinkedIn has shipped two shapes of this: an
//      older one where the listitem itself carries the componentkey, and the
//      current one where the componentkey sits on a wrapper div whose direct
//      child is the listitem (the wrapper also holds a sibling
//      "replaceableCommentTools" div). We match both.
//
//   2. Mobile web (the variant served inside the iOS WKWebView and to mobile
//      browsers). Built from stable BEM-ish hooks — main-feed-activity-card,
//      base-main-feed-card__entity-lockup, attributed-text-segment-list,
//      social-action-bar — plus data-* attributes (data-id, data-activity-urn).
//      Posts are `article[data-id="main-feed-card"]`.
//
// The same compiled dist/LinkedInAdapter.js is loaded by the desktop Chrome
// extension (manifest content-script block) AND injected into the iOS app's
// WKWebView, so the adapter must handle whichever DOM it finds. The two layouts
// have disjoint, unambiguous post selectors, so we use a union selector to find
// posts and dispatch per-post on `_isMobilePost(article)`.
//
// This file is fully additive — it does not touch the Twitter adapter.

import type { PlatformAdapter, PlatformSelectors, PostContent, QuoteContent } from '../../src/types';
// NOTE: adapters are built with esbuild bundle:false (standalone IIFE per
// manifest content_scripts entry), so we CANNOT import shared/platforms
// here — esbuild would leave `require(...)` calls that fail in the browser.
// Keep the hostname check inline. Must match the `linkedin` entry in
// src/shared/platforms.ts (PLATFORM_RUNTIME.linkedin.hostPattern).

const BouncerLinkedInAdapter = class LinkedInAdapter implements PlatformAdapter {
  siteId = 'linkedin' as const;

  // linkedin adaptation: union selectors covering both the desktop SDUI and the
  // mobile-web feed. Each side's selector is disjoint, so on a given page only
  // one variant ever matches.
  selectors: PlatformSelectors = {
    // Desktop: the listitem card, whether the FeedType componentkey is on the
    // listitem itself (older SDUI) or on its wrapper div (current SDUI).
    // Mobile: <article data-id="main-feed-card">.
    post: 'article[data-id="main-feed-card"], div[role="listitem"][componentkey*="FeedType"], div[componentkey*="FeedType"] > div[role="listitem"]',
    // Desktop right-hand aside rail. Mobile web has none (querySelector simply
    // returns null there — strictly safer than an empty selector, which throws).
    sidebar: 'aside[aria-label="Aside"]',
    sidebarContent: '',
    // Main feed column (desktop SDUI / mobile).
    primaryColumn: 'section[aria-label="Primary content"], section.feeds',
    // Top navigation bar.
    nav: 'header',
    // Neither layout has a Twitter-style mobile BottomBar.
    bottomBar: '',
    // DOM-recycling detection: elements whose re-render inside an existing
    // post should trigger a re-eval. Must sit INSIDE a post (the content
    // script walks closest(post) from each match), so this targets the post
    // body text on both layouts.
    mutations: '[data-testid="expandable-text-box"], .attributed-text-segment-list__content',
    // Post body text.
    textContent: '[data-testid="expandable-text-box"], .attributed-text-segment-list__content',
  };

  constructor() {
    // linkedin adaptation: fade filtered posts once scrolled fully above viewport.
    this._initFilteredPostObserver();
  }

  // linkedin adaptation: a post is mobile-web when it is (or sits inside) an
  // <article data-id="main-feed-card">; otherwise it is the desktop SDUI card.
  private _isMobilePost(el: HTMLElement): boolean {
    return el.matches('article[data-id="main-feed-card"]')
      || el.closest('article[data-id="main-feed-card"]') !== null;
  }

  // linkedin adaptation: mirror Twitter's above-viewport fade behavior.
  _initFilteredPostObserver() {
    const fadingOut = new Set<Element>();
    const scrollHandler = () => {
      const marked = document.querySelectorAll('[data-filtered-by-extension="true"]');
      for (const el of marked) {
        if (!(el instanceof HTMLElement)) continue;
        if (el.style.display === 'none' || fadingOut.has(el)) continue;
        const rect = el.getBoundingClientRect();
        // Entirely above viewport with a 50px buffer.
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

  extractPostContent(article: HTMLElement): PostContent {
    return this._isMobilePost(article)
      ? this._extractMobileContent(article)
      : this._extractDesktopContent(article);
  }

  private _cleanText(raw: string): string {
    return raw.replace(/\s+/g, ' ').trim();
  }

  // Strip interactive controls (LinkedIn's "…more" expander, action buttons)
  // before snapshotting innerHTML for the filtered-posts panel. The expander
  // in particular carries an `inset-inline-start: <N>px` style computed
  // against the live post's width, so re-rendering it in a smaller container
  // places it at a meaningless offset. The static snapshot has no JS, so the
  // button wouldn't function anyway — removing it is strictly better.
  private _cleanTextHtml(el: Element | null): string {
    if (!el) return '';
    const clone = el.cloneNode(true) as Element;
    clone.querySelectorAll('button, [role="button"]').forEach(b => b.remove());
    return clone.innerHTML;
  }

  // ===========================================================================
  // Desktop SDUI extraction
  // ===========================================================================

  private _extractDesktopContent(article: HTMLElement): PostContent {
    // linkedin adaptation: the actor identity block carries an aria-label of the
    // form "<Name> [Premium] Profile <degree>" (e.g. "Teddy Zheng Premium
    // Profile 3rd+"). It's present for every authored card and survives
    // LinkedIn's class obfuscation, so it's our primary anchor for both the name
    // and the connection degree. The "Open control menu" button is a fallback
    // for the name only — it isn't rendered on every card (e.g. before hover).
    const identityLabel =
      article.querySelector<HTMLElement>('[aria-label*=" Profile "]')
        ?.getAttribute('aria-label') ?? '';

    const author = this._extractDesktopAuthor(article, identityLabel);
    const degree = this._parseDesktopDegree(identityLabel);
    const handle = this._extractDesktopHandle(article);
    const avatarUrl = this._extractDesktopAvatarUrl(article);
    const timeText = this._extractDesktopTimestamp(article);

    const textEl = article.querySelector('[data-testid="expandable-text-box"]');
    const text = this._cleanText(textEl?.textContent ?? '');
    const textHtml = this._cleanTextHtml(textEl);

    const postUrl = this.getPostUrl(article);
    const imageUrls = this._extractDesktopImageUrls(article);
    const hasMediaContainer = imageUrls.length > 0;

    const quote = this._extractDesktopQuote(article, textEl);

    return {
      text,
      author,
      handle,
      avatarUrl,
      timeText,
      textHtml,
      quote,
      postUrl,
      imageUrls,
      hasMediaContainer,
      degree,
    };
  }

  // linkedin adaptation: the actor block stacks, in order, the author-name row,
  // the headline, an optional CTA link ("Book an appointment", "Visit my
  // website"), then the timestamp row. They are siblings under a common meta
  // container, which is the timestamp paragraph's grandparent (the globe <p> is
  // the only child of its wrapper div, so we go up one level to reach the row,
  // then one more to reach the container).
  private _extractDesktopHandle(article: HTMLElement): string {
    const globeIcon = article.querySelector('svg[aria-label*="Visibility"]');
    const timeP = globeIcon?.closest('p');
    const timeWrapper = timeP?.parentElement;
    const meta = timeWrapper?.parentElement;
    if (!timeWrapper || !meta) return '';
    // Scan the rows in document order and return the FIRST plain-text row after
    // the name — that's the headline. Scanning backwards from the timestamp
    // would instead grab the CTA link that sits just above it. We can't require
    // a <p> here: LinkedIn wraps the headline in a <span> as often as a <p>.
    for (const row of Array.from(meta.children)) {
      if (!(row instanceof HTMLElement)) continue;
      if (row === timeWrapper) break;          // reached the timestamp — stop
      if (this._isAuthorNameEl(row)) continue; // skip the author-name row
      const text = row.textContent?.trim();
      if (text) return this._cleanText(text);
    }
    return '';
  }

  // The author name in the actor block is rendered as a profile link (or an
  // element carrying the "… Profile …" aria-label used by _extractDesktopDegree).
  // Used to keep the headline scan from mistaking the name line for the headline.
  private _isAuthorNameEl(el: HTMLElement): boolean {
    return !!el.querySelector('a[href*="/in/"], a[href*="/company/"], [aria-label*=" Profile "]')
      || el.matches('a[href*="/in/"], a[href*="/company/"], [aria-label*=" Profile "]');
  }

  // linkedin adaptation: actor avatars use recognisable URL path segments
  // ("profile-displayphoto", "company-logo", "profile-framedphoto").
  private _extractDesktopAvatarUrl(article: HTMLElement): string | null {
    const avatarImgs = article.querySelectorAll<HTMLImageElement>(
      'a[href*="/in/"] img[src*="media.licdn.com"], a[href*="/company/"] img[src*="media.licdn.com"]'
    );
    const avatarHints = ['profile-displayphoto', 'company-logo', 'profile-framedphoto'];
    for (const img of avatarImgs) {
      const src = img.src;
      if (src && avatarHints.some(h => src.includes(h))) return src;
    }
    return null;
  }

  // linkedin adaptation: the timestamp paragraph contains the globe SVG.
  // The text before "•" is the age string ("2d", "5h", etc.).
  private _extractDesktopTimestamp(article: HTMLElement): string | null {
    const globeIcon = article.querySelector('svg[aria-label*="Visibility"]');
    const timeP = globeIcon?.closest('p');
    if (!timeP) return null;
    const raw = timeP.textContent ?? '';
    const before = raw.split('•')[0].trim();
    return before || null;
  }

  // linkedin adaptation: author name. Primary source is the actor identity
  // aria-label ("<Name> [Premium] Profile <degree>"); fall back to the control
  // menu button when that block is absent.
  private _extractDesktopAuthor(article: HTMLElement, identityLabel: string): string {
    // "Teddy Zheng Premium Profile 3rd+" -> "Teddy Zheng". Take everything
    // before " Profile", then drop a trailing membership/status qualifier that
    // LinkedIn appends before it.
    const beforeProfile = identityLabel.split(/\s+Profile\b/i)[0].trim();
    const name = beforeProfile.replace(/\s+(Premium|Influencer|Verified)$/i, '').trim();
    if (name) return name;

    const menuBtn = article.querySelector<HTMLElement>(
      'button[aria-label*="Open control menu for post by "]'
    );
    return menuBtn
      ?.getAttribute('aria-label')
      ?.replace(/^Open control menu for post by\s+/i, '')
      .trim() ?? '';
  }

  // linkedin adaptation: degree indicator ("2nd", "3rd+", etc.) is the trailing
  // token of the actor identity aria-label ("Name [Premium] Profile Xnd+").
  private _parseDesktopDegree(identityLabel: string): string {
    const m = identityLabel.match(/\b(\d+(?:st|nd|rd|th)\+?)\s*$/);
    return m?.[1] ?? '';
  }

  // linkedin adaptation: reshare posts have "X reposted this" in a <p> and
  // may contain the original post's text in a separate expandable-text-box.
  // Extract the original as a QuoteContent. If it's not a reshare, return null.
  private _extractDesktopQuote(
    article: HTMLElement,
    mainTextEl: Element | null
  ): QuoteContent | null {
    const hasRepost = Array.from(article.querySelectorAll('p')).some(
      p => /reposted this/i.test(p.textContent ?? '')
    );
    if (!hasRepost) return null;

    // On a reshare there may be multiple text boxes; the quoted post's text
    // is the last one when the resharer adds no comment of their own, or the
    // second-to-last when they do. We take the last one as the quote.
    const textBoxes = article.querySelectorAll('[data-testid="expandable-text-box"]');
    if (textBoxes.length < 1) return null;
    const qTextEl = textBoxes[textBoxes.length - 1];
    if (qTextEl === mainTextEl) return null;

    // The quoted post's author comes from the last "Open control menu" button.
    const menuBtns = article.querySelectorAll<HTMLElement>(
      'button[aria-label*="Open control menu for post by "]'
    );
    const qMenuBtn = menuBtns[menuBtns.length - 1];
    const qAuthor = qMenuBtn
      ?.getAttribute('aria-label')
      ?.replace(/^Open control menu for post by\s+/i, '')
      .trim() ?? '';

    return {
      textHtml: this._cleanTextHtml(qTextEl),
      author: qAuthor,
      handle: '',
      avatarUrl: null,
      timeText: null,
    };
  }

  // linkedin adaptation: distinguish post content images from avatar/logo
  // images by URL path patterns. Also collect video poster frames.
  private _extractDesktopImageUrls(article: HTMLElement): string[] {
    const urls: string[] = [];

    // Patterns that appear in avatar/logo URLs — exclude these.
    const avatarHints = [
      'profile-displayphoto', 'company-logo_100', 'profile-framedphoto',
      'scale_100_100', 'shrink_100_100',
    ];
    // Patterns that appear in post content image URLs.
    const contentHints = [
      'image-shrink_', 'feedshare-shrink_', 'image-shrink_1280',
      'image-crop_', 'image-scale_',
    ];

    const imgs = article.querySelectorAll<HTMLImageElement>('img[src*="media.licdn.com"]');
    for (const img of imgs) {
      const src = img.currentSrc || img.src;
      if (!src || src.startsWith('data:')) continue;
      if (avatarHints.some(h => src.includes(h))) continue;
      if (!contentHints.some(h => src.includes(h))) continue;
      if (!urls.includes(src)) urls.push(src);
    }

    // Video poster frames stored as background-image on the preview div.
    const posterDivs = article.querySelectorAll<HTMLElement>('div[style*="videocover"]');
    for (const div of posterDivs) {
      const style = div.getAttribute('style') ?? '';
      const m = style.match(/url\("([^"]+)"\)/);
      if (m?.[1] && !urls.includes(m[1])) urls.push(m[1]);
    }

    // <video poster> attributes (dms.licdn.com playlist thumbnails).
    const videos = article.querySelectorAll<HTMLVideoElement>('video[poster]');
    for (const v of videos) {
      if (v.poster && !v.poster.startsWith('data:') && !urls.includes(v.poster)) {
        urls.push(v.poster);
      }
    }

    return urls;
  }

  // ===========================================================================
  // Mobile-web extraction
  // ===========================================================================

  private _extractMobileContent(article: HTMLElement): PostContent {
    // linkedin adaptation: the author block ("entity lockup") holds the post
    // author's name, headline, avatar, degree and timestamp. The resharer/
    // reaction context (e.g. "X likes this") lives in a separate header <p>
    // outside the lockup, so scoping to the lockup avoids confusing the two.
    const lockup = article.querySelector<HTMLElement>('.base-main-feed-card__entity-lockup');

    const author = this._extractMobileAuthor(article, lockup);
    const handle = this._extractMobileHeadline(lockup);
    const avatarUrl = this._extractMobileAvatarUrl(lockup);
    const timeText = this._extractMobileTimestamp(lockup);
    const degree = this._extractMobileDegree(lockup);

    const textEl = article.querySelector('.attributed-text-segment-list__content');
    const text = this._cleanText(textEl?.textContent ?? '');
    const textHtml = this._cleanTextHtml(textEl);

    const postUrl = this.getPostUrl(article);
    const imageUrls = this._extractMobileImageUrls(article);
    const hasMediaContainer = imageUrls.length > 0
      || article.querySelector('.feed-article-content, video, img.w-main-feed-card-media') !== null;

    const quote = this._extractMobileQuote(article);

    return {
      text,
      author,
      handle,
      avatarUrl,
      timeText,
      textHtml,
      quote,
      postUrl,
      imageUrls,
      hasMediaContainer,
      degree,
    };
  }

  // linkedin adaptation: the author name is the entity-lockup profile link.
  // Prefer the "View profile for X" link; fall back to its aria-label, then to
  // any link text in the lockup.
  private _extractMobileAuthor(article: HTMLElement, lockup: HTMLElement | null): string {
    const scope = lockup ?? article;
    const nameLink = scope.querySelector<HTMLElement>('a[aria-label^="View profile for "], a[aria-label^="View page for "]');
    if (nameLink) {
      const txt = this._cleanText(nameLink.textContent ?? '');
      if (txt) return txt;
      const label = nameLink.getAttribute('aria-label') ?? '';
      return label.replace(/^View (?:profile|page) for\s+/i, '').trim();
    }
    // Fallback: first profile/company link with visible text.
    const link = scope.querySelector<HTMLElement>('a[href*="/in/"], a[href*="/company/"]');
    return this._cleanText(link?.textContent ?? '');
  }

  // linkedin adaptation: the headline (job/title line) is the first <p> inside
  // the entity lockup, e.g. "Math & AI @ MIT '29 | ...".
  private _extractMobileHeadline(lockup: HTMLElement | null): string {
    if (!lockup) return '';
    const p = lockup.querySelector('p');
    return this._cleanText(p?.textContent ?? '');
  }

  // linkedin adaptation: the actor avatar is the round entity image in the lockup.
  private _extractMobileAvatarUrl(lockup: HTMLElement | null): string | null {
    if (!lockup) return null;
    const img = lockup.querySelector<HTMLImageElement>('img.hue-web-entity__image, img[src*="licdn.com"]');
    const src = img?.currentSrc || img?.src || '';
    return (src && !src.startsWith('data:')) ? src : null;
  }

  // linkedin adaptation: timestamp is the <time> element inside the lockup
  // ("3h", "2d", etc.).
  private _extractMobileTimestamp(lockup: HTMLElement | null): string | null {
    if (!lockup) return null;
    const t = lockup.querySelector('time');
    const txt = this._cleanText(t?.textContent ?? '');
    return txt || null;
  }

  // linkedin adaptation: degree indicator ("2nd", "3rd+", etc.) is a small
  // low-emphasis span in the lockup.
  private _extractMobileDegree(lockup: HTMLElement | null): string {
    if (!lockup) return '';
    for (const span of lockup.querySelectorAll('span')) {
      const m = (span.textContent ?? '').trim().match(/^(\d+(?:st|nd|rd|th)\+?)$/);
      if (m) return m[1];
    }
    return '';
  }

  // linkedin adaptation: reshares carry a nested original post. Mobile web does
  // not expose a distinct quote container in the common case (a "likes this" /
  // reaction resurface is the original author's own post), so we only emit a
  // QuoteContent when a clearly nested second text body is present.
  private _extractMobileQuote(article: HTMLElement): QuoteContent | null {
    const textBoxes = article.querySelectorAll('.attributed-text-segment-list__content');
    if (textBoxes.length < 2) return null;
    const qTextEl = textBoxes[textBoxes.length - 1];
    return {
      textHtml: this._cleanTextHtml(qTextEl),
      author: '',
      handle: '',
      avatarUrl: null,
      timeText: null,
    };
  }

  // linkedin adaptation: collect post content images (article previews,
  // feedshare media, video posters) while excluding avatars and the static
  // reaction icons.
  private _extractMobileImageUrls(article: HTMLElement): string[] {
    const urls: string[] = [];

    const imgs = article.querySelectorAll<HTMLImageElement>('img[src*="licdn.com"]');
    for (const img of imgs) {
      const src = img.currentSrc || img.src;
      if (!src || src.startsWith('data:')) continue;
      // Skip avatars (round entity images) and avatar URL patterns.
      if (img.classList.contains('hue-web-entity__image')) continue;
      if (/profile-displayphoto|profile-framedphoto|company-logo/.test(src)) continue;
      // Skip static UI assets (reaction icons, glyphs).
      if (src.includes('static.licdn.com')) continue;
      if (!urls.includes(src)) urls.push(src);
    }

    // <video poster> frames.
    const videos = article.querySelectorAll<HTMLVideoElement>('video[poster]');
    for (const v of videos) {
      if (v.poster && !v.poster.startsWith('data:') && !urls.includes(v.poster)) {
        urls.push(v.poster);
      }
    }

    return urls;
  }

  // ===========================================================================
  // Shared / layout-agnostic methods
  // ===========================================================================

  shouldProcessCurrentPage(): boolean {
    const path = window.location.pathname;
    return path === '/' || path === '/feed' || path === '/feed/' || this.isPermalinkView();
  }

  isPermalinkView(): boolean {
    return /^\/feed\/update\//.test(window.location.pathname);
  }

  isMainPost(article: HTMLElement): boolean {
    if (!this.isPermalinkView()) return false;
    const primary = document.querySelector(this.selectors.primaryColumn) || document;
    const first = primary.querySelector(this.selectors.post);
    return first === article;
  }

  getPostUrl(article: HTMLElement): string | null {
    // linkedin adaptation: on a permalink page the page URL IS the post URL.
    if (this.isPermalinkView()) return window.location.href;
    // Mobile web: derive a stable permalink from the social-action links,
    // which point at /feed/update/activity:<id>. Strip tracking query.
    if (this._isMobilePost(article)) {
      const link = article.querySelector<HTMLAnchorElement>(
        'a[data-id="social-actions__reactions"], a[aria-label="Comment"]'
      );
      const href = link?.getAttribute('href');
      if (href && href.includes('/feed/update/')) {
        try {
          const u = new URL(href, window.location.origin);
          return u.origin + u.pathname;
        } catch {
          return href.split('?')[0];
        }
      }
      return null;
    }
    // Desktop SDUI feed cards embed no per-post permalink anchor; rely on
    // componentkey as the cache identity (see getPostContentKey).
    return null;
  }

  getPostContentKey(article: HTMLElement): string {
    // linkedin adaptation: prefer the per-post stable identifiers — mobile's
    // data-activity-urn or desktop's componentkey. On the current SDUI the
    // componentkey lives on the listitem's wrapper div, so resolve it via
    // closest() (matches the element itself on the older layout). Fall back
    // to permalink, then to text content.
    const urn = article.getAttribute('data-activity-urn');
    if (urn) return urn;
    const key = article.closest('[componentkey*="FeedType"]')?.getAttribute('componentkey');
    if (key) return key;
    return this.getPostUrl(article)
      || article.querySelector(this.selectors.textContent)?.textContent?.substring(0, 200)
      || '';
  }

  getPostContainer(article: HTMLElement): HTMLElement {
    // Mobile: hide the whole feed row (<li class="feed-item">) so no gap is left
    // behind. Desktop: hide the FeedType-keyed unit — on the current SDUI
    // that's the wrapper div (which also holds the sibling comment-tools
    // region); on the older layout the listitem carries the key itself, so
    // closest() matches the element and this is hide-self.
    return article.closest<HTMLElement>('li.feed-item')
      || article.closest<HTMLElement>('div[componentkey*="FeedType"]')
      || article;
  }

  hidePost(article: HTMLElement): void {
    const element = this.getPostContainer(article);
    const rect = element.getBoundingClientRect();
    element.dataset.filteredByExtension = 'true';
    if (rect.bottom > 0) {
      element.style.display = 'none';
    }
    // If entirely above the viewport, the scroll handler fades it later.
  }

  // Reverse hidePost: bring a previously filtered post back into the feed.
  // Used when a filter phrase is removed and its posts should reappear.
  showPost(article: HTMLElement): void {
    const element = this.getPostContainer(article);
    delete element.dataset.filteredByExtension;
    element.style.display = '';
    element.style.visibility = '';
    article.style.opacity = '';
    article.style.transition = '';
  }

  getThemeMode(): 'light' | 'dim' | 'dark' {
    // linkedin adaptation: desktop carries the theme on #interop-outlet
    // ("theme--dark"). Mobile web has no such element, so fall back to body
    // background luminance. LinkedIn has no "dim" mode (light/dark only).
    const outlet = document.getElementById('interop-outlet');
    if (outlet) return outlet.classList.contains('theme--dark') ? 'dark' : 'light';

    const bg = window.getComputedStyle(document.body).backgroundColor;
    const m = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (m) {
      const [, r, g, b] = m.map(Number);
      if (r + g + b < 384) return 'dark';
    }
    return 'light';
  }

  async extractPostContentFromStore(article: HTMLElement): Promise<PostContent | null> {
    // linkedin adaptation: LinkedIn exposes no client-side store. Delegate to
    // the DOM extractor so the content script never gets null (which would
    // cause it to skip the post after MAX_STORE_RETRIES).
    return Promise.resolve(this.extractPostContent(article));
  }

  cleanupFilteredPostHtml(postContent: HTMLElement, imageUrls: string[]): void {
    // linkedin adaptation: reset any hidden state from the captured snapshot
    // before re-rendering it in the "filtered posts" panel.
    postContent.style.display = '';
    postContent.style.opacity = '1';
    postContent.removeAttribute('data-filtered-by-extension');

    // Remove broken video elements (blob: src won't work outside the feed) and
    // desktop video poster divs (background-image won't reload outside context).
    postContent.querySelectorAll('video').forEach(v => v.remove());
    postContent.querySelectorAll('div[style*="videocover"]').forEach(d => d.remove());

    // Re-insert captured images as static <img> elements.
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

  // linkedin adaptation: each feed card's header renders a "…" overflow menu
  // button — labeled "Open control menu" on the desktop SDUI and "Open menu"
  // on the mobile-web variant. We anchor our Bounce control to it so it always
  // sits immediately to its right (top-right of the card) on both surfaces.
  private _getOverflowButton(article: HTMLElement): HTMLElement | null {
    return article.querySelector<HTMLElement>(
      'button[aria-label^="Open control menu"], button[aria-label^="Open menu"]'
    );
  }

  // linkedin adaptation: the native "Hide post" (X) button sits next to the "…"
  // overflow button. We remove it so our trash control takes over that role.
  private _getHideButton(article: HTMLElement): HTMLElement | null {
    return article.querySelector<HTMLElement>(
      'button[aria-label^="Hide post by"], button[aria-label="Hide post"]'
    );
  }

  getShareButton(article: HTMLElement): HTMLElement | null {
    // Desktop SDUI: anchor on the "…" overflow menu button — our control sits to
    // its right. It's present in the card header from first paint, so it also
    // gates when our control is allowed to be injected.
    const overflow = this._getOverflowButton(article);
    if (overflow) return overflow;
    // Mobile: the action bar's "Share" control is a <button> whose text span
    // reads "Share".
    const buttons = article.querySelectorAll<HTMLElement>('.social-action-bar button, .social-action-bar a');
    for (const btn of buttons) {
      const label = (btn.querySelector('.social-action-bar__button-text')?.textContent ?? btn.textContent ?? '').trim();
      if (label === 'Share') return btn;
    }
    // Desktop fallback: the "Send" action is an <a> with aria-label="Send".
    return article.querySelector<HTMLElement>('[aria-label="Send"]');
  }

  insertActionButton(article: HTMLElement, button: HTMLElement): void {
    // Desktop SDUI: place our Bounce control immediately to the right of the "…"
    // overflow menu button, and hide LinkedIn's native "Hide post" (X) button so
    // ours takes its place.
    const overflow = this._getOverflowButton(article);
    if (overflow) {
      button.classList.add('ff-why-annoying-btn--linkedin-header');
      // Match a native header icon button's exact box so our control lines up
      // with the "…" button. Identical height ⇒ identical vertical position
      // regardless of the row's align-items (our default icon box is much
      // shorter, which is what pushed the trash up and to the side). Prefer the
      // X button's box, falling back to the overflow button's.
      const ref = this._getHideButton(article) ?? overflow;
      const rect = ref.getBoundingClientRect();
      if (rect.width && rect.height) {
        button.style.width = `${rect.width}px`;
        button.style.height = `${rect.height}px`;
      }
      const hideBtn = this._getHideButton(article);
      if (hideBtn) hideBtn.style.display = 'none';
      overflow.insertAdjacentElement('afterend', button);
      return;
    }
    // Mobile: place our control at the end of the social action row.
    const shareBtn = this.getShareButton(article);
    if (shareBtn) {
      shareBtn.insertAdjacentElement('afterend', button);
      return;
    }
    const bar = article.querySelector('.social-action-bar');
    if (bar) {
      bar.appendChild(button);
      return;
    }
    article.appendChild(button);
  }

  getSearchForm(): HTMLElement | null {
    // linkedin adaptation: global search in the top nav (desktop typeahead or
    // mobile search input).
    return document.querySelector<HTMLElement>('[data-testid="typeahead-input"]')
      ?? document.querySelector<HTMLElement>('[role="search"]')
      ?? document.querySelector<HTMLElement>('input[type="search"]');
  }
};

// Self-guard by hostname. On iOS all platform adapter scripts inject on
// every page; without this guard LinkedIn would clobber Twitter's and
// YouTube's assignments and the content script would try to extract posts
// using the wrong selectors.
// Regex mirrors src/shared/platforms.ts PLATFORM_RUNTIME.linkedin.hostPattern.
if (/(^|\.)linkedin\.com$/i.test(location.hostname)) {
  window.BouncerAdapter = BouncerLinkedInAdapter;
}

// linkedin adaptation: neutralize the mobile-web "get the full app
// experience" upsells (the .upsell-bottom banner and the
// .blocking-upsell-bottom-sheet bottom sheet). linkedin.css hides both
// instantly so the user never sees them — but hiding is not enough.
//
// Mechanism, reverse-engineered from LinkedIn's own bundle and confirmed by
// live diagnosis on Android/desktop:
//  - A dormant div.blocking-upsell wrapper mounts at page load
//    (data-trigger-type="scrolling-counter"); after the user scrolls past
//    data-counter-target-number feed items, LinkedIn opens the bottom sheet
//    and adds the `overflow-hidden` utility CLASS to <body>. With <html>
//    overflow visible, body's overflow:hidden propagates to the viewport:
//    touch/wheel scrolling dies (programmatic scrollTo still works — no
//    event listener, no inline style, which is why clearing inline styles
//    and removing scrim nodes never unfroze anything). The class is only
//    removed on proper dismissal — impossible on a CSS-hidden sheet — so
//    the feed freezes forever.
//  - The upsell controllers check sessionStorage at boot
//    (readWithExpiry(storageKey, coolOff)): if it returns "DISMISSED",
//    LinkedIn REMOVES the upsell element itself and never arms any of this.
//    Storage format (av class in their bundle): JSON-encoded value under
//    the data-storage-key, plus JSON-encoded Date.now() under
//    `<key>_lastUpdatedAt`, valid for data-cool-off-time ms (7 days for the
//    sheet). Their dismiss handlers ignore synthetic events (isTrusted
//    check — verified: every dispatched event returns un-prevented).
//
// Defense in depth, in order:
//  1. Pre-seed sessionStorage with "DISMISSED" records — LinkedIn's own
//     boot check then removes the upsells before they can ever arm. This
//     is the primary fix; the rest guards against races (our seed landing
//     after their boot) and future storage-format drift.
//  2. Click LinkedIn's dismiss control (attempts 1-2 per surface, spaced
//     >=400ms; full pointerdown→click sequence). Structural selectors only:
//     banner X = button.upsell-content__dismiss-icon, sheet close =
//     button.btn-tertiary / data-tracking-control-name *close*/*dismiss* —
//     searched in the enclosing wrapper because the sheet's close button
//     sits outside the surface node. The app-store CTA is
//     a.btn-primary.upsell-content__action, which nothing here matches.
//  3. Remove the wrapper node (attempt 3+) — the strategy a dedicated iOS
//     WKUserScript used successfully before this shared path replaced it.
//  4. Strip a stale body `overflow-hidden` class whenever an upsell surface
//     has been seen and no legitimate modal remains open (checked on every
//     pass AND via a dedicated body class-attribute observer — the arming
//     step is an attribute-only mutation that childList observers miss).
//
// This runs at top level, NOT inside the adapter class: the hiding CSS is
// injected unconditionally by the manifest, so the dismisser must run even
// when the content script later bails (e.g. filtering disabled). Same
// upsell classes only exist on the mobile layout, so this is inert on
// desktop SDUI.
if (/(^|\.)linkedin\.com$/i.test(location.hostname)) {
  // Shows in the Android app's logcat ("Web Content"/"Isolated Web Content"
  // tags, consoleOutput enabled in BouncerGeckoView) and in desktop DevTools.
  const traceUpsell = (msg: string) => console.log(`[bouncer-upsell] ${msg}`);

  // 1. Pre-seed LinkedIn's own dismissal records (sessionStorage, JSON
  // values, `_lastUpdatedAt` expiry companion — see header comment). Their
  // boot check then removes the upsell nodes itself.
  try {
    const stamp = JSON.stringify(Date.now());
    for (const key of ['blocking-upsell', 'non-blocking-upsell']) {
      sessionStorage.setItem(key, '"DISMISSED"');
      sessionStorage.setItem(`${key}_lastUpdatedAt`, stamp);
    }
    traceUpsell('pre-seeded sessionStorage dismissal records');
  } catch (e) {
    traceUpsell(`sessionStorage seeding failed (${(e as Error).message}) — DOM fallbacks still active`);
  }

  const upsellAttempts = new WeakMap<Element, { count: number; last: number }>();
  let sawUpsellSurface = false;

  // 4. The actual un-freezer: LinkedIn's scroll lock is the `overflow-hidden`
  // utility class on <body>. Strip it only when an upsell surface has been
  // seen on this page (so we never touch a lock we don't understand) and no
  // legitimate modal could still own it.
  const stripStaleScrollLock = () => {
    const body = document.body;
    if (!sawUpsellSurface || !body || !body.classList.contains('overflow-hidden')) return;
    if (document.querySelector('.bottom-sheet-open')) return;
    for (const container of document.querySelectorAll('.top-level-modal-container')) {
      if (container.childElementCount > 0) return;
    }
    body.classList.remove('overflow-hidden');
    traceUpsell('stripped stale overflow-hidden scroll lock from <body>');
  };

  // .click() only fires a `click` event; if LinkedIn's dismiss handler
  // listens on pointer/mouse events instead, .click() is a silent no-op. So
  // fire the whole activation sequence, and report each dispatchEvent result
  // (`PREVENTED` = some handler called preventDefault = a listener really
  // saw it).
  const syntheticActivate = (el: HTMLElement): string => {
    const init: MouseEventInit = { bubbles: true, cancelable: true, composed: true, view: window };
    const results: string[] = [];
    const fire = (ev: Event) => {
      try {
        results.push(`${ev.type}:${el.dispatchEvent(ev) ? 'ok' : 'PREVENTED'}`);
      } catch (e) {
        results.push(`${ev.type}:threw(${(e as Error).message})`);
      }
    };
    fire(new PointerEvent('pointerdown', init));
    fire(new MouseEvent('mousedown', init));
    fire(new PointerEvent('pointerup', init));
    fire(new MouseEvent('mouseup', init));
    el.click();
    results.push('click():done');
    return results.join(' ');
  };

  const describeEl = (el: Element): string => {
    const aria = el.getAttribute('aria-label');
    const track = el.getAttribute('data-tracking-control-name');
    return `<${el.tagName.toLowerCase()} cls="${String(el.className).replace(/\s+/g, ' ').slice(0, 90)}"`
      + (aria ? ` aria="${aria}"` : '')
      + (track ? ` track="${track}"` : '')
      + `> text="${(el.textContent ?? '').trim().slice(0, 30)}"`;
  };

  const dismissUpsells = () => {
    const surfaces = document.querySelectorAll('.upsell-bottom, .blocking-upsell-bottom-sheet');
    // Runs even with zero surfaces: the lock class can outlive the surface
    // nodes (we remove them; LinkedIn's arming code may still add the class).
    stripStaleScrollLock();
    for (const surface of surfaces) {
      const state = upsellAttempts.get(surface) ?? { count: 0, last: 0 };
      const now = Date.now();
      if (state.count >= 5) {
        if (state.count === 5) {
          upsellAttempts.set(surface, { count: 6, last: now });
          traceUpsell(`GIVING UP on ${String(surface.className).split(' ')[0]} after 5 attempts; still connected=${surface.isConnected}`);
        }
        continue;
      }
      if (now - state.last < 400) continue;
      // The dismiss control can live in the sheet's chrome outside the
      // surface node (the sheet's Close button does), so search the whole
      // enclosing upsell/modal wrapper.
      const scope = surface.closest('.top-level-modal-container, .blocking-upsell, .mweb-app-upsell') ?? surface;
      if (state.count === 0) {
        sawUpsellSurface = true;
        traceUpsell(`surface mounted: ${describeEl(surface)} scope=${String(scope.className).replace(/\s+/g, ' ').slice(0, 90)} readyState=${document.readyState}`);
        traceUpsell(`scope html: ${scope.outerHTML.slice(0, 1200)}`);
        const clickables = scope.querySelectorAll('button, [role="button"], a, [class*="dismiss"], [class*="close"]');
        traceUpsell(`clickables (${clickables.length}): ${[...clickables].map(describeEl).join(' | ')}`);
        traceUpsell(`html style="${document.documentElement.getAttribute('style') ?? ''}" body style="${document.body?.getAttribute('style') ?? ''}" body cls="${document.body?.className ?? ''}"`);
      }
      upsellAttempts.set(surface, { count: state.count + 1, last: now });
      // Attempts 1-2: LinkedIn's own dismiss control. If LinkedIn honors it
      // (it sets the data-cool-off-time suppression in storage), this is the
      // clean path. In practice its handler ignores synthetic events
      // (isTrusted check — every dispatch returns un-prevented), so:
      // Attempt 3: remove the wrapper node outright, the same strategy the
      // iOS WKUserScript has used successfully all along. The wrapper's
      // scrim is what eats touch input while the sheet sits parked
      // off-screen (-bottom-full), so removing it restores scrolling even
      // though we never got a "real" dismissal.
      if (state.count >= 2) {
        traceUpsell(`escalating (attempt ${state.count + 1}): removing wrapper ${String(scope.className).replace(/\s+/g, ' ').slice(0, 80)}`);
        scope.remove();
        for (const el of [document.documentElement, document.body]) {
          if (el && el.style.overflow === 'hidden') {
            traceUpsell(`clearing inline overflow lock on ${el.tagName}`);
            el.style.overflow = '';
          }
        }
      } else {
        const dismiss = scope.querySelector<HTMLElement>(
          'button.upsell-content__dismiss-icon, button[data-tracking-control-name*="dismiss"], button[data-tracking-control-name*="close"], button.btn-tertiary'
        );
        if (!dismiss) {
          traceUpsell(`no dismiss control matched in ${String(surface.className).split(' ')[0]} (attempt ${state.count + 1})`);
          continue;
        }
        traceUpsell(`activating dismiss (attempt ${state.count + 1}) ${describeEl(dismiss)}`);
        const dispatchReport = syntheticActivate(dismiss);
        traceUpsell(`dispatch results: ${dispatchReport}`);
      }
      // Mutation-driven passes stall when the page goes quiet, so guarantee a
      // follow-up pass to verify the surface unmounted (and retry if not).
      setTimeout(() => {
        if (surface.isConnected) {
          traceUpsell(`surface STILL CONNECTED 500ms after attempt ${state.count + 1}; cls now="${String(surface.className).replace(/\s+/g, ' ').slice(0, 120)}"`);
          scheduleUpsellPass();
        } else {
          traceUpsell(`surface unmounted after attempt ${state.count + 1} — dismissed`);
        }
      }, 500);
    }
  };

  // rAF-coalesced so heavy feed mutation bursts cost at most one
  // querySelectorAll per frame.
  let upsellPassScheduled = false;
  const scheduleUpsellPass = () => {
    if (upsellPassScheduled) return;
    upsellPassScheduled = true;
    requestAnimationFrame(() => {
      upsellPassScheduled = false;
      dismissUpsells();
    });
  };

  new MutationObserver(scheduleUpsellPass)
    .observe(document.documentElement, { childList: true, subtree: true });
  // Arming the lock is an attribute-only mutation (class added to <body>)
  // that the childList observer above never fires for — watch it directly.
  if (document.body) {
    new MutationObserver(scheduleUpsellPass)
      .observe(document.body, { attributes: true, attributeFilter: ['class'] });
  }
  scheduleUpsellPass();
  traceUpsell(`armed on ${location.hostname} readyState=${document.readyState}`);
}
