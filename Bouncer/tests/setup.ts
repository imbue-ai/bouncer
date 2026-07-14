// Build-time env vars (normally replaced by esbuild, need defaults for tests)
globalThis.process = globalThis.process || {};
globalThis.process.env = globalThis.process.env || {};
process.env.BOUNCER_ENV = process.env.BOUNCER_ENV || 'test';
process.env.IMBUE_WS_URL = process.env.IMBUE_WS_URL || 'wss://test.aibutler.api.imbue.com';

// Global mocks for Chrome extension APIs
globalThis.chrome = {
  runtime: {
    id: 'test-extension-id',
    lastError: null,
    getManifest: () => ({ version: '1.0.0' }),
    sendMessage: vi.fn(),
    onMessage: { addListener: vi.fn() },
    onSuspend: { addListener: vi.fn() },
    onInstalled: { addListener: vi.fn() },
  },
  identity: {
    launchWebAuthFlow: vi.fn(),
    getRedirectURL: () => 'https://test-extension-id.chromiumapp.org/',
  },
  storage: {
    local: {
      get: vi.fn().mockResolvedValue({}),
      set: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
    },
    onChanged: { addListener: vi.fn() },
  },
  tabs: {
    onRemoved: { addListener: vi.fn() },
    sendMessage: vi.fn(),
  },
} as unknown as typeof chrome;

// DOMPurify is loaded as a separate content script at runtime (see
// manifest.json content_scripts → dompurify.js), so it's a runtime global
// rather than an import. Tests that exercise `parseHTML` need it stubbed.
// Use the test DOM parser directly — sanitization isn't what's being tested.
(globalThis as unknown as { DOMPurify: { sanitize: (html: string, opts?: { RETURN_DOM_FRAGMENT?: boolean }) => DocumentFragment | string } }).DOMPurify = {
  sanitize(html: string, opts?: { RETURN_DOM_FRAGMENT?: boolean }) {
    if (opts?.RETURN_DOM_FRAGMENT) {
      const tpl = document.createElement('template');
      tpl.innerHTML = html;
      return tpl.content;
    }
    return html;
  },
};
