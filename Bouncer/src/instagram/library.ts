// What we know about every reel we've seen, in the order we saw it.
//
// Once scrolling stops being how you move through the feed (./suggest.ts), the
// feed stops being a place you're in and becomes a list you pick from — and a
// list has to be readable without the thing it describes being on screen. Every
// row on the chooser shows a reel you are NOT watching: its thumbnail, what it
// is, how long it runs, who made it.
//
// Reels AHEAD of you, only — the chooser has no history to browse and index.ts
// hands over nothing behind the reel on screen. Ahead is enough to need all of
// this anyway: Instagram keeps two or three <video> elements mounted and recycles
// the rest, so a reel four along is already a card that may not be there when
// its row renders.
//
// So each fact is captured at the moment it is cheapest to capture, not when it
// is needed:
//
//   thumbnail  the cover <img> src, which is how the reel was discovered at all.
//   creator    scraped from the card ONCE, on discovery, and cached by reel id.
//              Instagram recycles cards as you move, so a card read late may
//              describe a different reel — or be gone. Read early, keep forever.
//   length     ./durations.ts, which joins Instagram's own API payloads to the
//              cover filename. Reels below the fold have no <video> to measure.
//   description placeholder for now — see PLACEHOLDER_PHRASES.
//
// The store is keyed by reel id and never evicts. A few hundred bytes per reel
// buys a row that still reads correctly after Instagram has virtualized its card
// away, which for a reel a few places ahead is most of the time.

import { durationFor, reelCodeFor } from './durations';

/** Everything a chooser row needs about one reel. */
export interface ReelRecord {
  /** Position in feed order, 0-based. */
  index: number;
  reelId: string;
  card: HTMLElement;
  thumbnailUrl: string;
  description: string;
  durationSec: number | null;
  creator: string | null;
  /** Whether the card is still in the DOM — a virtualized reel can be listed
   *  but not navigated to. */
  reachable: boolean;
  /** The reel's shortcode, when the hook has seen it: its own address,
   *  `/reels/<code>/`. Optional because a reel discovered from the DOM alone —
   *  one whose payload never went past the hook — has no code, and the chooser
   *  falls back to swiping for those. */
  code?: string;
}

/** The shape index.ts tracks reels in. Kept structural so the library doesn't
 *  depend on the module that owns the feed. */
export interface DiscoveredReel {
  reelId: string;
  card: HTMLElement;
  thumbnailUrl: string;
}

// Stand-in descriptions until the inference pipeline is trusted. Concrete and
// varied on purpose: a chooser is a claim that you can tell what's coming, and a
// column of "Reel 4" would prove nothing about whether the layout works. Indexed
// by position so a given reel keeps its label across renders.
const PLACEHOLDER_PHRASES = [
  'Viral tomato pasta recipe',
  'Spain vs Argentina World Cup clip',
  'Career advice for new graduates',
  'Funny cat knocking over vase',
  'Ranked review of budget headphones',
  'Street interview about rent prices',
  'Two-ingredient cold brew hack',
  'Golden retriever fails a trick',
  'Cabin renovation time-lapse',
  'Why this bridge collapsed',
] as const;

/** Set false once descriptions can be trusted to arrive; `describe` then takes
 *  the real one and falls back to PENDING_DESCRIPTION only while it's pending. */
export const PLACEHOLDER_DESCRIPTIONS = false;

/** Last resort for a row's label: no description, and no caption to fall back
 *  on either (see describeOrCaption in ../index.ts).
 *
 *  Not one of the stand-ins above. A placeholder is honest while EVERY row is
 *  one — the sheet is obviously a mock-up. Mixed in among real text it becomes
 *  a confident, specific claim about a reel nothing has looked at, and the user
 *  has no way to tell which rows are which. Vague and true beats concrete and
 *  invented. */
export const PENDING_DESCRIPTION = 'Describing…';

/** Whether a row has everything it needs to be worth showing: what the reel
 *  is, who made it, and how long it runs.
 *
 *  The chooser holds a row back until this is true, because the three facts do
 *  not arrive together and never will. The description is a round trip to the
 *  backend; the creator is read off a card that may not be in the DOM yet; the
 *  length usually lands last of all, because Instagram doesn't tell the page
 *  how long a reel is until you are nearly on it (see ./durations.ts). Rendered
 *  as they arrive, a row rewrites itself two or three times while you are
 *  trying to read it — and the rows below it move each time.
 *
 *  The thumbnail is deliberately NOT part of this. It is drawn into a box whose
 *  size is fixed before the image exists, so a late picture moves nothing; and
 *  gating on it would mean one dead CDN URL leaves a slot empty for good. It is
 *  prefetched instead, the moment the reel enters the window. */
export function isRecordComplete(record: ReelRecord): boolean {
  const described = record.description.trim().length > 0
    && (PLACEHOLDER_DESCRIPTIONS || record.description !== PENDING_DESCRIPTION);
  return described
    && record.creator !== null
    && record.creator.trim().length > 0
    && record.durationSec !== null
    && Number.isFinite(record.durationSec)
    && record.durationSec > 0;
}

export function placeholderDescription(index: number): string {
  return PLACEHOLDER_PHRASES[index % PLACEHOLDER_PHRASES.length];
}

// Reel id -> creator handle. Populated once per reel, on discovery.
const creators = new Map<string, string>();

// Paths that look like a profile link but aren't one.
const NON_PROFILE = new Set([
  'explore', 'reels', 'reel', 'direct', 'accounts', 'stories', 'p', 'tv',
  'about', 'privacy', 'terms', 'developer', 'legal',
]);

// Second segments that still make the first one a handle. A reel card links to
// the author's REELS TAB — /someone/reels/ — not to their profile root, which
// is the whole reason this needs to exist.
const PROFILE_TABS = new Set(['reels', 'reel', 'tagged', 'saved', 'feed']);

/** The handle a link points at, or null if it isn't a profile link.
 *
 *  Resolved through URL rather than matched on the raw attribute, because the
 *  raw form varies: absolute hrefs, a trailing `?igsh=...` share param, a hash.
 *
 *  Segment COUNT was the thing this got wrong. "A profile is a single path
 *  segment" is true of a profile root and false of every link a reel actually
 *  carries: measured against the live feed, all three cards linked their author
 *  as `/<handle>/reels/`. Requiring one segment rejected every author link on
 *  the page as not-a-profile, so the byline had no candidate to choose from and
 *  read "by —" everywhere — while `/reels/audio/<id>/` and `/explore/tags/<t>/`
 *  were correctly excluded, which made the filter look like it was working.
 *
 *  So the first segment is the handle, and a second is allowed only when it
 *  names a tab of that profile. Instagram's own routes are still excluded by
 *  NON_PROFILE on the FIRST segment, which is what separates `/x/reels/` (a
 *  person) from `/reels/audio/` (a sound). */
function handleFromHref(href: string | null): string | null {
  if (!href) return null;
  let path: string;
  try {
    path = new URL(href, location.href).pathname;
  } catch {
    return null;
  }
  const segments = path.split('/').filter(Boolean);
  if (segments.length === 0 || segments.length > 2) return null;
  const handle = segments[0];
  if (!/^[A-Za-z0-9._]{1,30}$/.test(handle)) return null;
  if (NON_PROFILE.has(handle.toLowerCase())) return null;
  if (segments.length === 2 && !PROFILE_TABS.has(segments[1].toLowerCase())) return null;
  return handle;
}

/** Whether a link is a fragment of a sentence rather than a piece of the card's
 *  own chrome — i.e. an @mention inside the caption.
 *
 *  Measured, not guessed: an author's handle IS the whole of its container's
 *  text, while a mention sits in a block that runs on well past it. */
function insideProse(a: HTMLAnchorElement, card: HTMLElement): boolean {
  const own = (a.textContent ?? '').trim().length;
  let el: HTMLElement | null = a.parentElement;
  for (let i = 0; i < 6 && el && el !== card; i++) {
    if (el.getAttribute('dir') === 'auto') {
      const total = (el.textContent ?? '').trim().length;
      if (total > own + 12) return true;
    }
    el = el.parentElement;
  }
  return false;
}

/** The account that posted this reel, scraped from the card.
 *
 *  Instagram's class names are hashed, so this keys off URL shape: a profile is
 *  a single path segment, while audio attribution and hashtags live under
 *  /reels/audio/ and /explore/tags/ and are excluded by having more.
 *
 *  Shape alone is not enough, though, and this is where taking the first match
 *  went wrong: a caption that says "@someoneelse" renders as `/someoneelse/` —
 *  one segment, indistinguishable from the author's own link, and frequently
 *  earlier in the card. The byline was showing whoever the caption mentioned.
 *
 *  So the author is identified structurally instead. The avatar is the giveaway:
 *  the author's profile link wraps an <img>, and a caption never contains one.
 *  Failing that, the first profile link that isn't embedded in prose. If every
 *  candidate is a mention, this returns null — no byline beats a wrong one. */
export function creatorFromCard(card: HTMLElement): string | null {
  const chosen = chooseCreatorLink(card);
  if (!chosen) return null;

  // Prefer the link's own text — it's the handle as Instagram renders it — but
  // an avatar link has none, and a leading "@" marks a mention rather than a
  // byline, so both fall back to the path segment.
  const text = (chosen.a.textContent ?? '').trim();
  if (text && !/\s/.test(text) && !text.startsWith('@') && text.length <= 30) return text;
  return chosen.handle;
}

/** The byline as an ELEMENT rather than a name — for anyone needing to know
 *  where on the card the author sits, not just who they are. ./fit.ts uses it
 *  to ask whether the byline ended up below the fold. */
export function creatorLinkFromCard(card: HTMLElement): HTMLAnchorElement | null {
  return chooseCreatorLink(card)?.a ?? null;
}

function chooseCreatorLink(card: HTMLElement): { a: HTMLAnchorElement; handle: string } | null {
  const candidates: { a: HTMLAnchorElement; handle: string }[] = [];
  for (const a of Array.from(card.querySelectorAll<HTMLAnchorElement>('a[href]'))) {
    const handle = handleFromHref(a.getAttribute('href'));
    if (handle) candidates.push({ a, handle });
  }
  return candidates.find((c) => c.a.querySelector('img') !== null)
    ?? candidates.find((c) => !insideProse(c.a, card))
    ?? null;
}

/** Exactly what the byline scraper can see on a card, for the on-device report.
 *
 *  This extraction has been wrong twice in ways invisible from the outside —
 *  first an anchored regex that the `?igsh=` share param defeated, then caption
 *  @mentions being indistinguishable from the author by URL shape. Both times
 *  the only symptom was "by —", which says nothing about which half failed. So
 *  the report ships the evidence: every link, what the shape test made of it,
 *  whether it wraps an avatar, and its text. */
export function creatorReport(card: HTMLElement): string {
  const links = Array.from(card.querySelectorAll<HTMLAnchorElement>('a[href]'));
  if (links.length === 0) return 'no <a href> in the card at all';
  const parts = links.slice(0, 10).map((a) => {
    const href = (a.getAttribute('href') ?? '').slice(0, 44);
    const handle = handleFromHref(a.getAttribute('href'));
    const avatar = a.querySelector('img') ? ' [img]' : '';
    const prose = insideProse(a, card) ? ' [prose]' : '';
    const text = (a.textContent ?? '').trim().slice(0, 24);
    return `${href} → ${handle ?? 'not-a-profile'}${avatar}${prose} "${text}"`;
  });
  return `${links.length} links: ${parts.join('  |  ')}`;
}

/** Capture what's only readable now. Safe to call repeatedly; the first
 *  SUCCESSFUL reading wins, because later ones may be looking at a recycled
 *  card. A reading that finds nothing is not cached — see creatorFor. */
export function remember(reel: DiscoveredReel): void {
  if (creators.has(reel.reelId)) return;
  const creator = creatorFromCard(reel.card);
  if (creator) creators.set(reel.reelId, creator);
}

/** The creator for a row, reading the card again if the first attempt came up
 *  empty.
 *
 *  Discovery fires the moment a reel's <video> mounts, and the handle is part of
 *  the overlay chrome — frequently a beat behind it. `remember` runs exactly
 *  once per card (../index.ts skips cards it has already seen), so a single
 *  early miss used to mean "by —" for the life of the feed. Retrying here costs
 *  one querySelectorAll on a card we were already about to render, and only
 *  until it succeeds. */
function creatorFor(reel: DiscoveredReel): string | null {
  const cached = creators.get(reel.reelId);
  if (cached) return cached;
  if (!reel.card.isConnected) return null;
  const found = creatorFromCard(reel.card);
  if (found) creators.set(reel.reelId, found);
  return found;
}

/** Resolve an ordered list of discovered reels into rows a chooser can render.
 *  `describeReel` supplies the real description when there is one; until then a
 *  row says it is still being described (or wears a stand-in, while
 *  PLACEHOLDER_DESCRIPTIONS is on). */
export function buildRecords(
  reels: readonly DiscoveredReel[],
  describeReel: (reel: DiscoveredReel) => string | null,
): ReelRecord[] {
  return reels.map((reel, index) => {
    const real = PLACEHOLDER_DESCRIPTIONS ? null : describeReel(reel);
    const pending = PLACEHOLDER_DESCRIPTIONS
      ? placeholderDescription(index)
      : PENDING_DESCRIPTION;
    return {
      index,
      reelId: reel.reelId,
      card: reel.card,
      thumbnailUrl: reel.thumbnailUrl,
      description: real ?? pending,
      durationSec: durationFor(reel.thumbnailUrl),
      creator: creatorFor(reel),
      reachable: reel.card.isConnected,
      ...((code) => (code ? { code } : {}))(reelCodeFor(reel.thumbnailUrl)),
    };
  });
}

/** Forget everything. Called when the describer tears down, so a later return
 *  to reels doesn't list reels from a feed that no longer exists. */
export function forgetAll(): void {
  creators.clear();
}
