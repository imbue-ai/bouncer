import { describe, it, expect } from 'vitest';
import type { PostContent } from '../../src/types';
import {
  structuralFilterKind,
  postMatchesStructuralKind,
  findStructuralMatch,
  STRUCTURAL_FILTER_SITES,
} from '../../src/shared/structural-filters.js';

const basePost: PostContent = {
  text: 'Hello world',
  author: 'Alice',
  handle: '@alice',
  avatarUrl: null,
  timeText: null,
  textHtml: '',
  quote: null,
  postUrl: null,
  imageUrls: [],
  hasMediaContainer: false,
  isRepost: false,
  hasVideo: false,
};

const quoteContent = {
  textHtml: 'quoted', author: 'Bob', handle: '@bob', avatarUrl: null, timeText: null,
};

describe('structuralFilterKind', () => {
  it('recognizes repost/retweet terms in post and tweet verbiage', () => {
    for (const phrase of [
      'repost', 'reposts', 'retweet', 'retweets', 'rt', 'rts',
      'reposted tweets', 'reposted posts', 'retweeted tweets', 'retweeted posts',
    ]) {
      expect(structuralFilterKind(phrase), phrase).toBe('repost');
    }
  });

  it('recognizes quote-tweet terms as a distinct kind from retweets', () => {
    for (const phrase of [
      'quote tweet', 'quote tweets', 'quote post', 'quote posts',
      'quoted tweets', 'quoted posts', 'quote retweets',
      'qrt', 'qrts', 'qt', 'qts', 'no QTs',
    ]) {
      expect(structuralFilterKind(phrase), phrase).toBe('quote');
    }
  });

  it('recognizes video terms in post and tweet verbiage', () => {
    for (const phrase of [
      'video', 'videos', 'video tweets', 'video posts',
      'tweets with videos', 'posts with videos', 'posts with a video',
    ]) {
      expect(structuralFilterKind(phrase), phrase).toBe('video');
    }
  });

  it('strips leading filter verbs and quantifiers', () => {
    expect(structuralFilterKind('no retweets')).toBe('repost');
    expect(structuralFilterKind('filter out videos')).toBe('video');
    expect(structuralFilterKind('hide all quote tweets')).toBe('quote');
    expect(structuralFilterKind("don't show me reposts")).toBe('repost');
    expect(structuralFilterKind('block RTs')).toBe('repost');
    expect(structuralFilterKind('  Remove  Video  Posts!  ')).toBe('video');
  });

  it('leaves semantic phrases to the model', () => {
    for (const phrase of [
      'crypto', 'engagement bait', 'crypto videos', 'videos about cooking',
      'reposts of old memes', 'people quoting elon',
      // bare "quotes" more likely means inspirational-quote content
      'quotes', 'quote',
    ]) {
      expect(structuralFilterKind(phrase), phrase).toBe(null);
    }
  });
});

describe('postMatchesStructuralKind', () => {
  it('matches repost only when isRepost is true', () => {
    expect(postMatchesStructuralKind('repost', basePost)).toBe(false);
    expect(postMatchesStructuralKind('repost', { ...basePost, isRepost: true })).toBe(true);
  });

  it('matches quote only when a quote is present', () => {
    expect(postMatchesStructuralKind('quote', basePost)).toBe(false);
    expect(postMatchesStructuralKind('quote', { ...basePost, quote: quoteContent })).toBe(true);
  });

  it('matches video only when hasVideo is true', () => {
    expect(postMatchesStructuralKind('video', basePost)).toBe(false);
    expect(postMatchesStructuralKind('video', { ...basePost, hasVideo: true })).toBe(true);
  });

  it('does not match when flags are undefined (adapter without detection)', () => {
    const flagless: PostContent = { ...basePost };
    delete flagless.isRepost;
    delete flagless.hasVideo;
    expect(postMatchesStructuralKind('repost', flagless)).toBe(false);
    expect(postMatchesStructuralKind('video', flagless)).toBe(false);
  });
});

describe('findStructuralMatch', () => {
  it('returns the first structural phrase the post matches', () => {
    const match = findStructuralMatch(
      ['crypto', 'no retweets', 'videos'],
      { ...basePost, isRepost: true, hasVideo: true },
    );
    expect(match).toEqual({ phrase: 'no retweets', kind: 'repost' });
  });

  it('returns null when no structural phrase matches the post', () => {
    expect(findStructuralMatch(['no retweets', 'videos'], basePost)).toBe(null);
    expect(findStructuralMatch(['crypto'], { ...basePost, isRepost: true })).toBe(null);
  });

  it('a retweet does not match a quote-tweet filter and vice versa', () => {
    const retweet = { ...basePost, isRepost: true };
    const quoteTweet = { ...basePost, quote: quoteContent };
    expect(findStructuralMatch(['quote tweets'], retweet)).toBe(null);
    expect(findStructuralMatch(['retweets'], quoteTweet)).toBe(null);
    expect(findStructuralMatch(['retweets'], retweet)?.kind).toBe('repost');
    expect(findStructuralMatch(['quote tweets'], quoteTweet)?.kind).toBe('quote');
  });
});

describe('STRUCTURAL_FILTER_SITES', () => {
  it('covers twitter only — other adapters do not report structure', () => {
    expect(STRUCTURAL_FILTER_SITES.has('twitter')).toBe(true);
    expect(STRUCTURAL_FILTER_SITES.has('youtube')).toBe(false);
    expect(STRUCTURAL_FILTER_SITES.has('linkedin')).toBe(false);
  });
});
