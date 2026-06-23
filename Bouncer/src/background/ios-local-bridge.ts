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

import { LOCAL_SYSTEM_PROMPT, buildTableYesnoUserMessage, parseTableYesnoResponse } from '../shared/prompts';
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
 *   EditLens scoring formula `(probs @ arange(n)) / (n-1)` used in the
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
  const textPreview = text.replace(/\s+/g, ' ').trim().slice(0, 60);

  console.log(`[AI] req text="${textPreview}"`);

  let rawResponse: string;
  try {
    rawResponse = await new Promise<string>((resolve, reject) => {
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
  } catch (err) {
    console.error(`[AI] FAIL req="${textPreview}" — ${(err as Error).message ?? String(err)}`);
    throw err;
  }

  try {
    return JSON.parse(rawResponse) as IosLocalAiTextDetectResponse;
  } catch (err) {
    throw new Error(`Local AI-text-detect returned non-JSON payload: ${rawResponse}`, { cause: err });
  }
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
  // LlGuidance FSM-constrained decoding regex: forces N pipe-delimited yes/no
  // cells with optional leading/trailing pipes and tight ` ?` (zero or one
  // space) padding. We deliberately avoid `\s*` here because that includes
  // newlines and tabs — Gemma can otherwise spend its maxOutputTokens budget
  // on whitespace tokens and never reach the Nth verdict.
  //
  // For N=3: `^\|? ?(yes|no)( ?\| ?(yes|no)){2}\|? ?$`
  const n = bannedCategories.length;
  const cell = '(yes|no)';
  const regexConstraint = n === 1
    ? `^\\|? ?${cell} ?\\|? ?$`
    : `^\\|? ?${cell}( ?\\| ?${cell}){${n - 1}}\\|? ?$`;

  const callbackId = `iosLocal-${++nextId}-${Date.now()}`;
  const start = Date.now();
  const postPreview = postData.text.replace(/\s+/g, ' ').trim().slice(0, 60);

  console.log(`[Filter] req cats=${bannedCategories.length} imgs=${imageUrls.length} text="${postPreview}" regex="${regexConstraint}"`);

  let rawResponse: string;
  try {
    rawResponse = await new Promise<string>((resolve, reject) => {
      pending.set(callbackId, { resolve, reject });
      try {
        const payload: Record<string, unknown> = { callbackId, systemMessage, userMessage, regexConstraint };
        if (hasImages) payload.imageUrls = imageUrls;
        webkit.messageHandlers.feedfilterLocalClassify.postMessage(JSON.stringify(payload));
      } catch (err) {
        pending.delete(callbackId);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  } catch (err) {
    console.error(`[Filter] FAIL req="${postPreview}" — ${(err as Error).message ?? String(err)}`);
    throw err;
  }

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
