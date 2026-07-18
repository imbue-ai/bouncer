// Heuristic, in-extension content-type classifier for the usage summary.
//
// No AI and no network: it matches lowercased post text against keyword buckets
// so every post — including ones the AI did NOT filter — can be bucketed for the
// "not filtered" pie. This works with any backend (including the default Imbue
// one, which can't return a content tag). Accuracy is deliberately rough; it's a
// directional breakdown, not a labelled dataset.
//
// Vocabulary = the user's own filter topics (checked first, so "crypto content
// that slipped past your filter" surfaces as `crypto`) + a fixed content-type
// taxonomy + a catch-all `Other`.

export const OTHER_CATEGORY = 'Other';

interface Bucket {
  category: string;
  keywords: string[];
}

// Fixed content-type taxonomy, checked in order — first bucket with a keyword
// hit wins, so more specific/topical buckets come before generic ones.
// Multi-word keywords (with a space) are matched as substrings; single words
// are matched against whole-word tokens so "ai" doesn't fire inside "said".
const CONTENT_BUCKETS: Bucket[] = [
  { category: 'Crypto', keywords: ['crypto', 'bitcoin', 'ethereum', 'blockchain', 'nft', 'defi', 'altcoin', 'web3', 'btc', 'eth', 'memecoin'] },
  { category: 'Politics', keywords: ['election', 'senate', 'congress', 'president', 'vote', 'government', 'policy', 'democrat', 'republican', 'parliament', 'minister', 'campaign', 'politics', 'political'] },
  { category: 'Sports', keywords: ['game', 'match', 'season', 'playoff', 'coach', 'championship', 'league', 'tournament', 'nba', 'nfl', 'soccer', 'football', 'basketball', 'baseball', 'goal', 'touchdown'] },
  { category: 'Science & Health', keywords: ['study', 'research', 'health', 'disease', 'vaccine', 'climate', 'science', 'medical', 'doctor', 'brain', 'nasa', 'space', 'physics', 'biology'] },
  { category: 'Entertainment', keywords: ['movie', 'film', 'music', 'album', 'celebrity', 'netflix', 'trailer', 'actor', 'singer', 'concert', 'episode', 'season finale', 'box office'] },
  { category: 'Tech', keywords: ['software', 'startup', 'coding', 'developer', 'programming', 'gadget', 'iphone', 'android', 'chip', 'algorithm', 'github', 'gpu', 'llm', 'open source', 'ai'] },
  { category: 'Business & Finance', keywords: ['market', 'stock', 'economy', 'earnings', 'revenue', 'investor', 'ipo', 'inflation', 'ceo', 'business', 'finance', 'funding', 'valuation', 'layoffs'] },
  { category: 'Humor & Memes', keywords: ['lol', 'lmao', 'meme', 'joke', 'funny', 'haha', 'banter', 'shitpost'] },
  { category: 'Promotional', keywords: ['sale', 'discount', 'promo', 'subscribe', 'giveaway', 'sponsored', 'link in bio', 'sign up', 'limited time', 'buy now', 'coupon'] },
  { category: 'News', keywords: ['breaking', 'report', 'news', 'update', 'announced', 'statement', 'according', 'confirms', 'reuters'] },
];

// English stop words dropped when turning a filter phrase into keywords.
const STOP_WORDS = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'about', 'your', 'you']);

function normalize(text: string): { tokens: Set<string>; normalized: string } {
  const normalized = text.toLowerCase();
  const tokens = new Set(normalized.match(/[a-z0-9']+/g) ?? []);
  return { tokens, normalized };
}

function bucketMatches(keywords: string[], tokens: Set<string>, normalized: string): boolean {
  for (const kw of keywords) {
    if (kw.includes(' ')) {
      if (normalized.includes(kw)) return true;
    } else if (tokens.has(kw)) {
      return true;
    }
  }
  return false;
}

// Turn a user filter phrase into a keyword bucket. Significant words (len ≥ 3,
// not a stop word) become token keywords; the whole phrase is also kept as a
// substring keyword so multi-word topics still match.
function extraBucket(phrase: string): Bucket {
  const lower = phrase.toLowerCase().trim();
  const words = lower.split(/\s+/).filter((w) => w.length >= 3 && !STOP_WORDS.has(w));
  const keywords = words.length > 0 ? [...words] : [lower].filter(Boolean);
  if (lower.includes(' ')) keywords.push(lower);
  return { category: phrase, keywords };
}

/**
 * Classify a post's text into a content category. `extraCategories` are the
 * user's current filter topics; they're checked before the fixed taxonomy so
 * Bouncer's own categories take precedence. Returns `Other` when nothing hits.
 */
export function classifyContent(text: string | null | undefined, extraCategories: string[] = []): string {
  if (!text || !text.trim()) return OTHER_CATEGORY;
  const { tokens, normalized } = normalize(text);

  for (const phrase of extraCategories) {
    if (!phrase || !phrase.trim()) continue;
    const bucket = extraBucket(phrase);
    if (bucket.keywords.length > 0 && bucketMatches(bucket.keywords, tokens, normalized)) {
      return bucket.category;
    }
  }

  for (const bucket of CONTENT_BUCKETS) {
    if (bucketMatches(bucket.keywords, tokens, normalized)) return bucket.category;
  }

  return OTHER_CATEGORY;
}
