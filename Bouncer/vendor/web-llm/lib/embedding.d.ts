import * as tvmjs from "@mlc-ai/web-runtime";
import { Tokenizer } from "@mlc-ai/web-tokenizers";
import { ChatConfig } from "./config";
export declare class EmbeddingPipeline {
    private config;
    private tokenizer;
    private tvm;
    private device;
    private vm;
    private prefill;
    private params;
    private contextWindowSize;
    private prefillChunkSize;
    private maxBatchSize;
    private curRoundEmbedTotalTokens;
    private curRoundEmbedTotalTime;
    constructor(tvm: tvmjs.Instance, tokenizer: Tokenizer, config: ChatConfig);
    embedStep(input: string | Array<string> | Array<number> | Array<Array<number>>): Promise<Array<Array<number>>>;
    dispose(): void;
    /**
     * Synchronize the device.
     */
    sync(): Promise<void>;
    asyncLoadWebGPUPipelines(): Promise<void>;
    /**
     * Get the time it took the last `embedStep()` in seconds.
     */
    getCurRoundEmbedTotalTime(): number;
    /**
     * Get the number of tokens embedded in the last `embedStep()`. This excludes the padded tokens.
     */
    getCurRoundEmbedTotalTokens(): number;
    /**
     * @returns Prefill tokens per second, starting from the last prefill performed.
     */
    getCurRoundEmbedTokensPerSec(): number;
}
//# sourceMappingURL=embedding.d.ts.map