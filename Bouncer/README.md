# Bouncer — Desktop Extension

The main codebase for the Bouncer browser extension (Chrome MV3, Firefox, Safari desktop).

## Build

```bash
npm install
npm run build          # one-time build
npm run watch          # dev mode with file watching
npm run build:dev      # dev build (no minification)
npm run watch:dev      # dev watch mode
```

Then load the unpacked extension from this folder at `chrome://extensions` (with Developer mode enabled).

## Scripts

| Command | Description |
|---------|-------------|
| `npm run build` | Production build via esbuild |
| `npm run watch` | Rebuild on file changes |
| `npm run test` | Run unit tests (vitest) |
| `npm run lint` | ESLint + TypeScript type checking |
| `npm run lint:fix` | Auto-fix lint issues |
| `npm run typecheck` | TypeScript only |
| `npm run cut-chrome` | Prepare Chrome Web Store build |

## Source Layout

```
src/
  background/
    index.ts             # Service worker entry: message routing, tab tracking
    pipeline.ts          # Post evaluation queue, batching, caching, error state
    local-model.ts       # WebLLM engine lifecycle, inference, preemption
    inference-queue.ts   # Serial priority queue for local model tasks
    providers.ts         # API calls (OpenAI, Gemini, Anthropic, Imbue, OpenRouter)
    auth.ts              # Google OAuth, token management
    ws-manager.ts        # WebSocket connection to Imbue backend
  content/
    index.ts             # MutationObserver, post detection, queue submission
    ui.ts                # Sidebar, modals, alerts, theming, filter management
    ios.ts               # iOS-specific UI (FAB button, full-screen overlay)
  shared/
    models.ts            # Model definitions and API endpoints
    prompts.ts           # System prompts for local and API models
    storage.ts           # Typed chrome.storage wrappers
    utils.ts             # Cache keys, response parsing, formatting
    alerts.ts            # Alert configuration

adapters/
  twitter/
    TwitterAdapter.ts    # DOM selectors, post extraction, theme detection
    twitter.css          # Twitter-specific style overrides

popup.html / popup.js / popup.css   # Extension settings UI
content.css                          # Content script styles
fiber-extractor.js                   # Main-world script for React fiber access
manifest.json                        # Chrome MV3 manifest
```

## Dependencies

- **[@mlc-ai/web-llm](https://github.com/mlc-ai/web-llm)** — in-browser model inference via WebGPU (vendored)
- **[DOMPurify](https://github.com/cure53/DOMPurify)** — HTML sanitization
- **[Firebase](https://firebase.google.com/)** — authentication
- **[esbuild](https://esbuild.github.io/)** — bundler
- **[vitest](https://vitest.dev/)** — test runner
- **[TypeScript](https://www.typescriptlang.org/)** — type checking (no emit, esbuild handles transpilation)

## Optional Jev feed decisions (BYOK)

Advanced Settings includes a separate, opt-in Jev decision layer. It is not a
chat model entry and does not replace the selected Bouncer filter model.

- Route through **TypeSafe directly** with a TypeSafe key, or through
  **OpenRouter** with the existing OpenRouter key.
- Independently enable helpful-probability badges, hiding clearly unhelpful
  posts, and hiding hateful posts. Each action has its own threshold.
- Customize what “helpful” means. “Hateful” is narrowly defined as
  identity-targeted dehumanization, hatred, or threats—not criticism,
  disagreement, or quotations condemning hate.
- All options default off. When any option is enabled, post text is transmitted
  to the selected provider. Keys remain in extension storage and API calls are
  made by the background worker; keys are never sent to the page or logged.
- API failures, malformed responses, and uncertain helpfulness scores fail open.
  Bouncer does not try a second provider automatically or invent an explanation;
  the UI displays only Jev probabilities.

The implementation follows the official typed-decision APIs:
[TypeSafe `POST /v1/systemone`](https://docs.typesafe.ai/api) with the versioned
`jev-1.13.0` model, and
[OpenRouter `POST /api/v1/systemone`](https://openrouter.ai/docs/api/api-reference/systemone/submit-a-system-one-request)
with `typesafe/jev-1.13`.
