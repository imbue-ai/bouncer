import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import type { EvaluationResult } from '../../src/types.js';

// ==================== Chrome stub ====================
// In-memory chrome.storage.local plus listener capture, so the real background
// entry point (index.ts) and pipeline can be driven through onMessage.

const TAB_ID = 42;
const store: Record<string, unknown> = {};
let onMessageListener: ((msg: unknown, sender: unknown, sendResponse: (r: unknown) => void) => unknown) | null = null;

const listenerStub = () => ({ addListener: vi.fn() });

globalThis.chrome = {
  storage: {
    local: {
      get: vi.fn((keys?: string | string[] | null) => {
        const list = keys == null ? Object.keys(store) : Array.isArray(keys) ? keys : [keys];
        const out: Record<string, unknown> = {};
        for (const k of list) if (k in store) out[k] = store[k];
        return Promise.resolve(out);
      }),
      set: vi.fn((items: Record<string, unknown>) => { Object.assign(store, items); return Promise.resolve(); }),
      remove: vi.fn((keys: string | string[]) => {
        for (const k of Array.isArray(keys) ? keys : [keys]) delete store[k];
        return Promise.resolve();
      }),
    },
    onChanged: listenerStub(),
  },
  tabs: {
    onActivated: listenerStub(),
    onRemoved: listenerStub(),
    onUpdated: listenerStub(),
    query: vi.fn().mockResolvedValue([{ id: TAB_ID }]),
    sendMessage: vi.fn().mockResolvedValue({ positions: {} }),
    create: vi.fn().mockResolvedValue({}),
  },
  windows: { onFocusChanged: listenerStub(), WINDOW_ID_NONE: -1 },
  runtime: {
    id: 'test-extension-id',
    lastError: null,
    getManifest: () => ({ version: '1.0.0' }),
    getURL: (p: string) => `chrome-extension://test/${p}`,
    setUninstallURL: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    onMessage: { addListener: vi.fn((fn: typeof onMessageListener) => { onMessageListener = fn; }) },
    onMessageExternal: listenerStub(),
    onInstalled: listenerStub(),
    onSuspend: listenerStub(),
  },
  identity: { getRedirectURL: () => 'https://test-extension-id.chromiumapp.org/' },
} as unknown as typeof chrome;

// ==================== Module mocks ====================

vi.mock('../../src/background/auth.js', () => ({
  IS_SAFARI: false,
  getAuthToken: vi.fn().mockResolvedValue(null),
  isAnonymousUser: vi.fn().mockReturnValue(false),
  getCurrentUid: vi.fn().mockReturnValue(null),
  setOnIdentityChanged: vi.fn(),
  launchAuthFlow: vi.fn(),
  signInAnon: vi.fn(),
  refreshAuthToken: vi.fn(),
  handleAppleSignIn: vi.fn(),
  signOut: vi.fn(),
}));

vi.mock('../../src/background/ws-manager.js', () => ({
  imbueWebSocket: { sendAndAwaitReply: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock('../../src/background/optional-platforms.js', () => ({
  initOptionalPlatforms: vi.fn(),
  syncOptionalPlatformScripts: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/background/local-model.js', () => ({
  callLocalInference: vi.fn(),
  localEngine: {
    isInitializing: () => false,
    isModelLoaded: () => true,
    checkCached: vi.fn().mockResolvedValue(true),
    clearQueue: vi.fn(),
    preempt: vi.fn(),
    ensureLoaded: vi.fn().mockResolvedValue(undefined),
    generate: vi.fn(),
  },
}));

vi.mock('../../src/background/providers.js', () => ({
  callDirectAPI: vi.fn(),
  callAnthropicAPI: vi.fn(),
  callImbueAPI: vi.fn(),
  callImbueAiTextDetection: vi.fn(),
  callImbueAiImageDetection: vi.fn(),
  sendFeedback: vi.fn(),
}));

import { verdictCoversPhrases, evaluationCache, clearTabQueue } from '../../src/background/pipeline.js';
import { callLocalInference } from '../../src/background/local-model.js';
import { cacheKeyFor } from '../../src/shared/utils.js';

const mockInference = vi.mocked(callLocalInference);

// ==================== verdictCoversPhrases (pure) ====================

describe('verdictCoversPhrases', () => {
  it('is false when the verdict has no phrases stamp (legacy entry)', () => {
    expect(verdictCoversPhrases({}, [])).toBe(false);
    expect(verdictCoversPhrases({}, ['sports'])).toBe(false);
  });

  it('is true when the verdict phrases equal the current list', () => {
    expect(verdictCoversPhrases({ phrases: ['sports', 'politics'] }, ['politics', 'sports'])).toBe(true);
    expect(verdictCoversPhrases({ phrases: [] }, [])).toBe(true);
  });

  it('is true when the verdict phrases are a superset (removal only)', () => {
    expect(verdictCoversPhrases({ phrases: ['sports', 'politics'] }, ['sports'])).toBe(true);
    expect(verdictCoversPhrases({ phrases: ['sports'] }, [])).toBe(true);
  });

  it('is false when a phrase was added', () => {
    expect(verdictCoversPhrases({ phrases: ['sports'] }, ['sports', 'politics'])).toBe(false);
    expect(verdictCoversPhrases({ phrases: [] }, ['sports'])).toBe(false);
  });

  it('is false when a phrase was swapped (one removed, one added)', () => {
    expect(verdictCoversPhrases({ phrases: ['sports'] }, ['politics'])).toBe(false);
  });

  it('normalizes case and surrounding whitespace on both sides', () => {
    expect(verdictCoversPhrases({ phrases: ['  Sports ', 'POLITICS'] }, ['sports', ' politics  '])).toBe(true);
    expect(verdictCoversPhrases({ phrases: ['sports'] }, ['SPORTS ', 'crypto'])).toBe(false);
  });
});

// ==================== evaluatePost cache path + in-flight re-queue ====================
// Drives the real background entry point (index.ts) and the real pipeline;
// only the classifier (callLocalInference) is mocked.

const SITE = 'twitter';
const flush = () => new Promise(r => setTimeout(r, 100));

function sendEvaluate(post: string): Promise<EvaluationResult & { cached?: boolean }> {
  return new Promise((resolve) => {
    const ret = onMessageListener!(
      { type: 'evaluatePost', post, imageUrls: [], postUrl: null, siteId: SITE, evaluationId: `eval-${post}` },
      { tab: { id: TAB_ID } },
      (r) => resolve(r as EvaluationResult),
    );
    expect(ret).toBe(true); // async response channel kept open
  });
}

function setDescriptions(phrases: string[]): void {
  store[`descriptions_${SITE}`] = phrases;
}

describe('evaluatePost cache honours phrase additions', () => {
  beforeAll(async () => {
    await import('../../src/background/index.js');
    expect(onMessageListener).toBeTypeOf('function');
  });

  beforeEach(() => {
    for (const k of Object.keys(store)) delete store[k];
    store.selectedModel = 'local:TestModel';
    evaluationCache.clear();
    clearTabQueue(TAB_ID);
    mockInference.mockReset();
  });

  function seedCachedVerdict(post: string, phrases: string[]): string {
    const key = cacheKeyFor(SITE, post, [], null);
    evaluationCache.set(key, { shouldHide: true, reasoning: 'cached-verdict', phrases });
    return key;
  }

  it('serves a verdict computed with [A] while descriptions are still [A]', async () => {
    setDescriptions(['sports']);
    seedCachedVerdict('post one', ['sports']);

    const res = await sendEvaluate('post one');
    expect(res.cached).toBe(true);
    expect(res.reasoning).toBe('cached-verdict');
    expect(mockInference).not.toHaveBeenCalled();
  });

  it('serves a verdict computed with [A] after A was removed (descriptions [])', async () => {
    setDescriptions([]);
    seedCachedVerdict('post two', ['sports']);

    const res = await sendEvaluate('post two');
    expect(res.cached).toBe(true);
    expect(res.reasoning).toBe('cached-verdict');
    expect(mockInference).not.toHaveBeenCalled();
  });

  it('does NOT serve a verdict computed with [A] once descriptions are [A, B]', async () => {
    setDescriptions(['sports', 'politics']);
    const key = seedCachedVerdict('post three', ['sports']);
    mockInference.mockResolvedValue({ shouldHide: false, reasoning: 'fresh-verdict', matches: [] });

    const res = await sendEvaluate('post three');
    expect(mockInference).toHaveBeenCalledTimes(1);
    expect(mockInference.mock.calls[0][1]).toEqual(['sports', 'politics']);
    expect(res.cached).toBeFalsy();
    expect(res.reasoning).toBe('fresh-verdict');
    // The fresh verdict replaces the stale one, stamped with the current list.
    expect(evaluationCache.get(key)?.phrases).toEqual(['sports', 'politics']);
  });

  it('does NOT serve a legacy cached verdict without a phrases stamp', async () => {
    setDescriptions(['sports']);
    const key = cacheKeyFor(SITE, 'post four', [], null);
    evaluationCache.set(key, { shouldHide: true, reasoning: 'legacy' });
    mockInference.mockResolvedValue({ shouldHide: false, reasoning: 'fresh-verdict', matches: [] });

    const res = await sendEvaluate('post four');
    expect(mockInference).toHaveBeenCalledTimes(1);
    expect(res.reasoning).toBe('fresh-verdict');
  });

  it('re-queues and re-classifies when a phrase is added mid-classification', async () => {
    setDescriptions(['sports']);
    mockInference
      .mockImplementationOnce(async () => {
        // User adds a phrase while the first classification is in flight.
        setDescriptions(['sports', 'politics']);
        return { shouldHide: false, reasoning: 'first-call', matches: [] };
      })
      .mockImplementationOnce(async () => ({ shouldHide: true, reasoning: 'second-call', matches: [] }));

    const res = await sendEvaluate('post five');
    expect(mockInference).toHaveBeenCalledTimes(2);
    expect(mockInference.mock.calls[0][1]).toEqual(['sports']);
    expect(mockInference.mock.calls[1][1]).toEqual(['sports', 'politics']);
    expect(res.reasoning).toBe('second-call');
    expect(res.shouldHide).toBe(true);

    const key = cacheKeyFor(SITE, 'post five', [], null);
    expect(evaluationCache.get(key)?.reasoning).toBe('second-call');
    expect(evaluationCache.get(key)?.phrases).toEqual(['sports', 'politics']);
  });

  it('delivers the in-flight verdict when a phrase is only removed mid-classification', async () => {
    setDescriptions(['sports', 'politics']);
    mockInference.mockImplementationOnce(async () => {
      setDescriptions(['sports']);
      return { shouldHide: false, reasoning: 'only-call', matches: [] };
    });

    const res = await sendEvaluate('post six');
    await flush();
    expect(mockInference).toHaveBeenCalledTimes(1);
    expect(res.reasoning).toBe('only-call');
  });
});
