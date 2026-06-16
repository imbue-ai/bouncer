// linkedin adaptation
//
// LinkedIn platform adapter targeting LinkedIn's SDUI (server-driven UI) DOM.
// Class names are hashed/obfuscated, so we rely exclusively on stable semantic
// hooks: role, aria-label, data-testid, componentkey, and structural position.
//
// This file is fully additive — it does not touch the Twitter adapter and is
// only loaded by the LinkedIn content-script block in manifest.base.json.

import type { PlatformAdapter, PlatformSelectors, PostContent, QuoteContent } from '../../src/types';

window.BouncerAdapter = class LinkedInAdapter implements PlatformAdapter {
  siteId = 'linkedin' as const;

  // linkedin adaptation: stable selectors based on ARIA/data attributes, not
  // obfuscated class names.
  selectors: PlatformSelectors = {
    // Each feed post is a listitem whose componentkey contains "FeedType".
    // The h2 child reads "Feed post" (visually hidden).
    post: 'div[role="listitem"][componentkey*="FeedType"]',
    // Right-hand aside rail.
    sidebar: 'aside[aria-label="Aside"]',
    sidebarContent: '',
    // Main feed column.
    primaryColumn: 'section[aria-label="Primary content"]',
    // Top navigation bar.
    nav: 'header',
    // LinkedIn has no Twitter-style mobile BottomBar.
    bottomBar: '',
    // MutationObserver target: the list that receives new post children.
    mutations: '[data-testid="mainFeed"]',
    // Post body text.
    textContent: '[data-testid="expandable-text-box"]',
  };

  constructor() {
    // linkedin adaptation: fade filtered posts once scrolled fully above viewport.
    this._initFilteredPostObserver();
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
    // linkedin adaptation: author name extracted from the "Open control menu"
    // button's aria-label — the most stable hook in LinkedIn's SDUI.
    const menuBtn = article.querySelector<HTMLElement>(
      'button[aria-label*="Open control menu for post by "]'
    );
    const author = menuBtn
      ?.getAttribute('aria-label')
      ?.replace(/^Open control menu for post by\s+/i, '')
      .trim() ?? '';

    // linkedin adaptation: the author headline sits as a sibling <p> before
    // the timestamp <p> (which always contains the globe icon).
    const handle = this._extractHandle(article);

    // linkedin adaptation: the actor avatar is the first media.licdn.com img
    // inside a profile or company link that is identifiably a photo/logo.
    const avatarUrl = this._extractAvatarUrl(article);

    // linkedin adaptation: timestamp — the <p> containing the visibility SVG
    // reads "2d • " followed by the icon. We take the text before "•".
    const timeText = this._extractTimestamp(article);

    const textEl = article.querySelector(this.selectors.textContent);
    const text = this._cleanText(textEl?.textContent ?? '');
    const textHtml = textEl ? textEl.innerHTML : '';

    const postUrl = this.getPostUrl(article);
    const imageUrls = this._extractImageUrls(article);
    const hasMediaContainer = imageUrls.length > 0;

    // linkedin adaptation: reshares carry "X reposted this" text above the
    // original post; extract the original as a QuoteContent when present.
    const quote = this._extractQuote(article, textEl);

    // linkedin adaptation: connection degree ("2nd", "3rd+", etc.) from the
    // actor's aria-label which reads "Name [Premium/Verified] Profile Xnd+".
    const degree = this._extractDegree(article);

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

  private _cleanText(raw: string): string {
    return raw.replace(/\s+/g, ' ').trim();
  }

  // linkedin adaptation: the author headline is in a wrapper div that is a
  // preceding sibling of the timestamp wrapper div (which itself wraps the globe
  // SVG p). We can't traverse timeP.previousElementSibling because timeP is
  // the only child of its wrapper div — we must go up one level first.
  private _extractHandle(article: HTMLElement): string {
    const globeIcon = article.querySelector('svg[aria-label*="Visibility"]');
    const timeP = globeIcon?.closest('p');
    if (!timeP) return '';
    const timeWrapper = timeP.parentElement;
    if (!timeWrapper) return '';
    let el = timeWrapper.previousElementSibling;
    while (el) {
      if (el instanceof HTMLElement) {
        for (const p of el.querySelectorAll('p')) {
          if (!p.querySelector('svg') && p.textContent?.trim()) {
            return this._cleanText(p.textContent);
          }
        }
      }
      el = el.previousElementSibling;
    }
    return '';
  }

  // linkedin adaptation: actor avatars use recognisable URL path segments
  // ("profile-displayphoto", "company-logo", "profile-framedphoto").
  private _extractAvatarUrl(article: HTMLElement): string | null {
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
  private _extractTimestamp(article: HTMLElement): string | null {
    const globeIcon = article.querySelector('svg[aria-label*="Visibility"]');
    const timeP = globeIcon?.closest('p');
    if (!timeP) return null;
    const raw = timeP.textContent ?? '';
    const before = raw.split('•')[0].trim();
    return before || null;
  }

  // linkedin adaptation: degree indicator ("2nd", "3rd+", etc.) lives inside
  // a div with aria-label="Name [Premium] Profile Xnd+" in the actor block.
  private _extractDegree(article: HTMLElement): string {
    const nameDiv = article.querySelector<HTMLElement>('[aria-label*=" Profile "]');
    const label = nameDiv?.getAttribute('aria-label') ?? '';
    const m = label.match(/\b(\d+(?:st|nd|rd|th)\+?)\s*$/);
    return m?.[1] ?? '';
  }

  // linkedin adaptation: reshare posts have "X reposted this" in a <p> and
  // may contain the original post's text in a separate expandable-text-box.
  // Extract the original as a QuoteContent. If it's not a reshare, return null.
  private _extractQuote(
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
      textHtml: qTextEl.innerHTML,
      author: qAuthor,
      handle: '',
      avatarUrl: null,
      timeText: null,
    };
  }

  // linkedin adaptation: distinguish post content images from avatar/logo
  // images by URL path patterns. Also collect video poster frames.
  private _extractImageUrls(article: HTMLElement): string[] {
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

  getPostUrl(_article: HTMLElement): string | null {
    // linkedin adaptation: LinkedIn's SDUI feed does not embed per-post
    // permalink anchors in feed cards. On a permalink page the page URL IS
    // the post URL; on the home feed we return null and rely on componentkey
    // as the cache identity (see getPostContentKey).
    if (this.isPermalinkView()) return window.location.href;
    return null;
  }

  getPostContentKey(article: HTMLElement): string {
    // linkedin adaptation: componentkey is unique per rendered post and stable
    // within a session — use it as the cache key in preference to text content.
    const key = article.getAttribute('componentkey');
    if (key) return key;
    return article.querySelector(this.selectors.textContent)?.textContent?.substring(0, 200) ?? '';
  }

  getPostContainer(article: HTMLElement): HTMLElement {
    // The listitem div is the top-level unit we hide — no inner wrapper needed.
    return article;
  }

  hidePost(article: HTMLElement): void {
    const element = this.getPostContainer(article);
    const rect = element.getBoundingClientRect();
    element.dataset.filteredByExtension = 'true';
    if (rect.bottom > 0) {
      element.style.display = 'none';
    }
  }

  getThemeMode(): 'light' | 'dim' | 'dark' {
    // linkedin adaptation: the interop-outlet element carries "theme--light" or
    // "theme--dark". LinkedIn has no "dim" mode, so we only return light/dark.
    const outlet = document.getElementById('interop-outlet');
    if (outlet?.classList.contains('theme--dark')) return 'dark';
    return 'light';
  }

  async extractPostContentFromStore(article: HTMLElement): Promise<PostContent | null> {
    // linkedin adaptation: LinkedIn exposes no client-side store. Delegate
    // to the DOM extractor so the content script never gets null (which would
    // cause it to skip the post after MAX_STORE_RETRIES).
    return Promise.resolve(this.extractPostContent(article));
  }

  cleanupFilteredPostHtml(postContent: HTMLElement, imageUrls: string[]): void {
    // linkedin adaptation: reset any hidden state from the captured snapshot
    // before re-rendering it in the "filtered posts" panel.
    postContent.style.display = '';
    postContent.style.opacity = '1';
    postContent.removeAttribute('data-filtered-by-extension');

    // Remove broken video elements (blob: src won't work outside the feed).
    postContent.querySelectorAll('video').forEach(v => v.remove());
    // Remove video poster divs — background-image won't reload outside context.
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

  getShareButton(article: HTMLElement): HTMLElement | null {
    // linkedin adaptation: the "Send" action is an <a> with aria-label="Send".
    return article.querySelector<HTMLElement>('[aria-label="Send"]');
  }

  insertActionButton(article: HTMLElement, button: HTMLElement): void {
    // linkedin adaptation: insert after the Send button so our control sits
    // at the right end of the social action row.
    const sendBtn = this.getShareButton(article);
    if (sendBtn) {
      sendBtn.insertAdjacentElement('afterend', button);
      return;
    }
    article.appendChild(button);
  }

  getSearchForm(): HTMLElement | null {
    // linkedin adaptation: global typeahead input in the top nav.
    return document.querySelector<HTMLElement>('[data-testid="typeahead-input"]')
      ?? document.querySelector<HTMLElement>('[role="search"]');
  }
};
