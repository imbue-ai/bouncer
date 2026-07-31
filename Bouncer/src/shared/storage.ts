import type {
  ActiveFilterPackKey,
  ActiveFilterPacksKey,
  AiFilterIntentState,
  DescriptionKey,
  FilterPackColorsKey,
  FilterPacksKey,
  FilterPacksOrderKey,
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

export const DEFAULT_FILTER_PACK_NAME = 'Default';

function siteIdFromDescKey(key: DescriptionKey): SiteId {
  return key.slice('descriptions_'.length) as SiteId;
}

function descriptionsKeyFor(siteId: SiteId): DescriptionKey {
  return `descriptions_${siteId}`;
}

export function filterPacksKeyFor(siteId: SiteId): FilterPacksKey {
  return `filterPacks_${siteId}`;
}

export function activeFilterPackKeyFor(siteId: SiteId): ActiveFilterPackKey {
  return `activeFilterPack_${siteId}`;
}

export function activeFilterPacksKeyFor(siteId: SiteId): ActiveFilterPacksKey {
  return `activeFilterPacks_${siteId}`;
}

export function filterPacksOrderKeyFor(siteId: SiteId): FilterPacksOrderKey {
  return `filterPacksOrder_${siteId}`;
}

export function filterPackColorsKeyFor(siteId: SiteId): FilterPackColorsKey {
  return `filterPackColors_${siteId}`;
}

export function filteringPausedKeyFor(siteId: SiteId): `filteringPaused_${SiteId}` {
  return `filteringPaused_${siteId}`;
}

/** Read whether phrase filtering is paused for this site. */
export async function getFilteringPaused(siteId: SiteId): Promise<boolean> {
  const key = filteringPausedKeyFor(siteId);
  const data = await chrome.storage.local.get([key]);
  return data[key] === true;
}

/** Persist whether phrase filtering is paused for this site. */
export async function setFilteringPaused(siteId: SiteId, paused: boolean): Promise<void> {
  const key = filteringPausedKeyFor(siteId);
  await chrome.storage.local.set({ [key]: paused });
}

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

function normalizeHex(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const trimmed = v.trim();
  const prefixed = trimmed.startsWith('#') ? trimmed : `#${trimmed}`;
  return HEX_RE.test(prefixed) ? prefixed.toUpperCase() : null;
}

/** Read the stored color map (packName → "#RRGGBB"). Every rendered pack should have an entry here; any that don't are backfilled positionally on the next syncPackBadges pass. */
export async function getFilterPackColors(siteId: SiteId): Promise<Record<string, string>> {
  const key = filterPackColorsKeyFor(siteId);
  const data = await chrome.storage.local.get([key]);
  const raw = data[key];
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const hex = normalizeHex(v);
    if (hex !== null) out[k] = hex;
  }
  return out;
}

/** Persist the user's chosen color for a single pack. Throws on invalid hex. */
export async function setFilterPackColor(siteId: SiteId, name: string, color: string): Promise<void> {
  const hex = normalizeHex(color);
  if (hex === null) throw new Error(`Invalid pack color: ${color}`);
  const key = filterPackColorsKeyFor(siteId);
  const current = await getFilterPackColors(siteId);
  const next = { ...current, [name]: hex };
  await chrome.storage.local.set({ [key]: next });
}

/** Merge multiple pack colors in one storage write. Invalid hex entries are dropped silently. */
export async function mergeFilterPackColors(siteId: SiteId, colors: Record<string, string>): Promise<void> {
  const normalized: Record<string, string> = {};
  for (const [name, color] of Object.entries(colors)) {
    const hex = normalizeHex(color);
    if (hex !== null) normalized[name] = hex;
  }
  if (Object.keys(normalized).length === 0) return;
  const key = filterPackColorsKeyFor(siteId);
  const current = await getFilterPackColors(siteId);
  const next = { ...current, ...normalized };
  await chrome.storage.local.set({ [key]: next });
}

/**
 * Merge an explicit order list with the actual pack map to produce display order.
 * Names in `rawOrder` come first (filtered to only those that exist in `packs`);
 * any remaining pack names — installs predating the order key, or packs created
 * by an older tab — are appended in Object.keys order so nothing disappears.
 */
function computeOrderedNames(packs: Record<string, string[]>, rawOrder: unknown): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  if (Array.isArray(rawOrder)) {
    for (const n of rawOrder) {
      if (typeof n === 'string' && packs[n] && !seen.has(n)) {
        seen.add(n);
        out.push(n);
      }
    }
  }
  for (const n of Object.keys(packs)) {
    if (!seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  }
  return out;
}

interface PacksState {
  packs: Record<string, string[]>;
  orderedNames: string[];
  mainList: string[];
  activeSet: string[];
  packsInitialized: boolean;
}

/**
 * Initial active set inferred from the main list — used on first load after
 * upgrading from the derived-active model. A pack is seeded as active iff it
 * has phrases AND every one of those phrases is present in the main list.
 * After this one-shot derivation we persist the active set, so subsequent
 * reads use the explicit set even if descriptions later drift.
 */
function deriveInitialActiveSet(
  packs: Record<string, string[]>,
  orderedNames: string[],
  mainList: string[],
): string[] {
  const mainSet = new Set(mainList);
  const out: string[] = [];
  for (const name of orderedNames) {
    const phrases = packs[name];
    if (!phrases) continue;
    if (phrases.length > 0 && phrases.every(p => mainSet.has(p))) out.push(name);
  }
  return out;
}

/**
 * Read packs + ordered names + the main filter list + the explicit active set.
 *
 * The active set is the source of truth for which packs are "on". The main
 * list (descriptions) holds the actual phrases used for filtering — its
 * contents are the union of active packs' phrases plus any free phrases the
 * user typed directly. On first read after upgrade (no `activeFilterPacks_*`
 * key yet) we derive the set from descriptions and persist it.
 */
async function loadState(siteId: SiteId): Promise<PacksState> {
  const packsKey = filterPacksKeyFor(siteId);
  const orderKey = filterPacksOrderKeyFor(siteId);
  const descKey = descriptionsKeyFor(siteId);
  const activeKey = activeFilterPackKeyFor(siteId);
  const activeSetKey = activeFilterPacksKeyFor(siteId);
  const data = await chrome.storage.local.get([packsKey, orderKey, descKey, activeKey, activeSetKey]);
  const packsInitialized = data[packsKey] !== undefined;
  const packs = (data[packsKey] as Record<string, string[]> | undefined) ?? {};
  const orderedNames = computeOrderedNames(packs, data[orderKey]);
  const mainList = Array.isArray(data[descKey])
    ? (data[descKey] as string[]).filter((p): p is string => typeof p === 'string')
    : [];

  const storedActive = data[activeSetKey];
  let activeSet: string[];
  if (Array.isArray(storedActive)) {
    activeSet = (storedActive as unknown[]).filter(
      (n): n is string => typeof n === 'string' && Boolean(packs[n])
    );
  } else {
    activeSet = deriveInitialActiveSet(packs, orderedNames, mainList);
    // One-shot upgrade write. Skip it when no packs key exists (fresh
    // install / pack-less user): the derived set is empty and re-deriving
    // it on every read is free, while writing here would churn storage —
    // and every storage.onChanged listener — on a plain read path.
    if (packsInitialized) {
      await chrome.storage.local.set({ [activeSetKey]: activeSet });
    }
  }

  // Drop the long-deprecated singular `activeFilterPack_<siteId>` key if it
  // still lingers from very old installs — keeps storage tidy.
  if (data[activeKey] !== undefined) {
    await chrome.storage.local.remove([activeKey]);
  }

  return { packs, orderedNames, mainList, activeSet, packsInitialized };
}

async function writeMainList(siteId: SiteId, _oldList: string[], newList: string[]): Promise<void> {
  await chrome.storage.local.set({ [descriptionsKeyFor(siteId)]: newList });
}

/** Read the main filter list (the phrases actually used to filter posts). */
export async function getDescriptions(descriptionsKey: DescriptionKey): Promise<string[]> {
  const siteId = siteIdFromDescKey(descriptionsKey);
  const { mainList } = await loadState(siteId);
  return mainList;
}

/** Read the main filter list directly by siteId. */
export async function getMainList(siteId: SiteId): Promise<string[]> {
  const { mainList } = await loadState(siteId);
  return mainList;
}

/**
 * Replace the main filter list directly. Used for free-phrase edits (the
 * user typing or removing individual phrases outside any pack); does not
 * change which packs are active.
 */
export async function setDescriptions(descriptionsKey: DescriptionKey, descriptions: string[]): Promise<void> {
  const siteId = siteIdFromDescKey(descriptionsKey);
  const { mainList } = await loadState(siteId);
  await writeMainList(siteId, mainList, descriptions);
}

/**
 * Replace a specific pack's phrase list. If the pack is currently active,
 * the main list is also updated so descriptions stays consistent: newly-added
 * phrases are appended, and removed phrases are dropped from descriptions
 * unless another active pack still claims them.
 */
export async function setPackPhrases(siteId: SiteId, packName: string, phrases: string[]): Promise<void> {
  const { packs, mainList, activeSet } = await loadState(siteId);
  const oldPhrases = packs[packName] || [];
  const newPacks: Record<string, string[]> = { ...packs, [packName]: phrases };

  const writes: Record<string, unknown> = {
    [filterPacksKeyFor(siteId)]: newPacks,
  };

  if (activeSet.includes(packName)) {
    const newPackSet = new Set(phrases);
    const removed = oldPhrases.filter(p => !newPackSet.has(p));

    // Phrases still claimed by *other* active packs must be retained in the main list.
    const otherActiveClaimed = new Set<string>();
    for (const n of activeSet) {
      if (n === packName) continue;
      for (const p of newPacks[n] || []) otherActiveClaimed.add(p);
    }
    const actualRemoved = new Set(removed.filter(p => !otherActiveClaimed.has(p)));

    let newList = actualRemoved.size > 0
      ? mainList.filter(p => !actualRemoved.has(p))
      : mainList;

    const present = new Set(newList);
    const additions: string[] = [];
    for (const p of phrases) {
      if (!present.has(p)) {
        present.add(p);
        additions.push(p);
      }
    }
    if (additions.length > 0) {
      newList = newList === mainList ? [...mainList, ...additions] : [...newList, ...additions];
    }
    if (newList !== mainList) {
      writes[descriptionsKeyFor(siteId)] = newList;
    }
  }

  await chrome.storage.local.set(writes);
}

/** Read all filter packs for a site, synthesizing a Default pack from legacy storage if needed. */
export async function getFilterPacks(siteId: SiteId): Promise<Record<string, string[]>> {
  const { packs, mainList, packsInitialized } = await loadState(siteId);
  if (packsInitialized) return packs;
  if (Object.keys(packs).length > 0) return packs;
  // Only synthesize a Default pack when there's a legacy phrase list to
  // migrate. Fresh installs (no packs key, no descriptions) get no pack.
  if (mainList.length === 0) return {};
  return { [DEFAULT_FILTER_PACK_NAME]: mainList };
}

/** Read filter-pack names in display order. */
export async function getFilterPackNames(siteId: SiteId): Promise<string[]> {
  const { packs, mainList, orderedNames, packsInitialized } = await loadState(siteId);
  if (packsInitialized) return orderedNames;
  if (Object.keys(packs).length > 0) return orderedNames;
  if (mainList.length === 0) return [];
  return [DEFAULT_FILTER_PACK_NAME];
}

/** Read the explicit set of active pack names, returned in display order. */
export async function getActiveFilterPacks(siteId: SiteId): Promise<string[]> {
  const { orderedNames, activeSet } = await loadState(siteId);
  const set = new Set(activeSet);
  return orderedNames.filter(n => set.has(n));
}

/** Activate a pack: add to the explicit active set and union its phrases into the main list. */
export async function activateFilterPack(siteId: SiteId, name: string): Promise<void> {
  const { packs, mainList, activeSet } = await loadState(siteId);
  const phrases = packs[name];
  if (!phrases) return;
  if (activeSet.includes(name)) return;

  const newActive = [...activeSet, name];
  const seen = new Set(mainList);
  const newList = [...mainList];
  for (const p of phrases) {
    if (!seen.has(p)) { seen.add(p); newList.push(p); }
  }

  const writes: Record<string, unknown> = {
    [activeFilterPacksKeyFor(siteId)]: newActive,
  };
  if (newList.length !== mainList.length) {
    writes[descriptionsKeyFor(siteId)] = newList;
  }
  await chrome.storage.local.set(writes);
}

/**
 * Deactivate a pack: remove it from the explicit active set, and drop its
 * phrases from the main list — but keep any phrases that another still-active
 * pack also lists.
 */
export async function deactivateFilterPack(siteId: SiteId, name: string): Promise<void> {
  const { packs, mainList, activeSet } = await loadState(siteId);
  if (!activeSet.includes(name)) return;
  const phrases = packs[name] || [];

  const newActive = activeSet.filter(n => n !== name);
  const stillClaimed = new Set<string>();
  for (const n of newActive) {
    for (const p of packs[n] || []) stillClaimed.add(p);
  }
  const toRemove = new Set(phrases.filter(p => !stillClaimed.has(p)));
  const newList = toRemove.size > 0
    ? mainList.filter(p => !toRemove.has(p))
    : mainList;

  const writes: Record<string, unknown> = {
    [activeFilterPacksKeyFor(siteId)]: newActive,
  };
  if (newList !== mainList) {
    writes[descriptionsKeyFor(siteId)] = newList;
  }
  await chrome.storage.local.set(writes);
}

const MAX_PACK_NAME_LENGTH = 40;

function validatePackName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('Pack name cannot be empty');
  if (trimmed.length > MAX_PACK_NAME_LENGTH) {
    throw new Error(`Pack name cannot exceed ${MAX_PACK_NAME_LENGTH} characters`);
  }
  return trimmed;
}

/** Create a new empty pack. Throws if the name is invalid or already exists. */
export async function createFilterPack(siteId: SiteId, name: string, color?: string): Promise<string> {
  const trimmed = validatePackName(name);
  const { packs, orderedNames } = await loadState(siteId);
  if (packs[trimmed]) throw new Error('A pack with that name already exists');
  // Don't auto-add a Default pack alongside the new one — getFilterPacks
  // synthesizes Default at read time only when no packs are persisted, so any
  // free-typed phrases keep rendering as free phrases (they live in the main
  // descriptions list, not in any pack). Baking an empty Default in here
  // produced a phantom badge users had no way to dismiss.
  const newPacks = { ...packs, [trimmed]: [] };
  const newOrder = orderedNames.includes(trimmed) ? orderedNames : [...orderedNames, trimmed];
  const writes: Record<string, unknown> = {
    [filterPacksKeyFor(siteId)]: newPacks,
    [filterPacksOrderKeyFor(siteId)]: newOrder,
  };
  // Write the pack's color in the same set() so the pack never exists in
  // storage without one. Any subsequent rename remaps both entries atomically.
  if (color !== undefined) {
    const hex = normalizeHex(color);
    if (hex === null) throw new Error(`Invalid pack color: ${color}`);
    const currentColors = await getFilterPackColors(siteId);
    writes[filterPackColorsKeyFor(siteId)] = { ...currentColors, [trimmed]: hex };
  }
  await chrome.storage.local.set(writes);
  return trimmed;
}

/** Rename a pack. The active-set entry, if present, is renamed in place. */
export async function renameFilterPack(siteId: SiteId, oldName: string, newName: string): Promise<string> {
  const trimmed = validatePackName(newName);
  if (trimmed === oldName) return oldName;
  const { packs, orderedNames, activeSet } = await loadState(siteId);
  const effectivePacks = Object.keys(packs).length > 0 ? packs : await getFilterPacks(siteId);
  if (!effectivePacks[oldName]) throw new Error('Pack not found');
  if (effectivePacks[trimmed]) throw new Error('A pack with that name already exists');
  const newPacks: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(effectivePacks)) {
    newPacks[k === oldName ? trimmed : k] = v;
  }
  const baseOrder = orderedNames.length > 0 ? orderedNames : Object.keys(effectivePacks);
  const newOrder = baseOrder.map(n => n === oldName ? trimmed : n);

  const writes: Record<string, unknown> = {
    [filterPacksKeyFor(siteId)]: newPacks,
    [filterPacksOrderKeyFor(siteId)]: newOrder,
  };
  if (activeSet.includes(oldName)) {
    writes[activeFilterPacksKeyFor(siteId)] = activeSet.map(n => n === oldName ? trimmed : n);
  }

  // Carry user-chosen color across the rename so the swatch stays put.
  const colors = await getFilterPackColors(siteId);
  if (colors[oldName] !== undefined) {
    const nextColors: Record<string, string> = {};
    for (const [k, v] of Object.entries(colors)) {
      nextColors[k === oldName ? trimmed : k] = v;
    }
    writes[filterPackColorsKeyFor(siteId)] = nextColors;
  }

  await chrome.storage.local.set(writes);
  return trimmed;
}

/**
 * Delete a pack. If the pack was active, its phrases are removed from the
 * main list (excluding any still claimed by another active pack), and the
 * pack name is dropped from the active set.
 */
export async function deleteFilterPack(siteId: SiteId, name: string): Promise<void> {
  const { packs, orderedNames, mainList, activeSet } = await loadState(siteId);
  if (!packs[name]) throw new Error('Pack not found');

  const newPacks = { ...packs };
  delete newPacks[name];
  const baseOrder = orderedNames.length > 0 ? orderedNames : Object.keys(packs);
  const newOrder = baseOrder.filter(n => n !== name);

  const writes: Record<string, unknown> = {
    [filterPacksKeyFor(siteId)]: newPacks,
    [filterPacksOrderKeyFor(siteId)]: newOrder,
  };

  if (activeSet.includes(name)) {
    const newActive = activeSet.filter(n => n !== name);
    const stillClaimed = new Set<string>();
    for (const n of newActive) {
      for (const p of newPacks[n] || []) stillClaimed.add(p);
    }
    const toRemove = new Set((packs[name] || []).filter(p => !stillClaimed.has(p)));
    const newList = toRemove.size > 0
      ? mainList.filter(p => !toRemove.has(p))
      : mainList;
    writes[activeFilterPacksKeyFor(siteId)] = newActive;
    if (newList !== mainList) {
      writes[descriptionsKeyFor(siteId)] = newList;
    }
  }

  // Drop any user-chosen color for this pack — the name is going away.
  const colors = await getFilterPackColors(siteId);
  if (colors[name] !== undefined) {
    const nextColors = { ...colors };
    delete nextColors[name];
    writes[filterPackColorsKeyFor(siteId)] = nextColors;
  }

  await chrome.storage.local.set(writes);
}

// Default confidence threshold for the AI-text-detection worker. The worker
// returns a score in [0, 1]; posts at or above the active threshold are
// classified as AI-generated.
export const DEFAULT_AI_TEXT_DETECTION_THRESHOLD = 0.9;

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
export const DEFAULT_AI_TEXT_REPLY_DETECTION_THRESHOLD = 0.9;

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
