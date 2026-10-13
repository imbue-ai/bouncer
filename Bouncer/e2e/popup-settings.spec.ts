import { test, expect, readStorage, openPopup, clearStorageKeys } from './fixtures';

// Keys these tests touch — reset after each so the dev profile isn't polluted.
const TOUCHED_KEYS = [
  'filterReplies',
  'aiTextFilterExperimental',
  'aiTextFilterEnabled',
  'aiImageFilterEnabled',
  'aiTextDetectionThreshold',
  'anthropicApiKey',
  'authErrorApis',
];

test.describe('Popup settings', () => {
  test.afterEach(async ({ context }) => {
    await clearStorageKeys(context, TOUCHED_KEYS);
  });

  test('"filter replies" toggle persists to storage', async ({ context, extensionId }) => {
    const page = await openPopup(context, extensionId);
    const toggle = page.locator('#enableFilterReplies');

    await toggle.uncheck();
    await expect
      .poll(async () => (await readStorage(context)).filterReplies, { timeout: 10_000 })
      .toBe(false);

    await toggle.check();
    await expect
      .poll(async () => (await readStorage(context)).filterReplies, { timeout: 10_000 })
      .toBe(true);
  });

  test('enabling the experimental AI-text filter reveals its section and persists', async ({
    context,
    extensionId,
  }) => {
    const page = await openPopup(context, extensionId);

    await page.locator('#enableAiTextExperimental').check();

    await expect(page.locator('#aiTextFilterExperimentalContent')).toBeVisible();
    await expect
      .poll(async () => (await readStorage(context)).aiTextFilterExperimental, { timeout: 10_000 })
      .toBe(true);
  });

  test('the AI-text threshold slider updates its label and persists', async ({
    context,
    extensionId,
  }) => {
    const page = await openPopup(context, extensionId);
    await page.locator('#enableAiTextExperimental').check();

    const slider = page.locator('#aiTextThreshold');
    await expect(slider).toBeVisible();
    // range inputs can't be .fill()'d — set the value and fire input+change.
    await slider.evaluate((el: HTMLInputElement) => {
      el.value = '0.9';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });

    await expect(page.locator('#aiTextThresholdValue')).toHaveText('90%');
    await expect
      .poll(async () => (await readStorage(context)).aiTextDetectionThreshold, { timeout: 10_000 })
      .toBeCloseTo(0.9, 2);
  });

  test('BYOK: a valid Anthropic key enables the provider', async ({ context, extensionId }) => {
    // Mock the verification request so no real key/network is needed.
    await context.route('https://api.anthropic.com/v1/messages', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ content: [{ type: 'text', text: 'ok' }] }),
      })
    );

    const page = await openPopup(context, extensionId);
    await page.locator('.api-provider-header[data-provider="anthropic"]').click(); // expand accordion
    await page.locator('#anthropicApiKey').fill('sk-ant-e2e-test-key');
    await page.locator('#anthropicEnableBtn').click();

    await expect(page.locator('#anthropicEnabled')).toBeVisible({ timeout: 10_000 });
    await expect
      .poll(async () => (await readStorage(context)).anthropicApiKey, { timeout: 10_000 })
      .toBe('sk-ant-e2e-test-key');
  });

  test('BYOK: an invalid Anthropic key shows an error and does not enable', async ({
    context,
    extensionId,
  }) => {
    await context.route('https://api.anthropic.com/v1/messages', (route) =>
      route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ error: { message: 'invalid x-api-key' } }),
      })
    );

    const page = await openPopup(context, extensionId);
    await page.locator('.api-provider-header[data-provider="anthropic"]').click();
    await page.locator('#anthropicApiKey').fill('sk-ant-bogus');
    await page.locator('#anthropicEnableBtn').click();

    await expect(page.locator('#anthropicError')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('#anthropicEnabled')).toBeHidden();
    expect((await readStorage(context)).anthropicApiKey).toBeUndefined();
  });
});
