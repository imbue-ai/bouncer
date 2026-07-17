import type {
  AiFilterIntentState,
  DescriptionKey,
  SiteId,
  StorageSchema,
} from '../types';

/** Typed wrapper around chrome.storage.local.get(). Values may be undefined if not yet set. */
export async function getStorage<K extends keyof StorageSchema>(
  keys: K[]
): Promise<Partial<Pick<StorageSchema, K>>> {
  return chrome.storage.local.get(keys);
}

/** Typed wrapper around chrome.storage.local.set(). */
export async function setStorage(
  items: Partial<StorageSchema>
): Promise<void> {
  await chrome.storage.local.set(items);
}

/** Typed wrapper around chrome.storage.local.remove(). */
export async function removeStorage<K extends keyof StorageSchema>(
  keys: K | K[]
): Promise<void> {
  await chrome.storage.local.remove(keys);
}

function siteIdFromDescKey(key: DescriptionKey): SiteId {
  return key.slice('descriptions_'.length) as SiteId;
}

function descriptionsKeyFor(siteId: SiteId): DescriptionKey {
  return `descriptions_${siteId}`;
}

async function loadMainList(siteId: SiteId): Promise<string[]> {
  const descKey = descriptionsKeyFor(siteId);
  // Use untyped get for legacy migration keys that are no longer in StorageSchema.
  const data = await chrome.storage.local.get([
    descKey,
    `filterPacks_${siteId}`,
    `activeFilterPack_${siteId}`,
    `activeFilterPacks_${siteId}`,
  ]);

  const legacyActiveSet = data[`activeFilterPacks_${siteId}`];
  if (Array.isArray(legacyActiveSet)) {
    const packs = (data[`filterPacks_${siteId}`] as Record<string, string[]> | undefined) ?? {};
    const seedNames = (legacyActiveSet as unknown[]).filter(
      (n): n is string => typeof n === 'string' && Boolean(packs[n])
    );
    const seen = new Set<string>();
    const mainList: string[] = [];
    for (const n of seedNames) {
      for (const p of packs[n] || []) {
        if (!seen.has(p)) { seen.add(p); mainList.push(p); }
      }
    }
    await chrome.storage.local.set({ [descKey]: mainList });
    await chrome.storage.local.remove([`activeFilterPack_${siteId}`, `activeFilterPacks_${siteId}`]);
    return mainList;
  }

  return Array.isArray(data[descKey])
    ? (data[descKey] as string[]).filter((p): p is string => typeof p === 'string')
    : [];
}

export async function getDescriptions(descriptionsKey: DescriptionKey): Promise<string[]> {
  return loadMainList(siteIdFromDescKey(descriptionsKey));
}

export async function setDescriptions(descriptionsKey: DescriptionKey, descriptions: string[]): Promise<void> {
  await chrome.storage.local.set({ [descriptionsKey]: descriptions });
}

// Default confidence threshold for the AI-text-detection worker. The worker
// returns a score in [0, 1]; posts at or above the active threshold are
// classified as AI-generated.
export const DEFAULT_AI_TEXT_DETECTION_THRESHOLD = 0.6;

// Default confidence threshold for the AI-image-detection worker. The worker
// returns a per-image score in [0, 1]; posts whose max score is at or above
// the active threshold are classified as AI-generated. Deliberately higher
// than the text default: image false-positives (photography, digital art)
// are common enough that only high-confidence detections should hide a post.
export const DEFAULT_AI_IMAGE_DETECTION_THRESHOLD = 0.9;

/** Clamp a stored threshold to [0, 1] and fall back to the default for missing/non-finite values. */
export function clampThreshold(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return DEFAULT_AI_TEXT_DETECTION_THRESHOLD;
  return Math.min(1, Math.max(0, v));
}

/** Same as clampThreshold but with the image-detector default. */
export function clampImageThreshold(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return DEFAULT_AI_IMAGE_DETECTION_THRESHOLD;
  return Math.min(1, Math.max(0, v));
}

// Default confidence threshold for AI-text detection on replies/comments.
// Deliberately lower than the main-post default: comments are short, so the
// detector's confidence rarely climbs as high as it does on full posts.
export const DEFAULT_AI_TEXT_REPLY_DETECTION_THRESHOLD = 0.5;

/** Same as clampThreshold but with the reply/comment default. */
export function clampReplyThreshold(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return DEFAULT_AI_TEXT_REPLY_DETECTION_THRESHOLD;
  return Math.min(1, Math.max(0, v));
}

/** Normalize a phrase set so the same phrases always produce the same key,
 *  regardless of order, casing, or duplicates. Lives here (not in
 *  background/ai-intent.ts, which builds on it) so the content script's
 *  storage-change listener can compare AI-phrase sets without pulling in
 *  background-only modules. */
export function phraseSetKey(categories: string[]): string {
  return [...new Set(categories.map(c => c.trim().toLowerCase()).filter(Boolean))]
    .sort()
    .join('\n');
}

/** True when the inferred "user wants AI content removed" state engages AI
 *  detection on ANY platform: at least one filter phrase, on any platform's
 *  list, was judged an AI-removal request. This is the cross-platform union —
 *  use it only for surfaces not tied to a platform (the popup's status row).
 *  Per-platform gating (detectors, the in-feed sparkle) goes through
 *  aiIntentActiveForSite below. The Array.isArray check also tolerates the
 *  pre-migration state shape, which lacked aiPhrases. */
export function aiIntentAutoActive(data: {
  aiFilterIntent?: AiFilterIntentState;
}): boolean {
  const phrases = data.aiFilterIntent?.aiPhrases;
  return Array.isArray(phrases) && phrases.length > 0;
}

/** Per-platform "AI detection is on": at least one of THIS platform's own
 *  filter phrases was judged an AI-removal request. The judged aiPhrases are
 *  a union across all platforms (background/ai-intent.ts judges the union so
 *  each phrase is judged once), so a platform's on/off state must intersect
 *  with its own phrase list — otherwise "AI slop" on X would engage the
 *  detectors and light the sparkle on LinkedIn too. There is still no manual
 *  toggle; detection turns on and off purely through the platform's
 *  natural-language filter phrases. */
export function aiIntentActiveForSite(
  data: { aiFilterIntent?: AiFilterIntentState },
  sitePhrases: string[],
): boolean {
  const aiPhrases = data.aiFilterIntent?.aiPhrases;
  if (!Array.isArray(aiPhrases) || aiPhrases.length === 0) return false;
  const aiKeys = new Set(aiPhrases.map(p => p.trim().toLowerCase()));
  return sitePhrases.some(p => aiKeys.has(p.trim().toLowerCase()));
}
