import { describe, it, expect } from 'vitest';
import {
  buildAPIMessages,
  buildLocalUserMessage,
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
    const texts = userContent.filter((c: ContentPart) => c.type === 'text').map((c: ContentPart) => c.text).join(' ');
    expect(texts).toContain('"sports"');
    expect(texts).toContain('"politics"');
  });

  it('includes post text', () => {
    const messages = buildAPIMessages(postData, bannedCategories);
    const userContent = messages[1].content as ContentPart[];
    const texts = userContent.filter((c: ContentPart) => c.type === 'text').map((c: ContentPart) => c.text).join(' ');
    expect(texts).toContain('The Lakers won last night!');
  });

  it('interleaves images with post', () => {
    const postWithImages = { text: 'Look at this!', imageUrls: ['http://img1.jpg', 'http://img2.jpg'] };
    const messages = buildAPIMessages(postWithImages, bannedCategories);
    const userContent = messages[1].content as ContentPart[];

    const imageEntries = userContent.filter((c: ContentPart) => c.type === 'image_url');
    expect(imageEntries).toHaveLength(2);
    expect(imageEntries[0].image_url!.url).toBe('http://img1.jpg');
    expect(imageEntries[1].image_url!.url).toBe('http://img2.jpg');
  });

  it('includes classify instruction', () => {
    const messages = buildAPIMessages(postData, bannedCategories);
    const userContent = messages[1].content as ContentPart[];
    const lastText = userContent[userContent.length - 1].text;
    expect(lastText).toContain('Classify the post');
  });
});

// ==================== buildLocalUserMessage ====================

describe('buildLocalUserMessage', () => {
  it('includes categories in filter_categories XML tag', () => {
    const msg = buildLocalUserMessage('Hello world', ['sports', 'politics'], false);
    expect(msg).toContain('<filter_categories>sports, politics</filter_categories>');
  });

  it('includes post text in post XML tag', () => {
    const msg = buildLocalUserMessage('The Lakers won!', ['sports'], false);
    expect(msg).toContain('<post>The Lakers won!</post>');
  });

  it('mentions images when hasImages is true', () => {
    const msg = buildLocalUserMessage('Look at this', ['sports'], true);
    expect(msg).toContain('images');
  });

  it('does not mention images when hasImages is false', () => {
    const msg = buildLocalUserMessage('Look at this', ['sports'], false);
    expect(msg).not.toContain('images');
  });
});
