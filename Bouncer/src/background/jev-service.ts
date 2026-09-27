import { getStorage } from '../shared/storage';
import type { JevEvaluationResult } from '../types';
import {
  applyJevPolicy,
  callJevDecision,
  clampJevHatefulThreshold,
  clampJevThreshold,
  clampJevUnhelpfulThreshold,
  DEFAULT_JEV_SETTINGS,
  type JevClassification,
  type JevRoute,
  type JevSettings,
} from './jev';

const evaluationCache = new Map<string, JevClassification>();
let settingsGeneration = 0;

export function clearJevEvaluationCache(): void {
  evaluationCache.clear();
}

/**
 * Invalidate both cached and in-flight work after any Jev storage change.
 * An old request may still finish, but its result must never be applied under
 * the new route, credentials, criteria, feature toggles, or thresholds.
 */
export function invalidateJevSettings(): void {
  settingsGeneration += 1;
  clearJevEvaluationCache();
}

async function loadJevSettings(): Promise<JevSettings & { apiKey: string }> {
  const data = await getStorage([
    'jevRoute',
    'typesafeApiKey',
    'openrouterApiKey',
    'jevHelpfulBadge',
    'jevHideUnhelpful',
    'jevHideHateful',
    'jevHelpfulBadgeThreshold',
    'jevUnhelpfulThreshold',
    'jevHatefulThreshold',
    'jevHelpfulCriteria',
  ]);
  const route: JevRoute = data.jevRoute === 'typesafe' ? 'typesafe' : 'openrouter';
  return {
    route,
    apiKey: route === 'typesafe'
      ? data.typesafeApiKey || ''
      : data.openrouterApiKey || '',
    helpfulBadge: data.jevHelpfulBadge === true,
    hideUnhelpful: data.jevHideUnhelpful === true,
    hideHateful: data.jevHideHateful === true,
    helpfulBadgeThreshold: clampJevThreshold(
      data.jevHelpfulBadgeThreshold,
      DEFAULT_JEV_SETTINGS.helpfulBadgeThreshold,
    ),
    unhelpfulThreshold: clampJevUnhelpfulThreshold(
      data.jevUnhelpfulThreshold,
      DEFAULT_JEV_SETTINGS.unhelpfulThreshold,
    ),
    hatefulThreshold: clampJevHatefulThreshold(
      data.jevHatefulThreshold,
      DEFAULT_JEV_SETTINGS.hatefulThreshold,
    ),
    helpfulCriteria: typeof data.jevHelpfulCriteria === 'string'
      ? data.jevHelpfulCriteria.trim()
      : '',
  };
}

export async function evaluateJevForPost(
  post: string,
  fetchImpl: typeof fetch = fetch,
): Promise<JevEvaluationResult | null> {
  const requestGeneration = settingsGeneration;
  const settings = await loadJevSettings();
  if (requestGeneration !== settingsGeneration) return null;
  const enabled = settings.helpfulBadge || settings.hideUnhelpful || settings.hideHateful;
  if (!enabled || !settings.apiKey || !post.trim()) return null;

  const cacheKey = JSON.stringify([settings.route, settings.helpfulCriteria, post]);
  let classification = evaluationCache.get(cacheKey);
  if (!classification) {
    try {
      classification = await callJevDecision({
        route: settings.route,
        apiKey: settings.apiKey,
        post,
        helpfulCriteria: settings.helpfulCriteria,
        fetchImpl,
      });
      if (requestGeneration !== settingsGeneration) return null;
      evaluationCache.set(cacheKey, classification);
    } catch {
      // Fail open. Do not include response bodies, post text, or credentials in logs.
      console.warn('[Jev] Decision unavailable; leaving post unchanged.');
      return null;
    }
  }

  if (requestGeneration !== settingsGeneration) return null;

  return {
    ...classification,
    ...applyJevPolicy(classification, settings),
  };
}
