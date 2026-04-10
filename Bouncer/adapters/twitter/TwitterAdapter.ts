import type { PlatformAdapter, PlatformSelectors, PostContent, QuoteContent } from '../../src/types';

/** Shape of the tweet data returned by the fiber-extractor main-world script. */
interface TweetStoreData {
  fullText: string;
  userName: string;
  userHandle: string;
  userAvatarUrl: string | null;
  postUrl: string | null;
  imageUrls: string[];
  videoThumbnailUrls: string[];
  quotedTweet?: {
    fullText: string;
    userName: string;
    userHandle: string;
    userAvatarUrl: string | null;
    imageUrls: string[];
  };
}

interface StoreResult {
  requestId: string;
  success: boolean;
  data?: TweetStoreData;
  error?: string;
}

window.BouncerAdapter = class TwitterAdapter implements PlatformAdapter {
  siteId = 'twitter' as const;

  selectors: PlatformSelectors = {
    post: 'article[data-testid="tweet"]',
    sidebar: '[data-testid="sidebarColumn"]',
    sidebarContent: 'div[data-testid="sidebarColumn"] > div > div > div > div',
    primaryColumn: '[data-testid="primaryColumn"]',
    nav: 'nav[role="navigation"]',
    bottomBar: 'div[data-testid="BottomBar"]',
    mutations: '[data-testid="tweetText"]',
    textContent: '[data-testid="tweetText"]',
  };

  private _fiberExtractorReady = false;
  private _pendingStoreRequests = new Map<string, (result: StoreResult) => void>();

  constructor() {
    // Eagerly inject the fiber extractor so it's ready before the first post is processed
    this.initFiberExtractor();
    this._initFilteredPostObserver();
  }

  _initFilteredPostObserver() {
    // Watches tweets marked data-filtered-by-extension (above viewport when filtered).
    // Fades them out once their top is 100px below the top of the viewport.
    const fadingOut = new Set<Element>();
    const scrollHandler = () => {
      const marked = document.querySelectorAll('[data-filtered-by-extension="true"]');
      for (const el of marked) {
        if (!(el instanceof HTMLElement)) continue;
        if (el.style.display === 'none' || fadingOut.has(el)) continue;
        const rect = el.getBoundingClientRect();
        if (rect.top >= 100) {
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
    const authorEl = article.querySelector('[data-testid="User-Name"]');
    const author = authorEl ? (authorEl.textContent ?? '') : '';

    // Handle: look for @-prefixed text in User-Name links
    const userNameLinks = article.querySelectorAll('[data-testid="User-Name"] a[role="link"]');
    let handle = '';
    userNameLinks.forEach(link => {
      const linkText = link.textContent ?? '';
      if (linkText.startsWith('@')) handle = linkText;
    });

    // Avatar — require [src] to skip unloaded placeholders; try multiple patterns
    const avatarImg = article.querySelector('[data-testid="Tweet-User-Avatar"] img[src*="twimg.com"]')
      || article.querySelector('[data-testid="Tweet-User-Avatar"] img[src]')
      || article.querySelector('img[src*="profile_images"]');
    const avatarSrc = (avatarImg as HTMLImageElement | null)?.src || '';
    const avatarUrl = (avatarSrc && !avatarSrc.startsWith('data:') && avatarSrc !== '') ? avatarSrc : null;

    // Timestamp text
    const timeEl = article.querySelector('time');
    const timeText = timeEl ? timeEl.textContent : null;

    const tweetTextEls = article.querySelectorAll('[data-testid="tweetText"]');
    const textParts: string[] = [];
    tweetTextEls.forEach((el, index) => {
      const raw = el.textContent?.replace(/\s+/g, ' ').trim();
      if (raw) {
        if (index === 0) {
          textParts.push(raw);
        } else {
          textParts.push(`[Quoted: ${raw}]`);
        }
      }
    });
    const text = textParts.join(' ');

    // Main tweet text as HTML (preserves links, emojis, formatting)
    const mainTextEl = tweetTextEls[0];
    const textHtml = mainTextEl ? mainTextEl.innerHTML : '';

    // Quote tweet — extract full metadata from the quote card container
    let quote: QuoteContent | null = null;
    if (tweetTextEls.length > 1) {
      const quoteTextEl = tweetTextEls[1];
      // The quote card is the nearest ancestor with role="link"
      const quoteCard = quoteTextEl.closest('[role="link"]');

      let qAuthor = '', qHandle = '', qAvatarUrl: string | null = null, qTimeText: string | null = null;
      if (quoteCard) {
        // Author and handle from User-Name inside the quote card
        const qUserName = quoteCard.querySelector('[data-testid="User-Name"]');
        if (qUserName) {
          const qNameLinks = qUserName.querySelectorAll('a[role="link"]');
          qNameLinks.forEach(link => {
            const qLinkText = link.textContent ?? '';
            if (qLinkText.startsWith('@')) {
              qHandle = qLinkText;
            }
          });
          // Display name: text before the handle
          const fullText = qUserName.textContent || '';
          if (qHandle) {
            const idx = fullText.indexOf(qHandle);
            if (idx > 0) qAuthor = fullText.substring(0, idx);
          } else {
            qAuthor = fullText;
          }
        }
        // Avatar
        const qAvatarImg = quoteCard.querySelector('[data-testid="Tweet-User-Avatar"] img[src]')
          || quoteCard.querySelector('img[src*="profile_images"]');
        const qSrc = (qAvatarImg as HTMLImageElement | null)?.src || '';
        qAvatarUrl = (qSrc && !qSrc.startsWith('data:')) ? qSrc : null;

        // Timestamp
        const qTime = quoteCard.querySelector('time');
        qTimeText = qTime ? qTime.textContent : null;
      }

      quote = {
        textHtml: quoteTextEl.innerHTML,
        author: qAuthor,
        handle: qHandle,
        avatarUrl: qAvatarUrl,
        timeText: qTimeText,
      };
    }

    const postUrl = this.getPostUrl(article);

    const imageEls = article.querySelectorAll('img[src*="pbs.twimg.com/media"]');
    const imageUrls: string[] = [];
    imageEls.forEach(img => {
      let url = (img as HTMLImageElement).src;
      if (url.includes('?')) {
        url = url.split('?')[0] + '?format=jpg&name=medium';
      }
      if (!imageUrls.includes(url)) {
        imageUrls.push(url);
      }
    });

    const videoEls = article.querySelectorAll('video[poster]');
    videoEls.forEach(video => {
      const posterUrl = (video as HTMLVideoElement).poster;
      if (posterUrl && !imageUrls.includes(posterUrl)) {
        imageUrls.push(posterUrl);
      }
    });

    const videoThumbEls = article.querySelectorAll('img[src*="pbs.twimg.com/ext_tw_video_thumb"], img[src*="pbs.twimg.com/amplify_video_thumb"]');
    videoThumbEls.forEach(img => {
      const url = (img as HTMLImageElement).src;
      if (!imageUrls.includes(url)) {
        imageUrls.push(url);
      }
    });

    const hasMediaContainer = article.querySelector(
      '[data-testid="tweetPhoto"], [data-testid="videoPlayer"], [data-testid="card.wrapper"]'
    ) !== null;


    const imgElements = article.querySelectorAll('img');
    const hasLargeImages = Array.from(imgElements).some(img => {
      const src = img.src || '';
      if (src.includes('profile_images') || src.includes('emoji') || src.includes('hashflag')) {
        return false;
      }
      if (src.includes('pbs.twimg.com') && !src.includes('profile')) {
        return true;
      }
      const width = img.naturalWidth || img.width || parseInt(img.getAttribute('width') || '0') || 0;
      const height = img.naturalHeight || img.height || parseInt(img.getAttribute('height') || '0') || 0;
      return width > 200 || height > 200;
    });

    const hasPotentialMedia = hasMediaContainer || hasLargeImages || article.querySelectorAll('video').length > 0;

    return { text, author, handle, avatarUrl, timeText, textHtml, quote, postUrl, imageUrls, hasMediaContainer: hasPotentialMedia };
  }

  shouldProcessCurrentPage() {
    const path = window.location.pathname;

    if ((path === '/home' || path === '/') && this._isHomeTab()) {
      return true;
    }

    if (/^\/.+\/status\/\d+/.test(path)) {
      return true;
    }

    if (path === '/explore' || path.startsWith('/search')) {
      return true;
    }

    return false;
  }

  private _isHomeTab() {
    const path = window.location.pathname;
    if (path !== '/home' && path !== '/') {
      return false;
    }

    const tabBar = document.querySelector('[role="tablist"]');
    if (!tabBar) return false;

    const tabs = tabBar.querySelectorAll('[role="tab"]');
    for (const tab of tabs) {
      const tabText = tab.textContent?.toLowerCase() || '';
      if (tabText.includes('for you') || tabText.includes('following')) {
        if (tab.getAttribute('aria-selected') === 'true') {
          return true;
        }
      }
    }

    return false;
  }

  isMainPost(article: HTMLElement) {
    if (!/^\/.+\/status\/\d+/.test(window.location.pathname)) {
      return false;
    }
    const conversationTimeline = document.querySelector('div[aria-label="Timeline: Conversation"]');
    if (conversationTimeline) {
      const firstArticle = conversationTimeline.querySelector(this.selectors.post);
      if (firstArticle === article) {
        return true;
      }
    }
    return false;
  }

  getPostUrl(article: HTMLElement) {
    const timeLink = article.querySelector('time')?.closest('a');
    return (timeLink as HTMLAnchorElement | null)?.href || null;
  }

  getPostContentKey(article: HTMLElement) {
    return this.getPostUrl(article) || article.querySelector(this.selectors.textContent)?.textContent?.substring(0, 200) || '';
  }

  getPostContainer(article: HTMLElement): HTMLElement {
    return article.closest<HTMLElement>('[data-testid="cellInnerDiv"]') || article;
  }

  hidePost(article: HTMLElement) {
    const element = this.getPostContainer(article);
    this._hideCell(element);

    // Also hide threaded replies that follow this tweet
    let sibling = element.nextElementSibling as HTMLElement | null;
    while (sibling) {
      if (!this._isReplyInThread(sibling)) break;
      this._hideCell(sibling);
      sibling = sibling.nextElementSibling as HTMLElement | null;
    }
  }

  _hideCell(element: HTMLElement) {
    const rect = element.getBoundingClientRect();
    element.dataset.filteredByExtension = 'true';
    if (rect.bottom > 0) {
      // Overlaps the viewport or is below it — hide immediately
      element.style.display = 'none';
    }
    // If entirely above viewport, just mark it; the scroll handler will hide it
    // once its top is 100px below the top of the viewport
  }

  /**
   * Detect if a cellInnerDiv is a threaded reply to the tweet above it.
   * article[role="article"] > div:nth-child(2) > div > div:first-child > div
   * has 2 children when the tweet is part of a thread, otherwise fewer.
   */
  _isReplyInThread(cellInnerDiv: Element) {
    const article = cellInnerDiv.querySelector(this.selectors.post);
    if (!article) return false;

    const col = article.querySelector(':scope > div:nth-child(2) > div > div:first-child > div');
    return col !== null && col.children.length === 2;
  }

  getThemeMode(): 'light' | 'dim' | 'dark' {
    const body = document.body;
    const bgColor = window.getComputedStyle(body).backgroundColor;
    const match = bgColor.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
    if (match) {
      const [, r, g, b] = match.map(Number);
      if (r > 200 && g > 200 && b > 200) {
        return 'light';
      }
      if (b > r && r < 50) {
        return 'dim';
      }
      return 'dark';
    }
    return 'dark';
  }

  /**
   * Inject the main-world script that reads Twitter's Redux store.
   * Content scripts run in an isolated world and can't access __reactFiber$ or the store,
   * so we inject into the page context and communicate via CustomEvent.
   */
  private initFiberExtractor() {
    if (this._fiberExtractorReady) return;
    this._fiberExtractorReady = true;

    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('adapters/twitter/fiber-extractor.js');
    (document.head || document.documentElement).appendChild(script);
    script.onload = () => script.remove();

    // Listen for store data results
    document.addEventListener('ff-tweet-data-result', (e) => {
      try {
        const detail = (e as CustomEvent).detail as string;
        const result: StoreResult = JSON.parse(detail) as StoreResult;
        const resolve = this._pendingStoreRequests.get(result.requestId);
        if (resolve) {
          this._pendingStoreRequests.delete(result.requestId);
          resolve(result);
        }
      } catch (err) {
        console.log('[Bouncer][Store] Parse error:', err);
      }
    });
  }

  /**
   * Extract post content from Twitter's Redux store.
   * Combines store extraction and normalization into a single adapter method.
   */
  async extractPostContentFromStore(article: HTMLElement): Promise<PostContent | null> {
    const storeData = await this._extractTweetDataFromStore(article);
    if (!storeData) return null;
    return this._normalizeStoreData(storeData);
  }

  /**
   * Extract tweet data from Twitter's Redux store via the injected main-world script.
   * Returns a Promise that resolves to store data or null (on timeout/error).
   */
  private _extractTweetDataFromStore(article: HTMLElement): Promise<unknown> {
    const cellInnerDiv = article.closest<HTMLElement>('[data-testid="cellInnerDiv"]') || article;
    const requestId = 'ff-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this._pendingStoreRequests.delete(requestId);
        console.log('[Bouncer][Store] Request timed out for', requestId);
        resolve(null);
      }, 200);

      this._pendingStoreRequests.set(requestId, (result) => {
        clearTimeout(timeout);
        if (result.success && result.data) {
          resolve(result.data);
        } else {
          console.log('[Bouncer][Store] Extraction failed:', result.error);
          resolve(null);
        }
      });

      cellInnerDiv.setAttribute('data-ff-request', requestId);
      document.dispatchEvent(new CustomEvent('ff-extract-tweet-data'));
    });
  }

  /**
   * Convert Redux store data into the same shape as extractPostContent returns.
   */
  private _normalizeStoreData(storeData: unknown): PostContent {
    const data = storeData as TweetStoreData;

    const allImageUrls = [
      ...(data.imageUrls || []),
      ...(data.videoThumbnailUrls || []),
    ];

    // Build quote object if quoted tweet exists
    let quote: QuoteContent | null = null;
    if (data.quotedTweet) {
      const qt = data.quotedTweet;
      quote = {
        textHtml: '', // Store doesn't have HTML formatting; DOM fallback will provide this
        author: qt.userName || '',
        handle: qt.userHandle || '',
        avatarUrl: qt.userAvatarUrl || null,
        timeText: null,
      };
    }

    const author = data.userName || '';
    const handle = data.userHandle || '';
    const text = data.quotedTweet
      ? data.fullText + ' [Quoted: ' + data.quotedTweet.fullText + ']'
      : data.fullText;

    // Merge quoted tweet images
    if (data.quotedTweet?.imageUrls?.length) {
      allImageUrls.push(...data.quotedTweet.imageUrls);
    }

    return {
      text,
      author,
      handle,
      avatarUrl: data.userAvatarUrl || null,
      timeText: null, // Not available in store
      textHtml: '', // Store has plain text; DOM provides HTML
      quote,
      postUrl: data.postUrl || null,
      imageUrls: allImageUrls,
      hasMediaContainer: allImageUrls.length > 0,
      fromStore: true,
    };
  }

  cleanupFilteredPostHtml(tweetContent: HTMLElement, imageUrls: string[]) {
    // Remove any hidden state from the injected post
    const cell = tweetContent.querySelector<HTMLElement>('[data-testid="cellInnerDiv"]');
    if (cell) {
      cell.style.display = '';
      cell.style.position = 'relative';
      cell.style.top = 'auto';
      cell.removeAttribute('data-filtered-by-extension');
    }
    const articles = tweetContent.querySelectorAll('article');
    articles.forEach(art => {
      art.style.display = '';
      art.style.opacity = '1';
      art.style.transform = '';
      art.classList.remove('ff-pending', 'ff-error');
      art.removeAttribute('data-filtered-by-extension');
      const bar = art.querySelector('.post-verification-bar');
      if (bar) bar.remove();
    });

    // Find the media section container
    const firstMediaElement = tweetContent.querySelector('[data-testid="tweetPhoto"], [data-testid="videoPlayer"], img[src*="pbs.twimg.com/media"], video');
    let mediaInsertionPoint: Element | null = null;

    if (firstMediaElement) {
      let container: Element = firstMediaElement;
      while (container.parentElement && !container.parentElement.matches('article, [data-testid="tweet"]')) {
        if (container.parentElement.querySelector('[data-testid="tweetPhoto"], [data-testid="videoPlayer"]') === container ||
            container.parentElement.children.length <= 2) {
          container = container.parentElement;
        } else {
          break;
        }
      }
      mediaInsertionPoint = container;
    }

    // Remove all broken media elements
    const brokenImages = tweetContent.querySelectorAll('img[src*="pbs.twimg.com/media"], img[src*="pbs.twimg.com/ext_tw_video_thumb"], img[src*="pbs.twimg.com/amplify_video_thumb"]');
    brokenImages.forEach(img => img.remove());
    const videos = tweetContent.querySelectorAll('video');
    videos.forEach(video => video.remove());
    const mediaContainers = tweetContent.querySelectorAll('[data-testid="tweetPhoto"], [data-testid="videoPlayer"]');
    mediaContainers.forEach(c => c.remove());

    // Insert fresh images at original media location
    if (imageUrls && imageUrls.length > 0) {
      const newMediaContainer = document.createElement('div');
      newMediaContainer.className = 'slop-media-container';
      imageUrls.forEach(url => {
        const img = document.createElement('img');
        img.src = url;
        img.className = 'slop-media-image';
        img.loading = 'lazy';
        newMediaContainer.appendChild(img);
      });

      if (mediaInsertionPoint && mediaInsertionPoint.parentElement) {
        mediaInsertionPoint.parentElement.insertBefore(newMediaContainer, mediaInsertionPoint);
        mediaInsertionPoint.remove();
      } else {
        const article = tweetContent.querySelector('article');
        if (article) {
          article.appendChild(newMediaContainer);
        } else {
          tweetContent.appendChild(newMediaContainer);
        }
      }
    } else if (mediaInsertionPoint) {
      mediaInsertionPoint.remove();
    }
  }

  getShareButton(article: HTMLElement): HTMLElement | null {
    return article.querySelector('button[aria-label="Share post"]');
  }

  insertActionButton(article: HTMLElement, button: HTMLElement): void {
    const shareBtn = this.getShareButton(article);
    if (!shareBtn) return;

    if (shareBtn.closest('[role="group"], [data-testid="tweet"]')) {
      shareBtn.parentElement?.parentElement?.insertAdjacentElement('afterend', button);
    } else {
      shareBtn.insertAdjacentElement('afterend', button);
    }
  }

  getSearchForm(): HTMLElement | null {
    return document.querySelector('form[aria-label="Search"]');
  }
};
