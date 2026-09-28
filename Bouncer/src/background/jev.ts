export type JevRoute = 'typesafe' | 'openrouter';

export interface JevClassification {
  helpfulProbability: number;
  hatefulProbability: number;
}

export interface JevSettings {
  route: JevRoute;
  helpfulBadge: boolean;
  hideUnhelpful: boolean;
  hideHateful: boolean;
  helpfulBadgeThreshold: number;
  unhelpfulThreshold: number;
  hatefulThreshold: number;
  helpfulCriteria: string;
}

export interface JevPolicyResult {
  showHelpfulBadge: boolean;
  hideReason: 'unhelpful' | 'hateful' | null;
}

export const DEFAULT_JEV_SETTINGS: JevSettings = {
  route: 'openrouter',
  helpfulBadge: false,
  hideUnhelpful: false,
  hideHateful: false,
  helpfulBadgeThreshold: 0.75,
  unhelpfulThreshold: 0.25,
  hatefulThreshold: 0.8,
  helpfulCriteria: '',
};

const ROUTES: Record<JevRoute, { endpoint: string; model: string }> = {
  typesafe: {
    endpoint: 'https://api.typesafe.ai/v1/systemone',
    model: 'jev-1.13.0',
  },
  openrouter: {
    endpoint: 'https://openrouter.ai/api/v1/systemone',
    model: 'typesafe/jev-1.13',
  },
};

interface NoulAnswer {
  type: 'noul';
  noul: number;
}

interface JevResponse {
  answers?: {
    helpful?: NoulAnswer;
    hateful?: NoulAnswer;
  };
}

function isProbability(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function parseJevResponse(value: unknown): JevClassification {
  const body = value as JevResponse;
  const helpful = body?.answers?.helpful;
  const hateful = body?.answers?.hateful;
  if (helpful?.type !== 'noul' || !isProbability(helpful.noul)
      || hateful?.type !== 'noul' || !isProbability(hateful.noul)) {
    throw new Error('Jev returned a malformed decision response');
  }
  return {
    helpfulProbability: helpful.noul,
    hatefulProbability: hateful.noul,
  };
}

export async function callJevDecision({
  route,
  apiKey,
  post,
  helpfulCriteria = '',
  fetchImpl = fetch,
}: {
  route: JevRoute;
  apiKey: string;
  post: string;
  helpfulCriteria?: string;
  fetchImpl?: typeof fetch;
}): Promise<JevClassification> {
  const target = ROUTES[route];
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
  if (route === 'openrouter') {
    headers['HTTP-Referer'] = 'https://bouncer.app';
    headers['X-Title'] = 'Bouncer';
  }

  const response = await fetchImpl(target.endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: target.model,
      state: {
        post,
        helpful_preferences: helpfulCriteria.trim()
          || 'Information, insight, practical advice, constructive discussion, or worthwhile entertainment.',
      },
      questions: {
        helpful: {
          type: 'noul',
          instructions: 'Would `post` be helpful to this reader under `helpful_preferences`?',
          criteria: {
            true: 'The post provides information, insight, practical value, constructive discussion, or worthwhile entertainment aligned with the preferences.',
            false: 'The post provides little or no value under the preferences. Uncertainty is not evidence that it is unhelpful.',
          },
        },
        hateful: {
          type: 'noul',
          instructions: 'Does `post` itself express identity-targeted dehumanization, hatred, or threats?',
          criteria: {
            true: 'The author attacks people for a protected or identity-based trait with dehumanization, hatred, exclusion, or threats.',
            false: 'Mere criticism, disagreement, profanity, insults not targeting an identity, neutral quotation, reporting, or a quote condemning hate.',
          },
        },
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`Jev ${route} API error (HTTP ${response.status})`);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error('Jev returned a malformed decision response');
  }
  return parseJevResponse(body);
}

export function applyJevPolicy(
  classification: JevClassification,
  settings: JevSettings,
): JevPolicyResult {
  const hideReason = settings.hideHateful
    && classification.hatefulProbability >= clampJevHatefulThreshold(
      settings.hatefulThreshold,
      DEFAULT_JEV_SETTINGS.hatefulThreshold,
    )
    ? 'hateful'
    : settings.hideUnhelpful
      && classification.helpfulProbability <= clampJevUnhelpfulThreshold(
        settings.unhelpfulThreshold,
        DEFAULT_JEV_SETTINGS.unhelpfulThreshold,
      )
      ? 'unhelpful'
      : null;
  return {
    showHelpfulBadge: settings.helpfulBadge
      && classification.helpfulProbability >= settings.helpfulBadgeThreshold,
    hideReason,
  };
}

export function clampJevThreshold(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(1, Math.max(0, value));
}

export function clampJevUnhelpfulThreshold(value: unknown, fallback: number): number {
  return Math.min(0.49, clampJevThreshold(value, fallback));
}

export function clampJevHatefulThreshold(value: unknown, fallback: number): number {
  return Math.max(0.5, clampJevThreshold(value, fallback));
}
