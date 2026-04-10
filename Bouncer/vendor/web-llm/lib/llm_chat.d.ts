import * as tvmjs from "@mlc-ai/web-runtime";
import { Tokenizer } from "@mlc-ai/web-tokenizers";
import { ChatConfig, GenerationConfig, Role } from "./config";
import { Conversation } from "./conversation";
import { LogitProcessor, LatencyBreakdown } from "./types";
import { ChatCompletionFinishReason, ChatCompletionTokenLogprob } from "./openai_api_protocols/index";
export declare class LLMChatPipeline {
    private config;
    private tokenizer;
    private tvm;
    private device;
    private vm;
    private prefill;
    private decoding;
    private resolvedModelABI;
    private kvStateKind;
    private image_embed;
    private embed;
    private fapplyBitmask;
    private fapplyPenalty;
    private fapplyLogitBias;
    private fsoftmaxWithTemperature;
    private fsampleWithTopP;
    private fargsortProbs;
    private fclearKVCaches;
    private fKVCacheAddSequence;
    private fKVCacheRemoveSequence;
    private fKVCacheBeginForward;
    private fKVCacheEndForward;
    private fKVCacheEnableSlidingWindowForSeq;
    private params;
    private kvCache?;
    private rnnState?;
    private prefillLogitPositions?;
    private prefillLogitPositionHost;
    private maxHistorySize;
    private logitsOnCPU?;
    private filledKVCacheLength;
    private bosTokenId;
    private contextWindowSize;
    private slidingWindowSize;
    private attentionSinkSize;
    private prefillChunkSize;
    private resetStatsPerPrefill;
    private stopStr;
    private stopTokens;
    private outputMessage;
    private outputIds;
    private stopTriggered;
    private finishReason;
    private appearedTokensFreq;
    private conversation;
    private tokenLogprobArray;
    private decodingTotalTime;
    private decodingTotalTokens;
    private prefillTotalTime;
    private prefillTotalTokens;
    private curRoundDecodingTotalTokens;
    private curRoundPrefillTotalTokens;
    private curRoundDecodingTotalTime;
    private curRoundPrefillTotalTime;
    curRoundLatencyBreakdown: LatencyBreakdown;
    private logitProcessor?;
    private grammarMatcher?;
    private responseFormatCacheKey?;
    private xgTokenizerInfo?;
    private grammarCompiler?;
    private bitmaskSize;
    private fullVocabSize;
    private token_postproc_method;
    private prepend_space_in_encode;
    private curRoundGrammarInitTotalTime;
    private curRoundGrammarPerTokenTotalTime;
    private sampleIndices;
    private sampleIndicesDevice;
    private topPDevice;
    constructor(tvm: tvmjs.Instance, tokenizer: Tokenizer, config: ChatConfig, logitProcessor?: LogitProcessor);
    dispose(): void;
    /**
     * Get the current message.
     */
    getMessage(): string;
    /**
     * Reset the runtime statistics
     */
    resetRuntimeStats(): void;
    /**
     * Reset the chat history
     */
    resetChat(keepStats?: boolean): void;
    /**
     * Reset KV Cache
     */
    resetKVCache(): void;
    /**
     * @returns Whether stop is triggered.
     */
    stopped(): boolean;
    /**
     * @returns Finish reason; undefined if generation not started/stopped yet.
     */
    getFinishReason(): ChatCompletionFinishReason | undefined;
    /**
     * @returns tokenLogprobArray for this current round of autoregressive generation.
     * Updated upon each sampled token, cleared upon each prefillStep().
     */
    getTokenLogprobArray(): Array<ChatCompletionTokenLogprob>;
    /**
     * @returns the number of tokens decoded for a single request or a single choice in the request.
     */
    getCurRoundDecodingTotalTokens(): number;
    /**
     * @returns the number of tokens decoded for a single request or a single choice in the request.
     */
    getCurRoundPrefillTotalTokens(): number;
    /**
     * @returns the time spent on decode for a single request or a single choice in the request.
     */
    getCurRoundDecodingTotalTime(): number;
    /**
     * @returns the time spent on  for a single request or a single choice in the request.
     */
    getCurRoundPrefillTotalTime(): number;
    /**
     * @returns the time (seconds) spent on for initializing grammar matcher for a single request.
     */
    getCurRoundGrammarInitTotalTime(): number;
    /**
     * @returns the total time (seconds) spent on creating bitmask and accepting token grammar matcher
     * for all the generated tokens in a single request.
     */
    getCurRoundGrammarPerTokenTotalTime(): number;
    /**
     * @returns the breakdown of latencies for sampling each token for a single request.
     */
    getCurRoundLatencyBreakdown(): LatencyBreakdown;
    /**
     * @returns Runtime stats information.
     */
    runtimeStatsText(): string;
    /**
     * @returns Runtime stats information, starting from the last prefill performed.
     */
    curRoundRuntimeStatsText(): string;
    /**
     * @returns Prefill tokens per second, starting from the last prefill performed.
     */
    getCurRoundPrefillTokensPerSec(): number;
    /**
     * @returns Prefill tokens per second, starting from the last prefill performed.
     */
    getCurRoundDecodingTokensPerSec(): number;
    /**
     * Set the seed for the RNG `this.tvm.rng`.
     */
    setSeed(seed: number): void;
    private getResponseFormatKey;
    /**
     * @returns The conversation object (not a deep copy).
     */
    getConversationObject(): Conversation;
    /**
     * Set this.conversation to a new conversation object.
     */
    setConversation(newConv: Conversation): void;
    asyncLoadWebGPUPipelines(): Promise<void>;
    /**
     * Generate the first token given input prompt
     */
    prefillStep(inp: string, msgRole: Role, // either user or tool
    inp_role_str?: string, genConfig?: GenerationConfig): Promise<void>;
    decodeStep(genConfig?: GenerationConfig): Promise<void>;
    /**
     * Manually trigger stop if it is not stopped.
     */
    triggerStop(): void;
    /**
     * Add a generated token and check for stop.
     *
     * @param nextToken The next token.
     * @param genConfig Configs that override `this.config` for this round of generation.
     */
    private processNextToken;
    /**
     * Given input tokens, return embeddings of them by calling embed kernel.
     *
     * @note precondition: inputTokens.length <= prefillChunkSize, since we take care of
     * chunking in `getChunkedPrefillInputData()`.
     */
    private getTokensEmbeddings;
    /**
     * Calculate resize dimensions for the vision model.
     * Phi3-V: aspect-ratio preserving resize based on vlm_utils.cc CalculateResizeShape.
     * Qwen3.5-V: fixed square resize to image_size from model_config.
     */
    private calculateResizeShape;
    /**
     * Calculate crop/tile dimensions for the vision model.
     * Phi3-V: tiles image into 336x336 patches (vlm_utils.cc CalculateCropShape).
     * Qwen3.5-V: single tile (no tiling).
     */
    private calculateCropShape;
    /**
     * Compute the number of embedding tokens an image will produce.
     * Must match the model's image_embed output size.
     * Based on mlc_llm/serve/data.py _compute_embed_size.
     */
    private computeImageEmbedSize;
    /**
     * Embed an image input.
     */
    private getImageEmbeddings;
    /**
     * Embed and forward input data, that can be either array of tokens, or an image.
     * This will increment `this.filledKVCacheLength`.
     *
     * @param inputData data to embed and forward
     * @param inputDataLen length of this inputData, should smaller than prefill chunk size.
     * @returns The logits returned by this forward as tvmjs.Tensor on GPU.
     *
     * @note Precondition: inputData's data length is smaller than prefill chunk size
     */
    private embedAndForward;
    private static loadVMFunctionRegistry;
    private static getRequiredVMFunctionByName;
    private static getVMFunctionAvailability;
    private parseKVStateKind;
    private static resolveModelABI;
    private requireKVCache;
    private requireRNNState;
    private getSingleStateForABI;
    private getActiveKVStates;
    private invokePrefill;
    private invokeDecode;
    private updateLogitsOnCPU;
    private sampleTokenFromLogits;
    /**
     * Return the an array of a mixture of token arrays and imageURLs (which cannot be represented
     * as tokens). Also return the number of tokens this represents.
     *
     * We first convert the Conversation into a prompt array to be prefilled. Then we encode the
     * text parts, leaving the imageURLs as it is.
     * Example prompts:
     * [
     *   "<|system|>\nSome system prompt\n",
     *   [
     *     "<|user|>\n",
     *     imageURL1,
     *     "\n",
     *     imageURL2,
     *     "\n",
     *     "Some user input<|end|>\n"
     *   ],
     * ]
     *
     * Expected output:
     * [
     *   token array for "<|system|>\nSome system prompt\n<|user|>\n",
     *   imageUrl1,
     *   token array for "\n",
     *   imageUrl2,
     *   token array for "\nSome user input<|end|>\n"
     */
    private getInputData;
    forwardTokensAndSample(inputIds: Array<number>, isPrefill: boolean): Promise<number>;
    /**
     * Based on `sampledToken` and `this.logitsOnCPU`, which becomes a distribution after
     * calling `this.tvm.applySoftmaxWithTemperature()`, generate `ChatCompletionTokenLogprob` and
     * update `this.tokenLogprobArray`.
     *
     * @param sampledToken The token ID sampled.
     * @param top_logprobs Number of top tokens to include; `top_logprobs` in `ChatCompletionRequest`.
     *
     * @return The `ChatCompletionTokenLogprob` for this single autoregressive step.
     */
    private getTokenLogprob;
    /**
     * Synchronize the device.
     */
    sync(): Promise<void>;
    evaluate(): Promise<void>;
}
//# sourceMappingURL=llm_chat.d.ts.map