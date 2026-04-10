import type { DescriptionKey, StorageSchema } from '../types';

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

/** Get the descriptions array for a given site-specific key (e.g. "descriptions_twitter"). */
export async function getDescriptions(descriptionsKey: DescriptionKey): Promise<string[]> {
  const data = await getStorage([descriptionsKey]);
  return data[descriptionsKey] || [];
}

/** Set the descriptions array for a given site-specific key. */
export async function setDescriptions(descriptionsKey: DescriptionKey, descriptions: string[]): Promise<void> {
  await setStorage({ [descriptionsKey]: descriptions } as Partial<StorageSchema>);
}
