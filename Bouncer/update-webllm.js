import { execSync } from 'child_process';
import { cpSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const vendorDir = path.join(__dirname, 'vendor', 'web-llm');

// Source directory: set WEBLLM_SRC env var, or default to ~/utilities/web-llm
const srcDir = process.env.WEBLLM_SRC || path.join(process.env.HOME, 'utilities', 'web-llm');

if (!existsSync(srcDir)) {
  console.error(`web-llm source not found at: ${srcDir}`);
  console.error('Set WEBLLM_SRC environment variable to your web-llm checkout.');
  process.exit(1);
}

// Build web-llm
console.log(`Building web-llm from ${srcDir}...`);
execSync('npm run build', { cwd: srcDir, stdio: 'inherit' });

// Clear old vendor lib and copy fresh build
const vendorLib = path.join(vendorDir, 'lib');
if (existsSync(vendorLib)) {
  rmSync(vendorLib, { recursive: true });
}

console.log('Copying lib/ to vendor/web-llm/...');
cpSync(path.join(srcDir, 'lib'), vendorLib, {
  recursive: true,
  filter: (src) => !src.endsWith('.js.map'),
});

// Strip sourceMappingURL references (we don't vendor .js.map files)
const indexJs = path.join(vendorLib, 'index.js');
const content = readFileSync(indexJs, 'utf8');
writeFileSync(indexJs, content.replace(/\n\/\/# sourceMappingURL=.+$/m, ''));

// Update version in vendored package.json from source
const srcPkg = JSON.parse(readFileSync(path.join(srcDir, 'package.json'), 'utf8'));
const vendorPkgPath = path.join(vendorDir, 'package.json');
const vendorPkg = JSON.parse(readFileSync(vendorPkgPath, 'utf8'));
vendorPkg.version = `${srcPkg.version}-custom`;
writeFileSync(vendorPkgPath, JSON.stringify(vendorPkg, null, 2) + '\n');

console.log(`Vendored web-llm updated to ${vendorPkg.version}`);
