// Pure helpers for blocked-post filter stats (per-category, per-day), reused by
// the usage summary. Free of chrome.* / DOM so the aggregation is unit-testable.

import type { FilterStats, StatsBreakdown, StatsWindow, StatsCategoryCount } from '../types';

// Daily buckets are pruned to this many days so `stats.daily` stays bounded.
export const DAILY_RETENTION_DAYS = 30;

// Days covered by the "week" window, inclusive of today.
export const WEEK_WINDOW_DAYS = 7;

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

const UNCATEGORIZED = 'Uncategorized';

/** Local-time `YYYY-MM-DD` key for a timestamp. Lexicographic order matches
 *  chronological order, which the pruning + window scans rely on. */
export function dateKey(ts: number): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Split a stored `category` string into individual buckets. A single hide can
 * match several filter phrases joined with ", " (e.g. "crypto, engagement
 * bait"); attributing to each gives a truthful per-topic breakdown. AI-detector
 * labels ("AI-generated") pass through unchanged; empty/null → "Uncategorized".
 */
export function splitCategories(category: string | null | undefined): string[] {
  if (!category) return [UNCATEGORIZED];
  const parts = category.split(',').map((c) => c.trim()).filter((c) => c.length > 0);
  return parts.length > 0 ? parts : [UNCATEGORIZED];
}

function ensureMaps(stats: FilterStats): Required<Pick<FilterStats, 'byCategory' | 'daily'>> & FilterStats {
  if (!stats.byCategory) stats.byCategory = {};
  if (!stats.daily) stats.daily = {};
  return stats as Required<Pick<FilterStats, 'byCategory' | 'daily'>> & FilterStats;
}

function pruneDaily(daily: Record<string, Record<string, number>>, now: number): void {
  const cutoff = dateKey(now - DAILY_RETENTION_DAYS * ONE_DAY_MS);
  for (const key of Object.keys(daily)) {
    if (key < cutoff) delete daily[key];
  }
}

/**
 * Record one hidden post against the per-category and per-day breakdowns.
 * Does NOT touch `filtered` / `evaluated` (the pipeline owns those). Mutates and
 * returns `stats`.
 */
export function recordFilterStat(stats: FilterStats, category: string | null | undefined, now: number): FilterStats {
  const s = ensureMaps(stats);
  const today = dateKey(now);
  const todayBucket = s.daily[today] ?? (s.daily[today] = {});

  for (const cat of splitCategories(category)) {
    s.byCategory[cat] = (s.byCategory[cat] ?? 0) + 1;
    todayBucket[cat] = (todayBucket[cat] ?? 0) + 1;
  }

  pruneDaily(s.daily, now);
  return s;
}

function toSortedRows(counts: Record<string, number>): StatsCategoryCount[] {
  return Object.entries(counts)
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category));
}

function sumWindow(daily: Record<string, Record<string, number>>, now: number, days: number): StatsWindow {
  const counts: Record<string, number> = {};
  for (let i = 0; i < days; i++) {
    const bucket = daily[dateKey(now - i * ONE_DAY_MS)];
    if (!bucket) continue;
    for (const [cat, n] of Object.entries(bucket)) {
      counts[cat] = (counts[cat] ?? 0) + n;
    }
  }
  const rows = toSortedRows(counts);
  return { total: rows.reduce((acc, r) => acc + r.count, 0), byCategory: rows };
}

/** Derive the today / last-7-days / all-time blocked breakdown. */
export function computeStatsBreakdown(stats: FilterStats | undefined, now: number): StatsBreakdown {
  const daily = stats?.daily ?? {};
  const allTimeRows = toSortedRows(stats?.byCategory ?? {});
  return {
    evaluated: stats?.evaluated ?? 0,
    today: sumWindow(daily, now, 1),
    week: sumWindow(daily, now, WEEK_WINDOW_DAYS),
    allTime: {
      total: stats?.filtered ?? allTimeRows.reduce((acc, r) => acc + r.count, 0),
      byCategory: allTimeRows,
    },
  };
}
