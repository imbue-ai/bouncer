// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyJevVisuals,
  awaitPipelineWithIndependentJev,
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

describe('awaitPipelineWithIndependentJev', () => {
  const validJevResult = {
    helpfulProbability: 0.78,
    hatefulProbability: 0.02,
    showHelpfulBadge: true,
    hideReason: null,
  } as const;

  it('lets the regular pipeline resolve while the Jev request is still pending', async () => {
    let resolveJev!: (value: unknown) => void;
    const jevRequest = new Promise<unknown>((resolve) => { resolveJev = resolve; });
    const applyJev = vi.fn();

    await expect(awaitPipelineWithIndependentJev(
      Promise.resolve('pipeline-result'),
      jevRequest,
      () => true,
      applyJev,
    )).resolves.toBe('pipeline-result');
    expect(applyJev).not.toHaveBeenCalled();

    resolveJev(validJevResult);
    await vi.waitFor(() => expect(applyJev).toHaveBeenCalledWith(validJevResult));
  });

  it('applies an early Jev result only after the regular pipeline settles', async () => {
    let resolvePipeline!: (value: string) => void;
    const pipelineRequest = new Promise<string>((resolve) => { resolvePipeline = resolve; });
    const applyJev = vi.fn();
    let jevSettled = false;
    const jevRequest = Promise.resolve(validJevResult).then((value) => {
      jevSettled = true;
      return value;
    });

    const result = awaitPipelineWithIndependentJev(
      pipelineRequest,
      jevRequest,
      () => true,
      applyJev,
    );
    await vi.waitFor(() => expect(jevSettled).toBe(true));
    await Promise.resolve();
    expect(applyJev).not.toHaveBeenCalled();

    resolvePipeline('pipeline-result');
    await expect(result).resolves.toBe('pipeline-result');
    await vi.waitFor(() => expect(applyJev).toHaveBeenCalledWith(validJevResult));
  });

  it('contains an early Jev rejection while the regular pipeline is pending', async () => {
    let resolvePipeline!: (value: string) => void;
    const pipelineRequest = new Promise<string>((resolve) => { resolvePipeline = resolve; });
    const applyJev = vi.fn();

    const result = awaitPipelineWithIndependentJev(
      pipelineRequest,
      Promise.reject(new Error('message channel closed')),
      () => true,
      applyJev,
    );
    await new Promise(resolve => setTimeout(resolve, 0));
    resolvePipeline('pipeline-result');

    await expect(result).resolves.toBe('pipeline-result');
    await Promise.resolve();
    expect(applyJev).not.toHaveBeenCalled();
  });

  it('drops malformed, failed, and stale Jev results', async () => {
    const applyMalformed = vi.fn();
    await awaitPipelineWithIndependentJev(
      Promise.resolve('pipeline-result'),
      Promise.resolve({ error: 'bad response' }),
      () => true,
      applyMalformed,
    );
    await Promise.resolve();
    expect(applyMalformed).not.toHaveBeenCalled();

    const applyStale = vi.fn();
    await awaitPipelineWithIndependentJev(
      Promise.resolve('pipeline-result'),
      Promise.resolve(validJevResult),
      () => false,
      applyStale,
    );
    await Promise.resolve();
    expect(applyStale).not.toHaveBeenCalled();

    const applyRejected = vi.fn();
    await expect(awaitPipelineWithIndependentJev(
      Promise.resolve('pipeline-result'),
      Promise.reject(new Error('offline')),
      () => true,
      applyRejected,
    )).resolves.toBe('pipeline-result');
    await Promise.resolve();
    expect(applyRejected).not.toHaveBeenCalled();
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
