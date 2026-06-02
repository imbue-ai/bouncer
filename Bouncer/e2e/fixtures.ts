import { test as base, chromium, type BrowserContext, type Locator, type Page, type Worker } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** The built, unpacked extension folder (the one containing manifest.json + dist/). */
export const EXTENSION_PATH = path.resolve(__dirname, '..');

/**
 * Fixed Chrome profile directory. Holds BOTH the X website session AND the
 * extension's Firebase session (Firebase persists auth in the extension's
 * IndexedDB, which lives inside this profile — not in storageState). Log in
 * once via `npm run test:e2e:login`; every later run reuses this profile.
 */
export const USER_DATA_DIR = path.resolve(__dirname, '.userdata');

type Fixtures = {
  context: BrowserContext;
  extensionId: string;
};

// Run headless with `HEADLESS=1`. Extensions DON'T load in Playwright's old
// headless or the bundled headless-shell — only in Chromium's *new* headless
// mode, which requires the full `channel: 'chromium'` build. The interactive
// login (test:e2e:login) must stay headed; don't set HEADLESS for it.
const HEADLESS = process.env.HEADLESS === '1' || process.env.HEADLESS === 'true';

/**
 * Launches Chromium with the unpacked extension loaded against the persistent
 * profile. `--enable-automation` is stripped because it breaks the singleton
 * browser-process behavior the extension relies on (and reduces Google's
 * "automated software" friction at login).
 */
export const test = base.extend<Fixtures>({
  context: async ({}, use) => {
    const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
      headless: HEADLESS,
      // New headless mode (extension-capable) lives in the full chromium build,
      // not the default headless-shell.
      channel: HEADLESS ? 'chromium' : undefined,
      ignoreDefaultArgs: ['--enable-automation'],
      // Desktop width so X renders the right sidebar (where the filter bar lives).
      viewport: { width: 1440, height: 900 },
      args: [
        `--disable-extensions-except=${EXTENSION_PATH}`,
        `--load-extension=${EXTENSION_PATH}`,
        // Reduces "automated software" friction during the manual Google/X login.
        '--disable-blink-features=AutomationControlled',
      ],
    });
    await use(context);
    await context.close();
  },

  extensionId: async ({ context }, use) => {
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent('serviceworker');
    // chrome-extension://<id>/...
    const extensionId = sw.url().split('/')[2];
    await use(extensionId);
  },
});

export const expect = test.expect;

/** Convenience: read the extension's chrome.storage.local from the service worker. */
export async function readStorage(context: BrowserContext): Promise<Record<string, unknown>> {
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker');
  return (sw as Worker).evaluate(() => chrome.storage.local.get(null));
}

/**
 * Returns a single x.com page navigated to `url`, and closes every other tab.
 * The extension auto-opens an x.com tab on install (onInstalled), so without
 * this each test would end up with two x tabs. We reuse that tab when present.
 */
export async function openFeed(
  context: BrowserContext,
  url = 'https://x.com/home'
): Promise<Page> {
  const page =
    context.pages().find((p) => p.url().includes('x.com')) ??
    (await context.waitForEvent('page', { timeout: 5_000 }).catch(() => null)) ??
    context.pages()[0] ??
    (await context.newPage());

  // Close any other tabs (a leftover blank tab, or a duplicate x.com tab).
  for (const other of context.pages()) {
    if (other !== page) await other.close().catch(() => {});
  }

  await page.goto(url, { waitUntil: 'domcontentloaded' });
  return page;
}

/**
 * Opens the extension's settings page (popup.html) in a single tab, closing
 * others. Waits for the authenticated settings view (#mainContainer) to show —
 * if that times out, the extension's Firebase session has expired; re-run
 * `npm run test:e2e:login`.
 */
export async function openPopup(context: BrowserContext, extensionId: string): Promise<Page> {
  const page = context.pages()[0] ?? (await context.newPage());
  for (const other of context.pages()) {
    if (other !== page) await other.close().catch(() => {});
  }
  await page.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: 'domcontentloaded' });
  // #mainContainer is visible by default, so it's not a readiness signal. Wait
  // instead for the model dropdown to be populated — that happens inside
  // loadSettings(), which is immediately followed by setupEventListeners(), so
  // by the time the menu has items the change/click handlers are attached.
  await page.locator('#modelDropdownMenu > *').first().waitFor({ state: 'attached', timeout: 15_000 });
  return page;
}

// Bouncer's filter input. It has sidebar/bottom/mobile variants and only one is
// shown per layout, so always target the visible one.
export const FILTER_INPUT = '.filter-phrases-input:visible';

/**
 * Waits for Bouncer's filter bar to be injected and visible, returning the
 * input locator. The bar only appears after X's feed has rendered and the
 * extension is signed in, so this is the single reliable "feed is ready" signal.
 * The timeout is generous because it depends on live X's (variable) load time.
 */
export async function waitForFilterBar(page: Page, timeout = 30_000): Promise<Locator> {
  const input = page.locator(FILTER_INPUT).first();
  await input.waitFor({ state: 'visible', timeout });
  return input;
}

/** Remove keys from chrome.storage.local via the service worker (test cleanup). */
export async function clearStorageKeys(context: BrowserContext, keys: string[]): Promise<void> {
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker');
  await (sw as Worker).evaluate((k) => chrome.storage.local.remove(k), keys);
}
