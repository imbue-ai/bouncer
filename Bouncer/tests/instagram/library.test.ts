/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  creatorFromCard, remember, buildRecords, forgetAll, placeholderDescription,
} from '../../src/instagram/library';
import { noteDuration } from '../../src/instagram/durations';

function card(html: string): HTMLElement {
  const el = document.createElement('div');
  // Test fixture, not a runtime sink — the no-innerHTML rule is about the
  // extension's own DOM writes.
  el.innerHTML = html;
  document.body.appendChild(el);
  return el;
}

beforeEach(() => {
  document.body.replaceChildren();
  forgetAll();
});

describe('creatorFromCard', () => {
  // Instagram's class names are hashed, so the only durable signal is the shape
  // of the URL: a profile is a single path segment.
  it('finds the handle from the profile link', () => {
    expect(creatorFromCard(card('<a href="/maisieboesiger/">maisieboesiger</a>'))).toBe('maisieboesiger');
  });

  // Taken verbatim off the live reels feed: the author is linked by their reels
  // TAB, two segments deep. Requiring one segment rejected every author link on
  // the page, which is what made the byline read "by —" everywhere.
  it('reads the author from a /<handle>/reels/ link', () => {
    expect(creatorFromCard(card(`
      <a href="/taenaah___07/reels/"><img src="avatar.jpg"></a>
      <a href="/taenaah___07/reels/">taenaah___07</a>
      <a href="/reels/audio/454452358350929/"><img src="audio.jpg"></a>
      <a href="/reels/audio/454452358350929/">Audio imageKhalid · Young</a>
    `))).toBe('taenaah___07');
  });

  // The same shape that makes /x/reels/ a person must not make /reels/audio/
  // one. The first segment is what separates them.
  it('still rejects an audio page, which is also two segments', () => {
    expect(creatorFromCard(card(
      '<a href="/reels/audio/1610545003352807/"><img src="a.jpg"></a>',
    ))).toBeNull();
  });

  it('reads the author when a caption is full of hashtags', () => {
    expect(creatorFromCard(card(`
      <a href="/dylangold0/reels/"><img src="avatar.jpg"></a>
      <a href="/dylangold0/reels/">dylangold0</a>
      <div dir="auto">night one <a href="/explore/tags/bts/">#bts</a>
        <a href="/explore/tags/vegas/">#vegas</a></div>
    `))).toBe('dylangold0');
  });

  it('falls back to the path when the link is just an avatar', () => {
    expect(creatorFromCard(card('<a href="/wyattjchristlieb/"><img src="x.jpg"></a>')))
      .toBe('wyattjchristlieb');
  });

  // Audio attribution and hashtags are links on the same card, but they live
  // deeper than one path segment.
  it('ignores audio, hashtag and explore links', () => {
    expect(creatorFromCard(card(`
      <a href="/reels/audio/123/">original audio</a>
      <a href="/explore/tags/pasta/">#pasta</a>
      <a href="/p/abc123/">post</a>
    `))).toBeNull();
  });

  it('ignores Instagram\'s own top-level routes', () => {
    expect(creatorFromCard(card('<a href="/explore/">Explore</a><a href="/direct/">Inbox</a>')))
      .toBeNull();
  });

  it('is null when the card carries no links at all', () => {
    expect(creatorFromCard(card('<div>no links here</div>'))).toBeNull();
  });

  // The href is matched on its pathname rather than raw, because the raw form
  // varies in ways that all used to cost the row its creator.
  it('sees through the share-attribution query Instagram appends', () => {
    expect(creatorFromCard(card('<a href="/kaitlynhrdy/?igsh=MWx6cw%3D%3D">kaitlynhrdy</a>')))
      .toBe('kaitlynhrdy');
  });

  it('handles an absolute profile URL', () => {
    expect(creatorFromCard(card('<a href="https://www.instagram.com/desmondtai/">desmondtai</a>')))
      .toBe('desmondtai');
  });

  it('strips the @ when the link renders one', () => {
    expect(creatorFromCard(card('<a href="/norahvance/">@norahvance</a>'))).toBe('norahvance');
  });

  // The bug this replaced: a caption mention is a single path segment, exactly
  // like the author's own link, and often comes first in the card.
  it('does not mistake an @mention in the caption for the author', () => {
    expect(creatorFromCard(card(`
      <div dir="auto">shot this with @someoneelse last week, full video in bio</div>
      <a href="/realauthor/"><img src="avatar.jpg"></a>
      <a href="/realauthor/">realauthor</a>
    `.replace('@someoneelse', '<a href="/someoneelse/">@someoneelse</a>'))))
      .toBe('realauthor');
  });

  it('prefers the avatar link even when a mention comes first in the DOM', () => {
    expect(creatorFromCard(card(`
      <div dir="auto">collab with <a href="/guestcreator/">@guestcreator</a> — part two soon</div>
      <a href="/hostcreator/"><img src="avatar.jpg"></a>
    `))).toBe('hostcreator');
  });

  // No byline beats the wrong byline.
  it('gives up rather than naming someone the caption merely mentioned', () => {
    expect(creatorFromCard(card(
      '<div dir="auto">reposted from <a href="/otherperson/">@otherperson</a>, go follow them</div>',
    ))).toBeNull();
  });

  it('takes the first profile link, which is the author', () => {
    expect(creatorFromCard(card(`
      <a href="/author_one/">author_one</a>
      <a href="/someone_else/">someone_else</a>
    `))).toBe('author_one');
  });
});

describe('remember', () => {
  // Instagram recycles cards as you move through the feed, so a read taken late
  // may be describing a different reel — or a card that's gone.
  it('keeps the first reading even if the card is later reused', () => {
    const c = card('<a href="/original_author/">original_author</a>');
    remember({ reelId: 'r1', card: c, thumbnailUrl: 'https://cdn/x/r1.jpg' });

    c.replaceChildren();
    const recycled = document.createElement('a');
    recycled.setAttribute('href', '/someone_new/');
    recycled.textContent = 'someone_new';
    c.appendChild(recycled);
    remember({ reelId: 'r1', card: c, thumbnailUrl: 'https://cdn/x/r1.jpg' });

    const [record] = buildRecords(
      [{ reelId: 'r1', card: c, thumbnailUrl: 'https://cdn/x/r1.jpg' }],
      () => null,
    );
    expect(record.creator).toBe('original_author');
  });

  it('leaves the creator null when the card had none to give', () => {
    const c = card('<div>nothing</div>');
    remember({ reelId: 'r2', card: c, thumbnailUrl: 'https://cdn/x/r2.jpg' });
    const [record] = buildRecords(
      [{ reelId: 'r2', card: c, thumbnailUrl: 'https://cdn/x/r2.jpg' }],
      () => null,
    );
    expect(record.creator).toBeNull();
  });

  // Discovery fires the moment a reel's <video> mounts and runs exactly once per
  // card, but the handle is overlay chrome and often a beat behind it. A single
  // early miss used to mean "by —" for the life of the feed.
  it('picks the handle up on a later render when it was not there yet', () => {
    const c = card('<div>chrome has not rendered yet</div>');
    const reel = { reelId: 'r3', card: c, thumbnailUrl: 'https://cdn/x/r3.jpg' };
    remember(reel);
    expect(buildRecords([reel], () => null)[0].creator).toBeNull();

    const link = document.createElement('a');
    link.setAttribute('href', '/late_arrival/');
    link.textContent = 'late_arrival';
    c.appendChild(link);

    expect(buildRecords([reel], () => null)[0].creator).toBe('late_arrival');
  });

  // The retry is only until it succeeds — after that the cached reading wins,
  // because the card it would re-read may since have been recycled.
  it('stops re-reading once it has an answer', () => {
    const c = card('<a href="/first_read/">first_read</a>');
    const reel = { reelId: 'r4', card: c, thumbnailUrl: 'https://cdn/x/r4.jpg' };
    expect(buildRecords([reel], () => null)[0].creator).toBe('first_read');

    c.replaceChildren();
    const recycled = document.createElement('a');
    recycled.setAttribute('href', '/different_reel_now/');
    recycled.textContent = 'different_reel_now';
    c.appendChild(recycled);

    expect(buildRecords([reel], () => null)[0].creator).toBe('first_read');
  });
});

describe('buildRecords', () => {
  function reels(n: number): { reelId: string; card: HTMLElement; thumbnailUrl: string }[] {
    return Array.from({ length: n }, (_, i) => ({
      reelId: `reel_${i}`,
      card: card(`<a href="/creator_${i}/">creator_${i}</a>`),
      thumbnailUrl: `https://cdn/x/reel_${i}.jpg`,
    }));
  }

  it('numbers reels by feed position', () => {
    const records = buildRecords(reels(3), () => null);
    expect(records.map((r) => r.index)).toEqual([0, 1, 2]);
  });

  it('carries the creator, length and thumbnail each row needs', () => {
    const list = reels(1);
    list.forEach(remember);
    noteDuration('https://cdn/x/reel_0.jpg', 14);

    const [record] = buildRecords(list, () => null);
    expect(record.creator).toBe('creator_0');
    expect(record.durationSec).toBe(14);
    expect(record.thumbnailUrl).toBe('https://cdn/x/reel_0.jpg');
  });

  // A reel Instagram has recycled stays in the history — being able to look
  // back at it is the point — but it can't be navigated to.
  it('marks a reel whose card has left the DOM as unreachable', () => {
    const list = reels(2);
    list[0].card.remove();
    const records = buildRecords(list, () => null);
    expect(records[0].reachable).toBe(false);
    expect(records[1].reachable).toBe(true);
  });

  it('takes the real description when inference has answered', () => {
    const list = reels(2);
    const records = buildRecords(list, (reel) =>
      reel.reelId === 'reel_0' ? 'Two-minute knife sharpening' : null);
    expect(records[0].description).toBe('Two-minute knife sharpening');
  });

  // Every row carries a claim about a reel. A row still waiting on inference has
  // to say that it is waiting — inventing a plausible phrase for it would be
  // indistinguishable, to the user, from a described reel.
  it('says a reel is still being described rather than guessing at it', () => {
    const records = buildRecords(reels(4), () => null);
    for (const r of records) expect(r.description).toBe('Describing…');
  });

  it('keeps a reel\'s label stable across renders', () => {
    const list = reels(3);
    const first = buildRecords(list, () => null).map((r) => r.description);
    const second = buildRecords(list, () => null).map((r) => r.description);
    expect(second).toEqual(first);
  });
});

describe('placeholderDescription', () => {
  it('wraps around rather than running out on a long feed', () => {
    expect(placeholderDescription(0)).toBe(placeholderDescription(10));
    expect(placeholderDescription(3)).toBe(placeholderDescription(13));
  });
});
