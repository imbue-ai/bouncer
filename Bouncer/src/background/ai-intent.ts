// Derivation of the backend's `aiFilterPhrases` signal into a persistent
// "which phrases request AI-content removal" state.
//
// Every tweetFilter jobComplete for reasons filterPost/validatePhrase carries
// `aiFilterPhrases: string[] | null` — the verbatim subset of the request's
// categories that ask for AI-generated content to be removed ("AI slop",
// "AI-generated images", ...). `[]` means none do; `null` (or absent, on old
// workers) means unknown.
//
// Latency rule: the FIRST server response that flags a phrase turns AI
// detection on — nothing waits on a debounce or an extra round trip.
//
// The judgment comes from an LLM at temperature 1.0, so borderline phrases
// ("AI hype") can flip between requests. Stability comes from an
// authoritative probe layered over the fast path:
//
//   - filterPost responses write immediately, but only ADD phrases, and only
//     while the current phrase union is UN-judged. That makes typing
//     "AI slop" engage detection on the very first response back.
//   - refreshAiFilterIntent probes the backend with the union of all
//     platforms' phrases and applies the verdict authoritatively (it can
//     remove fast-path false positives). `judgedSetKey` records which union
//     was judged; once a union is judged, it is never re-probed and
//     filterPost noise on it is ignored — so a borderline phrase can't
//     ping-pong in and out.
//   - Deleting phrases prunes the state locally and instantly — no backend
//     round-trip needed to know a removed phrase can't engage anything.
//     Pruning clears judgedSetKey: the stored judgment described a union
//     that no longer exists, and a stale key must not silence the re-probe
//     when the same set is later re-created (delete-then-re-add).
//
// The derived state persists in chrome.storage.local under `aiFilterIntent`.
// A non-empty aiPhrases list is the sole gate for the detectAiText /
// detectAiImage detectors — AI detection has no manual toggle; it turns on
// and off purely through the user's natural-language filter phrases. On the
// Imbue model path the pipeline also EXCLUDES these phrases from the
// tweet-filter categories (Settings.effectiveDescriptions): "AI slop"
// engages the AI detector instead of hiding human posts about AI slop.

import { getStorage, setStorage, getDescriptions, phraseSetKey } from '../shared/storage';
import { PLATFORMS } from '../shared/platforms';
import { DEFAULT_MODEL } from '../shared/models';
import { callImbueAPI } from './providers';
import type { AiFilterIntentState } from '../types';

export { phraseSetKey };

const normalize = (p: string) => p.trim().toLowerCase();

/** Dedupe by normalized identity, keeping the first verbatim spelling and
 *  dropping blank entries. */
function dedupeNormalized(phrases: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of phrases) {
    const key = normalize(p);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

/** The members of `phrases` that also appear in `set`, by normalized identity. */
function intersectNormalized(phrases: string[], set: string[]): string[] {
  const keys = new Set(set.map(normalize));
  return phrases.filter(p => keys.has(normalize(p)));
}

const DEFAULT_STATE: AiFilterIntentState = { aiPhrases: [], judgedSetKey: null, updatedAt: 0 };

/** Read the persisted state, tolerating the pre-migration shape (a boolean
 *  `intent` latch with no aiPhrases array) by treating it as empty — the
 *  startup migration in background/index.ts schedules a refresh to re-derive. */
async function getState(): Promise<AiFilterIntentState> {
  const data = await getStorage(['aiFilterIntent']);
  const stored = data.aiFilterIntent;
  if (!stored || !Array.isArray(stored.aiPhrases)) return DEFAULT_STATE;
  return { ...DEFAULT_STATE, ...stored };
}

/** Persist `next` only when it meaningfully differs from `prev` (normalized
 *  phrase set or judged-set key). The storage-change listeners clear the
 *  evaluation cache and re-evaluate posts on set changes, so no-op writes
 *  must never reach storage. */
async function persistIfChanged(prev: AiFilterIntentState, next: AiFilterIntentState): Promise<void> {
  const setChanged = phraseSetKey(prev.aiPhrases) !== phraseSetKey(next.aiPhrases);
  if (!setChanged && prev.judgedSetKey === next.judgedSetKey) return;
  if ((prev.aiPhrases.length > 0) !== (next.aiPhrases.length > 0)) {
    console.log(`[AiIntent] AI detection ${next.aiPhrases.length > 0 ? 'ON' : 'OFF'} (aiPhrases: ${JSON.stringify(next.aiPhrases)})`);
  }
  await setStorage({ aiFilterIntent: next });
}

/** Pure verdict transition — exported for tests. The probe judged
 *  `judgedUnion`; `returned` is the backend's aiFilterPhrases verdict for it.
 *  The intersection is defensive: constrained decoding guarantees returned
 *  phrases are verbatim members of the judged set. `now` is injected so
 *  tests are deterministic. */
export function applyValidatePhraseVerdict(
  judgedUnion: string[],
  returned: string[],
  now: number,
): AiFilterIntentState {
  return {
    aiPhrases: dedupeNormalized(intersectNormalized(returned, judgedUnion)),
    judgedSetKey: phraseSetKey(judgedUnion),
    updatedAt: now,
  };
}

/** Apply a validatePhrase verdict to the persisted state. Tolerates
 *  null/undefined (unknown — no-op). Together with the local prune in
 *  refreshAiFilterIntent, the only writer of the state. */
export async function recordValidatePhraseVerdict(
  judgedUnion: string[],
  returned: string[] | null | undefined,
): Promise<void> {
  if (!Array.isArray(returned)) return;
  const prev = await getState();
  await persistIfChanged(prev, applyValidatePhraseVerdict(judgedUnion, returned, Date.now()));
}

/** Apply a filterPost response's aiFilterPhrases — the fast path. The FIRST
 *  response that flags a phrase turns AI detection on immediately; nothing
 *  waits on the debounced probe. Guardrails against temperature-1.0 noise:
 *  writes only ADD phrases (that still exist in the user's lists), and only
 *  while the current union is un-judged — once the authoritative probe has
 *  judged this exact set, per-request noise on it is ignored, so a
 *  borderline phrase can't ping-pong in and out. Each fast-path write also
 *  schedules the probe so the authoritative verdict lands right after. */
export async function recordFilterPostAiPhrases(
  returned: string[] | null | undefined,
): Promise<void> {
  if (!Array.isArray(returned) || returned.length === 0) return;
  const prev = await getState();
  const known = new Set(prev.aiPhrases.map(normalize));
  const fresh = returned.filter(p => normalize(p) !== '' && !known.has(normalize(p)));
  if (fresh.length === 0) return;

  const union = await currentPhraseUnion();
  // The authoritative probe already judged this exact set — the flagged
  // phrase was judged NOT an AI request; this response is noise.
  if (phraseSetKey(union) === prev.judgedSetKey) return;
  // Only phrases that still exist can engage (the response may be stale).
  const freshExisting = intersectNormalized(fresh, union);
  if (freshExisting.length === 0) return;

  await persistIfChanged(prev, {
    ...prev,
    aiPhrases: dedupeNormalized([...prev.aiPhrases, ...freshExisting]),
    updatedAt: Date.now(),
  });
  scheduleAiFilterIntentRefresh();
}

/** The user's current phrases across all platforms. The backend judges each
 *  phrase independently, so probing with the union preserves per-phrase
 *  semantics. */
async function currentPhraseUnion(): Promise<string[]> {
  const all: string[] = [];
  for (const p of PLATFORMS) {
    all.push(...await getDescriptions(`descriptions_${p.id}`));
  }
  return [...new Set(all)];
}

/** Drop stored AI phrases that no longer exist in any platform's phrase
 *  list. Deterministic and local — no LLM needed to know a deleted phrase
 *  can't engage anything. Called directly (not debounced) on every phrase
 *  edit so deleting the last AI phrase turns detection off instantly, and
 *  again from refreshAiFilterIntent ahead of the backend/model gates so
 *  non-Imbue users stay correct too. */
export async function pruneAiFilterPhrases(): Promise<void> {
  const phrases = await currentPhraseUnion();
  const prev = await getState();
  const pruned = intersectNormalized(prev.aiPhrases, phrases);
  if (pruned.length !== prev.aiPhrases.length) {
    // judgedSetKey is cleared, not kept: it described a union that no longer
    // exists, and a stale key would silence the re-probe if the user
    // re-creates the same set (delete "AI slop", then add it back).
    await persistIfChanged(prev, { aiPhrases: pruned, judgedSetKey: null, updatedAt: Date.now() });
  }
}

/** Re-derive the state from the user's current phrases across all platforms.
 *  Called (debounced) on every phrase-list edit, on switching the filter
 *  model to Imbue, and when a filterPost response flags an unknown phrase.
 *  Deletions resolve locally; an empty union resolves deterministically
 *  without the backend; otherwise a validatePhrase probe is sent — unless
 *  this exact set was already judged. */
export async function refreshAiFilterIntent(): Promise<void> {
  await pruneAiFilterPhrases();

  const phrases = await currentPhraseUnion();

  if (phrases.length === 0) {
    // No phrases → nothing can be an AI-removal request; judged trivially.
    await persistIfChanged(await getState(), {
      aiPhrases: [], judgedSetKey: phraseSetKey([]), updatedAt: Date.now(),
    });
    return;
  }

  if (process.env.HAS_IMBUE_BACKEND !== 'true') return;
  // Only probe when the Imbue backend is already the filter model — users on
  // other/local models never send their phrases to Imbue via filterPost, and
  // this probe shouldn't be the thing that starts doing so.
  const { selectedModel } = await getStorage(['selectedModel']);
  if ((selectedModel || DEFAULT_MODEL) !== 'imbue') return;

  // Each phrase set is judged once, authoritatively. This is also the
  // convergence guard for filterPost-triggered refreshes: a borderline
  // phrase can't ping-pong in and out of the state, because the same set is
  // never re-judged.
  const setKey = phraseSetKey(phrases);
  if (setKey === (await getState()).judgedSetKey) return;
  // A probe for this exact set is already in the air (the leading-edge run
  // racing the trailing one) — its verdict is coming; don't double-send.
  if (setKey === inFlightProbeKey) return;

  inFlightProbeKey = setKey;
  try {
    // The judgment is a property of the phrase set; the tweet content is
    // irrelevant, so send a fixed placeholder and discard shouldHide.
    const response = await callImbueAPI(
      { text: 'placeholder post for phrase validation', imageUrls: [] },
      phrases,
      'validatePhrase',
    );
    // A failed probe (or null verdict) leaves judgedSetKey stale on purpose:
    // the next trigger retries instead of treating the set as judged.
    await recordValidatePhraseVerdict(phrases, response.aiFilterPhrases ?? null);
  } catch (err) {
    console.warn('[AiIntent] validatePhrase probe failed:', (err as Error).message);
  } finally {
    inFlightProbeKey = null;
  }
}

// Phrase-set key of a validatePhrase probe currently awaiting its response.
let inFlightProbeKey: string | null = null;

let refreshTimer: ReturnType<typeof setTimeout> | null = null;

/** Debounced refreshAiFilterIntent with a leading edge: the first edit in an
 *  idle period refreshes immediately, so typing "AI slop" engages AI
 *  detection as fast as the backend can judge it. One trailing run `delayMs`
 *  later picks up the rest of a burst (accepting several suggestions) —
 *  the judgedSetKey guard and the in-flight dedupe make that run free when
 *  the set didn't change again. */
export function scheduleAiFilterIntentRefresh(delayMs = 2000): void {
  const idle = refreshTimer === null;
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    refreshAiFilterIntent().catch(err =>
      console.warn('[AiIntent] refresh failed:', (err as Error).message));
  }, delayMs);
  if (idle) {
    refreshAiFilterIntent().catch(err =>
      console.warn('[AiIntent] refresh failed:', (err as Error).message));
  }
}
