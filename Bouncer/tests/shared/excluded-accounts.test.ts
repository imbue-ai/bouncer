import { describe, it, expect } from 'vitest';
import {
  normalizeAccountIdentity,
  exclusionIdentity,
} from '../../src/shared/storage.js';

describe('normalizeAccountIdentity', () => {
  it('strips the leading @ and lowercases (DOM extraction path)', () => {
    expect(normalizeAccountIdentity('@GodotEngine')).toBe('godotengine');
  });

  it('leaves bare handles intact apart from case (store path userHandle)', () => {
    expect(normalizeAccountIdentity('GodotEngine')).toBe('godotengine');
  });

  it('strips YouTube\'s leading slash before the @', () => {
    expect(normalizeAccountIdentity('/@SomeChannel')).toBe('somechannel');
  });

  it('trims whitespace, including between stripped prefixes', () => {
    expect(normalizeAccountIdentity('  @handle  ')).toBe('handle');
    expect(normalizeAccountIdentity('@ handle')).toBe('handle');
  });

  it('returns empty string for empty or prefix-only input', () => {
    expect(normalizeAccountIdentity('')).toBe('');
    expect(normalizeAccountIdentity('@')).toBe('');
    expect(normalizeAccountIdentity('  ')).toBe('');
  });
});

describe('exclusionIdentity', () => {
  it('uses the handle on Twitter, matching across DOM and store extraction', () => {
    const fromDom = exclusionIdentity('twitter', { author: 'Godot Engine@godotengine · 2h', handle: '@GodotEngine' });
    const fromStore = exclusionIdentity('twitter', { author: 'Godot Engine', handle: 'godotengine' });
    expect(fromDom).toBe('godotengine');
    expect(fromStore).toBe('godotengine');
  });

  it('uses the author on LinkedIn (its handle field carries the headline)', () => {
    expect(
      exclusionIdentity('linkedin', { author: 'Jane Doe', handle: 'Software Engineer at X' })
    ).toBe('jane doe');
  });

  it('normalizes YouTube channel handles', () => {
    expect(exclusionIdentity('youtube', { author: 'Some Channel', handle: '/@SomeChannel' })).toBe('somechannel');
  });

  it('returns null when the post has no usable identity', () => {
    expect(exclusionIdentity('twitter', { author: 'Name only', handle: '' })).toBeNull();
    expect(exclusionIdentity('linkedin', { author: '', handle: 'Headline' })).toBeNull();
    expect(exclusionIdentity('twitter', {})).toBeNull();
  });
});
