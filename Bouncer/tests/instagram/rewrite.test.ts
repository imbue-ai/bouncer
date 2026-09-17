// The feed-response deletion filter — the pure half of the MAIN-world hook's
// rewrite (src/instagram/rewrite.ts). Payload shapes mirror what the live
// signed-in feed serves: a clips connection under a versioned xdt_api key,
// edges of { node: { media } }, cursors in page_info beside the edges.

import { describe, expect, it } from 'vitest';
import {
  extractClipsEntries,
  filterClipsPayload,
  mediaMatchKeys,
  rewriteClipsText,
} from '../../src/instagram/rewrite';

const CDN = 'https://scontent.cdninstagram.com/v/t51.2885-15';

function media(code: string, opts: { pk?: string; cover?: string } = {}): Record<string, unknown> {
  return {
    pk: opts.pk ?? `9${code.length}00${code.charCodeAt(0)}`,
    code,
    video_duration: 12.3,
    image_versions2: {
      candidates: [
        { url: `${CDN}/${opts.cover ?? `${code}_cover.jpg`}?stp=dst-jpg&_nc_ht=x` },
        { url: `${CDN}/${opts.cover ?? `${code}_cover.jpg`}?stp=dst-jpg_s150x150` },
      ],
    },
  };
}

function clipsPayload(codes: string[]): Record<string, unknown> {
  return {
    data: {
      xdt_api__v1__clips__home__connection_v2: {
        edges: codes.map(code => ({ node: { media: media(code) } })),
        page_info: { end_cursor: 'CURSOR_123', has_next_page: true },
      },
    },
    extensions: { is_final: true },
  };
}

describe('mediaMatchKeys', () => {
  it('names a media by code, id, and every cover filename', () => {
    const keys = mediaMatchKeys(media('DAbc123', { pk: '777', cover: 'thumb_n.jpg' }));
    expect(keys).toContain('DAbc123');
    expect(keys).toContain('777');
    expect(keys).toContain('thumb_n.jpg');
  });
});

describe('filterClipsPayload', () => {
  it('drops an edge by shortcode and leaves the rest in order', () => {
    const payload = clipsPayload(['AAA', 'BBB', 'CCC']);
    const dropped = filterClipsPayload(payload, new Set(['BBB']));
    expect(dropped).toBe(1);
    const conn = (payload.data as Record<string, { edges: { node: { media: { code: string } } }[] }>)
      .xdt_api__v1__clips__home__connection_v2;
    expect(conn.edges.map(e => e.node.media.code)).toEqual(['AAA', 'CCC']);
  });

  it('drops an edge by cover filename — the one name the DOM side always has', () => {
    const payload = clipsPayload(['AAA', 'BBB']);
    const dropped = filterClipsPayload(payload, new Set(['BBB_cover.jpg']));
    expect(dropped).toBe(1);
  });

  it('drops an edge by numeric id', () => {
    const payload = {
      data: {
        clips_connection: {
          edges: [{ node: { media: media('AAA', { pk: '424242' }) } }],
        },
      },
    };
    expect(filterClipsPayload(payload, new Set(['424242']))).toBe(1);
  });

  it('leaves page_info and siblings untouched', () => {
    const payload = clipsPayload(['AAA', 'BBB']);
    filterClipsPayload(payload, new Set(['AAA']));
    const conn = (payload.data as Record<string, { page_info: unknown }>)
      .xdt_api__v1__clips__home__connection_v2;
    expect(conn.page_info).toEqual({ end_cursor: 'CURSOR_123', has_next_page: true });
    expect(payload.extensions).toEqual({ is_final: true });
  });

  it('matches any versioned clips-connection key, not one literal name', () => {
    const payload = {
      data: {
        xdt_api__v1__clips__discover__connection_v9: {
          edges: [{ node: { media: media('AAA') } }],
        },
      },
    };
    expect(filterClipsPayload(payload, new Set(['AAA']))).toBe(1);
  });

  it('filters every clips connection in a payload that carries several', () => {
    const payload = {
      one: { clips_home_connection: { edges: [{ node: { media: media('AAA') } }] } },
      two: { deep: { clips_tab_connection: { edges: [{ node: { media: media('AAA', { pk: '1' }) } }] } } },
    };
    expect(filterClipsPayload(payload, new Set(['AAA']))).toBe(2);
  });

  it('ignores non-clips edges arrays entirely', () => {
    const payload = {
      data: {
        xdt_api__v1__feed__timeline__connection: {
          edges: [{ node: { media: media('AAA') } }],
        },
      },
    };
    expect(filterClipsPayload(payload, new Set(['AAA']))).toBe(0);
  });

  it('tolerates media sitting directly on the node', () => {
    const payload = {
      data: { clips_connection: { edges: [{ node: media('AAA') }] } },
    };
    expect(filterClipsPayload(payload, new Set(['AAA']))).toBe(1);
  });

  it('is a no-op with an empty kill list', () => {
    const payload = clipsPayload(['AAA']);
    expect(filterClipsPayload(payload, new Set())).toBe(0);
  });
});

describe('extractClipsEntries', () => {
  it('lifts each reel with its names, caption, cover, and progressive MP4', () => {
    const m = media('AAA', { pk: '11' });
    m.caption = { text: 'gym motivation #grind' };
    m.video_versions = [
      { url: `${CDN}/AAA_v1.mp4?tok=1`, width: 720 },
      { url: `${CDN}/AAA_v2.mp4?tok=2`, width: 480 },
    ];
    const entries = extractClipsEntries({
      data: { clips_connection: { edges: [{ node: { media: m } }] } },
    });
    expect(entries).toHaveLength(1);
    expect(entries[0].code).toBe('AAA');
    expect(entries[0].caption).toBe('gym motivation #grind');
    expect(entries[0].thumbnailUrl).toContain('AAA_cover.jpg');
    expect(entries[0].videoUrl).toBe(`${CDN}/AAA_v1.mp4?tok=1`);
    expect(entries[0].filenames).toContain('AAA_cover.jpg');
  });

  it('tolerates missing caption and video, keeps payload order', () => {
    const entries = extractClipsEntries(clipsPayload(['AAA', 'BBB']));
    expect(entries.map(e => e.code)).toEqual(['AAA', 'BBB']);
    expect(entries[0].caption).toBe('');
    expect(entries[0].videoUrl).toBeUndefined();
  });

  it('skips media with no cover filenames (nothing to match a verdict on)', () => {
    const entries = extractClipsEntries({
      data: { clips_connection: { edges: [{ node: { media: { code: 'AAA', pk: '1' } } }] } },
    });
    expect(entries).toEqual([]);
  });

  it('does not mutate the payload', () => {
    const payload = clipsPayload(['AAA', 'BBB']);
    const before = JSON.stringify(payload);
    extractClipsEntries(payload);
    expect(JSON.stringify(payload)).toBe(before);
  });

  it('returns nothing for non-clips payloads', () => {
    expect(extractClipsEntries({ data: { user: { id: '1' } } })).toEqual([]);
  });
});

describe('rewriteClipsText', () => {
  it('re-serializes only when something was dropped', () => {
    const text = JSON.stringify(clipsPayload(['AAA', 'BBB', 'CCC']));
    const out = rewriteClipsText(text, new Set(['CCC']));
    expect(out).not.toBeNull();
    expect(out?.dropped).toBe(1);
    const reparsed = JSON.parse(out?.text ?? '') as ReturnType<typeof clipsPayload>;
    const conn = (reparsed.data as Record<string, { edges: unknown[]; page_info: unknown }>)
      .xdt_api__v1__clips__home__connection_v2;
    expect(conn.edges).toHaveLength(2);
    expect(conn.page_info).toEqual({ end_cursor: 'CURSOR_123', has_next_page: true });
    expect(out?.text).not.toContain('CCC');
  });

  it('returns null — hand back the original bytes — when nothing matches', () => {
    const text = JSON.stringify(clipsPayload(['AAA']));
    expect(rewriteClipsText(text, new Set(['ZZZ']))).toBeNull();
  });

  it('returns null for non-JSON, non-object, and clips-free bodies', () => {
    const removed = new Set(['AAA']);
    expect(rewriteClipsText('for (;;);{"clips":1}', removed)).toBeNull();
    expect(rewriteClipsText('{"clips_connection": truncated', removed)).toBeNull();
    expect(rewriteClipsText('{"data":{"user":{"id":"AAA"}}}', removed)).toBeNull();
  });

  it('returns null with an empty kill list without parsing', () => {
    expect(rewriteClipsText(JSON.stringify(clipsPayload(['AAA'])), new Set())).toBeNull();
  });
});
