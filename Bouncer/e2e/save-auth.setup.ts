import { test, expect } from './fixtures';

/**
 * ONE-TIME, INTERACTIVE login. Run with:  npm run test:e2e:login
 *
 * Opens a single x.com tab and pauses. While paused, YOU manually:
 *   1. Log in to your (throwaway) X account.
 *   2. In the feed, click the Bouncer "Settings" gear → "Activate Bouncer" and
 *      complete Google sign-in. (The in-feed settings load the same popup UI,
 *      so there's no separate popup tab to deal with.)
 * Then press ▶ Resume in the Playwright Inspector (or close it).
 *
 * Both sessions are written into the persistent profile (e2e/.userdata) by
 * Chrome itself, so every later `npm run test:e2e` run starts already
 * authenticated. Re-run this whenever a session expires.
 */
test('interactive login — sign in to X and to the extension by hand', async ({ context }) => {
  test.setTimeout(0); // no timeout — wait for the human

  // The extension opens an x.com tab itself on first install (onInstalled in
  // src/background/index.ts). Reuse that tab if it's already there or about to
  // appear; otherwise reuse the blank starting tab. Avoids piling up tabs.
  let x =
    context.pages().find((p) => p.url().includes('x.com')) ??
    (await context.waitForEvent('page', { timeout: 5_000 }).catch(() => null));
  if (!x) x = context.pages()[0] ?? (await context.newPage());
  if (!x.url().includes('x.com')) await x.goto('https://x.com/login');

  console.log(
    '\n  >>> Log in to X, then open the in-feed Bouncer Settings → Activate Bouncer.' +
      '\n  >>> When done, press Resume / close the Inspector.\n'
  );
  await x.pause(); // opens the Inspector; resume when done

  // Sanity check (read-only): confirm the X login took by looking for the
  // session cookie. The extension/Firebase session can't be read this simply;
  // it persists in the profile regardless and is only needed for tests that
  // exercise live filtering.
  const cookies = await context.cookies('https://x.com');
  const hasSession = cookies.some((c) => c.name === 'auth_token');
  expect(hasSession, 'No x.com auth_token cookie — X login did not complete').toBe(true);
});
