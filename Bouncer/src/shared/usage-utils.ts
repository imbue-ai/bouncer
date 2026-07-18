// Pure helpers for feed-usage stats (time on feed + per-content-category dwell
// of NOT-filtered posts) and the combined summary the popup renders.
//
// The two pies come from two sources:
//   - "not filtered" breakdown: content-category dwell/seen, from `usage`.
//   - "filtered" breakdown: blocked-post counts by topic, reused from
//     stats-utils (computeStatsBreakdown) so there's a single source of truth.
//
// Free of chrome.* / DOM so it's unit-testable.

import type {
  UsageStats, UsageDelta, UsageCategoryStat, UsageSummary, UsageWindow, FilterStats,
} from '../types';
import { dateKey, DAILY_RETENTION_DAYS, WEEK_WINDOW_DAYS, computeStatsBreakdown } from './stats-utils';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

// Fallback average per-post dwell used for the time-saved estimate before we
// have any measured dwell, and the clamp range applied to the measured average
// so a few outlier posts can't blow the estimate up or down.
const DEFAULT_MS_PER_POST = 3000;
const MIN_AVG_MS_PER_POST = 1000;
const MAX_AVG_MS_PER_POST = 15000;

/** A fresh, empty usage object. */
export function emptyUsage(): UsageStats {
  return { totalTimeMs: 0, byCategory: {}, daily: {} };
}

function addInto(map: Record<string, UsageCategoryStat>, cat: string, timeMs: number, seen: number): void {
  const cur = map[cat] ?? (map[cat] = { timeMs: 0, seen: 0 });
  cur.timeMs += timeMs;
  cur.seen += seen;
}

/**
 * Merge one content-script flush into the persisted usage object. Mutates and
 * returns `usage`. Updates lifetime totals and today's bucket, then prunes daily
 * buckets older than the retention window.
 */
export function recordUsage(usage: UsageStats, delta: UsageDelta, now: number): UsageStats {
  usage.totalTimeMs += delta.totalTimeMs;
  const today = dateKey(now);
  const day = usage.daily[today] ?? (usage.daily[today] = { totalTimeMs: 0, byCategory: {} });
  day.totalTimeMs += delta.totalTimeMs;

  for (const [cat, v] of Object.entries(delta.byCategory)) {
    addInto(usage.byCategory, cat, v.timeMs, v.seen);
    addInto(day.byCategory, cat, v.timeMs, v.seen);
  }

  const cutoff = dateKey(now - DAILY_RETENTION_DAYS * ONE_DAY_MS);
  for (const key of Object.keys(usage.daily)) {
    if (key < cutoff) delete usage.daily[key];
  }
  return usage;
}

/** Sum the most recent `days` daily usage buckets (inclusive of today). */
function sumUsageWindow(usage: UsageStats, now: number, days: number): { totalTimeMs: number; byCategory: Record<string, UsageCategoryStat> } {
  const byCategory: Record<string, UsageCategoryStat> = {};
  let totalTimeMs = 0;
  for (let i = 0; i < days; i++) {
    const bucket = usage.daily[dateKey(now - i * ONE_DAY_MS)];
    if (!bucket) continue;
    totalTimeMs += bucket.totalTimeMs;
    for (const [cat, v] of Object.entries(bucket.byCategory)) {
      addInto(byCategory, cat, v.timeMs, v.seen);
    }
  }
  return { totalTimeMs, byCategory };
}

/**
 * Estimate time saved by hiding blocked posts: how long the user would have
 * spent had those posts stayed in the feed. Uses their own average dwell per
 * scrolled post (clamped), falling back to a constant before any data exists.
 */
export function estimateTimeSaved(totalTimeMs: number, totalSeen: number, totalBlocked: number): number {
  if (totalBlocked <= 0) return 0;
  const rawAvg = totalSeen > 0 ? totalTimeMs / totalSeen : DEFAULT_MS_PER_POST;
  const avg = Math.min(MAX_AVG_MS_PER_POST, Math.max(MIN_AVG_MS_PER_POST, rawAvg));
  return Math.round(avg * totalBlocked);
}

function buildWindow(
  usageWindow: { totalTimeMs: number; byCategory: Record<string, UsageCategoryStat> },
  blockedRows: { category: string; count: number }[],
  totalBlocked: number,
): UsageWindow {
  const notFiltered = Object.entries(usageWindow.byCategory)
    .map(([category, v]) => ({ category, timeMs: v.timeMs, seen: v.seen }))
    .sort((a, b) => b.timeMs - a.timeMs || b.seen - a.seen || a.category.localeCompare(b.category));

  const filtered = blockedRows.map((r) => ({ category: r.category, blocked: r.count }));

  const totalSeen = notFiltered.reduce((acc, r) => acc + r.seen, 0);

  return {
    totalTimeMs: usageWindow.totalTimeMs,
    totalSeen,
    totalBlocked,
    timeSavedMs: estimateTimeSaved(usageWindow.totalTimeMs, totalSeen, totalBlocked),
    notFiltered,
    filtered,
  };
}

/**
 * Build the today / last-7-days / all-time summary the popup renders: a
 * content-category breakdown of not-filtered posts (with dwell time) plus a
 * topic breakdown of blocked posts.
 */
export function computeUsageSummary(
  usage: UsageStats | undefined,
  stats: FilterStats | undefined,
  now: number,
): UsageSummary {
  const u = usage ?? emptyUsage();
  const blocked = computeStatsBreakdown(stats, now);

  return {
    today: buildWindow(sumUsageWindow(u, now, 1), blocked.today.byCategory, blocked.today.total),
    week: buildWindow(sumUsageWindow(u, now, WEEK_WINDOW_DAYS), blocked.week.byCategory, blocked.week.total),
    allTime: buildWindow({ totalTimeMs: u.totalTimeMs, byCategory: u.byCategory }, blocked.allTime.byCategory, blocked.allTime.total),
  };
}

/** Format a millisecond duration compactly (e.g. `1h 4m`, `3m 12s`, `18s`). */
export function formatDuration(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  if (totalSec <= 0) return '0s';
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  if (m > 0) return s > 0 ? `${m}m ${s}s` : `${m}m`;
  return `${s}s`;
}
