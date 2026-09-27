// @vitest-environment happy-dom

import { beforeEach, describe, expect, it } from 'vitest';
import {
  applyJevVisuals,
  normalizeJevEvaluationResult,
  renderJevHelpfulBadge,
} from '../../src/content/jev-ui.js';

describe('normalizeJevEvaluationResult', () => {
  it('accepts only the probability-only background response shape', () => {
    const valid = {
      helpfulProbability: 0.78,
      hatefulProbability: 0.02,
      showHelpfulBadge: true,
      hideReason: null,
    };
    expect(normalizeJevEvaluationResult(valid)).toEqual(valid);
    expect(normalizeJevEvaluationResult({ ...valid, helpfulProbability: 2 })).toBeNull();
    expect(normalizeJevEvaluationResult({ ...valid, hideReason: 'unknown' })).toBeNull();
    expect(normalizeJevEvaluationResult({ error: 'background failure' })).toBeNull();
  });
});

describe('renderJevHelpfulBadge', () => {
  let article: HTMLElement;

  beforeEach(() => {
    article = document.createElement('article');
    document.body.replaceChildren(article);
  });

  it('renders a probability-only helpful badge without generated explanation', () => {
    renderJevHelpfulBadge(article, 0.876);
    const badge = article.querySelector('.jev-helpful-badge');
    expect(badge?.textContent).toBe('Helpful 88%');
    expect(badge?.getAttribute('title')).toBe('Jev helpful probability: 88%');
  });

  it('updates one existing badge instead of duplicating it', () => {
    renderJevHelpfulBadge(article, 0.8);
    renderJevHelpfulBadge(article, 0.9);
    expect(article.querySelectorAll('.jev-helpful-badge')).toHaveLength(1);
    expect(article.querySelector('.jev-helpful-badge')?.textContent).toBe('Helpful 90%');
  });

  it('removes the badge when no probability should be shown', () => {
    renderJevHelpfulBadge(article, 0.8);
    renderJevHelpfulBadge(article, null);
    expect(article.querySelector('.jev-helpful-badge')).toBeNull();
  });
});

describe('applyJevVisuals', () => {
  it('returns probability-only hide copy and renders an independent badge', () => {
    const article = document.createElement('article');
    const reason = applyJevVisuals(article, {
      helpfulProbability: 0.91,
      hatefulProbability: 0.82,
      showHelpfulBadge: true,
      hideReason: 'hateful',
    });
    expect(reason).toBe('Hidden by Jev: hateful probability 82%.');
    expect(article.querySelector('.jev-helpful-badge')?.textContent).toBe('Helpful 91%');
  });

  it('returns no hide reason for a badge-only result', () => {
    const article = document.createElement('article');
    expect(applyJevVisuals(article, {
      helpfulProbability: 0.78,
      hatefulProbability: 0.02,
      showHelpfulBadge: true,
      hideReason: null,
    })).toBeNull();
  });
});
