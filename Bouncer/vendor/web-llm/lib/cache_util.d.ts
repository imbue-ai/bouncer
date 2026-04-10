import { AppConfig, ChatConfig } from "./config";
import { Tokenizer } from "@mlc-ai/web-tokenizers";
import { ModelIntegrity } from "./integrity";
export declare function hasModelInCache(modelId: string, appConfig?: AppConfig): Promise<boolean>;
export declare function deleteModelAllInfoInCache(modelId: string, appConfig?: AppConfig): Promise<void>;
export declare function deleteModelInCache(modelId: string, appConfig?: AppConfig): Promise<void>;
export declare function deleteChatConfigInCache(modelId: string, appConfig?: AppConfig): Promise<void>;
export declare function deleteModelWasmInCache(modelId: string, appConfig?: AppConfig): Promise<void>;
/**
 *
 * @param baseUrl The link to which we can find tokenizer files, usually is a `ModelRecord.model`.
 * @param config A ChatConfig, usually loaded from `mlc-chat-config.json` in `baseUrl`.
 * @param appConfig An AppConfig, usually `webllm.prebuiltAppConfig` if not defined by user.
 * @param logger Logging function, console.log by default.
 * @param integrity Optional integrity configuration for verifying tokenizer files.
 * @returns
 */
export declare function asyncLoadTokenizer(baseUrl: string, config: ChatConfig, appConfig: AppConfig, logger?: (msg: string) => void, integrity?: ModelIntegrity): Promise<Tokenizer>;
//# sourceMappingURL=cache_util.d.ts.map