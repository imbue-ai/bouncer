import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import {
  clearJevEvaluationCache,
  evaluateJevForPost,
  invalidateJevSettings,
} from '../../src/background/jev-service.js';

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const decision = {
  answers: {
    helpful: { type: 'noul', noul: 0.9 },
    hateful: { type: 'noul', noul: 0.05 },
  },
};

describe('evaluateJevForPost', () => {
  beforeEach(() => {
    clearJevEvaluationCache();
    vi.clearAllMocks();
  });

  it('does not transmit posts while every Jev feature is off', async () => {
    const fetchMock = vi.fn();
    (chrome.storage.local.get as Mock).mockResolvedValue({
      openrouterApiKey: 'secret',
    });
    await expect(evaluateJevForPost('private post', fetchMock)).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses only the selected route key and returns policy without a credential', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(decision));
    (chrome.storage.local.get as Mock).mockResolvedValue({
      jevRoute: 'typesafe',
      typesafeApiKey: 'direct-only-secret',
      openrouterApiKey: 'must-not-be-used',
      jevHelpfulBadge: true,
    });

    const result = await evaluateJevForPost('useful post', fetchMock);
    expect(result).toEqual({
      helpfulProbability: 0.9,
      hatefulProbability: 0.05,
      showHelpfulBadge: true,
      hideReason: null,
    });
    expect(JSON.stringify(result)).not.toContain('secret');
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer direct-only-secret');
  });

  it('does not fall back to the other provider key', async () => {
    const fetchMock = vi.fn();
    (chrome.storage.local.get as Mock).mockResolvedValue({
      jevRoute: 'openrouter',
      typesafeApiKey: 'direct-secret',
      jevHideHateful: true,
    });

    await expect(evaluateJevForPost('post', fetchMock)).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['network', () => Promise.reject(new Error('offline'))],
    ['HTTP', () => Promise.resolve(response({ error: 'unavailable' }, 503))],
    ['malformed response', () => Promise.resolve(response({ answers: {} }))],
  ])('fails open on %s errors', async (_kind, fetchResult) => {
    (chrome.storage.local.get as Mock).mockResolvedValue({
      jevRoute: 'openrouter',
      openrouterApiKey: 'router-secret',
      jevHideHateful: true,
    });
    const fetchMock = vi.fn().mockImplementation(fetchResult);
    await expect(evaluateJevForPost('post', fetchMock)).resolves.toBeNull();
  });

  it('caches probabilities but reapplies changed local thresholds', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(decision));
    const storageGet = chrome.storage.local.get as Mock;
    storageGet.mockResolvedValueOnce({
      jevRoute: 'openrouter',
      openrouterApiKey: 'router-secret',
      jevHelpfulBadge: true,
      jevHelpfulBadgeThreshold: 0.95,
    });
    expect((await evaluateJevForPost('same post', fetchMock))?.showHelpfulBadge).toBe(false);

    storageGet.mockResolvedValueOnce({
      jevRoute: 'openrouter',
      openrouterApiKey: 'router-secret',
      jevHelpfulBadge: true,
      jevHelpfulBadgeThreshold: 0.8,
    });
    expect((await evaluateJevForPost('same post', fetchMock))?.showHelpfulBadge).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('drops an in-flight result after Jev settings change', async () => {
    (chrome.storage.local.get as Mock).mockResolvedValue({
      jevRoute: 'openrouter',
      openrouterApiKey: 'router-secret',
      jevHelpfulBadge: true,
    });

    let resolveFetch!: (response: Response) => void;
    const fetchMock = vi.fn().mockReturnValue(new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    }));

    const pending = evaluateJevForPost('post evaluated under old settings', fetchMock);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    invalidateJevSettings();
    resolveFetch(response(decision));

    await expect(pending).resolves.toBeNull();
  });
});
