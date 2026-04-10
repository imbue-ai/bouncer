/** Util methods. */
import { Tokenizer } from "@mlc-ai/web-tokenizers";
import { AppConfig, ModelRecord } from "./config";
import { ChatCompletionChunk, ChatCompletionContentPartImage, ChatCompletionMessageToolCall } from "./openai_api_protocols/index";
/**
 * Based on `p_prob` of size (vocabSize,) which becomes a distribution after calling
 * `applySoftmaxWithTemperature()`, sample `top_logprobs` top-probable tokens.
 *
 * @param num_top_probs: `top_logprobs` from ChatCompletionRequest
 * @param p_prob: `logitsOnCPUArray`, being a distribution after `applySoftmaxWithTemperature()`.
 *
 * Followed implementation of `ComputeTopProbsImpl()` from [https://github.com/mlc-ai/mlc-llm/blob/
 * 5b8c529e9704abd09b0432da6dcb4b013fdf43b1/cpp/serve/sampler/cpu_sampler.cc].
 *
 * @returns Arrays of (tokenID, prob) pairs, ranked from highest prob to least.
 */
export declare function getTopProbs(num_top_probs: number, p_prob: Float32Array): Array<[number, number]>;
/**
 * Get the token table in the form of a string list of tokens, ordered by their token id.
 * @param tokenizer A loaded tokenizer.
 * @note The size of the table (i.e. tokenizer.getVocabSize()) may be smaller than the `vocab_size`
 * in config.json (length of logits), see https://github.com/QwenLM/Qwen2/issues/147 and
 * https://huggingface.co/microsoft/Phi-3-mini-4k-instruct/discussions/47.
 */
export declare function getTokenTableFromTokenizer(tokenizer: Tokenizer): string[];
/**
 * Postprocess the suffix of ModelRecord.model to be "/resolve/main/" if it is not specified otherwise.
 * e.g. https://huggingface.co/mlc-ai/OpenHermes-2.5-Mistral-7B-q4f16_1-MLC/resolve/main/
 * @return the href of the final URL.
 */
export declare function cleanModelUrl(modelUrl: string): string;
/**
 * Json schema used to prompt the model for function calling; directly copied from the official guide.
 * This represents to a single function call.
 */
export declare const officialHermes2FunctionCallSchema = "{\"properties\": {\"arguments\": {\"title\": \"Arguments\", \"type\": \"object\"}, \"name\": {\"title\": \"Name\", \"type\": \"string\"}}, \"required\": [\"arguments\", \"name\"], \"title\": \"FunctionCall\", \"type\": \"object\"}";
/**
 * A list of such function calls. Used to specify response format, since the output is expected to
 * be a list of such function calls.
 */
export declare const officialHermes2FunctionCallSchemaArray = "{\"type\":\"array\",\"items\":{\"properties\": {\"arguments\": {\"title\": \"Arguments\", \"type\": \"object\"}, \"name\": {\"title\": \"Name\", \"type\": \"string\"}}, \"required\": [\"arguments\", \"name\"], \"title\": \"FunctionCall\", \"type\": \"object\"}}";
/**
 * Full system prompt for Hermes-2-Pro function calling.
 */
export declare const hermes2FunctionCallingSystemPrompt = "You are a function calling AI model. You are \nprovided with function signatures within <tools></tools> XML tags. You may call one or more functions \nto assist with the user query. Don't make assumptions about what values to plug into functions. Here \nare the available tools: <tools> {hermes_tools}  </tools>. \nUse the following pydantic model json schema for each tool call you will make: \n{\"properties\": {\"arguments\": {\"title\": \"Arguments\", \"type\": \"object\"}, \"name\": {\"title\": \"Name\", \"type\": \"string\"}}, \"required\": [\"arguments\", \"name\"], \"title\": \"FunctionCall\", \"type\": \"object\"} For each function call return a json object.";
/**
 * Given a string outputMessage, parse it as a JSON object and return an array of tool calls.
 *
 * Expect outputMessage to be a valid JSON string, and expect it to be an array of Function with
 * fields `arguments` and `name`.
 */
export declare function getToolCallFromOutputMessage(outputMessage: string, isStreaming: false): Array<ChatCompletionMessageToolCall>;
export declare function getToolCallFromOutputMessage(outputMessage: string, isStreaming: true): Array<ChatCompletionChunk.Choice.Delta.ToolCall>;
export declare function findModelRecord(modelId: string, appConfig: AppConfig): ModelRecord;
/**
 * Return the model to use given the loaded modelIds and requestModel. Throws error when unclear
 * which model to load.
 * @param loadedModelIds Models currently loaded in the engine.
 * @param requestModel Model the user specified to load via the request. Required when multiple
 *   models are loaded
 * @param requestName The type of request or API to load the model for. Needed for error throwing.
 */
export declare function getModelIdToUse(loadedModelIds: string[], requestModel: string | undefined | null, requestName: string): string;
/**
 * TODO: Consider if this is the best strategy (though aligned with mlc-llm). We currently greedily
 * try to fill up prefillChunkSize. Consider the example with 2048 prefill chunk size:
 * const inputData = [
    image1,  // 1921
    rangeArr(0, 2048),
    image2,
  ];
 * Current approach results in chunks:
   [image1, rangeArr(0, 127)],
   [rangeArr(127, 2048)],
   [image2],
 * This means 4 embedding kernels and 3 prefill kernels.
 * While the optimal chunking may be:
   [image1],
   [rangeArr(0, 2048)],
   [image2],
 * This results in 3 embedding kernels and 3 prefill kernels.
 * However, greedy strategy is more intuitive and probably more generalizable.
 */
/**
 * Chunk the inputData such that each chunk's total input length is smaller than prefill
 * chunk size.
 * @returns [the data chunks, the input length of each chunk]
 * @note precondition: if inputData has image in it, then prefillChunkSize >= imageEmbedSize.
 */
export declare function getChunkedPrefillInputData(inputData: Array<Array<number> | ImageURL>, prefillChunkSize: number, getImageEmbedSize: (image: ImageURL) => number): [Array<Array<number> | ImageURL>[], Array<number>];
/**
 * A lock implemented using Promise.
 *
 * Referred to:
 * - https://jackpordi.com/posts/locks-in-js-because-why-not
 * - https://www.linkedin.com/pulse/asynchronous-locking-using-promises-javascript-abdul-ahad-o7smf/
 */
export declare class CustomLock {
    private acquired;
    private readonly queue;
    acquire(): Promise<void>;
    release(): Promise<void>;
}
type ImageURL = ChatCompletionContentPartImage.ImageURL;
/**
 * Given a url, get the image data. The url can either start with `http` or `data:image`.
 */
export declare function getImageDataFromURL(url: string): Promise<ImageData>;
/**
 * Given an ImageData, return the RGB array in Uint8ClampedArray. Note the ImageData.data
 * is RGBA, so we skip every fourth element of the data. The order goes by rows from the
 * top-left pixel to the bottom-right, in RGB order.
 */
export declare function getRGBArrayFromImageData(imageData: ImageData): Uint8ClampedArray;
export {};
//# sourceMappingURL=support.d.ts.map