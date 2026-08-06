import { defineConfig } from '@playwright/test';

/**
 * E2E tests run against the REAL x.com using a persistent Chrome profile that
 * holds both the X session and the extension's Firebase session. See e2e/README.md.
 *
 * Persistent contexts can't be parallelized safely, so workers is pinned to 1.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  timeout: 90_000,
  expect: { timeout: 10_000 },
  projects: [
    {
      // Interactive, one-time manual login. Run via `npm run test:e2e:login`.
      // Never retry — it waits on a human.
      name: 'login',
      testMatch: /save-auth\.setup\.ts/,
      retries: 0,
    },
    {
      // The actual test suite. Run via `npm run test:e2e`. Retries absorb live
      // X's load-timing flakiness (slow timeline render, occasional
      // interstitials) — the tests themselves are deterministic.
      name: 'x',
      testMatch: /.*\.spec\.ts/,
      retries: 2,
    },
  ],
});
