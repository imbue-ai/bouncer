import { readFileSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { createInterface } from 'readline';
import { resolve, dirname, basename } from 'path';

const ROOT = dirname(new URL(import.meta.url).pathname);
// Version lives in manifest.base.json (source of truth for the generator).
// manifest.json at the root is a generated artifact and shouldn't be edited
// directly — cut.js writes to base.json then re-runs the generator.
const BASE_MANIFEST_PATH = resolve(ROOT, 'manifest.base.json');

function readManifestVersion(path) {
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  return manifest.version;
}

function writeManifestVersion(path, version) {
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  manifest.version = version;
  writeFileSync(path, JSON.stringify(manifest, null, 2) + '\n');
}


function compareVersions(a, b) {
  const partsA = a.split('.').map(Number);
  const partsB = b.split('.').map(Number);
  const len = Math.max(partsA.length, partsB.length);
  for (let i = 0; i < len; i++) {
    const numA = partsA[i] || 0;
    const numB = partsB[i] || 0;
    if (numA > numB) return 1;
    if (numA < numB) return -1;
  }
  return 0;
}

function incrementPatch(version) {
  const parts = version.split('.').map(Number);
  parts[parts.length - 1]++;
  return parts.join('.');
}

function prompt(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function main() {
  const sameVersion = process.argv.includes('--same-version');
  const firefox = process.argv.includes('--firefox');
  const target = firefox ? 'firefox' : 'chrome';

  // Build (build.js regenerates manifest.json from base + target overrides)
  console.log('Running npm install...');
  execSync('npm install', { cwd: ROOT, stdio: 'inherit' });

  console.log(`Running node build.js --target=${target}...`);
  execSync(`node build.js --target=${target}`, { cwd: ROOT, stdio: 'inherit' });

  console.log('Removing node_modules...');
  execSync('rm -rf node_modules', { cwd: ROOT, stdio: 'inherit' });

  // Read current version from base (source of truth)
  const currentVersion = readManifestVersion(BASE_MANIFEST_PATH);
  console.log(`\nCurrent version (manifest.base.json): ${currentVersion}`);

  let newVersion;
  if (sameVersion) {
    newVersion = currentVersion;
    console.log(`Keeping version at ${newVersion}`);
  } else {
    // Prompt for new version
    const defaultVersion = incrementPatch(currentVersion);
    const input = await prompt(`Enter new version number (must be > ${currentVersion}) [${defaultVersion}]: `);
    newVersion = input || defaultVersion;

    // Validate format
    if (!/^\d+(\.\d+)*$/.test(newVersion)) {
      console.error('Error: Invalid version format. Use semver like 1.2.3');
      process.exit(1);
    }

    // Validate it increased
    if (compareVersions(newVersion, currentVersion) <= 0) {
      console.error(`Error: New version ${newVersion} must be greater than ${currentVersion}`);
      process.exit(1);
    }

    // Write version to base and regenerate the target manifest
    writeManifestVersion(BASE_MANIFEST_PATH, newVersion);
    console.log(`Updated ${BASE_MANIFEST_PATH} to ${newVersion}`);
    const { generateManifest } = await import('./generate-manifests.mjs');
    generateManifest(target);
  }

  // Zip the directory
  const dirName = basename(ROOT);
  const zipName = `${dirName}-${newVersion}.zip`;
  const parentDir = resolve(ROOT, '..');

  const zipPath = resolve(parentDir, zipName);
  execSync(`rm -f "${zipPath}"`);

  console.log(`\nCreating ${zipName}...`);
  const excludes = [
    'node_modules/*',
    'vendor/*',
    '.git/*',
    '.gitignore',
    '.wrangler/*',
    'hosting/*',
    'src/*',
    'tests/*',
    '.env.*',
    'build.js',
    'cut.js',
    'generate-manifests.mjs',
    'webllm-stub.js',
    'background.js',
    'popup.js',
    'content.js',
    'adapters/twitter/TwitterAdapter.ts',
    'package.json',
    'package-lock.json',
    'vitest.config.js',
    'eslint.config.mjs',
    'manifest.base.json',
    'manifest.chrome.json',
    'manifest.firefox.json',
    'manifest.safari.json',
    '.DS_Store',
    '*/.DS_Store',
    '*/*/.DS_Store',
    '*/*/*/.DS_Store',
    'iOS (App)/*',
    'Bouncer.xcodeproj/*',
    '.claude/*',
    '.nvmrc',
    'README.md',
    'tsconfig.json',
    'tsconfig.test.json',
    'update-webllm.js',
  ].map(e => `"${e}"`).join(' ');
  execSync(`cd "${ROOT}" && zip -r "${resolve(parentDir, zipName)}" . -x ${excludes}`, {
    stdio: 'inherit',
  });

  console.log(`\nDone! Created ${resolve(parentDir, zipName)}`);
}

main();
