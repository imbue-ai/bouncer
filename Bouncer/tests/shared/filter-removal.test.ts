import { describe, it, expect } from 'vitest';
import { decideFilterRemoval } from '../../src/shared/filter-removal.js';

const removedSet = (...phrases: string[]): Set<string> =>
  new Set(phrases.map(p => p.toLowerCase()));

describe('decideFilterRemoval', () => {
  describe('complete classifier (matches !== null)', () => {
    it('restores when the only match is removed', () => {
      const d = decideFilterRemoval(['crypto'], 'crypto', removedSet('crypto'));
      expect(d.kind).toBe('restore');
    });

    it('restores when every match is removed', () => {
      const d = decideFilterRemoval(
        ['crypto', 'engagement bait'],
        'crypto, engagement bait',
        removedSet('crypto', 'engagement bait'),
      );
      expect(d.kind).toBe('restore');
    });

    it('refreshes with remaining matches when a subset is removed', () => {
      const d = decideFilterRemoval(
        ['crypto', 'engagement bait'],
        'crypto, engagement bait',
        removedSet('crypto'),
      );
      expect(d).toEqual({ kind: 'refresh', remaining: ['engagement bait'] });
    });

    it('preserves AI-generated when a phrase is removed', () => {
      const d = decideFilterRemoval(
        ['crypto', 'AI-generated'],
        'crypto, AI-generated',
        removedSet('crypto'),
      );
      expect(d).toEqual({ kind: 'refresh', remaining: ['AI-generated'] });
    });

    it('restores AI-generated-only post when AI-generated is removed', () => {
      const d = decideFilterRemoval(['AI-generated'], 'AI-generated', removedSet('AI-generated'));
      expect(d.kind).toBe('restore');
    });

    it('is case-insensitive on the removed phrase', () => {
      const d = decideFilterRemoval(['Crypto'], 'Crypto', removedSet('CRYPTO'));
      expect(d.kind).toBe('restore');
    });

    it('returns unaffected when none of the matches are removed', () => {
      const d = decideFilterRemoval(['crypto'], 'crypto', removedSet('spam'));
      expect(d.kind).toBe('unaffected');
    });

    it('returns unaffected on empty matches array', () => {
      // Defensive — shouldn't happen in practice (a filtered post should have
      // at least one match) but the pure function should still be sane.
      const d = decideFilterRemoval([], null, removedSet('crypto'));
      expect(d.kind).toBe('unaffected');
    });
  });

  describe('incomplete classifier (matches === null, API path)', () => {
    it('asks for re-evaluation when the stored category is removed', () => {
      const d = decideFilterRemoval(null, 'crypto', removedSet('crypto'));
      expect(d.kind).toBe('reevaluate');
    });

    it('is case-insensitive on the stored category', () => {
      const d = decideFilterRemoval(null, 'Crypto', removedSet('crypto'));
      expect(d.kind).toBe('reevaluate');
    });

    it('returns unaffected when the stored category is not removed', () => {
      const d = decideFilterRemoval(null, 'spam', removedSet('crypto'));
      expect(d.kind).toBe('unaffected');
    });

    it('returns unaffected when category is null', () => {
      const d = decideFilterRemoval(null, null, removedSet('crypto'));
      expect(d.kind).toBe('unaffected');
    });
  });
});
