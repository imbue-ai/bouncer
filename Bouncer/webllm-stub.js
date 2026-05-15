// Stub for @mlc-ai/web-llm — used for the iOS app bundles, which run in a
// WKWebView with no WebGPU. iOS uses a native CoreML bridge for inference,
// so swapping in no-op stubs keeps those bundles small.

export async function CreateMLCEngine() {
  throw new Error("WebLLM is not available in this build (no WebGPU)");
}

export async function hasModelInCache() {
  return false;
}

export const prebuiltAppConfig = { model_list: [] };
