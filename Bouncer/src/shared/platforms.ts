// Platform registry — single source of truth for everything Bouncer needs
// to know about a supported site. Adding a new platform is:
//   - one entry in PLATFORM_IDS + PLATFORM_RUNTIME below
//   - one entry in platforms.config.json (consumed by both the TS bundle
//     and the build-time manifest generator)
//   - the adapter implementation itself
//
// `platforms.config.json` is the JSON-safe slice (id + manifest host +
// asset paths) so build.js can read the same data without parsing TS.
// `PLATFORM_RUNTIME` here adds the runtime-only fields (RegExp, display
// name, feed URL) and the two are joined into the public `PLATFORMS`
// array via a registry-id lookup.

import platformsConfig from './platforms.config.json';

/** Literal-tuple of every supported platform id. SiteId is derived from
 *  this, so adding a new platform automatically extends the union — there
 *  is no longer a separate type alias to keep in sync. */
export const PLATFORM_IDS = ['twitter', 'youtube', 'linkedin'] as const;

export type SiteId = typeof PLATFORM_IDS[number];

/** Build-time data each platform contributes to the manifest. Lives in
 *  platforms.config.json so generate-manifests.mjs can read it without
 *  needing a TS toolchain. */
export interface PlatformBuildConfig {
  readonly id: SiteId;
  /** Pattern used in host_permissions, content_scripts, and
   *  web_accessible_resources matches. */
  readonly manifestHost: string;
  /** Path to the bundled adapter JS, relative to the extension root. */
  readonly adapterScript: string;
  /** Path to the platform's stylesheet, relative to the extension root. */
  readonly cssPath: string;
  /** Additional web-accessible files this platform's adapter loads via
   *  chrome.runtime.getURL (page-world helper scripts, etc.). */
  readonly extraWebAccessible: readonly string[];
}

/** Runtime-only fields — RegExp can't live in JSON; everything else is
 *  purely for the in-app code paths and not needed at manifest-gen time. */
interface PlatformRuntimeOnly {
  /** Human-facing display name (popup labels, picker rows). */
  readonly displayName: string;
  /** Regex matched against `location.hostname` for self-guarding adapters. */
  readonly hostPattern: RegExp;
  /** Where the platform's feed lives. */
  readonly feedUrl: string;
  /** Optional alternate URL for first-launch when the user is not signed
   *  in (X has a login flow; YouTube/LinkedIn don't gate this way). */
  readonly loginUrl?: string;
}

const PLATFORM_RUNTIME: Record<SiteId, PlatformRuntimeOnly> = {
  twitter: {
    displayName: 'X (Twitter)',
    hostPattern: /(^|\.)(x|twitter)\.com$/i,
    feedUrl: 'https://x.com/home',
    loginUrl: 'https://x.com/i/flow/login',
  },
  youtube: {
    displayName: 'YouTube',
    hostPattern: /(^|\.)(m\.)?youtube\.com$/i,
    feedUrl: 'https://www.youtube.com/',
  },
  linkedin: {
    displayName: 'LinkedIn',
    hostPattern: /(^|\.)linkedin\.com$/i,
    feedUrl: 'https://www.linkedin.com/feed/',
  },
};

export type PlatformDef = PlatformBuildConfig & PlatformRuntimeOnly;

/** Joined registry: build-config (from JSON) + runtime fields. */
export const PLATFORMS: readonly PlatformDef[] =
  (platformsConfig as readonly PlatformBuildConfig[]).map(cfg => ({
    ...cfg,
    ...PLATFORM_RUNTIME[cfg.id],
  }));

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
