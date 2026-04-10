import { readFileSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { createInterface } from 'readline';
import { resolve, dirname, basename } from 'path';

const ROOT = dirname(new URL(import.meta.url).pathname);
const MANIFEST_PATH = resolve(ROOT, 'manifest.json');
const BOUNCER_MANIFEST_PATH = resolve(ROOT, '..', 'Bouncer_xcode', 'Shared (Extension)', 'manifest.json');

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

  // Build
  console.log('Running npm install...');
  execSync('npm install', { cwd: ROOT, stdio: 'inherit' });

  console.log('Running node build.js...');
  execSync('node build.js', { cwd: ROOT, stdio: 'inherit' });

  console.log('Removing node_modules...');
  execSync('rm -rf node_modules', { cwd: ROOT, stdio: 'inherit' });

  // Read current versions
  const currentVersion = readManifestVersion(MANIFEST_PATH);
  const bouncerVersion = readManifestVersion(BOUNCER_MANIFEST_PATH);
  const maxCurrent = compareVersions(currentVersion, bouncerVersion) >= 0 ? currentVersion : bouncerVersion;

  console.log(`\nCurrent version (manifest.json): ${currentVersion}`);
  console.log(`Current version (Bouncer manifest.json): ${bouncerVersion}`);

  let newVersion;
  if (sameVersion) {
    newVersion = maxCurrent;
    console.log(`Keeping version at ${newVersion}`);
  } else {
    // Prompt for new version
    const defaultVersion = incrementPatch(maxCurrent);
    const input = await prompt(`Enter new version number (must be > ${maxCurrent}) [${defaultVersion}]: `);
    newVersion = input || defaultVersion;

    // Validate format
    if (!/^\d+(\.\d+)*$/.test(newVersion)) {
      console.error('Error: Invalid version format. Use semver like 1.2.3');
      process.exit(1);
    }

    // Validate it increased
    if (compareVersions(newVersion, maxCurrent) <= 0) {
      console.error(`Error: New version ${newVersion} must be greater than ${maxCurrent}`);
      process.exit(1);
    }

    // Update both manifests
    writeManifestVersion(MANIFEST_PATH, newVersion);
    console.log(`Updated ${MANIFEST_PATH} to ${newVersion}`);

    writeManifestVersion(BOUNCER_MANIFEST_PATH, newVersion);
    console.log(`Updated ${BOUNCER_MANIFEST_PATH} to ${newVersion}`);
  }

  // Zip the directory
  const dirName = basename(ROOT);
  const zipName = `${dirName}-${newVersion}.zip`;
  const parentDir = resolve(ROOT, '..');

  console.log(`\nCreating ${zipName}...`);
  const excludes = [
    'node_modules/*',
    '.git/*',
    'src/*',
    'tests/*',
    'build.js',
    'cut.js',
    'package.json',
    'package-lock.json',
    'vitest.config.js',
    'eslint.config.mjs',
    'manifest.chrome.json',
    'manifest.firefox.json',
  ].map(e => `"${dirName}/${e}"`).join(' ');
  execSync(`cd "${parentDir}" && zip -r "${zipName}" "${dirName}" -x ${excludes}`, {
    stdio: 'inherit',
  });

  console.log(`\nDone! Created ${resolve(parentDir, zipName)}`);
}

main();
