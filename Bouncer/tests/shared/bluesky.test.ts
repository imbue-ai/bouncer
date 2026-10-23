import { describe, it, expect } from 'vitest';
import {
  bskyPostUrl,
  facetsToLinks,
  formatCount,
  formatRelativeTime,
  isInjectableRawPost,
  normalizeTopic,
  rawMedia,
  type RawPostView,
} from '../../src/shared/bluesky.js';

function raw(overrides: Partial<RawPostView> = {}): RawPostView {
  return {
    uri: 'at://did:plc:abc/app.bsky.feed.post/3kxyz',
    author: { did: 'did:plc:abc', handle: 'alice.bsky.social' },
    record: { text: 'A perfectly ordinary post about woodworking.' },
    ...overrides,
  };
}

describe('bskyPostUrl', () => {
  it('builds a bsky.app permalink from the record key', () => {
    expect(bskyPostUrl('at://did:plc:abc/app.bsky.feed.post/3kxyz', 'alice.bsky.social'))
      .toBe('https://bsky.app/profile/alice.bsky.social/post/3kxyz');
  });
});

describe('isInjectableRawPost', () => {
  it('accepts a plain top-level post', () => {
    expect(isInjectableRawPost(raw())).toBe(true);
  });
  it('rejects replies', () => {
    expect(isInjectableRawPost(raw({ record: { text: 'long enough reply text here', reply: {} } }))).toBe(false);
  });
  it('rejects adult or moderation-labeled posts and authors', () => {
    expect(isInjectableRawPost(raw({ labels: [{ val: 'porn' }] }))).toBe(false);
    expect(isInjectableRawPost(raw({ author: { did: 'd', handle: 'h', labels: [{ val: '!hide' }] } }))).toBe(false);
  });
  it('rejects very short text-only posts but keeps short posts with media', () => {
    expect(isInjectableRawPost(raw({ record: { text: 'lol' } }))).toBe(false);
    expect(isInjectableRawPost(raw({ record: { text: 'lol' }, embed: { $type: 'app.bsky.embed.images#view', images: [] } }))).toBe(true);
  });
});

describe('facetsToLinks', () => {
  it('converts UTF-8 byte offsets to UTF-16 offsets past multi-byte characters', () => {
    const text = 'café 🎉 see example.com now';
    const enc = new TextEncoder();
    const byteStart = enc.encode('café 🎉 see ').length;
    const byteEnd = byteStart + enc.encode('example.com').length;
    const links = facetsToLinks(text, [{
      index: { byteStart, byteEnd },
      features: [{ $type: 'app.bsky.richtext.facet#link', uri: 'https://example.com' }],
    }]);
    expect(links).toHaveLength(1);
    expect(text.slice(links[0].start, links[0].end)).toBe('example.com');
    expect(links[0].href).toBe('https://example.com');
  });
  it('maps mentions and tags to bsky.app and drops non-https links', () => {
    const links = facetsToLinks('@bob #wood bad', [
      { index: { byteStart: 0, byteEnd: 4 }, features: [{ $type: 'app.bsky.richtext.facet#mention', did: 'did:plc:bob' }] },
      { index: { byteStart: 5, byteEnd: 10 }, features: [{ $type: 'app.bsky.richtext.facet#tag', tag: 'wood' }] },
      { index: { byteStart: 11, byteEnd: 14 }, features: [{ $type: 'app.bsky.richtext.facet#link', uri: 'javascript:alert(1)' }] },
    ]);
    expect(links.map(l => l.href)).toEqual([
      'https://bsky.app/profile/did:plc:bob',
      'https://bsky.app/hashtag/wood',
    ]);
  });
  it('drops out-of-range and overlapping facets', () => {
    const links = facetsToLinks('hello world', [
      { index: { byteStart: 0, byteEnd: 5 }, features: [{ $type: 'app.bsky.richtext.facet#link', uri: 'https://a.com' }] },
      { index: { byteStart: 3, byteEnd: 8 }, features: [{ $type: 'app.bsky.richtext.facet#link', uri: 'https://b.com' }] },
      { index: { byteStart: 6, byteEnd: 99 }, features: [{ $type: 'app.bsky.richtext.facet#link', uri: 'https://c.com' }] },
    ]);
    expect(links.map(l => l.href)).toEqual(['https://a.com']);
  });
});

describe('rawMedia', () => {
  it('caps images at four', () => {
    const images = Array.from({ length: 6 }, (_, i) => ({ thumb: `https://cdn/${i}` }));
    expect(rawMedia(raw({ embed: { $type: 'app.bsky.embed.images#view', images } })).images).toHaveLength(4);
  });
  it('uses the video thumbnail and flags video', () => {
    const m = rawMedia(raw({ embed: { $type: 'app.bsky.embed.video#view', thumbnail: 'https://cdn/t', aspectRatio: { width: 16, height: 9 } } }));
    expect(m).toEqual({ images: [{ thumb: 'https://cdn/t', aspectRatio: { width: 16, height: 9 } }], isVideo: true, external: null });
  });
  it('unwraps recordWithMedia', () => {
    const m = rawMedia(raw({ embed: { $type: 'app.bsky.embed.recordWithMedia#view', media: { $type: 'app.bsky.embed.external#view', external: { uri: 'https://x.org', title: 'T' } } } }));
    expect(m.external?.uri).toBe('https://x.org');
  });
});

describe('formatting', () => {
  const now = Date.parse('2026-10-22T12:00:00Z');
  it('formats relative times like X', () => {
    expect(formatRelativeTime('2026-10-22T11:59:30Z', now)).toBe('30s');
    expect(formatRelativeTime('2026-10-22T11:15:00Z', now)).toBe('45m');
    expect(formatRelativeTime('2026-10-22T09:00:00Z', now)).toBe('3h');
    expect(formatRelativeTime('not a date', now)).toBe('');
  });
  it('formats counts like X', () => {
    expect(formatCount(0)).toBe('');
    expect(formatCount(999)).toBe('999');
    expect(formatCount(1200)).toBe('1.2K');
    expect(formatCount(34567)).toBe('34K');
    expect(formatCount(1_500_000)).toBe('1.5M');
  });
  it('normalizes topics', () => {
    expect(normalizeTopic('  wood   working ')).toBe('wood working');
    expect(normalizeTopic('x'.repeat(100))).toHaveLength(60);
  });
});
