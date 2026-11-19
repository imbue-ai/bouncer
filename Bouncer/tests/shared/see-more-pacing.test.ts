import { describe, expect, it } from 'vitest';
import {
  GLOBAL_PRIOR, MIN_GAP, PACING_FLOOR_SHARE, TOPIC_PRIOR, decayBoost, dwellRate, emptyPacing, engagementFromDwell,
  meanOf, median, nextGap, parsePacing, rankTopics, recordOutcome, sampleBeta, targetShare, updateBeta,
} from '../../src/shared/see-more-pacing';

// Deterministic generator, so the sampling tests don't flake.
function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('engagementFromDwell', () => {
  it('maps half, equal and double the tweet pace to 0, 0.5 and 1', () => {
    expect(engagementFromDwell(1, 2)).toBeCloseTo(0);
    expect(engagementFromDwell(2, 2)).toBeCloseTo(0.5);
    expect(engagementFromDwell(4, 2)).toBeCloseTo(1);
    expect(engagementFromDwell(100, 2)).toBe(1);
    expect(engagementFromDwell(0.01, 2)).toBe(0);
  });

  it('is 0 without a usable baseline', () => {
    expect(engagementFromDwell(1, 0)).toBe(0);
    expect(engagementFromDwell(1, NaN)).toBe(0);
  });
});

describe('dwellRate', () => {
  it("doesn't reward a post for being tall", () => {
    // Same scroll speed (1 px/ms) past a short and a tall post.
    const viewport = 800;
    expect(dwellRate(200 + viewport, 200, viewport)).toBeCloseTo(dwellRate(1200 + viewport, 1200, viewport));
  });
});

describe('median', () => {
  it('handles odd, even and empty lists', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBeNaN();
  });
});

describe('targetShare', () => {
  it('runs from the floor to the ceiling with engagement', () => {
    expect(targetShare(0, 4, 0)).toBeCloseTo(PACING_FLOOR_SHARE);
    expect(targetShare(1, 4, 0)).toBeCloseTo(1 / 4);
    expect(targetShare(0.5, 4, 0)).toBeCloseTo((PACING_FLOOR_SHARE + 1 / 4) / 2);
  });

  it('a full boost goes straight to the ceiling', () => {
    expect(targetShare(0, 4, 1)).toBeCloseTo(1 / 4);
  });

  it('never goes over a ceiling lower than the floor', () => {
    expect(targetShare(1, 20, 0)).toBeCloseTo(1 / 20);
    expect(targetShare(0, 20, 0)).toBeCloseTo(1 / 20);
  });
});

describe('nextGap', () => {
  it('jitters around the target and never beats the ceiling', () => {
    const rng = seeded(1);
    const gaps = Array.from({ length: 2000 }, () => nextGap(1 / 8, 4, rng));
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(3);
    expect(new Set(gaps).size).toBeGreaterThan(3);
    const mean = gaps.reduce((x, y) => x + y, 0) / gaps.length;
    expect(mean).toBeGreaterThan(6);
    expect(mean).toBeLessThan(8);
  });

  it('at the ceiling, is the ceiling', () => {
    expect(nextGap(1 / 4, 4, () => 0)).toBe(3);
    expect(nextGap(1, 1, () => 0)).toBe(MIN_GAP);
  });
});

describe('scores', () => {
  it('fades old outcomes toward the prior', () => {
    let s = { ...GLOBAL_PRIOR };
    for (let i = 0; i < 500; i++) s = updateBeta(s, GLOBAL_PRIOR, 1);
    expect(meanOf(s)).toBeGreaterThan(0.9);
    // Bounded: ~1 / (1 - DECAY) outcomes' worth.
    expect(s.a + s.b).toBeLessThan(60);
    for (let i = 0; i < 100; i++) s = updateBeta(s, GLOBAL_PRIOR, 0);
    expect(meanOf(s)).toBeLessThan(0.3);
  });

  it('records into the timeline and the topic', () => {
    const next = recordOutcome(emptyPacing(), 'birds', 1);
    expect(meanOf(next.global)).toBeGreaterThan(meanOf(GLOBAL_PRIOR));
    expect(meanOf(next.topics.birds)).toBeGreaterThan(meanOf(TOPIC_PRIOR));
  });

  it('ranks a loved topic first far more often than a skipped one', () => {
    let state = emptyPacing();
    for (let i = 0; i < 20; i++) {
      state = recordOutcome(state, 'loved', 0.9);
      state = recordOutcome(state, 'skipped', 0.1);
    }
    const rng = seeded(7);
    let lovedFirst = 0;
    for (let i = 0; i < 1000; i++) if (rankTopics(['skipped', 'loved'], state, rng)[0] === 'loved') lovedFirst++;
    expect(lovedFirst).toBeGreaterThan(950);
  });

  it('samples Betas with the right mean', () => {
    const rng = seeded(3);
    const n = 4000;
    let sum = 0;
    for (let i = 0; i < n; i++) sum += sampleBeta({ a: 3, b: 7 }, rng);
    expect(sum / n).toBeCloseTo(0.3, 1);
    const x = sampleBeta({ a: 0.5, b: 0.5 }, rng);
    expect(x).toBeGreaterThanOrEqual(0);
    expect(x).toBeLessThanOrEqual(1);
  });
});

describe('decayBoost', () => {
  it('halves every half-life', () => {
    expect(decayBoost(1, 15)).toBeCloseTo(0.5);
    expect(decayBoost(1, 30)).toBeCloseTo(0.25);
  });
});

describe('parsePacing', () => {
  it('falls back to fresh scores on junk', () => {
    expect(parsePacing(undefined)).toEqual(emptyPacing());
    expect(parsePacing('x')).toEqual(emptyPacing());
    expect(parsePacing({ global: { a: 'no' }, topics: { t: null } })).toEqual(emptyPacing());
  });

  it('keeps valid scores, never below the prior', () => {
    const parsed = parsePacing({ global: { a: 10, b: 0 }, topics: { birds: { a: 5, b: 3 } } });
    expect(parsed.global).toEqual({ a: 10, b: GLOBAL_PRIOR.b });
    expect(parsed.topics.birds).toEqual({ a: 5, b: 3 });
  });
});
