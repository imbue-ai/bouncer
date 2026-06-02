# E2E tests (Playwright + real X)

These drive the **built, unpacked extension** in a real Chromium against the
live `x.com`. Because Chrome extensions require a headed *persistent* context,
all auth lives in one Chrome profile directory (`e2e/.userdata`, gitignored):

- the **X website** session (cookies), and
- the **extension's Firebase** session (Firebase persists auth in the
  extension's IndexedDB, which lives inside the profile — it is *not* captured by
  Playwright's `storageState`).

Log in once; every later run reuses that profile.

## Prerequisites

1. A **dedicated throwaway X account** (don't automate your personal account).
2. `.env.prod` populated with the Imbue keys (`FIREBASE_*`, `GOOGLE_CLIENT_ID`,
   `IMBUE_WS_URL`). Without them the build stubs out auth and there's no Google
   sign-in button. (Already set in this repo.)
3. Install the browser binary once: `npx playwright install chromium`.

## One-time login

```bash
npm run test:e2e:login
```

A real browser window opens on x.com. **By hand:** (1) log in to X, then (2) in
the feed click the Bouncer **Settings** gear → *Activate Bouncer* and complete
Google sign-in. The in-feed settings load the same UI as the toolbar popup, so
there's no separate popup tab. Then press ▶ Resume in the Playwright Inspector
(or close it). The profile is saved to `e2e/.userdata`.

## Run the suite

```bash
npm run test:e2e            # headed (a browser window is visible)
npm run test:e2e:headless   # no window — uses Chromium's new headless mode
```

Both scripts run `npm run build` first so the loaded extension is current.

### Headless

`HEADLESS=1` runs the suite with no visible window. Extensions do **not** load in
Playwright's old headless or the bundled `headless-shell`, so the fixture switches
to `channel: 'chromium'` (the full build) with `headless: true`, which uses
Chromium's *new* headless mode — the only headless variant that supports
extensions. The one-time `test:e2e:login` must stay **headed** (you log in by
hand); don't set `HEADLESS` for it.

## When tests fail with "filter bar not visible"

The saved session probably expired (X rotates cookies; Firebase tokens lapse).
Just re-run `npm run test:e2e:login`.

## What's covered

- `x-feed.spec.ts` — content script injects on the feed; a typed phrase persists.
- `filter-management.spec.ts` — comma-key commit, persistence across reload, no
  duplicates, chip removal, the in-feed settings modal, and filter-bar
  re-injection after SPA navigation.
- `popup-settings.spec.ts` — "filter replies" toggle, experimental AI-text
  toggle + section reveal, threshold slider, and BYOK Anthropic key enable
  (valid + invalid, with the verification request mocked via `context.route`).
- `filtering.spec.ts` — the end-to-end filtering behavior: seeds the Anthropic
  BYOK path and mocks `api.anthropic.com` to mark every post as a match, then
  asserts a post is hidden (`data-filtered-by-extension`), the "View filtered"
  counter advances, and the filtered-posts modal lists it. The classification
  fetch runs in the background service worker — `context.route` intercepts it.

## Notes / limits

- `workers` is pinned to 1 — persistent contexts don't parallelize.
- The filtering test mocks the classifier, so it proves the *pipeline + hide +
  View-filtered* path is wired correctly — not that real AI inference is
  accurate. It deliberately matches every post for determinism.
- This is **local-only**. Running against real X from GitHub CI is possible but
  flaky (datacenter IPs get challenged, cookies expire); add it as a nightly /
  manual workflow later, not a PR gate.
