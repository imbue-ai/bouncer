// Platform registry — single source of truth for everything Bouncer needs
// to know about a supported site. There is exactly ONE source: the JSON
// file `platforms.config.json`. Adding a platform (or changing which builds
// it ships on) is a single edit there. Every consumer reads from it:
//   - this TS registry (content script, popup, background pipeline)
//   - the build-time manifest generator (generate-manifests.mjs)
//   - the iOS app's native picker / WebView injection (Platforms.swift,
//     which decodes the same bundled JSON)
//
// A platform is present on a given build only when its `targets` array
// includes that build's target. `PLATFORMS` below is already filtered to
// the current build target, so a platform absent from this build never
// appears in any UI, storage key, or pipeline loop — no partial state.

import platformsConfig from './platforms.config.json';

/** Literal-tuple of every supported platform id. SiteId is the union of
 *  ids the codebase understands; platforms.config.json supplies a subset of
 *  these (whichever are actually shipped) along with their runtime data. */
export const PLATFORM_IDS = ['twitter', 'youtube', 'linkedin'] as const;

export type SiteId = typeof PLATFORM_IDS[number];

/** Build target a platform can ship on. Mirrors build.js `--target=` and
 *  generate-manifests.mjs. `safari` covers the iOS + macOS apps. */
export type BuildTarget = 'chrome' | 'firefox' | 'safari';

/** The complete, JSON-serializable record for one platform. This is the
 *  shape stored in platforms.config.json and shared verbatim by the TS
 *  bundle, the manifest generator, and (decoded) the iOS app. Everything a
 *  platform needs lives here so no consumer has to hardcode it. */
export interface PlatformConfig {
  readonly id: SiteId;
  /** Human-facing display name (popup labels, picker rows). */
  readonly displayName: string;
  /** Builds this platform ships on. Filters host_permissions /
   *  content_scripts (manifest), `PLATFORMS` (this file), and the iOS
   *  picker (Platforms.swift). */
  readonly targets: readonly BuildTarget[];
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
  /** Where the platform's feed lives. */
  readonly feedUrl: string;
  /** Alternate URL for first-launch when the user is not signed in (X has a
   *  login flow; LinkedIn/YouTube don't gate this way). `null` when unused. */
  readonly loginUrl: string | null;
  /** Every host this platform owns — the primary site plus related CDN /
   *  API domains. Root + subdomain matches derive `hostPattern`, and the
   *  iOS WebView's navigation guard flat-maps these into its allowlist. */
  readonly hostRoots: readonly string[];
}

/** Build the runtime host-matching RegExp from `hostRoots`: matches each
 *  root exactly or as a subdomain (`x.com` and `mobile.x.com`, not
 *  `notx.com`). Mirrors Platforms.swift `matches(host:)`. */
function hostPatternFor(hostRoots: readonly string[]): RegExp {
  const alternation = hostRoots
    .map(root => root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  return new RegExp(`(^|\\.)(${alternation})$`, 'i');
}

export type PlatformDef = PlatformConfig & {
  /** Regex matched against `location.hostname`, derived from `hostRoots`. */
  readonly hostPattern: RegExp;
};

/** Current build target. build.js replaces `process.env.BOUNCER_TARGET`
 *  with a literal at bundle time; outside a build (e.g. vitest) it is
 *  undefined and we fall back to `chrome`. */
const CURRENT_TARGET: BuildTarget =
  (process.env.BOUNCER_TARGET as BuildTarget) || 'chrome';

/** Platforms shipped on THIS build, with the derived host pattern attached.
 *  Filtered by `targets`, so a platform not shipping on this target is
 *  invisible to every downstream consumer. */
export const PLATFORMS: readonly PlatformDef[] =
  (platformsConfig as readonly PlatformConfig[])
    .filter(cfg => cfg.targets.includes(CURRENT_TARGET))
    .map(cfg => ({ ...cfg, hostPattern: hostPatternFor(cfg.hostRoots) }));

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
