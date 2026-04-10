// Shared pure utility functions used by background, content, and popup scripts

import type { ChatMessage, PostContent } from '../types';

// Format a post's content into the string sent to the AI for evaluation.
// This is also the basis for cache keys and feedback payloads.
export function formatPostForEvaluation(post: PostContent): string {
  return `${post.author}: ${post.text}`;
}

interface ParsedResult {
  shouldHide: boolean;
  reasoning: string;
  category: string | null;
}

// Parse XML-tagged response from API models
// Expected format: <post>N</post><reasoning>...</reasoning><category>...</category> (repeated per post)
export function parseAPIResponse(content: string): ParsedResult {
  // Try format with <post> tag (legacy)
  const postMatch = /<post>\d+<\/post>\s*<reasoning>([\s\S]*?)<\/reasoning>\s*<category>([\s\S]*?)<\/category>/i.exec(content);
  if (postMatch) {
    const reasoning = postMatch[1].trim();
    const category = postMatch[2].trim().toLowerCase();
    const shouldHide = category !== 'no match' && category !== 'unknown';
    return { shouldHide, reasoning, category: shouldHide ? category : null };
  }

  // Format without <post> tag
  const match = /<reasoning>([\s\S]*?)<\/reasoning>\s*<category>([\s\S]*?)<\/category>/i.exec(content);
  if (match) {
    const reasoning = match[1].trim();
    const category = match[2].trim().toLowerCase();
    const shouldHide = category !== 'no match' && category !== 'unknown';
    return { shouldHide, reasoning, category: shouldHide ? category : null };
  }

  console.warn('[ParseAPI] Could not parse response');
  return { shouldHide: false, reasoning: 'Could not parse response', category: null };
}

// Generate a cache key that includes both text and image URLs
// Normalizes whitespace to ensure consistent keys despite DOM re-rendering differences
export function generateCacheKey(post: string, imageUrls: string[] | null | undefined): string {
  // Normalize whitespace: collapse multiple spaces/newlines into single space, trim
  const normalizedPost = post.replace(/\s+/g, ' ').trim();
  const textPart = normalizedPost.substring(0, 200);
  if (!imageUrls || imageUrls.length === 0) {
    return textPart;
  }
  // Include a hash of image URLs to differentiate posts with same text but different images
  // Use spread to avoid mutating the original array
  const imageHash = [...imageUrls].sort().join('|').substring(0, 100);
  return `${textPart}|imgs:${imageHash}`;
}

interface RateLimitTypeConfig {
  patterns: RegExp[];
  combinedPatterns?: RegExp[][];
  reasoning: string;
}

// Provider-specific rate limit configurations
// Each config has patterns to detect that specific rate limit type and a user-facing message
export const RATE_LIMIT_TYPE_CONFIG: Record<string, RateLimitTypeConfig> = {
  openrouter_credits: {
    patterns: [
      /free-models-per-day/i,
      /Add.*credits.*unlock.*free model/i
    ],
    reasoning: 'OpenRouter free tier limit reached - add credits or switch provider'
  },
  gemini_free_tier: {
    patterns: [
      /free_tier/i,
      /GenerateRequestsPerMinutePerProjectPerModel-FreeTier/i
    ],
    // Also match RESOURCE_EXHAUSTED + quota together
    combinedPatterns: [[/RESOURCE_EXHAUSTED/i, /quota/i]],
    reasoning: 'Gemini free tier limit reached - upgrade your plan or switch provider'
  }
};

// Generic rate limit error patterns (fallback when no specific type matches)
export const GENERIC_RATE_LIMIT_PATTERNS: RegExp[] = [
  /rate.?limit/i,
  /too many requests/i,
  /quota exceeded/i,
  /resource.?exhausted/i,
  /RESOURCE_EXHAUSTED/i,
  /quota/i,
  /rate_limit_exceeded/i,
  /Request too large/i,
  /insufficient_quota/i,
  /429/i,
  /limit exceeded/i,
  /try again later/i
];

// Check if an error message indicates a rate limit
export function checkRateLimitError(errorMessage: string | null): { isRateLimited: boolean; type: string | null } {
  if (!errorMessage) return { isRateLimited: false, type: null };

  // Check for provider-specific rate limit types first
  for (const [type, config] of Object.entries(RATE_LIMIT_TYPE_CONFIG)) {
    // Check single patterns
    if (config.patterns?.some(pattern => pattern.test(errorMessage))) {
      return { isRateLimited: true, type };
    }
    // Check combined patterns (all patterns in a group must match)
    if (config.combinedPatterns?.some(group => group.every(pattern => pattern.test(errorMessage)))) {
      return { isRateLimited: true, type };
    }
  }

  // Check for generic rate limit patterns
  const isGenericRateLimit = GENERIC_RATE_LIMIT_PATTERNS.some(pattern => pattern.test(errorMessage));
  return { isRateLimited: isGenericRateLimit, type: isGenericRateLimit ? 'generic' : null };
}

interface ApiErrorTypeConfig {
  patterns: RegExp[];
  message: string;
}

// API error type configurations
export const API_ERROR_TYPE_CONFIG: Record<string, ApiErrorTypeConfig> = {
  not_found: {
    patterns: [/404/i, /not found/i, /model.*not found/i, /endpoint.*not found/i],
    message: 'API endpoint not found (404). Check your model configuration.'
  },
  server_error: {
    patterns: [/500/i, /502/i, /503/i, /504/i, /internal server error/i, /bad gateway/i, /service unavailable/i, /gateway timeout/i],
    message: 'API server error. The service may be temporarily unavailable.'
  }
};

// Check if an error message indicates an API error (404, 500, etc.)
export function checkApiError(errorMessage: string | null): { isApiError: boolean; type: string | null } {
  if (!errorMessage) return { isApiError: false, type: null };

  for (const [type, config] of Object.entries(API_ERROR_TYPE_CONFIG)) {
    if (config.patterns?.some(pattern => pattern.test(errorMessage))) {
      return { isApiError: true, type };
    }
  }

  return { isApiError: false, type: null };
}

// Helper to detect authentication errors from API responses
export function checkAuthenticationError(errorMessage: string | null): boolean {
  if (!errorMessage) return false;
  const lowerError = errorMessage.toLowerCase();
  return (
    lowerError.includes('authentication') ||
    lowerError.includes('unauthorized') ||
    lowerError.includes('invalid api key') ||
    lowerError.includes('invalid_api_key') ||
    lowerError.includes('api key') ||
    lowerError.includes('401') ||
    lowerError.includes('forbidden') ||
    lowerError.includes('403') ||
    lowerError.includes('access denied') ||
    lowerError.includes('invalid credentials') ||
    lowerError.includes('auth failed') ||
    lowerError.includes('not authenticated')
  );
}

// Helper to detect GPU device lost or OOM errors
export function isGPUDeviceLostError(errorMessage: string): boolean {
  if (!errorMessage) return false;
  const lowerError = errorMessage.toLowerCase();
  return (lowerError.includes('device') && (lowerError.includes('lost') || lowerError.includes('destroyed'))) ||
         (lowerError.includes('out of memory') || lowerError.includes('oom')) ||
         lowerError.includes('gpu') && lowerError.includes('memory');
}

// Helper to detect network/download errors that are retryable
export function isNetworkError(errorMessage: string): boolean {
  if (!errorMessage) return false;
  const lowerError = errorMessage.toLowerCase();
  return lowerError.includes('fetch') ||
         lowerError.includes('network') ||
         lowerError.includes('failed to load') ||
         lowerError.includes('connection') ||
         lowerError.includes('timeout') && !lowerError.includes('inference');
}

// Convert system messages to user messages for models that don't support system prompts
// Prepends system content to the first user message
export function convertSystemToUserMessages(messages: ChatMessage[]): ChatMessage[] {
  const converted: ChatMessage[] = [];
  let systemContent: string | null = null;

  for (const msg of messages) {
    if (msg.role === 'system') {
      systemContent = typeof msg.content === 'string' ? msg.content : '';
    } else {
      converted.push({ ...msg, content: Array.isArray(msg.content) ? [...msg.content] : msg.content });
    }
  }

  if (systemContent && converted.length > 0 && converted[0].role === 'user') {
    const firstUser = converted[0];
    if (typeof firstUser.content === 'string') {
      firstUser.content = `${systemContent}\n\n${firstUser.content}`;
    } else if (Array.isArray(firstUser.content)) {
      firstUser.content = [{ type: 'text', text: systemContent }, ...firstUser.content];
    }
  }

  return converted;
}


// Format result from two-stage local inference
export function formatLocalInferenceResult(reasoning: string, shouldHide: boolean): { shouldHide: boolean; reasoning: string } {
  return {
    shouldHide: shouldHide,
    reasoning: reasoning || 'No reasoning provided'
  };
}

// Clean reasoning string by removing "category n: " prefixes and "|" separators
export function cleanReasoning(reasoning: string | null | undefined): string | null | undefined {
  if (!reasoning) return reasoning;
  try {
    const cleaned = reasoning
      .replace(/category\s*\d+\s*:\s*/gi, '')  // Remove "category n: " prefixes
      .split('|')                               // Split by "|"
      .map(s => s.trim())                       // Trim each part
      .filter(s => s.length > 0)                // Remove empty parts
      .join(' ');
    return cleaned || reasoning;  // Fall back to original if result is empty
  } catch {
    return reasoning;  // Fall back to original on any error
  }
}

// HTML escape for safe DOM insertion
export function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
