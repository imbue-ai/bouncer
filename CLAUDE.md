# Bouncer

A browser extension that filters unwanted posts from Twitter/X feeds using AI. Users define filter topics (e.g., "crypto", "engagement bait") and the AI classifies and hides matching posts.

## Project Structure

**Important:** `Bouncer_xcode/` contains only iOS app code. The desktop extension code lives in `Bouncer/`.

## Build & Development

```bash
cd Bouncer
npm install
npm run build        # one-time build
```

Then load the unpacked extension from the `Bouncer/` folder at `chrome://extensions`.

Dependencies: esbuild, dompurify, vendored web-llm

Pre-commit checks:
```bash
cd Bouncer
npm run lint
npm run test
```

## Architecture

### Key Patterns

- **Adapter pattern**: Site-specific logic (DOM selectors, theme, post extraction) is abstracted behind adapters. Currently only `adapters/twitter/`. This enables future support for other platforms.
- **Theme support**: Three modes (light, dim, dark) detected via `adapter.getThemeMode()`. All custom UI elements respect the active theme.
- **Filter storage**: Filter phrases persisted via Chrome `storage.local` API.
- **Post tracking**: Filtered posts stored in `filteredPosts` array with their HTML, reasoning, image URLs, and post URLs.
- **Reasoning popups**: Each filtered post can show an AI-generated reasoning explaining why it was filtered.

### Content Script Flow

1. Extension injects content script on Twitter/X pages
2. MutationObserver watches for new posts in the feed
3. New posts are sent to the AI for classification against user-defined filter topics
4. Posts classified as matching a filter are hidden and added to `filteredPosts`
5. Users can view filtered posts via the "View filtered" button
