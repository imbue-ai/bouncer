# Bouncer

<p align="center">
  <img src="appstore_assets/logo.png" alt="Bouncer" width="200" />
</p>

**Heal your feed.** Bouncer is a browser extension that uses AI to filter unwanted posts from your Twitter/X feed. Define filter topics in plain language — "crypto", "engagement bait", "rage politics" — and Bouncer classifies and hides matching posts in real time.

[**Install from the Chrome Web Store**](https://chromewebstore.google.com/detail/bouncer-heal-your-feed-on/bkijmhafoocfloemhancbgadknkgdkcm)

[**Install on iOS**](https://apps.apple.com/us/app/bouncer-heal-your-feed/id6759466393)

<p align="center">
  <img src="appstore_assets/demo.gif" alt="Bouncer demo" />
</p>

## Features

- **Natural language filters** — describe what you don't want to see in your own words
- **Multiple AI backends** — run models locally on your GPU, or use cloud APIs (OpenAI, Google Gemini, Anthropic, OpenRouter)
- **On-device inference** — local models via WebLLM run entirely in your browser with zero data sent externally
- **Image-aware filtering** — multimodal models can classify posts based on images, not just text
- **Reasoning transparency** — see exactly why each post was filtered
- **Theme-aware UI** — adapts to light, dim, and dark modes automatically

## Supported Models

| Provider | Models | Requires |
|----------|--------|----------|
| **Local (WebGPU)** | Qwen3-4B, Qwen3.5-4B, Qwen3.5-4B Vision | WebGPU-capable browser |
| **OpenAI** | GPT-5 Nano, gpt-oss-20b | API key |
| **Google Gemini** | 2.5 Flash Lite, 2.5 Flash, 3 Flash Preview | API key |
| **Anthropic** | Claude Haiku 4.5 | API key |
| **OpenRouter** | Nemotron Nano 12B VL (free), Ministral 3B | Account |
| **Imbue** | Default backend | None (built-in) |

Local models are downloaded once and cached in the browser's Cache Storage.

## Quick Start

### Chrome / Edge (Web Store)

[**Install Bouncer**](https://chromewebstore.google.com/detail/bouncer-heal-your-feed-on/bkijmhafoocfloemhancbgadknkgdkcm) from the Chrome Web Store.

### Chrome / Edge (from source)

```bash
cd Bouncer
npm install
npm run build
```

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked** and select the `Bouncer/` folder
4. Navigate to twitter.com / x.com

### iOS

[**Install from the App Store**](https://apps.apple.com/us/app/bouncer-heal-your-feed/id6759466393)

For development:
Open `Bouncer_xcode/Bouncer.xcodeproj` in Xcode, build and sideload on your phone. See [`Bouncer_xcode/README.md`](Bouncer_xcode/README.md) for details.


## How It Works

1. A MutationObserver watches the Twitter feed for new posts
2. Post text, images, and metadata are extracted via the Twitter adapter
3. Posts are queued and sent to the selected AI model for classification against your filter topics
4. The model returns a category match and reasoning for each post
5. Matching posts are hidden with a fade-out animation and added to your filtered posts list
6. Click **View filtered** to review hidden posts and see why each was filtered

Results are cached so re-encountering a post doesn't require another inference call.
