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
manifest.firefox.json                # Firefox variant
```

## Dependencies

- **[@mlc-ai/web-llm](https://github.com/mlc-ai/web-llm)** — in-browser model inference via WebGPU (vendored)
- **[DOMPurify](https://github.com/cure53/DOMPurify)** — HTML sanitization
- **[Firebase](https://firebase.google.com/)** — authentication
- **[esbuild](https://esbuild.github.io/)** — bundler
- **[vitest](https://vitest.dev/)** — test runner
- **[TypeScript](https://www.typescriptlang.org/)** — type checking (no emit, esbuild handles transpilation)
