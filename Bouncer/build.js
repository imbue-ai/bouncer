import esbuild from 'esbuild';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { generateManifest } from './generate-manifests.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isWatch = process.argv.includes('--watch');
const env = process.argv.includes('--dev') ? 'dev' : 'prod';
const targetArg = process.argv.find((a) => a.startsWith('--target='));
const target = targetArg ? targetArg.split('=')[1] : 'chrome';

const ENV_KEYS = [
  'BOUNCER_ENV', 'FIREBASE_API_KEY', 'FIREBASE_AUTH_DOMAIN',
  'FIREBASE_PROJECT_ID', 'FIREBASE_STORAGE_BUCKET',
  'FIREBASE_MESSAGING_SENDER_ID', 'FIREBASE_APP_ID',
  'GOOGLE_CLIENT_ID', 'IMBUE_WS_URL',
  'BOUNCER_SIGNIN_DOMAIN',
];

// Keys that must all be present for the Imbue backend (Firebase auth +
// websocket pipeline) to be wired up at build time. When any are missing,
// auth.ts / ws-manager.ts are swapped with no-op stubs so the Firebase SDK
// is fully excluded from the bundle and the extension runs in BYOK / local
// model mode only.
//
// Sign-in flows are target-specific:
//   - Chrome / Firefox: chrome.identity → Google OAuth → GOOGLE_CLIENT_ID
//   - Safari: redirect to BOUNCER_SIGNIN_DOMAIN, which offers Apple and
//     Google buttons. Apple's Services ID is configured server-side in
//     Firebase Console (not exposed to the client), so the build only
//     requires the redirect domain on top of the common Firebase keys.
const IMBUE_KEYS_COMMON = [
  'FIREBASE_API_KEY', 'FIREBASE_AUTH_DOMAIN', 'FIREBASE_PROJECT_ID',
  'FIREBASE_STORAGE_BUCKET', 'FIREBASE_MESSAGING_SENDER_ID',
  'FIREBASE_APP_ID', 'IMBUE_WS_URL',
];
const IMBUE_KEYS_BY_TARGET = {
  chrome: [...IMBUE_KEYS_COMMON, 'GOOGLE_CLIENT_ID'],
  firefox: [...IMBUE_KEYS_COMMON, 'GOOGLE_CLIENT_ID'],
  safari: [...IMBUE_KEYS_COMMON, 'BOUNCER_SIGNIN_DOMAIN'],
};
const IMBUE_KEYS = IMBUE_KEYS_BY_TARGET[target] ?? IMBUE_KEYS_BY_TARGET.chrome;

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
  } else {
    console.warn(`Warning: ${envPath} not found. Copy .env.example to .env.${envName} and fill in your values.`);
  }

  // Allow process.env overrides (for CI or Docker)
  for (const key of ENV_KEYS) {
    if (process.env[key]) result[key] = process.env[key];
    else if (!(key in result)) result[key] = '';
  }

  return result;
}

const config = loadEnvFile(env);
const hasImbue = IMBUE_KEYS.every((k) => config[k] && config[k].length > 0);

// Build esbuild define map — replaces process.env.X with literal strings
const define = {
  'process.env.NODE_ENV': '"production"',
  'process.env.HAS_IMBUE_BACKEND': JSON.stringify(String(hasImbue)),
};
for (const [key, value] of Object.entries(config)) {
  define[`process.env.${key}`] = JSON.stringify(value);
}

// When Imbue is not configured, swap auth.ts and ws-manager.ts with no-op
// stubs so the Firebase SDK and websocket code are excluded entirely.
const imbueStubPlugin = {
  name: 'imbue-stub',
  setup(b) {
    b.onResolve({ filter: /^\.\/auth$/ }, (args) => {
      if (args.importer.includes(path.join('src', 'background'))) {
        return { path: path.join(__dirname, 'src', 'background', 'auth.stub.ts') };
      }
    });
    b.onResolve({ filter: /^\.\/ws-manager$/ }, (args) => {
      if (args.importer.includes(path.join('src', 'background'))) {
        return { path: path.join(__dirname, 'src', 'background', 'ws-manager.stub.ts') };
      }
    });
  },
};
const imbuePlugins = hasImbue ? [] : [imbueStubPlugin];

const litertlmStub = { '@litert-lm/core': path.join(__dirname, 'litertlm-stub.js') };

const adapterTsPath = path.join(__dirname, 'adapters/twitter/TwitterAdapter.ts');
const hasAdapterTs = fs.existsSync(adapterTsPath);

// Copy LiteRT-LM's wasm loader + binaries into dist/litertlm-wasm/ so the
// offscreen document can resolve them via chrome.runtime.getURL(...). The
// runtime feature-detects relaxed-SIMD and loads either litertlm_wasm_internal
// or litertlm_wasm_compat_internal; each .js fetches its sibling .wasm, so
// all four files need to sit at the same URL prefix. By default the package
// resolves these from a jsdelivr CDN URL, which the extension CSP blocks —
// loadLiteRtLm() in the runtime points at this local directory instead.
function copyLitertlmAssets() {
  const srcDir = path.join(__dirname, 'node_modules/@litert-lm/core/wasm');
  const dstDir = path.join(__dirname, 'dist/litertlm-wasm');
  if (!fs.existsSync(srcDir)) {
    console.warn('@litert-lm/core wasm dir not found — skipping copy');
    return;
  }
  fs.mkdirSync(dstDir, { recursive: true });
  for (const name of fs.readdirSync(srcDir)) {
    fs.copyFileSync(path.join(srcDir, name), path.join(dstDir, name));
  }
  console.log('Copied LiteRT-LM wasm assets into dist/litertlm-wasm/');
}

async function build() {
  console.log(hasImbue
    ? `Building with Imbue backend (env: ${env}, target: ${target})`
    : `Building without Imbue backend — auth & websocket stubbed (env: ${env}, target: ${target})`);

  // 0. Regenerate manifest.json from manifest.base.json + manifest.<target>.json.
  generateManifest(target);

  copyLitertlmAssets();

  // 1. Background: bundles the LiteRT-LM SDK directly so the SW-side proxy can
  //    ship its message protocol without a second chunk. The actual Engine
  //    runtime only executes in the offscreen document (bundle 2), but
  //    importing the module from the SW is safe — nothing wasm-loads until
  //    you call Engine.create().
  const bgCtx = await esbuild.context({
    entryPoints: [path.join(__dirname, 'background.js')],
    outdir: path.join(__dirname, 'dist'),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2020',
    minify: false,
    sourcemap: false,
    external: ['url'],
    define,
    plugins: imbuePlugins,
  });

  // 2. Offscreen document bundle. Hosts LiteRT-LM's Engine; the SW opens
  //    this page on demand because the LiteRT-LM wasm loader uses script-tag
  //    injection (via @litertjs/wasm-utils), which is not available in MV3
  //    ESM service workers.
  const offscreenCtx = await esbuild.context({
    entryPoints: [path.join(__dirname, 'offscreen.js')],
    outdir: path.join(__dirname, 'dist'),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2020',
    minify: false,
    sourcemap: false,
    external: ['url'],
    define,
  });

  // 3. Popup & content: fully self-contained (no external imports).
  const otherCtx = await esbuild.context({
    entryPoints: [
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
    plugins: imbuePlugins,
  });

  // 4. Sign-in bridge content script (injected on firebaseapp.com to relay credentials)
  const signinBridgeCtx = await esbuild.context({
    entryPoints: [path.join(__dirname, 'src/signin/bridge.ts')],
    outfile: path.join(__dirname, 'dist/signin-bridge.js'),
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2020',
    minify: false,
    sourcemap: false,
    define,
  });

  // 5. iOS app builds (IIFE, LiteRT-LM stubbed). Injected into a WKWebView
  // that has no WebGPU — iOS uses a native CoreML bridge instead, so stubbing
  // keeps these bundles small.
  const stubbedIifeEntries = {
    'background-app': 'background.js',
    'popup-app': 'popup.js',
  };
  const stubbedIifeCtxs = await Promise.all(
    Object.entries(stubbedIifeEntries).map(([name, src]) =>
      esbuild.context({
        entryPoints: { [name]: path.join(__dirname, src) },
        bundle: true,
        outdir: path.join(__dirname, 'dist'),
        format: 'iife',
        platform: 'browser',
        target: 'es2020',
        minify: false,
        sourcemap: false,
        external: ['url'],
        define,
        alias: { ...litertlmStub },
        plugins: imbuePlugins,
      })
    )
  );

  const contexts = [bgCtx, offscreenCtx, otherCtx, signinBridgeCtx, ...stubbedIifeCtxs];

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

    console.log(`Build complete (env: ${env}): dist/background.js, dist/offscreen.js, dist/popup.js, dist/content.js, dist/background-app.js, dist/popup-app.js` +
      (hasAdapterTs ? ', dist/TwitterAdapter.js' : ''));
  }
}

build().catch((err) => {
  console.error('Build failed:', err);
  process.exit(1);
});
