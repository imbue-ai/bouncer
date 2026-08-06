import { test, expect, readStorage, openFeed, waitForFilterBar, FILTER_INPUT } from './fixtures';

const DESCRIPTIONS_KEY = 'descriptions_twitter';

async function descriptions(context: Parameters<typeof readStorage>[0]): Promise<string[]> {
  const all = await readStorage(context);
  return (all[DESCRIPTIONS_KEY] as string[] | undefined) ?? [];
}

test.describe('Filter management on the real X feed', () => {
  test.beforeEach(async ({ context }) => {
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent('serviceworker');
    await sw.evaluate((key) => chrome.storage.local.remove(key), DESCRIPTIONS_KEY);
  });

  test('comma key commits a phrase', async ({ context }) => {
    const page = await openFeed(context);
    const input = await waitForFilterBar(page);

    await input.click();
    await input.fill('crypto');
    await input.press(','); // the input commits on Enter OR comma

    await expect.poll(() => descriptions(context), { timeout: 10_000 }).toContain('crypto');
  });

  test('phrases persist across a page reload', async ({ context }) => {
    const page = await openFeed(context);
    const input = await waitForFilterBar(page);
    await input.click();
    await input.fill('engagement bait');
    await input.press('Enter');
    await expect.poll(() => descriptions(context), { timeout: 10_000 }).toContain('engagement bait');

    await page.reload({ waitUntil: 'domcontentloaded' });

    // The phrase is re-rendered as a chip from storage after reload.
    await expect(
      page.locator('.filter-phrase-inline:visible', { hasText: 'engagement bait' }).first()
    ).toBeVisible({ timeout: 15_000 });
    expect(await descriptions(context)).toContain('engagement bait');
  });

  test('the same phrase is not added twice', async ({ context }) => {
    const page = await openFeed(context);
    const input = await waitForFilterBar(page);

    for (let i = 0; i < 2; i++) {
      await input.click();
      await input.fill('politics');
      await input.press('Enter');
      await expect.poll(() => descriptions(context), { timeout: 10_000 }).toContain('politics');
    }

    expect((await descriptions(context)).filter((d) => d === 'politics')).toHaveLength(1);
  });

  test('clicking a phrase chip removes it', async ({ context }) => {
    const page = await openFeed(context);
    const input = await waitForFilterBar(page);
    await input.click();
    await input.fill('sports');
    await input.press('Enter');
    await expect.poll(() => descriptions(context), { timeout: 10_000 }).toContain('sports');

    const chip = page.locator('.filter-phrase-inline:visible', { hasText: 'sports' }).first();
    await expect(chip).toBeVisible();
    await chip.click(); // chips are titled "Click to remove"

    await expect.poll(() => descriptions(context), { timeout: 10_000 }).not.toContain('sports');
  });

  test('the settings gear opens the in-feed settings modal', async ({ context }) => {
    const page = await openFeed(context);
    await waitForFilterBar(page);

    await page.locator('.filter-settings-btn:visible').first().click();

    const modal = page.locator('.settings-modal-overlay');
    await expect(modal).toBeVisible({ timeout: 10_000 });
    // The modal hosts the same popup UI in an iframe.
    const iframe = modal.locator('iframe.settings-modal-iframe');
    await expect(iframe).toHaveAttribute('src', /popup\.html$/);
  });

  test('the filter bar re-injects after SPA navigation', async ({ context }) => {
    const page = await openFeed(context);
    await waitForFilterBar(page);

    // Navigate away within the SPA, then back — the MutationObserver should
    // re-inject the bar without a full page load.
    await page.locator('a[data-testid="AppTabBar_Explore_Link"], a[href="/explore"]').first().click();
    await page.waitForURL('**/explore', { timeout: 15_000 });
    await page.locator('a[data-testid="AppTabBar_Home_Link"], a[href="/home"]').first().click();
    await page.waitForURL('**/home', { timeout: 15_000 });

    await waitForFilterBar(page);
  });
});
