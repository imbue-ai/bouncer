import esbuild from 'esbuild';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isWatch = process.argv.includes('--watch');
const env = process.argv.includes('--dev') ? 'dev' : 'prod';

const ENV_KEYS = [
  'BOUNCER_ENV', 'FIREBASE_API_KEY', 'FIREBASE_AUTH_DOMAIN',
  'FIREBASE_PROJECT_ID', 'FIREBASE_STORAGE_BUCKET',
  'FIREBASE_MESSAGING_SENDER_ID', 'FIREBASE_APP_ID',
  'GOOGLE_CLIENT_ID', 'IMBUE_WS_URL',
];

// Keys required for the Imbue backend (all env keys except BOUNCER_ENV)
const IMBUE_KEYS = ENV_KEYS.filter(k => k !== 'BOUNCER_ENV');

function loadEnvFile(envName) {
  const envPath = path.join(__dirname, `.env.${envName}`);
  const result = { BOUNCER_ENV: envName };

  // Read from .env file if it exists
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIndex = trimmed.indexOf('=');
      if (eqIndex === -1) continue;
      result[trimmed.slice(0, eqIndex).trim()] = trimmed.slice(eqIndex + 1).trim();
    }
  }

  // Allow process.env overrides (for CI or Docker)
  for (const key of ENV_KEYS) {
    if (process.env[key]) result[key] = process.env[key];
    else if (!(key in result)) result[key] = '';
  }

  return result;
}

// Check if all Imbue-specific env vars have non-empty values
function checkImbueConfigured(config) {
  return IMBUE_KEYS.every(key => config[key] && config[key].length > 0);
}

const config = loadEnvFile(env);
const hasImbue = checkImbueConfigured(config);

// Build esbuild define map — replaces process.env.X with literal strings
const define = {
  'process.env.NODE_ENV': '"production"',
  'process.env.HAS_IMBUE_BACKEND': JSON.stringify(String(hasImbue)),
};
for (const [key, value] of Object.entries(config)) {
  define[`process.env.${key}`] = JSON.stringify(value);
}

// When Imbue is not configured, swap auth.ts and ws-manager.ts with no-op stubs
// so the Firebase SDK and WebSocket code are completely excluded from the bundle.
const imbueStubPlugin = {
  name: 'imbue-stub',
  setup(build) {
    // Match relative imports of ./auth and ./ws-manager from background/
    build.onResolve({ filter: /^\.\/auth$/ }, (args) => {
      if (args.importer.includes(path.join('src', 'background'))) {
        return { path: path.join(__dirname, 'src', 'background', 'auth.stub.ts') };
      }
    });
    build.onResolve({ filter: /^\.\/ws-manager$/ }, (args) => {
      if (args.importer.includes(path.join('src', 'background'))) {
        return { path: path.join(__dirname, 'src', 'background', 'ws-manager.stub.ts') };
      }
    });
  },
};

const adapterTsPath = path.join(__dirname, 'adapters/twitter/TwitterAdapter.ts');
const hasAdapterTs = fs.existsSync(adapterTsPath);

async function build() {
  console.log(hasImbue
    ? `Building with Imbue backend (env: ${env})`
    : `Building without Imbue backend (no .env.${env} configured with Imbue keys)`);

  // Bundle main entry points (background, popup, content)
  const ctx = await esbuild.context({
    entryPoints: [
      path.join(__dirname, 'background.js'),
      path.join(__dirname, 'popup.js'),
      path.join(__dirname, 'content.js')
    ],
    bundle: true,
    outdir: path.join(__dirname, 'dist'),
    format: 'esm',
    platform: 'browser',
    target: 'es2020',
    minify: false,
    sourcemap: false,
    external: ['url'],
    define,
    plugins: hasImbue ? [] : [imbueStubPlugin],
  });

  const contexts = [ctx];

  // Type-strip the adapter (unbundled, standalone content script)
  if (hasAdapterTs) {
    const adapterCtx = await esbuild.context({
      entryPoints: [adapterTsPath],
      outfile: path.join(__dirname, 'dist/TwitterAdapter.js'),
      bundle: false,
      format: 'iife',
      platform: 'browser',
      target: 'es2020',
    });
    contexts.push(adapterCtx);
  }

  if (isWatch) {
    await Promise.all(contexts.map(c => c.watch()));
    console.log(`Watching for changes... (env: ${env})`);
  } else {
    await Promise.all(contexts.map(c => c.rebuild()));
    await Promise.all(contexts.map(c => c.dispose()));
    console.log(`Build complete (env: ${env}): dist/background.js, dist/popup.js, dist/content.js` +
      (hasAdapterTs ? ', dist/TwitterAdapter.js' : ''));
  }
}

build().catch((err) => {
  console.error('Build failed:', err);
  process.exit(1);
});
