import { describe, it, expect } from 'vitest';
import {
  encodeFilterPackCode,
  decodeFilterPackCode,
  FILTER_PACK_CODE_PREFIX,
  FILTER_PACK_CODE_REGEX,
} from '../../src/shared/share-encoding.js';

const PREFIX_LEN = FILTER_PACK_CODE_PREFIX.length;

describe('share-encoding round-trip', () => {
  it('round-trips an empty pack', async () => {
    const code = await encodeFilterPackCode({ phrases: [] });
    const decoded = await decodeFilterPackCode(code);
    expect(decoded).toEqual({ phrases: [] });
  });

  it('round-trips a single dict-friendly phrase', async () => {
    const phrases = ['crypto'];
    const code = await encodeFilterPackCode({ phrases });
    const decoded = await decodeFilterPackCode(code);
    expect(decoded).toEqual({ phrases });
  });

  it('round-trips multiple dict-friendly phrases preserving order', async () => {
    const phrases = ['crypto', 'engagement bait', 'AI slop', 'right wing'];
    const code = await encodeFilterPackCode({ phrases });
    const decoded = await decodeFilterPackCode(code);
    expect(decoded).toEqual({ phrases });
  });

  it('round-trips phrases with non-dict words via literal escape', async () => {
    const phrases = ['xkcd references', 'fooBarBaz'];
    const code = await encodeFilterPackCode({ phrases });
    const decoded = await decodeFilterPackCode(code);
    expect(decoded).toEqual({ phrases });
  });

  it('round-trips phrases with emoji (multibyte UTF-8)', async () => {
    const phrases = ['posts with 🔥 takes', 'crypto 💸'];
    const code = await encodeFilterPackCode({ phrases });
    const decoded = await decodeFilterPackCode(code);
    expect(decoded).toEqual({ phrases });
  });

  it('normalizes internal whitespace and drops empty phrases', async () => {
    const code = await encodeFilterPackCode({ phrases: ['  crypto  ', '', '\tengagement\nbait '] });
    const decoded = await decodeFilterPackCode(code);
    expect(decoded).toEqual({ phrases: ['crypto', 'engagement bait'] });
  });
});

describe('share-encoding size', () => {
  // The whole point of v2: for typical filter phrases the share code should be
  // SHORTER than the raw concatenated phrase text. If this regresses we've
  // either broken the dict tokenizer or shrunk the dict too far.
  it('beats the raw phrase length for dict-friendly packs', async () => {
    const phrases = ['crypto', 'engagement bait', 'AI slop', 'rage bait', 'right wing politics'];
    const rawLen = phrases.join('').length; // chars of just the phrases mashed together
    const code = await encodeFilterPackCode({ phrases });
    expect(code.length).toBeLessThan(rawLen + PREFIX_LEN);
    // And materially shorter than the prior gzip+JSON encoding would have been
    // (which always added the gzip header → never beat raw text). Sanity check
    // that we at least beat raw-with-newlines.
    const rawWithSeps = phrases.join('\n').length;
    expect(code.length - PREFIX_LEN).toBeLessThan(rawWithSeps);
  });

  it('falls back to raw method for non-dict input without inflating much', async () => {
    const phrases = ['xkcdreferences', 'foobarbaz', 'qwertyzxcv'];
    const code = await encodeFilterPackCode({ phrases });
    // Raw method is base64url(method_byte + utf8 bytes). Body length ≈ 4/3 × (1 + bytes).
    const totalBytes = 1 + phrases.join('\n').length;
    const expectedMaxBody = Math.ceil((totalBytes * 4) / 3);
    expect(code.length - PREFIX_LEN).toBeLessThanOrEqual(expectedMaxBody);
  });
});

describe('share-encoding parsing safety', () => {
  it('returns null for codes without the expected prefix', async () => {
    expect(await decodeFilterPackCode('bncr1_abcd')).toBeNull();
    expect(await decodeFilterPackCode('not-a-code')).toBeNull();
    expect(await decodeFilterPackCode('')).toBeNull();
  });

  it('returns null for empty payload after the prefix', async () => {
    expect(await decodeFilterPackCode(FILTER_PACK_CODE_PREFIX)).toBeNull();
  });

  it('returns null for unknown method byte', async () => {
    // method 0xAA, no payload
    const code = FILTER_PACK_CODE_PREFIX + 'qg'; // base64url('\xAA')
    expect(await decodeFilterPackCode(code)).toBeNull();
  });

  it('returns null for a truncated literal in dict method', async () => {
    // method 0x01, then literal escape (0xFF) with claimed length 5 but only 1 byte follows
    const bytes = new Uint8Array([0x01, 0xff, 0x05, 0x61]);
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    const code = FILTER_PACK_CODE_PREFIX + btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(await decodeFilterPackCode(code)).toBeNull();
  });
});

describe('FILTER_PACK_CODE_REGEX', () => {
  it('matches a generated code embedded in tweet text', async () => {
    const code = await encodeFilterPackCode({ phrases: ['crypto', 'engagement bait'] });
    const tweet = `Bouncer users can use this code to import the list: ${code} more text`;
    FILTER_PACK_CODE_REGEX.lastIndex = 0;
    const m = FILTER_PACK_CODE_REGEX.exec(tweet);
    expect(m?.[0]).toBe(code);
  });
});

describe('share-encoding named packs (method 0x02)', () => {
  it('round-trips a named pack with dict-friendly phrases', async () => {
    const pack = { phrases: ['crypto', 'engagement bait'], name: 'Money' };
    const code = await encodeFilterPackCode(pack);
    const decoded = await decodeFilterPackCode(code);
    expect(decoded).toEqual(pack);
  });

  it('round-trips a name containing multibyte UTF-8', async () => {
    const pack = { phrases: ['crypto'], name: 'Crypto 💸 pack' };
    const code = await encodeFilterPackCode(pack);
    const decoded = await decodeFilterPackCode(code);
    expect(decoded).toEqual(pack);
  });

  it('round-trips an empty named pack', async () => {
    const pack = { phrases: [], name: 'Empty' };
    const code = await encodeFilterPackCode(pack);
    const decoded = await decodeFilterPackCode(code);
    expect(decoded).toEqual(pack);
  });

  it('treats whitespace-only names as absent (no 0x02 wrap)', async () => {
    const named = await encodeFilterPackCode({ phrases: ['crypto'], name: '   ' });
    const unnamed = await encodeFilterPackCode({ phrases: ['crypto'] });
    expect(named).toBe(unnamed);
    const decoded = await decodeFilterPackCode(named);
    expect(decoded).toEqual({ phrases: ['crypto'] });
  });

  it('returns null for a truncated 0x02 record', async () => {
    // method 0x02, nameLen 5, only 1 byte of name follows (no inner method).
    const bytes = new Uint8Array([0x02, 0x05, 0x61]);
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    const code = FILTER_PACK_CODE_PREFIX + btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(await decodeFilterPackCode(code)).toBeNull();
  });

  it('returns null for a 0x02 record with zero-length name', async () => {
    // method 0x02, nameLen 0, then inner method 0x00, empty payload.
    const bytes = new Uint8Array([0x02, 0x00, 0x00]);
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    const code = FILTER_PACK_CODE_PREFIX + btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(await decodeFilterPackCode(code)).toBeNull();
  });
});
