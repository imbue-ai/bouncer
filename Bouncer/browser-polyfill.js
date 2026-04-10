(function initBrowserPolyfill() {
  if (typeof chrome !== 'undefined' && chrome.runtime) return;
  if (typeof browser === 'undefined') return;
  globalThis.chrome = browser;
})();
