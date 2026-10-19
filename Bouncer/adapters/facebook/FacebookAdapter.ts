// facebook adaptation
//
// Facebook platform adapter supporting BOTH of Facebook's feed layouts:
//
//   1. Desktop web (www.facebook.com, the "Comet" React UI) — the Chrome /
//      Firefox / macOS Safari extensions, and iPad (which the app serves a
//      Mac user agent).
//   2. Mobile web (m.facebook.com) — what the iPhone app's WKWebView and the
//      Android app's GeckoView get, since both send a phone user agent.
//      Facebook renders it with its server-driven "html-renderer": every node
//      is a `data-mcomponent` (MContainer / TextArea / ImageArea / MVideo)
//      with inline sizes, and there are no links or ad-rendering roles.
//
// The two layouts have disjoint post selectors, so the post selector is a
// union and each method dispatches on `_isMobilePost(article)`.
//
// ---- Desktop ----
//
// Facebook's class names are atomic CSS hashes that churn on every deploy, so
// everything here anchors on the few semantic hooks the Comet UI keeps stable
// (verified against the live feed, October 2026):
//
//   - The home feed is the sibling list that follows a visually-hidden
//     <h3>Feed posts</h3> inside [role="main"]. Each child of that list is a
//     virtualization slot holding a `[data-virtualized]` wrapper. Facebook
//     flips the wrapper to "true" and UNMOUNTS the post's contents when it
//     scrolls far off-screen, then mounts a fresh subtree when it comes back.
//     So the post element we hand the content script is the wrapper's child —
//     present only while mounted — and a remount simply surfaces as a new
//     post (the background's verdict cache makes re-evaluation free).
//   - Authored posts carry ad-rendering roles (Facebook reuses its ads markup
//     for organic posts): data-ad-rendering-role="profile_name" for the
//     author block and data-ad-preview="message" for the body text.
//   - The header's "…" menu is a button labelled "Actions for this post by
//     <Name>", next to an "X" link labelled "Hide post by <Name>". These
//     labels are the cleanest source of the author's name (the visible name
//     block also carries "Verified account", "· Follow", co-author suffixes).
//   - Comments rendered inline under a post are [role="article"]; everything
//     we extract skips those so a comment never leaks into the post text.
//
// Non-post feed units (People You May Know, Reels / Pages carousels) have no
// author header. extractPostContent returns empty content for them, which the
// content script records as "nothing to evaluate", and getShareButton returns
// null so no Bounce control is injected.
//
// Facebook obfuscates the timestamp and "Sponsored" label text (characters
// are shuffled in the DOM and re-ordered visually), so desktop timeText is
// left null rather than surfacing garbage.
//
// ---- Mobile ----
//
// Verified against m.facebook.com with an iPhone user agent, October 2026:
//
//   - Feed units are the direct children of the `[data-type="vscroller"]`
//     list that carry `data-tracking-duration-id`. They sit in normal flow
//     with inline heights, so hiding one collapses cleanly. Thin separator
//     containers between units have no tracking id and are left alone.
//   - An authored post is three blocks: a header (avatar, name, time, and a
//     "More options for <Name>" button), the body (text, photos, video
//     thumbnail, shared-post content), then a footer of reaction controls
//     ("…like, double tap and hold for more reactions"). Some posts add a
//     reason row ("Suggested for you") above the header.
//   - The avatar is labelled "<Name> Profile Picture" — the cleanest name.
//     "More options for …" sometimes carries an activity sentence instead
//     ("Jane Doe shared a memory.", "Jane Doe is at The Place."). The time
//     element is labelled "6 hours ago, Public", so mobile gets a timeText.
//   - Text nodes embed private-use-area glyphs (Facebook's icon font) and
//     LTR marks; they are stripped.
//   - Units without a "More options for" header (suggested groups, people
//     carousels) are skipped, as on desktop.

import type { PlatformAdapter, PlatformSelectors, PostContent, QuoteContent } from '../../src/types';
// NOTE: adapters are built with esbuild bundle:false (standalone IIFE per
// manifest content_scripts entry), so we CANNOT import shared/platforms
// here. Keep the hostname check inline. Must match the `facebook` entry in
// src/shared/platforms.ts (PLATFORM_RUNTIME.facebook.hostPattern).

/** Feed post: the mounted child of a virtualization wrapper in the list that
 *  follows the "Feed posts" heading. The `h3 ~ div` scope keeps out the one
 *  other `[data-virtualized]` region in [role="main"], above the feed. */
const POST_SELECTOR = '[role="main"] h3 ~ div [data-virtualized="false"] > div';

/** Mobile feed unit (m.facebook.com html-renderer). */
const MOBILE_POST_SELECTOR = '[data-type="vscroller"] > [data-tracking-duration-id]';
const MORE_OPTIONS_SELECTOR = '[aria-label^="More options for "]';
const PROFILE_PICTURE_SELECTOR = '[aria-label$=" Profile Picture"]';
const MOBILE_TEXT_SELECTOR = '[data-mcomponent="TextArea"], [data-mcomponent="ServerTextArea"]';
/** Footer reaction control — marks where a mobile post's body ends. */
const MOBILE_REACTION_SELECTOR = '[aria-label*="double tap"]';
/** Class on the mobile Bounce button; the tap shield keys off it. */
const MOBILE_BUTTON_CLASS = 'ff-why-annoying-btn--facebook-mobile';
/** Space kept between the mobile button and the "…" button / header text. */
const MOBILE_BUTTON_GAP = 4;
/** Activates a Bounce button without a DOM click. Must match
 *  BOUNCE_ACTIVATE_EVENT in src/content/ui.ts. */
const BOUNCE_ACTIVATE_EVENT = 'ff-bounce-activate';
/** Press events the tap shield keeps away from Facebook's listeners. */
const SHIELDED_EVENTS = [
  'touchstart', 'touchmove', 'touchend', 'touchcancel',
  'pointerdown', 'pointerup', 'pointercancel',
  'mousedown', 'mouseup', 'click', 'contextmenu',
];
let tapShieldInstalled = false;

/** Facebook's icon-font glyphs (private use areas) and directional marks. */
const MOBILE_GLYPH_RE = /[\uE000-\uF8FF\u{F0000}-\u{10FFFF}\u200E\u200F]/gu;

const ACTIONS_BUTTON_SELECTOR = '[aria-label^="Actions for this post by "]';
const HIDE_BUTTON_SELECTOR = '[aria-label^="Hide post by "]';
const MESSAGE_SELECTOR = '[data-ad-preview="message"]';
const PROFILE_NAME_SELECTOR = '[data-ad-rendering-role="profile_name"]';
const COMMENT_SELECTOR = '[role="article"]';

/** How long extraction waits for a video's first-frame image to appear. */
const VIDEO_FRAME_WAIT_MS = 2500;
/** Cap on remembered filtered mobile posts (see _installMobileRerenderGuard). */
const MAX_FILTERED_IDENTITIES = 1000;
/** Mobile renderer class on units it currently draws; see _syncRendererRecord. */
const RENDERER_DISPLAYED_CLASS = 'displayed';
/** Renderer state we overrode on a hidden unit, restored on unhide. */
const SAVED_DISPLAYED_ATTR = 'data-ff-fb-undisplayed';
const SAVED_ACTUAL_HEIGHT_ATTR = 'data-ff-fb-actual-height';
const SAVED_HEIGHT_ATTR = 'data-ff-fb-height';

/** Paths that show Facebook's main News Feed. */
const FEED_PATHS = new Set(['/', '/home.php']);

/** Permalink-ish link patterns that identify a single post. */
const PERMALINK_RE = /\/(posts|videos|reel)\/|\/permalink\.php|story_fbid=|\/photo\/?\?fbid=|\/watch\/?\?v=/;

const BouncerFacebookAdapter = class FacebookAdapter implements PlatformAdapter {
  siteId = 'facebook' as const;

  selectors: PlatformSelectors = {
    post: `${POST_SELECTOR}, ${MOBILE_POST_SELECTOR}`,
    // Right-hand rail ("Sponsored", "Friend requests", "Contacts"). It is a
    // sticky, viewport-tall box whose content scrolls inside an inner
    // overflow container; sidebarContent targets that scroller's content so
    // the filter box lands at the top of the rail's own scroll flow, where
    // facebook.css pins it with position: sticky.
    sidebar: '#right_rail_container, [role="complementary"]',
    sidebarContent: ':scope > div > div > div',
    // Main feed column.
    primaryColumn: '[role="main"]',
    // Top bar. Used only to anchor the narrow-window filter box.
    nav: '[role="banner"]',
    bottomBar: '',
    // Post body text — a re-render here inside a still-mounted post triggers
    // a content-key check (see getPostContentKey).
    // Video players mount lazily inside already-processed posts; their
    // arrival re-checks the content key (which includes the first frame).
    mutations: `${MESSAGE_SELECTOR}, ${MOBILE_TEXT_SELECTOR}, video`,
    textContent: `${MESSAGE_SELECTOR}, ${MOBILE_TEXT_SELECTOR}`,
  };

  constructor() {
    this._initFilteredPostObserver();
    this._installMobileTapShield();
    this._installMobileRerenderGuard();
  }

  /** The mobile renderer drops feed units and later inserts brand-new
   *  elements for the same posts (new tracking id, none of our attributes):
   *  it rebuilds whole runs of units in place, and re-mounts units it
   *  dropped long ago when the reader scrolls back up. A filtered post would
   *  come back full height — shoving the feed down — and since it's usually
   *  above the viewport, the cached verdict's hidePost would only mark it,
   *  leaving it visible. So remember every filtered post by identity, for as
   *  long as it stays filtered, and re-apply its state to any new copy from
   *  a MutationObserver callback, which runs before the browser paints.
   *  The record mirrors the DOM: it's written when a unit gains the
   *  filtered marker and dropped when a unit loses it (the content
   *  script's restore paths clear the marker), so restored posts come back
   *  visible. */
  private _installMobileRerenderGuard() {
    const filtered = new Map<string, { hidden: boolean }>();
    const remember = (unit: HTMLElement) => {
      const key = this._mobileIdentity(unit);
      if (!key) return;
      filtered.delete(key); // re-insert so the cap evicts the oldest
      filtered.set(key, { hidden: unit.hasAttribute('data-ff-fb-hidden') });
      if (filtered.size > MAX_FILTERED_IDENTITIES) {
        filtered.delete(filtered.keys().next().value!);
      }
    };
    const units = (node: Node): HTMLElement[] => {
      if (!(node instanceof HTMLElement)) return [];
      if (node.matches(MOBILE_POST_SELECTOR)) return [node];
      return Array.from(node.querySelectorAll<HTMLElement>(MOBILE_POST_SELECTOR));
    };
    new MutationObserver(records => {
      for (const record of records) {
        if (record.type === 'attributes') {
          const unit = record.target;
          // Not MOBILE_POST_SELECTOR: the unit may already be detached by
          // the time this batch is delivered, and its final state still counts.
          if (!(unit instanceof HTMLElement) || !unit.hasAttribute('data-tracking-duration-id')) continue;
          // The renderer rewrites its record of a unit (class, measured
          // height, inline style) as it nears the viewport, and restore paths
          // clear our marker without unhiding through us.
          this._syncRendererRecord(unit);
          if (record.attributeName !== 'data-filtered-by-extension' && record.attributeName !== 'data-ff-fb-hidden') continue;
          if (unit.dataset.filteredByExtension === 'true') {
            remember(unit);
          } else if (record.attributeName === 'data-filtered-by-extension') {
            const key = this._mobileIdentity(unit);
            if (key) filtered.delete(key);
          }
          continue;
        }
        if (filtered.size === 0) continue;
        for (const node of record.addedNodes) {
          for (const unit of units(node)) {
            if (unit.dataset.filteredByExtension) continue;
            const key = this._mobileIdentity(unit);
            const entry = key ? filtered.get(key) : undefined;
            if (!entry) continue;
            unit.dataset.filteredByExtension = 'true';
            if (entry.hidden) this._setHidden(unit, true);
          }
        }
      }
    }).observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-filtered-by-extension', 'data-ff-fb-hidden', 'class', 'style', 'data-actual-height'],
    });
  }

  /** Author + start of the body: stable across the renderer rebuilding a
   *  unit (which reassigns its tracking id and re-renders reaction counts).
   *  Kept short so a "See more" expansion doesn't change it. */
  private _mobileIdentity(unit: HTMLElement): string | null {
    const content = this._extractMobileContent(unit);
    return content.author ? `${content.author}|${content.text.substring(0, 100)}` : null;
  }

  /** m.facebook.com routes taps with listeners that run before anything on
   *  our button can react: a tap on the Bounce button inside a post opened
   *  the post. So intercept press events at the earliest point of their
   *  path — a window capture listener — whenever they target the mobile
   *  Bounce button, and stop them there so no Facebook listener (capture,
   *  bubble, or on* property) ever sees them. The click is then turned into
   *  BOUNCE_ACTIVATE_EVENT, which Bouncer's button handler also answers.
   *  No preventDefault on touch events, so the browser still synthesizes the
   *  click and scrolling that starts on the button still works. */
  private _installMobileTapShield() {
    if (tapShieldInstalled) return;
    tapShieldInstalled = true;
    const shield = (e: Event) => {
      const target = e.target;
      const btn = target instanceof Element
        ? target.closest<HTMLElement>(`.${MOBILE_BUTTON_CLASS}`)
        : null;
      if (!btn) return;
      e.stopPropagation();
      if (e.type === 'click') {
        e.preventDefault();
        btn.dispatchEvent(new CustomEvent(BOUNCE_ACTIVATE_EVENT));
      }
    };
    for (const type of SHIELDED_EVENTS) {
      window.addEventListener(type, shield, { capture: true, passive: type !== 'click' });
    }
  }

  // Posts filtered while entirely above the viewport are only marked by
  // hidePost: collapsing them there would yank the feed up under the reader
  // (WebKit has no scroll anchoring to compensate). They fade out once the
  // reader scrolls back up to them, matching the Twitter adapter.
  private _initFilteredPostObserver() {
    const fadingOut = new Set<Element>();
    const scrollHandler = () => {
      const marked = document.querySelectorAll('[data-filtered-by-extension="true"]');
      for (const el of marked) {
        if (!(el instanceof HTMLElement)) continue;
        if (el.style.display === 'none' || fadingOut.has(el)) continue;
        const rect = el.getBoundingClientRect();
        // The renderer collapsed it (scrolled far away): hiding it now moves
        // nothing, and keeps it from expanding visible later.
        if (!this._isRendered(rect)) {
          this._setHidden(el, true);
          continue;
        }
        if (rect.top >= 100) {
          fadingOut.add(el);
          el.style.transition = 'opacity 0.3s ease';
          el.style.opacity = '0';
          setTimeout(() => {
            this._setHidden(el, true);
            fadingOut.delete(el);
          }, 300);
        }
      }
    };
    // Capture so an inner scroller's scroll events count too, not just the
    // window's.
    document.addEventListener('scroll', scrollHandler, { capture: true, passive: true });
  }

  // ===========================================================================
  // Extraction
  // ===========================================================================

  /** Mobile posts are html-renderer feed units; everything else is desktop. */
  private _isMobilePost(el: HTMLElement): boolean {
    return el.matches(MOBILE_POST_SELECTOR) || el.closest(MOBILE_POST_SELECTOR) !== null;
  }

  /** Hide/unhide a feed slot. The inline display covers the desktop feed;
   *  the attribute (backed by a display:none !important rule in
   *  facebook.css) survives the mobile renderer rewriting a unit's inline
   *  style when it re-measures it. */
  private _setHidden(el: HTMLElement, hidden: boolean): void {
    el.style.display = hidden ? 'none' : '';
    if (hidden) el.setAttribute('data-ff-fb-hidden', '');
    else el.removeAttribute('data-ff-fb-hidden');
    this._syncRendererRecord(el);
  }

  /** The mobile renderer sizes the feed from its own record of each unit:
   *  the `displayed` class (drawn or collapsed), and the height it measured,
   *  kept in `data-actual-height` and the inline height. A hidden unit still
   *  recorded at full height makes the feed jump by that height when the
   *  renderer collapses it (once the post below it scrolls off the top), and
   *  back again on the way up. So while a unit is hidden, record it as a
   *  collapsed, zero-height unit, re-applying that whenever the renderer
   *  rewrites it; the originals are restored on unhide. */
  private _syncRendererRecord(el: HTMLElement): void {
    if (!el.hasAttribute('data-tracking-duration-id')) return;
    const hidden = el.hasAttribute('data-ff-fb-hidden') && el.dataset.filteredByExtension === 'true';
    if (hidden) {
      if (el.classList.contains(RENDERER_DISPLAYED_CLASS)) {
        el.classList.remove(RENDERER_DISPLAYED_CLASS);
        el.setAttribute(SAVED_DISPLAYED_ATTR, '');
      }
      const actual = el.getAttribute('data-actual-height');
      if (actual !== null && actual !== '0') {
        el.setAttribute(SAVED_ACTUAL_HEIGHT_ATTR, actual);
        el.setAttribute('data-actual-height', '0');
      }
      if (el.style.height && el.style.height !== '0px') {
        el.setAttribute(SAVED_HEIGHT_ATTR, el.style.height);
        el.style.height = '0px';
      }
      return;
    }
    if (el.hasAttribute(SAVED_DISPLAYED_ATTR)) {
      el.removeAttribute(SAVED_DISPLAYED_ATTR);
      el.classList.add(RENDERER_DISPLAYED_CLASS);
    }
    const actual = el.getAttribute(SAVED_ACTUAL_HEIGHT_ATTR);
    if (actual !== null) {
      el.removeAttribute(SAVED_ACTUAL_HEIGHT_ATTR);
      el.setAttribute('data-actual-height', actual);
    }
    const height = el.getAttribute(SAVED_HEIGHT_ATTR);
    if (height !== null) {
      el.removeAttribute(SAVED_HEIGHT_ATTR);
      el.style.height = height;
    }
  }

  /** True for posts with an author header — excludes carousels and
   *  suggestion units, which share the feed list. */
  private _isAuthoredPost(article: HTMLElement): boolean {
    return article.querySelector(PROFILE_NAME_SELECTOR) !== null
      || article.querySelector(HIDE_BUTTON_SELECTOR) !== null;
  }

  /** querySelectorAll, minus matches inside inline comments. */
  private _queryOutsideComments<T extends Element>(article: HTMLElement, selector: string): T[] {
    return Array.from(article.querySelectorAll<T>(selector)).filter(el => {
      const comment = el.closest(COMMENT_SELECTOR);
      return comment === null || !article.contains(comment);
    });
  }

  private _cleanText(raw: string): string {
    return raw.replace(/\s+/g, ' ').trim();
  }

  /** Body text without Facebook's inline "See more" / "See less" toggles. */
  private _messageText(el: Element | null): string {
    if (!el) return '';
    const clone = el.cloneNode(true) as Element;
    clone.querySelectorAll('[role="button"], button').forEach(b => b.remove());
    return this._cleanText(clone.textContent ?? '');
  }

  /** innerHTML snapshot for the filtered-posts panel, minus interactive
   *  controls (the static snapshot has no JS, so they'd be dead anyway). */
  private _messageHtml(el: Element | null): string {
    if (!el) return '';
    const clone = el.cloneNode(true) as Element;
    clone.querySelectorAll('[role="button"], button').forEach(b => b.remove());
    return clone.innerHTML;
  }

  private _emptyContent(): PostContent {
    return {
      text: '',
      author: '',
      handle: '',
      avatarUrl: null,
      timeText: null,
      textHtml: '',
      quote: null,
      postUrl: null,
      imageUrls: [],
      hasMediaContainer: false,
    };
  }

  extractPostContent(article: HTMLElement): PostContent {
    return this._isMobilePost(article)
      ? this._extractMobileContent(article)
      : this._extractDesktopContent(article);
  }

  private _extractDesktopContent(article: HTMLElement): PostContent {
    if (!this._isAuthoredPost(article)) return this._emptyContent();

    const messages = this._queryOutsideComments<HTMLElement>(article, MESSAGE_SELECTOR);
    const mainMsg = messages[0] ?? null;
    const imageUrls = this._extractImageUrls(article);
    const hasVideo = article.querySelector('video') !== null;

    return {
      text: this._messageText(mainMsg),
      author: this._extractAuthor(article),
      handle: '',
      avatarUrl: this._extractAvatarUrl(article),
      timeText: null,
      textHtml: this._messageHtml(mainMsg),
      quote: this._extractQuote(messages),
      postUrl: this.getPostUrl(article),
      imageUrls,
      hasMediaContainer: imageUrls.length > 0 || hasVideo,
      hasVideo,
    };
  }

  /** "Hide post by Jane Doe" / "Actions for this post by Jane Doe" → "Jane
   *  Doe". Falls back to the header's profile link text. */
  private _extractAuthor(article: HTMLElement): string {
    if (this._isMobilePost(article)) return this._extractMobileAuthor(article);
    for (const sel of [HIDE_BUTTON_SELECTOR, ACTIONS_BUTTON_SELECTOR]) {
      const label = article.querySelector(sel)?.getAttribute('aria-label') ?? '';
      const name = label.replace(/^.*?\bby\s+/i, '').trim();
      if (name) return name;
    }
    const nameLink = article.querySelector(`${PROFILE_NAME_SELECTOR} a, h4 a`);
    return this._cleanText(nameLink?.textContent ?? '');
  }

  /** Author avatar: the header renders it as an SVG <image> in a circular
   *  mask. The first one outside comments belongs to the author. */
  private _extractAvatarUrl(article: HTMLElement): string | null {
    const imgs = this._queryOutsideComments<SVGImageElement>(article, 'svg image');
    for (const img of imgs) {
      const href = img.getAttribute('xlink:href') || img.getAttribute('href') || '';
      if (href && !href.startsWith('data:')) return href;
    }
    return null;
  }

  /** A share ("X shared a post") renders the original post's body as a
   *  second message block. Its author isn't exposed by a stable hook, so
   *  only the text is carried. */
  private _extractQuote(messages: HTMLElement[]): QuoteContent | null {
    if (messages.length < 2) return null;
    const qMsg = messages[messages.length - 1];
    return {
      textHtml: this._messageHtml(qMsg),
      author: '',
      handle: '',
      avatarUrl: null,
      timeText: null,
    };
  }

  /** Post media for the classifiers: the first frame of each video first
   *  (the backend checks at most four images, and a video's frame is the
   *  post's main visual), then photos and link-preview images. */
  private _extractImageUrls(article: HTMLElement): string[] {
    const urls = this._videoFrameUrls(this._queryOutsideComments<HTMLVideoElement>(article, 'video'));
    for (const img of this._queryOutsideComments<HTMLImageElement>(article, 'img')) {
      const src = this._contentImageSrc(img);
      if (src && !urls.includes(src)) urls.push(src);
    }
    return urls;
  }

  /** First-frame image of each video: its poster, which Facebook generates
   *  from the opening frame and serves from its photo CDN. Videos without a
   *  usable poster yet are skipped here; extractPostContentFromStore waits
   *  briefly for one to appear. */
  private _videoFrameUrls(videos: HTMLVideoElement[]): string[] {
    const urls: string[] = [];
    for (const v of videos) {
      const poster = v.getAttribute('poster') || v.poster || '';
      if (this._isPhotoCdnUrl(poster) && !urls.includes(poster)) urls.push(poster);
    }
    return urls;
  }

  /** An <img>'s URL when it is post content: on Facebook's photo CDN and
   *  photo-sized (reaction glyphs and inline icons are tiny; fall back to
   *  intrinsic size before layout). Null otherwise. */
  private _contentImageSrc(img: HTMLImageElement): string | null {
    const src = img.currentSrc || img.src;
    if (!this._isPhotoCdnUrl(src)) return null;
    const w = img.width || img.naturalWidth;
    const h = img.height || img.naturalHeight;
    if (w && h && (w < 64 || h < 64)) return null;
    return src;
  }

  /** Facebook photo CDN: the `scontent…` hosts under fbcdn.net. Must match
   *  the backend's allowlist (is_allowed_image_host in the backend's
   *  lambda/shared.py) — other fbcdn hosts serve UI assets and are rejected
   *  there, which fails the whole AI-image request when no URL survives. */
  private _isPhotoCdnUrl(url: string): boolean {
    if (!url.startsWith('https://')) return false;
    const host = this._host(url).toLowerCase();
    return host.endsWith('.fbcdn.net') && host.split('.', 1)[0].startsWith('scontent');
  }

  // ===========================================================================
  // Mobile-web extraction
  // ===========================================================================

  private _mobileText(el: Element | null): string {
    return this._cleanText((el?.textContent ?? '').replace(MOBILE_GLYPH_RE, ''));
  }

  /** The unit's direct-child blocks split into header and body. Null when
   *  the unit has no authored-post header (suggestion carousels etc.). */
  private _mobileParts(article: HTMLElement): { header: HTMLElement; body: HTMLElement[] } | null {
    const more = article.querySelector(MORE_OPTIONS_SELECTOR);
    if (!more) return null;
    const blocks = Array.from(article.children).filter((c): c is HTMLElement => c instanceof HTMLElement);
    const hi = blocks.findIndex(b => b.contains(more));
    if (hi < 0) return null;
    const body: HTMLElement[] = [];
    for (const b of blocks.slice(hi + 1)) {
      if (b.querySelector(MOBILE_REACTION_SELECTOR)) break;
      body.push(b);
    }
    return { header: blocks[hi], body };
  }

  private _extractMobileContent(article: HTMLElement): PostContent {
    const parts = this._mobileParts(article);
    if (!parts) return this._emptyContent();

    // Body text: each text node's cleaned text, in order. Facebook's
    // "… See more" expander is a trailing text run; drop it.
    const lines = parts.body
      .flatMap(b => Array.from(b.querySelectorAll<HTMLElement>(MOBILE_TEXT_SELECTOR)))
      .map(t => this._mobileText(t).replace(/(?:\.\.\.|…)?\s*See more$/i, '').trim())
      .filter(Boolean);
    const text = lines.join('\n');
    // Panel snapshot: plain paragraphs built from text, never page markup.
    const textHtml = lines.map(l => `<p>${this._escapeHtml(l)}</p>`).join('');

    const imageUrls = this._extractMobileImageUrls(parts.body);
    const hasVideo = article.querySelector('[data-mcomponent="MVideo"], video') !== null;

    return {
      text,
      author: this._extractMobileAuthor(article),
      handle: '',
      avatarUrl: this._extractMobileAvatarUrl(parts.header),
      timeText: this._extractMobileTime(parts.header),
      textHtml,
      quote: null,
      postUrl: null,
      imageUrls,
      hasMediaContainer: imageUrls.length > 0 || hasVideo,
      hasVideo,
    };
  }

  private _escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /** "<Name> Profile Picture" when present; otherwise the "More options for"
   *  label, cut before an activity sentence ("Jane Doe is at The Place."). */
  private _extractMobileAuthor(article: HTMLElement): string {
    const pic = article.querySelector(PROFILE_PICTURE_SELECTOR)?.getAttribute('aria-label') ?? '';
    const fromPic = pic.replace(/\s+Profile Picture$/, '').trim();
    if (fromPic) return fromPic;
    let label = (article.querySelector(MORE_OPTIONS_SELECTOR)?.getAttribute('aria-label') ?? '')
      .replace(/^More options for\s+/, '').trim();
    if (label.endsWith('.')) {
      label = label.replace(/\s+(?:is|was|shared|added|updated|changed|in|at|with|feeling|and)\s.*$/, '');
    }
    return this._cleanText(label.replace(MOBILE_GLYPH_RE, ''));
  }

  private _extractMobileAvatarUrl(header: HTMLElement): string | null {
    const img = header.querySelector<HTMLImageElement>(`${PROFILE_PICTURE_SELECTOR} img`)
      ?? header.querySelector<HTMLImageElement>('img');
    const src = img?.currentSrc || img?.src || '';
    return src && !src.startsWith('data:') ? src : null;
  }

  /** "6 hours ago, Public" / "Jane Doe, 2 days ago, Public group" → the
   *  "… ago" segment. Older posts show a date with no "ago" label; null. */
  private _extractMobileTime(header: HTMLElement): string | null {
    for (const el of header.querySelectorAll('[aria-label]')) {
      const seg = (el.getAttribute('aria-label') ?? '').split(',')
        .map(x => x.trim()).find(x => /\bago$/.test(x));
      if (seg) return seg;
    }
    return null;
  }

  /** Body media: each video's first frame first (the poster of a playing
   *  <video>; before autoplay the MVideo shows the same frame as an <img>),
   *  then photos and thumbnails. */
  private _extractMobileImageUrls(body: HTMLElement[]): string[] {
    const urls = this._videoFrameUrls(body.flatMap(b => Array.from(b.querySelectorAll<HTMLVideoElement>('video'))));
    for (const img of body.flatMap(b => Array.from(b.querySelectorAll<HTMLImageElement>('img')))) {
      const src = this._contentImageSrc(img);
      if (src && !urls.includes(src)) urls.push(src);
    }
    return urls;
  }

  private _host(url: string): string {
    try {
      return new URL(url).hostname;
    } catch {
      return '';
    }
  }

  // ===========================================================================
  // Page / identity
  // ===========================================================================

  shouldProcessCurrentPage(): boolean {
    return FEED_PATHS.has(window.location.pathname);
  }

  // Comments are not feed posts here, so there's no reply view to gate.
  isPermalinkView(): boolean {
    return false;
  }

  isMainPost(): boolean {
    return false;
  }

  getPostUrl(article: HTMLElement): string | null {
    // Facebook writes the real permalink into the timestamp link only on
    // hover; before that it is a bare "/?__cft__…" placeholder. Take the
    // first link outside comments that already points at a post, photo, or
    // video, and drop the tracking query (keeping ids that live in it).
    const links = this._queryOutsideComments<HTMLAnchorElement>(article, 'a[href]');
    for (const a of links) {
      const href = a.href;
      if (!PERMALINK_RE.test(href)) continue;
      try {
        const u = new URL(href);
        const keep = new URLSearchParams();
        for (const k of ['story_fbid', 'id', 'fbid', 'v']) {
          const val = u.searchParams.get(k);
          if (val) keep.set(k, val);
        }
        const qs = keep.toString();
        return u.origin + u.pathname + (qs ? `?${qs}` : '');
      } catch {
        return href.split('?')[0];
      }
    }
    return null;
  }

  getPostContentKey(article: HTMLElement): string {
    // Posts unmount and remount rather than being recycled in place, so
    // author + the start of the body is a sufficient identity for detecting
    // an in-place re-render with different content.
    const author = this._extractAuthor(article);
    // The first image is part of the key so a video player that mounts after
    // the post was evaluated (bringing its first-frame poster) triggers a
    // re-evaluation instead of leaving the post judged without an image.
    const firstImage = this.extractPostContent(article).imageUrls[0] ?? '';
    if (this._isMobilePost(article)) {
      return `${author}|${this.extractPostContent(article).text.substring(0, 200)}|${firstImage}`;
    }
    const msg = this._queryOutsideComments<HTMLElement>(article, MESSAGE_SELECTOR)[0];
    const body = this._messageText(msg ?? null).substring(0, 200);
    return `${this.getPostUrl(article) || `${author}|${body}`}|${firstImage}`;
  }

  getPostContainer(article: HTMLElement): HTMLElement {
    // Mobile: the feed unit itself is the list child.
    if (this._isMobilePost(article)) {
      return article.closest<HTMLElement>(MOBILE_POST_SELECTOR) ?? article;
    }
    // Hide the whole virtualization slot — the feed list's direct child — so
    // no card margin is left behind. The list is the element whose parent
    // also holds the "Feed posts" <h3>.
    let el: HTMLElement = article;
    for (let depth = 0; depth < 25 && el.parentElement; depth++) {
      const parent = el.parentElement;
      if (parent.parentElement?.querySelector(':scope > h3') && parent.tagName !== 'H3') {
        return el;
      }
      el = parent;
    }
    // Layout drift fallback: the virtualization wrapper's parent.
    return article.closest<HTMLElement>('[data-virtualized]')?.parentElement ?? article;
  }

  hidePost(article: HTMLElement): void {
    const element = this.getPostContainer(article);
    const rect = element.getBoundingClientRect();
    element.dataset.filteredByExtension = 'true';
    // Hide now unless the post is drawn entirely above the viewport. A post
    // the mobile renderer has collapsed (display:none until the reader gets
    // close) has an all-zero rect; collapsing it moves nothing, and leaving
    // it merely marked let it expand visible later, scrolled past or above.
    if (rect.bottom > 0 || !this._isRendered(rect)) {
      this._setHidden(element, true);
    }
    // If drawn entirely above the viewport, the scroll handler fades it later
    // so the feed doesn't jump under the reader.
  }

  private _isRendered(rect: DOMRect): boolean {
    return rect.width > 0 || rect.height > 0;
  }

  showPost(article: HTMLElement): void {
    const element = this.getPostContainer(article);
    delete element.dataset.filteredByExtension;
    this._setHidden(element, false);
    element.style.visibility = '';
    element.style.opacity = '';
    element.style.transition = '';
    article.style.opacity = '';
    article.style.transition = '';
  }

  getThemeMode(): 'light' | 'dim' | 'dark' {
    // Facebook toggles __fb-dark-mode / __fb-light-mode on <html>. No dim.
    const html = document.documentElement;
    if (html.classList.contains('__fb-dark-mode')) return 'dark';
    if (html.classList.contains('__fb-light-mode')) return 'light';
    const bg = window.getComputedStyle(document.body).backgroundColor;
    const m = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (m) {
      const [, r, g, b] = m.map(Number);
      if (r + g + b < 384) return 'dark';
    }
    return 'light';
  }

  async extractPostContentFromStore(article: HTMLElement): Promise<PostContent | null> {
    // No client-side store hook; the DOM is the source of truth. Never return
    // null — the content script would retry and then give up on the post.
    let content = this.extractPostContent(article);
    // A video's frame can lag the post: the player mounts lazily and the
    // poster is set after it. Evaluating now would classify the post with
    // no image at all, so give the frame a moment to arrive.
    const deadline = Date.now() + VIDEO_FRAME_WAIT_MS;
    while (this._awaitingVideoFrame(article, content) && Date.now() < deadline && article.isConnected) {
      await new Promise(resolve => setTimeout(resolve, 150));
      content = this.extractPostContent(article);
    }
    return content;
  }

  /** True while the post shows a video but no frame image has been found. */
  private _awaitingVideoFrame(article: HTMLElement, content: PostContent): boolean {
    if (!content.author || content.imageUrls.length > 0) return false;
    return article.querySelector('video, [data-mcomponent="MVideo"]') !== null;
  }

  cleanupFilteredPostHtml(postContent: HTMLElement, imageUrls: string[]): void {
    postContent.style.display = '';
    postContent.style.opacity = '1';
    postContent.removeAttribute('data-filtered-by-extension');
    // blob: video sources don't survive outside the live feed.
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

  // ===========================================================================
  // Bounce control
  // ===========================================================================

  /** Climb from a header control to its slot in the header row: the chain
   *  above each control is single-child wrappers up to the row itself. */
  private _headerCell(control: HTMLElement): HTMLElement {
    let el = control;
    while (el.parentElement && el.parentElement.children.length === 1) {
      el = el.parentElement;
    }
    return el;
  }

  getShareButton(article: HTMLElement): HTMLElement | null {
    // Anchor on the header's "…" menu. Only authored posts have the
    // "…by <Name>" / "More options for <Name>" variants, so carousels never
    // get a Bounce control.
    return article.querySelector<HTMLElement>(ACTIONS_BUTTON_SELECTOR)
      ?? article.querySelector<HTMLElement>(MORE_OPTIONS_SELECTOR);
  }

  insertActionButton(article: HTMLElement, button: HTMLElement): void {
    const actions = this.getShareButton(article);
    if (!actions) {
      article.appendChild(button);
      return;
    }
    if (this._isMobilePost(article)) {
      this._insertMobileActionButton(actions, button);
      return;
    }
    const actionsCell = this._headerCell(actions);
    button.classList.add('ff-why-annoying-btn--facebook-header');
    // Our control takes the place of Facebook's "X" (Hide post), matching
    // its box so the header row keeps its rhythm.
    const hide = article.querySelector<HTMLElement>(HIDE_BUTTON_SELECTOR);
    const ref = hide ? this._headerCell(hide) : actionsCell;
    const rect = ref.getBoundingClientRect();
    if (rect.width && rect.height) {
      button.style.width = `${rect.width}px`;
      button.style.height = `${rect.height}px`;
    }
    if (hide) this._headerCell(hide).style.display = 'none';
    actionsCell.insertAdjacentElement('afterend', button);
  }

  /** Mobile header row: the renderer lays it out as a column flexbox and
   *  places every child with inline margins, so inserting into its flow
   *  would shift Facebook's own controls. The button is absolutely
   *  positioned (the row is position: relative) just left of the "…" button,
   *  level with it. The renderer lays out text itself, as fixed-width pieces
   *  ("Name", " · ", "Follow") inside a name column that runs right up to
   *  "…", so nothing can be made to wrap around the button: when a long
   *  name line reaches into that spot (common at phone widths), the button
   *  goes directly below "…" instead, where the row is always empty.
   *  Re-placed whenever the row or "…" is laid out or resized — posts are
   *  often processed before layout.
   *
   *  The renderer also sets `pointer-events: none` on its layout containers
   *  (only its own controls opt back in), which the button would inherit —
   *  taps would fall through to the post and open it. facebook.css restores
   *  `pointer-events: auto`; it is set inline too so the button stays
   *  tappable even if the stylesheet loads late. */
  private _insertMobileActionButton(more: HTMLElement, button: HTMLElement): void {
    const row = more.parentElement;
    if (!row) return;
    button.classList.add(MOBILE_BUTTON_CLASS);
    button.style.pointerEvents = 'auto';
    const place = () => {
      if (!more.offsetWidth) return;
      const size = button.offsetWidth || 32;
      const left = more.offsetLeft - size - MOBILE_BUTTON_GAP;
      const top = more.offsetTop + (more.offsetHeight - size) / 2;
      if (!this._mobileTextIntrudes(row, more, left, top, size)) {
        button.style.left = `${left}px`;
        button.style.top = `${top}px`;
        return;
      }
      button.style.left = `${more.offsetLeft + (more.offsetWidth - size) / 2}px`;
      button.style.top = `${more.offsetTop + more.offsetHeight}px`;
    };
    // Taps on the button are kept from Facebook by the window-level tap
    // shield (see _installMobileTapShield).
    row.appendChild(button);
    place();
    const observer = new ResizeObserver(place);
    observer.observe(more);
    observer.observe(row);
  }

  /** Whether any of the header's text pieces (other than the "…" glyph)
   *  overlaps a size×size box at (left, top) in the row, with a gap's margin
   *  on the left so text never butts against the button. */
  private _mobileTextIntrudes(row: HTMLElement, more: HTMLElement, left: number, top: number, size: number): boolean {
    const origin = row.getBoundingClientRect();
    for (const text of row.querySelectorAll<HTMLElement>(MOBILE_TEXT_SELECTOR)) {
      if (more.contains(text)) continue;
      const r = text.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      const x = r.left - origin.left;
      const y = r.top - origin.top;
      if (x < left + size && x + r.width > left - MOBILE_BUTTON_GAP
        && y < top + size && y + r.height > top) {
        return true;
      }
    }
    return false;
  }

  getSearchForm(): HTMLElement | null {
    return document.querySelector<HTMLElement>('input[type="search"]')
      ?? document.querySelector<HTMLElement>('[role="search"]');
  }
};

// Self-guard by hostname. On iOS all platform adapter scripts inject on every
// page; without this guard Facebook would clobber other adapters.
// Regex mirrors src/shared/platforms.ts PLATFORM_RUNTIME.facebook.hostPattern.
if (/(^|\.)facebook\.com$/i.test(location.hostname)) {
  window.BouncerAdapter = BouncerFacebookAdapter;
}
