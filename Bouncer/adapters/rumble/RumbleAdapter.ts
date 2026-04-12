import type { PlatformAdapter, PlatformSelectors, PostContent } from '../../src/types';

window.BouncerAdapter = class RumbleAdapter implements PlatformAdapter {
  siteId = 'rumble' as const;

  selectors: PlatformSelectors = {
    post: '.videostream, .video-listing-entry, .video-item, article.video-item',
    sidebar: '.sidebar, aside',
    sidebarContent: '.sidebar > div, aside > div',
    primaryColumn: '.main-content, .container-fluid, main',
    nav: 'header, .header, nav.navbar',
    bottomBar: 'footer, .footer',
    mutations: '.video-item--title, .videostream-title, h3 a',
    textContent: '.video-item--title, .videostream-title, h3 a',
  };

  extractPostContent(article: HTMLElement): PostContent {
    const titleEl = article.querySelector('.video-item--title a, .videostream-title a, h3 a, .title a') as HTMLAnchorElement | null;
    const title = titleEl?.textContent?.trim() || article.querySelector('h3')?.textContent?.trim() || '';
    const channelEl = article.querySelector('.video-item--by a, .videostream-channel a, .channel-name a, .video-item--meta a[href*="/c/"], .video-item--meta a[href*="/user/"]');
    const channel = channelEl?.textContent?.trim() || '';
    const viewsEl = article.querySelector('.video-item--views, .videostream-views, .video-item--meta');
    const views = viewsEl?.textContent?.trim() || '';
    const durationEl = article.querySelector('.video-item--duration, .videostream-duration, .duration');
    const duration = durationEl?.textContent?.trim() || '';
    const categoryEl = article.querySelector('.video-item--category, .category-tag');
    const category = categoryEl?.textContent?.trim() || '';
    const parts = [title];
    if (category) parts.push(`Category: ${category}`);
    if (duration) parts.push(duration);
    if (views) parts.push(views);
    const thumbEl = article.querySelector('img.video-item--img, img.videostream-img, .thumbnail-image img, img[src*="thumb"]') as HTMLImageElement | null;
    const thumbUrl = thumbEl?.src || thumbEl?.getAttribute('data-src') || '';
    const imageUrls = thumbUrl && !thumbUrl.startsWith('data:') ? [thumbUrl] : [];
    return {
      text: channel ? `${channel}: ${parts.join(' | ')}` : parts.join(' | '),
      author: channel,
      handle: channel,
      avatarUrl: null,
      timeText: article.querySelector('time, .video-item--time')?.textContent?.trim() || null,
      textHtml: titleEl?.innerHTML || title,
      quote: null,
      postUrl: titleEl?.href || null,
      imageUrls,
      hasMediaContainer: imageUrls.length > 0,
    };
  }

  shouldProcessCurrentPage(): boolean {
    const path = window.location.pathname;
    return path === '/' || path.startsWith('/browse') || path.startsWith('/search') ||
      path.startsWith('/c/') || path.startsWith('/user/') || path.startsWith('/category') ||
      path.startsWith('/editor-picks') || path.startsWith('/trending') || path.startsWith('/videos');
  }

  isMainPost(): boolean { return false; }

  getPostUrl(article: HTMLElement): string | null {
    return (article.querySelector('.video-item--title a, .videostream-title a, h3 a, .title a') as HTMLAnchorElement | null)?.href || null;
  }

  getPostContentKey(article: HTMLElement): string {
    return this.getPostUrl(article) || article.querySelector('h3, .video-item--title')?.textContent?.substring(0, 200) || '';
  }

  getPostContainer(article: HTMLElement): HTMLElement { return article; }

  hidePost(article: HTMLElement): void {
    article.style.display = 'none';
    article.dataset.filteredByExtension = 'true';
  }

  getThemeMode(): 'light' | 'dim' | 'dark' {
    if (document.body.classList.contains('dark-theme') || document.documentElement.classList.contains('dark')) return 'dark';
    return 'light';
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
    const meta = article.querySelector('.video-item--meta, .video-item--info, .videostream-info');
    if (meta) meta.appendChild(button);
  }

  getSearchForm(): HTMLElement | null {
    return document.querySelector('form[action="/search/video"], .search-form, [role="search"]');
  }
};
