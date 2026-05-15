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

export function generateManifest(target = 'chrome') {
  if (!VALID_TARGETS.has(target)) {
    throw new Error(`Unknown target: ${target}. Expected one of: ${[...VALID_TARGETS].join(', ')}`);
  }
  const base = readJSON('manifest.base.json');
  const override = readJSON(`manifest.${target}.json`);
  const merged = deepMerge(base, override);
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
