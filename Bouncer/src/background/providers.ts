// API provider functions: callDirectAPI, callAnthropicAPI, callImbueAPI, and sendFeedback

import { convertSystemToUserMessages } from '../shared/utils';
import { API_BASE_URLS } from '../shared/models';
import { imbueWebSocket } from './ws-manager';
import type { ChatMessage, APIConfig, DirectAPIResponse, ImbueFilterResponse, ImbueSuggestResponse, EvaluationPostData } from '../types';

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
    const response = await fetch(endpointUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const errorBody = await response.text();

      // Retry with converted messages if model doesn't support system prompts
      if (errorBody.includes('Developer instruction is not enabled')) {
        const convertedMessages = convertSystemToUserMessages(msgs);
        const retryResponse = await fetch(endpointUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify({ ...requestBody, messages: convertedMessages })
        });
        if (!retryResponse.ok) {
          const retryErrorBody = await retryResponse.text();
          throw new Error(`${apiConfig.apiName} API error (HTTP ${retryResponse.status}): ${retryErrorBody}`);
        }
        return retryResponse.json() as Promise<DirectAPIResponse>;
      }

      throw new Error(`${apiConfig.apiName} API error (HTTP ${response.status}): ${errorBody}`);
    }

    return response.json() as Promise<DirectAPIResponse>;
  }

  const responseData = await makeRequest(messages);
  return responseData.choices[0].message.content;
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

  const responseData = await response.json() as { content: Array<{ type: string; text: string }> };
  // Anthropic returns content as an array of content blocks
  const textBlocks = responseData.content.filter(b => b.type === 'text');
  return textBlocks.map(b => b.text).join('');
}

// Call Imbue backend via persistent WebSocket
// tweetData is a single post object: { text: string, imageUrls: string[] }
export async function callImbueAPI(tweetData: EvaluationPostData, categories: string[] | undefined, reason: 'filterPost' | 'validatePhrase', authToken?: string | null): Promise<ImbueFilterResponse>;
export async function callImbueAPI(tweetData: EvaluationPostData, categories: string[] | undefined, reason: 'suggestAnnoying', authToken?: string | null): Promise<ImbueSuggestResponse>;
export async function callImbueAPI(
  tweetData: EvaluationPostData,
  categories: string[] | undefined,
  reason: string,
  authToken?: string | null
): Promise<ImbueFilterResponse | ImbueSuggestResponse> {
  if (process.env.HAS_IMBUE_BACKEND !== 'true') {
    throw new Error('Imbue backend not configured');
  }
  const message: Record<string, unknown> = {
    action: "tweetFilter",
    tweetData: tweetData,
    categories: categories || [],
    version: chrome.runtime.getManifest().version,
    reason: reason || 'unknown',
  };
  if (authToken) {
    message.authToken = authToken;
  }

  return imbueWebSocket.send(message);
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
  if (process.env.HAS_IMBUE_BACKEND !== 'true') return;
  if (authToken) {
    feedbackMessage.authToken = authToken;
  }
  try {
    await imbueWebSocket.sendFireAndForget(feedbackMessage);
  } catch (err) {
    console.error('[Bouncer] Feedback send error:', err);
  }
}
