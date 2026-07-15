// iOS local-classify bridge.
//
// In the iOS app's WKWebView, the native Swift host runs Gemma 4 E4B IT via
// LiteRT-LM. This module is the JS half of that contract: it formats prompts,
// posts them to the native message handler, and waits for the resolver to be
// called from Swift.
//
// Wire protocol:
//   JS  → native: webkit.messageHandlers.feedfilterLocalClassify
//                   .postMessage(JSON.stringify({
//                     callbackId,
//                     systemMessage,  // stable per filter pack — Swift caches
//                                     // a prefilled Conversation keyed off this
//                     userMessage,    // per-post, varies on every call
//                     imageUrls?      // optional; raw HTTPS URLs (pbs.twimg.com).
//                                     // Swift fetches them via URLSession and
//                                     // passes the bytes to LiteRT-LM's
//                                     // Content.imageData(...).
//                   }))
//   native → JS: window.__ff_resolveLocalClassify(callbackId, ok, b64Payload)
//                where b64Payload is base64-encoded UTF-8.
//
// The native side applies Gemma's chat template internally via the LiteRT-LM
// Conversation API — JS no longer wraps the prompt with turn markers.

import {
  LOCAL_SYSTEM_PROMPT, buildTableYesnoUserMessage, parseTableYesnoResponse,
  AI_INTENT_LOCAL_SYSTEM_PROMPT, buildAiIntentUserMessage,
} from '../shared/prompts';
import type { DetectorResult } from './detectors';
import type { EvaluationPostData, LocalModelDef } from '../types';

interface PendingEntry {
  resolve: (value: string) => void;
  reject: (err: Error) => void;
}

const pending = new Map<string, PendingEntry>();
let nextId = 0;

declare global {
  interface Window {
    __ff_resolveLocalClassify?: (callbackId: string, ok: boolean, b64Payload: string) => void;
    __ff_resolveLocalAiTextDetect?: (callbackId: string, ok: boolean, b64Payload: string) => void;
  }
}

function decodeBase64Payload(b64Payload: string): string {
  try {
    return decodeURIComponent(escape(atob(b64Payload)));
  } catch {
    return '';
  }
}

if (typeof window !== 'undefined') {
  window.__ff_resolveLocalClassify = (callbackId: string, ok: boolean, b64Payload: string) => {
    const entry = pending.get(callbackId);
    if (!entry) return;
    pending.delete(callbackId);

    const payload = decodeBase64Payload(b64Payload);
    if (ok) {
      entry.resolve(payload);
    } else {
      entry.reject(new Error(payload || 'Local model error'));
    }
  };

  window.__ff_resolveLocalAiTextDetect = (
    callbackId: string, ok: boolean, b64Payload: string,
  ) => {
    const entry = pending.get(callbackId);
    if (!entry) return;
    pending.delete(callbackId);

    const payload = decodeBase64Payload(b64Payload);
    if (ok) {
      entry.resolve(payload);
    } else {
      entry.reject(new Error(payload || 'Local AI-text-detect error'));
    }
  };
}

export function isIosLocalAvailable(): boolean {
  return typeof webkit !== 'undefined' && !!webkit.messageHandlers?.feedfilterLocalClassify;
}

export function isIosLocalAiTextDetectAvailable(): boolean {
  return typeof webkit !== 'undefined'
    && !!webkit.messageHandlers?.feedfilterLocalAiTextDetect;
}

/**
 * Result of calling the on-device classifier head.
 *
 * - `aiConfidence` is the **normalized expected bucket index** from the
 *   trained 4-class softmax, i.e. `(probs · [0,1,2,3]) / 3`, matching the
 *   detector scoring formula `(probs @ arange(n)) / (n-1)` used in the
 *   training pipeline (classify_tweets.py, inference.py, eval_v2_buckets.py).
 *   Ranges continuously in [0, 1]: 0 = all mass on class 0 ("clearly
 *   human"), 1 = all mass on class 3 ("clearly AI"), 0.5 = uniform over the
 *   middle buckets. **Not** `P(class>=2)` — that's a different reduction.
 * - `logits` is the raw 4-vector (class 0 = clearly human ... class 3 =
 *   clearly AI), exposed for callers that want a different reduction.
 */
export interface IosLocalAiTextDetectResponse {
  aiConfidence: number;
  logits: number[];
}

/**
 * On-device AI-text detection via the LiteRT-LM classifier head + LoRA.
 * Routes the input text through the native `feedfilterLocalAiTextDetect`
 * WKScriptMessage handler, which calls `LocalInferenceService.classifyText`
 * and returns the raw 4-class logits + a single `aiConfidence` in [0, 1].
 *
 * This is the on-device equivalent of `callImbueAiTextDetection` — the
 * pipeline picks one or the other based on whether the user has selected the
 * iosLocal model.
 */
export async function iosLocalAiTextDetect(
  text: string,
): Promise<IosLocalAiTextDetectResponse> {
  if (!isIosLocalAiTextDetectAvailable()) {
    throw new Error(
      'iOS local AI-text-detect bridge unavailable (not running in WKWebView host?)',
    );
  }
  const callbackId = `iosLocalAiText-${++nextId}-${Date.now()}`;

  const rawResponse = await new Promise<string>((resolve, reject) => {
    pending.set(callbackId, { resolve, reject });
    try {
      const payload = { callbackId, text };
      webkit.messageHandlers.feedfilterLocalAiTextDetect.postMessage(
        JSON.stringify(payload),
      );
    } catch (err) {
      pending.delete(callbackId);
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });

  try {
    return JSON.parse(rawResponse) as IosLocalAiTextDetectResponse;
  } catch (err) {
    throw new Error(`Local AI-text-detect returned non-JSON payload: ${rawResponse}`, { cause: err });
  }
}

/**
 * Freeform text generation over the native bridge — same wire protocol as
 * classify, but with no regex constraint and a caller-chosen token budget
 * (the native side defaults to the tight 24-token classify cap otherwise).
 * Used for phrase suggestions ("Bounce a Tweet"); text only, no images.
 */
export async function iosLocalGenerate(
  systemMessage: string,
  userMessage: string,
  opts?: { maxOutputTokens?: number; modelName?: string },
): Promise<string> {
  if (!isIosLocalAvailable()) {
    throw new Error('iOS local-classify bridge unavailable (not running in WKWebView host?)');
  }
  const callbackId = `iosLocalGen-${++nextId}-${Date.now()}`;
  return await new Promise<string>((resolve, reject) => {
    pending.set(callbackId, { resolve, reject });
    try {
      const payload: Record<string, unknown> = { callbackId, systemMessage, userMessage };
      if (opts?.maxOutputTokens) payload.maxOutputTokens = opts.maxOutputTokens;
      if (opts?.modelName) payload.modelName = opts.modelName;
      webkit.messageHandlers.feedfilterLocalClassify.postMessage(JSON.stringify(payload));
    } catch (err) {
      pending.delete(callbackId);
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

// LlGuidance FSM-constrained decoding regex: forces N pipe-delimited yes/no
// cells with optional leading/trailing pipes and tight ` ?` (zero or one
// space) padding. We deliberately avoid `\s*` here because that includes
// newlines and tabs — Gemma can otherwise spend its maxOutputTokens budget
// on whitespace tokens and never reach the Nth verdict.
//
// For N=3: `^\|? ?(yes|no)( ?\| ?(yes|no)){2}\|? ?$`
function yesnoRowRegex(n: number): string {
  const cell = '(yes|no)';
  return n === 1
    ? `^\\|? ?${cell} ?\\|? ?$`
    : `^\\|? ?${cell}( ?\\| ?${cell}){${n - 1}}\\|? ?$`;
}

/**
 * On-device AI-intent judgment: which of the user's filter phrases ask for
 * AI-generated content to be removed? The local equivalent of the Imbue
 * backend's detectAiIntent probe — called once per phrase-set change from
 * refreshAiFilterIntent (debounced), never per post.
 *
 * Returns the phrases judged as AI-removal requests, or null when the
 * verdict row couldn't be parsed — null means "unknown", so the caller
 * leaves judgedSetKey stale and the next trigger retries.
 */
export async function iosLocalJudgeAiIntent(
  phrases: string[],
  modelConfig: LocalModelDef | null,
): Promise<string[] | null> {
  if (!isIosLocalAvailable()) {
    throw new Error('iOS local-classify bridge unavailable (not running in WKWebView host?)');
  }
  const systemMessage = AI_INTENT_LOCAL_SYSTEM_PROMPT;
  const userMessage = buildAiIntentUserMessage(phrases);
  const regexConstraint = yesnoRowRegex(phrases.length);
  // The native default is the tight 24-token classify cap; a large phrase
  // union (~3 tokens per verdict) can exceed it, so size the budget to the
  // row.
  const maxOutputTokens = Math.max(24, 6 + 4 * phrases.length);

  const callbackId = `iosLocalAiIntent-${++nextId}-${Date.now()}`;

  const rawResponse = await new Promise<string>((resolve, reject) => {
    pending.set(callbackId, { resolve, reject });
    try {
      const payload: Record<string, unknown> = {
        callbackId, systemMessage, userMessage, regexConstraint, maxOutputTokens,
      };
      if (modelConfig?.name) payload.modelName = modelConfig.name;
      webkit.messageHandlers.feedfilterLocalClassify.postMessage(JSON.stringify(payload));
    } catch (err) {
      pending.delete(callbackId);
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });

  const { matches, malformed } = parseTableYesnoResponse(rawResponse, phrases);
  return malformed ? null : matches;
}

export async function iosLocalClassify(
  postData: EvaluationPostData,
  bannedCategories: string[],
  modelConfig: LocalModelDef | null,
): Promise<DetectorResult> {
  if (!isIosLocalAvailable()) {
    throw new Error('iOS local-classify bridge unavailable (not running in WKWebView host?)');
  }

  // Respect the model's supportsImages flag. The LiteRT-LM Swift bindings
  // currently have no way to enable vision modality on a session config (the
  // C bindings expose no setter for SessionConfig::VisionModalityEnabled),
  // so the C++ runtime's vision executor is never lazy-loaded and any
  // sendMessage with Content.imageData fails with "Vision executor should
  // not be null". Until the fork patches that gap, only send images when
  // the model is explicitly marked supportsImages=true.
  const supportsImages = modelConfig?.supportsImages === true;
  const rawImageUrls = postData.imageUrls ?? [];
  const imageUrls = supportsImages ? rawImageUrls : [];
  const hasImages = imageUrls.length > 0;
  // Same prompt shape as the desktop path (see `callLocalInference` in
  // local-model.ts): bare system prompt, categories in the user message. iOS
  // still benefits from prefix caching — the Swift side keeps a base
  // Conversation keyed on the (immutable) system string and `.clone()`s it
  // per post.
  const systemMessage = LOCAL_SYSTEM_PROMPT;
  const userMessage = buildTableYesnoUserMessage(postData.text, bannedCategories, hasImages);
  const regexConstraint = yesnoRowRegex(bannedCategories.length);

  const callbackId = `iosLocal-${++nextId}-${Date.now()}`;
  const start = Date.now();

  const rawResponse = await new Promise<string>((resolve, reject) => {
    pending.set(callbackId, { resolve, reject });
    try {
      const payload: Record<string, unknown> = { callbackId, systemMessage, userMessage, regexConstraint };
      if (modelConfig?.name) payload.modelName = modelConfig.name;
      if (hasImages) payload.imageUrls = imageUrls;
      webkit.messageHandlers.feedfilterLocalClassify.postMessage(JSON.stringify(payload));
    } catch (err) {
      pending.delete(callbackId);
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });

  const inferenceTime = (Date.now() - start) / 1000;
  const { shouldHide, reasoning, matches } = parseTableYesnoResponse(rawResponse, bannedCategories);
  // `matches` is the list of categories that received `yes`; join into the
  // `category` field so the View-Filtered renderer can split on `, ` and
  // emit one badge per match (same convention as the desktop path).
  const category = matches.length > 0 ? matches.join(', ') : null;

  return {
    shouldHide,
    reasoning,
    category,
    rawResponse,
    inferenceTime,
  };
}
