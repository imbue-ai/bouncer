import type { PlatformAdapter } from './types';

declare global {
  var BouncerAdapter: new () => PlatformAdapter;
  var DOMPurify: { sanitize(dirty: string, config?: Record<string, unknown>): string };
  // esbuild replaces process.env.* at build time
  var process: { env: Record<string, string> };
}

export {};
