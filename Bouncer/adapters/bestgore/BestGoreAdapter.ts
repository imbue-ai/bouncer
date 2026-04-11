import type { PlatformAdapter, PlatformSelectors, PostContent } from '../../src/types';

window.BouncerAdapter = class BestGoreAdapter implements PlatformAdapter {
  siteId = 'bestgore' as const;

  selectors: PlatformSelectors = {
    post: 'my-video-miniature, my-video-list-item',
    sidebar: 'my-recommended-videos, .other-videos',
    sidebarContent: 'my-recommended-videos > div, .other-videos > div',
    primaryColumn: '.videos, .video-list, my-videos-list',
    nav: 'my-header, header, .header',
    bottomBar: 'my-footer, footer',
    mutations: '.video-miniature-name, a.video-miniature-name',
    textContent: '.video-miniature-name, a.video-miniature-name',
  };

  extractPostContent(article: HTMLElement): PostContent {
    const nameEl = article.querySelector('.video-miniature-name, a.video-miniature-name') as HTMLAnchorElement | null;
    const title = nameEl?.textContent?.trim() || nameEl?.getAttribute('title') || '';
    const channelEl = article.querySelector('.video-miniature-channel a, .video-miniature-account a');
    const channel = channelEl?.textContent?.trim() || '';
    const viewsEl = article.querySelector('.video-miniature-created-at-views, .video-miniature-views');
    const views = viewsEl?.textContent?.trim() || '';
    const durationEl = article.querySelector('.video-miniature-duration, .video-duration');
    const duration = durationEl?.textContent?.trim() || '';
    const categoryEl = article.querySelector('.video-miniature-category, .category');
    const category = categoryEl?.textContent?.trim() || '';
    const parts = [title];
    if (category) parts.push(`Category: ${category}`);
    if (duration) parts.push(duration);
    if (views) parts.push(views);
    const thumbEl = article.querySelector('img.video-thumbnail-image, my-video-thumbnail img, .video-thumbnail img') as HTMLImageElement | null;
    const thumbUrl = thumbEl?.src || thumbEl?.getAttribute('data-src') || '';
    const imageUrls = thumbUrl && !thumbUrl.startsWith('data:') ? [thumbUrl] : [];
    const avatarEl = channelEl?.closest('.video-miniature-information')?.querySelector('img, my-actor-avatar img') as HTMLImageElement | null;
    return {
      text: channel ? `${channel}: ${parts.join(' | ')}` : parts.join(' | '),
      author: channel,
      handle: channel,
      avatarUrl: avatarEl?.src || null,
      timeText: null,
      textHtml: nameEl?.innerHTML || title,
      quote: null,
      postUrl: this.getPostUrl(article),
      imageUrls,
      hasMediaContainer: imageUrls.length > 0,
    };
  }

  shouldProcessCurrentPage(): boolean {
    const path = window.location.pathname;
    return path === '/' || path.startsWith('/videos') || path.startsWith('/w/') ||
      path.startsWith('/search') || path.startsWith('/video-channels') ||
      path.startsWith('/c/') || path.startsWith('/a/');
  }

  isMainPost(): boolean { return false; }

  getPostUrl(article: HTMLElement): string | null {
    const link = article.querySelector('.video-miniature-name[href], a.video-miniature-name, my-video-thumbnail a, .video-thumbnail a') as HTMLAnchorElement | null;
    return link?.href || null;
  }

  getPostContentKey(article: HTMLElement): string {
    return this.getPostUrl(article) ||
      article.querySelector('.video-miniature-name')?.textContent?.substring(0, 200) || '';
  }

  getPostContainer(article: HTMLElement): HTMLElement { return article; }

  hidePost(article: HTMLElement): void {
    article.style.display = 'none';
    article.dataset.filteredByExtension = 'true';
  }

  getThemeMode(): 'light' | 'dim' | 'dark' {
    const bg = window.getComputedStyle(document.body).backgroundColor;
    const m = bg.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
    if (m && Number(m[1]) > 200 && Number(m[2]) > 200 && Number(m[3]) > 200) return 'light';
    return 'dark';
  }

  async extractPostContentFromStore(article: HTMLElement): Promise<PostContent | null> {
    return this.extractPostContent(article);
  }

  cleanupFilteredPostHtml(el: HTMLElement): void {
    el.style.display = '';
    el.removeAttribute('data-filtered-by-extension');
  }

  getShareButton(): HTMLElement | null { return null; }

  insertActionButton(article: HTMLElement, button: HTMLElement): void {
    const info = article.querySelector('.video-miniature-information');
    if (info) info.appendChild(button);
  }

  getSearchForm(): HTMLElement | null {
    return document.querySelector('my-search-typeahead input, .search-input input, [role="search"]');
  }
};
