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
  SUPPORTED_IMAGE_MIME_TYPES,
  type ContentPart,
  type Conversation,
  type ConversationConfig,
  type Message,
} from '@litert-lm/core';
import type { LocalModelDef, ChatMessage } from '../types';
import { PREDEFINED_MODELS } from '../shared/models';

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

// Vision config for the loaded model, or null when the engine is text-only.
type VisionConfig = NonNullable<NonNullable<LocalModelDef['litertlmConfig']>['vision']>;

export function visionConfigFor(modelDef: LocalModelDef): VisionConfig | null {
  if (modelDef.supportsImages !== true) return null;
  return modelDef.litertlmConfig?.vision ?? null;
}

// Fetch one post image as bytes LiteRT-LM's native decoder accepts. The
// platform CDNs (pbs.twimg.com, i.ytimg.com, *.fbcdn.net, media.licdn.com)
// all send Access-Control-Allow-Origin, so the extension origin can read
// them directly. Formats the decoder lacks (WebP, AVIF) are re-encoded to
// PNG through an OffscreenCanvas.
async function fetchImageBytes(url: string): Promise<Uint8Array> {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Image fetch failed: ${resp.status}`);
  const blob = await resp.blob();
  const mime = blob.type.split(';')[0].trim().toLowerCase();
  if (SUPPORTED_IMAGE_MIME_TYPES.has(mime)) {
    return new Uint8Array(await blob.arrayBuffer());
  }
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('No 2d context for image transcode');
    ctx.drawImage(bitmap, 0, 0);
    const png = await canvas.convertToBlob({ type: 'image/png' });
    return new Uint8Array(await png.arrayBuffer());
  } finally {
    bitmap.close();
  }
}

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

// Delete cached models no catalog entry points at any more — e.g. the
// text-only `-web.litertlm` files the catalog used before vision. Each is
// 2-3 GB, so drop them before a new download needs the quota.
async function pruneStaleModels(cache: Cache): Promise<void> {
  const current = new Set(PREDEFINED_MODELS.local.map(m => m.litertlmConfig?.modelUrl));
  for (const req of await cache.keys()) {
    if (current.has(req.url)) continue;
    console.log('[LiteRT-LM] Pruning stale cached model', req.url);
    try { await cache.delete(req); }
    catch (e) { console.error('[LiteRT-LM] Error pruning', req.url, e); }
  }
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
    // Cache hit: no download, so no progress events. The in-feed loading UI
    // keys off download progress ('downloading' state) and deliberately
    // stays hidden for the few seconds of cache-to-GPU streaming.
    return cached;
  }

  await pruneStaleModels(cache);

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
  // Prefix cache (mirrors the iOS getOrBuildBase pattern): a long-lived
  // "base" Conversation holds the prefilled preface (system prompt), and
  // each generate() clones it — clone() copies the KV cache, so only the
  // per-post user message is prefilled per call. Keyed by the preface
  // content + session config so a changed system prompt rebuilds the base.
  private baseConversation: Conversation | null = null;
  private baseKey: string | null = null;
  // The previous generate()'s clone, kept alive until the NEXT clone has been
  // scheduled. The engine records each clone task as the base session's
  // "last task", but the task is owned by the *cloned* session — deleting the
  // clone right away erases that task, and the next clone() then fails with
  // "Dependency task N is invalid" (see runtime/framework/resource_management/
  // serial_execution_manager.cc upstream). A completed-but-undeleted task is a
  // valid dependency, so deferring the delete by one call is sufficient.
  private retiredClone: Conversation | null = null;
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

    // Progress events are emitted only by the real network download inside
    // fetchAndCacheModel. Wasm loading, cache hits, and the cache-to-GPU
    // stream report nothing — callers see state 'initializing' until ready.
    await ensureWasmLoaded();
    if (abortSignal.aborted) throw new Error('aborted');

    const cached = await fetchAndCacheModel(cfg.modelUrl, onProgress, abortSignal);
    if (abortSignal.aborted) throw new Error('aborted');

    // Engine.create supports streaming load: pass the ReadableStream straight
    // in so the multi-GB blob is streamed into the GPU instead of
    // materialized contiguously. The backend (GPU for the generic files,
    // GPU_ARTISAN for `-web` ones) is resolved from the file itself.
    if (!cached.body) throw new Error('Cached model response has no body');

    // Vision runs the encoder on WebGPU alongside the decoder. Leaving
    // visionBackend unset keeps the engine text-only, which is required for
    // the GPU_ARTISAN `-web` files (they carry no vision sections).
    const vision = visionConfigFor(modelDef);
    this.engine = await Engine.create({
      model: cached.body,
      ...(vision ? {
        visionBackend: Backend.GPU,
        maxVisionTokensPerImage: vision.maxVisionTokensPerImage,
      } : {}),
      mainExecutorSettings: {
        maxNumTokens: cfg.maxTokens ?? 1024,
        ...(vision ? { maxNumImages: vision.maxNumImages } : {}),
      },
    });

    if (abortSignal.aborted) {
      await this.engine.delete();
      this.engine = null;
      throw new Error('aborted');
    }
    this.modelDef = modelDef;
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
    await this.dropBase();
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
  // Preface messages are flattened to text (the prefix-cache key is built
  // from them); image_url parts on the last user message become image parts
  // when the engine has vision, and are dropped otherwise.
  private async splitMessages(messages: ChatMessage[]): Promise<{ prefaceMessages: Message[]; userMessage: Message }> {
    const flatten = (content: ChatMessage['content']): string =>
      typeof content === 'string'
        ? content
        : content.filter(c => c.type === 'text').map(c => c.text ?? '').join('');

    const prefaceMessages: Message[] = [];
    let userMessage: Message = { role: 'user', content: '' };
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      const isLastUser = i === messages.length - 1 && m.role === 'user';
      if (isLastUser) {
        const images = await this.loadImages(m.content);
        userMessage = images.length > 0
          // Images before the text: Gemma's documented ordering, and the
          // prompt text refers to "the attached images".
          ? { role: 'user', content: [...images, { type: 'text', text: flatten(m.content) }] }
          : { role: 'user', content: flatten(m.content) };
      } else {
        prefaceMessages.push({ role: m.role, content: flatten(m.content) });
      }
    }
    return { prefaceMessages, userMessage };
  }

  // Fetch the message's image_url parts, capped at the engine's maxNumImages.
  // A failed image is skipped rather than failing the post — the rest of the
  // post (text and any other images) is still classifiable.
  private async loadImages(content: ChatMessage['content']): Promise<ContentPart[]> {
    const vision = this.modelDef ? visionConfigFor(this.modelDef) : null;
    if (!vision || typeof content === 'string') return [];
    const urls = content
      .filter(c => c.type === 'image_url' && c.image_url?.url)
      .map(c => c.image_url!.url)
      .slice(0, vision.maxNumImages);
    const results = await Promise.allSettled(urls.map(fetchImageBytes));
    const parts: ContentPart[] = [];
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') {
        parts.push({ type: 'image', data: r.value });
      } else {
        console.warn('[LiteRT-LM] Skipping image', urls[i], r.reason);
      }
    });
    return parts;
  }

  generate(messages: ChatMessage[], maxTokens: number, _params: Record<string, unknown>): Promise<string> {
    if (!this.engine) throw new Error('Engine not loaded');
    // Start image fetches now so they overlap with whatever generation is
    // ahead of us in the chain. Swallow here; the rejection is rethrown when
    // awaited inside the chain.
    const split = this.splitMessages(messages);
    split.catch(() => undefined);
    return this.enqueue(async () => {
      if (!this.engine) throw new Error('Engine not loaded');

      const { prefaceMessages, userMessage } = await split;

      // Clone from the prefix-cached base so only the user message needs
      // prefill; each clone is stateless — no KV-cache carryover between
      // unrelated posts.
      const base = await this.getOrBuildBase(prefaceMessages, maxTokens);
      let conversation: Conversation | null = null;
      let failed = false;
      try {
        conversation = await base.clone();
        // The new clone task has been scheduled with its dependency on the
        // previous clone's task already resolved, so the previous clone is
        // now safe to delete.
        await this.deleteRetiredClone();
        this.activeConversation = conversation;
        this.generating = true;
        const response = await conversation.sendMessage(userMessage);
        const raw = this.extractText(response);
        return raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
      } catch (e) {
        // A failed clone or send may reflect broken engine state that a stale
        // base would keep reproducing on every clone; drop it so the next
        // call rebuilds from scratch (same recovery as iOS
        // dropBaseConversation).
        failed = true;
        throw e;
      } finally {
        this.generating = false;
        this.activeConversation = null;
        if (failed) {
          // Best-effort dispose. Errors here would mask the generation error.
          if (conversation) {
            try { await conversation.delete(); } catch { /* noop */ }
          }
          await this.dropBase();
        } else {
          // Keep the clone alive until the next generate() schedules its
          // clone — see retiredClone.
          this.retiredClone = conversation;
        }
      }
    });
  }

  private async deleteRetiredClone(): Promise<void> {
    if (!this.retiredClone) return;
    const retired = this.retiredClone;
    this.retiredClone = null;
    try { await retired.delete(); }
    catch (e) { console.error('[LiteRT-LM] Error deleting retired clone:', e); }
  }

  // Return the cached base Conversation for this preface + config, building
  // (and preface-prefilling) a fresh one on any miss. Callers already hold
  // the enqueue chain, so there is no concurrent-access hazard on the cache.
  private async getOrBuildBase(prefaceMessages: Message[], maxTokens: number): Promise<Conversation> {
    if (!this.engine) throw new Error('Engine not loaded');
    const key = JSON.stringify({ prefaceMessages, maxTokens });
    if (this.baseConversation && this.baseKey === key) {
      return this.baseConversation;
    }
    // Same diagnostic as the iOS side: distinguishes first-call/dropped-base
    // misses from a changed preface so device logs explain per-post rebuilds.
    console.log(`[LiteRT-LM] base rebuild reason=${this.baseConversation ? 'key-changed' : 'no-base'}`);
    await this.dropBase();

    // Always GREEDY (top-1); a requested temperature in generate()'s params
    // is deliberately ignored. The GPU backend's max_top_k defaults to 1
    // and Engine.create can only raise it by supplying a complete
    // GpuArtisanConfig (whose defaults live in the wasm binary), so a
    // TOP_K session with k > 1 is rejected at session startup inside
    // sendMessage ("Top-K value 40 must be <= 1") — and the failed
    // attempt poisons the engine's context handler (every later session
    // RET_CHECKs with "processed context is already set"), so a
    // try-sampled-then-retry-greedy fallback is not viable either.
    // Until the engine is created with a raised max_top_k, sampled
    // callers (phrase suggestions request temperature 0.7) get clamped
    // to deterministic greedy output instead of an error.
    const conversationConfig: ConversationConfig = {
      preface: { messages: prefaceMessages },
      // Prefill the preface into the base's KV cache at creation time so
      // clones inherit it instead of re-prefilling the system prompt per post.
      prefillPrefaceOnInit: true,
      sessionConfig: {
        ...(maxTokens > 0 ? { maxOutputTokens: maxTokens } : {}),
        samplerParams: {
          type: SamplerType.GREEDY,
          k: 1,
          temperature: 0,
          seed: 0,
        },
      },
    };

    const base = await this.engine.createConversation(conversationConfig);
    this.baseConversation = base;
    this.baseKey = key;
    return base;
  }

  private async dropBase(): Promise<void> {
    await this.deleteRetiredClone();
    if (this.baseConversation) {
      try { await this.baseConversation.delete(); }
      catch (e) { console.error('[LiteRT-LM] Error deleting base conversation:', e); }
    }
    this.baseConversation = null;
    this.baseKey = null;
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

