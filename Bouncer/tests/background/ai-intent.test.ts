import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

// DEFAULT_MODEL and the probe gate read this at module-import time, so it must
// be set before ai-intent.js (→ shared/models.js) is imported below.
process.env.HAS_IMBUE_BACKEND = 'true';

// Mock providers so no WebSocket machinery (or Firebase auth) is pulled in.
vi.mock('../../src/background/providers.js', () => ({
  callImbueAPI: vi.fn(),
}));

const {
  applyAiFilterIntent, recordAiFilterIntent, refreshAiFilterIntent,
  phraseSetKey, AI_INTENT_OFF_STREAK,
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

const OFF: AiFilterIntentState = { intent: false, phraseSetKey: null, updatedAt: 0 };
const latched = (categories: string[]): AiFilterIntentState =>
  ({ intent: true, phraseSetKey: phraseSetKey(categories), updatedAt: 1 });

describe('phraseSetKey', () => {
  it('is insensitive to order, casing, whitespace, and duplicates', () => {
    expect(phraseSetKey(['AI slop', 'politics'])).toBe(phraseSetKey(['politics ', 'ai slop', 'AI SLOP']));
  });

  it('distinguishes different sets', () => {
    expect(phraseSetKey(['ai slop'])).not.toBe(phraseSetKey(['ai slop', 'politics']));
  });
});

describe('applyAiFilterIntent', () => {
  const cats = ['ai slop', 'politics'];

  it('treats null as unknown — state unchanged', () => {
    const prev = latched(cats);
    const r = applyAiFilterIntent(prev, 2, cats, null, 'filterPost', 99);
    expect(r.state).toBe(prev);
    expect(r.noStreak).toBe(2);
  });

  it('treats an absent field (undefined) as unknown — state unchanged', () => {
    const r = applyAiFilterIntent(OFF, 0, cats, undefined, 'validatePhrase', 99);
    expect(r.state).toBe(OFF);
  });

  it('latches ON immediately from a filterPost true', () => {
    const r = applyAiFilterIntent(OFF, 0, cats, true, 'filterPost', 99);
    expect(r.state).toEqual({ intent: true, phraseSetKey: phraseSetKey(cats), updatedAt: 99 });
  });

  it('latches ON immediately from a validatePhrase true', () => {
    const r = applyAiFilterIntent(OFF, 0, cats, true, 'validatePhrase', 99);
    expect(r.state.intent).toBe(true);
  });

  it('a validatePhrase false clears immediately (authoritative per phrase set)', () => {
    const r = applyAiFilterIntent(latched(cats), 0, ['politics'], false, 'validatePhrase', 99);
    expect(r.state.intent).toBe(false);
    expect(r.state.phraseSetKey).toBe(phraseSetKey(['politics']));
  });

  it(`a filterPost false only clears after ${AI_INTENT_OFF_STREAK} consecutive falses for the latched set`, () => {
    let state = latched(cats);
    let streak = 0;
    for (let i = 1; i < AI_INTENT_OFF_STREAK; i++) {
      ({ state, noStreak: streak } = applyAiFilterIntent(state, streak, cats, false, 'filterPost', 99));
      expect(state.intent).toBe(true);
      expect(streak).toBe(i);
    }
    ({ state, noStreak: streak } = applyAiFilterIntent(state, streak, cats, false, 'filterPost', 99));
    expect(state.intent).toBe(false);
    expect(streak).toBe(0);
  });

  it('a true resets the off-streak', () => {
    let state = latched(cats);
    let streak = AI_INTENT_OFF_STREAK - 1;
    ({ state, noStreak: streak } = applyAiFilterIntent(state, streak, cats, true, 'filterPost', 99));
    expect(streak).toBe(0);
    const after = applyAiFilterIntent(state, streak, cats, false, 'filterPost', 99);
    expect(after.state.intent).toBe(true);
    expect(after.noStreak).toBe(1);
  });

  it('ignores a filterPost false for a different phrase set than the latched one', () => {
    const prev = latched(cats);
    let state = prev;
    let streak = 0;
    for (let i = 0; i < AI_INTENT_OFF_STREAK + 1; i++) {
      ({ state, noStreak: streak } = applyAiFilterIntent(state, streak, ['sports'], false, 'filterPost', 99));
    }
    expect(state).toBe(prev);
    expect(streak).toBe(0);
  });

  it('a filterPost false when intent is already off is a no-op', () => {
    const r = applyAiFilterIntent(OFF, 0, cats, false, 'filterPost', 99);
    expect(r.state).toBe(OFF);
    expect(r.noStreak).toBe(0);
  });
});

describe('recordAiFilterIntent', () => {
  const cats = ['ai generated images'];

  it('does not write storage for null or undefined values', async () => {
    await recordAiFilterIntent(cats, null, 'filterPost');
    await recordAiFilterIntent(cats, undefined, 'filterPost');
    expect(store.aiFilterIntent).toBeUndefined();
  });

  it('persists a latched intent from a true response', async () => {
    await recordAiFilterIntent(cats, true, 'filterPost');
    const state = store.aiFilterIntent as AiFilterIntentState;
    expect(state.intent).toBe(true);
    expect(state.phraseSetKey).toBe(phraseSetKey(cats));
    expect(aiIntentAutoActive({ aiFilterIntent: state })).toBe(true);
  });

  it('an explicit opt-out beats a latched intent', async () => {
    await recordAiFilterIntent(cats, true, 'validatePhrase');
    store.aiFilterIntentOptOut = true;
    expect(aiIntentAutoActive({
      aiFilterIntent: store.aiFilterIntent as AiFilterIntentState,
      aiFilterIntentOptOut: true,
    })).toBe(false);
  });

  it('rides out isolated contradictory falses, then clears after a full streak', async () => {
    await recordAiFilterIntent(cats, true, 'filterPost');
    for (let i = 0; i < AI_INTENT_OFF_STREAK - 1; i++) {
      await recordAiFilterIntent(cats, false, 'filterPost');
      expect((store.aiFilterIntent as AiFilterIntentState).intent).toBe(true);
    }
    await recordAiFilterIntent(cats, false, 'filterPost');
    expect((store.aiFilterIntent as AiFilterIntentState).intent).toBe(false);
  });
});

describe('refreshAiFilterIntent', () => {
  it('clears intent deterministically when no phrases exist, without a backend call', async () => {
    // Latch first so the clear is observable.
    await recordAiFilterIntent(['ai slop'], true, 'validatePhrase');
    await refreshAiFilterIntent();
    expect(mockCallImbueAPI).not.toHaveBeenCalled();
    expect((store.aiFilterIntent as AiFilterIntentState).intent).toBe(false);
  });

  it('probes with the current phrases via validatePhrase and applies the verdict', async () => {
    store.descriptions_twitter = ['ai slop', 'politics'];
    store.selectedModel = 'imbue';
    mockCallImbueAPI.mockResolvedValue({
      shouldHide: false, reasoning: null, category: null,
      rawResponse: '', processingTime: 1, jobId: 'j1',
      aiFilterIntent: true,
    });

    await refreshAiFilterIntent();

    expect(mockCallImbueAPI).toHaveBeenCalledTimes(1);
    const [, categories, reason] = mockCallImbueAPI.mock.calls[0] as [unknown, string[], string];
    expect(reason).toBe('validatePhrase');
    expect([...categories].sort()).toEqual(['ai slop', 'politics']);
    expect((store.aiFilterIntent as AiFilterIntentState).intent).toBe(true);
  });

  it('does not probe when a non-Imbue model is selected', async () => {
    store.descriptions_twitter = ['ai slop'];
    store.selectedModel = 'openai:gpt-5';
    await refreshAiFilterIntent();
    expect(mockCallImbueAPI).not.toHaveBeenCalled();
  });

  it('leaves state unchanged when the probe response omits the field (old worker)', async () => {
    await recordAiFilterIntent(['ai slop'], true, 'validatePhrase');
    store.descriptions_twitter = ['ai slop'];
    store.selectedModel = 'imbue';
    mockCallImbueAPI.mockResolvedValue({
      shouldHide: true, reasoning: 'r', category: null,
      rawResponse: '', processingTime: 1, jobId: 'j2',
      // no aiFilterIntent field at all
    });

    await refreshAiFilterIntent();
    expect((store.aiFilterIntent as AiFilterIntentState).intent).toBe(true);
  });

  it('survives a probe failure without touching state', async () => {
    await recordAiFilterIntent(['ai slop'], true, 'validatePhrase');
    store.descriptions_twitter = ['ai slop'];
    store.selectedModel = 'imbue';
    mockCallImbueAPI.mockRejectedValue(new Error('socket closed'));

    await expect(refreshAiFilterIntent()).resolves.toBeUndefined();
    expect((store.aiFilterIntent as AiFilterIntentState).intent).toBe(true);
  });
});
