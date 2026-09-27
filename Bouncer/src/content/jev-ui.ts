import type { JevEvaluationResult } from '../types';

function isProbability(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

/** Keep the content-side message boundary probability-only and fail open. */
export function normalizeJevEvaluationResult(value: unknown): JevEvaluationResult | null {
  if (typeof value !== 'object' || value === null) return null;
  const result = value as Record<string, unknown>;
  const hideReason = result.hideReason;
  if (!isProbability(result.helpfulProbability)
      || !isProbability(result.hatefulProbability)
      || typeof result.showHelpfulBadge !== 'boolean'
      || (hideReason !== null && hideReason !== 'unhelpful' && hideReason !== 'hateful')) {
    return null;
  }
  return {
    helpfulProbability: result.helpfulProbability,
    hatefulProbability: result.hatefulProbability,
    showHelpfulBadge: result.showHelpfulBadge,
    hideReason,
  };
}

export function renderJevHelpfulBadge(article: HTMLElement, probability: number | null): void {
  const existing = article.querySelector<HTMLElement>('.jev-helpful-badge');
  if (probability === null) {
    existing?.remove();
    return;
  }

  const percent = Math.round(probability * 100);
  const badge = existing ?? document.createElement('span');
  badge.className = 'jev-helpful-badge';
  badge.textContent = `Helpful ${percent}%`;
  badge.title = `Jev helpful probability: ${percent}%`;
  badge.setAttribute('aria-label', badge.title);
  if (!existing) article.prepend(badge);
}

export function applyJevVisuals(
  article: HTMLElement,
  result: JevEvaluationResult | null,
): string | null {
  renderJevHelpfulBadge(
    article,
    result?.showHelpfulBadge ? result.helpfulProbability : null,
  );
  if (!result?.hideReason) return null;
  const probability = result.hideReason === 'hateful'
    ? result.hatefulProbability
    : result.helpfulProbability;
  const label = result.hideReason === 'hateful' ? 'hateful' : 'helpful';
  return `Hidden by Jev: ${label} probability ${Math.round(probability * 100)}%.`;
}
