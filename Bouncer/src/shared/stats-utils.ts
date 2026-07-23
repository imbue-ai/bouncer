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

function ensureMaps(stats: FilterStats): Required<Pick<FilterStats, 'byCategory' | 'daily' | 'dailyTotal'>> & FilterStats {
  if (!stats.byCategory) stats.byCategory = {};
  if (!stats.daily) stats.daily = {};
  if (!stats.dailyTotal) {
    // One-time migration for stats stored before dailyTotal existed: seed each
    // day from its category-instance sum (the best available estimate; slightly
    // high when a post matched several filters). Without this, a day mixing
    // pre-migration and post-migration hides would report only the latter —
    // dropping the morning's hides from "today" after an extension update.
    stats.dailyTotal = {};
    for (const [day, bucket] of Object.entries(stats.daily)) {
      stats.dailyTotal[day] = Object.values(bucket).reduce((a, n) => a + n, 0);
    }
  }
  return stats as Required<Pick<FilterStats, 'byCategory' | 'daily' | 'dailyTotal'>> & FilterStats;
}

/** Drop date-keyed entries older than the retention window (keys are
 *  lexicographically ordered dates, so a string compare suffices). */
function pruneByDate(map: Record<string, unknown>, now: number): void {
  const cutoff = dateKey(now - DAILY_RETENTION_DAYS * ONE_DAY_MS);
  for (const key of Object.keys(map)) {
    if (key < cutoff) delete map[key];
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

  // One post = one hide, regardless of how many filter phrases it matched.
  s.dailyTotal[today] = (s.dailyTotal[today] ?? 0) + 1;

  for (const cat of splitCategories(category)) {
    s.byCategory[cat] = (s.byCategory[cat] ?? 0) + 1;
    todayBucket[cat] = (todayBucket[cat] ?? 0) + 1;
  }

  pruneByDate(s.daily, now);
  pruneByDate(s.dailyTotal, now);
  return s;
}

function toSortedRows(counts: Record<string, number>): StatsCategoryCount[] {
  return Object.entries(counts)
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category));
}

function sumWindow(
  daily: Record<string, Record<string, number>>,
  dailyTotal: Record<string, number>,
  now: number,
  days: number,
): StatsWindow {
  const counts: Record<string, number> = {};
  let total = 0;
  for (let i = 0; i < days; i++) {
    const key = dateKey(now - i * ONE_DAY_MS);
    const bucket = daily[key];
    let catSum = 0;
    let maxCat = 0;
    if (bucket) {
      for (const [cat, n] of Object.entries(bucket)) {
        counts[cat] = (counts[cat] ?? 0) + n;
        catSum += n;
        if (n > maxCat) maxCat = n;
      }
    }
    // Posts hidden this day. dailyTotal is the exact per-post count for data
    // recorded with it; clamp up to the largest single-category count — a valid
    // lower bound, since a post matches any one filter at most once — to heal
    // undercounted values a partial/older build may have written. A day with no
    // dailyTotal entry at all falls back to the category-instance sum (slightly
    // high when posts matched several filters); it ages out with retention.
    const dt = dailyTotal[key];
    total += dt != null ? Math.max(dt, maxCat) : catSum;
  }
  return { total, byCategory: toSortedRows(counts) };
}

/** Derive the today / last-7-days / all-time blocked breakdown. All windows
 *  count hidden POSTS (not per-category matches), so `allTime.total` is always
 *  >= the shorter windows. */
export function computeStatsBreakdown(stats: FilterStats | undefined, now: number): StatsBreakdown {
  const daily = stats?.daily ?? {};
  const dailyTotal = stats?.dailyTotal ?? {};
  const allTimeRows = toSortedRows(stats?.byCategory ?? {});
  const today = sumWindow(daily, dailyTotal, now, 1);
  const week = sumWindow(daily, dailyTotal, now, WEEK_WINDOW_DAYS);
  // Lifetime post count. Guard against legacy data where the daily buckets
  // (pre-dailyTotal, category-instance based) sum higher than `filtered`: a
  // window can never contain more posts than all time.
  const allTimeTotal = Math.max(
    stats?.filtered ?? allTimeRows.reduce((acc, r) => acc + r.count, 0),
    week.total,
  );
  return {
    evaluated: stats?.evaluated ?? 0,
    today,
    week,
    allTime: {
      total: allTimeTotal,
      byCategory: allTimeRows,
    },
  };
}
