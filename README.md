# Bouncer

<p align="center">
  <img src="Bouncer/icons/icon128.png" alt="Bouncer" width="128" />
</p>

**Heal your feed.** Bouncer is a browser extension that uses AI to filter unwanted posts from your Twitter/X feed. Define filter topics in plain language — "crypto", "engagement bait", "rage politics" — and Bouncer classifies and hides matching posts in real time.

<p align="center">
  <img src="appstore_assets/demo.gif" alt="Bouncer demo" />
</p>

[**Available on the app stores for Chrome, Firefox, Safari, iOS, and Android**](https://imbue.com/product/bouncer/redirect.html)

## Features

- **Semantic filtering**: define your filters in natural language, rather than giving exact strings to remove
- **AI detection**: remove slop text and images using our custom-trained AI detector model
- **On-device inference**: local models run entirely in your browser with zero data sent externally
- **Image-aware filtering**: multimodal models can classify posts based on images, not just text
- **Multiple AI backends**: run models locally on your GPU, or use cloud APIs (OpenAI, Google Gemini, Anthropic, OpenRouter)
- **Theme-aware UI**: adapts to light, dim, and dark modes automatically

## Quick Start

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
5. Click "Settings" in the Bouncer element and add your preferred provider API key (or enable local models) and select your preferred model from the dropdown.

### Firefox (from source)

```bash
cd Bouncer
npm install
npm run build:firefox
```

1. Open `about:debugging`
2. Click **This Firefox** on the left menu
3. Click **Load Temporary Add-on...** and select the file `Bouncer/manifest.json`
4. Navigate to twitter.com / x.com
5. Click "Settings" in the Bouncer element and add your preferred provider API key (or enable local models) and select your preferred model from the dropdown.

### iOS

[**Install from the App Store**](https://apps.apple.com/us/app/bouncer-heal-your-feed/id6759466393)

## How It Works

1. A MutationObserver watches the Twitter feed for new posts
2. Post text, images, and metadata are extracted via the Twitter adapter
3. Posts are queued and sent to the selected AI model for classification against your filter topics
4. The model returns a category match and reasoning for each post
5. Matching posts are hidden with a fade-out animation and added to your filtered posts list
6. Click **View filtered** to review hidden posts and see why each was filtered

Results are cached so re-encountering a post doesn't require another inference call.
