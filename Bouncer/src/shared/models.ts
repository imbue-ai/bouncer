// Shared model definitions for Bouncer
// Used by both background and popup (via esbuild bundling)

import type { PredefinedModelsMap } from '../types';

export const PREDEFINED_MODELS: PredefinedModelsMap = {
  local: [
    {
      name: "Qwen3-4B-q4f16_1-MLC",
      display: "Qwen 3 4B",
      isLocal: true,
      supportsImages: false,
      sizeGB: 2.1,
      extraBody: { enable_thinking: false },
      inferenceParams: { temperature: 0.7, top_p: 0.8 },
      webllmConfig: {
        overrides: {
          context_window_size: 1024,
          prefill_chunk_size: 1024,
        },
        model_lib: "https://raw.githubusercontent.com/imbue-ai/binary-mlc-llm-libs/main/Qwen3-4B-q4f16_1-ctx1k_cs1k-webgpu-2.wasm",
      }
    },
    {
      name: "Qwen3_5-4B-q4f16_1-MLC",
      display: "Qwen 3.5 4B",
      isLocal: true,
      supportsImages: false,
      sizeGB: 2.2,
      inferenceParams: { temperature: 0.7, top_p: 0.8, presence_penalty: 1.5 },
      webllmConfig: {
        overrides: {
          context_window_size: 1024,
          prefill_chunk_size: 1024,
        },
        model_lib: "https://raw.githubusercontent.com/imbue-ai/binary-mlc-llm-libs/main/Qwen3.5-4B-q4f16_1-ctx1k_cs1k-webgpu-2.wasm",
        model: "https://huggingface.co/imbue/Qwen3.5-4B-q4f16_1-MLC-2"
      }
    },
    {
      name: "Qwen3_5-4B-vision-q4f16_1-MLC",
      display: "Qwen 3.5 4B Vision",
      isLocal: true,
      supportsImages: true,
      sizeGB: 2.8,
      inferenceParams: { temperature: 0.7, top_p: 0.8, presence_penalty: 1.5 },
      webllmConfig: {
        model_type: 2, // ModelType.VLM
        overrides: {
          context_window_size: 1024,
          prefill_chunk_size: 1024,
        },
        model_lib: "https://raw.githubusercontent.com/imbue-ai/binary-mlc-llm-libs/main/Qwen3.5-4B-vision-q4f16_1-ctx1k_cs1k-webgpu-2.wasm",
        model: "https://huggingface.co/imbue/Qwen3.5-4B-vision-q4f16_1-MLC-2"
      }
    }
  ],
  openrouter: [
    { name: "nvidia/nemotron-nano-12b-v2-vl:free", display: "Nemotron Nano 12B 2 VL", isFree: true },
    { name: "mistralai/ministral-3b-2512", display: "Ministral 3B", isFree: false }
  ],
  openai: [
    { name: 'gpt-5-nano', display: 'GPT-5 Nano', apiKwargs: { reasoning_effort: "minimal" } },
    { name: 'gpt-oss-20b', display: 'gpt-oss-20b' },
  ],
  gemini: [
    { name: 'gemini-2.5-flash-lite', display: 'Gemini 2.5 Flash Lite' },
    { name: 'gemini-2.5-flash', display: 'Gemini 2.5 Flash' },
    { name: 'gemini-3-flash-preview', display: 'Gemini 3 Flash' },
    { name: 'gemini-3.1-flash-lite-preview', display: 'Gemini 3.1 Flash Lite' }
  ],
  anthropic: [
    { name: 'claude-haiku-4-5-20251001', display: 'Claude Haiku 4.5' }
  ]
};

// Default model: 'imbue' when the Imbue backend is configured, empty string otherwise.
// Imported by background, popup, and content scripts to avoid repeating the conditional.
export const DEFAULT_MODEL = process.env.HAS_IMBUE_BACKEND === 'true' ? 'imbue' : '';

export const API_DISPLAY_NAMES: Record<string, string> = {
  openai: 'OpenAI',
  gemini: 'Gemini',
  anthropic: 'Anthropic',
  openrouter: 'OpenRouter',
  imbue: 'Imbue',
  local: 'Local'
};

export const API_BASE_URLS: Record<string, string> = {
  openai: 'https://api.openai.com/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai',
  anthropic: 'https://api.anthropic.com/v1'
};
