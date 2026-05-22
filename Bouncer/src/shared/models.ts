// Shared model definitions for Bouncer
// Used by both background and popup (via esbuild bundling)

import type { PredefinedModelsMap } from '../types';

export const PREDEFINED_MODELS: PredefinedModelsMap = {
  local: [
    {
      name: "gemma-4-E4B-it-web",
      display: "Gemma 4 E4B (Instruct)",
      isLocal: true,
      backend: 'litertlm',
      supportsImages: false,
      sizeGB: 3.0,
      inferenceParams: { temperature: 0.0 },
      litertlmConfig: {
        modelUrl: "https://huggingface.co/litert-community/gemma-4-E4B-it-litert-lm/resolve/main/gemma-4-E4B-it-web.litertlm",
        maxTokens: 1024,
        topK: 40,
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
  ]
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
  local: 'Local'
};

export const API_BASE_URLS: Record<string, string> = {
  openai: 'https://api.openai.com/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai',
  anthropic: 'https://api.anthropic.com/v1'
};
