// Per-post dwell tracker for the usage summary.
//
// Measures how long each tracked post is actually on screen — gated on the tab
// being visible AND focused — and attributes that time (plus a one-per-post
// "seen" count) to the category string the caller supplies. Deltas are flushed
// to the background periodically and on tab-hide/unload.
//
// Self-contained: owns its IntersectionObserver, visibility/focus listeners, and
// flush interval. The content script tracks a post once it's been evaluated and
// classified, and destroys the tracker when the feature is turned off.

import type { UsageDelta, UsageCategoryStat } from '../types';

const FLUSH_INTERVAL_MS = 15000;
// A post counts as "on screen" once at least this fraction is visible.
const VISIBLE_RATIO = 0.5;

interface PostRecord {
  category: string;
  visible: boolean;
  // Timestamp since which on-screen time has accrued, or null when paused
  // (post off-screen, or tab inactive).
  visibleSince: number | null;
}

export interface UsageTracker {
  /** Start (or update the category of) tracking for an evaluated post. */
  track(el: HTMLElement, category: string): void;
  /** Stop tracking a post, banking any outstanding time. */
  untrack(el: HTMLElement): void;
  /** Send accumulated deltas to the background now. */
  flush(): void;
  /** Tear down observers, listeners, and timers (flushes first). */
  destroy(): void;
}

export function createUsageTracker(send: (delta: UsageDelta) => void): UsageTracker {
  const records = new Map<HTMLElement, PostRecord>();
  const counted = new WeakSet<HTMLElement>();

  // Pending deltas since the last flush.
  let pendingTotalMs = 0;
  const pendingByCat = new Map<string, UsageCategoryStat>();

  // Total active-feed-time accrual (independent of any post being on screen).
  let activeSince: number | null = null;

  const now = (): number => Date.now();
  const isActive = (): boolean => document.visibilityState === 'visible' && document.hasFocus();

  function catBucket(cat: string): UsageCategoryStat {
    let c = pendingByCat.get(cat);
    if (!c) { c = { timeMs: 0, seen: 0 }; pendingByCat.set(cat, c); }
    return c;
  }

  // Bank a record's outstanding on-screen time into its category, pausing it.
  function bank(rec: PostRecord, t: number): void {
    if (rec.visibleSince == null) return;
    const dt = t - rec.visibleSince;
    if (dt > 0) catBucket(rec.category).timeMs += dt;
    rec.visibleSince = null;
  }

  function countSeen(el: HTMLElement, rec: PostRecord): void {
    if (counted.has(el)) return;
    counted.add(el);
    catBucket(rec.category).seen += 1;
  }

  const io = new IntersectionObserver((entries) => {
    const t = now();
    const active = isActive();
    for (const entry of entries) {
      const el = entry.target as HTMLElement;
      const rec = records.get(el);
      if (!rec) continue;
      const visible = entry.isIntersecting && entry.intersectionRatio >= VISIBLE_RATIO;
      rec.visible = visible;
      if (visible) {
        if (active) {
          countSeen(el, rec);
          if (rec.visibleSince == null) rec.visibleSince = t;
        }
      } else {
        bank(rec, t);
      }
    }
  }, { threshold: [0, VISIBLE_RATIO, 1] });

  // Resume/pause accrual on tab visibility + window focus changes.
  function setActive(active: boolean): void {
    const t = now();
    if (active) {
      if (activeSince == null) activeSince = t;
      for (const [el, rec] of records) {
        if (rec.visible) {
          countSeen(el, rec);
          if (rec.visibleSince == null) rec.visibleSince = t;
        }
      }
    } else {
      if (activeSince != null) { pendingTotalMs += t - activeSince; activeSince = null; }
      for (const rec of records.values()) bank(rec, t);
    }
  }

  const onVisibility = (): void => setActive(isActive());
  const onFocus = (): void => setActive(true);
  const onBlur = (): void => setActive(false);
  const onPageHide = (): void => flush();

  function flush(): void {
    const t = now();
    // Bank in-progress time, then resume so ongoing dwell keeps accruing.
    if (activeSince != null) { pendingTotalMs += t - activeSince; activeSince = t; }
    for (const [el, rec] of records) {
      if (!el.isConnected) {
        bank(rec, t);
        io.unobserve(el);
        records.delete(el);
        continue;
      }
      if (rec.visibleSince != null) {
        const dt = t - rec.visibleSince;
        if (dt > 0) catBucket(rec.category).timeMs += dt;
        rec.visibleSince = t;
      }
    }

    if (pendingTotalMs <= 0 && pendingByCat.size === 0) return;

    const byCategory: Record<string, UsageCategoryStat> = {};
    for (const [cat, v] of pendingByCat) {
      if (v.timeMs > 0 || v.seen > 0) byCategory[cat] = { timeMs: v.timeMs, seen: v.seen };
    }
    const delta: UsageDelta = { totalTimeMs: pendingTotalMs, byCategory };
    pendingTotalMs = 0;
    pendingByCat.clear();

    if (delta.totalTimeMs > 0 || Object.keys(delta.byCategory).length > 0) send(delta);
  }

  function track(el: HTMLElement, category: string): void {
    const cat = category || 'Other';
    const existing = records.get(el);
    if (existing) {
      if (existing.category !== cat) {
        bank(existing, now());
        existing.category = cat;
        // A category change usually means the platform's virtualized timeline
        // reused this element for a different post — let it count as seen again.
        counted.delete(el);
        if (isActive() && existing.visible) {
          countSeen(el, existing);
          existing.visibleSince = now();
        }
      }
      return;
    }
    records.set(el, { category: cat, visible: false, visibleSince: null });
    io.observe(el);
  }

  function untrack(el: HTMLElement): void {
    const rec = records.get(el);
    if (!rec) return;
    bank(rec, now());
    counted.delete(el);
    io.unobserve(el);
    records.delete(el);
  }

  function destroy(): void {
    flush();
    io.disconnect();
    records.clear();
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('focus', onFocus);
    window.removeEventListener('blur', onBlur);
    window.removeEventListener('pagehide', onPageHide);
    clearInterval(interval);
  }

  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('focus', onFocus);
  window.addEventListener('blur', onBlur);
  window.addEventListener('pagehide', onPageHide);
  const interval = setInterval(flush, FLUSH_INTERVAL_MS);

  // Prime the active clock if the tab is already foregrounded.
  if (isActive()) activeSince = now();

  return { track, untrack, flush, destroy };
}
