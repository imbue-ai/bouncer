import type {
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
  return `descriptions_${siteId}` as DescriptionKey;
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
export const DEFAULT_AI_TEXT_DETECTION_THRESHOLD = 0.7;

/** Clamp a stored threshold to [0, 1] and fall back to the default for missing/non-finite values. */
export function clampThreshold(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return DEFAULT_AI_TEXT_DETECTION_THRESHOLD;
  return Math.min(1, Math.max(0, v));
}
