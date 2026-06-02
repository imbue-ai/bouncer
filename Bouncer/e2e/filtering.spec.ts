import { test, expect, openFeed } from './fixtures';

/**
 * Tier 2: the actual filtering behavior. We point the classification pipeline
 * at the Anthropic BYOK path (selectedModel = "anthropic:…" + a stored key) and
 * mock that HTTP endpoint to mark EVERY post as a match. That makes the outcome
 * deterministic without live AI inference or a real key.
 *
 * Note: the classification fetch is made by the extension's *background service
 * worker*, so this also exercises Playwright's service-worker route interception.
 */

const SEED = {
  selectedModel: 'anthropic:claude-haiku-4-5-20251001',
  anthropicApiKey: 'sk-ant-e2e-test',
  descriptions_twitter: ['crypto'],
  filterReplies: true,
};

async function setStorage(context: Parameters<typeof openFeed>[0], items: Record<string, unknown>) {
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker');
  await sw.evaluate((i) => chrome.storage.local.set(i), items);
}

test.describe('Filtering behavior (mocked Anthropic BYOK)', () => {
  test.afterEach(async ({ context }) => {
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent('serviceworker');
    await sw.evaluate(() =>
      chrome.storage.local.remove(['selectedModel', 'anthropicApiKey', 'descriptions_twitter'])
    );
  });

  test('a matching post is hidden and appears in "View filtered" with reasoning', async ({
    context,
  }) => {
    let intercepted = 0;
    await context.route('https://api.anthropic.com/**', (route) => {
      intercepted++;
      // parseAPIResponse() treats any <category> other than "no match"/"unknown"
      // as a hit, and surfaces <reasoning> in the filtered-posts view.
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          content: [
            {
              type: 'text',
              text: '<reasoning>Promotes cryptocurrency.</reasoning><category>crypto</category>',
            },
          ],
        }),
      });
    });

    await setStorage(context, SEED);
    const page = await openFeed(context);

    // Wait for the live feed to render real tweets. Use 'attached', not
    // 'visible': the mock matches every post, so the extension may have already
    // hidden (display:none) them by the time this runs.
    await page.locator('article[data-testid="tweet"]').first().waitFor({
      state: 'attached',
      timeout: 20_000,
    });

    // Hidden posts are marked on their cell container by the Twitter adapter.
    await expect
      .poll(
        () => page.locator('[data-testid="cellInnerDiv"][data-filtered-by-extension="true"]').count(),
        { timeout: 45_000, message: 'no post was hidden — was the SW fetch intercepted?' }
      )
      .toBeGreaterThan(0);

    // Confirms the mock actually intercepted the background service worker's fetch.
    expect(intercepted).toBeGreaterThan(0);

    // The in-feed "View filtered (N)" counter should advance past zero.
    await expect
      .poll(async () => (await page.locator('.filtered-toggle-count:visible').first().textContent()) ?? '', {
        timeout: 10_000,
      })
      .not.toBe('(0)');

    // Opening the modal lists the filtered post(s); reasoning/category flow through.
    await page.locator('.filtered-toggle-btn:visible').first().click();
    await expect(page.locator('.filtered-view-container')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('.slop-post-wrapper').first()).toBeVisible();
  });
});
