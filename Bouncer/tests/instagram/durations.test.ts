/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect } from 'vitest';
import { durationFor, noteDuration, formatDuration } from '../../src/instagram/durations';

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
