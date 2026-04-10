/**
 * Helpers for loading the static Twitter HTML fixture into the test document.
 *
 * Usage:
 *   import { loadTwitterFixture, getTweetArticles } from '../fixtures/twitter-dom.js';
 *   loadTwitterFixture();
 *   const articles = getTweetArticles();
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const html = readFileSync(resolve(__dirname, 'twitter.html'), 'utf8');

/**
 * Load the Twitter fixture HTML into the current happy-dom document.
 * Replaces document body content and copies body styles from the fixture.
 */
export function loadTwitterFixture() {
  // Polyfill video.poster — happy-dom doesn't implement it as an IDL attribute
  if (!('poster' in HTMLVideoElement.prototype)) {
    Object.defineProperty(HTMLVideoElement.prototype, 'poster', {
      get() { return this.getAttribute('poster') || ''; },
      set(v) { this.setAttribute('poster', v); },
      configurable: true,
    });
  }

  const parser = new DOMParser();
  const parsed = parser.parseFromString(html, 'text/html');

  document.body.innerHTML = parsed.body.innerHTML;
  const style = parsed.body.getAttribute('style');
  if (style) {
    document.body.setAttribute('style', style);
  }

  return document;
}

