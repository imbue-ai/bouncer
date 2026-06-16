// Stub for @litert-lm/core — used for the iOS app bundles, which run in a
// WKWebView with no WebGPU. iOS uses a native CoreML bridge for inference,
// so swapping in no-op stubs keeps those bundles small.

const NOT_AVAILABLE = "LiteRT-LM is not available in this build (no WebGPU)";

export class Engine {
  static async create() { throw new Error(NOT_AVAILABLE); }
}

export function loadLiteRtLm() { throw new Error(NOT_AVAILABLE); }
export function unloadLiteRtLm() { /* no-op */ }
export function getOrLoadGlobalLiteRtLm() { throw new Error(NOT_AVAILABLE); }

export const Backend = {
  UNSPECIFIED: 0,
  CPU_ARTISAN: 1,
  GPU_ARTISAN: 2,
  CPU: 3,
  GPU: 4,
  GOOGLE_TENSOR_ARTISAN: 5,
  NPU: 6,
};

export const SamplerType = {
  TYPE_UNSPECIFIED: 0,
  TOP_K: 1,
  TOP_P: 2,
  GREEDY: 3,
};
