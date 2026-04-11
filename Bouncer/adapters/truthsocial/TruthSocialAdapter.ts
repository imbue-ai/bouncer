import type { PlatformAdapter, PlatformSelectors, PostContent } from '../../src/types';

window.BouncerAdapter = class TruthSocialAdapter implements PlatformAdapter {
  siteId = 'truthsocial' as const;

  selectors: PlatformSelectors = {
    post: '[data-testid="status"]',
    sidebar: 'aside',
    sidebarContent: 'aside > div',
    primaryColumn: '[role="main"], main',
    nav: '[role="banner"], nav',
    bottomBar: '[role="navigation"]',
    mutations: '.status--content-wrapper',
    textContent: '.status--content-wrapper',
  };

  extractPostContent(article: HTMLElement): PostContent {
    const statusEl = article.querySelector('.status') || article;
    const accountEl = statusEl.querySelector('[data-testid="account"]');
    const nameEl = accountEl?.querySelector('[class*="truncate"]');
    const displayName = nameEl?.textContent?.trim() || '';
    let handle = '';
    accountEl?.querySelectorAll('span').forEach(s => {
      const t = s.textContent?.trim() || '';
      if (t.startsWith('@')) handle = t;
    });
    const avatarEl = accountEl?.querySelector('img') as HTMLImageElement | null;
    const avatarUrl = avatarEl?.src || null;
    const timeEl = statusEl.querySelector('time');
    const timeText = timeEl?.textContent?.trim() || null;
    const contentEl = statusEl.querySelector('.status--content-wrapper');
    const markupEl = contentEl?.querySelector('div[tabindex]');
    const text = markupEl?.textContent?.trim() || contentEl?.textContent?.trim() || '';
    const textHtml = markupEl?.innerHTML || '';
    const imageEls = statusEl.querySelectorAll('.media-gallery img, .status-media img, video[poster]');
    const imageUrls: string[] = [];
    imageEls.forEach(el => {
      const url = (el as HTMLImageElement).src || (el as HTMLVideoElement).poster || '';
      if (url && !imageUrls.includes(url)) imageUrls.push(url);
    });
    return {
      text: displayName ? `${displayName}: ${text}` : text,
      author: displayName,
      handle,
      avatarUrl,
      timeText,
      textHtml,
      quote: null,
      postUrl: this.getPostUrl(article),
      imageUrls,
      hasMediaContainer: imageUrls.length > 0 || !!statusEl.querySelector('video, [class*="media"]'),
    };
  }

  shouldProcessCurrentPage(): boolean {
    const path = window.location.pathname;
    return path === '/' || path === '/home' || path.startsWith('/explore') ||
      path.startsWith('/search') || path.startsWith('/@') || path.startsWith('/group');
  }

  isMainPost(article: HTMLElement): boolean {
    return /^\/@[^/]+\/posts\/\d+/.test(window.location.pathname) &&
      article === document.querySelector(this.selectors.post);
  }

  getPostUrl(article: HTMLElement): string | null {
    const wrapper = article.querySelector('.status--wrapper, [data-id]');
    const id = wrapper?.getAttribute('data-id');
    const accountEl = article.querySelector('[data-testid="account"] a[href^="/@"]') as HTMLAnchorElement | null;
    if (id && accountEl) return `${accountEl.getAttribute('href')}/posts/${id}`;
    const timeLink = article.querySelector('time')?.closest('a') as HTMLAnchorElement | null;
    return timeLink?.href || null;
  }

  getPostContentKey(article: HTMLElement): string {
    const wrapper = article.querySelector('[data-id]');
    return wrapper?.getAttribute('data-id') || this.getPostUrl(article) ||
      article.querySelector('.status--content-wrapper')?.textContent?.substring(0, 200) || '';
  }

  getPostContainer(article: HTMLElement): HTMLElement { return article; }

  hidePost(article: HTMLElement): void {
    article.style.display = 'none';
    article.dataset.filteredByExtension = 'true';
  }

  getThemeMode(): 'light' | 'dim' | 'dark' {
    if (document.documentElement.classList.contains('dark')) return 'dark';
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

  getShareButton(article: HTMLElement): HTMLElement | null {
    return article.querySelector('button[aria-label*="share" i], button[aria-label*="more" i]');
  }

  insertActionButton(article: HTMLElement, button: HTMLElement): void {
    const actions = article.querySelector('[class*="action-bar"], [class*="StatusActionBar"]');
    if (actions) actions.appendChild(button);
  }

  getSearchForm(): HTMLElement | null {
    return document.querySelector('[role="search"], form[action*="search"]');
  }
};
