import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock @mlc-ai/web-llm before importing local-model
vi.mock('@mlc-ai/web-llm', () => ({
  CreateMLCEngine: vi.fn(),
  hasModelInCache: vi.fn(),
  prebuiltAppConfig: {
    model_list: [
      {
        model_id: 'Qwen3-4B-q4f16_1-MLC',
        model: 'https://huggingface.co/mlc-ai/Qwen3-4B-q4f16_1-MLC',
        model_lib: 'https://raw.githubusercontent.com/user/Qwen3-4B-q4f16_1-ctx4k_cs1k-webgpu.wasm',
      },
    ],
  },
}));

// We need to mock models.js so we can control PREDEFINED_MODELS per test.
// Use a mutable holder so individual tests can override the values.
const modelsState: { PREDEFINED_MODELS: { local: Record<string, unknown>[] } } = {
  PREDEFINED_MODELS: { local: [] },
};

vi.mock('../../src/shared/models.js', () => ({
  get PREDEFINED_MODELS() { return modelsState.PREDEFINED_MODELS; },
}));

// Mock shared modules needed by LocalEngine
vi.mock('../../src/shared/utils.js', () => ({
  isGPUDeviceLostError: vi.fn(() => false),
  isNetworkError: vi.fn(() => false),
  formatLocalInferenceResult: vi.fn(),
}));
vi.mock('../../src/shared/prompts.js', () => ({
  LOCAL_SYSTEM_PROMPT: 'mock system prompt',
  buildLocalUserMessage: vi.fn(),
}));

import { buildModelConfig, localEngine, parseLocalModelResponse } from '../../src/background/local-model.js';
import { InferenceQueue, inferenceQueue } from '../../src/background/inference-queue.js';
import { CreateMLCEngine, hasModelInCache } from '@mlc-ai/web-llm';
import { isGPUDeviceLostError } from '../../src/shared/utils.js';
import type { Mock } from 'vitest';
import type { LocalModelDef } from '../../src/types.js';

// ==================== InferenceQueue ====================

// Each test gets a fresh queue instance — no shared mutable state.
describe('InferenceQueue', () => {
  it('clear rejects all pending tasks', async () => {
    const q = new InferenceQueue();
    const neverResolve = () => new Promise(() => {});

    // p1 starts executing (shifted out of pending), p2 stays pending
    q.enqueue(neverResolve);
    const p2 = q.enqueue(neverResolve);
    await new Promise(r => setTimeout(r, 0));

    q.clear();

    await expect(p2).rejects.toThrow('Inference queue cleared');
  });

  it('clear is a no-op when the queue is empty', () => {
    const q = new InferenceQueue();
    expect(() => q.clear()).not.toThrow();
  });

  it('drain waits for in-flight task before running callback', async () => {
    const q = new InferenceQueue();
    const order: string[] = [];
    let resolveInflight!: (value: unknown) => void;

    const inflightPromise = q.enqueue(() => new Promise(resolve => {
      resolveInflight = resolve;
    }));
    await new Promise(r => setTimeout(r, 0));

    const drainPromise = q.drain(async () => { order.push('drain'); });

    // Drain should not have run yet
    expect(order).toEqual([]);

    resolveInflight('done');
    await inflightPromise;
    await drainPromise;

    expect(order).toEqual(['drain']);
  });

  it('drain clears pending tasks so only in-flight task runs first', async () => {
    const q = new InferenceQueue();
    let resolveInflight!: (value: unknown) => void;

    q.enqueue(() => new Promise(resolve => { resolveInflight = resolve; }));
    await new Promise(r => setTimeout(r, 0));

    const pendingPromise = q.enqueue(() => Promise.resolve('should not run'));
    pendingPromise.catch(() => {}); // prevent unhandled rejection

    const drainPromise = q.drain(async () => 'drained');

    await expect(pendingPromise).rejects.toThrow('Inference queue cleared');

    resolveInflight('done');
    await drainPromise;
  });

  it('concurrent drain calls serialize instead of rejecting each other', async () => {
    const q = new InferenceQueue();
    const order: string[] = [];
    let resolveInflight!: (value?: unknown) => void;

    // Block with in-flight task
    q.enqueue(() => new Promise(resolve => { resolveInflight = resolve; }));
    await new Promise(r => setTimeout(r, 0));

    // Two concurrent drains — second must not reject first
    const d1 = q.drain(async () => { order.push('drain1'); });
    const d2 = q.drain(async () => { order.push('drain2'); });

    resolveInflight();
    await Promise.all([d1, d2]);

    expect(order).toEqual(['drain1', 'drain2']);
  });

  it('enqueue respects priority ordering among pending tasks', async () => {
    const q = new InferenceQueue();
    const order: string[] = [];
    let resolveInflight!: (value?: unknown) => void;

    // Block the queue with an in-flight task
    q.enqueue(() => new Promise(resolve => { resolveInflight = resolve; }));
    await new Promise(r => setTimeout(r, 0));

    // Queue tasks with different priorities
    q.enqueue(async () => { order.push('low'); }, { priority: 0 });
    q.enqueue(async () => { order.push('high'); }, { priority: 10 });
    q.enqueue(async () => { order.push('mid'); }, { priority: 5 });

    resolveInflight();
    // Wait for all tasks to process
    await new Promise(r => setTimeout(r, 10));

    expect(order).toEqual(['high', 'mid', 'low']);
  });
});

// ==================== buildModelConfig ====================

describe('buildModelConfig', () => {
  beforeEach(() => {
    modelsState.PREDEFINED_MODELS = { local: [] };
  });

  // --- appConfig tests ---

  it('returns undefined appConfig for a built-in model with no webllmConfig', () => {
    modelsState.PREDEFINED_MODELS = {
      local: [{ name: 'Qwen3-4B-q4f16_1-MLC', display: 'Qwen3 4B' }],
    };
    expect(buildModelConfig('Qwen3-4B-q4f16_1-MLC').appConfig).toBeUndefined();
  });

  it('returns undefined appConfig for an unknown model', () => {
    expect(buildModelConfig('nonexistent-model').appConfig).toBeUndefined();
  });

  // --- Custom registry path (webllmConfig.model set) ---

  it('builds config from webllmConfig.model for non-registry models', () => {
    modelsState.PREDEFINED_MODELS = {
      local: [{
        name: 'InternVL3_5-4B-q4f16_1-MLC',
        webllmConfig: {
          model_type: 2,
          model: 'https://huggingface.co/imbue/internvl3_5-4b-q4f16_1-mlc',
          model_lib: 'https://example.com/model.wasm',
          overrides: { context_window_size: 4096, prefill_chunk_size: 1024 },
        },
      }],
    };
    const { appConfig } = buildModelConfig('InternVL3_5-4B-q4f16_1-MLC');
    const record = appConfig!.model_list[0];
    expect(record.model_id).toBe('InternVL3_5-4B-q4f16_1-MLC');
    expect(record.model).toBe('https://huggingface.co/imbue/internvl3_5-4b-q4f16_1-mlc');
    expect(record.model_lib).toBe('https://example.com/model.wasm');
    expect(record.model_type).toBe(2);
    expect(record.overrides).toEqual({ context_window_size: 4096, prefill_chunk_size: 1024 });
  });

  it('omits overrides key when webllmConfig has no overrides', () => {
    modelsState.PREDEFINED_MODELS = {
      local: [{
        name: 'Custom-MLC',
        webllmConfig: {
          model: 'https://example.com/model',
          model_lib: 'https://example.com/model.wasm',
        },
      }],
    };
    const record = buildModelConfig('Custom-MLC').appConfig!.model_list[0];
    expect(record).not.toHaveProperty('overrides');
  });

  it('returns undefined appConfig when webllmConfig exists but model is not in prebuilt registry', () => {
    modelsState.PREDEFINED_MODELS = {
      local: [{
        name: 'LocalOnly-MLC',
        webllmConfig: { model_type: 2 },
      }],
    };
    // Not in prebuilt registry and no custom model URL → falls through to default
    expect(buildModelConfig('LocalOnly-MLC').appConfig).toBeUndefined();
  });

  it('merges model_lib override onto prebuilt registry record', () => {
    modelsState.PREDEFINED_MODELS = {
      local: [{
        name: 'Qwen3-4B-q4f16_1-MLC',
        webllmConfig: {
          model_lib: 'https://example.com/custom.wasm',
          overrides: { context_window_size: 4096 },
        },
      }],
    };
    const { appConfig } = buildModelConfig('Qwen3-4B-q4f16_1-MLC');
    const record = appConfig!.model_list[0];
    // Should use prebuilt model URL
    expect(record.model).toBe('https://huggingface.co/mlc-ai/Qwen3-4B-q4f16_1-MLC');
    // Should use custom model_lib
    expect(record.model_lib).toBe('https://example.com/custom.wasm');
    expect(record.overrides).toEqual({ context_window_size: 4096 });
  });

  it('returns undefined appConfig when webllmConfig has only overrides and model is in prebuilt registry', () => {
    modelsState.PREDEFINED_MODELS = {
      local: [{
        name: 'Qwen3-4B-q4f16_1-MLC',
        webllmConfig: {
          overrides: { context_window_size: 4096 },
        },
      }],
    };
    // Only overrides, no record-level fields to merge → use default config
    expect(buildModelConfig('Qwen3-4B-q4f16_1-MLC').appConfig).toBeUndefined();
  });

  // --- chatOpts tests ---

  it('returns base chatOpts when no webllmConfig', () => {
    modelsState.PREDEFINED_MODELS = {
      local: [{ name: 'Qwen3-4B-q4f16_1-MLC', display: 'Qwen3 4B' }],
    };
    const { chatOpts } = buildModelConfig('Qwen3-4B-q4f16_1-MLC');
    expect(chatOpts).toEqual({ context_window_size: 1024 });
  });

  it('merges overrides into chatOpts', () => {
    modelsState.PREDEFINED_MODELS = {
      local: [{
        name: 'Qwen3-4B-q4f16_1-MLC',
        webllmConfig: {
          overrides: { context_window_size: 4096, prefill_chunk_size: 1024 },
        },
      }],
    };
    const { chatOpts } = buildModelConfig('Qwen3-4B-q4f16_1-MLC');
    expect(chatOpts.context_window_size).toBe(4096);
    expect(chatOpts.prefill_chunk_size).toBe(1024);
  });

  it('excludes model-record-level keys from chatOpts', () => {
    modelsState.PREDEFINED_MODELS = {
      local: [{
        name: 'TestVLM-MLC',
        webllmConfig: {
          model_type: 2,
          model: 'https://example.com/model',
          model_lib: 'https://example.com/model.wasm',
          overrides: { context_window_size: 4096 },
        },
      }],
    };
    const { chatOpts } = buildModelConfig('TestVLM-MLC');
    expect(chatOpts).not.toHaveProperty('model_type');
    expect(chatOpts).not.toHaveProperty('model');
    expect(chatOpts).not.toHaveProperty('model_lib');
    expect(chatOpts.context_window_size).toBe(4096);
  });
});

// ==================== localEngine.cancelDownload ====================

describe('localEngine.cancelDownload', () => {
  let storageData: Record<string, unknown>;

  beforeEach(async () => {
    // Reset mocks and state
    (CreateMLCEngine as Mock).mockReset();
    (hasModelInCache as Mock).mockReset();
    modelsState.PREDEFINED_MODELS = { local: [{ name: 'TestModel-MLC', display: 'Test' }] };

    await localEngine.reset();

    // Mock chrome.storage
    storageData = {};
    globalThis.chrome = {
      storage: {
        local: {
          get: vi.fn(async () => storageData),
          set: vi.fn(async (data: Record<string, unknown>) => { Object.assign(storageData, data); }),
        } as unknown as chrome.storage.LocalStorageArea,
      },
    } as unknown as typeof chrome;

    // Mock navigator.gpu
    Object.defineProperty(globalThis, 'navigator', {
      value: { gpu: {} },
      writable: true,
      configurable: true,
    });
  });

  it('returns false when no download is in progress for the model', async () => {
    const result = await localEngine.cancelDownload('TestModel-MLC');
    expect(result).toBe(false);
  });

  it('aborts an in-progress download and resets state', async () => {
    (hasModelInCache as Mock).mockResolvedValue(false);

    // Start an initialization that will hang (never resolve)
    (CreateMLCEngine as Mock).mockImplementation(() => new Promise(() => {}));

    // Start init (don't await - it will hang because CreateMLCEngine never resolves)
    localEngine.initialize('TestModel-MLC');

    // Wait for init to start
    await new Promise(r => setTimeout(r, 10));

    expect(localEngine.isInitializing()).toBe(true);
    expect(localEngine.isInitializingModel('TestModel-MLC')).toBe(true);

    // Cancel it
    const cancelled = await localEngine.cancelDownload('TestModel-MLC');
    expect(cancelled).toBe(true);

    // State should be reset
    expect(localEngine.isInitializing()).toBe(false);
    expect(localEngine.engine).toBeNull();
    expect(localEngine.loadedModel).toBeNull();
  });

  it('sets status to not_downloaded when model is not cached', async () => {
    (hasModelInCache as Mock).mockResolvedValue(false);
    (CreateMLCEngine as Mock).mockImplementation(() => new Promise(() => {}));

    localEngine.initialize('TestModel-MLC');
    await new Promise(r => setTimeout(r, 10));

    await localEngine.cancelDownload('TestModel-MLC');

    // Check that status was set to not_downloaded
    const statuses = (storageData.localModelStatuses || {}) as Record<string, Record<string, unknown>>;
    expect(statuses['TestModel-MLC']?.state).toBe('not_downloaded');
  });

  it('sets status to cached when partial download exists in cache', async () => {
    // First call during init (for syncLocalModelStatus), then true for cancel check
    (hasModelInCache as Mock).mockResolvedValue(true);
    (CreateMLCEngine as Mock).mockImplementation(() => new Promise(() => {}));

    localEngine.initialize('TestModel-MLC');
    await new Promise(r => setTimeout(r, 10));

    await localEngine.cancelDownload('TestModel-MLC');

    const statuses = (storageData.localModelStatuses || {}) as Record<string, Record<string, unknown>>;
    expect(statuses['TestModel-MLC']?.state).toBe('cached');
  });

  it('abort paths resolve initPromise when engine creation completes after abort', async () => {
    (hasModelInCache as Mock).mockResolvedValue(false);

    // CreateMLCEngine resolves after abort fires — the post-creation abort check
    // must call _completeInit(null) so waiters on _initPromise don't hang.
    const mockEngine = { unload: vi.fn().mockResolvedValue(undefined) };
    let resolveCreate!: (value: unknown) => void;
    (CreateMLCEngine as Mock).mockImplementation(() => new Promise(resolve => { resolveCreate = resolve; }));

    const initPromise = localEngine.initialize('TestModel-MLC');
    await new Promise(r => setTimeout(r, 10));

    // A second caller starts waiting on _initPromise
    const waiterPromise = localEngine._initPromise;

    // Cancel via cancelDownload (which calls reset internally)
    await localEngine.cancelDownload('TestModel-MLC');

    // Now engine creation completes after abort
    resolveCreate(mockEngine);
    await new Promise(r => setTimeout(r, 10));

    // Both promises should resolve to null (not hang)
    const [engine, waiterResult] = await Promise.all([
      Promise.race([initPromise, new Promise(r => setTimeout(() => r('TIMEOUT'), 100))]),
      Promise.race([waiterPromise ?? Promise.resolve(null), new Promise(r => setTimeout(() => r('TIMEOUT'), 100))]),
    ]);
    expect(engine).toBeNull();
    expect(waiterResult).toBeNull();
  });

  it('discards engine created after abort signal fires', async () => {
    (hasModelInCache as Mock).mockResolvedValue(false);

    const mockEngine = { unload: vi.fn().mockResolvedValue(undefined) };
    let resolveCreate!: (value: unknown) => void;
    (CreateMLCEngine as Mock).mockImplementation(() => new Promise(resolve => { resolveCreate = resolve; }));

    const initPromise = localEngine.initialize('TestModel-MLC');
    await new Promise(r => setTimeout(r, 10));

    // Cancel while CreateMLCEngine is still pending
    await localEngine.cancelDownload('TestModel-MLC');

    // Now resolve CreateMLCEngine after cancellation
    resolveCreate(mockEngine);
    await new Promise(r => setTimeout(r, 10));

    const engine = await initPromise;
    expect(engine).toBeNull();
    // Engine should have been unloaded since it completed after abort
    expect(mockEngine.unload).toHaveBeenCalled();
  });
});

// ==================== Idle timeout ====================

describe('idle timeout', () => {
  let storageData: Record<string, unknown>;

  beforeEach(async () => {
    vi.useFakeTimers();
    (CreateMLCEngine as Mock).mockReset();
    (hasModelInCache as Mock).mockReset();
    modelsState.PREDEFINED_MODELS = {
      local: [{ name: 'TestModel-MLC', display: 'Test' }],
    };

    await localEngine.reset();

    storageData = {};
    globalThis.chrome = {
      storage: {
        local: {
          get: vi.fn(async () => storageData),
          set: vi.fn(async (data: Record<string, unknown>) => { Object.assign(storageData, data); }),
        } as unknown as chrome.storage.LocalStorageArea,
      },
    } as unknown as typeof chrome;

    Object.defineProperty(globalThis, 'navigator', {
      value: { gpu: {} },
      writable: true,
      configurable: true,
    });
  });

  afterEach(async () => {
    await localEngine.reset();
    vi.useRealTimers();
  });

  // Helper: advance time and flush the async idle timeout callback.
  // Stops keepalive first to prevent infinite interval ticks, then
  // uses vi.advanceTimersByTimeAsync which handles promise-based callbacks.
  async function advanceAndFlush(ms: number): Promise<void> {
    localEngine._stopKeepAlive();
    await vi.advanceTimersByTimeAsync(ms);
  }

  it('unloads engine after idle timeout fires', async () => {
    const mockEngine = { unload: vi.fn().mockResolvedValue(undefined) };
    (CreateMLCEngine as Mock).mockResolvedValue(mockEngine);

    await localEngine.initialize('TestModel-MLC');
    expect(localEngine.engine).toBe(mockEngine);

    await advanceAndFlush(60000);

    expect(mockEngine.unload).toHaveBeenCalled();
    expect(localEngine.engine).toBeNull();
    expect(localEngine.loadedModel).toBeNull();
  });

  it('sets status to cached after idle unload', async () => {
    const mockEngine = { unload: vi.fn().mockResolvedValue(undefined) };
    (CreateMLCEngine as Mock).mockResolvedValue(mockEngine);

    await localEngine.initialize('TestModel-MLC');

    await advanceAndFlush(60000);

    const statuses = (storageData.localModelStatuses || {}) as Record<string, Record<string, unknown>>;
    expect(statuses['TestModel-MLC']?.state).toBe('cached');
  });

  it('_resetIdleTimeout delays the unload', async () => {
    const mockEngine = { unload: vi.fn().mockResolvedValue(undefined) };
    (CreateMLCEngine as Mock).mockResolvedValue(mockEngine);

    await localEngine.initialize('TestModel-MLC');

    // Advance 50s (not yet at 60s threshold)
    await advanceAndFlush(50000);
    expect(localEngine.engine).toBe(mockEngine);

    // Reset the timer (simulates an inference request)
    localEngine._resetIdleTimeout();

    // Advance another 50s (100s total, but only 50s since reset)
    await advanceAndFlush(50000);
    expect(localEngine.engine).toBe(mockEngine);

    // Advance 10 more seconds (60s since last reset)
    await advanceAndFlush(10000);

    expect(mockEngine.unload).toHaveBeenCalled();
    expect(localEngine.engine).toBeNull();
  });

  it('explicit reset clears idle timer and prevents double-unload', async () => {
    const mockEngine = { unload: vi.fn().mockResolvedValue(undefined) };
    (CreateMLCEngine as Mock).mockResolvedValue(mockEngine);

    await localEngine.initialize('TestModel-MLC');

    // Explicitly reset state (which calls _stopIdleTimeout internally)
    await localEngine.reset();
    expect(mockEngine.unload).toHaveBeenCalledTimes(1);

    // Advance past what would have been the idle timeout
    await advanceAndFlush(60000);

    // Should not have been called again by the idle timer
    expect(mockEngine.unload).toHaveBeenCalledTimes(1);
  });
});

// ==================== localEngine.initialize (model switch) ====================

describe('localEngine.initialize model switch', () => {
  let storageData: Record<string, unknown>;

  beforeEach(async () => {
    (CreateMLCEngine as Mock).mockReset();
    (hasModelInCache as Mock).mockReset();
    modelsState.PREDEFINED_MODELS = {
      local: [
        { name: 'ModelA-MLC', display: 'Model A' },
        { name: 'ModelB-MLC', display: 'Model B' },
      ],
    };

    await localEngine.reset();

    storageData = {};
    globalThis.chrome = {
      storage: {
        local: {
          get: vi.fn(async () => storageData),
          set: vi.fn(async (data: Record<string, unknown>) => { Object.assign(storageData, data); }),
        } as unknown as chrome.storage.LocalStorageArea,
      },
    } as unknown as typeof chrome;

    Object.defineProperty(globalThis, 'navigator', {
      value: { gpu: {} },
      writable: true,
      configurable: true,
    });
  });

  it('concurrent init calls for new model do not reject each other via drain race', async () => {
    // Model A is loaded and "running inference" (in-flight task in the queue)
    const oldEngine = { unload: vi.fn(async () => {}), chat: { completions: { create: vi.fn() } } };
    localEngine.engine = oldEngine as unknown as typeof localEngine.engine;
    localEngine.loadedModel = 'ModelA-MLC';

    // CreateMLCEngine for model B — use a deferred promise so we control when it resolves
    const newEngine = { unload: vi.fn(async () => {}), chat: { completions: { create: vi.fn() } } };
    (CreateMLCEngine as Mock).mockImplementation(() => new Promise(resolve => {
      // Resolve on next tick to simulate async engine creation
      setTimeout(() => resolve(newEngine), 10);
    }));

    // Two concurrent localEngine.initialize calls for the new model,
    // simulating two processBatch → callLocalInference → initialize calls.
    // Before the fix, both would enter the drain path and the second drain would
    // clear the first's queued task, causing "Inference queue cleared" rejection.
    const [engine1, engine2] = await Promise.all([
      localEngine.initialize('ModelB-MLC'),
      localEngine.initialize('ModelB-MLC'),
    ]);

    // Both should resolve to the same engine — no "Inference queue cleared" error
    expect(engine1).toBe(newEngine);
    expect(engine2).toBe(newEngine);

    // Old engine should have been unloaded exactly once
    expect(oldEngine.unload).toHaveBeenCalledTimes(1);
  });
});

// ==================== parseLocalModelResponse ====================

describe('parseLocalModelResponse', () => {
  it('returns SHOW with empty-response reasoning for empty string', () => {
    const result = parseLocalModelResponse('');
    expect(result.shouldHide).toBe(false);
    expect(result.reasoning).toMatch(/empty model response/i);
  });

  it('returns SHOW with empty-response reasoning for null', () => {
    const result = parseLocalModelResponse(null);
    expect(result.shouldHide).toBe(false);
    expect(result.reasoning).toMatch(/empty model response/i);
  });

  it('returns SHOW when response contains "No match"', () => {
    const result = parseLocalModelResponse('Post about cooking dinner at home. No match.');
    expect(result.shouldHide).toBe(false);
    expect(result.reasoning).toBe('Post about cooking dinner at home. No match.');
  });

  it('returns HIDE when response contains "Matches <topic>"', () => {
    const result = parseLocalModelResponse('Post about NBA basketball game results. Matches sports.');
    expect(result.shouldHide).toBe(true);
    expect(result.reasoning).toContain('(Matched: sports)');
  });

  it('uses last occurrence when both "no match" and "matches" are present', () => {
    // "Matches" after "no match" → HIDE (last-wins)
    const hide = parseLocalModelResponse('Not a no match situation. Matches politics.');
    expect(hide.shouldHide).toBe(true);

    // "No match" after "matches" → SHOW (last-wins)
    const show = parseLocalModelResponse('This matches nothing relevant. No match.');
    expect(show.shouldHide).toBe(false);
  });

  it('returns SHOW when neither pattern is present', () => {
    const result = parseLocalModelResponse('Post about cooking dinner at home.');
    expect(result.shouldHide).toBe(false);
    expect(result.reasoning).toBe('Post about cooking dinner at home.');
  });

  it('is case-insensitive', () => {
    const upper = parseLocalModelResponse('Post about sports. MATCHES sports.');
    expect(upper.shouldHide).toBe(true);

    const mixed = parseLocalModelResponse('Post about food. No Match.');
    expect(mixed.shouldHide).toBe(false);
  });

  it('extracts the matched topic from after "Matches "', () => {
    const result = parseLocalModelResponse('Political content about elections. Matches politics.');
    expect(result.reasoning).toContain('(Matched: politics)');
  });

  it('strips trailing period from matched topic', () => {
    const result = parseLocalModelResponse('Sports content. Matches sports.');
    expect(result.reasoning).toContain('(Matched: sports)');
    expect(result.reasoning).not.toContain('(Matched: sports.)');
  });
});

// ==================== LocalEngine.generate / preempt / ensureLoaded / teardown ====================

describe('LocalEngine generate + preempt + lifecycle', () => {
  let storageData: Record<string, unknown>;
  let mockEngine: ReturnType<typeof makeMockEngine>;

  function makeMockEngine(createResponse = 'No match.') {
    return {
      resetChat: vi.fn().mockResolvedValue(undefined),
      interruptGenerate: vi.fn().mockResolvedValue(undefined),
      interruptSignal: false,
      unload: vi.fn().mockResolvedValue(undefined),
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue({
            choices: [{ message: { content: createResponse } }],
          }),
        },
      },
    };
  }

  beforeEach(async () => {
    (CreateMLCEngine as Mock).mockReset();
    (hasModelInCache as Mock).mockReset();
    (isGPUDeviceLostError as Mock).mockReturnValue(false);

    modelsState.PREDEFINED_MODELS = {
      local: [{ name: 'TestModel-MLC', display: 'Test' }],
    };

    mockEngine = makeMockEngine();

    // Reset localEngine and inference queue to clean state
    await localEngine.reset();
    inferenceQueue.reset();

    // Set localEngine to a "loaded" state with the mock engine
    localEngine.engine = mockEngine as unknown as typeof localEngine.engine;
    localEngine.loadedModel = 'TestModel-MLC';
    localEngine._modelConfig = { name: 'TestModel-MLC', display: 'Test' } as LocalModelDef;

    storageData = {};
    globalThis.chrome = {
      storage: {
        local: {
          get: vi.fn(async () => storageData),
          set: vi.fn(async (data: Record<string, unknown>) => { Object.assign(storageData, data); }),
        } as unknown as chrome.storage.LocalStorageArea,
      },
    } as unknown as typeof chrome;

    Object.defineProperty(globalThis, 'navigator', {
      value: { gpu: {} },
      writable: true,
      configurable: true,
    });
  });

  afterEach(async () => {
    await localEngine.reset();
    inferenceQueue.reset();
  });

  // ---- generate() basic behavior ----

  it('calls resetChat before inference and returns stripped response', async () => {
    const result = await localEngine.generate(
      [{ role: 'user', content: 'hello' }], 40
    );
    expect(mockEngine.resetChat).toHaveBeenCalled();
    expect(mockEngine.chat.completions.create).toHaveBeenCalled();
    expect(result).toBe('No match.');
  });

  it('strips <think> blocks from response', async () => {
    mockEngine.chat.completions.create.mockResolvedValue({
      choices: [{ message: { content: '<think>reasoning here</think>No match.' } }],
    });
    const result = await localEngine.generate(
      [{ role: 'user', content: 'test' }], 40
    );
    expect(result).toBe('No match.');
  });

  it('passes temperature override through to engine request', async () => {
    await localEngine.generate(
      [{ role: 'user', content: 'test' }], 40, { temperature: 0.7 }
    );
    const request = mockEngine.chat.completions.create.mock.calls[0][0];
    expect(request.temperature).toBe(0.7);
  });

  it('fires onStart callback when task begins executing, not when enqueued', async () => {
    const order: string[] = [];
    let resolveFirst!: (value: unknown) => void;

    // Block the queue with a first generate
    mockEngine.chat.completions.create
      .mockImplementationOnce(() => new Promise(resolve => {
        resolveFirst = resolve;
      }))
      .mockResolvedValueOnce({
        choices: [{ message: { content: 'second' } }],
      });

    const first = localEngine.generate(
      [{ role: 'user', content: 'first' }], 40,
      { onStart: () => order.push('onStart-1') }
    );
    // Let the first task start executing
    await new Promise(r => setTimeout(r, 0));

    const second = localEngine.generate(
      [{ role: 'user', content: 'second' }], 40,
      { onStart: () => order.push('onStart-2') }
    );

    // First onStart should have fired, second should not yet
    expect(order).toEqual(['onStart-1']);

    // Resolve first, let second start
    resolveFirst({ choices: [{ message: { content: 'first' } }] });
    await first;
    await second;

    expect(order).toEqual(['onStart-1', 'onStart-2']);
  });

  // ---- preempt() during generate() ----

  it('preempt rejects in-flight generate with "Inference preempted"', async () => {
    // Make the engine completion hang until preempted
    mockEngine.chat.completions.create.mockImplementation(
      () => new Promise((_, reject) => {
        // Simulate engine rejecting after interrupt
        setTimeout(() => reject(new Error('AbortError')), 20);
      })
    );

    const genPromise = localEngine.generate(
      [{ role: 'user', content: 'test' }], 40
    );
    await new Promise(r => setTimeout(r, 0));

    localEngine.preempt();

    await expect(genPromise).rejects.toThrow('Inference preempted');
    expect(mockEngine.interruptGenerate).toHaveBeenCalled();
  });

  it('preempt is idempotent — second call does not re-call interruptGenerate', async () => {
    mockEngine.chat.completions.create.mockImplementation(
      () => new Promise((_, reject) => {
        setTimeout(() => reject(new Error('AbortError')), 20);
      })
    );

    const genPromise = localEngine.generate(
      [{ role: 'user', content: 'test' }], 40
    );
    await new Promise(r => setTimeout(r, 0));

    localEngine.preempt();
    localEngine.preempt();

    await genPromise.catch(() => {});
    expect(mockEngine.interruptGenerate).toHaveBeenCalledTimes(1);
  });

  // ---- preempt + next generate interaction ----

  it('generate after preempt waits for interruptGenerate to settle and clears stale interruptSignal', async () => {
    let resolveInterrupt!: (value?: unknown) => void;
    mockEngine.interruptGenerate.mockImplementation(
      () => new Promise(resolve => { resolveInterrupt = resolve; })
    );

    // First generate hangs, then gets preempted
    mockEngine.chat.completions.create
      .mockImplementationOnce(() => new Promise((_, reject) => {
        setTimeout(() => reject(new Error('AbortError')), 10);
      }))
      .mockResolvedValueOnce({
        choices: [{ message: { content: 'after preempt' } }],
      });

    const first = localEngine.generate(
      [{ role: 'user', content: 'first' }], 40
    );
    await new Promise(r => setTimeout(r, 0));

    localEngine.preempt();
    // Simulate stale interruptSignal left on engine
    mockEngine.interruptSignal = true;

    // Queue a second generate
    const onStart2 = vi.fn();
    const second = localEngine.generate(
      [{ role: 'user', content: 'second' }], 40,
      { onStart: onStart2 }
    );

    // First should reject
    await expect(first).rejects.toThrow('Inference preempted');

    // Second should be blocked waiting for interruptGenerate to settle
    await new Promise(r => setTimeout(r, 0));
    expect(onStart2).not.toHaveBeenCalled();

    // Resolve the interrupt
    resolveInterrupt();
    const result = await second;

    expect(result).toBe('after preempt');
    expect(onStart2).toHaveBeenCalled();
    // interruptSignal should have been cleared
    expect(mockEngine.interruptSignal).toBe(false);
  });

  // ---- generate + generate + preempt: second generate picks up ----

  it('preempting first generate allows queued second generate to execute with onStart', async () => {
    let rejectFirst!: (reason?: unknown) => void;
    mockEngine.chat.completions.create
      .mockImplementationOnce(() => new Promise((_resolve, reject) => {
        rejectFirst = reject;
      }))
      .mockResolvedValueOnce({
        choices: [{ message: { content: 'second result' } }],
      });

    const onStart1 = vi.fn();
    const onStart2 = vi.fn();

    const first = localEngine.generate(
      [{ role: 'user', content: 'first' }], 40,
      { onStart: onStart1 }
    );
    await new Promise(r => setTimeout(r, 0));
    expect(onStart1).toHaveBeenCalled();

    // Queue second while first is in-flight
    const second = localEngine.generate(
      [{ role: 'user', content: 'second' }], 40,
      { onStart: onStart2 }
    );
    expect(onStart2).not.toHaveBeenCalled();

    // Preempt first
    localEngine.preempt();
    rejectFirst(new Error('AbortError'));

    await expect(first).rejects.toThrow('Inference preempted');

    // Second should complete
    const result = await second;
    expect(result).toBe('second result');
    expect(onStart2).toHaveBeenCalled();
  });

  // ---- ensureLoaded + generate ----

  it('ensureLoaded initializes engine if not loaded, then generate works', async () => {
    // Start with no engine
    localEngine.engine = null;
    localEngine.loadedModel = null;

    const freshEngine = makeMockEngine('Matches politics.');
    (CreateMLCEngine as Mock).mockResolvedValue(freshEngine);
    (hasModelInCache as Mock).mockResolvedValue(false);

    await localEngine.ensureLoaded('TestModel-MLC');
    expect(localEngine.engine).toBe(freshEngine);

    const result = await localEngine.generate(
      [{ role: 'user', content: 'test' }], 40
    );
    expect(result).toBe('Matches politics.');
    expect(freshEngine.resetChat).toHaveBeenCalled();
  });

  it('ensureLoaded is a no-op when model is already loaded', async () => {
    await localEngine.ensureLoaded('TestModel-MLC');
    // Should not have called CreateMLCEngine since engine is already set
    expect(CreateMLCEngine).not.toHaveBeenCalled();
  });

  it('ensureLoaded throws when engine cannot be created', async () => {
    localEngine.engine = null;
    localEngine.loadedModel = null;

    // Remove WebGPU support
    Object.defineProperty(globalThis, 'navigator', {
      value: { gpu: null },
      writable: true,
      configurable: true,
    });

    await expect(localEngine.ensureLoaded('TestModel-MLC'))
      .rejects.toThrow('Local model not available');
  });

  // ---- teardown ----

  it('teardown nulls engine synchronously and stops timers', () => {
    // Start keepalive and idle timeout
    localEngine._startKeepAlive();
    localEngine._resetIdleTimeout();
    expect(localEngine._keepAliveInterval).not.toBeNull();
    expect(localEngine._idleTimeoutId).not.toBeNull();

    localEngine.teardown();

    expect(localEngine.engine).toBeNull();
    expect(localEngine.loadedModel).toBeNull();
    expect(localEngine._modelConfig).toBeNull();
    expect(localEngine._keepAliveInterval).toBeNull();
    expect(localEngine._idleTimeoutId).toBeNull();
  });

  it('generate fails after teardown because engine is null', async () => {
    localEngine.teardown();

    await expect(
      localEngine.generate([{ role: 'user', content: 'test' }], 40)
    ).rejects.toThrow();
  });

  // ---- generate resets idle timeout ----

  it('successful generate resets idle timeout', async () => {
    vi.useFakeTimers();
    try {
      localEngine._resetIdleTimeout();
      const originalTimeoutId = localEngine._idleTimeoutId;

      await localEngine.generate(
        [{ role: 'user', content: 'test' }], 40
      );

      // Timeout should have been reset (new timer ID)
      expect(localEngine._idleTimeoutId).not.toBe(originalTimeoutId);
      expect(localEngine._idleTimeoutId).not.toBeNull();
    } finally {
      localEngine._stopIdleTimeout();
      vi.useRealTimers();
    }
  });

  // ---- GPU device lost during generate ----

  it('generate resets engine and updates status on GPU device lost error', async () => {
    (isGPUDeviceLostError as Mock).mockReturnValue(true);
    mockEngine.chat.completions.create.mockRejectedValue(
      new Error('GPU device was lost')
    );

    await expect(
      localEngine.generate([{ role: 'user', content: 'test' }], 40)
    ).rejects.toThrow('GPU device was lost');

    expect(localEngine.engine).toBeNull();
    const statuses = (storageData.localModelStatuses || {}) as Record<string, Record<string, unknown>>;
    expect(statuses['TestModel-MLC']?.state).toBe('error');
    expect(statuses['TestModel-MLC']?.error).toMatch(/GPU memory/);
  });
});
