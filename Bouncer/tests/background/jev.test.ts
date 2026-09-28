import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  applyJevPolicy,
  callJevDecision,
  DEFAULT_JEV_SETTINGS,
  type JevSettings,
} from '../../src/background/jev.js';

const directResponse = {
  model: 'jev-1.13.0',
  answers: {
    helpful: { type: 'noul', noul: 0.86 },
    hateful: { type: 'noul', noul: 0.04 },
  },
  usage: { input_tokens: 42, output_tokens: 2 },
};

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function settings(overrides: Partial<JevSettings> = {}): JevSettings {
  return { ...DEFAULT_JEV_SETTINGS, ...overrides };
}

describe('callJevDecision', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('uses the official TypeSafe System One endpoint and pinned direct model', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(directResponse));

    const result = await callJevDecision({
      route: 'typesafe',
      apiKey: 'direct-secret',
      post: 'A practical guide to fixing a bike chain.',
      helpfulCriteria: 'Practical technical advice',
      fetchImpl: fetchMock,
    });

    expect(result).toEqual({ helpfulProbability: 0.86, hatefulProbability: 0.04 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.typesafe.ai/v1/systemone');
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer direct-secret',
      'Content-Type': 'application/json',
    });
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe('jev-1.13.0');
    expect(body.state).toEqual({
      post: 'A practical guide to fixing a bike chain.',
      helpful_preferences: 'Practical technical advice',
    });
    expect(body.questions.helpful.type).toBe('noul');
    expect(body.questions.hateful.type).toBe('noul');
    expect(JSON.stringify(body.questions.hateful)).toContain('identity-targeted');
    expect(JSON.stringify(body.questions.hateful)).toContain('condemning hate');
  });

  it('uses OpenRouter System One with its Jev model and attribution headers', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({
      ...directResponse,
      model: 'typesafe/jev-1.13-20260917',
    }));

    await callJevDecision({
      route: 'openrouter',
      apiKey: 'router-secret',
      post: 'post',
      fetchImpl: fetchMock,
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://openrouter.ai/api/v1/systemone');
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer router-secret',
      'HTTP-Referer': 'https://bouncer.app',
      'X-Title': 'Bouncer',
    });
    expect(JSON.parse(String(init.body)).model).toBe('typesafe/jev-1.13');
  });

  it.each([
    {},
    { answers: { helpful: { type: 'noul', noul: 2 }, hateful: { type: 'noul', noul: 0.1 } } },
    { answers: { helpful: { type: 'choice', noul: 0.8 }, hateful: { type: 'noul', noul: 0.1 } } },
  ])('rejects malformed decision responses so callers can fail open', async (body) => {
    const fetchMock = vi.fn().mockResolvedValue(response(body));
    await expect(callJevDecision({
      route: 'typesafe', apiKey: 'secret', post: 'post', fetchImpl: fetchMock,
    })).rejects.toThrow('malformed');
  });

  it('does not call a second route after an API failure', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ error: 'bad key' }, 401));
    await expect(callJevDecision({
      route: 'typesafe', apiKey: 'secret', post: 'post', fetchImpl: fetchMock,
    })).rejects.toThrow('HTTP 401');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('applyJevPolicy', () => {
  it('badges only sufficiently helpful posts', () => {
    expect(applyJevPolicy(
      { helpfulProbability: 0.8, hatefulProbability: 0.1 },
      settings({ helpfulBadge: true, helpfulBadgeThreshold: 0.75 }),
    )).toMatchObject({ showHelpfulBadge: true, hideReason: null });
  });

  it('does not call an uncertain helpfulness score unhelpful', () => {
    expect(applyJevPolicy(
      { helpfulProbability: 0.5, hatefulProbability: 0.1 },
      settings({ hideUnhelpful: true, unhelpfulThreshold: 0.25 }),
    ).hideReason).toBeNull();
    expect(applyJevPolicy(
      { helpfulProbability: 0.5, hatefulProbability: 0.1 },
      settings({ hideUnhelpful: true, unhelpfulThreshold: 1 }),
    ).hideReason).toBeNull();
  });

  it('hides only when an enabled threshold is crossed', () => {
    expect(applyJevPolicy(
      { helpfulProbability: 0.2, hatefulProbability: 0.1 },
      settings({ hideUnhelpful: true, unhelpfulThreshold: 0.25 }),
    ).hideReason).toBe('unhelpful');
    expect(applyJevPolicy(
      { helpfulProbability: 0.9, hatefulProbability: 0.85 },
      settings({ hideHateful: true, hatefulThreshold: 0.8 }),
    ).hideReason).toBe('hateful');
    expect(applyJevPolicy(
      { helpfulProbability: 0.9, hatefulProbability: 0.4 },
      settings({ hideHateful: true, hatefulThreshold: 0 }),
    ).hideReason).toBeNull();
  });

  it('keeps every action disabled by default', () => {
    expect(applyJevPolicy(
      { helpfulProbability: 0.99, hatefulProbability: 0.99 },
      DEFAULT_JEV_SETTINGS,
    )).toEqual({ showHelpfulBadge: false, hideReason: null });
  });
});
