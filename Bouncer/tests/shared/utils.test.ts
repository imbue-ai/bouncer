import { describe, it, expect } from 'vitest';
import type { ChatMessage } from '../../src/types';
import {
  parseAPIResponse,
  generateCacheKey,
  cacheKeyFor,
  youtubeVideoIdFromUrl,
  checkRateLimitError,
  checkApiError,
  checkAuthenticationError,
  convertSystemToUserMessages,
  cleanReasoning,
} from '../../src/shared/utils.js';

// ==================== parseAPIResponse ====================

describe('parseAPIResponse', () => {
  it('parses response with post tag (legacy format)', () => {
    const content = `
<post>1</post>
<reasoning>This is about sports.</reasoning>
<category>sports</category>
`;
    const result = parseAPIResponse(content);
    expect(result).toEqual({ shouldHide: true, reasoning: 'This is about sports.', category: 'sports' });
  });

  it('parses response without post tag', () => {
    const content = `
<reasoning>This is about cooking.</reasoning>
<category>no match</category>
`;
    const result = parseAPIResponse(content);
    expect(result).toEqual({ shouldHide: false, reasoning: 'This is about cooking.', category: null });
  });

  it('handles empty content', () => {
    const result = parseAPIResponse('');
    expect(result).toEqual({ shouldHide: false, reasoning: 'Could not parse response', category: null });
  });

  it('handles malformed XML', () => {
    const content = `<reasoning>Incomplete response.`;
    const result = parseAPIResponse(content);
    expect(result).toEqual({ shouldHide: false, reasoning: 'Could not parse response', category: null });
  });

  it('treats "no match" and "unknown" as SHOW', () => {
    const content = `
<reasoning>Unclear.</reasoning>
<category>no match</category>
`;
    const result = parseAPIResponse(content);
    expect(result).toEqual({ shouldHide: false, reasoning: 'Unclear.', category: null });
  });

  it('handles case-insensitive categories', () => {
    const content = `
<reasoning>Match.</reasoning>
<category>Sports</category>
`;
    const result = parseAPIResponse(content);
    expect(result.shouldHide).toBe(true);
    expect(result.category).toBe('sports');
  });

  it('handles categories with extra whitespace', () => {
    const content = `
<reasoning>Match.</reasoning>
<category>  sports  </category>
`;
    const result = parseAPIResponse(content);
    expect(result.shouldHide).toBe(true);
  });

  it('handles multiline reasoning', () => {
    const content = `
<reasoning>This post discusses multiple topics:
- sports
- politics
Overall it matches sports.</reasoning>
<category>sports</category>
`;
    const result = parseAPIResponse(content);
    expect(result.shouldHide).toBe(true);
    expect(result.reasoning).toContain('multiple topics');
  });
});

// ==================== generateCacheKey ====================

describe('generateCacheKey', () => {
  it('returns normalized text for text-only posts', () => {
    const key = generateCacheKey('Hello   world\n\ntest', []);
    expect(key).toBe('Hello world test');
  });

  it('truncates text to 200 chars', () => {
    const longText = 'a'.repeat(300);
    const key = generateCacheKey(longText, []);
    expect(key).toHaveLength(200);
  });

  it('includes sorted image hash when images present', () => {
    const key = generateCacheKey('post text', ['http://b.jpg', 'http://a.jpg']);
    expect(key).toContain('|imgs:');
    expect(key).toContain('http://a.jpg');
    // Images should be sorted
    const imgPart = key.split('|imgs:')[1];
    expect(imgPart.indexOf('http://a.jpg')).toBeLessThan(imgPart.indexOf('http://b.jpg'));
  });

  it('does not mutate the input array', () => {
    const urls = ['http://b.jpg', 'http://a.jpg'];
    generateCacheKey('test', urls);
    expect(urls[0]).toBe('http://b.jpg'); // original order preserved
  });

  it('handles empty text', () => {
    const key = generateCacheKey('', []);
    expect(key).toBe('');
  });

  it('collapses whitespace consistently', () => {
    const key1 = generateCacheKey('hello  world', []);
    const key2 = generateCacheKey('hello\nworld', []);
    const key3 = generateCacheKey('hello\t\tworld', []);
    expect(key1).toBe(key2);
    expect(key2).toBe(key3);
  });

  it('handles null/undefined imageUrls', () => {
    const key1 = generateCacheKey('test', null);
    const key2 = generateCacheKey('test', undefined);
    const key3 = generateCacheKey('test', []);
    expect(key1).toBe(key3);
    expect(key2).toBe(key3);
  });
});

// ==================== youtubeVideoIdFromUrl ====================

describe('youtubeVideoIdFromUrl', () => {
  it('extracts the id from a /watch?v= URL', () => {
    expect(youtubeVideoIdFromUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
  });

  it('extracts the id from a /shorts/ URL', () => {
    expect(youtubeVideoIdFromUrl('https://www.youtube.com/shorts/shortID12345')).toBe('shortID12345');
  });

  it('ignores extra query params and keeps the v id', () => {
    expect(youtubeVideoIdFromUrl('https://www.youtube.com/watch?v=abc123XYZ_-&list=PL1&t=30')).toBe('abc123XYZ_-');
  });

  it('returns null for non-video / malformed URLs', () => {
    expect(youtubeVideoIdFromUrl('https://www.youtube.com/feed/subscriptions')).toBeNull();
    expect(youtubeVideoIdFromUrl('')).toBeNull();
    expect(youtubeVideoIdFromUrl(null)).toBeNull();
    expect(youtubeVideoIdFromUrl('not a url')).toBeNull();
  });
});

// ==================== cacheKeyFor ====================

describe('cacheKeyFor', () => {
  it('keys YouTube purely on the video id, ignoring title/channel and thumbnail', () => {
    const a = cacheKeyFor('youtube', 'Rick Astley: Never Gonna Give You Up',
      ['https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg'], 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    // Same video, different rendered title text + different thumbnail variant.
    const b = cacheKeyFor('youtube', 'Rick Astley: Never Gonna Give You Up (Official Video)',
      ['https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg'], 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    expect(a).toBe('yt:dQw4w9WgXcQ');
    expect(a).toBe(b);
  });

  it('gives different YouTube keys for different videos', () => {
    const a = cacheKeyFor('youtube', 'same title', [], 'https://www.youtube.com/watch?v=AAAAAAAAAAA');
    const b = cacheKeyFor('youtube', 'same title', [], 'https://www.youtube.com/watch?v=BBBBBBBBBBB');
    expect(a).not.toBe(b);
  });

  it('falls back to the text/image key for YouTube when no video id is derivable', () => {
    const key = cacheKeyFor('youtube', 'Channel: Title', ['http://a.jpg'], null);
    expect(key).toBe(generateCacheKey('Channel: Title', ['http://a.jpg']));
  });

  it('uses the text/image key for non-YouTube platforms', () => {
    const key = cacheKeyFor('twitter', 'user: tweet text', ['http://a.jpg'], 'https://x.com/user/status/1');
    expect(key).toBe(generateCacheKey('user: tweet text', ['http://a.jpg']));
  });
});

// ==================== checkRateLimitError ====================

describe('checkRateLimitError', () => {
  it('returns false for null/empty input', () => {
    expect(checkRateLimitError(null).isRateLimited).toBe(false);
    expect(checkRateLimitError('').isRateLimited).toBe(false);
  });

  it('detects OpenRouter credits exhausted', () => {
    const result = checkRateLimitError('free-models-per-day limit exceeded');
    expect(result.isRateLimited).toBe(true);
    expect(result.type).toBe('openrouter_credits');
  });

  it('detects Gemini free tier via combined patterns', () => {
    const result = checkRateLimitError('RESOURCE_EXHAUSTED: quota limit reached');
    expect(result.isRateLimited).toBe(true);
    expect(result.type).toBe('gemini_free_tier');
  });

  it('detects Gemini free tier via single pattern', () => {
    const result = checkRateLimitError('GenerateRequestsPerMinutePerProjectPerModel-FreeTier exceeded');
    expect(result.isRateLimited).toBe(true);
    expect(result.type).toBe('gemini_free_tier');
  });

  it('detects generic rate limits', () => {
    const result = checkRateLimitError('Rate limit exceeded');
    expect(result.isRateLimited).toBe(true);
    expect(result.type).toBe('generic');
  });

  it('detects 429 error codes', () => {
    const result = checkRateLimitError('HTTP 429 Too Many Requests');
    expect(result.isRateLimited).toBe(true);
  });

  it('returns false for non-rate-limit errors', () => {
    const result = checkRateLimitError('Invalid API key');
    expect(result.isRateLimited).toBe(false);
    expect(result.type).toBeNull();
  });

  it('combined patterns require ALL patterns to match', () => {
    // Only RESOURCE_EXHAUSTED without quota should not match gemini_free_tier combined pattern
    // But it would match the single pattern for RESOURCE_EXHAUSTED in generic
    const result = checkRateLimitError('RESOURCE_EXHAUSTED: general error');
    // This should match generic because RESOURCE_EXHAUSTED is in GENERIC_RATE_LIMIT_PATTERNS
    expect(result.isRateLimited).toBe(true);
  });
});

// ==================== checkApiError ====================

describe('checkApiError', () => {
  it('returns false for null/empty input', () => {
    expect(checkApiError(null).isApiError).toBe(false);
    expect(checkApiError('').isApiError).toBe(false);
  });

  it('detects 404 errors', () => {
    const result = checkApiError('HTTP 404 Not Found');
    expect(result.isApiError).toBe(true);
    expect(result.type).toBe('not_found');
  });

  it('detects server errors', () => {
    const result = checkApiError('Internal Server Error 500');
    expect(result.isApiError).toBe(true);
    expect(result.type).toBe('server_error');
  });

  it('detects 502 Bad Gateway', () => {
    const result = checkApiError('502 Bad Gateway');
    expect(result.isApiError).toBe(true);
    expect(result.type).toBe('server_error');
  });

  it('returns false for non-API errors', () => {
    const result = checkApiError('some random error');
    expect(result.isApiError).toBe(false);
    expect(result.type).toBeNull();
  });
});

// ==================== checkAuthenticationError ====================

describe('checkAuthenticationError', () => {
  it('returns false for null/empty input', () => {
    expect(checkAuthenticationError(null)).toBe(false);
    expect(checkAuthenticationError('')).toBe(false);
  });

  it('detects various auth error patterns', () => {
    expect(checkAuthenticationError('Unauthorized access')).toBe(true);
    expect(checkAuthenticationError('Invalid API key provided')).toBe(true);
    expect(checkAuthenticationError('HTTP 401')).toBe(true);
    expect(checkAuthenticationError('HTTP 403 Forbidden')).toBe(true);
    expect(checkAuthenticationError('Access denied')).toBe(true);
    expect(checkAuthenticationError('Not authenticated')).toBe(true);
  });

  it('returns false for non-auth errors', () => {
    expect(checkAuthenticationError('Rate limit exceeded')).toBe(false);
    expect(checkAuthenticationError('Internal server error')).toBe(false);
  });
});

// ==================== convertSystemToUserMessages ====================

describe('convertSystemToUserMessages', () => {
  it('prepends system content to string user message', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'You are a helper.' },
      { role: 'user', content: 'Hello' }
    ];
    const result = convertSystemToUserMessages(messages);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe('user');
    expect(result[0].content).toBe('You are a helper.\n\nHello');
  });

  it('prepends system content to array user message', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'You are a helper.' },
      { role: 'user', content: [{ type: 'text', text: 'Hello' }] }
    ];
    const result = convertSystemToUserMessages(messages);
    expect(result).toHaveLength(1);
    expect(result[0].content[0]).toEqual({ type: 'text', text: 'You are a helper.' });
    expect(result[0].content[1]).toEqual({ type: 'text', text: 'Hello' });
  });

  it('does not mutate original messages', () => {
    const originalContent = [{ type: 'text', text: 'Hello' }];
    const messages: ChatMessage[] = [
      { role: 'system', content: 'System.' },
      { role: 'user', content: originalContent }
    ];
    convertSystemToUserMessages(messages);
    expect(originalContent).toHaveLength(1); // original not mutated
  });

  it('handles messages with no system role', () => {
    const messages: ChatMessage[] = [{ role: 'user', content: 'Hello' }];
    const result = convertSystemToUserMessages(messages);
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe('Hello');
  });
});

// ==================== cleanReasoning ====================

describe('cleanReasoning', () => {
  it('returns null/undefined as-is', () => {
    expect(cleanReasoning(null)).toBeNull();
    expect(cleanReasoning(undefined)).toBeUndefined();
  });

  it('removes category prefixes', () => {
    expect(cleanReasoning('category 1: Sports content')).toBe('Sports content');
  });

  it('splits on pipe separators', () => {
    expect(cleanReasoning('Part one | Part two')).toBe('Part one Part two');
  });

  it('handles combined category prefix and pipe', () => {
    expect(cleanReasoning('category 1: Sports | category 2: Politics')).toBe('Sports Politics');
  });

  it('returns original if result would be empty', () => {
    expect(cleanReasoning('|||')).toBe('|||');
  });
});

