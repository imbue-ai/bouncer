import { test, expect, readStorage, openFeed, waitForFilterBar } from './fixtures';

const DESCRIPTIONS_KEY = 'descriptions_twitter';
const TEST_PHRASE = 'e2e-test-crypto-spam';

test.describe('Bouncer on the real X feed', () => {
  test.beforeEach(async ({ context }) => {
    // Start each test from a clean filter list so runs are idempotent.
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent('serviceworker');
    await sw.evaluate((key) => chrome.storage.local.remove(key), DESCRIPTIONS_KEY);
  });

  test('content script injects the filter bar on the home feed', async ({ context }) => {
    const page = await openFeed(context);

    // The filter input only renders (vs. a sign-in prompt) when the extension
    // is signed in, and only after X's feed has loaded — so its visibility is a
    // sufficient signal. If this times out, the saved session likely expired —
    // re-run `npm run test:e2e:login`.
    await waitForFilterBar(page);
  });

  test('typing a filter phrase persists it to chrome.storage', async ({ context }) => {
    const page = await openFeed(context);

    const input = await waitForFilterBar(page);

    await input.click();
    await input.fill(TEST_PHRASE);
    await input.press('Enter');

    await expect
      .poll(
        async () => {
          const all = await readStorage(context);
          return (all[DESCRIPTIONS_KEY] as string[] | undefined) ?? [];
        },
        { timeout: 10_000 }
      )
      .toContain(TEST_PHRASE);
  });
});
