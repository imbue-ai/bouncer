// Deterministic structural filters.
//
// Phrases like "no retweets" or "videos" aren't semantic categories — the
// adapter already knows with certainty whether a post is a repost, a quote
// tweet, or contains a video. Sending such phrases to the model invites
// overzealous matches (posts merely *about* videos get hidden). Instead:
//
//   - the content script resolves them deterministically from the post's
//     extracted attributes (no model call, zero false positives), and
//   - getSettings() excludes them from the category list the model sees.
//
// Both behaviors are gated on STRUCTURAL_FILTER_SITES: on platforms whose
// adapter doesn't report structure, the phrases keep acting as ordinary
// model-evaluated filters.

import type { PostContent } from '../types';

export type StructuralKind = 'repost' | 'quote' | 'video';

/** Sites whose adapter populates the structural PostContent attributes
 *  (isRepost / quote / hasVideo) in both extraction paths. */
export const STRUCTURAL_FILTER_SITES: ReadonlySet<string> = new Set(['twitter']);

// Pure retweets — someone resurfacing a post unchanged. Quote tweets are
// deliberately NOT in this list; they carry original commentary and get
// their own kind below.
const REPOST_TERMS = [
  'repost', 'reposts',
  'reposted tweet', 'reposted tweets',
  'reposted post', 'reposted posts',
  'retweet', 'retweets',
  'retweeted tweet', 'retweeted tweets',
  'retweeted post', 'retweeted posts',
  'rt', 'rts',
];

// Quote tweets. Bare "quote"/"quotes" is deliberately excluded — as a filter
// phrase it far more likely means inspirational-quote content than the
// quote-tweet structure.
const QUOTE_TERMS = [
  'quote tweet', 'quote tweets',
  'quote post', 'quote posts',
  'quoted tweet', 'quoted tweets',
  'quoted post', 'quoted posts',
  'quote retweet', 'quote retweets',
  'quote rt', 'quote rts',
  'qrt', 'qrts',
  'qt', 'qts',
];

const VIDEO_TERMS = [
  'video', 'videos',
  'video tweet', 'video tweets',
  'video post', 'video posts',
  'video content',
  'tweet with video', 'tweets with video', 'tweets with videos',
  'post with video', 'posts with video', 'posts with videos',
  'tweet with a video', 'tweets with a video',
  'post with a video', 'posts with a video',
];

const KIND_BY_TERM = new Map<string, StructuralKind>([
  ...REPOST_TERMS.map(t => [t, 'repost'] as const),
  ...QUOTE_TERMS.map(t => [t, 'quote'] as const),
  ...VIDEO_TERMS.map(t => [t, 'video'] as const),
]);

// "no retweets", "filter out videos", "hide all quote tweets" → the bare term.
const LEADING_VERB_RE = /^(?:please\s+)?(?:no|hide|remove|block|filter(?:\s+out)?|don'?t\s+show(?:\s+me)?)\s+/;
const LEADING_QUANTIFIER_RE = /^(?:all|any)\s+/;

function normalizePhrase(phrase: string): string {
  let p = phrase.toLowerCase().replace(/\s+/g, ' ').trim();
  p = p.replace(/[.!?]+$/, '').trim();
  p = p.replace(LEADING_VERB_RE, '');
  p = p.replace(LEADING_QUANTIFIER_RE, '');
  return p;
}

/** The structural kind a filter phrase targets, or null when the phrase is an
 *  ordinary semantic filter that must go to the model. Deliberately exact
 *  (after normalization): "crypto videos" is NOT structural — the model needs
 *  to judge the topic there. */
export function structuralFilterKind(phrase: string): StructuralKind | null {
  return KIND_BY_TERM.get(normalizePhrase(phrase)) ?? null;
}

export function postMatchesStructuralKind(kind: StructuralKind, post: PostContent): boolean {
  switch (kind) {
    case 'repost': return post.isRepost === true;
    case 'quote': return post.quote != null;
    case 'video': return post.hasVideo === true;
  }
}

/** First structural phrase the post matches, or null. Order follows the
 *  user's phrase list, mirroring how the model reports one category. */
export function findStructuralMatch(
  phrases: string[],
  post: PostContent,
): { phrase: string; kind: StructuralKind } | null {
  for (const phrase of phrases) {
    const kind = structuralFilterKind(phrase);
    if (kind !== null && postMatchesStructuralKind(kind, post)) {
      return { phrase, kind };
    }
  }
  return null;
}

/** Human-readable noun for hide reasoning, e.g. "This post is a repost". */
export const STRUCTURAL_KIND_LABELS: Record<StructuralKind, string> = {
  repost: 'a repost (retweet)',
  quote: 'a quote post',
  video: 'a video post',
};
