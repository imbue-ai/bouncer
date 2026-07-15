// Derivation of a persistent "which phrases request AI-content removal"
// state from the user's filter phrases.
//
// The judge returns `string[] | null` — the verbatim subset of the judged
// phrases that ask for AI-generated content to be removed ("AI slop",
// "AI-generated images", ...). `[]` means none do; `null` means unknown
// (the model's verdict couldn't be parsed). On the Imbue path the judge is
// the backend's dedicated detectAiIntent WebSocket route; on local models
// it is a one-off on-device/in-browser inference (see judgeAiIntent).
//
// Judgments happen per phrase-LIST change — on edits (debounced, with a
// leading edge so typing "AI slop" engages detection as fast as the judge
// can answer) and once at startup if the current list was never judged.
// NEVER per tweet: the detectAiIntent route is rate-limited to 60
// requests/min per user.
//
// The judgment comes from an LLM at temperature 1.0, so borderline phrases
// ("AI hype") could flip between requests. Stability rules:
//
//   - refreshAiFilterIntent judges the union of all platforms' phrases and
//     applies the verdict authoritatively. `judgedSetKey` records which
//     union was judged; once a union is judged, it is never re-judged — so
//     a borderline phrase can't ping-pong in and out, and unchanged lists
//     cost nothing on startup.
//   - Deleting phrases prunes the state locally and instantly — no backend
//     round-trip needed to know a removed phrase can't engage anything.
//     Pruning clears judgedSetKey: the stored judgment described a union
//     that no longer exists, and a stale key must not silence the re-judge
//     when the same set is later re-created (delete-then-re-add).
//
// The derived state persists in chrome.storage.local under `aiFilterIntent`.
// aiPhrases spans all platforms (the union is judged so each phrase is
// judged once), but the detectAiText / detectAiImage detectors gate
// PER PLATFORM: detection is on for a platform only when that platform's
// own phrase list contains one of the aiPhrases (aiIntentActiveForSite in
// shared/storage.ts). AI detection has no manual toggle; it turns on and
// off purely through each platform's natural-language filter phrases. On
// the Imbue model path the pipeline also EXCLUDES these phrases from the
// tweet-filter categories (Settings.effectiveDescriptions): "AI slop"
// engages the AI detector instead of hiding human posts about AI slop.

import { getStorage, setStorage, getDescriptions, phraseSetKey } from '../shared/storage';
import { AI_DETECTION_SEED_PHRASE } from '../shared/utils';
import { PLATFORMS } from '../shared/platforms';
import { DEFAULT_MODEL, PREDEFINED_MODELS } from '../shared/models';
import { callImbueDetectAiIntent } from './providers';
import { iosLocalJudgeAiIntent } from './ios-local-bridge';
import { callLocalAiIntentJudgment } from './local-model';
import type { AiFilterIntentState } from '../types';

export { phraseSetKey };

/** Whether the given filter model can judge phrases for AI-removal intent —
 *  i.e. whether the NL AI-detection system is live on this model. Imbue and
 *  the desktop in-browser model also need the Imbue backend, because their
 *  AI text/image detectors are the cloud workers; the iOS on-device model
 *  judges AND detects locally, so it needs no backend at all. BYOK models
 *  are excluded: nothing judges their phrases, so the detectors never
 *  engage (and the intent state only ever prunes toward off). */
export function canJudgeAiIntent(model: string): boolean {
  if (model.startsWith('iosLocal:')) return true;
  if (process.env.HAS_IMBUE_BACKEND !== 'true') return false;
  return model === 'imbue' || model.startsWith('local:');
}

const normalize = (p: string) => p.trim().toLowerCase();

/** The seed phrase our own sparkle indicator plants. Its meaning is known by
 *  construction, so it engages detection deterministically — no LLM verdict
 *  needed, and no LLM verdict can override it. */
const isSeedPhrase = (p: string) => normalize(p) === normalize(AI_DETECTION_SEED_PHRASE);

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

/** Pure verdict transition — exported for tests. The judge covered
 *  `judgedUnion`; `returned` is its aiFilterPhrases verdict for it. The
 *  intersection is defensive: the backend promises returned phrases are
 *  verbatim members of the sent list. `now` is injected so tests are
 *  deterministic. */
export function applyAiIntentVerdict(
  judgedUnion: string[],
  returned: string[],
  now: number,
): AiFilterIntentState {
  return {
    // The seed phrase is always kept, whatever the judge said.
    aiPhrases: dedupeNormalized([
      ...judgedUnion.filter(isSeedPhrase),
      ...intersectNormalized(returned, judgedUnion),
    ]),
    judgedSetKey: phraseSetKey(judgedUnion),
    updatedAt: now,
  };
}

/** Apply an intent-judgment verdict to the persisted state. Tolerates
 *  null/undefined (unknown — no-op). Together with the local prune in
 *  refreshAiFilterIntent, the only writer of the state. */
export async function recordAiIntentVerdict(
  judgedUnion: string[],
  returned: string[] | null | undefined,
): Promise<void> {
  if (!Array.isArray(returned)) return;
  const prev = await getState();
  await persistIfChanged(prev, applyAiIntentVerdict(judgedUnion, returned, Date.now()));
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

/** The backend caps a detectAiIntent request at 1000 chars of phrases.
 *  Greedily keep the phrases that fit, in list order. */
const DETECT_AI_INTENT_CHAR_BUDGET = 1000;
function fitToDetectAiIntentBudget(phrases: string[]): string[] {
  const kept: string[] = [];
  let budget = DETECT_AI_INTENT_CHAR_BUDGET;
  for (const p of phrases) {
    if (p.length > budget) continue;
    kept.push(p);
    budget -= p.length;
  }
  return kept;
}

/** Judge `phrases` for AI-removal intent with whichever judge the selected
 *  model provides: the Imbue detectAiIntent route on the Imbue and
 *  desktop-local paths, or the on-device model on iOS. On the desktop-local
 *  path only the one-off judgment goes to Imbue — the per-post filter
 *  requests never carry the phrases there. Returns the phrases judged as
 *  AI-removal requests, or null for "unknown" (unparseable verdict / old
 *  gateway). */
async function judgeAiIntent(model: string, phrases: string[]): Promise<string[] | null> {
  if (model.startsWith('iosLocal:')) {
    const modelName = model.split(':')[1];
    const modelConfig = PREDEFINED_MODELS.iosLocal?.find(m => m.name === modelName) ?? null;
    return await iosLocalJudgeAiIntent(phrases, modelConfig);
  }
  if (model.startsWith('local:')) {
    return await callLocalAiIntentJudgment(phrases, model.split(':')[1]);
  }
  // Oversized lists are judged partially rather than not at all: phrases
  // beyond the budget come back un-flagged and keep acting as ordinary
  // filters. The verdict is still recorded against the full union, so the
  // set counts as judged and isn't re-sent every trigger.
  const sendable = fitToDetectAiIntentBudget(phrases);
  if (sendable.length < phrases.length) {
    console.warn(`[AiIntent] phrase list exceeds the detectAiIntent budget; judging ${sendable.length}/${phrases.length} phrases`);
  }
  if (sendable.length === 0) return null;
  const response = await callImbueDetectAiIntent(sendable);
  return response.aiFilterPhrases ?? null;
}

/** Re-derive the state from the user's current phrases across all platforms.
 *  Called (debounced) on every phrase-list edit, on switching the filter
 *  model to one that can judge, and once at startup. Deletions resolve
 *  locally; an empty union resolves deterministically without any model;
 *  otherwise the phrase set is judged — by the Imbue detectAiIntent route or
 *  the local model, per canJudgeAiIntent — unless this exact set was already
 *  judged. */
export async function refreshAiFilterIntent(): Promise<void> {
  await pruneAiFilterPhrases();

  const phrases = await currentPhraseUnion();

  // The seed phrase turns detection on right now — no waiting on (and no
  // vetoing by) the intent judge. judgedSetKey is left untouched: the rest
  // of the list still gets judged normally below.
  const seed = phrases.filter(isSeedPhrase);
  if (seed.length > 0) {
    const prev = await getState();
    if (!prev.aiPhrases.some(isSeedPhrase)) {
      await persistIfChanged(prev, {
        ...prev,
        aiPhrases: dedupeNormalized([...prev.aiPhrases, ...seed]),
        updatedAt: Date.now(),
      });
    }
  }

  if (phrases.length === 0) {
    // No phrases → nothing can be an AI-removal request; judged trivially.
    await persistIfChanged(await getState(), {
      aiPhrases: [], judgedSetKey: phraseSetKey([]), updatedAt: Date.now(),
    });
    return;
  }

  // Only judge on models that have a judge (and working detectors). On BYOK
  // models the user's phrases are never sent anywhere for judgment — Imbue
  // never sees phrases it wasn't already receiving via filterPost.
  const { selectedModel } = await getStorage(['selectedModel']);
  const model = selectedModel || DEFAULT_MODEL;
  if (!canJudgeAiIntent(model)) return;

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
    // A failed probe (timeout, jobFailed, rate limit) or a null verdict
    // leaves judgedSetKey stale on purpose: the next trigger retries instead
    // of treating the set as judged. Timeouts are expected — the backend
    // acks some errors silently and never sends a result — so they are
    // logged, never surfaced.
    await recordAiIntentVerdict(phrases, await judgeAiIntent(model, phrases));
  } catch (err) {
    console.warn('[AiIntent] phrase-intent judgment failed:', (err as Error).message);
  } finally {
    inFlightProbeKey = null;
  }
}

// Phrase-set key of an intent judgment currently awaiting its verdict.
let inFlightProbeKey: string | null = null;
