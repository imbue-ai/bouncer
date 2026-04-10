import { ChatOptions, MLCEngineConfig } from "./config";
import { WebWorkerMLCEngineHandler, WebWorkerMLCEngine } from "./web_worker";
export interface ExtensionMLCEngineConfig extends MLCEngineConfig {
    extensionId?: string;
    onDisconnect?: () => void;
}
/**
 * Worker handler that can be used in a ServiceWorker.
 *
 * @example
 *
 * const engine = new MLCEngine();
 * let handler;
 * chrome.runtime.onConnect.addListener(function (port) {
 *   if (handler === undefined) {
 *     handler = new ServiceWorkerMLCEngineHandler(engine, port);
 *   } else {
 *     handler.setPort(port);
 *   }
 *   port.onMessage.addListener(handler.onmessage.bind(handler));
 * });
 */
export declare class ServiceWorkerMLCEngineHandler extends WebWorkerMLCEngineHandler {
    port: chrome.runtime.Port | null;
    constructor(port: chrome.runtime.Port);
    postMessage(msg: any): void;
    setPort(port: chrome.runtime.Port): void;
    onPortDisconnect(port: chrome.runtime.Port): void;
    onmessage(event: any): void;
}
/**
 * Create a ServiceWorkerMLCEngine.
 *
 * @param modelId model_id of the model to load, either string or string[]. When multiple models
 *   are provided, we load all models sequentially. Each modelId needs to either be in
 *   `webllm.prebuiltAppConfig`, or in `engineCOnfig.appConfig`.
 * @param engineConfig Optionally configures the engine, see `webllm.MLCEngineConfig` for more.
 * @param chatOpts Extra options to optionally override the `mlc-chat-config.json` of `modelId`.
 *   The size of which needs to match that of `modelId`; chatOpts[i] will be used for modelId[i].
 * @param keepAliveMs The interval to send keep alive messages to the service worker.
 * See [Service worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle#idle-shutdown)
 * The default is 10s.
 * @returns An initialized `WebLLM.ServiceWorkerMLCEngine` with `modelId` loaded.
 */
export declare function CreateServiceWorkerMLCEngine(modelId: string | string[], engineConfig?: ExtensionMLCEngineConfig, chatOpts?: ChatOptions | ChatOptions[], keepAliveMs?: number): Promise<ServiceWorkerMLCEngine>;
/**
 * A client of MLCEngine that exposes the same interface
 */
export declare class ServiceWorkerMLCEngine extends WebWorkerMLCEngine {
    port: chrome.runtime.Port;
    extensionId?: string;
    constructor(engineConfig?: ExtensionMLCEngineConfig, keepAliveMs?: number);
}
//# sourceMappingURL=extension_service_worker.d.ts.map