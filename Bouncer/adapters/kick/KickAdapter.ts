import type { PlatformAdapter, PlatformSelectors, PostContent } from '../../src/types';

window.BouncerAdapter = class KickAdapter implements PlatformAdapter {
  siteId = 'kick' as const;

  selectors: PlatformSelectors = {
    post: '[class*="StreamCard"], [class*="stream-card"], [class*="video-card"], [class*="clip-card"], a[href*="/video/"]',
    sidebar: '[class*="sidebar"], aside',
    sidebarContent: '[class*="sidebar"] > div, aside > div',
    primaryColumn: 'main, [class*="main-content"], [class*="feed"]',
    nav: 'header, nav, [class*="navbar"]',
    bottomBar: 'footer',
    mutations: '[class*="stream-title"], [class*="card-title"], h3',
    textContent: '[class*="stream-title"], [class*="card-title"], h3',
  };

  extractPostContent(article: HTMLElement): PostContent {
    const titleEl = this._q(article, 'stream-title, card-title, video-title, clip-title') || article.querySelector('h3, h2, [class*="title"]');
    const title = titleEl?.textContent?.trim() || '';
    const channelEl = this._q(article, 'channel-name, streamer-name, username') || article.querySelector('a[href^="/"] span, [class*="user"] span');
    const channel = channelEl?.textContent?.trim() || '';
    const categoryEl = this._q(article, 'category, game-name, tag');
    const category = categoryEl?.textContent?.trim() || '';
    const viewerEl = this._q(article, 'viewer, views');
    const viewers = viewerEl?.textContent?.trim() || '';
    const parts = [title];
    if (category) parts.push(`Category: ${category}`);
    if (viewers) parts.push(viewers);
    const thumbEl = article.querySelector('img[src*="thumb"], img[src*="stream"], img[src*="kick"], img[class*="thumbnail"]') as HTMLImageElement | null;
    const thumbUrl = thumbEl?.src || thumbEl?.getAttribute('data-src') || '';
    const imageUrls = thumbUrl && !thumbUrl.startsWith('data:') ? [thumbUrl] : [];
    const avatarEl = article.querySelector('img[class*="avatar"], img[alt*="avatar"]') as HTMLImageElement | null;
    return {
      text: channel ? `${channel}: ${parts.join(' | ')}` : parts.join(' | '),
      author: channel,
      handle: channel,
      avatarUrl: avatarEl?.src || null,
      timeText: null,
      textHtml: titleEl?.innerHTML || title,
      quote: null,
      postUrl: this.getPostUrl(article),
      imageUrls,
      hasMediaContainer: imageUrls.length > 0,
    };
  }

  private _q(el: HTMLElement, partials: string): HTMLElement | null {
    for (const p of partials.split(', ')) {
      const found = el.querySelector(`[class*="${p}"]`) as HTMLElement | null;
      if (found) return found;
    }
    return null;
  }

  shouldProcessCurrentPage(): boolean {
    const path = window.location.pathname;
    return path === '/' || path.startsWith('/browse') || path.startsWith('/categories') ||
      path.startsWith('/search') || path.startsWith('/directory') || /^\/[a-zA-Z0-9_-]+\/?$/.test(path);
  }

  isMainPost(): boolean { return false; }

  getPostUrl(article: HTMLElement): string | null {
    if (article.tagName === 'A') return (article as HTMLAnchorElement).href;
    const link = article.querySelector('a[href]') as HTMLAnchorElement | null;
    return link?.href || null;
  }

  getPostContentKey(article: HTMLElement): string {
    return this.getPostUrl(article) || article.querySelector('h3, h2, [class*="title"]')?.textContent?.substring(0, 200) || '';
  }

  getPostContainer(article: HTMLElement): HTMLElement { return article; }

  hidePost(article: HTMLElement): void {
    article.style.display = 'none';
    article.dataset.filteredByExtension = 'true';
  }

  getThemeMode(): 'light' | 'dim' | 'dark' { return 'dark'; }

  async extractPostContentFromStore(article: HTMLElement): Promise<PostContent | null> {
    return this.extractPostContent(article);
  }

  cleanupFilteredPostHtml(el: HTMLElement): void {
    el.style.display = '';
    el.removeAttribute('data-filtered-by-extension');
  }

  getShareButton(): HTMLElement | null { return null; }

  insertActionButton(article: HTMLElement, button: HTMLElement): void {
    const info = this._q(article, 'stream-info, card-info, meta') || article;
    info.appendChild(button);
  }

  getSearchForm(): HTMLElement | null {
    return document.querySelector('[role="search"], input[type="search"], form[action*="search"]');
  }
};
