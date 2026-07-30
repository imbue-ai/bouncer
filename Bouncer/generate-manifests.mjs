// Merges manifest.base.json + manifest.<target>.json and writes manifest.json.
// Usage:
//   node generate-manifests.mjs [--target=<chrome|firefox|safari>]
// Default target is chrome. Also exported for use by build.js.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const VALID_TARGETS = new Set(['chrome', 'firefox', 'safari']);

function readJSON(filename) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, filename), 'utf8'));
}

// Deep merge with array concat. Arrays from override are appended to base
// arrays; objects are merged recursively; scalars are replaced.
function deepMerge(base, override) {
  if (override === undefined) return base;
  if (Array.isArray(base) && Array.isArray(override)) {
    return [...base, ...override];
  }
  const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  if (isPlainObject(base) && isPlainObject(override)) {
    const result = { ...base };
    for (const key of Object.keys(override)) {
      result[key] = deepMerge(base[key], override[key]);
    }
    return result;
  }
  return override;
}

// Read the shared platform registry. The TS bundle imports the same file
// (Bouncer/src/shared/platforms.ts) so any host / asset path used by the
// manifest stays in lockstep with the in-app code.
function readPlatformConfig() {
  return JSON.parse(
    fs.readFileSync(path.join(ROOT, 'src/shared/platforms.config.json'), 'utf8')
  );
}

// Synthesize per-platform manifest entries from the registry. Adding a new
// platform here is automatic: drop an entry in platforms.config.json and
// host_permissions, content_scripts, and web_accessible_resources all gain
// the corresponding rows — but only on the build targets listed in that
// entry's `targets` array.
//
// Platforms listing this target in `optionalTargets` are deliberately kept
// OUT of host_permissions and content_scripts: a published update that adds
// new required host permissions (or static content scripts, whose match
// patterns count as host permissions) gets the extension disabled for every
// existing user until they re-approve. Those platforms land in
// optional_host_permissions — silent on update — and their content scripts
// are registered at runtime once the user grants access (see
// src/background/optional-platforms.ts, which builds the same js/css lists
// via contentScripts() in src/shared/platforms.ts).
// web_accessible_resources `matches` are not permissions and trigger no
// warning, so optional platforms may appear there statically.
function platformsToManifestSlice(target) {
  const platforms = readPlatformConfig().filter(p => p.targets.includes(target));
  const optional = platforms.filter(p => (p.optionalTargets ?? []).includes(target));
  const required = platforms.filter(p => !optional.includes(p));
  const sharedContentJs = ['browser-polyfill.js', 'dompurify.js'];
  const sharedContentCss = ['content.css'];
  // The standard adapter + pipeline pair, plus any platform-specific extras
  // (MAIN-world hooks, standalone bundles) declared in the registry.
  const contentScriptsFor = (p) => [
    {
      matches: [p.manifestHost],
      js: [...sharedContentJs, p.adapterScript, 'dist/content.js'],
      css: [...sharedContentCss, p.cssPath],
      run_at: 'document_idle',
    },
    ...(p.extraContentScripts ?? []).map(s => ({
      matches: [p.manifestHost],
      js: [...s.js],
      ...(s.css ? { css: [...s.css] } : {}),
      run_at: s.runAt ?? 'document_idle',
      ...(s.world ? { world: s.world } : {}),
    })),
  ];
  return {
    host_permissions: required.map(p => p.manifestHost),
    ...(optional.length > 0
      ? { optional_host_permissions: optional.map(p => p.manifestHost) }
      : {}),
    content_scripts: required.flatMap(contentScriptsFor),
    web_accessible_resources: [
      {
        resources: [
          'popup.html',
          'popup.css',
          'dist/popup.js',
          'browser-polyfill.js',
          ...platforms.flatMap(p => p.extraWebAccessible ?? []),
          'icons/a-bouncer-2x-black.png',
          'icons/icon48.png',
        ],
        matches: platforms.map(p => p.manifestHost),
      },
    ],
  };
}

export function generateManifest(target = 'chrome') {
  if (!VALID_TARGETS.has(target)) {
    throw new Error(`Unknown target: ${target}. Expected one of: ${[...VALID_TARGETS].join(', ')}`);
  }
  const base = readJSON('manifest.base.json');
  const override = readJSON(`manifest.${target}.json`);
  // Per-platform manifest fields come from the shared registry, so the JSON
  // template doesn't have to repeat them for every platform. Filtered to the
  // platforms whose `targets` include this build target.
  const platformSlice = platformsToManifestSlice(target);
  const merged = deepMerge(deepMerge(base, platformSlice), override);
  const outPath = path.join(ROOT, 'manifest.json');
  fs.writeFileSync(outPath, JSON.stringify(merged, null, 2) + '\n');
  console.log(`Generated manifest.json for target=${target}`);
  return merged;
}

// Run as a script when invoked directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const targetArg = process.argv.find((a) => a.startsWith('--target='));
  const target = targetArg ? targetArg.split('=')[1] : 'chrome';
  generateManifest(target);
}
