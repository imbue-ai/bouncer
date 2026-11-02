// Chrome built-in AI (Prompt API / Gemini Nano) LocalBackend. Chrome owns the
// model download, storage, and GPU/CPU placement; we only create sessions.
// The `LanguageModel` global is exposed directly in extension service
// workers (Chrome 138+), so unlike LiteRT-LM there's no offscreen hop.
//
// Same prefix-cache shape as LitertlmRuntime: a long-lived base session holds
// the system prompt in `initialPrompts`, and each generate() clones it so
// only the per-post user message is prefilled.

import type { LocalModelDef, ChatMessage } from '../../types';
import type { LocalBackend, InitProgress } from './types';
import { yesnoRowRegex } from '../../shared/prompts';

// Minimal typings for the subset of the Prompt API we use. Chrome renamed
// inputUsage/inputQuota/measureInputUsage to contextUsage/contextWindow/
// measureContextUsage; both spellings are probed.
type Availability = 'unavailable' | 'downloadable' | 'downloading' | 'available';
type PromptContent = { type: 'text'; value: string } | { type: 'image'; value: Blob };
type PromptInput = string | { role: 'user' | 'assistant' | 'system'; content: string | PromptContent[] }[];
interface ExpectedIO { type: 'text' | 'image' | 'audio'; languages?: string[] }
interface CreateOptions {
  initialPrompts?: { role: 'system' | 'user' | 'assistant'; content: string }[];
  temperature?: number;
  topK?: number;
  expectedInputs?: ExpectedIO[];
  expectedOutputs?: ExpectedIO[];
  signal?: AbortSignal;
  monitor?: (m: EventTarget) => void;
}
interface PromptOptions { signal?: AbortSignal; responseConstraint?: unknown }
interface LanguageModelSession {
  prompt(input: PromptInput, opts?: PromptOptions): Promise<string>;
  clone(opts?: { signal?: AbortSignal }): Promise<LanguageModelSession>;
  destroy(): void;
  measureContextUsage?(input: PromptInput): Promise<number>;
  measureInputUsage?(input: PromptInput): Promise<number>;
  contextWindow?: number;
  inputQuota?: number;
}
interface LanguageModelStatic {
  availability(opts?: CreateOptions): Promise<Availability>;
  create(opts?: CreateOptions): Promise<LanguageModelSession>;
  params?(): Promise<{ defaultTopK: number; maxTopK: number; defaultTemperature: number; maxTemperature: number } | null>;
}

function getLanguageModel(): LanguageModelStatic | null {
  return (globalThis as { LanguageModel?: LanguageModelStatic }).LanguageModel ?? null;
}

export function isPromptApiPresent(): boolean {
  return getLanguageModel() !== null;
}

const TEXT_IO: ExpectedIO[] = [{ type: 'text', languages: ['en'] }];
const VISION_INPUTS: ExpectedIO[] = [...TEXT_IO, { type: 'image' }];

function sessionOptions(withImages: boolean): CreateOptions {
  return {
    expectedInputs: withImages ? VISION_INPUTS : TEXT_IO,
    expectedOutputs: TEXT_IO,
  };
}

export async function promptApiAvailability(modelDef: LocalModelDef): Promise<Availability> {
  const LM = getLanguageModel();
  if (!LM) return 'unavailable';
  try {
    // Text is the floor: a device that can't take image input still runs
    // text-only classification.
    const text = await LM.availability(sessionOptions(false));
    if (text === 'unavailable' || modelDef.supportsImages !== true) return text;
    const vision = await LM.availability(sessionOptions(true));
    return vision === 'unavailable' ? text : vision;
  } catch (e) {
    console.error('[PromptAPI] availability() failed:', e);
    return 'unavailable';
  }
}

// Kick off Gemini Nano's download from a context that has user activation
// (the popup's download click). create() needs transient activation while
// the model is still downloadable, which the extension service worker never
// has; once Chrome has started the download it continues browser-side even
// after the popup closes, and the worker's own create() then succeeds.
export async function startPromptApiDownloadFromUserGesture(modelDef: LocalModelDef): Promise<void> {
  const LM = getLanguageModel();
  if (!LM) return;
  const opts = sessionOptions(modelDef.supportsImages === true);
  if (await LM.availability(opts) === 'unavailable') return;
  const session = await LM.create(opts);
  session.destroy();
}

// Fetch a post image as a Blob. The Prompt API decodes Blobs itself, so no
// transcode step is needed (unlike LiteRT-LM's native decoder).
async function fetchImageBlob(url: string): Promise<Blob> {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Image fetch failed: ${resp.status}`);
  return resp.blob();
}

const AVAILABILITY_POLL_MS = 2000;
// Output-length safety net for unconstrained prompts — the Prompt API has no
// maxOutputTokens, so cut generation once the response exceeds this many
// characters per requested token.
const MAX_CHARS_PER_OUTPUT_TOKEN = 6;

export class PromptApiBackend implements LocalBackend {
  private modelDef: LocalModelDef | null = null;
  private vision = false;
  private defaultTopK = 3;
  // Used for token measurement; carries no history.
  private utilSession: LanguageModelSession | null = null;
  private baseSession: LanguageModelSession | null = null;
  private baseKey: string | null = null;
  private activeAbort: AbortController | null = null;
  private imageTokens = 0;
  // Flipped off the first time Chrome rejects a RegExp responseConstraint.
  private regexConstraintSupported = true;
  private chain: Promise<unknown> = Promise.resolve();

  private enqueue<T>(op: () => Promise<T>): Promise<T> {
    const next = this.chain.catch(() => undefined).then(op);
    this.chain = next.catch(() => undefined);
    return next;
  }

  async initialize(modelDef: LocalModelDef, onProgress: (p: InitProgress) => void, abortSignal: AbortSignal): Promise<void> {
    const LM = getLanguageModel();
    if (!LM) throw new Error('Chrome Prompt API not available');

    const availability = await promptApiAvailability(modelDef);
    if (availability === 'unavailable') {
      throw new Error('Gemini Nano is unavailable on this device');
    }
    this.vision = modelDef.supportsImages === true
      && await LM.availability(sessionOptions(true)) !== 'unavailable';

    const opts: CreateOptions = {
      ...sessionOptions(this.vision),
      signal: abortSignal,
      monitor: (m) => {
        m.addEventListener('downloadprogress', (e) => {
          const loaded = (e as Event & { loaded?: number }).loaded;
          if (typeof loaded === 'number') onProgress({ progress: loaded, text: '' });
        });
      },
    };

    try {
      this.utilSession = await LM.create(opts);
    } catch (e) {
      // No user activation in the service worker. If the popup already
      // kicked the download off, wait for Chrome to finish it.
      if ((e as DOMException)?.name !== 'NotAllowedError') throw e;
      if (availability === 'downloadable') {
        throw new Error('Gemini Nano download must be started from the popup', { cause: e });
      }
      await this.waitUntilAvailable(LM, onProgress, abortSignal);
      this.utilSession = await LM.create(sessionOptions(this.vision));
    }
    if (abortSignal.aborted) {
      this.utilSession.destroy();
      this.utilSession = null;
      throw new Error('aborted');
    }

    try {
      const params = await LM.params?.();
      if (params?.defaultTopK) this.defaultTopK = params.defaultTopK;
    } catch { /* params() is extension-only and optional */ }

    this.imageTokens = this.vision ? await this.measureImageTokens() : 0;
    this.modelDef = modelDef;
  }

  private async waitUntilAvailable(LM: LanguageModelStatic, onProgress: (p: InitProgress) => void, abortSignal: AbortSignal): Promise<void> {
    onProgress({ progress: 0, text: 'Chrome is downloading Gemini Nano...' });
    for (;;) {
      if (abortSignal.aborted) throw new Error('aborted');
      if (await LM.availability(sessionOptions(this.vision)) === 'available') return;
      await new Promise(r => setTimeout(r, AVAILABILITY_POLL_MS));
    }
  }

  // Per-image token cost, measured once on a mid-size blank image. Returns 0
  // (callLocalInference then skips image budgeting) if measuring fails.
  private async measureImageTokens(): Promise<number> {
    try {
      const canvas = new OffscreenCanvas(512, 512);
      canvas.getContext('2d')?.fillRect(0, 0, 512, 512);
      const blob = await canvas.convertToBlob({ type: 'image/png' });
      const withImage = await this.measure([{ role: 'user', content: [{ type: 'text', value: 'x' }, { type: 'image', value: blob }] }]);
      const without = await this.measure([{ role: 'user', content: [{ type: 'text', value: 'x' }] }]);
      return Math.max(0, withImage - without);
    } catch (e) {
      console.warn('[PromptAPI] Could not measure image tokens:', e);
      return 0;
    }
  }

  private async measure(input: PromptInput): Promise<number> {
    const s = this.utilSession;
    if (!s) throw new Error('Engine not loaded');
    if (s.measureContextUsage) return s.measureContextUsage(input);
    if (s.measureInputUsage) return s.measureInputUsage(input);
    throw new Error('Prompt API has no token-measurement method');
  }

  async unload(): Promise<void> {
    this.activeAbort?.abort();
    await this.chain.catch(() => undefined);
    this.dropBase();
    this.utilSession?.destroy();
    this.utilSession = null;
    this.modelDef = null;
    this.chain = Promise.resolve();
  }

  private dropBase(): void {
    this.baseSession?.destroy();
    this.baseSession = null;
    this.baseKey = null;
  }

  // Base session for this system prompt + sampling config, rebuilt on a miss.
  // Sampling is session-level in the Prompt API, so temperature is part of
  // the key. Default is greedy (topK 1) to match the LiteRT-LM backend.
  private async getOrBuildBase(systemPrompt: string, temperature: number | undefined): Promise<LanguageModelSession> {
    const LM = getLanguageModel();
    if (!LM) throw new Error('Chrome Prompt API not available');
    const key = JSON.stringify({ systemPrompt, temperature });
    if (this.baseSession && this.baseKey === key) return this.baseSession;
    this.dropBase();
    const sampled = temperature !== undefined && temperature > 0;
    this.baseSession = await LM.create({
      ...sessionOptions(this.vision),
      initialPrompts: systemPrompt ? [{ role: 'system', content: systemPrompt }] : [],
      temperature: sampled ? temperature : 0,
      topK: sampled ? this.defaultTopK : 1,
    });
    this.baseKey = key;
    return this.baseSession;
  }

  private async buildUserContent(content: ChatMessage['content']): Promise<PromptContent[]> {
    if (typeof content === 'string') return [{ type: 'text', value: content }];
    const text = content.filter(c => c.type === 'text').map(c => c.text ?? '').join('');
    if (!this.vision) return [{ type: 'text', value: text }];
    const maxImages = this.modelDef?.promptApiConfig?.maxNumImages ?? Infinity;
    const urls = content
      .filter(c => c.type === 'image_url' && c.image_url?.url)
      .map(c => c.image_url!.url)
      .slice(0, maxImages);
    const results = await Promise.allSettled(urls.map(fetchImageBlob));
    const images: PromptContent[] = [];
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') images.push({ type: 'image', value: r.value });
      else console.warn('[PromptAPI] Skipping image', urls[i], r.reason);
    });
    // Images before the text, matching the LiteRT-LM ordering the prompts
    // were written against ("the attached images").
    return [...images, { type: 'text', value: text }];
  }

  generate(messages: ChatMessage[], maxTokens: number, params: Record<string, unknown>): Promise<string> {
    if (!this.utilSession) throw new Error('Engine not loaded');
    const flatten = (c: ChatMessage['content']): string =>
      typeof c === 'string' ? c : c.filter(p => p.type === 'text').map(p => p.text ?? '').join('');
    const systemPrompt = messages.filter(m => m.role === 'system').map(m => flatten(m.content)).join('\n\n');
    const last = messages[messages.length - 1];
    // Start image fetches now so they overlap with the generation ahead of us.
    const userContent = this.buildUserContent(last?.content ?? '');
    userContent.catch(() => undefined);
    const temperature = typeof params.temperature === 'number' ? params.temperature : undefined;
    const verdictCount = typeof params.verdictCount === 'number' ? params.verdictCount : 0;

    return this.enqueue(async () => {
      const base = await this.getOrBuildBase(systemPrompt, temperature);
      const abort = new AbortController();
      this.activeAbort = abort;
      let session: LanguageModelSession | null = null;
      try {
        session = await base.clone({ signal: abort.signal });
        const input: PromptInput = [{ role: 'user', content: await userContent }];
        const raw = await this.runPrompt(session, input, maxTokens, verdictCount, abort.signal);
        return raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
      } catch (e) {
        if (abort.signal.aborted) throw new Error('Inference interrupted', { cause: e });
        // A broken base would reproduce the failure on every clone.
        this.dropBase();
        throw e;
      } finally {
        session?.destroy();
        if (this.activeAbort === abort) this.activeAbort = null;
      }
    });
  }

  private async runPrompt(
    session: LanguageModelSession,
    input: PromptInput,
    maxTokens: number,
    verdictCount: number,
    signal: AbortSignal,
  ): Promise<string> {
    // Verdict-row callers (callLocalInference / AI-intent) get the same
    // pipe-row regex the iOS LlGuidance path uses, so wrong-arity or
    // markdown-table drift is impossible.
    if (verdictCount > 0 && this.regexConstraintSupported) {
      const responseConstraint = new RegExp(yesnoRowRegex(verdictCount));
      try {
        return await session.prompt(input, { signal, responseConstraint });
      } catch (e) {
        const name = (e as DOMException)?.name;
        if (signal.aborted || (name !== 'NotSupportedError' && !(e instanceof TypeError))) throw e;
        console.warn('[PromptAPI] RegExp responseConstraint unsupported; falling back to unconstrained', e);
        this.regexConstraintSupported = false;
      }
    }
    if (maxTokens <= 0) return session.prompt(input, { signal });
    // No maxOutputTokens in the Prompt API: stream and stop once the output
    // overruns the caller's token budget.
    return this.promptCapped(session, input, maxTokens * MAX_CHARS_PER_OUTPUT_TOKEN, signal);
  }

  private async promptCapped(session: LanguageModelSession, input: PromptInput, maxChars: number, signal: AbortSignal): Promise<string> {
    const s = session as LanguageModelSession & {
      promptStreaming?(input: PromptInput, opts?: PromptOptions): ReadableStream<string>;
    };
    if (!s.promptStreaming) return s.prompt(input, { signal });
    const capAbort = new AbortController();
    const onOuterAbort = (): void => capAbort.abort();
    signal.addEventListener('abort', onOuterAbort, { once: true });
    let out = '';
    try {
      const reader = s.promptStreaming(input, { signal: capAbort.signal }).getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        out += value;
        if (out.length >= maxChars) {
          capAbort.abort();
          break;
        }
      }
      return out;
    } catch (e) {
      // Our own cap-abort is a normal stop; anything else propagates.
      if (capAbort.signal.aborted && !signal.aborted) return out;
      throw e;
    } finally {
      signal.removeEventListener('abort', onOuterAbort);
    }
  }

  async interrupt(): Promise<void> {
    this.activeAbort?.abort();
    await this.chain.catch(() => undefined);
  }

  async countTokens(text: string): Promise<number> {
    return this.measure(text);
  }

  // Proportional shrink against the real tokenizer: slice by the measured
  // chars/token ratio, re-measure, repeat. Converges in 1–2 rounds.
  async truncateText(text: string, maxTokens: number): Promise<string> {
    if (maxTokens <= 0) return '';
    let current = text;
    for (let i = 0; i < 4; i++) {
      const tokens = await this.measure(current);
      if (tokens <= maxTokens) return current;
      current = current.slice(0, Math.floor(current.length * (maxTokens / tokens) * 0.95));
    }
    return current;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async getImageEmbedSize(): Promise<number> {
    if (!this.modelDef) throw new Error('Engine not loaded');
    return this.imageTokens;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async getContextWindow(): Promise<number> {
    const s = this.utilSession;
    if (!s) throw new Error('Engine not loaded');
    return s.contextWindow ?? s.inputQuota ?? 4096;
  }
}

export async function isPromptApiCached(modelDef: LocalModelDef): Promise<boolean> {
  return await promptApiAvailability(modelDef) === 'available';
}
