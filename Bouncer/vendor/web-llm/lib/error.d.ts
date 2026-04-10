export declare class ModelNotFoundError extends Error {
    constructor(modelId: string);
}
export declare class ConfigValueError extends Error {
    constructor(message: string);
}
export declare class MinValueError extends ConfigValueError {
    constructor(paramName: string, minValue: number);
}
export declare class RangeError extends ConfigValueError {
    constructor(paramName: string, minValue: number, maxValue: number, additionalMessage?: string);
}
export declare class NonNegativeError extends ConfigValueError {
    constructor(paramName: string);
}
export declare class InvalidNumberStringError extends ConfigValueError {
    constructor(paramName: string, actualValue?: string);
}
export declare class DependencyError extends ConfigValueError {
    constructor(dependentParam: string, requiredParam: string, requiredValue: any);
}
export declare class WebGPUNotAvailableError extends Error {
    constructor();
}
export declare class WebGPUNotFoundError extends Error {
    constructor();
}
export declare class ModelNotLoadedError extends Error {
    constructor(requestName: string);
}
export declare class WorkerEngineModelNotLoadedError extends Error {
    constructor(engineName: string);
}
export declare class MessageOrderError extends Error {
    constructor(message: string);
}
export declare class SystemMessageOrderError extends Error {
    constructor();
}
export declare class ContentTypeError extends Error {
    constructor(name: string);
}
export declare class UnsupportedRoleError extends Error {
    constructor(role: string);
}
export declare class UserMessageContentErrorForNonVLM extends Error {
    constructor(modelId: string, modelType: string, content: any);
}
export declare class PrefillChunkSizeSmallerThanImageError extends Error {
    constructor(prefillChunkSize: number, imageEmbedSize: number);
}
export declare class CannotFindImageEmbedError extends Error {
    constructor();
}
export declare class UnsupportedDetailError extends Error {
    constructor(detail: string);
}
export declare class UnsupportedImageURLError extends Error {
    constructor(url: string);
}
export declare class MultipleTextContentError extends Error {
    constructor();
}
export declare class ToolCallOutputParseError extends Error {
    constructor(outputMessage: string, error: Error);
}
export declare class ToolCallOutputInvalidTypeError extends Error {
    constructor(expectedType: string);
}
export declare class ToolCallOutputMissingFieldsError extends Error {
    constructor(missingFields: string[], object: any);
}
export declare class ConfigurationNotInitializedError extends Error {
    constructor();
}
export declare class MissingModelWasmError extends Error {
    constructor(modelId: string);
}
export declare class FeatureSupportError extends Error {
    constructor(feature: string);
}
export declare class UnsupportedFieldsError extends Error {
    constructor(unsupportedFields: string[], targetClass: string);
}
export declare class ShaderF16SupportError extends FeatureSupportError {
    constructor();
}
export declare class DeviceLostError extends Error {
    constructor();
}
export declare class InvalidToolChoiceError extends Error {
    constructor(toolChoice: string);
}
export declare class UnsupportedToolChoiceTypeError extends Error {
    constructor();
}
export declare class FunctionNotFoundError extends Error {
    constructor(functionName: string);
}
export declare class UnsupportedToolTypeError extends Error {
    constructor();
}
export declare class EngineNotLoadedError extends Error {
    constructor();
}
export declare class UnsupportedTokenizerFilesError extends Error {
    constructor(files: string[]);
}
export declare class WindowSizeConfigurationError extends Error {
    constructor(contextWindowSize: number, slidingWindowSize: number);
}
export declare class AttentionSinkSizeError extends Error {
    constructor();
}
export declare class WindowSizeSpecificationError extends Error {
    constructor();
}
export declare class ContextWindowSizeExceededError extends Error {
    constructor(numPromptTokens: number, contextWindowSize: number);
}
export declare class NonWorkerEnvironmentError extends Error {
    constructor(className: string);
}
export declare class NoServiceWorkerAPIError extends Error {
    constructor();
}
export declare class ServiceWorkerInitializationError extends Error {
    constructor();
}
export declare class StreamingCountError extends Error {
    constructor();
}
export declare class SeedTypeError extends Error {
    constructor(seed: any);
}
export declare class InvalidResponseFormatError extends Error {
    constructor();
}
export declare class InvalidResponseFormatGrammarError extends Error {
    constructor();
}
export declare class InvalidResponseFormatStructuralTagError extends Error {
    constructor();
}
export declare class CustomResponseFormatError extends Error {
    constructor(currentFormat: any);
}
export declare class UnsupportedModelIdError extends Error {
    constructor(currentModelId: string, supportedModelIds: string[]);
}
export declare class CustomSystemPromptError extends Error {
    constructor();
}
export declare class InvalidStreamOptionsError extends Error {
    constructor();
}
export declare class UnknownMessageKindError extends Error {
    constructor(msgKind: string, msgContent: any);
}
export declare class TextCompletionExpectsKVEmptyError extends Error {
    constructor();
}
export declare class TextCompletionConversationExpectsPrompt extends Error {
    constructor();
}
export declare class TextCompletionConversationError extends Error {
    constructor(funcName: string);
}
export declare class EmbeddingUnsupportedEncodingFormatError extends Error {
    constructor();
}
export declare class EmbeddingUnsupportedModelError extends Error {
    constructor(currentModel: string);
}
export declare class EmbeddingSlidingWindowError extends Error {
    constructor(sliding_window_size: number);
}
export declare class EmbeddingChunkingUnsupportedError extends Error {
    constructor(contextWindowSize: number, prefillChunkSize: number);
}
export declare class EmbeddingExceedContextWindowSizeError extends Error {
    constructor(contextWindowSize: number, receivedSize: number);
}
export declare class EmbeddingInputEmptyError extends Error {
    constructor();
}
export declare class ReloadArgumentSizeUnmatchedError extends Error {
    constructor(numModelId: number, numChatOpts: number);
}
export declare class UnclearModelToUseError extends Error {
    constructor(loadedModels: string[], requestName: string);
}
export declare class SpecifiedModelNotFoundError extends Error {
    constructor(loadedModels: string[], requestedModelId: string, requestName: string);
}
export declare class IncorrectPipelineLoadedError extends Error {
    constructor(selectedModelId: string, expectedPipeline: string, requestName: string);
}
export declare class ReloadModelIdNotUniqueError extends Error {
    constructor(modelId: string[]);
}
export declare class IntegrityError extends Error {
    readonly url: string;
    readonly expected: string;
    readonly actual: string;
    constructor(url: string, expected: string, actual: string);
}
//# sourceMappingURL=error.d.ts.map