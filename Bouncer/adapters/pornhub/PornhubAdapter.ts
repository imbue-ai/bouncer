import type { PlatformAdapter, PlatformSelectors, PostContent } from '../../src/types';

window.BouncerAdapter = class PornhubAdapter implements PlatformAdapter {
  siteId = 'pornhub' as const;

  selectors: PlatformSelectors = {
    post: 'li.pcVideoListItem, li.videoblock, div.videoBox',
    sidebar: '#rightSide, .sidebar',
    sidebarContent: '#rightSide > div, .sidebar > div',
    primaryColumn: '#main-container, .nf-videos',
    nav: '#headerWrapper',
    bottomBar: '#footer',
    mutations: '.title a',
    textContent: '.title a',
  };

  extractPostContent(article: HTMLElement): PostContent {
    const titleEl = article.querySelector('.title a') as HTMLAnchorElement | null;
    const title = titleEl?.textContent?.trim() || titleEl?.getAttribute('title') || '';
    const uploader = article.querySelector('.usernameWrap a')?.textContent?.trim() || '';
    const views = article.querySelector('.views, var.views')?.textContent?.trim() || '';
    const duration = article.querySelector('.duration, var.duration')?.textContent?.trim() || '';
    const tagEls = article.querySelectorAll('.tags a');
    const tags = Array.from(tagEls).map(t => t.textContent?.trim()).filter(Boolean).join(', ');
    const parts = [title];
    if (tags) parts.push(`Tags: ${tags}`);
    if (duration) parts.push(duration);
    if (views) parts.push(views);
    const thumbEl = article.querySelector('img.thumb, img.js-videoThumb, .phimage img') as HTMLImageElement | null;
    const thumbUrl = thumbEl?.getAttribute('data-thumb_url') || thumbEl?.src || '';
    const imageUrls = thumbUrl && !thumbUrl.startsWith('data:') ? [thumbUrl] : [];
    return {
      text: parts.join(' | '),
      author: uploader,
      handle: uploader,
      avatarUrl: null,
      timeText: null,
      textHtml: titleEl?.innerHTML || title,
      quote: null,
      postUrl: titleEl?.href || null,
      imageUrls,
      hasMediaContainer: imageUrls.length > 0,
    };
  }

  shouldProcessCurrentPage(): boolean {
    const path = window.location.pathname;
    return path === '/' || path.startsWith('/categories') || path.startsWith('/video') ||
      path.startsWith('/search') || path.startsWith('/recommended') ||
      path.startsWith('/pornstar') || path.startsWith('/channels') || path.startsWith('/model');
  }

  isMainPost(): boolean { return false; }

  getPostUrl(article: HTMLElement): string | null {
    return (article.querySelector('.title a, a[href*="viewkey"]') as HTMLAnchorElement | null)?.href || null;
  }

  getPostContentKey(article: HTMLElement): string {
    return article.getAttribute('data-video-vkey') || this.getPostUrl(article) ||
      article.querySelector('.title a')?.textContent?.substring(0, 200) || '';
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
    const info = article.querySelector('.thumbnail-info-wrapper');
    if (info) info.appendChild(button);
  }

  getSearchForm(): HTMLElement | null {
    return document.querySelector('#search-form, form[action*="search"]');
  }
};
