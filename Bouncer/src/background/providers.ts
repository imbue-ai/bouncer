// API provider functions: callDirectAPI, callAnthropicAPI, callImbueAPI, and sendFeedback

import { convertSystemToUserMessages } from '../shared/utils';
import { API_BASE_URLS } from '../shared/models';
import { imbueWebSocket } from './ws-manager';
import type { ChatMessage, APIConfig, DirectAPIResponse, ImbueFilterResponse, ImbueSuggestResponse, ImbueAiTextResponse, ImbueAiImageResponse, EvaluationPostData } from '../types';

// Call an OpenAI-compatible API directly from the extension via fetch
// Used for OpenAI, OpenRouter, and Gemini models
export async function callDirectAPI(messages: ChatMessage[], apiConfig: APIConfig): Promise<string> {
  const baseUrl = apiConfig.apiBase
    ? apiConfig.apiBase.replace(/\/+$/, '')
    : API_BASE_URLS[apiConfig.apiName];

  if (!baseUrl) {
    throw new Error(`Unknown API: ${apiConfig.apiName}`);
  }

  const endpointUrl = `${baseUrl}/chat/completions`;

  // Build headers
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiConfig.apiKey}`
  };

  // OpenRouter extra headers
  if (apiConfig.apiName === 'openrouter') {
    headers['HTTP-Referer'] = 'https://bouncer.app';
    headers['X-Title'] = 'Bouncer';
  }

  // Build request body
  const requestBody: Record<string, unknown> = {
    model: apiConfig.modelName,
    messages: messages
  };

  // Merge apiKwargs (e.g., reasoning_effort, temperature)
  if (apiConfig.apiKwargs) {
    Object.assign(requestBody, apiConfig.apiKwargs);
  }

  async function makeRequest(msgs: ChatMessage[]): Promise<DirectAPIResponse> {
    const body = { ...requestBody, messages: msgs };
    console.log(`[Provider:${apiConfig.apiName}] POST ${endpointUrl} model=${apiConfig.modelName} messages=${msgs.length}`);
    const response = await fetch(endpointUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const errorBody = await response.text();
      console.log(`[Provider:${apiConfig.apiName}] HTTP ${response.status} error body:`, errorBody);

      // Retry with converted messages if model doesn't support system prompts
      if (errorBody.includes('Developer instruction is not enabled')) {
        console.log(`[Provider:${apiConfig.apiName}] retrying with converted system→user messages`);
        const convertedMessages = convertSystemToUserMessages(msgs);
        const retryResponse = await fetch(endpointUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify({ ...requestBody, messages: convertedMessages })
        });
        if (!retryResponse.ok) {
          const retryErrorBody = await retryResponse.text();
          console.log(`[Provider:${apiConfig.apiName}] retry HTTP ${retryResponse.status} error body:`, retryErrorBody);
          throw new Error(`${apiConfig.apiName} API error (HTTP ${retryResponse.status}): ${retryErrorBody}`);
        }
        const retryJson = await retryResponse.text();
        console.log(`[Provider:${apiConfig.apiName}] retry OK body:`, retryJson);
        return JSON.parse(retryJson) as DirectAPIResponse;
      }

      throw new Error(`${apiConfig.apiName} API error (HTTP ${response.status}): ${errorBody}`);
    }

    // Read as text first so we can log the raw body even when it doesn't
    // parse as the expected shape (e.g. OpenRouter's HTTP-200 `{error: ...}`).
    const rawBody = await response.text();
    console.log(`[Provider:${apiConfig.apiName}] HTTP ${response.status} body:`, rawBody);
    return JSON.parse(rawBody) as DirectAPIResponse;
  }

  const responseData = await makeRequest(messages);
  // OpenRouter (and other OpenAI-compatible providers) can return HTTP 200
  // with an `{ error: { message, code } }` body instead of a chat completion
  // — most commonly on rate limit / quota / moderation / upstream-provider
  // failures. Surface the real error instead of letting `.choices[0]` throw
  // a generic TypeError that the pipeline can't classify.
  const choice = responseData.choices?.[0];
  if (!choice?.message?.content) {
    const apiError = (responseData as unknown as { error?: { message?: string; code?: string | number } }).error;
    if (apiError?.message) {
      throw new Error(`${apiConfig.apiName} API error: ${apiError.message}`);
    }
    throw new Error(`${apiConfig.apiName} returned unexpected response shape: ${JSON.stringify(responseData).slice(0, 200)}`);
  }
  console.log(`[Provider:${apiConfig.apiName}] model content:`, choice.message.content);
  return choice.message.content;
}

// Call Anthropic Messages API directly
// Anthropic uses a different format from OpenAI-compatible APIs
export async function callAnthropicAPI(messages: ChatMessage[], apiConfig: APIConfig): Promise<string> {
  const baseUrl = apiConfig.apiBase
    ? apiConfig.apiBase.replace(/\/+$/, '')
    : API_BASE_URLS.anthropic;

  const endpointUrl = `${baseUrl}/messages`;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-api-key': apiConfig.apiKey!,
    'anthropic-version': '2023-06-01',
    'anthropic-dangerous-direct-browser-access': 'true'
  };

  // Extract system message and convert user messages to Anthropic format
  let system: string | undefined;
  const anthropicMessages: Array<{ role: string; content: unknown }> = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      system = typeof msg.content === 'string' ? msg.content : (msg.content as Array<{ text?: string }>).map(c => c.text).join('\n');
    } else {
      // Convert OpenAI content format to Anthropic format
      let content: unknown;
      if (typeof msg.content === 'string') {
        content = msg.content;
      } else if (Array.isArray(msg.content)) {
        content = msg.content.map(part => {
          if (part.type === 'text') {
            return { type: 'text', text: part.text };
          } else if (part.type === 'image_url') {
            const url = part.image_url!.url;
            // Handle base64 data URLs
            const match = url.match(/^data:(image\/[^;]+);base64,(.+)$/);
            if (match) {
              return {
                type: 'image',
                source: { type: 'base64', media_type: match[1], data: match[2] }
              };
            }
            // Handle regular URLs
            return {
              type: 'image',
              source: { type: 'url', url }
            };
          }
          return part;
        });
      } else {
        content = msg.content;
      }
      anthropicMessages.push({ role: msg.role, content });
    }
  }

  const requestBody: Record<string, unknown> = {
    model: apiConfig.modelName,
    max_tokens: 256,
    messages: anthropicMessages
  };

  if (system) {
    requestBody.system = system;
  }

  if (apiConfig.apiKwargs) {
    Object.assign(requestBody, apiConfig.apiKwargs);
  }

  console.log(`[Provider:anthropic] POST ${endpointUrl} model=${apiConfig.modelName} messages=${anthropicMessages.length}`);
  const response = await fetch(endpointUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(requestBody)
  });

  if (!response.ok) {
    const errorBody = await response.text();
    console.error(`[AnthropicAPI] Error body: ${errorBody}`);
    throw new Error(`anthropic API error (HTTP ${response.status}): ${errorBody}`);
  }

  const rawBody = await response.text();
  console.log(`[Provider:anthropic] HTTP ${response.status} body:`, rawBody);
  const responseData = JSON.parse(rawBody) as { content: Array<{ type: string; text: string }> };
  // Anthropic returns content as an array of content blocks
  const textBlocks = responseData.content.filter(b => b.type === 'text');
  const out = textBlocks.map(b => b.text).join('');
  console.log(`[Provider:anthropic] model content:`, out);
  return out;
}

// Call Imbue backend via persistent WebSocket
// tweetData is a single post object: { text: string, imageUrls: string[] }
// Auth token is not sent — the WS gateway authenticates the connection itself
// via the App Check token at handshake time.
export async function callImbueAPI(tweetData: EvaluationPostData, categories: string[] | undefined, reason: 'filterPost' | 'validatePhrase'): Promise<ImbueFilterResponse>;
export async function callImbueAPI(tweetData: EvaluationPostData, categories: string[] | undefined, reason: 'suggestAnnoying'): Promise<ImbueSuggestResponse>;
export async function callImbueAPI(
  tweetData: EvaluationPostData,
  categories: string[] | undefined,
  reason: string,
): Promise<ImbueFilterResponse | ImbueSuggestResponse> {
  const message: Record<string, unknown> = {
    action: "tweetFilter",
    tweetData: tweetData,
    categories: categories || [],
    version: chrome.runtime.getManifest().version,
    reason: reason || 'unknown',
  };

  console.log('[Filter] → request:', message);
  const startedAt = Date.now();

  try {
    const response = await imbueWebSocket.send(message) as unknown as ImbueFilterResponse | ImbueSuggestResponse;
    const wallMs = Date.now() - startedAt;
    console.log(`[Filter] ← response (wallMs=${wallMs}):`, response);
    return response;
  } catch (err) {
    const wallMs = Date.now() - startedAt;
    console.warn(`[Filter] ✗ error after ${wallMs}ms:`, err);
    throw err;
  }
}

// Call the Imbue AI-text-detection worker via the same WebSocket gateway.
// Routes to a dedicated worker via the `detectAiText` action; threshold is applied client-side.
export async function callImbueAiTextDetection(
  tweetData: EvaluationPostData,
): Promise<ImbueAiTextResponse> {
  const message: Record<string, unknown> = {
    action: 'detectAiText',
    tweetData,
    version: chrome.runtime.getManifest().version,
  };

  console.log('[AiDetect] → request:', message);
  const startedAt = Date.now();

  try {
    const response = await imbueWebSocket.send(message) as unknown as ImbueAiTextResponse;
    const wallMs = Date.now() - startedAt;
    console.log(`[AiDetect] ← response (wallMs=${wallMs}):`, response);
    return response;
  } catch (err) {
    const wallMs = Date.now() - startedAt;
    console.warn(`[AiDetect] ✗ error after ${wallMs}ms:`, err);
    throw err;
  }
}

// Call the Imbue AI-image-detection worker via the same WebSocket gateway.
// Routes to a dedicated worker via the `detectAiImage` action; threshold is
// applied client-side against confidence = max(scores).
export async function callImbueAiImageDetection(
  imageUrls: string[],
): Promise<ImbueAiImageResponse> {
  const message: Record<string, unknown> = {
    action: 'detectAiImage',
    tweetData: { imageUrls },
    version: chrome.runtime.getManifest().version,
  };

  console.log('[AiImageDetect] → request:', message);
  const startedAt = Date.now();

  try {
    const response = await imbueWebSocket.send(message) as unknown as ImbueAiImageResponse;
    const wallMs = Date.now() - startedAt;
    console.log(`[AiImageDetect] ← response (wallMs=${wallMs}):`, response);
    return response;
  } catch (err) {
    const wallMs = Date.now() - startedAt;
    console.warn(`[AiImageDetect] ✗ error after ${wallMs}ms:`, err);
    throw err;
  }
}

interface FeedbackMessage {
  action: string;
  tweetData: { text: string; imageUrls: string[] };
  categories: string[];
  version: string;
  model: string;
  rawResponse: string;
  reasoning: string;
  decision: string;
  authToken?: string;
}

// Send feedback (false_positive / false_negative) to Imbue via persistent WebSocket
export async function sendFeedback(feedbackMessage: FeedbackMessage, authToken?: string | null): Promise<void> {
  if (authToken) {
    feedbackMessage.authToken = authToken;
  }
  try {
    await imbueWebSocket.sendFireAndForget(feedbackMessage);
  } catch (err) {
    console.error('[Bouncer] Feedback send error:', err);
  }
}
