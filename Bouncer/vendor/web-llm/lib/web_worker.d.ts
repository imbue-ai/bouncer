import { AppConfig, ChatOptions, MLCEngineConfig } from "./config";
import { MLCEngineInterface, InitProgressCallback, LogLevel, LogitProcessor } from "./types";
import { ChatCompletionRequestBase, ChatCompletionRequestStreaming, ChatCompletionRequestNonStreaming, ChatCompletion, ChatCompletionChunk, Completion, CompletionCreateParamsNonStreaming, CompletionCreateParamsStreaming, CompletionCreateParamsBase, CreateEmbeddingResponse, EmbeddingCreateParams } from "./openai_api_protocols/index";
import * as API from "./openai_api_protocols/index";
import { MessageContent, WorkerRequest } from "./message";
import { MLCEngine } from "./engine";
/**
 * Worker handler that can be used in a WebWorker
 *
 * @example
 *
 * // setup a chat worker handler that routes
 * // requests to the chat
 * const engine = new MLCEngine();
 * cont handler = new WebWorkerMLCEngineHandler(engine);
 * onmessage = handler.onmessage;
 */
export declare class WebWorkerMLCEngineHandler {
    /**
     * The modelId and chatOpts that the underlying engine (backend) is currently loaded with.
     * An engine can be loaded with multiple models, so modelId and chatOpts are lists.
     *
     * TODO(webllm-team): This is always in-sync with `this.engine` unless device is lost due to
     * unexpected reason. Therefore, we should get it from `this.engine` directly and make handler
     * stateless. Besides, consider if we should add appConfig, or use engine's API to find the
     * corresponding model record rather than relying on just the modelId.
     */
    modelId?: string[];
    chatOpts?: ChatOptions[];
    engine: MLCEngine;
    /** ChatCompletion and Completion share the same chunk generator. Each loaded model has its own. */
    protected loadedModelIdToAsyncGenerator: Map<string, AsyncGenerator<ChatCompletionChunk | Completion, void, void>>;
    /**
     * @param engine A concrete implementation of MLCEngineInterface
     */
    constructor();
    postMessage(msg: any): void;
    setLogitProcessorRegistry(logitProcessorRegistry?: Map<string, LogitProcessor>): void;
    handleTask<T extends MessageContent>(uuid: string, task: () => Promise<T>): Promise<void>;
    onmessage(event: any, onComplete?: (value: any) => void, onError?: () => void): void;
    /** Check whether frontend expectation matches with backend (modelId and chatOpts). If not (due
     * to possibly killed service worker), we reload here.
     * For more, see https://github.com/mlc-ai/web-llm/pull/533
     */
    reloadIfUnmatched(expectedModelId: string[], expectedChatOpts?: ChatOptions[]): Promise<void>;
}
export interface ChatWorker {
    onmessage: any;
    postMessage: (message: any) => void;
}
/**
 * Creates `WebWorkerMLCEngine`, a client that holds the same interface as `MLCEngine`.
 *
 * Equivalent to `new webllm.WebWorkerMLCEngine(worker).reload(...)`.
 *
 * @param worker The worker that holds the actual MLCEngine, initialized with `new Worker()`.
 * @param modelId model_id of the model to load, either string or string[]. When multiple models
 *   are provided, we load all models sequentially. Each modelId needs to either be in
 *   `webllm.prebuiltAppConfig`, or in `engineCOnfig.appConfig`.
 * @param engineConfig Optionally configures the engine, see `webllm.MLCEngineConfig` for more.
 * @param chatOpts Extra options to optionally override the `mlc-chat-config.json` of `modelId`.
 *   The size of which needs to match that of `modelId`; chatOpts[i] will be used for modelId[i].
 * @returns An initialized `WebLLM.WebWorkerMLCEngine` with `modelId` loaded.
 *
 * @note engineConfig.logitProcessorRegistry is ignored for `CreateWebWorkMLCEngine()`.
 */
export declare function CreateWebWorkerMLCEngine(worker: any, modelId: string | string[], engineConfig?: MLCEngineConfig, chatOpts?: ChatOptions | ChatOptions[]): Promise<WebWorkerMLCEngine>;
/**
 * A client of MLCEngine that exposes the same interface
 *
 * @example
 *
 * const chat = new webllm.WebWorkerMLCEngine(new Worker(
 *   new URL('./worker.ts', import.meta.url),
 *   {type: 'module'}
 * ));
 */
export declare class WebWorkerMLCEngine implements MLCEngineInterface {
    worker: ChatWorker;
    /** For chat.completions.create() */
    chat: API.Chat;
    /** For completions.create() */
    completions: API.Completions;
    /** For embeddings.create() */
    embeddings: API.Embeddings;
    /**
     * The modelId and chatOpts that the frontend expects the backend engine is currently loaded
     * with. Needed for service worker. It is the backend and handler's job to match up with the
     * expectation despite the web/service worker possibly being killed.
     * Since an engine can load multiple models, both modelId and chatOpts are lists.
     */
    modelId?: string[];
    chatOpts?: ChatOptions[];
    private initProgressCallback?;
    private pendingPromise;
    constructor(worker: ChatWorker, engineConfig?: MLCEngineConfig);
    setInitProgressCallback(initProgressCallback?: InitProgressCallback): void;
    getInitProgressCallback(): InitProgressCallback | undefined;
    setAppConfig(appConfig: AppConfig): void;
    setLogLevel(logLevel: LogLevel): void;
    protected getPromise<T extends MessageContent>(msg: WorkerRequest): Promise<T>;
    reload(modelId: string | string[], chatOpts?: ChatOptions | ChatOptions[]): Promise<void>;
    getMaxStorageBufferBindingSize(): Promise<number>;
    getGPUVendor(): Promise<string>;
    getMessage(modelId?: string): Promise<string>;
    runtimeStatsText(modelId?: string): Promise<string>;
    interruptGenerate(): void;
    unload(): Promise<void>;
    resetChat(keepStats?: boolean, modelId?: string): Promise<void>;
    forwardTokensAndSample(inputIds: Array<number>, isPrefill: boolean, modelId?: string): Promise<number>;
    /**
     * Every time the generator is called, we post a message to the worker asking it to
     * decode one step, and we expect to receive a message of `ChatCompletionChunk` from
     * the worker which we yield. The last message is `void`, meaning the generator has nothing
     * to yield anymore.
     *
     * @param selectedModelId: The model of whose async generator to call next() to get next chunk.
     *   Needed because an engine can load multiple models.
     *
     * @note ChatCompletion and Completion share the same chunk generator.
     */
    asyncGenerate(selectedModelId: string): AsyncGenerator<ChatCompletionChunk | Completion, void, void>;
    chatCompletion(request: ChatCompletionRequestNonStreaming): Promise<ChatCompletion>;
    chatCompletion(request: ChatCompletionRequestStreaming): Promise<AsyncIterable<ChatCompletionChunk>>;
    chatCompletion(request: ChatCompletionRequestBase): Promise<AsyncIterable<ChatCompletionChunk> | ChatCompletion>;
    completion(request: CompletionCreateParamsNonStreaming): Promise<Completion>;
    completion(request: CompletionCreateParamsStreaming): Promise<AsyncIterable<Completion>>;
    completion(request: CompletionCreateParamsBase): Promise<AsyncIterable<Completion> | Completion>;
    embedding(request: EmbeddingCreateParams): Promise<CreateEmbeddingResponse>;
    onmessage(event: any): void;
}
//# sourceMappingURL=web_worker.d.ts.map