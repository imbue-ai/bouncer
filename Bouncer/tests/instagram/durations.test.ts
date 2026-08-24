/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, vi } from 'vitest';
import {
  durationFor, noteDuration, formatDuration, installDurationSource, requestHookReplay,
  videoUrlFor, probeDuration, onDurationResolved, durationReport,
} from '../../src/instagram/durations';

describe('formatDuration', () => {
  it('renders m:ss', () => {
    expect(formatDuration(7)).toBe('0:07');
    expect(formatDuration(31)).toBe('0:31');
    expect(formatDuration(83)).toBe('1:23');
    expect(formatDuration(600)).toBe('10:00');
  });

  it('rounds to the nearest second rather than truncating', () => {
    expect(formatDuration(30.6)).toBe('0:31');
    expect(formatDuration(59.7)).toBe('1:00');
  });

  // Callers render the result unconditionally, so anything unusable has to come
  // back as "nothing to say" rather than "0:00" or "NaN:NaN".
  it('gives an empty string for anything unusable', () => {
    expect(formatDuration(null)).toBe('');
    expect(formatDuration(undefined)).toBe('');
    expect(formatDuration(0)).toBe('');
    expect(formatDuration(-4)).toBe('');
    expect(formatDuration(NaN)).toBe('');
    expect(formatDuration(Infinity)).toBe('');
  });
});

describe('durationFor', () => {
  // Reel ids are derived from the cover thumbnail, whose query string carries
  // short-lived CDN tokens — so the join key is the filename alone. A length
  // recorded against one signed URL has to survive the next one.
  it('joins on the thumbnail filename, ignoring the query string', () => {
    noteDuration('https://scontent.cdninstagram.com/v/t51/joined_1.jpg?token=aaa&oe=1', 12.5);
    expect(durationFor('https://scontent-lhr.cdninstagram.com/v/t51/joined_1.jpg?token=zzz'))
      .toBe(12.5);
  });

  // Measured on device: every length arrived from the hook and not one of them
  // joined — 8 announced, 0 rows with a number. The payload names a cover one
  // way and the page requests it another (a size prefix, a different t51 bucket,
  // an `_s`/`_e35` rendition suffix), and the long digit runs are what survive
  // all of it.
  it('joins two renditions of the same cover', () => {
    noteDuration('https://cdn/v/t51.2885-15/658397544_2494782664325741_5320800819561902195_n.jpg', 31);
    expect(durationFor(
      'https://cdn/v/t51.71878-15/s640x640_658397544_2494782664325741_5320800819561902195_e35.jpg',
    )).toBe(31);
  });

  it('does not join two different covers that merely look alike', () => {
    noteDuration('https://cdn/x/111111111_222222222_333333333_n.jpg', 12);
    expect(durationFor('https://cdn/x/111111111_999999999_333333333_n.jpg')).toBeNull();
  });

  // A filename with nothing id-shaped in it has no stem to fall back on, and
  // must not collide with every other such filename.
  it('does not join filenames with no ids in them', () => {
    noteDuration('https://cdn/x/cover.jpg', 9);
    expect(durationFor('https://cdn/x/other.jpg')).toBeNull();
  });

  it('is null for a reel nothing has reported on', () => {
    expect(durationFor('https://scontent.cdninstagram.com/v/t51/unknown_reel.jpg')).toBeNull();
  });

  it('ignores lengths that would render as nonsense', () => {
    noteDuration('https://cdn/x/rejected_1.jpg', 0);
    noteDuration('https://cdn/x/rejected_2.jpg', NaN);
    noteDuration('https://cdn/x/rejected_3.jpg', -3);
    expect(durationFor('https://cdn/x/rejected_1.jpg')).toBeNull();
    expect(durationFor('https://cdn/x/rejected_2.jpg')).toBeNull();
    expect(durationFor('https://cdn/x/rejected_3.jpg')).toBeNull();
  });

  // A measured <video>.duration is about the reel actually on screen; the hook's
  // value came from a JSON payload matched by filename. The later write wins.
  it('lets a newer reading replace an older one', () => {
    noteDuration('https://cdn/x/replaced.jpg', 10);
    noteDuration('https://cdn/x/replaced.jpg', 14.2);
    expect(durationFor('https://cdn/x/replaced.jpg')).toBe(14.2);
  });
});

describe('the hook feed', () => {
  /** What hook.ts posts across the world boundary. */
  function postFromHook(entries: unknown[]): void {
    window.dispatchEvent(Object.assign(
      new MessageEvent('message', { data: { source: 'bouncer-ig-audio-hook', entries } }),
      { source: window },
    ));
  }

  // Instagram embeds the first screenful's state inline and fetches the rest.
  // A length is a length whichever channel it arrived on.
  it('takes lengths from an inline payload the same as a fetched one', () => {
    installDurationSource();
    window.dispatchEvent(Object.assign(
      new MessageEvent('message', {
        data: {
          source: 'bouncer-ig-audio-hook',
          via: 'inline',
          entries: [{ filenames: ['inline_1.jpg'], durationSec: 21 }],
        },
      }),
      { source: window },
    ));
    expect(durationFor('https://cdn/x/inline_1.jpg')).toBe(21);
  });

  it('records lengths announced by the hook', () => {
    installDurationSource();
    postFromHook([{ filenames: ['hooked_1.jpg', 'hooked_1_alt.jpg'], durationSec: 18.4 }]);

    // Every filename a media object goes by is a valid join key — Instagram
    // serves the same cover at several sizes.
    expect(durationFor('https://cdn/v/t51/hooked_1.jpg?token=x')).toBe(18.4);
    expect(durationFor('https://cdn/v/t51/hooked_1_alt.jpg')).toBe(18.4);
  });

  it('ignores entries carrying no usable length', () => {
    installDurationSource();
    postFromHook([
      { filenames: ['nolength_1.jpg'] },
      { filenames: ['nolength_2.jpg'], durationSec: 0 },
    ]);
    expect(durationFor('https://cdn/x/nolength_1.jpg')).toBeNull();
    expect(durationFor('https://cdn/x/nolength_2.jpg')).toBeNull();
  });

  it('ignores messages that did not come from this window', () => {
    installDurationSource();
    window.dispatchEvent(new MessageEvent('message', {
      data: { source: 'bouncer-ig-audio-hook', entries: [{ filenames: ['foreign.jpg'], durationSec: 9 }] },
    }));
    expect(durationFor('https://cdn/x/foreign.jpg')).toBeNull();
  });

  // The hook harvests the server-rendered payload at DOMContentLoaded; every
  // consumer boots at document_idle. Without asking for a replay, the reel you
  // land on is the one guaranteed to have no length.
  it('asks the hook to re-announce what it harvested before we were listening', () => {
    const posted = vi.spyOn(window, 'postMessage');
    requestHookReplay();
    expect(posted).toHaveBeenCalledWith({ source: 'bouncer-ig-hook-ready' }, '*');
    posted.mockRestore();
  });

  // The stream URL is what makes a MISSING length recoverable later — see
  // probeDuration — and by the time it's missed, the entry that carried it is
  // long gone. So it's kept on the way past, length or no length.
  it('keeps the reel\'s video URL, even from an entry that had a length', () => {
    installDurationSource();
    postFromHook([
      { filenames: ['withurl_1.jpg'], videoUrl: 'https://cdn/v/withurl_1.mp4', durationSec: 12 },
      { filenames: ['withurl_2.jpg'], videoUrl: 'https://cdn/v/withurl_2.mp4' },
    ]);
    expect(videoUrlFor('https://cdn/x/withurl_1.jpg?token=x'))
      .toBe('https://cdn/v/withurl_1.mp4');
    expect(videoUrlFor('https://cdn/x/withurl_2.jpg')).toBe('https://cdn/v/withurl_2.mp4');
  });
});

// The third source. The first two leave a gap — not every payload carries a
// length, and a reel below the fold has no <video> to measure — and this is the
// case where we have the reel's own stream URL and had simply never asked it.
describe('probeDuration', () => {
  /** How many <video> elements got created — one per reel actually asked. */
  function watchVideos(): { count: () => number; stop: () => void } {
    let made = 0;
    const create = vi.spyOn(document, 'createElement');
    create.mockImplementation(((tag: string) => {
      const el = Object.getPrototypeOf(document).createElement.call(document, tag) as HTMLElement;
      if (tag === 'video') made++;
      return el;
    }) as typeof document.createElement);
    return { count: () => made, stop: () => create.mockRestore() };
  }

  /** One entry, as hook.ts posts them. */
  function postEntry(entry: Record<string, unknown>): void {
    window.dispatchEvent(Object.assign(
      new MessageEvent('message', {
        data: { source: 'bouncer-ig-audio-hook', entries: [entry] },
      }),
      { source: window },
    ));
  }

  it('does nothing for a reel that already has a length', async () => {
    noteDuration('https://cdn/x/known.jpg', 21);
    expect(await probeDuration('https://cdn/x/known.jpg')).toBe(false);
  });

  it('does nothing for a reel it has no video URL for', async () => {
    expect(await probeDuration('https://cdn/x/no_url_at_all.jpg')).toBe(false);
  });

  // The whole point of asking early: the reel is a name in a payload long
  // before it is a row on screen, and that is the moment to go and find out.
  it('asks as soon as the hook mentions a reel with no length', () => {
    const made = watchVideos();
    installDurationSource();
    postEntry({ filenames: ['probe_eager.jpg'], videoUrl: 'https://cdn/v/probe_eager.mp4' });
    expect(made.count()).toBe(1);
    made.stop();
  });

  it('does not ask for one the payload already answered', () => {
    const made = watchVideos();
    installDurationSource();
    postEntry({
      filenames: ['probe_known.jpg'],
      videoUrl: 'https://cdn/v/probe_known.mp4',
      durationSec: 14,
    });
    expect(made.count()).toBe(0);
    made.stop();
  });

  // A network round trip per row per render would be a lot of network for a
  // number that isn't coming.
  it('asks at most once per reel', async () => {
    const made = watchVideos();
    installDurationSource();
    postEntry({ filenames: ['probe_once.jpg'], videoUrl: 'https://cdn/v/probe_once.mp4' });

    // happy-dom loads nothing, so these hang on the timeout; the point is how
    // many of them got as far as creating an element to ask with.
    void probeDuration('https://cdn/x/probe_once.jpg');
    void probeDuration('https://cdn/x/probe_once.jpg');
    made.stop();

    expect(made.count()).toBe(1);
  });
});

// The lag this fixes: a length that arrives AFTER a row has rendered used to
// sit in the map, correct and invisible, until something unrelated re-rendered.
// Only the network probe announced — and probes stopped running the moment the
// hook join started working, which is to say for every reel.
describe('telling the screen a length arrived', () => {
  /** One microtask past the coalescing window. */
  const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  it('announces a length that lands from the hook', async () => {
    const heard = vi.fn();
    onDurationResolved(heard);
    installDurationSource();
    window.dispatchEvent(Object.assign(
      new MessageEvent('message', {
        data: {
          source: 'bouncer-ig-audio-hook',
          entries: [{ filenames: ['announced_1.jpg'], durationSec: 12 }],
        },
      }),
      { source: window },
    ));

    await settled();
    expect(heard).toHaveBeenCalled();
  });

  it('announces one measured off a mounted video', async () => {
    const heard = vi.fn();
    onDurationResolved(heard);
    noteDuration('https://cdn/x/announced_2.jpg', 31);

    await settled();
    expect(heard).toHaveBeenCalled();
  });

  // A batch is one render, not one per reel.
  it('coalesces a whole payload into a single announcement', async () => {
    const heard = vi.fn();
    onDurationResolved(heard);
    for (let i = 0; i < 12; i++) noteDuration(`https://cdn/x/batch_${i}.jpg`, 10 + i);

    await settled();
    expect(heard).toHaveBeenCalledTimes(1);
  });

  // Re-recording the same number must not announce. Announcing re-renders the
  // chooser, which re-reads every row, which re-runs the mounted-<video> sweep,
  // which records these same numbers again — this is what stops that being an
  // infinite loop through three modules.
  it('says nothing when the number has not changed', async () => {
    noteDuration('https://cdn/x/stable.jpg', 18);
    await settled();

    const heard = vi.fn();
    onDurationResolved(heard);
    noteDuration('https://cdn/x/stable.jpg', 18);
    await settled();

    expect(heard).not.toHaveBeenCalled();
  });
});

// "The times are laggy" is a claim about one number: how long a row sat on
// screen with a blank where the time goes. These make that number readable.
describe('the wait report', () => {
  const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  it('counts a length that landed before anything asked as free', async () => {
    noteDuration('https://cdn/x/early_bird.jpg', 14);
    await settled();
    // Either wording, depending on whether anything else in this module's life
    // has waited: "N instant" alongside real waits, or "landed before any row
    // asked" when there are none at all.
    expect(durationReport(['https://cdn/x/early_bird.jpg']))
      .toMatch(/instant|before any row asked/);
  });

  // The case worth measuring: a row rendered, found nothing, and the answer
  // turned up afterwards.
  it('measures the gap between the first ask and the answer', async () => {
    // A render that wants it and comes up empty — this is the ask.
    expect(durationFor('https://cdn/x/late_one.jpg')).toBeNull();
    expect(durationFor('https://cdn/x/late_one.jpg')).toBeNull();

    noteDuration('https://cdn/x/late_one.jpg', 22);
    await settled();

    const report = durationReport([]);
    expect(report).toMatch(/rows? rendered blank/);
    expect(report).toContain('median');
    // And which source finally answered, which is the "why".
    expect(report).toContain('video');
  });

  it('says when something is still missing', () => {
    expect(durationFor('https://cdn/x/never_arrives.jpg')).toBeNull();
    expect(durationReport([])).toContain('still missing');
  });
});

// The signed-in feed answers differently at every stage of the pipeline than
// the logged-out one — different endpoints, different payload shapes — and
// "the times are laggy when I'm signed in" needs the report to say WHERE the
// pipeline went quiet, not just that it did.
describe('the hook accounting in the report', () => {
  it('reports the hook as silent until stats arrive', () => {
    expect(durationReport([])).toContain('no stats received');
  });

  it('carries the hook\'s own accounting once a batch delivers it', () => {
    installDurationSource();
    window.dispatchEvent(Object.assign(
      new MessageEvent('message', {
        data: {
          source: 'bouncer-ig-audio-hook',
          via: 'fetch',
          entries: [{ filenames: ['stats_1.jpg'], durationSec: 9 }],
          stats: {
            responses: { fetch: 7, xhr: 1, inline: 3 },
            mediaWithManifest: 12,
            mediaWithDuration: 4,
            posted: 11,
            droppedNoCover: 5,
            coverlessShapes: ['pk|code|video_duration|media_type'],
            walkTruncated: 2,
          },
        },
      }),
      { source: window },
    ));
    const report = durationReport([]);
    expect(report).toContain('fetch 7');
    expect(report).toContain('12 manifests + 4 bare lengths');
    expect(report).toContain('5 DROPPED coverless');
    // The shape sample is the diagnosis: it names the payload variant whose
    // covers we failed to find.
    expect(report).toContain('pk|code|video_duration|media_type');
    expect(report).toContain('2 walk(s) TRUNCATED');
  });

  it('names each missing on-screen cover with its probe standing', () => {
    expect(durationFor('https://cdn/x/missing_9876543_1234567.jpg')).toBeNull();
    const report = durationReport(['https://cdn/x/missing_9876543_1234567.jpg']);
    expect(report).toContain('missing_9876543_1234567.jpg');
    expect(report).toContain('stem 9876543_1234567');
    expect(report).toContain('video url NO');
    expect(report).toContain('probed no');
  });

  it('stamps each channel with when its batches arrived', () => {
    const report = durationReport([]);
    // The fetch channel above arrived at some measurable moment.
    expect(report).toMatch(/fetch \d+ @\d+\.\ds/);
  });
});
