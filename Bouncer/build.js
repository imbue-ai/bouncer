import esbuild from 'esbuild';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isWatch = process.argv.includes('--watch');
const env = process.argv.includes('--dev') ? 'dev' : 'prod';

const ENV_CONFIGS = {
  prod: {
    BOUNCER_ENV: 'prod',
    FIREBASE_API_KEY: 'AIzaSyCog9TwTeMEow5bWE9esJw8el3oSOeUA7I',
    FIREBASE_AUTH_DOMAIN: 'bouncer-180ba.firebaseapp.com',
    FIREBASE_PROJECT_ID: 'bouncer-180ba',
    FIREBASE_STORAGE_BUCKET: 'bouncer-180ba.firebasestorage.app',
    FIREBASE_MESSAGING_SENDER_ID: '739221928933',
    FIREBASE_APP_ID: '1:739221928933:web:516efa2fb8574bd363cd0c',
    GOOGLE_CLIENT_ID: '739221928933-ano3gr1v8iskuhlb3ndtiqe5f8p49im9.apps.googleusercontent.com',
    IMBUE_WS_URL: 'wss://prod.aibutler.api.imbue.com',
  },
  dev: {
    BOUNCER_ENV: 'dev',
    FIREBASE_API_KEY: 'AIzaSyAhHBuEFgSrVR-lChCvthLE3muQH5VauU0',
    FIREBASE_AUTH_DOMAIN: 'bouncerdev-24e50.firebaseapp.com',
    FIREBASE_PROJECT_ID: 'bouncerdev-24e50',
    FIREBASE_STORAGE_BUCKET: 'bouncerdev-24e50.firebasestorage.app',
    FIREBASE_MESSAGING_SENDER_ID: '1082748697460',
    FIREBASE_APP_ID: '1:1082748697460:web:e733f4d69e756f55d98a21',
    GOOGLE_CLIENT_ID: '1082748697460-hvati54s347t21fhg56tm2k4kvge4hm8.apps.googleusercontent.com',
    IMBUE_WS_URL: 'wss://dev.aibutler.api.imbue.com',
  },
};

const config = ENV_CONFIGS[env];

// Build esbuild define map — replaces process.env.X with literal strings
const define = {
  'process.env.NODE_ENV': '"production"',
};
for (const [key, value] of Object.entries(config)) {
  define[`process.env.${key}`] = JSON.stringify(value);
}

const adapterTsPath = path.join(__dirname, 'adapters/twitter/TwitterAdapter.ts');
const hasAdapterTs = fs.existsSync(adapterTsPath);

async function build() {
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
