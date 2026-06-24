// Platform registry — single source of truth for everything Bouncer needs
// to know about a supported site. Adding a new platform should be one entry
// here (plus the adapter implementation itself); other call sites read from
// the registry instead of hardcoding ids.
//
// Phase 1 of the registry refactor keeps `SiteId` declared in types.ts so
// the rest of the codebase keeps importing it from the same place. A later
// phase will derive `SiteId` from the registry literal so the union and the
// registry can't drift.

import type { SiteId } from '../types';

export interface PlatformDef {
  /** Canonical short identifier used as the storage-key suffix and the
   *  `adapter.siteId` value. */
  readonly id: SiteId;
  /** Human-facing display name (popup labels, picker rows). */
  readonly displayName: string;
  /** Regex matched against `location.hostname` for self-guarding adapters. */
  readonly hostPattern: RegExp;
  /** Pattern used in `manifest.base.json` host_permissions / content_scripts /
   *  web_accessible_resources. Kept here for documentation; the manifest itself
   *  is still hand-edited (a later phase will generate it from this field). */
  readonly manifestHost: string;
  /** Where the platform's feed lives. The iOS WebView navigates here when the
   *  user picks the platform; some flows also use it as a "go to feed" target. */
  readonly feedUrl: string;
  /** Optional alternate URL for first-launch on the platform when the user is
   *  not signed in (X has a login flow; YouTube/LinkedIn don't gate this way). */
  readonly loginUrl?: string;
}

export const PLATFORMS: readonly PlatformDef[] = [
  {
    id: 'twitter',
    displayName: 'X (Twitter)',
    hostPattern: /(^|\.)(x|twitter)\.com$/i,
    manifestHost: 'https://x.com/*',
    feedUrl: 'https://x.com/home',
    loginUrl: 'https://x.com/i/flow/login',
  },
  {
    id: 'youtube',
    displayName: 'YouTube',
    hostPattern: /(^|\.)(m\.)?youtube\.com$/i,
    manifestHost: 'https://www.youtube.com/*',
    feedUrl: 'https://www.youtube.com/',
  },
  {
    id: 'linkedin',
    displayName: 'LinkedIn',
    hostPattern: /(^|\.)linkedin\.com$/i,
    manifestHost: 'https://www.linkedin.com/*',
    feedUrl: 'https://www.linkedin.com/feed/',
  },
];

// ---------------------------------------------------------------------------
// Lookup helpers
// ---------------------------------------------------------------------------

/** Find a platform by its canonical id. Returns undefined for unknown ids. */
export function platformById(id: string): PlatformDef | undefined {
  return PLATFORMS.find(p => p.id === id);
}

/** Find a platform whose host pattern matches the given hostname. */
export function platformFromHost(host: string): PlatformDef | undefined {
  return PLATFORMS.find(p => p.hostPattern.test(host));
}

// ---------------------------------------------------------------------------
// Derived storage-key helpers — every consumer of "{id}Enabled" /
// "descriptions_{id}" goes through these instead of building the strings
// inline, so adding a new platform doesn't require teaching the rest of the
// codebase about a new literal.
// ---------------------------------------------------------------------------

/** chrome.storage.local key for the per-platform master enable toggle. */
export function enabledStorageKey(id: SiteId): `${SiteId}Enabled` {
  return `${id}Enabled`;
}

/** chrome.storage.local key for the per-platform filter-phrase list. */
export function descriptionsStorageKey(id: SiteId): `descriptions_${SiteId}` {
  return `descriptions_${id}`;
}
