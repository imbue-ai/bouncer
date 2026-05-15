// Filter-pack share-code encoding. Pack → bytes → base64url → prefixed with
// `bncr2_` so tweet text can be scanned for it deterministically. v2 of the
// format is `bncr2_`; bump the prefix if the payload shape ever changes.
//
// Wire format (after the prefix and base64url decode):
//   [byte 0]   method selector
//   [byte 1+]  payload
//
// Methods:
//   0x00 RAW   payload is UTF-8 phrases joined by '\n'
//   0x01 DICT  token stream against a static dictionary (see DICT below)
//
// Token stream (method 0x01) — each token is one byte unless escaped:
//   0x00         phrase separator
//   0x01..0xFE   dict entry at index (byteValue - 1), so dict[0..253]
//   0xFF         literal escape: next byte = UTF-8 length L (1..255), then L bytes
// Within a phrase, consecutive tokens decode joined by a single space.
//
// On encode we try both methods and pick whichever produces a shorter base64url
// body. For phrases made of common English/topic words the dict beats the raw
// list of phrases; for everything else the raw method is at most a few bytes
// over the original text.

export const FILTER_PACK_CODE_PREFIX = 'bncr2_';
export const FILTER_PACK_CODE_REGEX = /bncr2_[A-Za-z0-9_-]+/g;

/** Landing page that hosts the share URL. The bncr2_ code rides in the URL
 *  fragment so it never hits the server — the importing extension extracts it
 *  client-side from the rendered <a>. */
export const FILTER_PACK_SHARE_URL_BASE = 'imbue.com/product/bouncer';

/** Match an imbue.com bouncer share URL anywhere in a string. Captures the
 *  bncr2_ code so callers can pass it straight to decodeFilterPackCode. The
 *  scheme is optional because Twitter's link rendering sometimes hides it in
 *  an aria-hidden span and sometimes drops it entirely. */
export const FILTER_PACK_SHARE_URL_REGEX = /(?:https?:\/\/)?imbue\.com\/product\/bouncer#(bncr2_[A-Za-z0-9_-]+)/;

/** Build the share URL that gets pasted into the tweet caption. */
export function buildFilterPackShareUrl(code: string): string {
  return `https://${FILTER_PACK_SHARE_URL_BASE}#${code}`;
}

export interface SharedFilterPack {
  /** Phrase list in display order. Pack names are deliberately not part of the
   *  shared payload — the importer names the pack locally. */
  phrases: string[];
}

const METHOD_RAW = 0x00;
const METHOD_DICT = 0x01;

const TOKEN_PHRASE_SEP = 0x00;
const TOKEN_LITERAL = 0xff;
const DICT_INDEX_OFFSET = 1; // dict[i] is encoded as byte (i + 1)
const MAX_DICT_ENTRIES = TOKEN_LITERAL - DICT_INDEX_OFFSET; // 254

// Static dictionary, v2. APPEND-ONLY once the share format ships — reordering
// or removing entries shifts every existing index and breaks codes already in
// the wild. New entries go at the end, up to MAX_DICT_ENTRIES total.
//
// Curated for filter phrases users typically write: glue words plus topic
// terms common in feed-cleaning packs (AI/crypto, engagement-bait, politics,
// adult/gambling, sports, etc.). Multi-word entries are tokenized greedily so
// "engagement bait" collapses to a single byte.
const DICT: readonly string[] = Object.freeze([
  // 0..29 — glue words (articles, prepositions, common particles). Pruned of
  // entries that almost never show up inside a filter phrase (interrogatives,
  // most pronouns, modal "very/too/just"). Filter phrases are noun-y; we want
  // bytes for content words, not every English stopword.
  'the', 'a', 'an', 'and', 'or', 'of', 'in', 'on', 'at', 'to',
  'for', 'with', 'from', 'by', 'about', 'is', 'are', 'was', 'be', 'this',
  'that', 'no', 'not', 'so', 'all', 'any', 'some', 'most', 'more', 'who',
  // 30..39 — keepable pronouns + person words
  'I', 'you', 'me', 'my', 'your', 'people', 'person', 'man', 'woman', 'kids',
  // 40..79 — AI / tech / online
  'AI', 'ai', 'NFT', 'nft', 'crypto', 'web3', 'blockchain', 'token', 'coin', 'defi',
  'DAO', 'LLM', 'model', 'machine', 'learning', 'generated', 'generation', 'image', 'images', 'photo',
  'photos', 'video', 'videos', 'art', 'artwork', 'tech', 'software', 'startup', 'app', 'apps',
  'site', 'website', 'product', 'coding', 'programming', 'developer', 'design', 'designer', 'gaming', 'gamer',
  // 80..109 — engagement / spam / promo / slop
  'engagement', 'bait', 'farming', 'rage', 'spam', 'shilling', 'shill', 'scam', 'scammer', 'promotion',
  'promoting', 'promo', 'ad', 'ads', 'advertisement', 'marketing', 'sponsored', 'affiliate', 'MLM', 'slop',
  'recycled', 'repost', 'reposts', 'meme', 'memes', 'thread', 'threads', 'reply', 'replies', 'influencer',
  // 110..139 — discourse / posts / vibes
  'tweet', 'tweets', 'post', 'posts', 'content', 'feed', 'take', 'takes', 'opinion', 'opinions',
  'discourse', 'argument', 'fight', 'cope', 'seethe', 'cringe', 'based', 'doom', 'doomer', 'hot',
  'good', 'bad', 'best', 'snark', 'smug', 'virtue', 'signaling', 'gatekeeping', 'humblebrag', 'flex',
  // 140..169 — emotion / behavior / personality
  'outrage', 'outraged', 'complaining', 'whining', 'preaching', 'moralizing', 'elitism', 'elitist', 'pretentious', 'bro',
  'bros', 'tradwife', 'narcissism', 'narcissist', 'ego', 'aesthetic', 'vibe', 'vibes', 'selfie', 'selfies',
  'fashion', 'luxury', 'wealth', 'food', 'cooking', 'recipe', 'travel', 'music', 'song', 'songs',
  // 170..199 — politics
  'politics', 'political', 'election', 'campaign', 'left', 'right', 'wing', 'liberal', 'conservative', 'democrat',
  'democrats', 'republican', 'republicans', 'MAGA', 'Trump', 'Biden', 'GOP', 'partisan', 'culture', 'war',
  'wars', 'woke', 'wokeness', 'protest', 'Israel', 'Palestine', 'Ukraine', 'Russia', 'racist', 'sexist',
  // 200..219 — adult / gambling / sports
  'OnlyFans', 'porn', 'NSFW', 'nsfw', 'gambling', 'betting', 'casino', 'sports', 'football', 'soccer',
  'basketball', 'baseball', 'hockey', 'tennis', 'NBA', 'NFL', 'MLB', 'olympics', 'celebrity', 'gossip',
  // 220..239 — entertainment / lifestyle / health
  'anime', 'weeb', 'gooner', 'kpop', 'drama', 'movie', 'movies', 'film', 'TV', 'streamer',
  'podcast', 'youtube', 'weight', 'loss', 'diet', 'fitness', 'gym', 'workout', 'anti', 'vax',
  // 240..253 — health / personal / multi-word bigrams (every byte saved here)
  'vaccine', 'covid', 'news', 'media', 'dating', 'breakup', 'wedding', 'parenting', 'religion', 'astrology',
  'engagement bait', 'rage bait', 'AI generated', 'AI slop',
]);

if (DICT.length > MAX_DICT_ENTRIES) {
  // Catch dictionary overflow at module load instead of at first encode call.
  throw new Error(`share-encoding DICT has ${DICT.length} entries, max ${MAX_DICT_ENTRIES}`);
}

// Build lookup map and the longest n-gram word count once, lazily. Lazy because
// importing the module shouldn't pay this cost for callers that never encode.
let dictLookup: Map<string, number> | null = null;
let dictMaxNgram = 0;

function ensureDictIndex(): { lookup: Map<string, number>; maxNgram: number } {
  if (dictLookup) return { lookup: dictLookup, maxNgram: dictMaxNgram };
  const lookup = new Map<string, number>();
  let maxNgram = 1;
  for (let i = 0; i < DICT.length; i++) {
    const entry = DICT[i];
    lookup.set(entry, i);
    const wc = entry.split(' ').length;
    if (wc > maxNgram) maxNgram = wc;
  }
  dictLookup = lookup;
  dictMaxNgram = maxNgram;
  return { lookup, maxNgram };
}

// ---------- base64url ----------

function base64urlEncode(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---------- raw method (0x00) ----------

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

function encodeRaw(phrases: string[]): Uint8Array {
  return utf8Encoder.encode(phrases.join('\n'));
}

function decodeRaw(payload: Uint8Array): string[] {
  const text = utf8Decoder.decode(payload);
  // An empty payload should decode to [], not [""]. A pack with one empty
  // phrase doesn't make sense to share, so we don't try to preserve it.
  if (text.length === 0) return [];
  return text.split('\n');
}

// ---------- dict method (0x01) ----------

function encodeDict(phrases: string[]): Uint8Array {
  const { lookup, maxNgram } = ensureDictIndex();
  const out: number[] = [];

  for (let p = 0; p < phrases.length; p++) {
    if (p > 0) out.push(TOKEN_PHRASE_SEP);

    const words = phrases[p].split(/\s+/).filter(Boolean);
    let i = 0;
    while (i < words.length) {
      // Greedy longest-n-gram match against the dict. Multi-word dict entries
      // collapse to a single byte (e.g. "engagement bait" → 1 byte instead of 2).
      let matchedIdx = -1;
      let matchedLen = 0;
      const maxLen = Math.min(maxNgram, words.length - i);
      for (let len = maxLen; len >= 1; len--) {
        const candidate = len === 1 ? words[i] : words.slice(i, i + len).join(' ');
        const idx = lookup.get(candidate);
        if (idx !== undefined) {
          matchedIdx = idx;
          matchedLen = len;
          break;
        }
      }
      if (matchedIdx >= 0) {
        out.push(matchedIdx + DICT_INDEX_OFFSET);
        i += matchedLen;
      } else {
        // Literal: encode the single word as UTF-8 with a 1-byte length prefix.
        // Single words above 255 UTF-8 bytes are vanishingly rare for filter
        // phrases; if it ever happens we just fall back to RAW (which always
        // works) since the encoder picks the shorter result.
        const wordBytes = utf8Encoder.encode(words[i]);
        if (wordBytes.length === 0 || wordBytes.length > 255) {
          // Sentinel that makes encodeDict bail; callers see this as "DICT not
          // viable" by getting a payload that base64s longer than RAW (i.e.,
          // we just emit nothing and let RAW win). Easier: throw and let the
          // top-level encoder catch.
          throw new Error('dict-method literal too long');
        }
        out.push(TOKEN_LITERAL, wordBytes.length, ...wordBytes);
        i += 1;
      }
    }
  }
  return Uint8Array.from(out);
}

function decodeDict(payload: Uint8Array): string[] | null {
  const phrases: string[] = [];
  let current: string[] = [];
  const flush = () => {
    phrases.push(current.join(' '));
    current = [];
  };

  let i = 0;
  while (i < payload.length) {
    const b = payload[i];
    if (b === TOKEN_PHRASE_SEP) {
      flush();
      i += 1;
    } else if (b === TOKEN_LITERAL) {
      if (i + 1 >= payload.length) return null;
      const len = payload[i + 1];
      const start = i + 2;
      const end = start + len;
      if (end > payload.length) return null;
      let text: string;
      try {
        text = utf8Decoder.decode(payload.subarray(start, end));
      } catch {
        return null;
      }
      current.push(text);
      i = end;
    } else {
      const idx = b - DICT_INDEX_OFFSET;
      if (idx < 0 || idx >= DICT.length) return null;
      current.push(DICT[idx]);
      i += 1;
    }
  }
  // Flush the final phrase. Empty payload means empty list — drop the trailing
  // empty phrase that a naive flush would otherwise produce.
  if (payload.length === 0) return [];
  flush();
  return phrases;
}

// ---------- public API ----------

// Collapse internal whitespace and drop empties. Both methods rely on phrases
// having no embedded newlines (RAW uses '\n' as the separator) and the dict
// tokenizer splits on /\s+/ anyway; doing it once up front keeps both methods
// honest and makes round-tripping deterministic.
function normalizePhrases(phrases: string[]): string[] {
  const out: string[] = [];
  for (const p of phrases) {
    const cleaned = p.split(/\s+/).filter(Boolean).join(' ');
    if (cleaned) out.push(cleaned);
  }
  return out;
}

/** Encode a pack into a self-contained tweet-safe token. Tries all available
 *  methods and picks the one that produces the shortest base64url body, so we
 *  never come out worse than a plain UTF-8 dump of the phrases.
 *
 *  Returns a Promise even though encoding is currently sync — call sites use
 *  `await`/`.then()` and we want headroom to swap in async compression later
 *  without churning every caller. */
// eslint-disable-next-line @typescript-eslint/require-await
export async function encodeFilterPackCode(pack: SharedFilterPack): Promise<string> {
  const phrases = normalizePhrases(pack.phrases);
  const candidates: Uint8Array[] = [];

  const rawBody = encodeRaw(phrases);
  candidates.push(prefixMethod(METHOD_RAW, rawBody));

  try {
    const dictBody = encodeDict(phrases);
    candidates.push(prefixMethod(METHOD_DICT, dictBody));
  } catch {
    // Dict method not viable for this input (e.g. a freakishly long single
    // word). RAW is always available, so we just skip the dict candidate.
  }

  let best = candidates[0];
  for (let i = 1; i < candidates.length; i++) {
    if (candidates[i].length < best.length) best = candidates[i];
  }
  return FILTER_PACK_CODE_PREFIX + base64urlEncode(best);
}

function prefixMethod(method: number, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(body.length + 1);
  out[0] = method;
  out.set(body, 1);
  return out;
}

/** Parse a share code. Returns null on any malformed or non-decoding input —
 *  we never want a broken code to crash the tweet scanner. */
// eslint-disable-next-line @typescript-eslint/require-await
export async function decodeFilterPackCode(code: string): Promise<SharedFilterPack | null> {
  if (!code.startsWith(FILTER_PACK_CODE_PREFIX)) return null;
  const body = code.slice(FILTER_PACK_CODE_PREFIX.length);
  let bytes: Uint8Array;
  try {
    bytes = base64urlDecode(body);
  } catch {
    return null;
  }
  if (bytes.length === 0) return null;
  const method = bytes[0];
  const payload = bytes.subarray(1);
  let phrases: string[] | null;
  if (method === METHOD_RAW) {
    try { phrases = decodeRaw(payload); } catch { return null; }
  } else if (method === METHOD_DICT) {
    phrases = decodeDict(payload);
  } else {
    return null;
  }
  if (!phrases) return null;
  return { phrases };
}
