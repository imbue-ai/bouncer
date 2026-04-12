// WebLLM local model engine: lifecycle, inference, preemption, keep-alive

import { CreateMLCEngine, hasModelInCache, prebuiltAppConfig } from "@mlc-ai/web-llm";
import type { MLCEngine, AppConfig, ChatCompletion, MLCEngineConfig } from "@mlc-ai/web-llm";
import type { LocalModelDef, LocalModelStatus, EvaluationPostData, ChatMessage } from '../types';
import { PREDEFINED_MODELS } from '../shared/models';
import { isGPUDeviceLostError, isNetworkError, formatLocalInferenceResult } from '../shared/utils';
import { LOCAL_SYSTEM_PROMPT, buildLocalUserMessage } from '../shared/prompts';
import { inferenceQueue } from './inference-queue';
import { getStorage, setStorage } from '../shared/storage';

declare global {
  interface Navigator {
    gpu?: unknown;
  }
}

// ==================== Constants ====================

const KEEP_ALIVE_INTERVAL_MS = 5000;
const IDLE_TIMEOUT_MS = 60000;
const INFERENCE_TIMEOUT_MS = 30000;
const DOWNLOAD_MAX_RETRIES = 3;
const DOWNLOAD_RETRY_DELAY_MS = 2000;

// Keys that belong on the ModelRecord (appConfig), not chatOpts.
const MODEL_RECORD_KEYS = new Set(['model', 'model_lib', 'model_type']);

/** JSON schema for structured classification output from local models. */
const CLASSIFICATION_RESPONSE_FORMAT = {
  type: 'json_object' as const,
  schema: JSON.stringify({
    type: 'object',
    properties: {
      reasoning: { type: 'string' },
      match: { type: ['string', 'null'] },
    },
    required: ['reasoning', 'match'],
  }),
};

// ==================== Pure helpers ====================

// Build both the appConfig (ModelRecord for CreateMLCEngine) and chatOpts
// (chat-level overrides) from a model's webllmConfig. Keeps the
// "which keys go where" split defined in one place.
export function buildModelConfig(modelId: string): { appConfig: AppConfig | undefined; chatOpts: Record<string, unknown> } {
  const modelDef = PREDEFINED_MODELS.local.find(m => m.name === modelId);
  const webllmConfig = modelDef?.webllmConfig;
  const { overrides, ...recordFields } = webllmConfig || {};

  let appConfig: AppConfig | undefined;
  if (recordFields.model) {
    appConfig = { model_list: [{ model_id: modelId, ...recordFields, ...(overrides && { overrides }) } as AppConfig['model_list'][number]] };
  } else {
    const prebuiltRecord = prebuiltAppConfig.model_list.find(m => m.model_id === modelId);
    const hasRecordFields = Object.keys(recordFields).length > 0;
    if (prebuiltRecord && hasRecordFields) {
      appConfig = { model_list: [{ ...prebuiltRecord, ...recordFields, ...(overrides && { overrides }) }] };
    }
  }

  const chatOpts: Record<string, unknown> = { context_window_size: 1024 };
  if (overrides) Object.assign(chatOpts, overrides);
  for (const [key, value] of Object.entries(recordFields)) {
    if (!MODEL_RECORD_KEYS.has(key)) chatOpts[key] = value;
  }

  return { appConfig, chatOpts };
}

// Parse a local model's freeform response to extract a hide/show decision and reasoning.
// Uses last-index-wins: if "Matches <topic>" appears after any "No match", it's a hide.
export function parseLocalModelResponse(rawResponse: string | null): { shouldHide: boolean; reasoning: string } {
  if (!rawResponse) {
    return { shouldHide: false, reasoning: 'Empty model response — model returned no output' };
  }

  // Try JSON structured output first
  try {
    const parsed = JSON.parse(rawResponse);
    if (typeof parsed === 'object' && parsed !== null && 'reasoning' in parsed) {
      const match = parsed.match;
      const shouldHide = typeof match === 'string' && match.length > 0 && match !== 'null';
      const reasoning = shouldHide
        ? `${parsed.reasoning} (Matched: ${match})`
        : String(parsed.reasoning);
      return { shouldHide, reasoning };
    }
  } catch {
    // Not JSON — fall through to regex parsing
  }

  // Fallback: freeform text parsing (backward compatibility)
  let reasoning = rawResponse;
  let shouldHide = false;

  const lower = rawResponse.toLowerCase();
  const matchesIdx = lower.lastIndexOf('matches ');
  const noMatchIdx = lower.lastIndexOf('no match');
  if (matchesIdx !== -1 && matchesIdx > noMatchIdx) {
    shouldHide = true;
    const matchedTopic = rawResponse.slice(matchesIdx + 'matches '.length).replace(/\.$/, '').trim();
    reasoning = matchedTopic ? `${rawResponse} (Matched: ${matchedTopic})` : rawResponse;
  }

  return { shouldHide, reasoning };
}

// Merge model-level inference params with per-call overrides into a single request object.
function buildInferenceRequest(modelConfig: LocalModelDef | Record<string, never>, requestOpts: Record<string, unknown>): Record<string, unknown> {
  return {
    ...(modelConfig as LocalModelDef).inferenceParams,
    ...requestOpts,
    ...((modelConfig as LocalModelDef).extraBody && { extra_body: (modelConfig as LocalModelDef).extraBody }),
  };
}

// ==================== LocalEngine ====================

export class LocalEngine {
  engine: MLCEngine | null;
  loadedModel: string | null;
  _modelConfig: LocalModelDef | null;

  // Initialization tracking
  _initializingModel: string | null;
  _initPromise: Promise<MLCEngine | null> | null;
  _initPromiseResolve: ((engine: MLCEngine | null) => void) | null;
  _initAbortController: AbortController | null;

  // Keep-alive and idle timeout
  _keepAliveInterval: ReturnType<typeof setInterval> | null;
  _idleTimeoutId: ReturnType<typeof setTimeout> | null;

  // Preemption state
  _preempted: boolean;
  _interruptSettledPromise: Promise<void> | null;

  constructor() {
    this.engine = null;
    this.loadedModel = null;
    this._modelConfig = null;

    this._initializingModel = null;
    this._initPromise = null;
    this._initPromiseResolve = null;
    this._initAbortController = null;

    this._keepAliveInterval = null;
    this._idleTimeoutId = null;

    this._preempted = false;
    this._interruptSettledPromise = null;
  }

  // ---- State queries ----

  isInitializing(): boolean { return this._initializingModel !== null; }
  isModelLoaded(modelId: string): boolean { return this.engine !== null && this.loadedModel === modelId; }
  isInitializingModel(modelId: string): boolean { return this._initializingModel === modelId; }

  // ---- Lifecycle ----

  async ensureLoaded(modelId: string): Promise<void> {
    await this.syncStatus(modelId);
    if (!this.isModelLoaded(modelId)) {
      const engine = await this.initialize(modelId);
      if (!engine) {
        throw new Error('Local model not available. WebGPU may not be supported or model not downloaded.');
      }
    }
  }

  async initialize(modelId: string): Promise<MLCEngine | null> {
    if (!modelId) {
      console.error('[WebLLM] No model ID provided');
      return null;
    }

    if (this.isInitializingModel(modelId)) {
      return this._initPromise;
    }

    if (this.isModelLoaded(modelId)) {
      return this.engine;
    }

    if (!navigator.gpu) {
      await this.updateStatus(modelId, { state: 'unsupported', reason: 'WebGPU not supported' });
      return null;
    }

    // Start tracking initialization BEFORE any async work so concurrent callers
    // see isInitializingModel() and wait on _initPromise.
    void this._startInit(modelId);
    const abortSignal = this._initAbortController!.signal;

    // If a different model is loaded, unload it first to free GPU memory.
    // Drain the inference queue so any in-flight task finishes before we dispose the engine.
    if (this.engine && this.loadedModel !== modelId) {
      await this.drainQueue(async () => {
        if (this.engine) {
          try {
            await this.engine.unload();
          } catch (e) {
            console.error('[WebLLM] Error unloading engine:', e);
          }
        }
        this.engine = null;
        this.loadedModel = null;
        this._modelConfig = null;
        this._stopKeepAlive();
      });
    }

    // Retry loop for network errors
    let retryCount = 0;
    while (true) {
      if (abortSignal.aborted) {
        this._completeInit(null);
        return null;
      }

      try {
        await this.updateStatus(modelId, { state: 'initializing', progress: 0, text: retryCount > 0 ? `Retrying (${retryCount}/${DOWNLOAD_MAX_RETRIES})...` : 'Starting...' });

        const engineConfig: MLCEngineConfig & { initProgressCallback: (progress: { progress: number; text: string }) => void } = {
          initProgressCallback: (progress: { progress: number; text: string }) => {
            if (abortSignal.aborted) return;
            const displayText = progress.text
              .replace(/^Fetching param cache/, 'Downloading param cache')
              .replace(/\bcache\[(\d+)\s*\/\s*(\d+)\]/, 'cache [$1 / $2]')
              .replace(/\. It can take a while.*$/, '');
            this.updateStatus(modelId, {
              state: 'downloading',
              progress: progress.progress,
              text: displayText
            }).catch(err => console.error('[WebLLM] Failed to update download status:', err));
          }
        };

        const { appConfig, chatOpts } = buildModelConfig(modelId);
        if (appConfig) {
          (engineConfig as MLCEngineConfig & { appConfig?: AppConfig }).appConfig = appConfig;
        }

        const engine = await CreateMLCEngine(modelId, engineConfig as MLCEngineConfig, chatOpts);

        if (abortSignal.aborted) {
          try { await engine.unload(); } catch { /* ignore */ }
          this._completeInit(null);
          return null;
        }

        this.engine = engine;
        this.loadedModel = modelId;
        this._modelConfig = PREDEFINED_MODELS.local.find(m => m.name === modelId) || null;

        await this.updateStatus(modelId, { state: 'ready' });

        this._startKeepAlive();
        this._resetIdleTimeout();
        this._completeInit(this.engine);

        return this.engine;
      } catch (error) {
        console.error('[WebLLM] Initialization failed:', error);

        const errorMsg = (error as Error).message;

        if (isNetworkError(errorMsg) && retryCount < DOWNLOAD_MAX_RETRIES) {
          retryCount++;
          const delay = DOWNLOAD_RETRY_DELAY_MS * Math.pow(2, retryCount - 1);

          await this.updateStatus(modelId, {
            state: 'downloading',
            progress: 0,
            text: `Retrying download (${retryCount}/${DOWNLOAD_MAX_RETRIES})...`
          });

          await new Promise(resolve => setTimeout(resolve, delay));
          if (abortSignal.aborted) {
            this._completeInit(null);
            return null;
          }
          continue;
        }

        let errorMessage = errorMsg;
        if (isGPUDeviceLostError(errorMsg)) {
          errorMessage = 'GPU memory exhausted. Try a smaller model or close other GPU-intensive tabs.';
        } else if (isNetworkError(errorMsg)) {
          errorMessage = 'Download failed after multiple retries. Check your internet connection.';
        }

        await this.updateStatus(modelId, { state: 'error', error: errorMessage });
        await this.reset();
        return null;
      }
    }
  }

  async cancelDownload(modelId: string): Promise<boolean> {
    if (!this.isInitializingModel(modelId)) {
      return false;
    }
    if (this._initAbortController) {
      this._initAbortController.abort();
    }

    await this.reset();

    const cached = await this.checkCached(modelId);
    await this.updateStatus(modelId, { state: cached ? 'cached' : 'not_downloaded' });
    return true;
  }

  // Synchronous teardown for service worker onSuspend: stop timers and null out
  // references without async unload (Chrome kills the worker before it completes).
  teardown(): void {
    this._stopIdleTimeout();
    this._stopKeepAlive();
    this.engine = null;
    this.loadedModel = null;
    this._modelConfig = null;
  }

  async reset(): Promise<void> {
    this._stopIdleTimeout();
    this._stopKeepAlive();
    if (this.engine) {
      try {
        await this.engine.unload();
      } catch (e) {
        console.error('[WebLLM] Error unloading engine:', e);
      }
    }
    this.engine = null;
    this.loadedModel = null;
    this._modelConfig = null;
    this._initializingModel = null;
    this._initAbortController = null;
    this._preempted = false;
    this._interruptSettledPromise = null;
    this._completeInit(null);
  }

  // ---- Inference ----

  // Run a completion: queue, handle preemption, resetChat, timeout, strip think blocks.
  // Returns the raw text content from the model.
  async generate(
    messages: ChatMessage[],
    maxTokens: number,
    { priority = 0, temperature, onStart, responseFormat }: { priority?: number; temperature?: number; onStart?: () => void; responseFormat?: Record<string, unknown> } = {}
  ): Promise<string> {
    const requestOpts: Record<string, unknown> = { messages, max_tokens: maxTokens };
    if (responseFormat) requestOpts.response_format = responseFormat;
    if (temperature !== undefined) requestOpts.temperature = temperature;
    const request = buildInferenceRequest(this._modelConfig || ({} as Record<string, never>), requestOpts);

    return inferenceQueue.enqueue(async () => {
      // Wait for any previous interruptGenerate() to settle
      if (this._interruptSettledPromise) {
        await this._interruptSettledPromise;
        this._interruptSettledPromise = null;
      }
      // WebLLM bug workaround: clear stale interruptSignal
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
      if (this.engine && (this.engine as any).interruptSignal) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
        (this.engine as any).interruptSignal = false;
      }

      this._preempted = false;
      if (onStart) onStart();
      try {
        await this.engine!.resetChat();
        const completion = await this._callWithTimeout(request);

        if (this._preempted) throw new Error('Inference preempted');

        const raw = (completion.choices[0]?.message?.content || '')
          .replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
        this._resetIdleTimeout();
        return raw;
      } catch (error) {
        if ((error as Error).message === 'Inference preempted') throw error;
        if (this._preempted) {
          throw new Error('Inference preempted', { cause: error });
        }

        if (isGPUDeviceLostError((error as Error).message)) {
          console.error('[WebLLM] GPU device lost during inference, resetting engine...');
          const modelId = this.loadedModel;
          await this.reset();
          await this.updateStatus(modelId!, {
            state: 'error',
            error: 'GPU memory exhausted during inference. Try a smaller model or close other tabs.'
          });
        }

        throw error;
      }
    }, { priority });
  }

  preempt(): void {
    if (this._preempted) return;
    this._preempted = true;
    if (this.engine) {
      this._interruptSettledPromise = this.engine.interruptGenerate().catch(e =>
        console.error('[Preempt] Failed to interrupt generation:', e)
      );
    }
  }

  // ---- Token counting ----

  async countTokens(text: string): Promise<number> {
    if (!this.engine) throw new Error('Engine not loaded');
    return await this.engine.countTokens(text);
  }

  async truncateText(text: string, maxTokens: number): Promise<string> {
    if (!this.engine) throw new Error('Engine not loaded');
    return await this.engine.truncateText(text, maxTokens);
  }

  async getImageEmbedSize(): Promise<number> {
    if (!this.engine) throw new Error('Engine not loaded');
    return await this.engine.getImageEmbedSize();
  }

  // ---- Queue operations ----

  clearQueue(): void { inferenceQueue.clear(); }
  drainQueue<T>(fn: () => Promise<T>): Promise<T> { return inferenceQueue.drain(fn); }

  // ---- Status helpers ----

  async updateStatus(modelId: string, status: LocalModelStatus): Promise<void> {
    const data = await getStorage(['localModelStatuses']);
    const statuses: Record<string, LocalModelStatus> = { ...(data.localModelStatuses ?? {}) };
    statuses[modelId] = status;
    await setStorage({ localModelStatuses: statuses });
  }

  async checkCached(modelId: string): Promise<boolean> {
    try {
      const { appConfig } = buildModelConfig(modelId);
      const cached = await hasModelInCache(modelId, appConfig);
      return cached;
    } catch (e) {
      console.error('[WebLLM] Error checking cache for', modelId, ':', e);
      return false;
    }
  }

  async syncStatus(modelId: string): Promise<LocalModelStatus | undefined> {
    const data = await getStorage(['localModelStatuses']);
    const statuses: Record<string, LocalModelStatus> = { ...(data.localModelStatuses ?? {}) };
    const storedStatus = statuses[modelId];

    if (!storedStatus) return storedStatus;

    let needsUpdate = false;
    const { appConfig } = buildModelConfig(modelId);

    if (storedStatus.state === 'ready' && !this.isModelLoaded(modelId)) {
      const cached = await hasModelInCache(modelId, appConfig);
      if (!cached) {
        statuses[modelId] = { state: 'not_downloaded' };
        needsUpdate = true;
      } else {
        statuses[modelId] = { state: 'cached' };
        needsUpdate = true;
      }
    }

    if ((storedStatus.state === 'downloading' || storedStatus.state === 'initializing') &&
        !this.isInitializing()) {
      const cached = await hasModelInCache(modelId, appConfig);
      statuses[modelId] = { state: cached ? 'cached' : 'not_downloaded' };
      needsUpdate = true;
    }

    if (needsUpdate) {
      await setStorage({ localModelStatuses: statuses });
    }

    return statuses[modelId];
  }

  async syncAllStatuses(): Promise<void> {
    for (const model of PREDEFINED_MODELS.local) {
      await this.syncStatus(model.name);
    }
  }

  async autoInitSelected(): Promise<void> {
    try {
      const data = await getStorage(['selectedModel']);
      const selectedModel = data.selectedModel;

      if (!selectedModel || !selectedModel.startsWith('local:')) return;

      const modelId = selectedModel.split(':')[1];

      if (this.isModelLoaded(modelId)) return;

      const cached = await this.checkCached(modelId);
      if (!cached) return;

      this.initialize(modelId).catch(err => {
        console.error('[WebLLM] Auto-init failed:', err);
      });
    } catch (e) {
      console.error('[WebLLM] Error in autoInitSelected:', e);
    }
  }

  // ---- Private: initialization tracking ----

  _startInit(modelId: string): Promise<MLCEngine | null> {
    this._initializingModel = modelId;
    this._initAbortController = new AbortController();
    this._initPromise = new Promise<MLCEngine | null>(resolve => {
      this._initPromiseResolve = resolve;
    });
    return this._initPromise;
  }

  _completeInit(engine: MLCEngine | null): void {
    this._initializingModel = null;
    this._initAbortController = null;
    if (this._initPromiseResolve) {
      this._initPromiseResolve(engine);
      this._initPromiseResolve = null;
    }
    this._initPromise = null;
  }

  // ---- Private: keep-alive ----

  _startKeepAlive(): void {
    if (this._keepAliveInterval) return;
    this._keepAliveInterval = setInterval(() => {
      // Keep-alive: accessing this.engine prevents service worker from idling
      void this.engine;
    }, KEEP_ALIVE_INTERVAL_MS);
  }

  _stopKeepAlive(): void {
    if (this._keepAliveInterval) {
      clearInterval(this._keepAliveInterval);
      this._keepAliveInterval = null;
    }
  }

  // ---- Private: idle timeout ----

  _resetIdleTimeout(): void {
    if (this._idleTimeoutId !== null) {
      clearTimeout(this._idleTimeoutId);
    }
    this._idleTimeoutId = setTimeout(() => this._onIdleTimeout(), IDLE_TIMEOUT_MS);
  }

  _stopIdleTimeout(): void {
    if (this._idleTimeoutId !== null) {
      clearTimeout(this._idleTimeoutId);
      this._idleTimeoutId = null;
    }
  }

  async _onIdleTimeout(): Promise<void> {
    this._idleTimeoutId = null;
    if (!this.engine) return;
    const modelId = this.loadedModel;
    try {
      await this.engine.unload();
    } catch (e) {
      console.error('[WebLLM] Error during idle unload:', e);
    }
    this.engine = null;
    this.loadedModel = null;
    this._modelConfig = null;
    this._stopKeepAlive();
    if (modelId) {
      await this.updateStatus(modelId, { state: 'cached' });
    }
  }

  // ---- Private: inference timeout ----

  _callWithTimeout(request: Record<string, unknown>, timeoutMs: number = INFERENCE_TIMEOUT_MS): Promise<ChatCompletion> {
    return new Promise((resolve, reject) => {
      let completed = false;

      const timeoutId = setTimeout(async () => {
        if (completed) return;
        completed = true;
        console.warn(`[WebLLM] Inference timeout after ${timeoutMs}ms, interrupting...`);
        try {
          await this.engine!.interruptGenerate();
        } catch (e) {
          console.error('[WebLLM] Failed to interrupt generation:', e);
        }
        reject(new Error('Inference timeout - model took too long to respond'));
      }, timeoutMs);

      this.engine!.chat.completions.create(request as unknown as Parameters<MLCEngine['chat']['completions']['create']>[0])
        .then(result => {
          if (completed) return;
          completed = true;
          clearTimeout(timeoutId);
          resolve(result as ChatCompletion);
        })
        .catch(error => {
          if (completed) return;
          completed = true;
          clearTimeout(timeoutId);
          reject(error instanceof Error ? error : new Error(String(error)));
        });
    });
  }
}

// ==================== Singleton & exports ====================

export const localEngine = new LocalEngine();

// ==================== Post inference orchestration ====================

// Orchestrates local inference for a single post: builds prompt, calls generate,
// handles image fallback, parses response. This is the post-filtering-specific
// wrapper around localEngine.generate().
export async function callLocalInference(
  postData: EvaluationPostData,
  bannedCategories: string[],
  modelConfig: LocalModelDef | null,
  modelId: string,
  { priority = 0, onInferenceStart }: { priority?: number; onInferenceStart?: () => void } = {}
): Promise<{ shouldHide: boolean; reasoning: string; rawResponse?: string | null; inferenceTime?: number }> {
  await localEngine.ensureLoaded(modelId);

  const post = postData;
  const contextWindowSize = (modelConfig?.webllmConfig?.overrides?.context_window_size as number) || 1024;
  const maxGenerationTokens = 40;
  const supportsImages = modelConfig?.supportsImages === true;
  let useImages = supportsImages && post.imageUrls && post.imageUrls.length > 0;

  // Calculate token budget and truncate post text to fit within context window
  const overheadPrompt = buildLocalUserMessage('', bannedCategories, useImages);
  const [systemTokens, overheadTokens] = await Promise.all([
    localEngine.countTokens(LOCAL_SYSTEM_PROMPT),
    localEngine.countTokens(overheadPrompt),
  ]);

  let imageTokens = 0;
  if (useImages) {
    const perImageTokens = await localEngine.getImageEmbedSize();
    imageTokens = perImageTokens * post.imageUrls.length;
  }

  let postTextBudget = contextWindowSize - systemTokens - overheadTokens - maxGenerationTokens - imageTokens;

  // If images leave no room for text, drop images and recalculate
  if (useImages && postTextBudget < 1) {
    console.log('[WebLLM] Images consume too much context, falling back to text-only');
    useImages = false;
    const textOnlyOverhead = await localEngine.countTokens(buildLocalUserMessage('', bannedCategories, false));
    postTextBudget = contextWindowSize - systemTokens - textOnlyOverhead - maxGenerationTokens;
  }

  // Truncate post text to fit budget (tokenize, slice, decode — only if needed)
  const postText = postTextBudget > 0
    ? await localEngine.truncateText(post.text, postTextBudget)
    : '';
  const userPrompt = buildLocalUserMessage(postText, bannedCategories, useImages);

  let userContent: string | Array<{ type: string; text?: string; image_url?: { url: string } }>;
  if (useImages) {
    userContent = [{ type: "text", text: userPrompt }];
    for (const url of post.imageUrls) {
      (userContent as Array<{ type: string; text?: string; image_url?: { url: string } }>).push({ type: "image_url", image_url: { url } });
    }
  } else {
    userContent = userPrompt;
  }

  const messages: ChatMessage[] = [
    { role: "system", content: LOCAL_SYSTEM_PROMPT },
    { role: "user", content: userContent }
  ];

  let inferenceStart: number;
  const onStart = (): void => {
    if (onInferenceStart) onInferenceStart();
    inferenceStart = Date.now();
  };

  let rawResponse: string;
  try {
    rawResponse = await localEngine.generate(messages, 40, { priority, onStart, responseFormat: CLASSIFICATION_RESPONSE_FORMAT });
  } catch (imgError) {
    if ((imgError as Error).message === 'Inference preempted') throw imgError;
    if (useImages) {
      console.warn('[WebLLM] Image processing failed, retrying with text only:', (imgError as Error).message);
      const textOnlyContent = buildLocalUserMessage(postText, bannedCategories, false);
      const textMessages: ChatMessage[] = [
        { role: "system", content: LOCAL_SYSTEM_PROMPT },
        { role: "user", content: textOnlyContent }
      ];
      rawResponse = await localEngine.generate(textMessages, 40, { priority, onStart, responseFormat: CLASSIFICATION_RESPONSE_FORMAT });
    } else {
      throw imgError;
    }
  }

  const inferenceTime = ((Date.now() - inferenceStart!) / 1000).toFixed(2);

  const { shouldHide, reasoning } = parseLocalModelResponse(rawResponse);
  if (!rawResponse) {
    console.warn('[WebLLM] Empty response from model');
  }

  const result: { shouldHide: boolean; reasoning: string; rawResponse?: string | null; inferenceTime?: number } =
    formatLocalInferenceResult(reasoning, shouldHide);
  result.rawResponse = rawResponse;
  result.inferenceTime = parseFloat(inferenceTime);

  return result;
}
