import type { PlatformAdapter } from './types';

declare global {
  var BouncerAdapter: new () => PlatformAdapter;
  var DOMPurify: {
    sanitize(dirty: string, config: { RETURN_DOM_FRAGMENT: true } & Record<string, unknown>): DocumentFragment;
    sanitize(dirty: string, config?: Record<string, unknown>): string;
  };
  // esbuild replaces process.env.* at build time
  var process: { env: Record<string, string> };

  // iOS WKWebView polyfill bridge
  var webkit: {
    messageHandlers: Record<string, { postMessage(msg: unknown): void }>;
  };

  interface Window {
    /** Injected by iOS native host: popup HTML + CSS for in-app settings modal */
    __feedfilterPopup?: { html: string; css: string };
  }

  // Extend chrome namespace for iOS polyfill flag
  namespace chrome {
    // eslint-disable-next-line no-var
    var _polyfilled: boolean | undefined;
  }
}

export {};
