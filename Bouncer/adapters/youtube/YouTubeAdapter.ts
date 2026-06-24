import type {
  FilterBoxAnchor,
  PlatformAdapter,
  PlatformSelectors,
  PostContent,
} from '../../src/types';
// NOTE: adapters are built with esbuild bundle:false (standalone IIFE per
// manifest content_scripts entry), so we CANNOT import shared/platforms
// here — esbuild would leave `require(...)` calls that fail in the browser.
// Keep the hostname check inline. Must match the `youtube` entry in
// src/shared/platforms.ts (PLATFORM_RUNTIME.youtube.hostPattern).

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

// Assigned to `window.BouncerAdapter` only when running on a YouTube host (see
// the guarded assignment at the bottom of this file). On iOS both the Twitter
// and YouTube adapters are injected into every page, so each must claim the
// global slot only for its own site or they'd clobber each other.
const BouncerYouTubeAdapter = class YouTubeAdapter implements PlatformAdapter {
  siteId = 'youtube' as const;
  filterBoxPlacement = 'banner' as const;

  // Mobile web (`m.youtube.com`, e.g. inside the iOS WKWebView) ships a
  // different component tree from desktop. The home feed still uses the
  // shared `yt-lockup-view-model` (wrapped in `ytm-rich-item-renderer`), so
  // the desktop extraction works there verbatim; the watch page renders
  // mobile-only `ytm-*` cards (`ytm-video-with-context-renderer` →
  // `ytm-media-item`) that need their own extraction path. The DOM-facing
  // members below branch on this flag. All the desktop chrome (banner box,
  // mini-guide, per-post action button) is skipped on mobile — on iOS the
  // entire Bouncer UI lives in the native filtered-posts tab, so the adapter
  // only needs to make matching videos disappear.
  private _mobile = location.hostname === 'm.youtube.com';

  selectors: PlatformSelectors = {
    // Desktop — two surfaces:
    //   - Home: `ytd-rich-item-renderer` wraps each card in the grid.
    //   - Watch: `yt-lockup-view-model` inside the suggested-videos
    //     container (`ytd-watch-next-secondary-results-renderer`) is the
    //     card itself — no rich-item wrapper on the watch sidebar.
    // Mobile — `ytm-rich-item-renderer` wraps each home-grid lockup, and the
    // watch related feed is a list of `ytm-video-with-context-renderer`
    // cards (each wrapping one `ytm-media-item`, so matching the outer
    // renderer avoids double-counting).
    // Mobile Shorts live in a grid shelf (`grid-shelf-view-model`), NOT in a
    // rich-item, so `ytm-shorts-lockup-view-model` must be matched directly.
    post: this._mobile
      ? 'ytm-rich-item-renderer, ytm-video-with-context-renderer, ytm-shorts-lockup-view-model'
      : 'ytd-rich-item-renderer, ytd-watch-next-secondary-results-renderer yt-lockup-view-model',
    sidebar: '',
    sidebarContent: '',
    primaryColumn: '#primary',
    nav: '',
    bottomBar: '',
    // A `yt-lockup-view-model` (home), `ytm-media-item` (watch) or
    // `ytm-shorts-lockup-view-model` (shorts shelf) getting added is the
    // signal that a card's data is hydrated. Used for DOM-recycling
    // re-evaluation and detecting new suggestions/shorts on scroll.
    mutations: this._mobile ? 'yt-lockup-view-model, ytm-media-item, ytm-shorts-lockup-view-model' : 'yt-lockup-view-model',
    textContent: this._mobile ? '.ytLockupMetadataViewModelTitle, .media-item-headline, .shortsLockupViewModelHostMetadataTitle' : '.ytLockupMetadataViewModelTitle',
  };

  private _extractorReady = false;
  private _pendingStoreRequests = new Map<string, (result: StoreResult) => void>();
  // `youtubeShowPlaceholder` mirrored locally so `hidePost` (sync) can read
  // it without awaiting storage. Updated by `_initPlaceholderSetting` on
  // load and on `chrome.storage.onChanged`.
  private _showPlaceholder = false;

  constructor() {
    this._initLockupExtractor();
    // The mini-guide entry and inline filter box are desktop-only UI. On
    // mobile the iOS app surfaces everything through its native tab, so we
    // skip them (and `getFilterBoxAnchor`/`insertActionButton` no-op too).
    if (!this._mobile) this._initMiniGuideEntry();
    this._initPlaceholderSetting();
  }

  // Read the placeholder setting and keep it current. The setting also
  // toggles a class on <html> so `youtube.css` can gate the cover styling
  // — CSS reads the class, JS reads the field, both stay in sync via the
  // storage listener below.
  private _initPlaceholderSetting(): void {
    chrome.storage.local.get(['youtubeShowPlaceholder'])
      .then((data) => {
        this._showPlaceholder = (data as { youtubeShowPlaceholder?: boolean }).youtubeShowPlaceholder === true;
        this._applyPlaceholderClass();
      })
      .catch(() => { /* storage unavailable — keep default (off) */ });

    chrome.storage.onChanged.addListener((changes) => {
      if (!changes.youtubeShowPlaceholder) return;
      const next = changes.youtubeShowPlaceholder.newValue === true;
      if (next === this._showPlaceholder) return;
      this._showPlaceholder = next;
      this._applyPlaceholderClass();
      // Retroactively switch already-filtered cards to the new style.
      // Turning the placeholder OFF: hide the card (matching the new
      // default for fresh hides). Turning it ON: restore the slot AND
      // inject the placeholder DOM so CSS has something to render — the
      // page-class toggle alone isn't enough.
      document.querySelectorAll<HTMLElement>('[data-filtered-by-extension="true"]').forEach((el) => {
        if (this._showPlaceholder) {
          el.style.display = '';
          this._ensurePlaceholderElement(el);
        } else {
          el.style.display = 'none';
        }
      });
    });
  }

  private _applyPlaceholderClass(): void {
    // Distinct from the placeholder element's class — selecting `.bouncer-
    // yt-placeholder` on its own would match both <html> and the element,
    // and hiding the element with `display:none` would also hide <html>.
    document.documentElement.classList.toggle('bouncer-yt-show-placeholder', this._showPlaceholder);
  }

  // Build the placeholder DOM and append it as a direct child of the card.
  // Idempotent — bails if a placeholder is already attached. CSS gates
  // visibility, so it's safe to leave the element in place when toggling
  // the setting off; only fresh hides require an injection.
  private _ensurePlaceholderElement(el: HTMLElement): void {
    if (el.querySelector(':scope > .bouncer-yt-placeholder')) return;

    // Shorts cards use a 2:3 thumbnail and a simpler byline (title + views,
    // no avatar). Detect by descendant — the rich-item-renderer wraps a
    // `ytm-shorts-lockup-view-model` in shelf items.
    const isShort = !!el.querySelector('ytm-shorts-lockup-view-model, .shortsLockupViewModelHost');

    const wrap = document.createElement('div');
    wrap.className = isShort ? 'bouncer-yt-placeholder bouncer-yt-placeholder--short' : 'bouncer-yt-placeholder';

    const thumb = document.createElement('div');
    thumb.className = 'bouncer-yt-placeholder-thumb';
    const logo = document.createElement('img');
    logo.className = 'bouncer-yt-placeholder-logo';
    logo.src = chrome.runtime.getURL('icons/icon48.png');
    logo.alt = '';
    logo.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span');
    label.className = 'bouncer-yt-placeholder-label';
    label.textContent = 'Filtered by Bouncer';
    thumb.appendChild(logo);
    thumb.appendChild(label);

    const meta = document.createElement('div');
    meta.className = 'bouncer-yt-placeholder-meta';
    // Regular cards have an avatar circle; shorts don't.
    if (!isShort) {
      const avatar = document.createElement('div');
      avatar.className = 'bouncer-yt-placeholder-avatar';
      meta.appendChild(avatar);
    }
    const bars = document.createElement('div');
    bars.className = 'bouncer-yt-placeholder-bars';
    // Shorts get two short bars (title + views) instead of the regular
    // three-line byline (title × 2 + channel + views).
    const barVariants = isShort ? ['long', 'tiny'] : ['long', 'short', 'tiny'];
    for (const variant of barVariants) {
      const bar = document.createElement('div');
      bar.className = `bouncer-yt-placeholder-bar ${variant}`;
      bars.appendChild(bar);
    }
    meta.appendChild(bars);

    wrap.appendChild(thumb);
    wrap.appendChild(meta);
    el.appendChild(wrap);
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
    // Apply any filter count that accumulated before the entry existed.
    this._applyCountToBadge();
    return entry;
  }

  // Mirror the filtered-post count into the mini-guide entry's badge.
  // Listen for the count-changed event dispatched by `updateFilteredTabCount`
  // in shared UI. This decouples the badge from the box's DOM — important
  // on YT because the guide drawer (where the box lives) lazy-hydrates on
  // first open, so DOM-scrape mirrors miss filter activity that happens
  // before the user touches the drawer.
  private _wireFilteredCountListener(): void {
    document.addEventListener('bouncer:filtered-count-changed', () => {
      this._applyCountToBadge();
    });
  }

  // Mirror the published filtered-post count onto the mini-guide badge.
  // Reads from `document.documentElement.dataset.bouncerFilteredCount`,
  // which `updateFilteredTabCount` keeps in sync with `filteredPosts.length`
  // (the single source of truth). Idempotent — safe to call when the
  // entry doesn't yet exist (no-op) or when the value hasn't changed
  // (avoids dispatching a no-op DOM mutation that would re-fire the
  // tick observer).
  private _applyCountToBadge(): void {
    const c = document.querySelector<HTMLElement>('.bouncer-mini-guide-entry__count');
    if (!c) return;
    const n = document.documentElement.dataset.bouncerFilteredCount || '0';
    if (c.textContent !== n) c.textContent = n;
    c.classList.toggle('bouncer-mini-guide-entry__count--nonzero', n !== '0');
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

    // Decide whether the drawer needs opening. Decisive signal: the URL,
    // not the box's current location. On a fresh reload with the drawer
    // collapsed, the box hasn't been injected yet (YT lazy-hydrates the
    // guide drawer's section list on first open) — so `box` is null and
    // we can't infer "where the box belongs" from it. The URL tells us:
    //   - Home: anchor is inside the drawer → open drawer.
    //   - Watch: anchor is in `#secondary` (always visible) → don't open
    //     drawer (would cover the page with an empty overlay).
    const anchorIsInDrawer = !window.location.pathname.startsWith('/watch');
    if (boxInViewport || !anchorIsInDrawer) {
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
    // No inline filter box on mobile — the iOS native tab owns the UI.
    if (this._mobile) return null;

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
    const html = document.documentElement;
    const root = this._mobile ? html : document.body;
    // Trust the computed background color first: it's what the user
    // actually sees on the page, regardless of what attributes YouTube
    // happens to flip. On mobile in particular the `darker-dark-theme`
    // attribute has been observed in BOTH light and dark mode in recent
    // builds, so leaning on attributes alone produces false darks.
    const m = window.getComputedStyle(root).backgroundColor
      .match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
    if (m) {
      const r = Number(m[1]), g = Number(m[2]), b = Number(m[3]);
      const a = m[4] !== undefined ? Number(m[4]) : 1;
      if (a > 0) {
        // High RGB values → definitely a light background.
        if (r > 200 && g > 200 && b > 200) return 'light';
        // Low RGB values → definitely dark.
        if (r < 50 && g < 50 && b < 50) return 'dark';
      }
    }
    // Background was transparent or in the ambiguous mid-range. Fall
    // back to attribute sniffing — desktop is reliable (only set in
    // dark mode); mobile's `darker-dark-theme` is less so but still
    // useful as a tiebreaker when the bg color didn't give a clear read.
    if (html.hasAttribute('dark')) return 'dark';
    if (this._mobile && html.hasAttribute('darker-dark-theme')) return 'dark';
    // Default to light. Deliberately NOT falling back to
    // matchMedia('(prefers-color-scheme: dark)') — inside an iOS
    // WKWebView that reflects the iPhone's system theme, not the
    // actual YouTube page theme.
    return 'light';
  }

  getSearchForm(): HTMLElement | null {
    return document.querySelector<HTMLElement>('ytd-searchbox');
  }

  isMainPost(_article: HTMLElement): boolean { return false; }

  isPermalinkView(): boolean { return false; }

  getPostUrl(article: HTMLElement): string | null {
    const id = getVideoIdFromContentIdClass(article) || this._videoIdFromHref(article);
    if (id) return 'https://www.youtube.com/watch?v=' + id;
    return null;
  }

  // Mobile watch cards carry no `content-id-*` class — derive the video id
  // from the card's `/watch?v=` link instead. Also used as a fallback for
  // any lockup whose content-id class hasn't hydrated yet.
  private _videoIdFromHref(article: HTMLElement): string | null {
    const a = article.querySelector<HTMLAnchorElement>(
      'a.ytLockupViewModelContentImage[href*="/watch?v="], a.media-item-thumbnail-container[href*="/watch?v="], a[href*="/watch?v="], a[href*="/shorts/"]'
    );
    if (!a) return null;
    try {
      const u = new URL(a.href, location.origin);
      const v = u.searchParams.get('v');
      if (v) return v;
      const m = u.pathname.match(/^\/shorts\/([^/?]+)/);
      return m ? m[1] : null;
    } catch {
      return null;
    }
  }

  getPostContentKey(article: HTMLElement): string {
    const id = getVideoIdFromContentIdClass(article) || this._videoIdFromHref(article);
    if (id) return 'yt:' + id;
    return article.querySelector(this.selectors.textContent)?.textContent?.slice(0, 200) || '';
  }

  getPostContainer(article: HTMLElement): HTMLElement {
    // Mobile Shorts are cells in a horizontal grid shelf — hide the whole
    // grid-shelf cell so there's no empty gap left behind.
    if (this._mobile) {
      const shortsCell = article.closest<HTMLElement>('.ytGridShelfViewModelGridShelfItem');
      if (shortsCell) return shortsCell;
    }
    return article;
  }

  // Two modes, gated by the `youtubeShowPlaceholder` setting:
  //   - off (default): remove the card outright, matching Twitter.
  //   - on: leave the slot in the home grid and cover it with a
  //         "Filtered by Bouncer" placeholder (see youtube.css).
  // The watch-page sidebar is always remove-only — it's a linear list, so
  // a placeholder row would be noise between real suggestions.
  hidePost(article: HTMLElement): void {
    const el = this.getPostContainer(article);
    el.dataset.filteredByExtension = 'true';
    // Mobile always removes the card outright — the placeholder is a
    // desktop-only affordance (and `youtubeShowPlaceholder` is a shared
    // setting that may be `true` from a desktop session). The watch sidebar
    // also always removes (a placeholder row would be noise between results).
    if (this._mobile || !this._showPlaceholder || window.location.pathname.startsWith('/watch')) {
      el.style.display = 'none';
      return;
    }
    // Clear the fade-out styles the shared hide flow applies before calling
    // us — otherwise the just-installed cover inherits `opacity: 0` and is
    // invisible.
    el.style.opacity = '';
    el.style.transition = '';
    this._ensurePlaceholderElement(el);
  }

  extractPostContent(article: HTMLElement): PostContent {
    if (this._mobile) {
      // Mobile watch-page card: `ytm-video-with-context-renderer` / `ytm-media-item`.
      if (article.querySelector('.media-item-headline')) {
        return this._extractMobileWatchCard(article);
      }
      // Mobile Shorts shelf card.
      if (article.matches?.('ytm-shorts-lockup-view-model') || article.querySelector('.shortsLockupViewModelHostMetadataTitle')) {
        return this._extractMobileShort(article);
      }
    }
    // Mobile home cards are standard lockups, so they fall through to the
    // desktop lockup path below unchanged.

    const titleEl = article.querySelector<HTMLElement>('.ytLockupMetadataViewModelTitle');
    const text = (titleEl?.textContent || '').replace(/\s+/g, ' ').trim();
    const textHtml = titleEl?.innerHTML || '';

    // Desktop: channel is metadata row 0 (an <a>); views/age are later rows.
    const rows = article.querySelectorAll<HTMLElement>('.ytContentMetadataViewModelMetadataRow');
    const channelLink = rows[0]?.querySelector<HTMLAnchorElement>('a');
    let author = (channelLink?.textContent || '').replace(/\s+/g, ' ').trim();
    const handle = channelLink?.getAttribute('href') || '';

    const avatarImg = article.querySelector<HTMLImageElement>('.ytSpecAvatarShapeImage');
    const avatarSrc = avatarImg?.src || '';
    const avatarUrl = avatarSrc && !avatarSrc.startsWith('data:') ? avatarSrc : null;

    let rowTexts: string[] = [];
    rows.forEach((r, i) => {
      if (i === 0) return;
      const t = r.textContent?.replace(/\s+/g, ' ').trim();
      if (t) rowTexts.push(t);
    });

    // Mobile home lockups pack channel + views + age into a single metadata
    // row with no channel anchor, so the desktop row-0/row-1 split finds
    // nothing. Fall back to the metadata-text spans in document order:
    // [0] = channel, the rest = views / age. (Desktop keeps its anchor author,
    // so this only kicks in when the row-based extraction came up empty.)
    if (!author) {
      const spans = Array.from(article.querySelectorAll<HTMLElement>('.ytContentMetadataViewModelMetadataText'));
      author = (spans[0]?.textContent || '').replace(/\s+/g, ' ').trim();
      if (rowTexts.length === 0) {
        rowTexts = spans.slice(1)
          .map(s => (s.textContent || '').replace(/\s+/g, ' ').trim())
          .filter(Boolean);
      }
    }
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

  // Mobile watch-page card extraction. Layout (see mobile-youtube-dom-notes):
  //   ytm-video-with-context-renderer > ytm-media-item
  //     a.media-item-thumbnail-container[href="/watch?v="]  (+ ytm-thumbnail-cover img)
  //     .media-item-details
  //       .media-channel a[href^="/@"]  (avatar img.ytProfileIconImage)
  //       h3.media-item-headline  (title)
  //       ytm-badge-and-byline-renderer  (channel name, then views/age/badges)
  private _extractMobileWatchCard(article: HTMLElement): PostContent {
    const titleEl = article.querySelector<HTMLElement>('.media-item-headline');
    const text = (titleEl?.textContent || '').replace(/\s+/g, ' ').trim();
    const textHtml = titleEl?.innerHTML || '';

    // Byline items: the first is the channel name; later ones are views / age
    // (and the occasional "New" badge, which carries no text byline).
    const bylineItems = article.querySelectorAll<HTMLElement>(
      'ytm-badge-and-byline-renderer .YtmBadgeAndBylineRendererItemByline'
    );
    const author = (bylineItems[0]?.textContent || '').replace(/\s+/g, ' ').trim();
    const rowTexts: string[] = [];
    bylineItems.forEach((r, i) => {
      if (i === 0) return;
      const t = r.textContent?.replace(/\s+/g, ' ').trim();
      if (t) rowTexts.push(t);
    });
    const timeText = rowTexts.join(' • ') || null;

    const channelLink = article.querySelector<HTMLAnchorElement>('.media-channel a[href^="/@"]');
    const handle = channelLink?.getAttribute('href') || '';

    const avatarImg = article.querySelector<HTMLImageElement>('img.ytProfileIconImage');
    const avatarSrc = avatarImg?.src || '';
    const avatarUrl = avatarSrc && !avatarSrc.startsWith('data:') ? avatarSrc : null;

    const videoId = this._videoIdFromHref(article);
    const thumbImg = article.querySelector<HTMLImageElement>('ytm-thumbnail-cover img.ytCoreImageHost');
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

  // Mobile Shorts shelf card (`ytm-shorts-lockup-view-model`). DOM fallback for
  // when store extraction is unavailable — the title lives in
  // `.shortsLockupViewModelHostMetadataTitle`, the id in the `/shorts/<id>`
  // href. Shorts carry no channel on the lockup (matches normalizeShort).
  private _extractMobileShort(article: HTMLElement): PostContent {
    const titleEl = article.querySelector<HTMLElement>('.shortsLockupViewModelHostMetadataTitle');
    const text = (titleEl?.textContent || '').replace(/\s+/g, ' ').trim();
    const textHtml = titleEl?.innerHTML || '';

    const videoId = this._videoIdFromHref(article);
    const thumbImg = article.querySelector<HTMLImageElement>('yt-thumbnail-view-model img.ytCoreImageHost');
    const { imageUrls, displayImageUrls } = buildThumbnailUrls(videoId, thumbImg?.src);

    return {
      text,
      author: 'Short',
      handle: '',
      avatarUrl: null,
      timeText: null,
      textHtml,
      quote: null,
      postUrl: videoId ? 'https://www.youtube.com/shorts/' + videoId : null,
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
    // Reset filtered-state styling on the re-injected snippet. Covers both
    // desktop (`ytd-rich-item-renderer`) and mobile (`ytm-rich-item-renderer`
    // home grid, `ytm-video-with-context-renderer` / `ytm-media-item` watch).
    const containers = el.querySelectorAll<HTMLElement>(
      'ytd-rich-item-renderer, ytm-rich-item-renderer, ytm-video-with-context-renderer, ytm-media-item, ytm-shorts-lockup-view-model'
    );
    containers.forEach(c => {
      c.style.display = '';
      c.style.opacity = '1';
      c.removeAttribute('data-filtered-by-extension');
    });

    // Strip any injected placeholder DOM — the panel renders the real
    // video, so the skeleton cover would just be cruft inside the clone.
    el.querySelectorAll('.bouncer-yt-placeholder').forEach(p => p.remove());

    // Strip our injected trash button — otherwise the filtered-posts panel
    // renders it inside the cloned card (e.g. inside a Short's title).
    el.querySelectorAll('.ff-why-annoying-btn').forEach(b => b.remove());

    // Replace the thumbnail (which has lazy/blob src state) with a fresh <img>
    // so the filtered-posts panel can render it reliably. Desktop/home cards
    // use `yt-thumbnail-view-model`; mobile watch cards use `ytm-thumbnail-cover`.
    const thumb = el.querySelector<HTMLElement>('yt-thumbnail-view-model, ytm-thumbnail-cover');
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
    // Surface-specific anchors, all inline at the end of an existing text
    // row so the button reads as a native sibling of the metadata:
    //   - Regular videos (incl. mobile home lockup): end of the views/age row.
    //   - Mobile watch cards: end of the views byline.
    //   - Shorts: end of the views subhead (desktop) / title (mobile).
    //   - Sponsored ads: end of the "Sponsored • <advertiser>" row.
    //   - Other lockups (live, playlists, etc.) with no text row to anchor
    //     against: fall back to absolute placement next to the 3-dots menu.
    let anchor: HTMLElement | null;
    let positionClass: string;
    let inline = false;

    const shortSubhead = article.querySelector<HTMLElement>('.shortsLockupViewModelHostOutsideMetadataSubhead');
    const adBadgeRow = article.querySelector<HTMLElement>('.ytwFeedAdMetadataViewModelHostMetadataAdBadgeDetailsLineContainerStyleStandard');
    // Mobile Shorts: the title is overlaid on the thumbnail (so injecting into
    // it pollutes the filtered-view title); place the trash absolutely under
    // the 3-dot menu (a direct child of the shorts host) instead.
    const mobileShort = this._mobile && article.matches?.('ytm-shorts-lockup-view-model') ? article : null;
    const mobileAnchor = (this._mobile && !mobileShort) ? this._mobileActionAnchor(article) : null;
    if (shortSubhead) {
      anchor = shortSubhead;
      positionClass = 'ff-yt-inline-meta';
      inline = true;
    } else if (adBadgeRow) {
      anchor = adBadgeRow;
      positionClass = 'ff-yt-inline-meta';
      inline = true;
    } else if (mobileShort) {
      anchor = mobileShort;
      positionClass = 'ff-yt-short-menu';
      inline = false;
    } else if (mobileAnchor) {
      anchor = mobileAnchor;
      positionClass = 'ff-yt-inline-meta';
      inline = true;
    } else {
      // Anchor at the LAST metadata row. For typical videos that's the
      // views/age row (channel is row 0, views/age is row 1). For lockups
      // with a single text row — Mix playlists, "X and more" attributions,
      // etc. — it's that single row. Falls back to absolute placement only
      // when the card has no metadata rows at all.
      const metaRows = article.querySelectorAll<HTMLElement>('.ytContentMetadataViewModelMetadataRow');
      if (metaRows.length >= 1) {
        anchor = metaRows[metaRows.length - 1];
        positionClass = 'ff-yt-inline-meta';
        inline = true;
      } else {
        anchor =
          article.querySelector<HTMLElement>('.ytLockupMetadataViewModelHost')
          || article.querySelector<HTMLElement>('feed-ad-metadata-view-model');
        positionClass = 'ff-yt-under-menu';
      }
    }

    if (!anchor) {
      // Anchor not hydrated yet — observe the card and retry when YT
      // finishes rendering the metadata row. Without this we'd silently
      // miss the first few cards on every page load.
      const mo = new MutationObserver(() => {
        if (article.querySelector('.ff-why-annoying-btn')) { mo.disconnect(); return; }
        const hasShort = article.querySelector('.shortsLockupViewModelHostOutsideMetadataSubhead');
        const hasAdBadge = article.querySelector('.ytwFeedAdMetadataViewModelHostMetadataAdBadgeDetailsLineContainerStyleStandard');
        const metaRows = article.querySelectorAll('.ytContentMetadataViewModelMetadataRow');
        const hasFallback =
          article.querySelector('.ytLockupMetadataViewModelHost')
          || article.querySelector('feed-ad-metadata-view-model');
        const hasMobile = this._mobile && (article.matches?.('ytm-shorts-lockup-view-model') || this._mobileActionAnchor(article));
        if (hasShort || hasAdBadge || metaRows.length >= 1 || hasFallback || hasMobile) {
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
    if (!inline && getComputedStyle(anchor).position === 'static') {
      anchor.style.position = 'relative';
    }
    anchor.appendChild(button);
  }

  // Mobile inline anchor for the trash button: the end of the views byline on
  // watch cards. (Home lockups use the shared
  // `.ytContentMetadataViewModelMetadataRow` path; Shorts use absolute
  // placement under the 3-dot menu — both handled in insertActionButton.)
  private _mobileActionAnchor(article: HTMLElement): HTMLElement | null {
    const bylines = article.querySelectorAll<HTMLElement>('.media-item-metadata ytm-badge-and-byline-renderer');
    return bylines.length ? bylines[bylines.length - 1] : null;
  }
};

// Self-guard by hostname — covers both www.youtube.com and m.youtube.com.
// Regex mirrors src/shared/platforms.ts PLATFORM_RUNTIME.youtube.hostPattern.
if (/(^|\.)(m\.)?youtube\.com$/i.test(location.hostname)) {
  window.BouncerAdapter = BouncerYouTubeAdapter;
}
