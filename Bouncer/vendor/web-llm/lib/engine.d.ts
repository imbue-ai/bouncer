import { ChatConfig, ChatOptions, AppConfig, GenerationConfig, MLCEngineConfig } from "./config";
import { LLMChatPipeline } from "./llm_chat";
import { ChatCompletionRequest, ChatCompletion, ChatCompletionChunk, ChatCompletionRequestNonStreaming, ChatCompletionRequestStreaming, ChatCompletionRequestBase, CompletionCreateParamsNonStreaming, CompletionCreateParamsStreaming, CompletionCreateParamsBase, CompletionCreateParams, Completion, EmbeddingCreateParams, CreateEmbeddingResponse } from "./openai_api_protocols/index";
import * as API from "./openai_api_protocols/index";
import { InitProgressCallback, MLCEngineInterface, LogitProcessor, LogLevel } from "./types";
/**
 * Creates `MLCEngine`, and loads `modelId` onto WebGPU.
 *
 * Equivalent to `new webllm.MLCEngine().reload(...)`.
 *
 * @param modelId model_id of the model to load, either string or string[]. When multiple models
 *   are provided, we load all models sequentially. Each modelId needs to either be in
 *   `webllm.prebuiltAppConfig`, or in `engineCOnfig.appConfig`.
 * @param engineConfig Optionally configures the engine, see `webllm.MLCEngineConfig`.
 * @param chatOpts Extra options to optionally override the `mlc-chat-config.json` of `modelId`.
 *   The size of which needs to match that of `modelId`; chatOpts[i] will be used for modelId[i].
 * @returns An initialized `WebLLM.MLCEngine` with `modelId` loaded.
 * @throws Throws error when device lost (mostly due to OOM); users should re-call `CreateMLCEngine()`,
 *   potentially with a smaller model or smaller context window size.
 */
export declare function CreateMLCEngine(modelId: string | string[], engineConfig?: MLCEngineConfig, chatOpts?: ChatOptions | ChatOptions[]): Promise<MLCEngine>;
/**
 * The main interface of MLCEngine, which loads a model and performs tasks.
 *
 * You can either initialize one with `webllm.CreateMLCEngine(modelId)`, or
 * `webllm.MLCEngine().reload(modelId)`.
 */
export declare class MLCEngine implements MLCEngineInterface {
    /** For chat.completions.create() */
    chat: API.Chat;
    /** For completions.create() */
    completions: API.Completions;
    /** For embeddings.create() */
    embeddings: API.Embeddings;
    /** Maps each loaded model's modelId to its pipeline */
    private loadedModelIdToPipeline;
    /** Maps each loaded model's modelId to its chatConfig */
    private loadedModelIdToChatConfig;
    /** Maps each loaded model's modelId to its modelType */
    private loadedModelIdToModelType;
    /** Maps each loaded model's modelId to a lock. Ensures
     * each model only processes one request at at time.
     */
    private loadedModelIdToLock;
    private logger;
    private logitProcessorRegistry?;
    private initProgressCallback?;
    private appConfig;
    private interruptSignal;
    private deviceLostIsError;
    private reloadController;
    constructor(engineConfig?: MLCEngineConfig);
    setAppConfig(appConfig: AppConfig): void;
    setInitProgressCallback(initProgressCallback?: InitProgressCallback): void;
    getInitProgressCallback(): InitProgressCallback | undefined;
    setLogitProcessorRegistry(logitProcessorRegistry?: Map<string, LogitProcessor>): void;
    /**
     * Set MLCEngine logging output level
     *
     * @param logLevel The new log level
     */
    setLogLevel(logLevel: LogLevel): void;
    reload(modelId: string | string[], chatOpts?: ChatOptions | ChatOptions[]): Promise<void>;
    private reloadInternal;
    unload(): Promise<void>;
    private _generate;
    /**
     * Similar to `_generate()`; but instead of using callback, we use an async iterable.
     */
    asyncGenerate(request: ChatCompletionRequestStreaming, model: string, pipeline: LLMChatPipeline, chatConfig: ChatConfig, genConfig: GenerationConfig, timeReceived: number): AsyncGenerator<ChatCompletionChunk, void, void>;
    asyncGenerate(request: CompletionCreateParamsStreaming, model: string, pipeline: LLMChatPipeline, chatConfig: ChatConfig, genConfig: GenerationConfig, timeReceived: number): AsyncGenerator<Completion, void, void>;
    interruptGenerate(): Promise<void>;
    /**
     * Completes a single ChatCompletionRequest.
     *
     * @param request A OpenAI-style ChatCompletion request.
     *
     * @note For each choice (i.e. `n`), a request is defined by a single `prefill()` and multiple
     * `decode()`. This is important as it determines the behavior of various fields including `seed`.
     */
    chatCompletion(request: ChatCompletionRequestNonStreaming): Promise<ChatCompletion>;
    chatCompletion(request: ChatCompletionRequestStreaming): Promise<AsyncIterable<ChatCompletionChunk>>;
    chatCompletion(request: ChatCompletionRequestBase): Promise<AsyncIterable<ChatCompletionChunk> | ChatCompletion>;
    /**
     * Completes a single CompletionCreateParams, a text completion with no chat template.
     *
     * @param request A OpenAI-style Completion request.
     *
     * @note For each choice (i.e. `n`), a request is defined by a single `prefill()` and multiple
     * `decode()`. This is important as it determines the behavior of various fields including `seed`.
     */
    completion(request: CompletionCreateParamsNonStreaming): Promise<Completion>;
    completion(request: CompletionCreateParamsStreaming): Promise<AsyncIterable<Completion>>;
    completion(request: CompletionCreateParamsBase): Promise<AsyncIterable<Completion> | Completion>;
    embedding(request: EmbeddingCreateParams): Promise<CreateEmbeddingResponse>;
    getMaxStorageBufferBindingSize(): Promise<number>;
    getGPUVendor(): Promise<string>;
    private getLLMStates;
    private getEmbeddingStates;
    /**
     * Return the model, its LLMChatPipeline, and ChatConfig to use. Throws error when unclear which
     * model to load. Ensure all loadedModelIdToXXX maps contain entry for the selected modelId.
     * @param requestName The type of request or API to load the model for. Needed for error throwing.
     * @param modelType The typ of model, determining what type of pipeline to expect.
     * @param modelId Model the user specified to load via the request. Required when multiple
     *   models are loaded
     */
    private getModelStates;
    forwardTokensAndSample(inputIds: Array<number>, isPrefill: boolean, modelId?: string): Promise<number>;
    /**
     * Get the current generated response.
     *
     * @returns The current output message.
     */
    getMessage(modelId?: string): Promise<string>;
    runtimeStatsText(modelId?: string): Promise<string>;
    /**
     * Count the number of tokens in a text string using the loaded model's tokenizer.
     */
    countTokens(text: string, modelId?: string): Promise<number>;
    /**
     * Truncate text to fit within the given token budget.
     * Returns the original text if it already fits.
     */
    truncateText(text: string, maxTokens: number, modelId?: string): Promise<string>;
    /**
     * Get the number of embedding tokens a single image will produce for the loaded model.
     */
    getImageEmbedSize(modelId?: string): Promise<number>;
    resetChat(keepStats?: boolean, modelId?: string): Promise<void>;
    /**
     * Run a prefill step with a given input.
     *
     * If `input` is a chatCompletionRequest, we treat `input.messages[-1]` as the usual user input.
     * We then convert `input.messages[:-1]` to a `Conversation` object, representing a conversation
     * history.
     *
     * If the new `Conversation` object matches the current one loaded, it means we are
     * performing multi-round chatting, so we do not reset, hence reusing KV cache. Otherwise, we
     * reset every thing, treating the request as something completely new.
     *
     * @param input The OpenAI-style prompt to prefill.
     * @param pipeline The loaded pipeline, hence model, to carry out this prefill.
     * @param chatConfig The chat config to use for this model.
     * @param genConfig Generation config.
     */
    prefill(input: ChatCompletionRequest | CompletionCreateParams, pipeline: LLMChatPipeline, chatConfig: ChatConfig, genConfig: GenerationConfig): Promise<void>;
    /**
     * Run a decode step to decode the next token.
     */
    decode(pipeline: LLMChatPipeline, genConfig?: GenerationConfig): Promise<void>;
}
//# sourceMappingURL=engine.d.ts.map