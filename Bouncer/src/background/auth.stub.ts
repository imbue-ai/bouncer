// Stub: auth not available (no Imbue backend configured at build time)
// Matches the export interface of auth.ts so all imports compile unchanged.

export function getAuthToken(): Promise<string | null> {
  return Promise.resolve(null);
}

export function launchAuthFlow(): Promise<string | null> {
  return Promise.resolve(null);
}

export function refreshAuthToken(): Promise<string | null> {
  return Promise.resolve(null);
}
