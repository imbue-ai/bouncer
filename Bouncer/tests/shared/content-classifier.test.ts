import { describe, it, expect } from 'vitest';
import { classifyContent, OTHER_CATEGORY } from '../../src/shared/content-classifier.js';

describe('classifyContent', () => {
  it('buckets by fixed content-type keywords', () => {
    expect(classifyContent('The senate will vote on the new policy tomorrow')).toBe('Politics');
    expect(classifyContent('Bitcoin and ethereum are up today')).toBe('Crypto');
    expect(classifyContent('Huge playoff game, what a touchdown')).toBe('Sports');
    expect(classifyContent('New study on vaccine research published')).toBe('Science & Health');
  });

  it('matches whole-word tokens, not substrings', () => {
    // "ai" (Tech) must not fire inside "said" / "maintain".
    expect(classifyContent('She said she would maintain the garden')).toBe(OTHER_CATEGORY);
    expect(classifyContent('New ai model released')).toBe('Tech');
  });

  it('matches multi-word keywords as substrings', () => {
    expect(classifyContent('Check the link in bio for details')).toBe('Promotional');
  });

  it('prefers the user\'s own filter topics over the fixed taxonomy', () => {
    // "crypto" is both a user topic and a fixed bucket — user topic wins the label.
    expect(classifyContent('a post about crypto markets', ['crypto degens'])).toBe('crypto degens');
  });

  it('falls back to Other for empty or unmatched text', () => {
    expect(classifyContent('')).toBe(OTHER_CATEGORY);
    expect(classifyContent(null)).toBe(OTHER_CATEGORY);
    expect(classifyContent('just some ordinary words here')).toBe(OTHER_CATEGORY);
  });

  it('ignores stop-word-only filter phrases', () => {
    expect(classifyContent('an ordinary sentence', ['the and for'])).toBe(OTHER_CATEGORY);
  });
});
