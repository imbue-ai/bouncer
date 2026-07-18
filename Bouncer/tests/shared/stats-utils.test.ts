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
});
