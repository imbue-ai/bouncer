import type { PlatformAdapter, PlatformSelectors, PostContent } from '../../src/types';

window.BouncerAdapter = class EightchanAdapter implements PlatformAdapter {
  siteId = 'eightchan' as const;

  selectors: PlatformSelectors = {
    post: '.post.op, .post.reply',
    sidebar: '.boardlist',
    sidebarContent: '.boardlist',
    primaryColumn: 'form[name="postcontrols"]',
    nav: '.boardlist:first-of-type',
    bottomBar: '.boardlist.bottom',
    mutations: '.body',
    textContent: '.body',
  };

  extractPostContent(article: HTMLElement): PostContent {
    const introEl = article.querySelector('.intro');
    const name = article.querySelector('.name')?.textContent?.trim() || 'Anonymous';
    const trip = article.querySelector('.trip')?.textContent?.trim() || '';
    const posterId = article.querySelector('.poster_id')?.textContent?.trim() || '';
    const subject = article.querySelector('.subject')?.textContent?.trim() || '';
    const bodyEl = article.querySelector('.body');
    const text = bodyEl?.textContent?.trim() || '';
    const textHtml = bodyEl?.innerHTML || '';
    const timeEl = introEl?.querySelector('time');
    const thumbEl = article.querySelector('.post-image, img[src*="/thumb/"]') as HTMLImageElement | null;
    const thumbUrl = thumbEl?.src || '';
    const imageUrls = thumbUrl && !thumbUrl.startsWith('data:') ? [thumbUrl] : [];
    const fullText = subject ? `${subject}: ${text}` : text;
    const author = trip ? `${name} ${trip}` : (posterId ? `${name} ID:${posterId}` : name);
    return {
      text: fullText,
      author,
      handle: name,
      avatarUrl: null,
      timeText: timeEl?.getAttribute('datetime') || timeEl?.textContent?.trim() || null,
      textHtml,
      quote: null,
      postUrl: this.getPostUrl(article),
      imageUrls,
      hasMediaContainer: imageUrls.length > 0,
    };
  }

  shouldProcessCurrentPage(): boolean {
    const path = window.location.pathname;
    return path === '/' || /^\/[a-z0-9]+\/(index|catalog|res\/)/.test(path) ||
      /^\/[a-z0-9]+\/?$/.test(path);
  }

  isMainPost(article: HTMLElement): boolean {
    if (!/\/res\//.test(window.location.pathname)) return false;
    return article.classList.contains('op');
  }

  getPostUrl(article: HTMLElement): string | null {
    const postNo = article.querySelector('a.post_no[href]') as HTMLAnchorElement | null;
    return postNo?.href || null;
  }

  getPostContentKey(article: HTMLElement): string {
    return article.id || this.getPostUrl(article) ||
      article.querySelector('.body')?.textContent?.substring(0, 200) || '';
  }

  getPostContainer(article: HTMLElement): HTMLElement { return article; }

  hidePost(article: HTMLElement): void {
    article.style.display = 'none';
    article.dataset.filteredByExtension = 'true';
  }

  getThemeMode(): 'light' | 'dim' | 'dark' {
    const sheet = document.body.getAttribute('data-stylesheet') || '';
    if (/dark|tomorrow|cyberpunk/i.test(sheet)) return 'dark';
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
    const intro = article.querySelector('.intro');
    if (intro) intro.appendChild(button);
  }

  getSearchForm(): HTMLElement | null {
    return document.querySelector('form[action*="search"], .fa-search')?.closest('form') || null;
  }
};
