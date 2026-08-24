/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { clipForDescribe, installAudioFilter } from '../../src/instagram/audiofilter';

/** What hook.ts posts across the world boundary. */
function announce(filenames: string[], audioUrl: string): void {
  window.dispatchEvent(Object.assign(
    new MessageEvent('message', {
      data: { source: 'bouncer-ig-audio-hook', entries: [{ filenames, audioUrl }] },
    }),
    { source: window },
  ));
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  installAudioFilter();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('the clip the describer asks for', () => {
  // The reel's soundtrack is frequently the only place its subject appears —
  // a talking head over a static frame with no caption described as "a person
  // talking" until this became a third modality on the same request.
  it('is null when the hook has not announced a soundtrack', async () => {
    expect(await clipForDescribe('https://cdn/x/silent_reel.jpg', 500)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('is null for a thumbnail that is not a URL at all', async () => {
    expect(await clipForDescribe('', 500)).toBeNull();
  });

  // The rule the backend asks for in as many words: send without audio rather
  // than delay. A description is on the critical path for what the user reads
  // next, and extraction is a CDN fetch plus a transcode.
  it('gives up rather than making the description wait', async () => {
    announce(['slow_reel.jpg'], 'https://cdn/v/slow.m4a');
    // A fetch that never settles — the CDN hanging, which is the case the
    // deadline exists for.
    fetchMock.mockImplementation(() => new Promise(() => { /* never */ }));

    const started = Date.now();
    const clip = await clipForDescribe('https://cdn/x/slow_reel.jpg', 50);
    expect(clip).toBeNull();
    expect(Date.now() - started).toBeLessThan(1000);
  });

  // MEASURED ON DEVICE. The WebCodecs transcode fails on every reel here
  // ("Decoding failed"), so every clip was the raw fallback cut at the byte
  // budget — and every describe request carrying one came back "Processing
  // failed after multiple attempts". The filter route tolerates a cut-off
  // container because it only needs recognisable sound; a model decoding the
  // whole thing does not.
  it('refuses a truncated container rather than sending one that may not decode', async () => {
    announce(['truncated_reel.jpg'], 'https://cdn/v/truncated.m4a');
    // Far more than the byte budget, so the raw fallback cuts it.
    const huge = new ArrayBuffer(1_400_000);
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: () => Promise.resolve(huge),
    });

    expect(await clipForDescribe('https://cdn/x/truncated_reel.jpg', 2000)).toBeNull();
  });

  // A soundtrack that 404s should not be re-fetched on every scroll-by.
  it('remembers a failure instead of retrying it forever', async () => {
    announce(['broken_reel.jpg'], 'https://cdn/v/broken.m4a');
    fetchMock.mockResolvedValue({ ok: false, status: 404 });

    expect(await clipForDescribe('https://cdn/x/broken_reel.jpg', 500)).toBeNull();
    expect(await clipForDescribe('https://cdn/x/broken_reel.jpg', 500)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // Same join key as everything else in this pipeline: the cover filename,
  // which survives the CDN's signed-URL churn.
  it('joins on the filename, ignoring the query string', async () => {
    announce(['joined_reel.jpg'], 'https://cdn/v/joined.m4a');
    fetchMock.mockResolvedValue({ ok: false, status: 500 });

    await clipForDescribe('https://scontent-a.cdninstagram.com/v/joined_reel.jpg?token=aaa', 500);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
