export interface SuggestedPack {
  id: string;
  name: string;
  phrases: string[];
}

// Hosted from Bouncer/hosting/ via Cloudflare Pages (see hosting/README.md).
// Domain is per-env: prod → bouncer.imbue.com, dev → bouncer-dev.imbue.com.
const PACKS_URL = `https://${process.env.BOUNCER_SIGNIN_DOMAIN}/v1/en/packs.json`;
const FETCH_TIMEOUT_MS = 5000;

function isValidPack(p: unknown): p is SuggestedPack {
  if (!p || typeof p !== 'object') return false;
  const { id, name, phrases } = p as Record<string, unknown>;
  return (
    typeof id === 'string' && id.length > 0 &&
    typeof name === 'string' && name.length > 0 &&
    Array.isArray(phrases) && phrases.every(ph => typeof ph === 'string')
  );
}

async function fetchPacks(): Promise<SuggestedPack[]> {
  try {
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('timeout')), FETCH_TIMEOUT_MS)
    );
    const fetchPromise = chrome.runtime.sendMessage<{ type: 'fetchUrl'; url: string }, { data?: unknown; error?: string }>({ type: 'fetchUrl', url: PACKS_URL });
    const result = await Promise.race([fetchPromise, timeoutPromise]);
    if (!result || result.error || !result.data) return [];
    const data = result.data;
    if (!data || typeof data !== 'object') return [];
    const { packs } = data as Record<string, unknown>;
    if (!Array.isArray(packs)) return [];
    return packs.filter(isValidPack);
  } catch {
    return [];
  }
}

// Fetched once per page load; subsequent calls return the cached promise.
let cache: Promise<SuggestedPack[]> | null = null;

export function getSuggestedPacks(): Promise<SuggestedPack[]> {
  if (!cache) cache = fetchPacks();
  return cache;
}
