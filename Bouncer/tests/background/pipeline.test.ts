import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

// Mock Chrome APIs used by pipeline.js and its imports
globalThis.chrome = {
  storage: {
    local: { get: vi.fn().mockResolvedValue({}), set: vi.fn().mockResolvedValue(undefined), remove: vi.fn().mockResolvedValue(undefined) },
    onChanged: { addListener: vi.fn() },
  },
  tabs: { sendMessage: vi.fn().mockResolvedValue({}) },
  runtime: { id: 'test-extension-id', onMessage: { addListener: vi.fn() } },
} as unknown as typeof chrome;

// Mock auth module to prevent Firebase initialization
vi.mock('../../src/background/auth.js', () => ({
  getAuthToken: vi.fn().mockResolvedValue(null),
}));

// Mock local-model.js to avoid WebLLM dependencies
vi.mock('../../src/background/local-model.js', () => ({
  callLocalInference: vi.fn(),
  localEngine: {
    isInitializing: () => false,
    isModelLoaded: () => false,
    clearQueue: vi.fn(),
    ensureLoaded: vi.fn().mockResolvedValue(undefined),
    generate: vi.fn(),
  },
}));

// Mock providers.js
vi.mock('../../src/background/providers.js', () => ({
  callDirectAPI: vi.fn(),
  callImbueAPI: vi.fn(),
}));

import { classifyError, enqueuePost, isKeyPending, clearTabQueue, setActiveTab, scheduleBatch } from '../../src/background/pipeline.js';
import { localEngine, callLocalInference } from '../../src/background/local-model.js';
import type { PendingEvaluation } from '../../src/types.js';

const mockCallLocalInference = vi.mocked(callLocalInference);

/** Create a PendingEvaluation with sensible defaults. */
function makePendingItem(overrides: Partial<PendingEvaluation> & { post: string; cacheKey: string; resolve: PendingEvaluation['resolve'] }): PendingEvaluation {
  return {
    imageUrls: [],
    tabId: undefined,
    postUrl: null,
    siteId: 'twitter',
    ...overrides,
  };
}

describe('classifyError', () => {
  it('classifies "401 Unauthorized" as auth for external APIs', () => {
    const result = classifyError('401 Unauthorized', 'openai');
    expect(result.errorType).toBe('auth');
  });

  it('does not classify auth errors for imbue provider', () => {
    const result = classifyError('401 Unauthorized', 'imbue');
    expect(result.errorType).toBeNull();
  });

  it('does not classify auth errors for local provider', () => {
    const result = classifyError('401 Unauthorized', 'local');
    expect(result.errorType).toBeNull();
  });

  it('classifies "RESOURCE_EXHAUSTED: quota limit reached" as gemini_free_tier rate limit', () => {
    const result = classifyError('RESOURCE_EXHAUSTED: quota limit reached', 'gemini');
    expect(result.errorType).toBe('rate_limit');
    expect(result.subType).toBe('gemini_free_tier');
  });

  it('classifies "503 Service Unavailable rate limit" as rate_limit (checked before api_error)', () => {
    const result = classifyError('503 Service Unavailable rate limit', 'openai');
    expect(result.errorType).toBe('rate_limit');
    expect(result.subType).toBe('generic');
  });

  it('classifies "HTTP 404 Not Found" as not_found', () => {
    const result = classifyError('HTTP 404 Not Found', 'openai');
    expect(result.errorType).toBe('not_found');
  });

  it('classifies "Internal Server Error 500" as server_error', () => {
    const result = classifyError('Internal Server Error 500', 'openai');
    expect(result.errorType).toBe('server_error');
  });

  it('auth takes priority over rate_limit for overlapping patterns', () => {
    const result = classifyError('Unauthorized 429', 'openai');
    expect(result.errorType).toBe('auth');
  });

  it('returns null errorType for unrecognized errors', () => {
    const result = classifyError('Something completely unknown happened', 'openai');
    expect(result.errorType).toBeNull();
    expect(result.subType).toBeNull();
  });

  it('classifies "free-models-per-day limit exceeded" as openrouter_credits', () => {
    const result = classifyError('free-models-per-day limit exceeded', 'openrouter');
    expect(result.errorType).toBe('rate_limit');
    expect(result.subType).toBe('openrouter_credits');
  });
});

// ==================== Per-tab queue management ====================

describe('enqueuePost', () => {
  beforeEach(() => {
    // Clear all tab queues by clearing the tab for a fresh state
    clearTabQueue(1);
    clearTabQueue(2);
  });

  it('adds item to correct tab queue and returns false for new cacheKey', () => {
    const resolve = vi.fn();
    const item = makePendingItem({ post: 'test', cacheKey: 'key1', resolve });
    const isDuplicate = enqueuePost(1, item);
    expect(isDuplicate).toBe(false);
    expect(isKeyPending(1, 'key1')).toBe(true);
  });

  it('returns true for duplicate cacheKey on same tab', () => {
    const item1 = makePendingItem({ post: 'test', cacheKey: 'key1', resolve: vi.fn() });
    const item2 = makePendingItem({ post: 'test', cacheKey: 'key1', resolve: vi.fn() });
    enqueuePost(1, item1);
    const isDuplicate = enqueuePost(1, item2);
    expect(isDuplicate).toBe(true);
  });

  it('items from different tabs are independent (same cacheKey on two tabs)', () => {
    const item1 = makePendingItem({ post: 'test', cacheKey: 'key1', resolve: vi.fn() });
    const item2 = makePendingItem({ post: 'test', cacheKey: 'key1', resolve: vi.fn() });
    expect(enqueuePost(1, item1)).toBe(false);
    expect(enqueuePost(2, item2)).toBe(false);
  });
});

describe('isKeyPending', () => {
  beforeEach(() => {
    clearTabQueue(1);
    clearTabQueue(2);
  });

  it('returns true for queued cacheKey on correct tab', () => {
    enqueuePost(1, makePendingItem({ post: 'test', cacheKey: 'key1', resolve: vi.fn() }));
    expect(isKeyPending(1, 'key1')).toBe(true);
  });

  it('returns false for wrong tab', () => {
    enqueuePost(1, makePendingItem({ post: 'test', cacheKey: 'key1', resolve: vi.fn() }));
    expect(isKeyPending(2, 'key1')).toBe(false);
  });

  it('returns false for unknown key', () => {
    expect(isKeyPending(1, 'nonexistent')).toBe(false);
  });
});

describe('clearTabQueue', () => {
  beforeEach(() => {
    clearTabQueue(1);
    vi.clearAllMocks();
  });

  it('resolves all items with null when tab is cleared', () => {
    const resolve1 = vi.fn();
    const resolve2 = vi.fn();
    enqueuePost(1, makePendingItem({ post: 'a', cacheKey: 'k1', resolve: resolve1 }));
    enqueuePost(1, makePendingItem({ post: 'b', cacheKey: 'k2', resolve: resolve2 }));

    clearTabQueue(1);

    expect(resolve1).toHaveBeenCalledWith(null);
    expect(resolve2).toHaveBeenCalledWith(null);
  });

  it('deletes queue and keys after clearing', () => {
    enqueuePost(1, makePendingItem({ post: 'a', cacheKey: 'k1', resolve: vi.fn() }));
    clearTabQueue(1);
    expect(isKeyPending(1, 'k1')).toBe(false);
  });

  it('is a no-op for unknown tabId', () => {
    expect(() => clearTabQueue(999)).not.toThrow();
  });
});

describe('setActiveTab', () => {
  beforeEach(() => {
    clearTabQueue(1);
    vi.clearAllMocks();
  });

  it('calls localEngine.clearQueue', () => {
    setActiveTab(1);
    expect(localEngine.clearQueue).toHaveBeenCalled();
  });

  it('calls localEngine.clearQueue even when setting to null', () => {
    setActiveTab(null);
    expect(localEngine.clearQueue).toHaveBeenCalled();
  });
});

// ==================== processBatch re-queue on tab switch ====================

describe('processBatch re-queue on inference queue cleared', () => {
  const TAB_ID = 10;
  const flush = () => new Promise(r => setTimeout(r, 100));

  beforeEach(() => {
    clearTabQueue(TAB_ID);
    clearTabQueue(TAB_ID + 1);
    setActiveTab(null);
    vi.clearAllMocks();

    // Mock storage to return local model settings with descriptions
    (globalThis.chrome.storage.local.get as Mock).mockResolvedValue({
      selectedModel: 'local:TestModel',
      descriptions_twitter: ['Sports'],
    });
    // Mock tabs.sendMessage for prioritizeByViewportDistance
    (globalThis.chrome.tabs.sendMessage as Mock).mockResolvedValue({ positions: {} });
  });

  it('re-queues items to original tab on inference queue cleared', async () => {
    mockCallLocalInference.mockRejectedValue(new Error('Inference queue cleared'));

    const resolve = vi.fn();
    enqueuePost(TAB_ID, { post: 'test post', imageUrls: [], cacheKey: 'test post', resolve, tabId: TAB_ID, postUrl: null, siteId: 'twitter' });

    setActiveTab(TAB_ID);
    scheduleBatch();
    await flush();

    // Item should be back in the queue, NOT resolved
    expect(resolve).not.toHaveBeenCalled();
    expect(isKeyPending(TAB_ID, 'test post')).toBe(true);
  });

  it('resolves with queue_cleared when tab was closed during batch', async () => {
    // Simulate: callLocalInference is called, tab closes (clearTabQueue), then inference rejects
    mockCallLocalInference.mockImplementation(async () => {
      clearTabQueue(TAB_ID);
      throw new Error('Inference queue cleared');
    });

    const resolve = vi.fn();
    enqueuePost(TAB_ID, { post: 'test post', imageUrls: [], cacheKey: 'test post', resolve, tabId: TAB_ID, postUrl: null, siteId: 'twitter' });

    setActiveTab(TAB_ID);
    scheduleBatch();
    await flush();

    // Item should be resolved with null since tab is gone
    expect(resolve).toHaveBeenCalledWith(null);
    expect(isKeyPending(TAB_ID, 'test post')).toBe(false);
  });

  it('does not re-queue into a replacement queue (page reload)', async () => {
    const newResolve = vi.fn();

    // Simulate: callLocalInference is called, page reloads (clear + new enqueue), then inference rejects
    mockCallLocalInference.mockImplementation(async () => {
      clearTabQueue(TAB_ID);
      // New page enqueues a fresh item into a NEW queue for the same tab
      enqueuePost(TAB_ID, { post: 'new page post', imageUrls: [], cacheKey: 'new_key', resolve: newResolve, tabId: TAB_ID, postUrl: null, siteId: 'twitter' });
      throw new Error('Inference queue cleared');
    });

    const oldResolve = vi.fn();
    enqueuePost(TAB_ID, { post: 'old post', imageUrls: [], cacheKey: 'old_key', resolve: oldResolve, tabId: TAB_ID, postUrl: null, siteId: 'twitter' });

    setActiveTab(TAB_ID);
    scheduleBatch();
    await flush();

    // Old item should be resolved with null (NOT re-queued into the new queue)
    expect(oldResolve).toHaveBeenCalledWith(null);
    // New item should be untouched in the new queue
    expect(newResolve).not.toHaveBeenCalled();
    expect(isKeyPending(TAB_ID, 'new_key')).toBe(true);
  });
});
