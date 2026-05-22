// Wraps LiteRT-LM's Engine + Conversation for use as a Bouncer LocalBackend.
// Runs in any DOM-backed context — the Firefox event-page background and the
// Chrome offscreen document both instantiate this directly. Chrome's MV3
// service worker proxies through litertlm-proxy.ts because @litertjs/wasm-utils
// uses <script> tag injection to load the wasm runner, which a module SW
// cannot do.

import {
  Engine,
  loadLiteRtLm,
  unloadLiteRtLm,
  Backend,
  SamplerType,
  type Conversation,
  type ConversationConfig,
  type Message,
} from '@litert-lm/core';
import type { LocalModelDef, ChatMessage } from '../types';

// Cache the .litertlm model in the standard Cache Storage so a reload skips
// the multi-GB download. Keyed by the model URL so multiple models coexist.
const LITERTLM_CACHE_KEY = 'litertlm-cache';

// Path inside the extension where build.js drops the LiteRT-LM wasm loader
// + binaries. Has to be reachable via chrome.runtime.getURL.
const WASM_BASE = 'dist/litertlm-wasm';

// Rough chars-per-token for Gemma's BPE tokenizer. LiteRT-LM's JS layer
// doesn't expose a tokenizer, so we use a conservative estimate — round down
// in chars-to-tokens (estimateTokens) and round down in tokens-to-chars
// (truncateText) to err on the side of fitting in the budget.
const CHARS_PER_TOKEN = 3;

export interface InitProgress {
  progress: number;
  text: string;
}

function getWasmBaseUrl(): string {
  // Same-origin path resolved through the extension URL scheme. The
  // LiteRT-LM loader appends litertlm_wasm_internal.js (or its compat
  // variant) to this prefix.
  return chrome.runtime.getURL(`${WASM_BASE}/`);
}

// Stream a remote model into the Cache Storage while reporting progress.
// Returns a fresh Response for the now-cached entry so the caller can pull
// the body without re-downloading.
async function fetchAndCacheModel(
  url: string,
  onProgress: (p: InitProgress) => void,
  abortSignal: AbortSignal,
): Promise<Response> {
  const cache = await caches.open(LITERTLM_CACHE_KEY);
  const cached = await cache.match(url);
  if (cached) {
    onProgress({ progress: 1, text: 'cached' });
    return cached;
  }

  const upstream = await fetch(url, { signal: abortSignal });
  if (!upstream.ok || !upstream.body) {
    throw new Error(`Failed to fetch model: ${upstream.status} ${upstream.statusText}`);
  }

  const total = Number(upstream.headers.get('content-length') ?? 0);
  let received = 0;

  // Tee the response so we can both forward progress and store the bytes
  // in Cache Storage. The Cache API takes a Response object whose body
  // hasn't been consumed yet, so build a new Response from the tee.
  const [forCache, forCount] = upstream.body.tee();

  const counter = new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = forCount.getReader();
      for (;;) {
        if (abortSignal.aborted) {
          controller.error(new Error('aborted'));
          return;
        }
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (total > 0) {
          onProgress({ progress: received / total, text: '' });
        }
        controller.enqueue(value);
      }
      controller.close();
    },
  });

  // The progress stream needs to be drained — Cache Storage will read
  // `forCache`, but if nothing pulls from `forCount` the tee will stall.
  // Drive it explicitly and discard.
  void (async (): Promise<void> => {
    const reader = counter.getReader();
    while (!(await reader.read()).done) { /* drained for progress */ }
  })();

  const responseForCache = new Response(forCache, { headers: upstream.headers });
  await cache.put(url, responseForCache);
  const cachedAfter = await cache.match(url);
  if (!cachedAfter) throw new Error('Failed to cache model after download');
  onProgress({ progress: 1, text: '' });
  return cachedAfter;
}

// `loadLiteRtLm` throws if called twice. Track our own load promise so the
// offscreen page survives engine reloads without unloading the wasm module —
// reloading the wasm would re-fetch ~19 MB. unloadLiteRtLm() is only used
// when the runtime itself is torn down.
let wasmLoaded: Promise<void> | null = null;
function ensureWasmLoaded(): Promise<void> {
  if (!wasmLoaded) {
    wasmLoaded = loadLiteRtLm(getWasmBaseUrl()).then(() => undefined);
  }
  return wasmLoaded;
}

export class LitertlmRuntime {
  private engine: Engine | null = null;
  private modelDef: LocalModelDef | null = null;
  private activeConversation: Conversation | null = null;
  private generating = false;
  // LiteRT-LM serializes work through its own executor mutex, but we keep an
  // explicit chain here for the same reason as before: unload() and
  // interrupt() must wait for any in-flight generate() to settle before
  // touching engine state, and the chain provides that ordering.
  private chain: Promise<unknown> = Promise.resolve();

  private enqueue<T>(op: () => T | Promise<T>): Promise<T> {
    const next = this.chain.catch(() => undefined).then(() => op());
    // Reassign before returning so back-to-back enqueue() calls all chain
    // off the same in-flight tail rather than racing against `this.chain`.
    this.chain = next.catch(() => undefined);
    return next;
  }

  async initialize(
    modelDef: LocalModelDef,
    onProgress: (p: InitProgress) => void,
    abortSignal: AbortSignal,
  ): Promise<void> {
    const cfg = modelDef.litertlmConfig;
    if (!cfg) throw new Error(`Model ${modelDef.name} is missing litertlmConfig`);

    onProgress({ progress: 0, text: '' });
    await ensureWasmLoaded();
    if (abortSignal.aborted) throw new Error('aborted');

    const cached = await fetchAndCacheModel(cfg.modelUrl, onProgress, abortSignal);
    if (abortSignal.aborted) throw new Error('aborted');

    // LiteRT-LM's default backend (GPU_ARTISAN) supports streaming load:
    // pass the ReadableStream straight into Engine.create so the multi-GB
    // blob is streamed into the GPU instead of materialized contiguously.
    if (!cached.body) throw new Error('Cached model response has no body');

    this.engine = await Engine.create({
      model: cached.body,
      mainExecutorSettings: { maxNumTokens: cfg.maxTokens ?? 1024 },
    });

    if (abortSignal.aborted) {
      await this.engine.delete();
      this.engine = null;
      throw new Error('aborted');
    }
    this.modelDef = modelDef;
    onProgress({ progress: 1, text: '' });
  }

  async unload(): Promise<void> {
    // cancel() in-flight generation, then drain the chain (prefill may not be
    // cancellable; the executor mutex will settle once it completes), then
    // delete the engine. delete() while generation is in flight would race.
    if (this.activeConversation && this.generating) {
      this.activeConversation.cancel();
    }
    await this.chain.catch(() => undefined);
    if (this.activeConversation) {
      try { await this.activeConversation.delete(); }
      catch (e) { console.error('[LiteRT-LM] Error deleting conversation:', e); }
      this.activeConversation = null;
    }
    try { await this.engine?.delete(); }
    catch (e) { console.error('[LiteRT-LM] Error deleting engine:', e); }
    this.engine = null;
    this.modelDef = null;
    this.generating = false;
    this.chain = Promise.resolve();
  }

  // Translate Bouncer's ChatMessage[] into LiteRT-LM's Preface + final user
  // message. The system message goes into the preface; the last user message
  // is what gets sent. LiteRT-LM applies the model's chat template internally.
  private splitMessages(messages: ChatMessage[]): { prefaceMessages: Message[]; userText: string } {
    const flatten = (content: ChatMessage['content']): string =>
      typeof content === 'string'
        ? content
        : content.filter(c => c.type === 'text').map(c => c.text ?? '').join('');

    const prefaceMessages: Message[] = [];
    let userText = '';
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      const text = flatten(m.content);
      const isLastUser = i === messages.length - 1 && m.role === 'user';
      if (isLastUser) {
        userText = text;
      } else {
        prefaceMessages.push({ role: m.role, content: text });
      }
    }
    return { prefaceMessages, userText };
  }

  generate(messages: ChatMessage[], _maxTokens: number, params: Record<string, unknown>): Promise<string> {
    if (!this.engine) throw new Error('Engine not loaded');
    return this.enqueue(async () => {
      if (!this.engine) throw new Error('Engine not loaded');

      const { prefaceMessages, userText } = this.splitMessages(messages);
      const cfg = this.modelDef?.litertlmConfig;
      const defaultParams = this.modelDef?.inferenceParams ?? {};
      const temperature = typeof params.temperature === 'number'
        ? params.temperature
        : typeof defaultParams.temperature === 'number'
          ? defaultParams.temperature
          : 0.0;

      // GREEDY when temperature is 0 (deterministic classification);
      // otherwise TOP_K with the configured k. Bouncer's table_yesno
      // classifier wants deterministic verdicts so temperature=0 is the
      // common path. Greedy means top-1, so k MUST be 1 — the GPU backend
      // defaults max_top_k to 1 and rejects larger values otherwise.
      const isGreedy = temperature === 0;
      const samplerType = isGreedy ? SamplerType.GREEDY : SamplerType.TOP_K;
      const k = isGreedy ? 1 : (cfg?.topK ?? 40);

      const conversationConfig: ConversationConfig = {
        preface: { messages: prefaceMessages },
        sessionConfig: {
          samplerParams: {
            type: samplerType,
            k,
            temperature,
            seed: 0,
          },
        },
      };

      // Create a fresh Conversation per call so each classification is
      // stateless — no KV-cache carryover between unrelated posts.
      const conversation = await this.engine.createConversation(conversationConfig);
      this.activeConversation = conversation;
      this.generating = true;
      try {
        const response = await conversation.sendMessage(userText);
        const raw = this.extractText(response);
        return raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
      } finally {
        this.generating = false;
        this.activeConversation = null;
        // Best-effort dispose. Errors here would mask a generation error.
        try { await conversation.delete(); } catch { /* noop */ }
      }
    });
  }

  private extractText(message: Message): string {
    const content = message.content;
    if (typeof content === 'string') return content;
    if (!content) return '';
    return content.map(item => (item.type === 'text' ? (item.text ?? '') : '')).join('');
  }

  // Signals LiteRT-LM to abort decode, then awaits the chain so the caller
  // can rely on "interrupt resolved → engine idle". Prefill may not be
  // cancellable, so this may still take seconds on a fresh prompt.
  interrupt(): Promise<void> {
    if (this.activeConversation && this.generating) {
      this.activeConversation.cancel();
    }
    return this.chain.then(() => undefined, () => undefined);
  }

  // LiteRT-LM's JS layer doesn't expose a tokenizer. Approximate via
  // character count — Gemma BPE averages ~3.5 chars/token; we use 3 to
  // round up in token count so the orchestrator's budget math is
  // conservative.
  countTokens(text: string): Promise<number> {
    return Promise.resolve(Math.ceil(text.length / CHARS_PER_TOKEN));
  }

  truncateText(text: string, maxTokens: number): Promise<string> {
    if (Math.ceil(text.length / CHARS_PER_TOKEN) <= maxTokens) {
      return Promise.resolve(text);
    }
    return Promise.resolve(text.slice(0, maxTokens * CHARS_PER_TOKEN));
  }

  // Static cache probe so the orchestrator can ask "is this model on disk"
  // without instantiating Engine (which requires WebGPU and big memory).
  static async isCached(modelDef: LocalModelDef): Promise<boolean> {
    try {
      const url = modelDef.litertlmConfig?.modelUrl;
      if (!url) return false;
      if (typeof caches === 'undefined') return false;
      const cache = await caches.open(LITERTLM_CACHE_KEY);
      const hit = await cache.match(url);
      return hit !== undefined;
    } catch (e) {
      console.error('[LiteRT-LM] Error checking cache for', modelDef.name, ':', e);
      return false;
    }
  }
}

// Exposed for tests / teardown paths. The runtime itself never calls this
// during a normal session — the wasm module survives engine reloads.
export function unloadLitertlmWasm(): void {
  if (wasmLoaded) {
    try { unloadLiteRtLm(); } catch { /* noop */ }
    wasmLoaded = null;
  }
}

// Suppress unused-import warning on Backend. We don't override the default
// (GPU_ARTISAN, set by Engine.create) yet, but re-exporting keeps the import
// list tied to the API surface the runtime depends on.
export { Backend };
