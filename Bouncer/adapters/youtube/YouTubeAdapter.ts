import type {
  FilterBoxAnchor,
  PlatformAdapter,
  PlatformSelectors,
  PostContent,
} from '../../src/types';

interface LockupStoreData {
  kind?: 'video' | 'ad' | 'short';
  videoId: string | null;
  title: string;
  channelName: string;
  channelHandle: string;
  channelBrowseId: string;
  avatarUrl: string | null;
  thumbnailUrl: string | null;
  duration: string | null;
  metadataRows: string[];
  postUrl: string | null;
  skip?: boolean;
  reason?: string;
}

interface StoreResult {
  requestId: string;
  success: boolean;
  data?: LockupStoreData;
  error?: string;
}

function getVideoIdFromContentIdClass(article: HTMLElement): string | null {
  const host = article.querySelector('[class*="content-id-"]');
  if (!host) return null;
  for (const cls of host.classList) {
    if (cls.startsWith('content-id-')) return cls.slice('content-id-'.length);
  }
  return null;
}

window.BouncerAdapter = class YouTubeAdapter implements PlatformAdapter {
  siteId = 'youtube' as const;
  filterBoxPlacement = 'banner' as const;

  selectors: PlatformSelectors = {
    post: 'ytd-rich-item-renderer',
    sidebar: '',
    sidebarContent: '',
    primaryColumn: '#primary',
    nav: '',
    bottomBar: '',
    // `yt-lockup-view-model` getting added to a rich item is the signal that
    // its data is hydrated. Used for DOM-recycling re-evaluation.
    mutations: 'yt-lockup-view-model',
    textContent: '.ytLockupMetadataViewModelTitle',
  };

  private _extractorReady = false;
  private _pendingStoreRequests = new Map<string, (result: StoreResult) => void>();

  constructor() {
    this._initLockupExtractor();
    this._initFilteredPostObserver();
  }

  shouldProcessCurrentPage(): boolean {
    // Phase 1: home feed only.
    const path = window.location.pathname;
    return path === '/' || path === '';
  }

  getFilterBoxAnchor(): FilterBoxAnchor | null {
    const grid = document.querySelector<HTMLElement>('ytd-rich-grid-renderer');
    if (!grid) return null;
    const contents = grid.querySelector<HTMLElement>('#contents');
    if (contents && contents.parentElement === grid) {
      return { parent: grid, insertBefore: contents };
    }
    return { parent: grid, insertBefore: null };
  }

  getThemeMode(): 'light' | 'dim' | 'dark' {
    if (document.documentElement.hasAttribute('dark')) return 'dark';
    const bg = window.getComputedStyle(document.body).backgroundColor;
    const match = bg.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
    if (match) {
      const [, r, g, b] = match.map(Number);
      if (r < 50 && g < 50 && b < 50) return 'dark';
    }
    return 'light';
  }

  getSearchForm(): HTMLElement | null {
    return document.querySelector<HTMLElement>('ytd-searchbox');
  }

  isMainPost(_article: HTMLElement): boolean { return false; }

  getPostUrl(article: HTMLElement): string | null {
    const id = getVideoIdFromContentIdClass(article);
    if (id) return 'https://www.youtube.com/watch?v=' + id;
    const a = article.querySelector<HTMLAnchorElement>('a.ytLockupViewModelContentImage[href*="/watch?v="]');
    if (a) {
      try {
        const u = new URL(a.href, location.origin);
        const v = u.searchParams.get('v');
        if (v) return 'https://www.youtube.com/watch?v=' + v;
      } catch { /* malformed href */ }
    }
    return null;
  }

  getPostContentKey(article: HTMLElement): string {
    const id = getVideoIdFromContentIdClass(article);
    if (id) return 'yt:' + id;
    return article.querySelector(this.selectors.textContent)?.textContent?.slice(0, 200) || '';
  }

  getPostContainer(article: HTMLElement): HTMLElement {
    return article;
  }

  hidePost(article: HTMLElement): void {
    const el = this.getPostContainer(article);
    const rect = el.getBoundingClientRect();
    el.dataset.filteredByExtension = 'true';
    if (rect.bottom > 0) {
      el.style.display = 'none';
    }
    // Above-viewport posts get faded out by the scroll handler in
    // _initFilteredPostObserver so users don't see the layout jump.
  }

  // Same fade-on-scroll pattern as TwitterAdapter — keeps off-screen
  // filtered items from causing a visible jump when they come into view.
  private _initFilteredPostObserver() {
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
    const titleEl = article.querySelector<HTMLElement>('.ytLockupMetadataViewModelTitle');
    const text = (titleEl?.textContent || '').replace(/\s+/g, ' ').trim();
    const textHtml = titleEl?.innerHTML || '';

    // First metadata row is channel; subsequent rows are views/age.
    const rows = article.querySelectorAll<HTMLElement>('.ytContentMetadataViewModelMetadataRow');
    const channelLink = rows[0]?.querySelector<HTMLAnchorElement>('a');
    const author = (channelLink?.textContent || '').replace(/\s+/g, ' ').trim();
    const handle = channelLink?.getAttribute('href') || '';

    const avatarImg = article.querySelector<HTMLImageElement>('.ytSpecAvatarShapeImage');
    const avatarSrc = avatarImg?.src || '';
    const avatarUrl = avatarSrc && !avatarSrc.startsWith('data:') ? avatarSrc : null;

    const rowTexts: string[] = [];
    rows.forEach((r, i) => {
      if (i === 0) return;
      const t = r.textContent?.replace(/\s+/g, ' ').trim();
      if (t) rowTexts.push(t);
    });
    const timeText = rowTexts.join(' • ') || null;

    const thumbImg = article.querySelector<HTMLImageElement>('yt-thumbnail-view-model img.ytCoreImageHost');
    const thumbSrc = thumbImg?.src || '';
    const imageUrls = thumbSrc && !thumbSrc.startsWith('data:') ? [thumbSrc] : [];

    return {
      text,
      author,
      handle,
      avatarUrl,
      timeText,
      textHtml,
      quote: null,
      postUrl: this.getPostUrl(article),
      imageUrls,
      hasMediaContainer: imageUrls.length > 0,
    };
  }

  private _initLockupExtractor() {
    if (this._extractorReady) return;
    this._extractorReady = true;

    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('adapters/youtube/lockup-extractor.js');
    (document.head || document.documentElement).appendChild(script);
    script.onload = () => script.remove();

    document.addEventListener('ff-youtube-data-result', (e) => {
      try {
        const detail = (e as CustomEvent).detail as string;
        const result: StoreResult = JSON.parse(detail) as StoreResult;
        const resolve = this._pendingStoreRequests.get(result.requestId);
        if (resolve) {
          this._pendingStoreRequests.delete(result.requestId);
          resolve(result);
        }
      } catch (err) {
        console.log('[Bouncer][YT][Store] Parse error:', err);
      }
    });
  }

  async extractPostContentFromStore(article: HTMLElement): Promise<PostContent | null> {
    const vid = getVideoIdFromContentIdClass(article);
    const data = await this._requestStoreData(article);
    if (!data) {
      console.log('[Bouncer][YT] store: no data', { videoId: vid });
      return null;
    }
    if (data.skip) {
      console.log('[Bouncer][YT] store: skip', { videoId: vid, reason: data.reason });
      return null;
    }
    return this._normalize(data, article);
  }

  private _requestStoreData(article: HTMLElement): Promise<LockupStoreData | null> {
    const requestId = 'ff-yt-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this._pendingStoreRequests.delete(requestId);
        console.log('[Bouncer][YT] store: timeout', { requestId });
        resolve(null);
      }, 200);

      this._pendingStoreRequests.set(requestId, (result) => {
        clearTimeout(timeout);
        if (result.success && result.data) {
          resolve(result.data);
        } else {
          console.log('[Bouncer][YT] store: bridge error', { requestId, error: result.error });
          resolve(null);
        }
      });

      article.setAttribute('data-ff-request', requestId);
      document.dispatchEvent(new CustomEvent('ff-extract-youtube-data'));
    });
  }

  private _normalize(data: LockupStoreData, article: HTMLElement): PostContent {
    // Compose the classifier input: title + channel + view/age context.
    // Description doesn't exist on the lockup, so this is the full text surface.
    const parts: string[] = [];
    if (data.title) parts.push(data.title);
    for (const r of data.metadataRows) parts.push(r);
    let text = parts.join(' — ').trim();
    if (data.kind === 'ad' && text) text = `[Sponsored] ${text}`;

    // Set textHtml directly to the title so the filtered-posts panel doesn't
    // fall back to `formatPostForEvaluation` (which prefixes with "author: ").
    // For organic videos the DOM merge in index.ts replaces this with the
    // rich title HTML; for shorts/ads the DOM selectors don't match so this
    // is the only source of the display text.
    let textHtml = data.title || '';
    if (data.kind === 'ad' && textHtml) textHtml = `[Sponsored] ${textHtml}`;

    const imageUrls = data.thumbnailUrl ? [data.thumbnailUrl] : [];

    return {
      text,
      author: data.channelName || '',
      handle: data.channelHandle || data.channelBrowseId || '',
      avatarUrl: data.avatarUrl || null,
      timeText: data.metadataRows[data.metadataRows.length - 1] || null,
      textHtml,
      quote: null,
      postUrl: data.postUrl || this.getPostUrl(article),
      imageUrls,
      hasMediaContainer: imageUrls.length > 0,
      fromStore: true,
    };
  }

  cleanupFilteredPostHtml(el: HTMLElement, imageUrls: string[]): void {
    // Reset filtered-state styling on the re-injected snippet.
    const containers = el.querySelectorAll<HTMLElement>('ytd-rich-item-renderer');
    containers.forEach(c => {
      c.style.display = '';
      c.style.opacity = '1';
      c.removeAttribute('data-filtered-by-extension');
    });

    // Replace the thumbnail (which has lazy/blob src state) with a fresh <img>
    // so the filtered-posts panel can render it reliably.
    const thumb = el.querySelector<HTMLElement>('yt-thumbnail-view-model');
    if (thumb && imageUrls.length > 0) {
      const container = document.createElement('div');
      container.className = 'slop-media-container';
      const img = document.createElement('img');
      img.src = imageUrls[0];
      img.className = 'slop-media-image';
      img.loading = 'lazy';
      container.appendChild(img);
      thumb.replaceWith(container);
    }
  }

  getShareButton(article: HTMLElement): HTMLElement | null {
    // The three-dots menu is the only per-card action button in the lockup;
    // we anchor our action button next to it.
    return article.querySelector<HTMLElement>('.ytLockupMetadataViewModelMenuButton button');
  }

  insertActionButton(article: HTMLElement, button: HTMLElement): void {
    const menu = article.querySelector<HTMLElement>('.ytLockupMetadataViewModelMenuButton');
    if (!menu || !menu.parentElement) return;
    menu.parentElement.insertBefore(button, menu);
  }
};
