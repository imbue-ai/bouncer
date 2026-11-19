// How often "See more" posts go into the X timeline, and which topic each
// comes from, learned from how the user treats them.
//
// Engagement: an injected post the user lingers on (relative to how long
// they spend on ordinary tweets) or opens counts toward its topic; one they
// scroll straight past counts against it. Each topic keeps a Beta(a, b)
// score of that, as does the timeline as a whole.
//  - Rate: the overall score sets the share of the timeline between
//    PACING_FLOOR_SHARE and the user's ceiling (the popup's slider).
//  - Topic: each post goes to the topic whose score, sampled from its Beta,
//    is highest (Thompson sampling), so liked topics win more often and the
//    others still get the occasional chance to recover.
//  - Intent: adding a topic is the clearest "more of this" there is; it
//    lifts the rate to the ceiling, fading with a half-life of
//    BOOST_HALF_LIFE_TWEETS.
// Gaps are randomized around the target, so the posts don't fall into a
// visible every-Nth pattern.
//
// Pure functions only; bluesky-see-more.ts owns the state and the timing.

export const SEE_MORE_PACING_KEY = 'seeMorePacing_twitter';

/** Never fewer than one in this many tweets, however little they engage
 *  (only a removed topic means "none"). */
export const PACING_FLOOR_EVERY = 12;
export const PACING_FLOOR_SHARE = 1 / PACING_FLOOR_EVERY;
/** Fewest tweets between two injected posts' slots. */
export const MIN_GAP = 2;
/** Gaps vary by up to this fraction either side of the target. */
const GAP_JITTER = 0.35;
export const BOOST_HALF_LIFE_TWEETS = 15;
/** Older outcomes fade by this much per new one, so the score follows
 *  what the user wants now: about the last 50 posts count. */
const DECAY = 0.98;

/** Pseudo-counts a score starts from: a neutral guess for the timeline,
 *  an optimistic one for a just-added topic. */
export const GLOBAL_PRIOR: Beta = { a: 2, b: 2 };
export const TOPIC_PRIOR: Beta = { a: 2, b: 1 };

export interface Beta { a: number; b: number }

export interface PacingState {
  global: Beta;
  topics: Record<string, Beta>;
}

export function emptyPacing(): PacingState {
  return { global: { ...GLOBAL_PRIOR }, topics: {} };
}

/** A stored state, or a fresh one if it's missing or malformed. */
export function parsePacing(v: unknown): PacingState {
  const out = emptyPacing();
  if (!v || typeof v !== 'object') return out;
  const raw = v as { global?: unknown; topics?: unknown };
  const beta = (x: unknown, prior: Beta): Beta | null => {
    if (!x || typeof x !== 'object') return null;
    const { a, b } = x as { a?: unknown; b?: unknown };
    if (typeof a !== 'number' || typeof b !== 'number' || !Number.isFinite(a) || !Number.isFinite(b)) return null;
    return { a: Math.max(prior.a, a), b: Math.max(prior.b, b) };
  };
  out.global = beta(raw.global, GLOBAL_PRIOR) ?? out.global;
  if (raw.topics && typeof raw.topics === 'object') {
    for (const [t, s] of Object.entries(raw.topics)) {
      const parsed = beta(s, TOPIC_PRIOR);
      if (parsed) out.topics[t] = parsed;
    }
  }
  return out;
}

export function meanOf(s: Beta): number {
  return s.a / (s.a + s.b);
}

/** Fold an outcome in [0, 1] (0: skipped, 1: engaged) into a score, after
 *  fading what's already there toward its prior. */
export function updateBeta(s: Beta, prior: Beta, engagement: number): Beta {
  const e = Math.min(1, Math.max(0, engagement));
  return {
    a: prior.a + (s.a - prior.a) * DECAY + e,
    b: prior.b + (s.b - prior.b) * DECAY + (1 - e),
  };
}

export function recordOutcome(state: PacingState, topic: string, engagement: number): PacingState {
  return {
    global: updateBeta(state.global, GLOBAL_PRIOR, engagement),
    topics: { ...state.topics, [topic]: updateBeta(state.topics[topic] ?? TOPIC_PRIOR, TOPIC_PRIOR, engagement) },
  };
}

/** How much the user engaged with an injected post, from 0 (scrolled right
 *  past) to 1 (read it at length): its time on screen against their
 *  median for tweets, both per pixel scrolled past (see dwellRate). Half
 *  as long → 0, the same → 0.5, twice as long → 1. */
export function engagementFromDwell(postRate: number, medianTweetRate: number): number {
  if (!(postRate > 0) || !(medianTweetRate > 0)) return 0;
  return Math.min(1, Math.max(0, (Math.log2(postRate / medianTweetRate) + 1) / 2));
}

/** Time on screen per pixel the element and the viewport scroll past each
 *  other: at a steady scroll speed v, anything is on screen for
 *  (height + viewport) / v, so this is 1/v whatever the post's height —
 *  a tall post isn't "engaging" just for being tall. */
export function dwellRate(ms: number, height: number, viewport: number): number {
  return ms / Math.max(1, height + viewport);
}

export function median(values: readonly number[]): number {
  if (!values.length) return NaN;
  const sorted = [...values].sort((x, y) => x - y);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** The share of the timeline to give injected posts: between the floor and
 *  `ceilingEvery` (the slider's "1 in N") by engagement, then raised toward
 *  the ceiling by `boost` (0–1, a just-added topic). */
export function targetShare(engagement: number, ceilingEvery: number, boost: number): number {
  const ceiling = 1 / Math.max(1, ceilingEvery);
  const floor = Math.min(PACING_FLOOR_SHARE, ceiling);
  const e = Math.min(1, Math.max(0, engagement));
  const share = floor + (ceiling - floor) * e;
  const b = Math.min(1, Math.max(0, boost));
  return share + (ceiling - share) * b;
}

/** Tweets to count before the next slot: around 1 / share, jittered, never
 *  closer than the ceiling allows. */
export function nextGap(share: number, ceilingEvery: number, rng: () => number = Math.random): number {
  const mean = 1 / Math.max(1e-6, share);
  const jittered = mean * (1 - GAP_JITTER + 2 * GAP_JITTER * rng());
  return Math.max(MIN_GAP, Math.max(1, ceilingEvery) - 1, Math.round(jittered) - 1);
}

/** A just-added topic's boost after `tweets` more tweets. */
export function decayBoost(boost: number, tweets = 1): number {
  return boost * Math.pow(0.5, tweets / BOOST_HALF_LIFE_TWEETS);
}

/** Topics in the order to try them for the next post: each one's score
 *  sampled from its Beta, highest first. */
export function rankTopics(topics: readonly string[], state: PacingState, rng: () => number = Math.random): string[] {
  return topics
    .map(t => ({ t, v: sampleBeta(state.topics[t] ?? TOPIC_PRIOR, rng) }))
    .sort((x, y) => y.v - x.v)
    .map(x => x.t);
}

export function sampleBeta({ a, b }: Beta, rng: () => number = Math.random): number {
  const x = sampleGamma(a, rng);
  const y = sampleGamma(b, rng);
  return x + y > 0 ? x / (x + y) : 0.5;
}

// Marsaglia & Tsang; shapes below 1 via the usual U^(1/k) boost.
function sampleGamma(k: number, rng: () => number): number {
  if (k < 1) return sampleGamma(k + 1, rng) * Math.pow(Math.max(rng(), 1e-12), 1 / k);
  const d = k - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number;
    let v: number;
    do {
      x = standardNormal(rng);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = Math.max(rng(), 1e-12);
    if (Math.log(u) < 0.5 * x * x + d - d * v + d * Math.log(v)) return d * v;
  }
}

function standardNormal(rng: () => number): number {
  const u = Math.max(rng(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}
