import { describe, it, expect } from 'vitest';
import type { UsageStats, FilterStats } from '../../src/types';
import {
  emptyUsage, recordUsage, computeUsageSummary, estimateTimeSaved, formatDuration,
} from '../../src/shared/usage-utils.js';
import { recordFilterStat } from '../../src/shared/stats-utils.js';

const DAY = 24 * 60 * 60 * 1000;
function noon(y: number, m: number, d: number): number {
  return new Date(y, m - 1, d, 12, 0, 0, 0).getTime();
}
const T0 = noon(2026, 7, 7);

describe('recordUsage', () => {
  it('merges deltas into lifetime + daily and prunes old days', () => {
    const u = emptyUsage();
    recordUsage(u, { totalTimeMs: 1000, byCategory: { Tech: { timeMs: 1000, seen: 1 } } }, T0 - 40 * DAY);
    recordUsage(u, { totalTimeMs: 5000, byCategory: { Tech: { timeMs: 4000, seen: 8 }, News: { timeMs: 1000, seen: 2 } } }, T0);

    expect(u.totalTimeMs).toBe(6000);
    expect(u.byCategory.Tech).toEqual({ timeMs: 5000, seen: 9 });
    expect(Object.keys(u.daily)).toEqual(['2026-07-07']);
    expect(u.daily['2026-07-07'].byCategory.News).toEqual({ timeMs: 1000, seen: 2 });
  });
});

describe('estimateTimeSaved', () => {
  it('is zero with no blocked posts', () => {
    expect(estimateTimeSaved(10000, 5, 0)).toBe(0);
  });
  it('uses measured average dwell per post', () => {
    expect(estimateTimeSaved(10000, 5, 3)).toBe(6000);
  });
  it('falls back to the default before any dwell is measured', () => {
    expect(estimateTimeSaved(0, 0, 2)).toBe(6000);
  });
  it('clamps a runaway average', () => {
    expect(estimateTimeSaved(100000, 1, 1)).toBe(15000);
  });
});

describe('computeUsageSummary', () => {
  it('returns empty windows for undefined inputs', () => {
    const s = computeUsageSummary(undefined, undefined, T0);
    expect(s.today).toEqual({ totalTimeMs: 0, totalSeen: 0, totalBlocked: 0, timeSavedMs: 0, notFiltered: [], filtered: [] });
  });

  it('splits not-filtered (by content type) from filtered (by topic)', () => {
    const usage: UsageStats = emptyUsage();
    recordUsage(usage, { totalTimeMs: 6000, byCategory: { 'Not filtered': { timeMs: 0, seen: 0 }, News: { timeMs: 4000, seen: 8 }, Tech: { timeMs: 2000, seen: 4 } } }, T0);

    const stats: FilterStats = { filtered: 0, evaluated: 0, totalCost: 0 };
    recordFilterStat(stats, 'crypto', T0);
    recordFilterStat(stats, 'crypto', T0);
    recordFilterStat(stats, 'politics', T0);

    const today = computeUsageSummary(usage, stats, T0).today;

    expect(today.notFiltered[0]).toEqual({ category: 'News', timeMs: 4000, seen: 8 });
    expect(today.notFiltered[1]).toEqual({ category: 'Tech', timeMs: 2000, seen: 4 });
    expect(today.totalTimeMs).toBe(6000);
    expect(today.totalSeen).toBe(12);

    expect(today.totalBlocked).toBe(3);
    expect(today.filtered).toEqual([
      { category: 'crypto', blocked: 2 },
      { category: 'politics', blocked: 1 },
    ]);

    // time saved = avg dwell (6000/12 = 500 → clamped up to 1000) × 3 blocked.
    expect(today.timeSavedMs).toBe(3000);
  });

  it('uses lifetime totals for the all-time window', () => {
    const usage: UsageStats = emptyUsage();
    recordUsage(usage, { totalTimeMs: 1000, byCategory: { Tech: { timeMs: 1000, seen: 1 } } }, T0 - 100 * DAY);
    recordUsage(usage, { totalTimeMs: 2000, byCategory: { Tech: { timeMs: 2000, seen: 1 } } }, T0);

    const summary = computeUsageSummary(usage, undefined, T0);
    expect(summary.allTime.totalTimeMs).toBe(3000);
    expect(summary.allTime.notFiltered[0]).toEqual({ category: 'Tech', timeMs: 3000, seen: 2 });
    expect(summary.week.totalTimeMs).toBe(2000);
  });
});

describe('formatDuration', () => {
  it('formats sub-minute, minute, and hour durations', () => {
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(18_000)).toBe('18s');
    expect(formatDuration(192_000)).toBe('3m 12s');
    expect(formatDuration(3_840_000)).toBe('1h 4m');
  });
});
