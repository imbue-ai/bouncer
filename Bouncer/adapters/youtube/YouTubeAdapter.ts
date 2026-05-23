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

// YouTube's signed `oar*.jpg` thumbnail variants (used for Shorts and ads)
// serve AVIF despite the `.jpg` extension, and Anthropic/OpenAI both reject
// AVIF (only image/{jpeg,png,gif,webp} supported). Use the canonical
// `mqdefault.jpg` endpoint (320×180, unsigned, stable JPEG) for the classifier
// payload only — the filtered-posts panel uses the original lockup URL since
// browsers render AVIF fine.
function canonicalThumbnailUrl(videoId: string): string {
  return `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;
}

// Builds the `imageUrls` / `displayImageUrls` pair for a YouTube post.
// `imageUrls` is the classifier payload (JPEG-guaranteed via canonical
// mqdefault when we have a video ID). `displayImageUrls` is the original
// lockup URL for the filtered-posts panel, when available.
function buildThumbnailUrls(
  videoId: string | null,
  originalUrl: string | null | undefined,
): { imageUrls: string[]; displayImageUrls: string[] | undefined } {
  const hasOriginal = !!originalUrl && !originalUrl.startsWith('data:');
  if (videoId) {
    return {
      imageUrls: [canonicalThumbnailUrl(videoId)],
      displayImageUrls: hasOriginal ? [originalUrl] : undefined,
    };
  }
  if (hasOriginal) {
    return { imageUrls: [originalUrl], displayImageUrls: undefined };
  }
  return { imageUrls: [], displayImageUrls: undefined };
}

window.BouncerAdapter = class YouTubeAdapter implements PlatformAdapter {
  siteId = 'youtube' as const;
  filterBoxPlacement = 'banner' as const;

  selectors: PlatformSelectors = {
    // Two surfaces:
    //   - Home: `ytd-rich-item-renderer` wraps each card in the grid.
    //   - Watch: `yt-lockup-view-model` inside the suggested-videos
    //     container (`ytd-watch-next-secondary-results-renderer`) is the
    //     card itself — no rich-item wrapper on the watch sidebar.
    // The lockup elsewhere on home is NESTED inside rich-item, so the
    // `:not(ytd-rich-item-renderer *)` guard prevents double-matching
    // on the home feed. (Equivalent to "only match standalone lockups.")
    post: 'ytd-rich-item-renderer, ytd-watch-next-secondary-results-renderer yt-lockup-view-model',
    sidebar: '',
    sidebarContent: '',
    primaryColumn: '#primary',
    nav: '',
    bottomBar: '',
    // `yt-lockup-view-model` getting added to a rich item is the signal
    // that its data is hydrated. Used for DOM-recycling re-evaluation,
    // and now also for detecting new watch-sidebar suggestions.
    mutations: 'yt-lockup-view-model',
    textContent: '.ytLockupMetadataViewModelTitle',
  };

  private _extractorReady = false;
  private _pendingStoreRequests = new Map<string, (result: StoreResult) => void>();

  constructor() {
    this._initLockupExtractor();
    this._initFilteredPostObserver();
    this._initMiniGuideEntry();
  }

  // ===== Mini-guide entry =====
  // The full filter box is anchored inline in YT's guide drawer (see
  // `getFilterBoxAnchor`). When the drawer is collapsed to its mini-rail
  // (`ytd-mini-guide-renderer`), we still want users to be able to reach
  // Bouncer — so we inject a Bouncer entry styled to match the native
  // mini-guide entries (Home / Shorts / Subs / You). Clicking it presses
  // YT's own hamburger button, which opens the drawer and reveals the
  // inline box.

  private _countListenerWired = false;

  private _ensureMiniGuideEntry(): HTMLElement | null {
    // Mirror the box's page scope: the mini icon should only appear on
    // pages where clicking it actually leads somewhere useful (i.e. where
    // `shouldProcessCurrentPage` returns true and the inline box exists).
    // On other pages, strip any stale entry so we don't leave dangling UI.
    if (!this.shouldProcessCurrentPage()) {
      const stale = document.querySelector<HTMLElement>('.bouncer-mini-guide-entry');
      stale?.remove();
      return null;
    }

    let entry = document.querySelector<HTMLElement>('.bouncer-mini-guide-entry');
    if (entry && entry.isConnected) return entry;

    const miniItems = document.querySelector<HTMLElement>('ytd-mini-guide-renderer #items');
    if (!miniItems) return null;

    const logoUrl = chrome.runtime.getURL('icons/icon48.png');
    entry = document.createElement('button');
    entry.className = 'bouncer-mini-guide-entry';
    (entry as HTMLButtonElement).type = 'button';
    entry.setAttribute('aria-label', 'Open Bouncer filters');
    entry.innerHTML = `
      <span class="bouncer-mini-guide-entry__icon-wrap">
        <img class="bouncer-mini-guide-entry__icon" src="${logoUrl}" alt="" aria-hidden="true">
        <span class="bouncer-mini-guide-entry__count" aria-hidden="true">0</span>
      </span>
      <span class="bouncer-mini-guide-entry__label">Bouncer</span>
    `;
    entry.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this._jumpToBox();
    });

    // Insert between Shorts and Subscriptions so the order in the mini-rail
    // matches the order in the expanded drawer: Home → Shorts → Bouncer →
    // Subscriptions → You. We anchor against the Subscriptions link rather
    // than a positional index because YT occasionally reshuffles primary
    // tabs (e.g. signed-out users see fewer entries).
    const subsAnchor = miniItems.querySelector<HTMLElement>('a[href="/feed/subscriptions"]')
      ?.closest('ytd-mini-guide-entry-renderer') as HTMLElement | null;
    miniItems.insertBefore(entry, subsAnchor);
    return entry;
  }

  // Mirror the filtered-post count into the mini-guide entry's badge.
  // Listen for the count-changed event dispatched by `updateFilteredTabCount`
  // in shared UI. This decouples the badge from the box's DOM — important
  // on YT because the guide drawer (where the box lives) lazy-hydrates on
  // first open, so DOM-scrape mirrors miss filter activity that happens
  // before the user touches the drawer.
  private _wireFilteredCountListener(): void {
    document.addEventListener('bouncer:filtered-count-changed', (e) => {
      const detail = (e as CustomEvent<{ count: number }>).detail;
      const c = document.querySelector<HTMLElement>('.bouncer-mini-guide-entry__count');
      if (!c) return;
      const n = String(detail?.count ?? 0);
      if (c.textContent !== n) c.textContent = n;
      c.classList.toggle('bouncer-mini-guide-entry__count--nonzero', n !== '0');
    });
  }

  // Click handler for the mini-guide entry. The inline box is the single
  // source of truth — the mini icon is a "jump to" shortcut, not a real
  // tab. If the drawer is collapsed (box hidden), open it before scrolling.
  private _jumpToBox() {
    const scrollAndFocus = () => {
      const b = document.querySelector<HTMLElement>('.filter-phrases-banner--youtube');
      if (!b) return;
      b.scrollIntoView({ behavior: 'smooth', block: 'center' });
      const input = b.querySelector<HTMLInputElement>('.filter-phrases-input');
      input?.focus({ preventScroll: true });
    };

    const box = document.querySelector<HTMLElement>('.filter-phrases-banner--youtube');
    const rect = box?.getBoundingClientRect();
    const boxInViewport =
      !!rect
      && rect.width > 0
      && rect.height > 0
      && rect.right > 0
      && rect.left < window.innerWidth
      && rect.bottom > 0
      && rect.top < window.innerHeight;

    // Only try to open the drawer when the box is actually inside it.
    // On the watch page the box lives in `#secondary` (always visible),
    // so opening the drawer would be a no-op that covers part of the
    // page with an empty drawer.
    const boxInDrawer = !!box && !!box.closest('tp-yt-app-drawer#guide');
    if (boxInViewport || !boxInDrawer) {
      scrollAndFocus();
      return;
    }

    // YT wraps its hamburger in a Polymer `yt-icon-button` whose id is
    // `guide-button`; the actual <button> is nested inside. The first
    // selector targets that inner button. The fallbacks cover older or
    // future YT builds where the structure may differ.
    const hamburger =
      document.querySelector<HTMLElement>('ytd-masthead #guide-button button')
      || document.querySelector<HTMLElement>('ytd-masthead #guide-button')
      || document.querySelector<HTMLElement>('#guide-button button')
      || document.querySelector<HTMLElement>('#guide-button');
    hamburger?.click();
    setTimeout(scrollAndFocus, 350);
  }

  // Prepend the Bouncer logo into the box's title span. Done from the
  // adapter (not from shared UI markup) because the logo URL needs
  // `chrome.runtime.getURL`, which isn't reachable from CSS, and only the
  // YouTube skin wants this decoration.
  private _ensureTitleLogo() {
    const title = document.querySelector<HTMLElement>(
      '.filter-phrases-banner--youtube .filter-phrases-box-name'
    );
    if (!title) return;
    if (title.querySelector('.bouncer-title-logo')) return;
    const img = document.createElement('img');
    img.className = 'bouncer-title-logo';
    img.src = chrome.runtime.getURL('icons/icon48.png');
    img.alt = '';
    img.setAttribute('aria-hidden', 'true');
    title.prepend(img);
  }

  private _initMiniGuideEntry() {
    if (!this._countListenerWired) {
      this._wireFilteredCountListener();
      this._countListenerWired = true;
    }
    const tick = () => {
      this._ensureMiniGuideEntry();
      this._ensureTitleLogo();
    };
    tick();
    // Long-running observer — handles delayed guide hydration, SPA nav, and
    // YT re-rendering the mini-guide on viewport changes. Each tick is just
    // a few querySelectors so it's cheap. CRITICAL: every DOM write inside
    // `tick` must be idempotent (re-writing the same value would re-fire
    // this observer and lock up the page on YT's already-frequent mutations).
    new MutationObserver(tick).observe(document.body, { childList: true, subtree: true });
  }

  shouldProcessCurrentPage(): boolean {
    const path = window.location.pathname;
    return path === '/' || path === '' || path.startsWith('/watch');
  }

  getFilterBoxAnchor(): FilterBoxAnchor | null {
    const path = window.location.pathname;

    // Watch page: anchor at the very top of the right-hand "Up next"
    // column (`#secondary` inside `ytd-watch-flexy`). The column is
    // visible by default on this layout, so the box doesn't need the
    // drawer to be opened — users see it the moment the page loads.
    if (path.startsWith('/watch')) {
      const secondary = document.querySelector<HTMLElement>('ytd-watch-flexy #secondary')
        || document.querySelector<HTMLElement>('#secondary');
      if (!secondary) return null;
      return { parent: secondary, insertBefore: secondary.firstChild };
    }

    // Home: anchor inside the FIRST guide section's `#items` list, after
    // the Shorts entry — so Bouncer becomes part of the same section as
    // Home and Shorts (keeping YT's section divider below Bouncer, above
    // Subscriptions).
    const firstSection = document.querySelector<HTMLElement>(
      'ytd-guide-renderer #sections ytd-guide-section-renderer'
    );
    if (!firstSection) return null;
    const items = firstSection.querySelector<HTMLElement>('#items');
    if (!items) return null;
    return { parent: items, insertBefore: null };
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

  isPermalinkView(): boolean { return false; }

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

    const videoId = getVideoIdFromContentIdClass(article);
    const thumbImg = article.querySelector<HTMLImageElement>('yt-thumbnail-view-model img.ytCoreImageHost');
    const { imageUrls, displayImageUrls } = buildThumbnailUrls(videoId, thumbImg?.src);

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
      displayImageUrls,
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

    // For the classifier we want a stable JPEG. When we have a video ID,
    // rewrite to canonical mqdefault.jpg (see `canonicalThumbnailUrl`). Ads
    // without a videoId fall back to whatever the lockup gave us — those have
    // not been observed serving AVIF in practice.
    const { imageUrls, displayImageUrls } = buildThumbnailUrls(data.videoId, data.thumbnailUrl);

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
      displayImageUrls,
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
    // Use the lockup as the gate (always present), but the actual injection
    // anchors to the three-dots menu so the button sits directly below it.
    return article.querySelector<HTMLElement>('yt-lockup-view-model') || article;
  }

  insertActionButton(article: HTMLElement, button: HTMLElement): void {
    if (article.querySelector('.ff-why-annoying-btn')) return;
    // Surface-specific anchors. Each card type renders its 3-dots menu in
    // a different container; we anchor our button to the same container so
    // it lands directly below the menu regardless of layout.
    //   - Regular videos: `.ytLockupMetadataViewModelHost`
    //   - Sponsored ads:  `feed-ad-metadata-view-model`
    //   - Shorts:         `.shortsLockupViewModelHostOutsideMetadata`
    //     (the row that contains both the title and the menu button).
    // The class we add (`ff-yt-under-menu` vs `ff-yt-short-menu`) lets the
    // stylesheet apply different absolute offsets per surface.
    let anchor: HTMLElement | null;
    let positionClass: string;

    const shortMeta = article.querySelector<HTMLElement>('.shortsLockupViewModelHostOutsideMetadata');
    if (shortMeta) {
      anchor = shortMeta;
      positionClass = 'ff-yt-short-menu';
    } else {
      anchor =
        article.querySelector<HTMLElement>('.ytLockupMetadataViewModelHost')
        || article.querySelector<HTMLElement>('feed-ad-metadata-view-model');
      positionClass = 'ff-yt-under-menu';
    }

    if (!anchor) {
      // Anchor not hydrated yet — observe the card and retry when YT
      // finishes rendering the metadata row. Without this we'd silently
      // miss the first few cards on every page load.
      const mo = new MutationObserver(() => {
        if (article.querySelector('.ff-why-annoying-btn')) { mo.disconnect(); return; }
        const a =
          article.querySelector<HTMLElement>('.shortsLockupViewModelHostOutsideMetadata')
          || article.querySelector<HTMLElement>('.ytLockupMetadataViewModelHost')
          || article.querySelector<HTMLElement>('feed-ad-metadata-view-model');
        if (a) {
          mo.disconnect();
          this.insertActionButton(article, button);
        }
      });
      mo.observe(article, { childList: true, subtree: true });
      // Stop observing after a few seconds to avoid leaking observers on
      // cards that genuinely never render a usable anchor.
      setTimeout(() => mo.disconnect(), 8000);
      return;
    }

    button.classList.add(positionClass);
    if (getComputedStyle(anchor).position === 'static') {
      anchor.style.position = 'relative';
    }
    anchor.appendChild(button);
  }
};
