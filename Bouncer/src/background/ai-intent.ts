// Derivation of the backend's `aiFilterIntent` signal into a persistent
// "user wants AI content removed" state.
//
// Every tweetFilter jobComplete for reasons filterPost/validatePhrase carries
// `aiFilterIntent: true | false | null` — whether at least one of the filter
// phrases sent with that request refers to AI-generated content. The judgment
// comes from an LLM at temperature 1.0, so borderline phrase sets can flip
// between requests. The state here is therefore sticky rather than
// last-write-wins:
//
//   - true latches the intent ON immediately, from either request reason.
//   - false from a filterPost only turns it OFF after AI_INTENT_OFF_STREAK
//     consecutive falses for the same phrase set that latched it — one noisy
//     contradiction never flips the state. Falses for a *different* phrase set
//     (another platform's phrase list) are ignored; set changes are handled by
//     the probe below.
//   - a validatePhrase result is authoritative for the phrase set it was
//     computed from. refreshAiFilterIntent sends one on every phrase-list edit
//     (the natural moment to learn intent), using the union of all platforms'
//     phrases, and applies its verdict directly.
//   - null / absent means unknown (backend rollout, model omitted the tag)
//     and never changes the state.
//
// The derived bit persists in chrome.storage.local under `aiFilterIntent`,
// where the pipeline ORs it (minus the explicit `aiFilterIntentOptOut`) into
// the existing aiTextFilterEnabled / aiImageFilterEnabled gates that drive the
// detectAiText / detectAiImage detectors.

import { getStorage, setStorage, getDescriptions } from '../shared/storage';
import { PLATFORMS } from '../shared/platforms';
import { DEFAULT_MODEL } from '../shared/models';
import { callImbueAPI } from './providers';
import type { AiFilterIntentState } from '../types';

/** Consecutive filterPost falses (for the latched phrase set) required to
 *  clear a latched intent. Absorbs temperature-1.0 flip-flops. */
export const AI_INTENT_OFF_STREAK = 3;

export type AiIntentSource = 'filterPost' | 'validatePhrase';

/** Normalize a phrase set so the same phrases always produce the same key,
 *  regardless of order, casing, or duplicates. */
export function phraseSetKey(categories: string[]): string {
  return [...new Set(categories.map(c => c.trim().toLowerCase()).filter(Boolean))]
    .sort()
    .join('\n');
}

export interface AiIntentTransition {
  state: AiFilterIntentState;
  /** Running count of consecutive filterPost falses against the latched set. */
  noStreak: number;
}

/** Pure state transition — see the module comment for the rules. `now` is
 *  injected so tests are deterministic. */
export function applyAiFilterIntent(
  prev: AiFilterIntentState,
  noStreak: number,
  categories: string[],
  value: boolean | null | undefined,
  source: AiIntentSource,
  now: number,
): AiIntentTransition {
  // null / absent = unknown — never a signal in either direction.
  if (typeof value !== 'boolean') {
    return { state: prev, noStreak };
  }

  const key = phraseSetKey(categories);

  if (value) {
    return {
      state: { intent: true, phraseSetKey: key, updatedAt: now },
      noStreak: 0,
    };
  }

  // value === false
  if (source === 'validatePhrase') {
    // Authoritative full-set probe: most recent verdict per phrase set wins.
    return {
      state: { intent: false, phraseSetKey: key, updatedAt: now },
      noStreak: 0,
    };
  }

  // filterPost false. Only falses for the exact set that latched the intent
  // count toward clearing it — a false for another platform's phrase set says
  // nothing about the set that latched.
  if (!prev.intent || key !== prev.phraseSetKey) {
    return { state: prev, noStreak };
  }
  const streak = noStreak + 1;
  if (streak >= AI_INTENT_OFF_STREAK) {
    return {
      state: { intent: false, phraseSetKey: key, updatedAt: now },
      noStreak: 0,
    };
  }
  return { state: prev, noStreak: streak };
}

// In-memory streak. Losing it on a service-worker restart just restarts the
// debounce window, which is safe (the latch persists in storage).
let noStreak = 0;

const DEFAULT_STATE: AiFilterIntentState = { intent: false, phraseSetKey: null, updatedAt: 0 };

/** Apply one response's aiFilterIntent to the persisted state. Tolerates
 *  null/undefined (no-op). Persists only when the state meaningfully changed,
 *  so storage-change listeners don't fire on every classified post. */
export async function recordAiFilterIntent(
  categories: string[],
  value: boolean | null | undefined,
  source: AiIntentSource,
): Promise<void> {
  if (typeof value !== 'boolean') return;
  const data = await getStorage(['aiFilterIntent']);
  const prev = data.aiFilterIntent ?? DEFAULT_STATE;
  const next = applyAiFilterIntent(prev, noStreak, categories, value, source, Date.now());
  noStreak = next.noStreak;
  if (next.state.intent !== prev.intent || next.state.phraseSetKey !== prev.phraseSetKey) {
    if (next.state.intent !== prev.intent) {
      console.log(`[AiIntent] intent ${prev.intent} → ${next.state.intent} (source: ${source})`);
    }
    await setStorage({ aiFilterIntent: next.state });
  }
}

/** Re-derive the intent from the user's current phrases across all platforms.
 *  Called (debounced) whenever a phrase list changes. An empty union is
 *  resolved deterministically without the backend; otherwise a validatePhrase
 *  probe is sent so the verdict lands immediately rather than waiting for the
 *  next filterPost. */
export async function refreshAiFilterIntent(): Promise<void> {
  const all: string[] = [];
  for (const p of PLATFORMS) {
    all.push(...await getDescriptions(`descriptions_${p.id}`));
  }
  // The backend judges "at least one phrase refers to AI content", so probing
  // with the union across platforms preserves the semantics of a single set.
  const phrases = [...new Set(all)];

  if (phrases.length === 0) {
    // No phrases → no AI-removal intent, no LLM needed.
    await recordAiFilterIntent([], false, 'validatePhrase');
    return;
  }

  if (process.env.HAS_IMBUE_BACKEND !== 'true') return;
  // Only probe when the Imbue backend is already the filter model — users on
  // other/local models never send their phrases to Imbue via filterPost, and
  // this probe shouldn't be the thing that starts doing so.
  const { selectedModel } = await getStorage(['selectedModel']);
  if ((selectedModel || DEFAULT_MODEL) !== 'imbue') return;

  try {
    // The judgment is a property of the phrase set; the tweet content is
    // irrelevant, so send a fixed placeholder and discard shouldHide.
    const response = await callImbueAPI(
      { text: 'placeholder post for phrase validation', imageUrls: [] },
      phrases,
      'validatePhrase',
    );
    await recordAiFilterIntent(phrases, response.aiFilterIntent ?? null, 'validatePhrase');
  } catch (err) {
    console.warn('[AiIntent] validatePhrase probe failed:', (err as Error).message);
  }
}

let refreshTimer: ReturnType<typeof setTimeout> | null = null;

/** Debounced refreshAiFilterIntent — phrase edits often come in bursts
 *  (accepting several suggestions), and each burst needs only one probe. */
export function scheduleAiFilterIntentRefresh(delayMs = 2000): void {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    refreshAiFilterIntent().catch(err =>
      console.warn('[AiIntent] refresh failed:', (err as Error).message));
  }, delayMs);
}
