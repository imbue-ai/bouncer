// Stub: auth not available (no Imbue backend configured at build time).
// Mirrors auth.ts's export surface so every importer compiles unchanged;
// each function resolves to a no-op so callers transparently fall through
// to BYOK / local-model paths.

export const IS_SAFARI = typeof (globalThis as unknown as { browser?: unknown }).browser !== 'undefined' && typeof chrome.identity?.getRedirectURL !== 'function';

export function getAuthToken(): Promise<string | null> {
  return Promise.resolve(null);
}

export function signOut(): Promise<void> {
  return Promise.resolve();
}

export function launchAuthFlow(_method?: string): Promise<string | null> {
  return Promise.resolve(null);
}

export function handleAppleSignIn(
  _idToken: string,
  _rawNonce: string,
  _firebaseToken?: string,
  _providerId?: string,
): Promise<string | null> {
  return Promise.resolve(null);
}

export function refreshAuthToken(): Promise<string | null> {
  return Promise.resolve(null);
}
