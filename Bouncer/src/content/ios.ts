// iOS FAB, filtered modal, native sheet bridge

import type { IOSDeps } from '../types';
import { clampThreshold } from '../shared/storage';
import { parseHTML } from '../shared/utils';
import { shareFilterPackForIOS } from './ui';

// Bridge globals exposed to native Swift (added to window) and WebKit message
// handler injected by WKWebView. Declaring them here gives ESLint/TS proper
// types and removes the need for `as any` casts throughout this file.
interface FFWindow {
  __ff_addPhrase?: (text: string) => Promise<boolean>;
  __ff_removePhrase?: (phrase: string) => Promise<void>;
  __ff_showFilteredModal?: () => void;
  __ff_getAiTextFilterEnabled?: () => Promise<boolean>;
  __ff_setAiTextFilterEnabled?: (enabled: boolean) => Promise<void>;
  __ff_getAiTextDetectionThreshold?: () => Promise<number>;
  __ff_setAiTextDetectionThreshold?: (value: number) => Promise<void>;
  __ff_shareFilterPack?: () => Promise<{ ok: boolean; error?: string }>;
  __ff_getStorage?: (keys: string[]) => Promise<Record<string, unknown>>;
  __ff_setStorage?: (items: Record<string, unknown>) => Promise<void>;
  __ff_clearModelCache?: () => Promise<void>;
}
interface WebkitMessageHandlers {
  feedfilterPhrasesUpdated?: { postMessage: (msg: string) => void };
}
interface WebkitBridge {
  messageHandlers: WebkitMessageHandlers;
}
declare const webkit: WebkitBridge;

// Dependencies (set by initIOS from index.ts)
let _deps: IOSDeps;

// iOS Safari detection (for Safari Web Extension on iOS)
export function isIOSSafari() {
  const ua = navigator.userAgent;
  // Exclude iPad — it uses desktop Twitter and should get the desktop UI
  const isIPhone = /iPhone|iPod/.test(ua);
  const isSafari = /Safari/.test(ua) && !/Chrome|CriOS|FxiOS/.test(ua);
  return isIPhone && isSafari;
}

export const IS_IOS = isIOSSafari();

export function initIOS(deps: IOSDeps) {
  console.log('[Bouncer][iOS] initIOS called');
  _deps = deps;

  // Bridge functions for native Swift sheet to call back into JS
  const w = window as Window & FFWindow;
  w.__ff_addPhrase = async (text: string): Promise<boolean> => {
    console.log('[Bouncer][iOS] __ff_addPhrase called with:', text);
    const added = await _deps.addFilterPhrase(text);
    console.log('[Bouncer][iOS] addFilterPhrase returned:', added);
    updateIOSFilteredCount();
    return added;
  };
  w.__ff_removePhrase = async (phrase: string): Promise<void> => {
    console.log('[Bouncer][iOS] __ff_removePhrase called with:', phrase);
    await _deps.removeFilterPhrase(phrase);
    updateIOSFilteredCount();
  };

  const _showFilteredModal = showIOSFilteredModal;
  w.__ff_showFilteredModal = () => _showFilteredModal();

  // Native settings page reads/writes BYOK provider keys, selected model,
  // etc. through these generic bridges. Limited to chrome.storage.local
  // and the in-extension `clearCache` message so the surface stays small
  // and we don't expose arbitrary chrome.runtime calls to the native UI.
  w.__ff_getStorage = async (keys: string[]): Promise<Record<string, unknown>> => {
    if (!Array.isArray(keys)) return {};
    return await chrome.storage.local.get(keys);
  };
  w.__ff_setStorage = async (items: Record<string, unknown>): Promise<void> => {
    if (!items || typeof items !== 'object') return;
    await chrome.storage.local.set(items);
  };
  w.__ff_clearModelCache = async (): Promise<void> => {
    try {
      await chrome.runtime.sendMessage({ type: 'clearCache' });
    } catch (err) {
      console.warn('[Bouncer][iOS] clearModelCache failed:', err);
    }
  };

  // AI-text-detection toggle bridge. The native settings page reads/writes
  // chrome.storage.local through these; the storage-change listener in
  // content/index.ts then re-evaluates posts (cache is invalidated by
  // background/index.ts's settings-change handler).
  w.__ff_getAiTextFilterEnabled = async (): Promise<boolean> => {
    const data = await chrome.storage.local.get(['aiTextFilterEnabled']);
    return data.aiTextFilterEnabled === true;
  };
  w.__ff_setAiTextFilterEnabled = async (enabled: boolean): Promise<void> => {
    console.log('[Bouncer][iOS] __ff_setAiTextFilterEnabled:', enabled);
    await chrome.storage.local.set({ aiTextFilterEnabled: enabled === true });
  };
  w.__ff_getAiTextDetectionThreshold = async (): Promise<number> => {
    const data = await chrome.storage.local.get(['aiTextDetectionThreshold']);
    return clampThreshold(data.aiTextDetectionThreshold);
  };
  w.__ff_setAiTextDetectionThreshold = async (value: number): Promise<void> => {
    const n = Number(value);
    if (!Number.isFinite(n)) return;
    const clamped = clampThreshold(n);
    console.log('[Bouncer][iOS] __ff_setAiTextDetectionThreshold:', clamped);
    await chrome.storage.local.set({ aiTextDetectionThreshold: clamped });
  };

  // Native "Share filters" button drives the same composer-paste flow the
  // desktop "Share filters" button uses: render a screenshot of the desktop
  // filter card, encode the bncr2_ share code, click X's compose link, and
  // paste image + caption into the resulting modal. Requires the WebView to
  // be on x.com (the Swift side navigates there before calling).
  w.__ff_shareFilterPack = async (): Promise<{ ok: boolean; error?: string }> => {
    if (!/^https?:\/\/(www\.)?(x|twitter)\.com(\/|$)/.test(location.href)) {
      return { ok: false, error: 'not_on_x' };
    }
    try {
      await shareFilterPackForIOS();
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: msg };
    }
  };

  // Send initial phrases to native Swift UI so the sheet isn't empty on first open
  console.log('[Bouncer][iOS] Sending initial phrases update');
  updateIOSFilteredCount();
}

// State accessors
export function getFFPageActive() { return false; }
export function getIOSPageContainer(): HTMLElement | null { return null; }
export function getFFFabButton(): HTMLElement | null { return null; }

// FAB is now in the native Swift NavBarView — no JS injection needed
export function injectBouncerFAB() {}

// Show iOS filtered posts modal
export function showIOSFilteredModal() {
  // Remove existing modal if any
  hideIOSFilteredModal();

  const backdrop = document.createElement('div');
  backdrop.className = 'ff-ios-filtered-modal-backdrop';
  backdrop.replaceChildren(parseHTML(`
    <div class="ff-ios-filtered-modal">
      <div class="ff-ios-filtered-modal-header">
        <span class="ff-ios-filtered-modal-title">Filtered posts</span>
        <button class="ff-ios-filtered-modal-close" aria-label="Close">&times;</button>
      </div>
      <div class="ff-ios-filtered-modal-content"></div>
    </div>
  `));

  document.body.appendChild(backdrop);

  // Render filtered posts into modal content
  const content = backdrop.querySelector<HTMLElement>('.ff-ios-filtered-modal-content');
  if (content) {
    _deps.renderFilteredPostsView(content);
  }

  // Apply theme
  const theme = _deps.adapter.getThemeMode();
  backdrop.classList.add(`${theme}-mode`);

  // Animate in
  requestAnimationFrame(() => {
    backdrop.classList.add('visible');
  });

  // Close on X button
  backdrop.querySelector('.ff-ios-filtered-modal-close')!.addEventListener('click', () => {
    hideIOSFilteredModal();
  });

  // Close on backdrop click
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) {
      hideIOSFilteredModal();
    }
  });
}

// Hide iOS filtered posts modal
export function hideIOSFilteredModal() {
  const existing = document.querySelector('.ff-ios-filtered-modal-backdrop');
  if (existing) {
    existing.classList.add('closing');
    existing.classList.remove('visible');
    setTimeout(() => {
      if (existing.isConnected) existing.remove();
    }, 350);
  }
}

// Push updated filtered count to native Swift UI
export function updateIOSFilteredCount() {
  if (typeof webkit !== 'undefined' && webkit.messageHandlers?.feedfilterPhrasesUpdated) {
    const count = _deps.getFilteredPosts().length;
    chrome.storage.local.get([_deps.descriptionsKey], (data) => {
      const phrases = (data[_deps.descriptionsKey] as string[] | undefined) || [];
      webkit.messageHandlers.feedfilterPhrasesUpdated?.postMessage(
        JSON.stringify({ phrases, filteredCount: count })
      );
    });
  }
}

// Stub for renderIOSCategories — no longer needed with native sheet
export function renderIOSCategories(_page: HTMLElement) {}

// Handle DOM mutations related to iOS elements (called from index.ts uiObserver)
export function handleDOMMutationIOS() {}

// ==================== Import-Pack Genie Animation ====================

/**
 * iOS counterpart to the desktop "fly the tweet image into the Bouncer box"
 * animation. The native Bouncer FAB sits in a UIKit toolbar below the
 * WebView, so we can't actually deliver pixels into it from JS — instead we
 * genie the tweet's photo down off the bottom of the viewport, where the
 * native FAB visually sits just below.
 *
 * If the tweet has no photo (text-only) we just run the import without
 * animation — there's no "screenshot" to genie.
 */
export async function runIOSImportAnimation(
  article: HTMLElement | null,
  doImport: () => Promise<void>,
): Promise<void> {
  // Same selectors the desktop animation uses.
  const tweetImg =
    article?.querySelector<HTMLImageElement>('[data-testid="tweetPhoto"] img') ??
    article?.querySelector<HTMLImageElement>('img[src*="pbs.twimg.com/media"]') ??
    null;

  if (!tweetImg || !tweetImg.complete || tweetImg.naturalWidth === 0) {
    await doImport();
    return;
  }

  const sourceRect = tweetImg.getBoundingClientRect();
  if (sourceRect.width < 4 || sourceRect.height < 4) {
    await doImport();
    return;
  }

  const vw = window.innerWidth;
  const vh = window.innerHeight;
  // Cap dpr at 2 — three or four physical pixels per CSS pixel doesn't help
  // a brief motion-blurred animation and wastes fill rate.
  const dpr = Math.min(2, window.devicePixelRatio || 1);

  const canvas = document.createElement('canvas');
  canvas.width = Math.round(vw * dpr);
  canvas.height = Math.round(vh * dpr);
  Object.assign(canvas.style, {
    position: 'fixed',
    left: '0',
    top: '0',
    width: `${vw}px`,
    height: `${vh}px`,
    pointerEvents: 'none',
    zIndex: '2147483646',
  } satisfies Partial<CSSStyleDeclaration>);
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    await doImport();
    return;
  }
  ctx.scale(dpr, dpr);
  document.body.appendChild(canvas);

  const originalVis = tweetImg.style.visibility;
  tweetImg.style.visibility = 'hidden';

  // Aim at the center of the native Bouncer button (rightmost of four
  // equally-spaced toolbar buttons), and have the funnel taper to roughly
  // the button's visible width (~56pt) rather than a single point. targetY
  // exits the viewport so the funnel's tip drains *off* the bottom — the
  // tweet image flows out of the WebView into where the native FAB sits.
  const BUTTON_WIDTH = 56;
  const targetX = vw * 7 / 8;
  const targetY = vh + 24;

  const genie = new GenieEffect({
    canvas,
    image: tweetImg,
    source: { x: sourceRect.left, y: sourceRect.top, w: sourceRect.width, h: sourceRect.height },
    target: { x: targetX, y: targetY },
    funnel: { endWidth: BUTTON_WIDTH, phaseSplit: 0.25 },
    duration: 450,
  });

  // Kick the storage write off in parallel — by the time the funnel's
  // tip leaves the viewport, the native sheet's phrase list is already
  // updated (confirmAndImportPack calls updateIOSFilteredCount on iOS).
  const importPromise = doImport();

  await new Promise<void>((resolve) => {
    genie.minimize(() => resolve());
  });

  canvas.remove();
  tweetImg.style.visibility = originalVis;
  await importPromise;
}


/**
 * macOS-style Genie effect.
 * Animates a source image into a target point using a two-phase
 * canvas-warp: horizontal squeeze, then vertical slide down a funnel.
 */

export type GenieImage = CanvasImageSource;

export interface SourceRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TargetPoint {
  x: number;
  y: number;
}

export interface FunnelConfig {
  /** Width at the dock end (pixels). Default: 36 */
  endWidth?: number;
  /** Exponent on the width taper. 1 = linear, 2 = macOS look, 3 = sharper pinch. Default: 2 */
  curve?: number;
  /** Fraction of progress spent on squeeze vs slide. Default: 0.45 */
  phaseSplit?: number;
}

export interface GenieEffectOptions {
  canvas: HTMLCanvasElement;
  image: GenieImage;
  source: SourceRect;
  target: TargetPoint;
  /**
   * Natural pixel dimensions of `image`. Auto-detected from HTMLImageElement
   * via naturalWidth/naturalHeight; required for any other CanvasImageSource
   * (offscreen canvas, ImageBitmap, etc.).
   */
  imageSize?: { w: number; h: number };
  funnel?: FunnelConfig;
  /** Full minimize duration in ms. Default: 700 */
  duration?: number;
}

interface ResolvedFunnel {
  endWidth: number;
  curve: number;
  phaseSplit: number;
}

type CompleteCallback = () => void;
type Direction = -1 | 0 | 1;

export class GenieEffect {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly image: GenieImage;
  private readonly src: SourceRect;
  private readonly target: TargetPoint;
  private readonly funnel: ResolvedFunnel;
  // Natural pixel dimensions of `image` — distinct from src.w/src.h, which are
  // CSS-pixel placement coords. On Retina an `<img>` typically has a natural
  // size ~2× its displayed size, and source-rect args to drawImage are
  // interpreted in this natural space.
  private readonly imgW: number;
  private readonly imgH: number;

  duration: number;
  progress = 0;

  private direction: Direction = 0;
  private rafId: number | null = null;
  private lastTime = 0;
  private onComplete: CompleteCallback | null = null;

  constructor(options: GenieEffectOptions) {
    const ctx = options.canvas.getContext('2d');
    if (!ctx) {
      throw new Error('GenieEffect: failed to get 2D rendering context');
    }

    this.canvas = options.canvas;
    this.ctx = ctx;
    this.image = options.image;
    this.src = { ...options.source };
    this.target = { ...options.target };
    this.duration = options.duration ?? 700;

    const explicitSize = options.imageSize;
    if (explicitSize) {
      this.imgW = explicitSize.w;
      this.imgH = explicitSize.h;
    } else if (options.image instanceof HTMLImageElement) {
      this.imgW = options.image.naturalWidth;
      this.imgH = options.image.naturalHeight;
    } else {
      throw new Error('GenieEffect: imageSize is required when image is not an HTMLImageElement');
    }

    const f = options.funnel ?? {};
    this.funnel = {
      endWidth: f.endWidth ?? 36,
      curve: f.curve ?? 2,
      phaseSplit: f.phaseSplit ?? 0.45,
    };
  }

  // --- Easing ---
  // Quadratic rather than cubic: cubic has zero slope at t=0/t=1, which makes
  // the squeeze→slide handoff feel like a noticeable pause. Quadratic still
  // eases nicely but the boundary slope is steeper, so the two phases blend.
  private static easeOut(t: number): number {
    return 1 - (1 - t) * (1 - t);
  }
  private static easeIn(t: number): number {
    return t * t;
  }

  // --- Funnel geometry (ny is normalized y from 0 at top to 1 at bottom) ---
  private funnelWidthAt(ny: number): number {
    const t = Math.pow(ny, this.funnel.curve);
    return this.src.w + (this.funnel.endWidth - this.src.w) * t;
  }
  private funnelCenterAt(ny: number): number {
    const srcCenter = this.src.x + this.src.w / 2;
    const t = Math.pow(ny, this.funnel.curve);
    return srcCenter + (this.target.x - srcCenter) * t;
  }

  // --- Core draw routine ---
  draw(p: number): void {
    const { ctx, canvas, image, src, target } = this;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (p <= 0) {
      ctx.drawImage(image, src.x, src.y, src.w, src.h);
      return;
    }
    if (p >= 1) return;

    const funnelTop = src.y;
    const funnelBottom = target.y;
    const funnelHeight = funnelBottom - funnelTop;
    const split = this.funnel.phaseSplit;

    // Split progress into squeeze (p1) and slide (p2). easeOut on the
    // squeeze and easeIn on the slide keep the start of phase 1 snappy and
    // the tail of phase 2 punchy.
    let p1: number;
    let p2: number;
    if (p < split) {
      p1 = GenieEffect.easeOut(p / split);
      p2 = 0;
    } else {
      p1 = 1;
      p2 = GenieEffect.easeIn((p - split) / (1 - split));
    }

    const slide = p2 * funnelHeight;
    const srcCenter = src.x + src.w / 2;
    // Each output row is one CSS pixel tall; source slices are taken in the
    // image's natural pixel space, so each slice covers (imgH/src.h) source
    // rows.
    const sliceH = this.imgH / src.h;

    for (let row = 0; row < src.h; row++) {
      const screenY = src.y + row + slide;
      if (screenY < funnelTop || screenY > funnelBottom) continue;

      const ny = (screenY - funnelTop) / funnelHeight;
      const fw = this.funnelWidthAt(ny);
      const fc = this.funnelCenterAt(ny);

      // Phase 1 lerps the row from rectangular to funnel-shaped
      const w = src.w * (1 - p1) + fw * p1;
      const cx = srcCenter * (1 - p1) + fc * p1;

      if (w < 0.5) continue;
      ctx.drawImage(image, 0, row * sliceH, this.imgW, sliceH, cx - w / 2, screenY, w, 1);
    }
  }

  // --- Animation control ---
  minimize(onComplete?: CompleteCallback): void {
    this.start(1, onComplete);
  }
  restore(onComplete?: CompleteCallback): void {
    this.start(-1, onComplete);
  }
  toggle(onComplete?: CompleteCallback): void {
    this.start(this.progress >= 1 ? -1 : 1, onComplete);
  }

  private start(direction: Exclude<Direction, 0>, onComplete?: CompleteCallback): void {
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.direction = direction;
    this.onComplete = onComplete ?? null;
    this.lastTime = performance.now();
    this.tick();
  }

  private tick = (): void => {
    const now = performance.now();
    const dt = now - this.lastTime;
    this.lastTime = now;

    this.progress += this.direction * (dt / this.duration);
    this.progress = Math.max(0, Math.min(1, this.progress));

    this.draw(this.progress);

    if (
      (this.direction > 0 && this.progress >= 1) ||
      (this.direction < 0 && this.progress <= 0)
    ) {
      this.rafId = null;
      const cb = this.onComplete;
      this.onComplete = null;
      if (cb) cb();
      return;
    }
    this.rafId = requestAnimationFrame(this.tick);
  };

  destroy(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }
}
