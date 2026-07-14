import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';

// DEFAULT_MODEL and the probe gate read this at module-import time, so it must
// be set before ai-intent.js (→ shared/models.js) is imported below.
process.env.HAS_IMBUE_BACKEND = 'true';

// Mock providers so no WebSocket machinery (or Firebase auth) is pulled in.
vi.mock('../../src/background/providers.js', () => ({
  callImbueDetectAiIntent: vi.fn(),
}));
// Mock the local judges so no WKWebView bridge / WebGPU engine is pulled in.
vi.mock('../../src/background/ios-local-bridge.js', () => ({
  iosLocalJudgeAiIntent: vi.fn(),
}));
vi.mock('../../src/background/local-model.js', () => ({
  callLocalAiIntentJudgment: vi.fn(),
}));

const {
  applyAiIntentVerdict, recordAiIntentVerdict,
  refreshAiFilterIntent, pruneAiFilterPhrases,
  phraseSetKey, canJudgeAiIntent,
} = await import('../../src/background/ai-intent.js');
const { callImbueDetectAiIntent } = await import('../../src/background/providers.js');
const { iosLocalJudgeAiIntent } = await import('../../src/background/ios-local-bridge.js');
const { callLocalAiIntentJudgment } = await import('../../src/background/local-model.js');
const { aiIntentAutoActive } = await import('../../src/shared/storage.js');
type AiFilterIntentState = import('../../src/types.js').AiFilterIntentState;

const mockDetectAiIntent = callImbueDetectAiIntent as unknown as Mock;
const mockIosJudge = iosLocalJudgeAiIntent as unknown as Mock;
const mockLocalJudge = callLocalAiIntentJudgment as unknown as Mock;

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
  mockDetectAiIntent.mockReset();
  mockIosJudge.mockReset();
  mockLocalJudge.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

const state = () => store.aiFilterIntent as AiFilterIntentState;
const setWriteCount = () => (chrome.storage.local.set as Mock).mock.calls.length;

const intentResponse = (aiFilterPhrases: string[] | null | undefined) => ({
  reasoning: null, rawResponse: '', processingTime: 1, jobId: 'j1',
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

describe('canJudgeAiIntent', () => {
  // HAS_IMBUE_BACKEND is 'true' in this file (set before import above).
  it('imbue, desktop-local, and iOS on-device models can judge; BYOK cannot', () => {
    expect(canJudgeAiIntent('imbue')).toBe(true);
    expect(canJudgeAiIntent('local:gemma-4-E2B-it-web')).toBe(true);
    expect(canJudgeAiIntent('iosLocal:gemma-4-e2b-detector-v2')).toBe(true);
    expect(canJudgeAiIntent('openai:gpt-5-nano')).toBe(false);
    expect(canJudgeAiIntent('')).toBe(false);
  });
});

describe('applyAiIntentVerdict', () => {
  const union = ['AI slop', 'politics', 'crypto'];

  it('stores the returned phrases verbatim with the judged-set key', () => {
    const r = applyAiIntentVerdict(union, ['AI slop'], 99);
    expect(r).toEqual({ aiPhrases: ['AI slop'], judgedSetKey: phraseSetKey(union), updatedAt: 99 });
  });

  it('an empty verdict clears the phrases but still marks the set judged', () => {
    const r = applyAiIntentVerdict(union, [], 99);
    expect(r.aiPhrases).toEqual([]);
    expect(r.judgedSetKey).toBe(phraseSetKey(union));
  });

  it('defensively drops returned phrases outside the judged set', () => {
    const r = applyAiIntentVerdict(union, ['AI slop', 'not a real phrase'], 99);
    expect(r.aiPhrases).toEqual(['AI slop']);
  });

  it('dedupes by normalized identity and drops blanks', () => {
    const r = applyAiIntentVerdict(union, ['AI slop', ' ai slop ', '  '], 99);
    expect(r.aiPhrases).toEqual(['AI slop']);
  });
});

describe('recordAiIntentVerdict', () => {
  const union = ['ai slop', 'politics'];

  it('does not write storage for null or undefined verdicts', async () => {
    await recordAiIntentVerdict(union, null);
    await recordAiIntentVerdict(union, undefined);
    expect(state()).toBeUndefined();
  });

  it('persists the verdict and engages aiIntentAutoActive', async () => {
    await recordAiIntentVerdict(union, ['ai slop']);
    expect(state().aiPhrases).toEqual(['ai slop']);
    expect(aiIntentAutoActive({ aiFilterIntent: state() })).toBe(true);
  });

  it('skips the write when neither the phrase set nor the judged-set key changed', async () => {
    await recordAiIntentVerdict(union, ['ai slop']);
    const before = setWriteCount();
    await recordAiIntentVerdict(union, ['AI SLOP ']); // same set, normalized
    expect(setWriteCount()).toBe(before);
  });

  it('writes when only the judged-set key changed (new union, same verdict)', async () => {
    await recordAiIntentVerdict(union, ['ai slop']);
    const before = setWriteCount();
    await recordAiIntentVerdict([...union, 'crypto'], ['ai slop']);
    expect(setWriteCount()).toBe(before + 1);
    expect(state().judgedSetKey).toBe(phraseSetKey([...union, 'crypto']));
  });
});

describe('pruneAiFilterPhrases', () => {
  it('turns detection off instantly when all triggering phrases are gone, without a backend call', async () => {
    await recordAiIntentVerdict(['AI slop', 'politics'], ['AI slop']);
    expect(aiIntentAutoActive({ aiFilterIntent: state() })).toBe(true);

    store.descriptions_twitter = ['politics']; // "AI slop" deleted
    await pruneAiFilterPhrases();

    expect(mockDetectAiIntent).not.toHaveBeenCalled();
    expect(state().aiPhrases).toEqual([]);
    expect(aiIntentAutoActive({ aiFilterIntent: state() })).toBe(false);
  });

  it('keeps surviving AI phrases and does not write when nothing was deleted', async () => {
    store.descriptions_twitter = ['AI slop', 'politics'];
    await recordAiIntentVerdict(['AI slop', 'politics'], ['AI slop']);
    const before = setWriteCount();
    await pruneAiFilterPhrases();
    expect(setWriteCount()).toBe(before);
    expect(state().aiPhrases).toEqual(['AI slop']);
  });

  it('delete then re-add re-activates: pruning clears judgedSetKey so the set is re-judged', async () => {
    store.selectedModel = 'imbue';
    store.descriptions_twitter = ['AI slop'];
    mockDetectAiIntent.mockResolvedValue(intentResponse(['AI slop']));
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
    expect(mockDetectAiIntent).toHaveBeenCalledTimes(2);
    expect(state().aiPhrases).toEqual(['AI slop']);
    expect(aiIntentAutoActive({ aiFilterIntent: state() })).toBe(true);
  });
});

describe('refreshAiFilterIntent', () => {
  it('clears state deterministically when no phrases exist, without a backend call', async () => {
    await recordAiIntentVerdict(['ai slop'], ['ai slop']);
    await refreshAiFilterIntent();
    expect(mockDetectAiIntent).not.toHaveBeenCalled();
    expect(state().aiPhrases).toEqual([]);
    expect(aiIntentAutoActive({ aiFilterIntent: state() })).toBe(false);
  });

  it('judges the current phrases via detectAiIntent and applies the verdict', async () => {
    store.descriptions_twitter = ['ai slop', 'politics'];
    store.selectedModel = 'imbue';
    mockDetectAiIntent.mockResolvedValue(intentResponse(['ai slop']));

    await refreshAiFilterIntent();

    expect(mockDetectAiIntent).toHaveBeenCalledTimes(1);
    const [phrases] = mockDetectAiIntent.mock.calls[0] as [string[]];
    expect([...phrases].sort()).toEqual(['ai slop', 'politics']);
    expect(state().aiPhrases).toEqual(['ai slop']);
    expect(state().judgedSetKey).toBe(phraseSetKey(['ai slop', 'politics']));
  });

  it('sends only the phrases that fit the 1000-char detectAiIntent budget, in order', async () => {
    const huge = 'x'.repeat(1001);
    store.descriptions_twitter = [huge, 'ai slop', 'politics'];
    store.selectedModel = 'imbue';
    mockDetectAiIntent.mockResolvedValue(intentResponse(['ai slop']));

    await refreshAiFilterIntent();

    const [phrases] = mockDetectAiIntent.mock.calls[0] as [string[]];
    expect(phrases).toEqual(['ai slop', 'politics']);
    // Recorded against the full union: the set counts as judged, no re-send.
    expect(state().judgedSetKey).toBe(phraseSetKey([huge, 'ai slop', 'politics']));
    expect(state().aiPhrases).toEqual(['ai slop']);
  });

  it('treats the verdict as unknown when no phrase fits the budget (no request sent)', async () => {
    store.descriptions_twitter = ['y'.repeat(1001)];
    store.selectedModel = 'imbue';

    await refreshAiFilterIntent();

    expect(mockDetectAiIntent).not.toHaveBeenCalled();
    expect(state()?.judgedSetKey ?? null).toBeNull();
  });

  it('never re-probes a set that was already judged', async () => {
    store.descriptions_twitter = ['ai slop'];
    store.selectedModel = 'imbue';
    mockDetectAiIntent.mockResolvedValue(intentResponse(['ai slop']));

    await refreshAiFilterIntent();
    await refreshAiFilterIntent();
    expect(mockDetectAiIntent).toHaveBeenCalledTimes(1);
  });

  it('does not double-probe when a second refresh starts while the probe is in flight', async () => {
    store.descriptions_twitter = ['ai slop'];
    store.selectedModel = 'imbue';
    let resolveProbe!: (v: unknown) => void;
    mockDetectAiIntent.mockImplementation(() => new Promise(r => { resolveProbe = r; }));

    const first = refreshAiFilterIntent();
    const second = refreshAiFilterIntent(); // reaches the in-flight guard and returns
    await second;
    resolveProbe(intentResponse(['ai slop']));
    await first;

    expect(mockDetectAiIntent).toHaveBeenCalledTimes(1);
    expect(state().aiPhrases).toEqual(['ai slop']);
  });

  it('prunes deleted phrases locally, even when probing is gated (non-Imbue model)', async () => {
    await recordAiIntentVerdict(['ai slop', 'politics'], ['ai slop']);
    store.descriptions_twitter = ['politics']; // "ai slop" deleted
    store.selectedModel = 'openai:gpt-5';

    await refreshAiFilterIntent();

    expect(mockDetectAiIntent).not.toHaveBeenCalled();
    expect(state().aiPhrases).toEqual([]);
  });

  it('does not probe when a BYOK model is selected', async () => {
    store.descriptions_twitter = ['ai slop'];
    store.selectedModel = 'openai:gpt-5';
    await refreshAiFilterIntent();
    expect(mockDetectAiIntent).not.toHaveBeenCalled();
    expect(mockIosJudge).not.toHaveBeenCalled();
    expect(mockLocalJudge).not.toHaveBeenCalled();
  });

  it('judges via the on-device model when iosLocal is selected — no backend call', async () => {
    store.descriptions_twitter = ['ai slop', 'politics'];
    store.selectedModel = 'iosLocal:gemma-4-e2b-detector-v2';
    mockIosJudge.mockResolvedValue(['ai slop']);

    await refreshAiFilterIntent();

    expect(mockDetectAiIntent).not.toHaveBeenCalled();
    expect(mockIosJudge).toHaveBeenCalledTimes(1);
    const [phrases] = mockIosJudge.mock.calls[0] as [string[]];
    expect([...phrases].sort()).toEqual(['ai slop', 'politics']);
    expect(state().aiPhrases).toEqual(['ai slop']);
    expect(state().judgedSetKey).toBe(phraseSetKey(['ai slop', 'politics']));
    expect(aiIntentAutoActive({ aiFilterIntent: state() })).toBe(true);
  });

  it('judges via the in-browser model when a desktop local model is selected', async () => {
    store.descriptions_twitter = ['ai slop'];
    store.selectedModel = 'local:gemma-4-E2B-it-web';
    mockLocalJudge.mockResolvedValue(['ai slop']);

    await refreshAiFilterIntent();

    expect(mockDetectAiIntent).not.toHaveBeenCalled();
    expect(mockLocalJudge).toHaveBeenCalledWith(['ai slop'], 'gemma-4-E2B-it-web');
    expect(state().aiPhrases).toEqual(['ai slop']);
    expect(state().judgedSetKey).toBe(phraseSetKey(['ai slop']));
  });

  it('a null (unparseable) local verdict leaves judgedSetKey stale so the next trigger retries', async () => {
    store.descriptions_twitter = ['ai slop'];
    store.selectedModel = 'local:gemma-4-E2B-it-web';
    mockLocalJudge.mockResolvedValueOnce(null);

    await refreshAiFilterIntent();
    expect(state()?.judgedSetKey ?? null).toBeNull();

    mockLocalJudge.mockResolvedValue(['ai slop']);
    await refreshAiFilterIntent();
    expect(mockLocalJudge).toHaveBeenCalledTimes(2);
    expect(state().aiPhrases).toEqual(['ai slop']);
  });

  it('leaves state and judged-set key unchanged when the response omits the field (old gateway)', async () => {
    await recordAiIntentVerdict(['ai slop'], ['ai slop']);
    const judgedBefore = state().judgedSetKey;
    store.descriptions_twitter = ['ai slop', 'politics'];
    store.selectedModel = 'imbue';
    mockDetectAiIntent.mockResolvedValue(intentResponse(undefined));

    await refreshAiFilterIntent();
    expect(state().aiPhrases).toEqual(['ai slop']);
    // judgedSetKey stays stale on purpose so the next trigger retries.
    expect(state().judgedSetKey).toBe(judgedBefore);
  });

  it('survives a probe failure (timeout / jobFailed / 429) without touching state, then retries on the next call', async () => {
    await recordAiIntentVerdict(['ai slop'], ['ai slop']);
    store.descriptions_twitter = ['ai slop', 'politics'];
    store.selectedModel = 'imbue';
    // The silent-error case surfaces as a timeout rejection from the WS layer.
    mockDetectAiIntent.mockRejectedValueOnce(new Error('Request timed out after 30 seconds.'));

    await expect(refreshAiFilterIntent()).resolves.toBeUndefined();
    expect(state().aiPhrases).toEqual(['ai slop']);

    mockDetectAiIntent.mockResolvedValue(intentResponse(['ai slop', 'politics']));
    await refreshAiFilterIntent();
    expect(mockDetectAiIntent).toHaveBeenCalledTimes(2);
    expect(state().aiPhrases).toEqual(['ai slop', 'politics']);
  });

  it('treats pre-migration state (boolean latch, no aiPhrases) as empty', async () => {
    store.aiFilterIntent = { intent: true, phraseSetKey: 'ai slop', updatedAt: 1 };
    expect(aiIntentAutoActive({ aiFilterIntent: store.aiFilterIntent as AiFilterIntentState })).toBe(false);

    store.descriptions_twitter = ['ai slop'];
    store.selectedModel = 'imbue';
    mockDetectAiIntent.mockResolvedValue(intentResponse(['ai slop']));

    await refreshAiFilterIntent();
    expect(state().aiPhrases).toEqual(['ai slop']);
    expect(aiIntentAutoActive({ aiFilterIntent: state() })).toBe(true);
  });
});
