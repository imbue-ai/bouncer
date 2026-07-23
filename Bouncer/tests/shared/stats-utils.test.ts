import { describe, it, expect } from 'vitest';
import type { FilterStats } from '../../src/types';
import {
  dateKey, splitCategories, recordFilterStat, computeStatsBreakdown, DAILY_RETENTION_DAYS,
} from '../../src/shared/stats-utils.js';

const DAY = 24 * 60 * 60 * 1000;
function noon(y: number, m: number, d: number): number {
  return new Date(y, m - 1, d, 12, 0, 0, 0).getTime();
}
const T0 = noon(2026, 7, 7);
const fresh = (): FilterStats => ({ filtered: 0, evaluated: 0, totalCost: 0 });

describe('dateKey', () => {
  it('formats a zero-padded local date', () => {
    expect(dateKey(noon(2026, 1, 5))).toBe('2026-01-05');
    expect(dateKey(noon(2026, 12, 31))).toBe('2026-12-31');
  });
});

describe('splitCategories', () => {
  it('splits comma-joined matches, trims, and handles empties', () => {
    expect(splitCategories('crypto, engagement bait')).toEqual(['crypto', 'engagement bait']);
    expect(splitCategories('AI-generated')).toEqual(['AI-generated']);
    expect(splitCategories(null)).toEqual(['Uncategorized']);
  });
});

describe('recordFilterStat', () => {
  it('increments lifetime + daily buckets per category', () => {
    const s = fresh();
    recordFilterStat(s, 'crypto, politics', T0);
    recordFilterStat(s, 'crypto', T0);
    expect(s.byCategory).toEqual({ crypto: 2, politics: 1 });
    expect(s.daily?.['2026-07-07']).toEqual({ crypto: 2, politics: 1 });
  });

  it('prunes old daily buckets but keeps lifetime totals', () => {
    const s = fresh();
    recordFilterStat(s, 'crypto', T0 - (DAILY_RETENTION_DAYS + 5) * DAY);
    recordFilterStat(s, 'crypto', T0);
    expect(Object.keys(s.daily ?? {})).toEqual(['2026-07-07']);
    expect(s.byCategory).toEqual({ crypto: 2 });
  });
});

describe('computeStatsBreakdown', () => {
  it('aggregates windows and sorts count-desc', () => {
    const s = fresh();
    s.filtered = 4;
    recordFilterStat(s, 'crypto', T0);
    recordFilterStat(s, 'crypto', T0);
    recordFilterStat(s, 'politics', T0 - 3 * DAY);
    recordFilterStat(s, 'crypto', T0 - 10 * DAY);

    const b = computeStatsBreakdown(s, T0);
    expect(b.today).toEqual({ total: 2, byCategory: [{ category: 'crypto', count: 2 }] });
    expect(b.week.total).toBe(3);
    expect(b.allTime.total).toBe(4);
    expect(b.allTime.byCategory).toEqual([
      { category: 'crypto', count: 3 },
      { category: 'politics', count: 1 },
    ]);
  });

  it('returns zeros for undefined stats', () => {
    const b = computeStatsBreakdown(undefined, T0);
    expect(b.today).toEqual({ total: 0, byCategory: [] });
    expect(b.allTime).toEqual({ total: 0, byCategory: [] });
  });

  it('counts posts (not category matches) in window totals', () => {
    // One post matching two filters must count once toward totals — otherwise
    // today/week outgrow all-time (which counts posts via `filtered`).
    const s = fresh();
    s.filtered = 2;
    recordFilterStat(s, 'crypto, engagement bait', T0);
    recordFilterStat(s, 'crypto', T0 - 2 * DAY);

    const b = computeStatsBreakdown(s, T0);
    expect(b.today.total).toBe(1);
    expect(b.week.total).toBe(2);
    expect(b.allTime.total).toBe(2);
    // The pie still shows every matched category.
    expect(b.today.byCategory).toEqual([
      { category: 'crypto', count: 1 },
      { category: 'engagement bait', count: 1 },
    ]);
  });

  it('never reports a window total above all-time (legacy data guard)', () => {
    // Data recorded before dailyTotal existed: daily buckets are category-
    // instance counts, which can sum higher than the per-post `filtered`.
    const s = fresh();
    s.filtered = 1;
    s.daily = { [dateKey(T0)]: { crypto: 1, politics: 1 } };
    s.byCategory = { crypto: 1, politics: 1 };

    const b = computeStatsBreakdown(s, T0);
    expect(b.today.total).toBe(2); // fallback: category sum for legacy days
    expect(b.allTime.total).toBeGreaterThanOrEqual(b.week.total);
    expect(b.allTime.total).toBeGreaterThanOrEqual(b.today.total);
  });

  it('seeds dailyTotal from legacy daily buckets on first record after migration', () => {
    // Stats stored by a pre-dailyTotal build: hides exist in `daily` only.
    // The first hide on the new build must not orphan them — "today" would
    // otherwise report only post-update hides.
    const s = fresh();
    s.filtered = 3;
    s.byCategory = { crypto: 2, politics: 1 };
    s.daily = { [dateKey(T0)]: { crypto: 2, politics: 1 } };

    recordFilterStat(s, 'news', T0); // first post-migration hide, same day
    s.filtered = 4;

    const b = computeStatsBreakdown(s, T0);
    expect(b.today.total).toBe(4); // 3 seeded + 1 new, not just 1
    expect(b.allTime.total).toBe(4);
  });

  it('heals an undercounted dailyTotal up to the max category count', () => {
    // Reproduces the dev-testing corruption: an older build wrote
    // dailyTotal[today]=1 while daily[today] correctly holds 5 category
    // instances across 4 posts. The largest single category (crypto=4) is a
    // valid lower bound on posts, so today must read at least 4, not 1.
    const s = fresh();
    s.filtered = 4;
    s.daily = { [dateKey(T0)]: { crypto: 4, politics: 1 } };
    s.byCategory = { crypto: 4, politics: 1 };
    s.dailyTotal = { [dateKey(T0)]: 1 }; // corrupt undercount

    const b = computeStatsBreakdown(s, T0);
    expect(b.today.total).toBe(4); // healed from 1 up to max(crypto)=4
    expect(b.allTime.total).toBe(4);
  });

  it('does not inflate a correct dailyTotal (clamp is a no-op)', () => {
    // A post matching two filters: dailyTotal=1 is correct, max category=1.
    const s = fresh();
    s.filtered = 1;
    recordFilterStat(s, 'crypto, politics', T0);
    const b = computeStatsBreakdown(s, T0);
    expect(b.today.total).toBe(1); // not bumped to catSum (2)
  });

  it('prunes dailyTotal alongside daily', () => {
    const s = fresh();
    recordFilterStat(s, 'crypto', T0 - (DAILY_RETENTION_DAYS + 5) * DAY);
    recordFilterStat(s, 'crypto', T0);
    expect(Object.keys(s.dailyTotal ?? {})).toEqual([dateKey(T0)]);
  });
});
