// Shared model definitions for Bouncer
// Used by both background and popup (via esbuild bundling)

import type { LocalModelDef, PredefinedModelsMap } from '../types';
import { CURRENT_TARGET } from './platforms';

// iOS on-device model catalog, injected by the native app: FilteredWebView
// prepends `var __iosLocalModels = [...]` (serialized from the Swift
// registry, LocalInferenceService.models) to ChromePolyfill.js, which runs
// before any bundle that imports this module. That registry is the single
// source of truth for iOS models — ids, display names, sizes, and the
// device-RAM support flag all come from it. Desktop/extension builds have no
// such global and get an empty list; the iosLocal provider is only reachable
// in-app anyway.
interface InjectedIosModel {
  name: string;
  display: string;
  size: string;        // e.g. "~2.2 GB"
  isSupported: boolean;
  requiredRAM: string; // e.g. "6 GB"
}
const injectedIosModels: InjectedIosModel[] =
  (globalThis as { __iosLocalModels?: InjectedIosModel[] }).__iosLocalModels ?? [];

// Loudness guard: inside the app (ChromePolyfill sets chrome._polyfilled) the
// catalog must exist and be non-empty — an empty list here means the
// injection-order invariant broke (some bundle importing this module ran
// before ChromePolyfill) and the popup would silently lose its on-device
// model row. Warn so the failure is diagnosable from the console.
const inApp = typeof chrome !== 'undefined' &&
  (chrome as unknown as { _polyfilled?: boolean })._polyfilled;
if (inApp && injectedIosModels.length === 0) {
  console.warn(
    '[models] __iosLocalModels missing/empty in app mode — native catalog ' +
    'injection did not run before this bundle; on-device model UI will be absent.',
  );
}

// Chrome's built-in Gemini Nano via the Prompt API (Chrome 138+ for
// extensions). Chrome downloads and owns the weights, so there's no
// modelUrl or size; Firefox/Safari have no LanguageModel global, so the
// entry only exists in the Chrome build.
export const PROMPT_API_MODEL_NAME = 'gemini-nano-chrome';
const PROMPT_API_MODELS: LocalModelDef[] = CURRENT_TARGET === 'chrome' ? [{
  name: PROMPT_API_MODEL_NAME,
  display: 'Gemini Nano (Chrome built-in)',
  isLocal: true,
  backend: 'prompt-api',
  supportsImages: true,
  promptApiConfig: { maxNumImages: 4 },
}] : [];

export const PREDEFINED_MODELS: PredefinedModelsMap = {
  // Web models use the generic `.litertlm` files (Backend.GPU) rather than
  // the `-web`/`-gpu` GPU_ARTISAN builds: only the generic files carry the
  // vision encoder sections. Ids keep their "-web" suffix because they're
  // persisted in users' selectedModel setting. The context window fits up to
  // 4 images x 280 vision tokens (Gemma 4's default budget) plus the prompt.
  local: [
    ...PROMPT_API_MODELS,
    {
      name: "gemma-4-E2B-it-web",
      display: "Gemma 4 E2B (Instruct)",
      isLocal: true,
      backend: 'litertlm',
      supportsImages: true,
      sizeGB: 2.6,
      inferenceParams: { temperature: 0.0 },
      litertlmConfig: {
        modelUrl: "https://huggingface.co/litert-community/gemma-4-E2B-it-litert-lm/resolve/main/gemma-4-E2B-it.litertlm",
        maxTokens: 2048,
        topK: 40,
        vision: { maxNumImages: 4, maxVisionTokensPerImage: 280 },
      }
    },
    {
      name: "gemma-4-E4B-it-web",
      display: "Gemma 4 E4B (Instruct)",
      isLocal: true,
      backend: 'litertlm',
      supportsImages: true,
      sizeGB: 3.7,
      inferenceParams: { temperature: 0.0 },
      litertlmConfig: {
        modelUrl: "https://huggingface.co/litert-community/gemma-4-E4B-it-litert-lm/resolve/main/gemma-4-E4B-it.litertlm",
        maxTokens: 2048,
        topK: 40,
        vision: { maxNumImages: 4, maxVisionTokensPerImage: 280 },
      }
    }
  ],
  openrouter: [
    { name: "nvidia/nemotron-nano-12b-v2-vl:free", display: "Nemotron Nano 12B 2 VL", isFree: true },
    { name: "mistralai/ministral-3b-2512", display: "Ministral 3B", isFree: false }
  ],
  openai: [
    { name: 'gpt-5-nano', display: 'GPT-5 Nano', apiKwargs: { reasoning_effort: "minimal" } },
  ],
  gemini: [
    { name: 'gemini-2.5-flash-lite', display: 'Gemini 2.5 Flash Lite' },
    { name: 'gemini-2.5-flash', display: 'Gemini 2.5 Flash' },
    { name: 'gemini-3-flash-preview', display: 'Gemini 3 Flash' },
    { name: 'gemini-3.1-flash-lite-preview', display: 'Gemini 3.1 Flash Lite' }
  ],
  anthropic: [
    { name: 'claude-haiku-4-5-20251001', display: 'Claude Haiku 4.5' }
  ],
  // Populated from the injected native catalog (see InjectedIosModel above).
  // The native side resolves files/URLs from the "iosLocal:<id>" key.
  iosLocal: injectedIosModels.map((m) => ({
    name: m.name,
    display: m.display,
    isLocal: true,
    supportsImages: false,
    sizeDisplay: m.size,
    isSupportedOnThisDevice: m.isSupported,
    requiredRAMDisplay: m.requiredRAM,
  })),
};

// Default model: 'imbue' when the Imbue backend is configured at build
// time, empty string otherwise. Empty string represents "no model
// configured" and triggers the OpenRouter auto-switch on first sign-in
// (see popup/index.ts). Imported by background, popup, and content
// scripts to avoid repeating the conditional everywhere.
export const DEFAULT_MODEL = process.env.HAS_IMBUE_BACKEND === 'true' ? 'imbue' : '';

export const API_DISPLAY_NAMES: Record<string, string> = {
  openai: 'OpenAI',
  gemini: 'Gemini',
  anthropic: 'Anthropic',
  openrouter: 'OpenRouter',
  imbue: 'Imbue',
  local: 'Local',
  iosLocal: 'On-device (iOS)'
};

export const API_BASE_URLS: Record<string, string> = {
  openai: 'https://api.openai.com/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai',
  anthropic: 'https://api.anthropic.com/v1'
};
