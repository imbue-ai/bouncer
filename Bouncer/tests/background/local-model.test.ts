import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Each test that exercises localEngine.initialize() needs its own controllable
// LocalBackend instance. The mock factory below pulls from this slot — set it
// in beforeEach (or just before triggering an init) so the next
// `new LitertlmBackend()` returns the configured fake.
type FakeBackend = {
  initialize: ReturnType<typeof vi.fn>;
  unload: ReturnType<typeof vi.fn>;
  generate: ReturnType<typeof vi.fn>;
  interrupt: ReturnType<typeof vi.fn>;
  countTokens: ReturnType<typeof vi.fn>;
  truncateText: ReturnType<typeof vi.fn>;
  getImageEmbedSize: ReturnType<typeof vi.fn>;
};

function makeFakeBackend(): FakeBackend {
  return {
    initialize: vi.fn().mockResolvedValue(undefined),
    unload: vi.fn().mockResolvedValue(undefined),
    generate: vi.fn().mockResolvedValue(''),
    interrupt: vi.fn().mockResolvedValue(undefined),
    countTokens: vi.fn().mockResolvedValue(0),
    truncateText: vi.fn().mockImplementation((t: string) => Promise.resolve(t)),
    getImageEmbedSize: vi.fn().mockResolvedValue(0),
  };
}

let nextFakeBackend: FakeBackend | null = null;
let isLitertlmCachedReturn = false;

vi.mock('../../src/background/backends/litertlm-backend.js', () => ({
  LitertlmBackend: vi.fn(function () {
    const fb = nextFakeBackend ?? makeFakeBackend();
    nextFakeBackend = null;
    return fb;
  }),
  isLitertlmCached: vi.fn(async () => isLitertlmCachedReturn),
}));

// Holder so individual tests can override PREDEFINED_MODELS.
const modelsState: { PREDEFINED_MODELS: { local: Record<string, unknown>[] } } = {
  PREDEFINED_MODELS: { local: [] },
};

vi.mock('../../src/shared/models.js', () => ({
  get PREDEFINED_MODELS() { return modelsState.PREDEFINED_MODELS; },
}));

vi.mock('../../src/shared/utils.js', () => ({
  isGPUDeviceLostError: vi.fn(() => false),
  isNetworkError: vi.fn(() => false),
  formatLocalInferenceResult: vi.fn(),
}));

import { localEngine, parseTableYesnoResponse } from '../../src/background/local-model.js';
import { InferenceQueue, inferenceQueue } from '../../src/background/inference-queue.js';
import { isGPUDeviceLostError } from '../../src/shared/utils.js';
import type { Mock } from 'vitest';
import type { LocalBackend } from '../../src/background/backends/types.js';
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

// ==================== localEngine.cancelDownload ====================

describe('localEngine.cancelDownload', () => {
  let storageData: Record<string, unknown>;

  beforeEach(async () => {
    nextFakeBackend = null;
    isLitertlmCachedReturn = false;
    modelsState.PREDEFINED_MODELS = {
      local: [{ name: 'TestModel', display: 'Test', backend: 'litertlm' }],
    };

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
    const result = await localEngine.cancelDownload('TestModel');
    expect(result).toBe(false);
  });

  it('aborts an in-progress download and resets state', async () => {
    isLitertlmCachedReturn = false;

    // Make the backend's initialize hang so the download stays in flight
    const fb = makeFakeBackend();
    fb.initialize.mockImplementation(() => new Promise(() => {}));
    nextFakeBackend = fb;

    // Start init (don't await - it will hang because initialize never resolves)
    localEngine.initialize('TestModel');

    // Wait for init to start
    await new Promise(r => setTimeout(r, 10));

    expect(localEngine.isInitializing()).toBe(true);
    expect(localEngine.isInitializingModel('TestModel')).toBe(true);

    // Cancel it
    const cancelled = await localEngine.cancelDownload('TestModel');
    expect(cancelled).toBe(true);

    // State should be reset
    expect(localEngine.isInitializing()).toBe(false);
    expect(localEngine.engine).toBeNull();
    expect(localEngine.loadedModel).toBeNull();
  });

  it('sets status to not_downloaded when model is not cached', async () => {
    isLitertlmCachedReturn = false;

    const fb = makeFakeBackend();
    fb.initialize.mockImplementation(() => new Promise(() => {}));
    nextFakeBackend = fb;

    localEngine.initialize('TestModel');
    await new Promise(r => setTimeout(r, 10));

    await localEngine.cancelDownload('TestModel');

    // Check that status was set to not_downloaded
    const statuses = (storageData.localModelStatuses || {}) as Record<string, Record<string, unknown>>;
    expect(statuses['TestModel']?.state).toBe('not_downloaded');
  });

  it('sets status to cached when partial download exists in cache', async () => {
    isLitertlmCachedReturn = true;

    const fb = makeFakeBackend();
    fb.initialize.mockImplementation(() => new Promise(() => {}));
    nextFakeBackend = fb;

    localEngine.initialize('TestModel');
    await new Promise(r => setTimeout(r, 10));

    await localEngine.cancelDownload('TestModel');

    const statuses = (storageData.localModelStatuses || {}) as Record<string, Record<string, unknown>>;
    expect(statuses['TestModel']?.state).toBe('cached');
  });

  it('abort paths resolve initPromise when backend init completes after abort', async () => {
    isLitertlmCachedReturn = false;

    // Backend initialize resolves after abort fires — the post-completion
    // abort check must call _completeInit(null) so waiters on _initPromise
    // don't hang.
    const fb = makeFakeBackend();
    let resolveInit!: () => void;
    fb.initialize.mockImplementation(() => new Promise<void>(resolve => { resolveInit = resolve; }));
    nextFakeBackend = fb;

    const initPromise = localEngine.initialize('TestModel');
    await new Promise(r => setTimeout(r, 10));

    // A second caller starts waiting on _initPromise
    const waiterPromise = localEngine._initPromise;

    // Cancel via cancelDownload (which calls reset internally)
    await localEngine.cancelDownload('TestModel');

    // Now backend.initialize completes after abort
    resolveInit();
    await new Promise(r => setTimeout(r, 10));

    // Both promises should resolve to null (not hang)
    const [engine, waiterResult] = await Promise.all([
      Promise.race([initPromise, new Promise(r => setTimeout(() => r('TIMEOUT'), 100))]),
      Promise.race([waiterPromise ?? Promise.resolve(null), new Promise(r => setTimeout(() => r('TIMEOUT'), 100))]),
    ]);
    expect(engine).toBeNull();
    expect(waiterResult).toBeNull();
  });

  it('discards backend created after abort signal fires', async () => {
    isLitertlmCachedReturn = false;

    const fb = makeFakeBackend();
    let resolveInit!: () => void;
    fb.initialize.mockImplementation(() => new Promise<void>(resolve => { resolveInit = resolve; }));
    nextFakeBackend = fb;

    const initPromise = localEngine.initialize('TestModel');
    await new Promise(r => setTimeout(r, 10));

    // Cancel while backend.initialize is still pending
    await localEngine.cancelDownload('TestModel');

    // Now resolve backend.initialize after cancellation
    resolveInit();
    await new Promise(r => setTimeout(r, 10));

    const engine = await initPromise;
    expect(engine).toBeNull();
    // Backend should have been unloaded since it completed after abort
    expect(fb.unload).toHaveBeenCalled();
  });
});

// ==================== Idle timeout ====================

describe('idle timeout', () => {
  let storageData: Record<string, unknown>;
  let fb: FakeBackend;

  beforeEach(async () => {
    vi.useFakeTimers();
    nextFakeBackend = null;
    isLitertlmCachedReturn = false;
    modelsState.PREDEFINED_MODELS = {
      local: [{ name: 'TestModel', display: 'Test', backend: 'litertlm' }],
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

    fb = makeFakeBackend();
    nextFakeBackend = fb;
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
    await localEngine.initialize('TestModel');
    expect(localEngine.engine).toBe(fb as unknown as LocalBackend);

    await advanceAndFlush(60000);

    expect(fb.unload).toHaveBeenCalled();
    expect(localEngine.engine).toBeNull();
    expect(localEngine.loadedModel).toBeNull();
  });

  it('sets status to cached after idle unload', async () => {
    await localEngine.initialize('TestModel');

    await advanceAndFlush(60000);

    const statuses = (storageData.localModelStatuses || {}) as Record<string, Record<string, unknown>>;
    expect(statuses['TestModel']?.state).toBe('cached');
  });

  it('_resetIdleTimeout delays the unload', async () => {
    await localEngine.initialize('TestModel');

    // Advance 50s (not yet at 60s threshold)
    await advanceAndFlush(50000);
    expect(localEngine.engine).toBe(fb as unknown as LocalBackend);

    // Reset the timer (simulates an inference request)
    localEngine._resetIdleTimeout();

    // Advance another 50s (100s total, but only 50s since reset)
    await advanceAndFlush(50000);
    expect(localEngine.engine).toBe(fb as unknown as LocalBackend);

    // Advance 10 more seconds (60s since last reset)
    await advanceAndFlush(10000);

    expect(fb.unload).toHaveBeenCalled();
    expect(localEngine.engine).toBeNull();
  });

  it('explicit reset clears idle timer and prevents double-unload', async () => {
    await localEngine.initialize('TestModel');

    // Explicitly reset state (which calls _stopIdleTimeout internally)
    await localEngine.reset();
    expect(fb.unload).toHaveBeenCalledTimes(1);

    // Advance past what would have been the idle timeout
    await advanceAndFlush(60000);

    // Should not have been called again by the idle timer
    expect(fb.unload).toHaveBeenCalledTimes(1);
  });
});

// ==================== localEngine.initialize (model switch) ====================

describe('localEngine.initialize model switch', () => {
  let storageData: Record<string, unknown>;

  beforeEach(async () => {
    nextFakeBackend = null;
    isLitertlmCachedReturn = false;
    modelsState.PREDEFINED_MODELS = {
      local: [
        { name: 'ModelA', display: 'Model A', backend: 'litertlm' },
        { name: 'ModelB', display: 'Model B', backend: 'litertlm' },
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
    // Model A is loaded
    const oldBackend = makeFakeBackend();
    localEngine.engine = oldBackend as unknown as LocalBackend;
    localEngine.loadedModel = 'ModelA';

    // Init for model B uses a deferred promise so we control when it resolves
    const newBackend = makeFakeBackend();
    newBackend.initialize.mockImplementation(() => new Promise<void>(resolve => {
      // Resolve on next tick to simulate async engine creation
      setTimeout(() => resolve(), 10);
    }));
    nextFakeBackend = newBackend;

    // Two concurrent localEngine.initialize calls for the new model,
    // simulating two processBatch → callLocalInference → initialize calls.
    // Before the fix, both would enter the drain path and the second drain would
    // clear the first's queued task, causing "Inference queue cleared" rejection.
    const [engine1, engine2] = await Promise.all([
      localEngine.initialize('ModelB'),
      localEngine.initialize('ModelB'),
    ]);

    // Both should resolve to the same backend — no "Inference queue cleared" error.
    expect(engine1).not.toBeNull();
    expect(engine1).toBe(newBackend as unknown as LocalBackend);
    expect(engine2).toBe(engine1);

    // Old backend should have been unloaded exactly once
    expect(oldBackend.unload).toHaveBeenCalledTimes(1);
  });
});

// ==================== LocalEngine.generate / preempt / ensureLoaded / teardown ====================

describe('LocalEngine generate + preempt + lifecycle', () => {
  let storageData: Record<string, unknown>;
  let fb: FakeBackend;

  beforeEach(async () => {
    nextFakeBackend = null;
    isLitertlmCachedReturn = false;
    (isGPUDeviceLostError as Mock).mockReturnValue(false);

    modelsState.PREDEFINED_MODELS = {
      local: [{ name: 'TestModel', display: 'Test', backend: 'litertlm' }],
    };

    fb = makeFakeBackend();
    fb.generate.mockResolvedValue('No match.');

    // Reset localEngine and inference queue to clean state
    await localEngine.reset();
    inferenceQueue.reset();

    // Set localEngine to a "loaded" state with the fake backend
    localEngine.engine = fb as unknown as LocalBackend;
    localEngine.loadedModel = 'TestModel';
    localEngine._modelConfig = { name: 'TestModel', display: 'Test', backend: 'litertlm' } as LocalModelDef;

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

  it('delegates to backend.generate and returns its response', async () => {
    const result = await localEngine.generate(
      [{ role: 'user', content: 'hello' }], 40
    );
    expect(fb.generate).toHaveBeenCalled();
    expect(result).toBe('No match.');
  });

  it('passes temperature override through to backend.generate params', async () => {
    await localEngine.generate(
      [{ role: 'user', content: 'test' }], 40, { temperature: 0.7 }
    );
    const params = fb.generate.mock.calls[0][2] as Record<string, unknown>;
    expect(params.temperature).toBe(0.7);
  });

  it('fires onStart callback when task begins executing, not when enqueued', async () => {
    const order: string[] = [];
    let resolveFirst!: (value: unknown) => void;

    // Block the queue with a first generate
    fb.generate
      .mockImplementationOnce(() => new Promise(resolve => {
        resolveFirst = resolve;
      }))
      .mockResolvedValueOnce('second');

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
    resolveFirst('first');
    await first;
    await second;

    expect(order).toEqual(['onStart-1', 'onStart-2']);
  });

  // ---- preempt() during generate() ----

  it('preempt rejects in-flight generate with "Inference preempted"', async () => {
    // Make the backend generate hang until preempted
    fb.generate.mockImplementation(
      () => new Promise((_, reject) => {
        // Simulate backend rejecting after interrupt
        setTimeout(() => reject(new Error('AbortError')), 20);
      })
    );

    const genPromise = localEngine.generate(
      [{ role: 'user', content: 'test' }], 40
    );
    await new Promise(r => setTimeout(r, 0));

    localEngine.preempt();

    await expect(genPromise).rejects.toThrow('Inference preempted');
    expect(fb.interrupt).toHaveBeenCalled();
  });

  it('preempt is idempotent — second call does not re-call interrupt', async () => {
    fb.generate.mockImplementation(
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
    expect(fb.interrupt).toHaveBeenCalledTimes(1);
  });

  // ---- preempt + next generate interaction ----

  it('generate after preempt waits for interrupt to settle', async () => {
    let resolveInterrupt!: (value?: unknown) => void;
    fb.interrupt.mockImplementation(
      () => new Promise(resolve => { resolveInterrupt = resolve; })
    );

    // First generate hangs, then gets preempted
    fb.generate
      .mockImplementationOnce(() => new Promise((_, reject) => {
        setTimeout(() => reject(new Error('AbortError')), 10);
      }))
      .mockResolvedValueOnce('after preempt');

    const first = localEngine.generate(
      [{ role: 'user', content: 'first' }], 40
    );
    await new Promise(r => setTimeout(r, 0));

    localEngine.preempt();

    // Queue a second generate
    const onStart2 = vi.fn();
    const second = localEngine.generate(
      [{ role: 'user', content: 'second' }], 40,
      { onStart: onStart2 }
    );

    // First should reject
    await expect(first).rejects.toThrow('Inference preempted');

    // Second should be blocked waiting for interrupt to settle
    await new Promise(r => setTimeout(r, 0));
    expect(onStart2).not.toHaveBeenCalled();

    // Resolve the interrupt
    resolveInterrupt();
    const result = await second;

    expect(result).toBe('after preempt');
    expect(onStart2).toHaveBeenCalled();
  });

  // ---- generate + generate + preempt: second generate picks up ----

  it('preempting first generate allows queued second generate to execute with onStart', async () => {
    let rejectFirst!: (reason?: unknown) => void;
    fb.generate
      .mockImplementationOnce(() => new Promise((_resolve, reject) => {
        rejectFirst = reject;
      }))
      .mockResolvedValueOnce('second result');

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

    const freshBackend = makeFakeBackend();
    freshBackend.generate.mockResolvedValue('Matches politics.');
    nextFakeBackend = freshBackend;

    await localEngine.ensureLoaded('TestModel');
    expect(localEngine.engine).toBe(freshBackend as unknown as LocalBackend);

    const result = await localEngine.generate(
      [{ role: 'user', content: 'test' }], 40
    );
    expect(result).toBe('Matches politics.');
    expect(freshBackend.generate).toHaveBeenCalled();
  });

  it('ensureLoaded is a no-op when model is already loaded', async () => {
    // Track new-backend constructions to confirm none happen.
    const constructionsBefore = (await import('../../src/background/backends/litertlm-backend.js')).LitertlmBackend as unknown as Mock;
    constructionsBefore.mockClear();

    await localEngine.ensureLoaded('TestModel');
    expect(constructionsBefore).not.toHaveBeenCalled();
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

    await expect(localEngine.ensureLoaded('TestModel'))
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
    fb.generate.mockRejectedValue(new Error('GPU device was lost'));

    await expect(
      localEngine.generate([{ role: 'user', content: 'test' }], 40)
    ).rejects.toThrow('GPU device was lost');

    expect(localEngine.engine).toBeNull();
    const statuses = (storageData.localModelStatuses || {}) as Record<string, Record<string, unknown>>;
    expect(statuses['TestModel']?.state).toBe('error');
    expect(statuses['TestModel']?.error).toMatch(/GPU memory/);
  });
});

// ==================== parseTableYesnoResponse ====================

describe('parseTableYesnoResponse', () => {
  const cats = ['politics', 'sports', 'crypto'];

  it('parses canonical prompt-shaped row with leading `|`', () => {
    const r = parseTableYesnoResponse('| no | yes | no', cats);
    expect(r.matches).toEqual(['sports']);
    expect(r.shouldHide).toBe(true);
  });

  it('parses bare row without leading `|` (regression: was counting 2 instead of 3)', () => {
    const r = parseTableYesnoResponse('no|yes|yes', cats);
    expect(r.matches).toEqual(['sports', 'crypto']);
    expect(r.shouldHide).toBe(true);
  });

  it('tolerates trailing `|`', () => {
    const r = parseTableYesnoResponse('|no|yes|yes|', cats);
    expect(r.matches).toEqual(['sports', 'crypto']);
  });

  it('tolerates whitespace around verdicts', () => {
    const r = parseTableYesnoResponse('  no | yes | no  ', cats);
    expect(r.matches).toEqual(['sports']);
  });

  it('strips non-verdict preamble before the row', () => {
    const r = parseTableYesnoResponse('Verdict: | no | yes | no', cats);
    expect(r.matches).toEqual(['sports']);
  });

  it('returns malformed when verdict count is wrong', () => {
    const r = parseTableYesnoResponse('no|yes', cats);
    expect(r.shouldHide).toBe(false);
    expect(r.reasoning).toMatch(/expected 3 verdicts, got 2/);
    expect(r.matches).toEqual([]);
  });

  it('returns malformed when a cell is neither yes nor no', () => {
    const r = parseTableYesnoResponse('no|maybe|yes', cats);
    expect(r.shouldHide).toBe(false);
    expect(r.reasoning).toMatch(/verdict 1/);
  });

  it('returns show + empty matches when all verdicts are no', () => {
    const r = parseTableYesnoResponse('|no|no|no', cats);
    expect(r.shouldHide).toBe(false);
    expect(r.matches).toEqual([]);
  });

  it('returns empty-response message on null/empty input', () => {
    expect(parseTableYesnoResponse(null, cats).reasoning).toMatch(/Empty model response/);
    expect(parseTableYesnoResponse('', cats).reasoning).toMatch(/Empty model response/);
  });

  it('handles single-category bare verdict', () => {
    const r = parseTableYesnoResponse('yes', ['only']);
    expect(r.matches).toEqual(['only']);
  });
});

