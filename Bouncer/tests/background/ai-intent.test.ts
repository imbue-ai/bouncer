import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';

// DEFAULT_MODEL and the probe gate read this at module-import time, so it must
// be set before ai-intent.js (→ shared/models.js) is imported below.
process.env.HAS_IMBUE_BACKEND = 'true';

// Mock providers so no WebSocket machinery (or Firebase auth) is pulled in.
vi.mock('../../src/background/providers.js', () => ({
  callImbueAPI: vi.fn(),
}));

const {
  applyValidatePhraseVerdict, recordValidatePhraseVerdict,
  recordFilterPostAiPhrases, refreshAiFilterIntent, pruneAiFilterPhrases,
  phraseSetKey,
} = await import('../../src/background/ai-intent.js');
const { callImbueAPI } = await import('../../src/background/providers.js');
const { aiIntentAutoActive } = await import('../../src/shared/storage.js');
type AiFilterIntentState = import('../../src/types.js').AiFilterIntentState;

const mockCallImbueAPI = callImbueAPI as unknown as Mock;

// In-memory chrome.storage.local so persistence round-trips.
let store: Record<string, unknown> = {};

beforeEach(() => {
  store = {};
  (chrome.storage.local.get as Mock).mockImplementation((keys: string[]) => {
    const out: Record<string, unknown> = {};
    for (const k of keys) if (k in store) out[k] = store[k];
    return Promise.resolve(out);
  });
  (chrome.storage.local.set as Mock).mockImplementation((items: Record<string, unknown>) => {
    Object.assign(store, items);
    return Promise.resolve();
  });
  mockCallImbueAPI.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

const state = () => store.aiFilterIntent as AiFilterIntentState;
const setWriteCount = () => (chrome.storage.local.set as Mock).mock.calls.length;

// Drain the microtask queue so fire-and-forget async chains (the leading-edge
// refresh) settle without advancing timers. All mocks resolve as microtasks.
const flushMicrotasks = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

const filterResponse = (aiFilterPhrases: string[] | null | undefined) => ({
  shouldHide: false, reasoning: null, category: null,
  rawResponse: '', processingTime: 1, jobId: 'j1',
  ...(aiFilterPhrases !== undefined && { aiFilterPhrases }),
});

describe('phraseSetKey', () => {
  it('is insensitive to order, casing, whitespace, and duplicates', () => {
    expect(phraseSetKey(['AI slop', 'politics'])).toBe(phraseSetKey(['politics ', 'ai slop', 'AI SLOP']));
  });

  it('distinguishes different sets', () => {
    expect(phraseSetKey(['ai slop'])).not.toBe(phraseSetKey(['ai slop', 'politics']));
  });
});

describe('applyValidatePhraseVerdict', () => {
  const union = ['AI slop', 'politics', 'crypto'];

  it('stores the returned phrases verbatim with the judged-set key', () => {
    const r = applyValidatePhraseVerdict(union, ['AI slop'], 99);
    expect(r).toEqual({ aiPhrases: ['AI slop'], judgedSetKey: phraseSetKey(union), updatedAt: 99 });
  });

  it('an empty verdict clears the phrases but still marks the set judged', () => {
    const r = applyValidatePhraseVerdict(union, [], 99);
    expect(r.aiPhrases).toEqual([]);
    expect(r.judgedSetKey).toBe(phraseSetKey(union));
  });

  it('defensively drops returned phrases outside the judged set', () => {
    const r = applyValidatePhraseVerdict(union, ['AI slop', 'not a real phrase'], 99);
    expect(r.aiPhrases).toEqual(['AI slop']);
  });

  it('dedupes by normalized identity and drops blanks', () => {
    const r = applyValidatePhraseVerdict(union, ['AI slop', ' ai slop ', '  '], 99);
    expect(r.aiPhrases).toEqual(['AI slop']);
  });
});

describe('recordValidatePhraseVerdict', () => {
  const union = ['ai slop', 'politics'];

  it('does not write storage for null or undefined verdicts', async () => {
    await recordValidatePhraseVerdict(union, null);
    await recordValidatePhraseVerdict(union, undefined);
    expect(state()).toBeUndefined();
  });

  it('persists the verdict and engages aiIntentAutoActive', async () => {
    await recordValidatePhraseVerdict(union, ['ai slop']);
    expect(state().aiPhrases).toEqual(['ai slop']);
    expect(aiIntentAutoActive({ aiFilterIntent: state() })).toBe(true);
  });

  it('skips the write when neither the phrase set nor the judged-set key changed', async () => {
    await recordValidatePhraseVerdict(union, ['ai slop']);
    const before = setWriteCount();
    await recordValidatePhraseVerdict(union, ['AI SLOP ']); // same set, normalized
    expect(setWriteCount()).toBe(before);
  });

  it('writes when only the judged-set key changed (new union, same verdict)', async () => {
    await recordValidatePhraseVerdict(union, ['ai slop']);
    const before = setWriteCount();
    await recordValidatePhraseVerdict([...union, 'crypto'], ['ai slop']);
    expect(setWriteCount()).toBe(before + 1);
    expect(state().judgedSetKey).toBe(phraseSetKey([...union, 'crypto']));
  });
});

describe('recordFilterPostAiPhrases', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    store.selectedModel = 'imbue';
    store.descriptions_twitter = ['AI slop', 'politics'];
  });

  it('the first flagged response turns AI detection on immediately — before any probe', async () => {
    mockCallImbueAPI.mockResolvedValue(filterResponse(['AI slop']));
    await recordFilterPostAiPhrases(['AI slop']);
    // On, right now — no debounce, no probe round trip.
    expect(state().aiPhrases).toEqual(['AI slop']);
    expect(aiIntentAutoActive({ aiFilterIntent: state() })).toBe(true);
    // The authoritative probe follows (leading edge) and confirms.
    await flushMicrotasks();
    expect(mockCallImbueAPI).toHaveBeenCalledTimes(1);
    expect(state().judgedSetKey).toBe(phraseSetKey(['AI slop', 'politics']));
  });

  it('ignores noise on an already-judged union (no ping-pong)', async () => {
    // Probe judged the full set: "AI hype" is NOT an AI-removal request.
    store.descriptions_twitter = ['AI hype', 'politics'];
    await recordValidatePhraseVerdict(['AI hype', 'politics'], []);
    const before = setWriteCount();

    await recordFilterPostAiPhrases(['AI hype']); // temp-1.0 noise
    expect(setWriteCount()).toBe(before);
    expect(state().aiPhrases).toEqual([]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(mockCallImbueAPI).not.toHaveBeenCalled();
  });

  it('already-known phrases, empty lists, null, and deleted phrases are no-ops', async () => {
    await recordValidatePhraseVerdict(['AI slop', 'politics'], ['AI slop']);
    const before = setWriteCount();
    await recordFilterPostAiPhrases(['AI slop']);   // already known
    await recordFilterPostAiPhrases([]);
    await recordFilterPostAiPhrases(null);
    await recordFilterPostAiPhrases(['midjourney']); // stale — phrase no longer exists
    expect(setWriteCount()).toBe(before);
    await vi.advanceTimersByTimeAsync(5000);
    expect(mockCallImbueAPI).not.toHaveBeenCalled();
  });
});

describe('pruneAiFilterPhrases', () => {
  it('turns detection off instantly when all triggering phrases are gone, without a backend call', async () => {
    await recordValidatePhraseVerdict(['AI slop', 'politics'], ['AI slop']);
    expect(aiIntentAutoActive({ aiFilterIntent: state() })).toBe(true);

    store.descriptions_twitter = ['politics']; // "AI slop" deleted
    await pruneAiFilterPhrases();

    expect(mockCallImbueAPI).not.toHaveBeenCalled();
    expect(state().aiPhrases).toEqual([]);
    expect(aiIntentAutoActive({ aiFilterIntent: state() })).toBe(false);
  });

  it('keeps surviving AI phrases and does not write when nothing was deleted', async () => {
    store.descriptions_twitter = ['AI slop', 'politics'];
    await recordValidatePhraseVerdict(['AI slop', 'politics'], ['AI slop']);
    const before = setWriteCount();
    await pruneAiFilterPhrases();
    expect(setWriteCount()).toBe(before);
    expect(state().aiPhrases).toEqual(['AI slop']);
  });

  it('delete then re-add re-activates: pruning clears judgedSetKey so the set is re-judged', async () => {
    store.selectedModel = 'imbue';
    store.descriptions_twitter = ['AI slop'];
    mockCallImbueAPI.mockResolvedValue(filterResponse(['AI slop']));
    await refreshAiFilterIntent();
    expect(state().aiPhrases).toEqual(['AI slop']);

    // Delete: instant off, and the stale judgment must go with it.
    store.descriptions_twitter = [];
    await pruneAiFilterPhrases();
    expect(state().aiPhrases).toEqual([]);
    expect(state().judgedSetKey).toBeNull();

    // Re-add the same phrase: the same set key must NOT be treated as
    // already judged (this was a real bug — detection never came back).
    store.descriptions_twitter = ['AI slop'];
    await refreshAiFilterIntent();
    expect(mockCallImbueAPI).toHaveBeenCalledTimes(2);
    expect(state().aiPhrases).toEqual(['AI slop']);
    expect(aiIntentAutoActive({ aiFilterIntent: state() })).toBe(true);
  });
});

describe('refreshAiFilterIntent', () => {
  it('clears state deterministically when no phrases exist, without a backend call', async () => {
    await recordValidatePhraseVerdict(['ai slop'], ['ai slop']);
    await refreshAiFilterIntent();
    expect(mockCallImbueAPI).not.toHaveBeenCalled();
    expect(state().aiPhrases).toEqual([]);
    expect(aiIntentAutoActive({ aiFilterIntent: state() })).toBe(false);
  });

  it('probes with the current phrases via validatePhrase and applies the verdict', async () => {
    store.descriptions_twitter = ['ai slop', 'politics'];
    store.selectedModel = 'imbue';
    mockCallImbueAPI.mockResolvedValue(filterResponse(['ai slop']));

    await refreshAiFilterIntent();

    expect(mockCallImbueAPI).toHaveBeenCalledTimes(1);
    const [, categories, reason] = mockCallImbueAPI.mock.calls[0] as [unknown, string[], string];
    expect(reason).toBe('validatePhrase');
    expect([...categories].sort()).toEqual(['ai slop', 'politics']);
    expect(state().aiPhrases).toEqual(['ai slop']);
    expect(state().judgedSetKey).toBe(phraseSetKey(['ai slop', 'politics']));
  });

  it('never re-probes a set that was already judged', async () => {
    store.descriptions_twitter = ['ai slop'];
    store.selectedModel = 'imbue';
    mockCallImbueAPI.mockResolvedValue(filterResponse(['ai slop']));

    await refreshAiFilterIntent();
    await refreshAiFilterIntent();
    expect(mockCallImbueAPI).toHaveBeenCalledTimes(1);
  });

  it('does not double-probe when a second refresh starts while the probe is in flight', async () => {
    store.descriptions_twitter = ['ai slop'];
    store.selectedModel = 'imbue';
    let resolveProbe!: (v: unknown) => void;
    mockCallImbueAPI.mockImplementation(() => new Promise(r => { resolveProbe = r; }));

    const first = refreshAiFilterIntent();
    const second = refreshAiFilterIntent(); // reaches the in-flight guard and returns
    await second;
    resolveProbe(filterResponse(['ai slop']));
    await first;

    expect(mockCallImbueAPI).toHaveBeenCalledTimes(1);
    expect(state().aiPhrases).toEqual(['ai slop']);
  });

  it('prunes deleted phrases locally, even when probing is gated (non-Imbue model)', async () => {
    await recordValidatePhraseVerdict(['ai slop', 'politics'], ['ai slop']);
    store.descriptions_twitter = ['politics']; // "ai slop" deleted
    store.selectedModel = 'openai:gpt-5';

    await refreshAiFilterIntent();

    expect(mockCallImbueAPI).not.toHaveBeenCalled();
    expect(state().aiPhrases).toEqual([]);
  });

  it('does not probe when a non-Imbue model is selected', async () => {
    store.descriptions_twitter = ['ai slop'];
    store.selectedModel = 'openai:gpt-5';
    await refreshAiFilterIntent();
    expect(mockCallImbueAPI).not.toHaveBeenCalled();
  });

  it('leaves state and judged-set key unchanged when the probe response omits the field (old worker)', async () => {
    await recordValidatePhraseVerdict(['ai slop'], ['ai slop']);
    const judgedBefore = state().judgedSetKey;
    store.descriptions_twitter = ['ai slop', 'politics'];
    store.selectedModel = 'imbue';
    mockCallImbueAPI.mockResolvedValue(filterResponse(undefined));

    await refreshAiFilterIntent();
    expect(state().aiPhrases).toEqual(['ai slop']);
    // judgedSetKey stays stale on purpose so the next trigger retries.
    expect(state().judgedSetKey).toBe(judgedBefore);
  });

  it('survives a probe failure without touching state, then retries on the next call', async () => {
    await recordValidatePhraseVerdict(['ai slop'], ['ai slop']);
    store.descriptions_twitter = ['ai slop', 'politics'];
    store.selectedModel = 'imbue';
    mockCallImbueAPI.mockRejectedValueOnce(new Error('socket closed'));

    await expect(refreshAiFilterIntent()).resolves.toBeUndefined();
    expect(state().aiPhrases).toEqual(['ai slop']);

    mockCallImbueAPI.mockResolvedValue(filterResponse(['ai slop', 'politics']));
    await refreshAiFilterIntent();
    expect(mockCallImbueAPI).toHaveBeenCalledTimes(2);
    expect(state().aiPhrases).toEqual(['ai slop', 'politics']);
  });

  it('treats pre-migration state (boolean latch, no aiPhrases) as empty', async () => {
    store.aiFilterIntent = { intent: true, phraseSetKey: 'ai slop', updatedAt: 1 };
    expect(aiIntentAutoActive({ aiFilterIntent: store.aiFilterIntent as AiFilterIntentState })).toBe(false);

    store.descriptions_twitter = ['ai slop'];
    store.selectedModel = 'imbue';
    mockCallImbueAPI.mockResolvedValue(filterResponse(['ai slop']));

    await refreshAiFilterIntent();
    expect(state().aiPhrases).toEqual(['ai slop']);
    expect(aiIntentAutoActive({ aiFilterIntent: state() })).toBe(true);
  });
});
