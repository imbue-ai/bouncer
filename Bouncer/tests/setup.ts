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
