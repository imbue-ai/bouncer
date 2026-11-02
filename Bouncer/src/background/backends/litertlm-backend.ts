// LiteRT-LM LocalBackend. The Chrome MV3 service worker proxies all calls to
// an offscreen document because @litertjs/wasm-utils uses <script>-tag
// injection to load the wasm runner, which a module SW cannot do. Firefox
// and Safari use background event pages (with a real `document`) and can
// host the runtime directly — the backend picks the right path at
// construction time.

import type { LocalModelDef, ChatMessage } from '../../types';
import type { LocalBackend, InitProgress } from './types';
import { LitertlmProxy } from './litertlm-proxy';
import { LitertlmRuntime, visionConfigFor } from '../../offscreen/litertlm-runtime';

interface Impl {
  initialize(d: LocalModelDef, p: (x: InitProgress) => void, s: AbortSignal): Promise<void>;
  unload(): Promise<void>;
  generate(m: ChatMessage[], n: number, params: Record<string, unknown>): Promise<string>;
  interrupt(): void | Promise<void>;
  countTokens(t: string): number | Promise<number>;
  truncateText(t: string, n: number): string | Promise<string>;
}

function hasDocument(): boolean {
  return typeof document !== 'undefined';
}

export class LitertlmBackend implements LocalBackend {
  private impl: Impl;
  private modelDef: LocalModelDef | null = null;

  constructor() {
    // Direct mode in any window/event-page context; proxy through the
    // offscreen document inside Chrome's ESM service worker.
    this.impl = hasDocument() ? new LitertlmRuntime() : new LitertlmProxy();
  }

  async initialize(modelDef: LocalModelDef, onProgress: (p: InitProgress) => void, abortSignal: AbortSignal): Promise<void> {
    await this.impl.initialize(modelDef, onProgress, abortSignal);
    this.modelDef = modelDef;
  }

  unload(): Promise<void> {
    this.modelDef = null;
    return this.impl.unload();
  }

  generate(messages: ChatMessage[], maxTokens: number, params: Record<string, unknown>): Promise<string> {
    return this.impl.generate(messages, maxTokens, params);
  }

  async interrupt(): Promise<void> {
    await this.impl.interrupt();
  }

  async countTokens(text: string): Promise<number> {
    return this.impl.countTokens(text);
  }

  async truncateText(text: string, maxTokens: number): Promise<string> {
    return this.impl.truncateText(text, maxTokens);
  }

  // Per-image token cost for context budgeting. Read from the model def
  // rather than the engine so the SW doesn't need an offscreen round-trip;
  // the runtime passes the same value to Engine.create.
  // eslint-disable-next-line @typescript-eslint/require-await
  async getImageEmbedSize(): Promise<number> {
    if (!this.modelDef) throw new Error('Engine not loaded');
    return visionConfigFor(this.modelDef)?.maxVisionTokensPerImage ?? 0;
  }
}

// Static cache probe used by LocalEngine to query state without loading the
// model. Routes to the same code path either way: in a window context we can
// open the Cache Storage directly; in the SW we can too (Cache API is shared).
export async function isLitertlmCached(modelDef: LocalModelDef): Promise<boolean> {
  return LitertlmRuntime.isCached(modelDef);
}
