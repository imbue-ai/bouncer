import { describe, it, expect } from 'vitest';
import {
  buildAPIMessages,
  buildTableYesnoUserMessage,
  parseTableYesnoResponse,
} from '../../src/shared/prompts.js';

type ContentPart = { type: string; text?: string; image_url?: { url: string } };

// ==================== buildAPIMessages ====================

describe('buildAPIMessages', () => {
  const bannedCategories = ['sports', 'politics'];
  const postData = { text: 'The Lakers won last night!', imageUrls: [] };

  it('returns system + user messages', () => {
    const messages = buildAPIMessages(postData, bannedCategories);
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('system');
    expect(messages[1].role).toBe('user');
  });

  it('includes banned categories in user content', () => {
    const messages = buildAPIMessages(postData, bannedCategories);
    const userContent = messages[1].content as ContentPart[];
    expect(userContent[0].text).toContain('sports');
    expect(userContent[0].text).toContain('politics');
  });

  it('includes post text', () => {
    const messages = buildAPIMessages(postData, bannedCategories);
    const userContent = messages[1].content as ContentPart[];
    const concatenated = userContent.map(c => c.text || '').join('');
    expect(concatenated).toContain('The Lakers won last night!');
  });

  it('interleaves images with post', () => {
    const withImages = { ...postData, imageUrls: ['http://example.com/img1.jpg'] };
    const messages = buildAPIMessages(withImages, bannedCategories);
    const userContent = messages[1].content as ContentPart[];
    const imagePart = userContent.find(c => c.type === 'image_url');
    expect(imagePart).toBeDefined();
    expect(imagePart!.image_url!.url).toBe('http://example.com/img1.jpg');
  });

  it('includes classify instruction', () => {
    const messages = buildAPIMessages(postData, bannedCategories);
    const userContent = messages[1].content as ContentPart[];
    const concatenated = userContent.map(c => c.text || '').join('');
    expect(concatenated).toContain('Classify the post');
  });
});

// ==================== buildTableYesnoUserMessage ====================

describe('buildTableYesnoUserMessage', () => {
  it('includes the post text after a Post: label', () => {
    const msg = buildTableYesnoUserMessage('The Lakers won!', ['sports'], false);
    expect(msg).toContain('Post: The Lakers won!');
  });

  it('lists categories in order, comma-separated, in the user message', () => {
    const msg = buildTableYesnoUserMessage('hi', ['sports', 'politics'], false);
    expect(msg).toContain('Categories (in order): sports, politics');
  });

  it('asks the model for a verdict row', () => {
    const msg = buildTableYesnoUserMessage('hi', ['a'], false);
    expect(msg).toContain('Output the verdict row:');
  });

  it('mentions images when hasImages is true', () => {
    const msg = buildTableYesnoUserMessage('Look at this', ['a'], true);
    expect(msg).toContain('includes images');
  });

  it('does not mention images when hasImages is false', () => {
    const msg = buildTableYesnoUserMessage('Look at this', ['a'], false);
    expect(msg).not.toContain('images');
  });
});

// ==================== parseTableYesnoResponse — Gemma 4 IT + multi-line + bare-token cases ====================
//
// Core happy-path / preamble / count-mismatch coverage lives in
// `tests/background/local-model.test.ts`. These tests cover the cases the
// iOS path added when the parser was unified: Gemma 4 IT's `<turn|>` marker,
// multi-line responses, and bare yes/no with punctuation/filler for
// single-category packs.

describe('parseTableYesnoResponse — primary newline-per-verdict shape', () => {
  it('parses 3 verdicts on separate lines', () => {
    const r = parseTableYesnoResponse('no\nyes\nno', ['a', 'b', 'c']);
    expect(r.shouldHide).toBe(true);
    expect(r.matches).toEqual(['b']);
  });

  it('ignores leading preamble lines that are not yes/no', () => {
    const r = parseTableYesnoResponse('Sure, here are the verdicts:\nno\nyes\nno', ['a', 'b', 'c']);
    expect(r.shouldHide).toBe(true);
    expect(r.matches).toEqual(['b']);
  });

  it('ignores trailing lines after the first N verdicts (e.g. echoed instruction)', () => {
    const r = parseTableYesnoResponse('yes\nno\nOutput the verdict row:', ['a', 'b']);
    expect(r.shouldHide).toBe(true);
    expect(r.matches).toEqual(['a']);
  });

  it('case-insensitive on verdicts', () => {
    const r = parseTableYesnoResponse('YES\nNo', ['a', 'b']);
    expect(r.shouldHide).toBe(true);
    expect(r.matches).toEqual(['a']);
  });
});

describe('parseTableYesnoResponse — Gemma 4 IT + iOS edge cases', () => {
  const cats = ['a', 'b'];

  it('strips Gemma 4 IT <turn|> markers', () => {
    const r = parseTableYesnoResponse('| yes | no<turn|><turn|>', cats);
    expect(r.shouldHide).toBe(true);
    expect(r.matches).toEqual(['a']);
  });

  it('strips Gemma 4 IT <|turn> markers (open-form variant)', () => {
    const r = parseTableYesnoResponse('| yes | no<|turn>', cats);
    expect(r.shouldHide).toBe(true);
    expect(r.matches).toEqual(['a']);
  });

  it('skips a preamble line and uses the first line with a pipe', () => {
    const r = parseTableYesnoResponse('Sure! Here are the verdicts:\n| yes | no', cats);
    expect(r.shouldHide).toBe(true);
    expect(r.matches).toEqual(['a']);
  });

  it('is case-insensitive on verdicts', () => {
    const r = parseTableYesnoResponse('| Yes | NO ', cats);
    expect(r.shouldHide).toBe(true);
    expect(r.matches).toEqual(['a']);
  });

  it('accepts a bare yes/no with trailing punctuation for one category', () => {
    expect(parseTableYesnoResponse('Yes.', ['only']).matches).toEqual(['only']);
    expect(parseTableYesnoResponse('No!', ['only']).matches).toEqual([]);
  });

  it('accepts a bare yes/no with filler text after for one category', () => {
    const r = parseTableYesnoResponse('Yes, this post matches.', ['only']);
    expect(r.matches).toEqual(['only']);
  });

  it('still fails when no pipe is present and there are multiple categories', () => {
    const r = parseTableYesnoResponse('yes', ['a', 'b']);
    expect(r.shouldHide).toBe(false);
    expect(r.matches).toEqual([]);
  });

  it('still fails on a non-yes/no first token for a single category', () => {
    const r = parseTableYesnoResponse('maybe', ['only']);
    expect(r.shouldHide).toBe(false);
    expect(r.matches).toEqual([]);
  });
});
