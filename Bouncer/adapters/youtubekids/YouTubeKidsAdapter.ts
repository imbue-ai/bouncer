import type {
  FilterBoxAnchor,
  PlatformAdapter,
  PlatformSelectors,
  PostContent,
} from '../../src/types';
// NOTE: adapters are built with esbuild bundle:false (standalone IIFE per
// manifest content_scripts entry), so we CANNOT import shared/platforms
// here — esbuild would leave `require(...)` calls that fail in the browser.
// Keep the hostname check inline. Must match the `youtubekids` entry in
// src/shared/platforms.ts (PLATFORM_RUNTIME.youtubekids.hostPattern).

// youtubekids.com is a Polymer app (`<ytk-app>` shell) built with the
// ShadyDOM polyfill, so every component renders into the LIGHT DOM — plain
// querySelector reaches everything, no shadow-root piercing needed. The
// video tile is `ytk-compact-video-renderer`; its Polymer `data` property
// (the `compactVideoRenderer` JSON) is only visible from the page world,
// but everything we need is already in the rendered DOM:
//   - home/search stamp the tile with id="ytk-compact-video-renderer-<videoId>"
//   - the tile's endpoint anchor carries the /watch?v= href
//   - the title lives in `.details .primary-text span`
// so unlike the youtube.com adapter there is no page-world store extractor.
// Tiles carry no channel byline (the details div holds only the title), so
// `author`/`handle` are always empty for this platform.

// Home/search tiles are stamped as
// `id="ytk-compact-video-renderer-<videoId>"`. Video ids can contain `-`
// and `_`, so slice on the fixed prefix — never split on `-`.
const TILE_ID_PREFIX = 'ytk-compact-video-renderer-';

function videoIdOf(article: HTMLElement): string | null {
  if (article.id && article.id.startsWith(TILE_ID_PREFIX)) {
    return article.id.slice(TILE_ID_PREFIX.length) || null;
  }
  // Watch-page tiles carry no id attribute — parse the endpoint anchor.
  const a = article.querySelector<HTMLAnchorElement>('a[href*="watch"]');
  if (!a) return null;
  try {
    const u = new URL(a.getAttribute('href') || '', location.origin);
    const v = u.searchParams.get('v');
    if (v) return v;
    const m = u.pathname.match(/^\/watch\/([^/?]+)/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

// YouTube Kids serves the same video corpus as youtube.com, so the canonical
// `mqdefault.jpg` endpoint (320×180, unsigned, stable JPEG) works for any
// tile with a known video id. Used for the classifier payload — the lockup's
// own thumbnail URL can be a signed AVIF-despite-.jpg variant that the
// classification APIs reject. The filtered-posts panel keeps the original
// URL (browsers render AVIF fine).
function canonicalThumbnailUrl(videoId: string): string {
  return `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;
}

// Assigned to `window.BouncerAdapter` only when running on a YouTube Kids
// host (see the guarded assignment at the bottom of this file). On iOS all
// adapters are injected into every page, so each must claim the global slot
// only for its own site or they'd clobber each other.
const BouncerYouTubeKidsAdapter = class YouTubeKidsAdapter implements PlatformAdapter {
  siteId = 'youtubekids' as const;
  filterBoxPlacement = 'banner' as const;

  selectors: PlatformSelectors = {
    // The one tile type filtered in v1 — playlist tiles
    // (`ytk-compact-playlist-renderer`), channel tiles
    // (`ytk-compact-channel-renderer`) and search promo tiles
    // (`ytk-kids-search-promo-tile-renderer`) are deliberately not matched.
    // Covers all three surfaces: home grid (inside
    // `ytk-item-section-renderer`), search results (same section renderer),
    // and the watch page's up-next list
    // (`ytk-two-column-watch-next-results-renderer`).
    post: 'ytk-compact-video-renderer',
    sidebar: '',
    sidebarContent: '',
    primaryColumn: 'ytk-app',
    nav: '',
    bottomBar: '',
    // Hydration/recycling signals: the tile itself arriving (pagination /
    // page switch), plus the inner nodes Polymer stamps when a recycled
    // tile is re-bound to new data.
    mutations: 'ytk-compact-video-renderer, ytk-compact-video-renderer a.yt-simple-endpoint, ytk-compact-video-renderer yt-img-shadow img',
    textContent: '.primary-text span, .primary-text',
  };

  shouldProcessCurrentPage(): boolean {
    // Home, watch, and search are the only tile-bearing surfaces. The
    // onboarding / profile-selection / parental-gate flows render no
    // `ytk-compact-video-renderer` tiles, so excluding them here mostly
    // matters for the banner box (which should not appear mid-onboarding).
    const path = window.location.pathname;
    return path === '/' || path === '' || path.startsWith('/watch') || path.startsWith('/search');
  }

  // Banner box on the home screen only, anchored directly above the home
  // grid. The watch page's up-next column has no comparable slot, and the
  // box is primarily a parent-facing control — home is where parents land.
  getFilterBoxAnchor(): FilterBoxAnchor | null {
    if (window.location.pathname.startsWith('/watch')) return null;
    const home = document.querySelector<HTMLElement>('ytk-kids-home-screen-renderer');
    if (!home || !home.parentElement) return null;
    return { parent: home.parentElement, insertBefore: home };
  }

  getThemeMode(): 'light' | 'dim' | 'dark' {
    // YouTube Kids web has no user-facing dark mode today; read the computed
    // body background anyway (same approach as the youtube.com adapter) so
    // the box stays legible if Google ships one.
    const m = window.getComputedStyle(document.body).backgroundColor
      .match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
    if (m) {
      const r = Number(m[1]), g = Number(m[2]), b = Number(m[3]);
      const a = m[4] !== undefined ? Number(m[4]) : 1;
      if (a > 0) {
        if (r > 200 && g > 200 && b > 200) return 'light';
        if (r < 50 && g < 50 && b < 50) return 'dark';
      }
    }
    return 'light';
  }

  getSearchForm(): HTMLElement | null {
    // No search-bar integration on the kid-facing UI.
    return null;
  }

  isMainPost(_article: HTMLElement): boolean { return false; }

  // The watch page's up-next list is a feed of suggestions, not replies —
  // keep the "Filter replies/comments" gate out of the picture entirely.
  isPermalinkView(): boolean { return false; }

  getPostUrl(article: HTMLElement): string | null {
    // `?v=` form so cacheKeyFor's youtubeVideoIdFromUrl parses it into the
    // shared `yt:<videoId>` cache key (same key space as youtube.com).
    const id = videoIdOf(article);
    return id ? 'https://www.youtubekids.com/watch?v=' + id : null;
  }

  getPostContentKey(article: HTMLElement): string {
    const id = videoIdOf(article);
    if (id) return 'yt:' + id;
    return article.querySelector(this.selectors.textContent)?.textContent?.slice(0, 200) || '';
  }

  getPostContainer(article: HTMLElement): HTMLElement {
    // The `ytk-compact-video-renderer` is the grid/list cell itself (home
    // tiles carry their `data-index="tile-N"` directly on it).
    return article;
  }

  // Always remove the tile outright — never a "Filtered by Bouncer"
  // placeholder on a kid-facing surface. youtubekids.css carries a
  // belt-and-braces `[data-filtered-by-extension]` rule in case Polymer
  // re-binding resets the inline style.
  hidePost(article: HTMLElement): void {
    const el = this.getPostContainer(article);
    el.dataset.filteredByExtension = 'true';
    el.style.display = 'none';
  }

  extractPostContent(article: HTMLElement): PostContent {
    const titleEl = article.querySelector<HTMLElement>('.primary-text span')
      || article.querySelector<HTMLElement>('.primary-text');
    let text = (titleEl?.textContent || '').replace(/\s+/g, ' ').trim();
    const textHtml = titleEl?.innerHTML || '';

    // Fallback: the endpoint anchor's aria-label carries the title (plus
    // a11y context like duration) before `.primary-text` exists.
    if (!text) {
      const a = article.querySelector<HTMLAnchorElement>('a.yt-simple-endpoint[aria-label], a[aria-label]');
      text = (a?.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
    }

    const videoId = videoIdOf(article);
    const thumbImg = article.querySelector<HTMLImageElement>('yt-img-shadow img');
    const thumbSrc = thumbImg?.src || '';
    const originalThumb = thumbSrc && !thumbSrc.startsWith('data:') ? thumbSrc : null;
    const imageUrls = videoId
      ? [canonicalThumbnailUrl(videoId)]
      : (originalThumb ? [originalThumb] : []);
    const displayImageUrls = videoId && originalThumb ? [originalThumb] : undefined;

    return {
      text,
      author: '', // tiles render no channel byline (title-only details div)
      handle: '',
      avatarUrl: null,
      timeText: null, // tiles only show duration, which isn't classification signal
      textHtml,
      quote: null,
      postUrl: this.getPostUrl(article),
      imageUrls,
      displayImageUrls,
      hasMediaContainer: imageUrls.length > 0,
    };
  }

  // No page-world store bridge on this platform — this is the same DOM
  // extraction, returning null until the tile is hydrated (both a video id
  // and a title). Nulls ride the content script's MAX_STORE_RETRIES
  // observer-retry loop; requiring both fields avoids classifying a
  // half-rendered tile and caching that verdict under `yt:<videoId>`.
  // Deliberately does NOT set `fromStore` — the DOM-preferred merge in
  // index.ts is exactly right for DOM-sourced content.
  extractPostContentFromStore(article: HTMLElement): Promise<PostContent | null> {
    if (!videoIdOf(article)) return Promise.resolve(null);
    const content = this.extractPostContent(article);
    return Promise.resolve(content.text ? content : null);
  }

  cleanupFilteredPostHtml(el: HTMLElement, imageUrls: string[]): void {
    // Reset filtered-state styling on the re-injected snippet so the
    // filtered-posts panel shows the tile, not a hidden clone.
    el.querySelectorAll<HTMLElement>('ytk-compact-video-renderer').forEach(c => {
      c.style.display = '';
      c.style.opacity = '1';
      c.removeAttribute('data-filtered-by-extension');
    });

    // The tile's 3-dot menu is dead weight inside the panel clone.
    el.querySelectorAll('.menu').forEach(m => m.remove());

    // Replace the thumbnail (yt-img-shadow has lazy/background-image state
    // that doesn't survive cloning) with a fresh <img> the panel can render.
    const thumb = el.querySelector<HTMLElement>('yt-img-shadow');
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

  // Returning null is the sanctioned off-switch for the per-post trash
  // button (addWhyAnnoyingButton bails before insertActionButton) — no
  // Bouncer chrome on kid-visible tiles.
  getShareButton(_article: HTMLElement): HTMLElement | null {
    return null;
  }

  insertActionButton(_article: HTMLElement, _button: HTMLElement): void {
    // Unreachable while getShareButton returns null; interface requires it.
  }
};

// Self-guard by hostname — regex mirrors src/shared/platforms.ts
// PLATFORM_RUNTIME.youtubekids.hostPattern.
if (/(^|\.)youtubekids\.com$/i.test(location.hostname)) {
  window.BouncerAdapter = BouncerYouTubeKidsAdapter;
}
