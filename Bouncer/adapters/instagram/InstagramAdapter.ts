// Instagram platform adapter — brings the Bouncer filter pipeline (the same
// one that powers X and LinkedIn) to the Instagram Reels feed.
//
// Unlike the standalone reel-describer experiment (src/instagram/index.ts), this
// adapter plugs into the shared content script: each reel's caption + cover
// thumbnail is sent to the classifier against the user's filter topics, and any
// matching reel is pre-removed from the feed (so you scroll past as if it never
// existed) and archived in the "filtered" list UI.
//
// SELECTORS: Instagram's class names are hashed and unstable, so the ONLY stable
// anchor is the cover thumbnail <img> (decorative: aria-hidden + empty alt,
// served from the cdninstagram media host). Everything else is derived
// structurally from it:
//   - The matched "post" element is the cover img's parent div (the smallest
//     stable, child-bearing container — the verification bar needs a div, and an
//     <img> can't hold children). `div:has(> img[aria-hidden][alt=""])` matches
//     exactly one such div per reel.
//   - The reel "card" (what we hide) is the LARGEST ancestor of the cover that
//     still contains exactly one <video> — i.e. the single-reel slide. Its
//     parent merges all reels (the feed scroller), so we stop there.
//   - The caption lives in a sibling branch of the <video>, found as the longest
//     non-link dir="auto" block in the card.
// If Instagram changes its markup, these heuristics are the first thing to revisit.

import type { PlatformAdapter, PlatformSelectors, PostContent, QuoteContent } from '../../src/types';

const COVER_IMG_SELECTOR = 'img[aria-hidden="true"][alt=""]';
// Defensive cap on caption length sent (server truncates too).
const MAX_CAPTION_CHARS = 2200;

const BouncerInstagramAdapter = class InstagramAdapter implements PlatformAdapter {
  siteId = 'instagram' as const;

  // Reels has no sidebar rail and no good spot for the bottom pill over the
  // player. The reel-describer content script (src/instagram/index.ts) owns
  // the entry point instead: its gear fires `bouncer-open-settings`, which
  // content/index.ts turns into the settings modal.
  filterBoxPlacement = 'external' as const;

  selectors: PlatformSelectors = {
    // The cover img's parent div — exactly one per reel (verified 1:1 against the
    // live feed). A real div, so the pipeline's verification bar can mount in it.
    post: `div:has(> ${COVER_IMG_SELECTOR})`,
    // Reels has no Twitter-style aside rail, so the filter UI mounts as the
    // bottom pill (injectBottomFilterBox) instead of the sidebar input. This
    // selector must stay VALID (not '') — the pipeline calls querySelector() on
    // it unguarded, and querySelector('') throws a SyntaxError that aborts init
    // before the filter UI mounts. A valid never-matching selector returns null,
    // so injectFilterPhrasesInput bails cleanly.
    sidebar: 'bouncer-no-sidebar',
    sidebarContent: '',
    primaryColumn: 'main[role="main"]',
    nav: 'nav',
    bottomBar: '',
    // Best-effort DOM-recycling hook (captions are mostly stable per reel).
    mutations: '[dir="auto"]',
    textContent: '[dir="auto"]',
  };

  constructor() {
    this._initFilteredPostObserver();
  }

  // Mirror the Twitter/LinkedIn above-viewport fade: once a reel we've marked
  // scrolls fully above the viewport, fade then remove it.
  private _initFilteredPostObserver(): void {
    const fadingOut = new Set<Element>();
    const scrollHandler = () => {
      for (const el of document.querySelectorAll('[data-filtered-by-extension="true"]')) {
        if (!(el instanceof HTMLElement)) continue;
        if (el.style.display === 'none' || fadingOut.has(el)) continue;
        const rect = el.getBoundingClientRect();
        if (rect.bottom < -50) {
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
    window.addEventListener('scroll', scrollHandler, { passive: true, capture: true });
  }

  // ===========================================================================
  // Structural helpers (cover img → card → caption)
  // ===========================================================================

  // The cover thumbnail img for a reel, given the matched post div.
  private _coverImg(article: HTMLElement): HTMLImageElement | null {
    const img = article.querySelector<HTMLImageElement>(COVER_IMG_SELECTOR);
    return img && /cdninstagram\.com/.test(img.src) ? img : null;
  }

  // Walk up from the cover img to the reel card: the largest ancestor that still
  // contains exactly one <video> (the single-reel slide). Stop before the
  // ancestor that merges multiple reels (the feed scroller). Returns null if the
  // reel's <video> hasn't lazy-mounted yet — caller defers/retries.
  //
  // The <main>/<body>/<html> guard is load-bearing: the "merges multiple reels"
  // stop only fires once a SECOND <video> is mounted. On a freshly-loaded feed —
  // and permanently on a /reel/<id>/ permalink — there is exactly one <video>, so
  // every ancestor up to <html> holds exactly one and the climb would hand back
  // the whole document as the card (hiding the entire page on a match, and
  // scraping all of its text as the caption).
  private _cardFromCover(img: HTMLElement): HTMLElement | null {
    let el: HTMLElement | null = img.parentElement;
    let card: HTMLElement | null = null;
    for (let i = 0; i < 20 && el; i++) {
      if (el === document.body || el === document.documentElement || el.tagName === 'MAIN') break;
      const videos = el.querySelectorAll('video').length;
      if (videos === 1) card = el;
      else if (videos > 1) break;
      el = el.parentElement;
    }
    return card;
  }

  // Longest non-link dir="auto" block in the card. Hashtag <a>s live inside the
  // caption div, so we key off the container itself not being a link.
  private _captionEl(card: HTMLElement): HTMLElement | null {
    let best: HTMLElement | null = null;
    let bestLen = 0;
    for (const el of card.querySelectorAll<HTMLElement>('[dir="auto"]')) {
      if (el.closest('a')) continue;
      const len = (el.textContent ?? '').trim().length;
      if (len > bestLen) { bestLen = len; best = el; }
    }
    return best;
  }

  // Author username from the first profile/reels link (e.g. "/jennynomzz/reels/").
  private _authorFromCard(card: HTMLElement): string {
    const skip = new Set(['reels', 'reel', 'explore', 'p', 'stories', 'direct', 'accounts']);
    for (const a of card.querySelectorAll<HTMLAnchorElement>('a[href^="/"]')) {
      const seg = a.getAttribute('href')?.split('/').filter(Boolean)[0] ?? '';
      if (seg && !skip.has(seg)) return seg;
    }
    return '';
  }

  // The round profile avatar (a non-decorative img, i.e. not the cover).
  private _avatarFromCard(card: HTMLElement): string | null {
    for (const img of card.querySelectorAll<HTMLImageElement>('img')) {
      if (img.getAttribute('aria-hidden') === 'true') continue;
      const src = img.currentSrc || img.src;
      if (src && !src.startsWith('data:')) return src;
    }
    return null;
  }

  // ===========================================================================
  // PlatformAdapter
  // ===========================================================================

  extractPostContent(article: HTMLElement): PostContent {
    const empty: PostContent = {
      text: '', author: '', handle: '', avatarUrl: null, timeText: null,
      textHtml: '', quote: null, postUrl: null, imageUrls: [], hasMediaContainer: false,
    };

    const cover = this._coverImg(article);
    if (!cover) return empty;
    const card = this._cardFromCover(cover);
    if (!card) return empty;

    const captionEl = this._captionEl(card);
    const text = (captionEl?.textContent ?? '').trim().slice(0, MAX_CAPTION_CHARS);
    const textHtml = captionEl ? captionEl.innerHTML : '';
    const author = this._authorFromCard(card);

    return {
      text,
      author,
      handle: author ? `@${author}` : '',
      avatarUrl: this._avatarFromCard(card),
      timeText: null,
      textHtml,
      quote: null as QuoteContent | null,
      postUrl: null,
      // The cover thumbnail is the image the classifier sees (one per reel).
      imageUrls: [cover.src],
      hasMediaContainer: true,
    };
  }

  shouldProcessCurrentPage(): boolean {
    // Process broadly — the cover-img selector self-limits to reels, so we don't
    // need a path allow-list. Skip only obvious non-feed surfaces.
    const path = window.location.pathname;
    return !path.startsWith('/direct') && !path.startsWith('/accounts');
  }

  // Reels has no "focal post vs replies" notion — never treat one as the main
  // post, and never treat a page as a permalink thread. A /reel/<id>/ URL is
  // still just one reel in the same vertical viewer, not a post + comments
  // view, so there are no replies for the pipeline to gate on.
  isMainPost(): boolean {
    return false;
  }

  isPermalinkView(): boolean {
    return false;
  }

  // Per-reel feed cards carry no stable permalink anchor; rely on the thumbnail
  // pathname (the media filename) for identity instead.
  getPostUrl(): string | null {
    return null;
  }

  getPostContentKey(article: HTMLElement): string {
    const cover = this._coverImg(article);
    if (cover) {
      try { return new URL(cover.src).pathname; } catch { return cover.src; }
    }
    return article.querySelector(this.selectors.textContent)?.textContent?.slice(0, 200) ?? '';
  }

  getPostContainer(article: HTMLElement): HTMLElement {
    const cover = this._coverImg(article);
    return (cover && this._cardFromCover(cover)) || article;
  }

  hidePost(article: HTMLElement): void {
    const element = this.getPostContainer(article);
    const rect = element.getBoundingClientRect();
    element.dataset.filteredByExtension = 'true';
    if (rect.bottom > 0) {
      element.style.display = 'none';
    }
    // Entirely above viewport: the scroll handler fades it later.
  }

  showPost(article: HTMLElement): void {
    const element = this.getPostContainer(article);
    delete element.dataset.filteredByExtension;
    element.style.display = '';
    element.style.visibility = '';
    element.style.opacity = '';
    element.style.transition = '';
    article.style.opacity = '';
    article.style.transition = '';
  }

  getThemeMode(): 'light' | 'dim' | 'dark' {
    // Instagram has light/dark only. Derive from body background luminance.
    const bg = window.getComputedStyle(document.body).backgroundColor;
    const m = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (m) {
      const [, r, g, b] = m.map(Number);
      if (r + g + b < 384) return 'dark';
    }
    return 'light';
  }

  extractPostContentFromStore(article: HTMLElement): Promise<PostContent | null> {
    // Instagram exposes no client-side store we tap. Use DOM extraction, but
    // return null while the reel's <video> hasn't mounted yet (no card) so the
    // content script retries on a later mutation instead of skipping the reel.
    const content = this.extractPostContent(article);
    if (!content.text && content.imageUrls.length === 0) return Promise.resolve(null);
    return Promise.resolve(content);
  }

  cleanupFilteredPostHtml(postContent: HTMLElement, imageUrls: string[]): void {
    // Reset any hidden state captured in the snapshot before re-rendering it in
    // the "filtered posts" panel.
    postContent.style.display = '';
    postContent.style.opacity = '1';
    postContent.removeAttribute('data-filtered-by-extension');

    // Live <video>/blob media won't survive outside the feed — drop and re-insert
    // the captured thumbnail as a static <img>.
    postContent.querySelectorAll('video').forEach(v => v.remove());
    if (imageUrls && imageUrls.length > 0) {
      const container = document.createElement('div');
      container.className = 'slop-media-container';
      imageUrls.forEach(url => {
        const img = document.createElement('img');
        img.src = url;
        img.className = 'slop-media-image';
        img.loading = 'lazy';
        container.appendChild(img);
      });
      postContent.appendChild(container);
    }
  }

  // No inline action button on reels — returning null makes the pipeline skip
  // injecting the per-post trash control (addWhyAnnoyingButton early-returns).
  getShareButton(): HTMLElement | null {
    return null;
  }

  insertActionButton(): void {
    // No-op: see getShareButton.
  }

  getSearchForm(): HTMLElement | null {
    return document.querySelector<HTMLElement>('input[aria-label="Search input"]')
      ?? document.querySelector<HTMLElement>('input[type="search"]');
  }
};

// Self-guard by hostname so the X / LinkedIn / YouTube adapter scripts injected
// alongside this one on iOS don't fight over window.BouncerAdapter.
// Regex mirrors src/shared/platforms.ts PLATFORM_RUNTIME.instagram.hostPattern.
if (/(^|\.)instagram\.com$/i.test(location.hostname)) {
  window.BouncerAdapter = BouncerInstagramAdapter;
}
