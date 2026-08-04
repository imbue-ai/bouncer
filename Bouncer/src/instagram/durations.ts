// How long each reel runs.
//
// The paused card and the transition chooser both want to show a reel's length
// before you commit to watching it — and for the chooser that means reels you
// haven't reached yet, which is the hard half. Instagram only ever keeps 2-3
// <video> elements mounted (see the note in ./frame.ts), so for most of the
// rows on the chooser screen there is no media element to read `duration` off.
//
// So lengths come from two sources, joined on the same key everything else in
// this pipeline uses — the cover thumbnail's filename:
//
//   1. Instagram's own API JSON, which carries `video_duration` on every media
//      object. The MAIN-world hook (./hook.ts) already walks those responses
//      for stream URLs; it posts the duration alongside. This covers reels far
//      below the fold, which is what the chooser needs.
//   2. A mounted <video>'s `duration`, once its metadata loads. Authoritative,
//      but only ever available for the reel you're on and its neighbours.
//
// Neither is guaranteed: a reel whose manifest never came past the hook and
// whose <video> hasn't mounted simply has no length, and the callers render
// without one rather than guessing.

const HOOK_SOURCE = 'bouncer-ig-audio-hook';   // must match hook.ts

// Cover thumbnail filename -> length in seconds.
const byFilename = new Map<string, number>();

// Same join key the audio filter and frame grabber use: the last path segment
// of the cover thumbnail URL, which survives query-string token refreshes.
function fileNameOf(url: string): string | null {
  try {
    const p = new URL(url, location.href).pathname;
    const name = p.slice(p.lastIndexOf('/') + 1);
    return name || null;
  } catch {
    return null;
  }
}

function record(filename: string, seconds: unknown): void {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return;
  byFilename.set(filename, seconds);
}

/** Start listening to the MAIN-world hook for reel lengths. Cheap and passive —
 *  installed even when the fullscreen flow is off, so a rotation into it finds
 *  the lengths already collected. */
export function installDurationSource(): void {
  window.addEventListener('message', (e: MessageEvent) => {
    const data = e.data as
      { source?: string; entries?: { filenames?: string[]; durationSec?: number }[] } | null;
    if (e.source !== window || !data || data.source !== HOOK_SOURCE) return;
    for (const entry of data.entries ?? []) {
      for (const f of entry.filenames ?? []) record(f, entry.durationSec);
    }
  });
}

/** Record a length read straight off a mounted <video>. Overwrites the hook's
 *  value: this one is measured from the media actually being played. */
export function noteDuration(thumbnailUrl: string, seconds: number): void {
  const f = fileNameOf(thumbnailUrl);
  if (f) record(f, seconds);
}

/** The reel's length in seconds, or null if neither source has one yet. */
export function durationFor(thumbnailUrl: string): number | null {
  const f = fileNameOf(thumbnailUrl);
  const d = f === null ? undefined : byFilename.get(f);
  return d ?? null;
}

/** "0:07", "1:23". Empty string for anything unusable, so callers can render
 *  the result unconditionally and get nothing when there's nothing to say. */
export function formatDuration(seconds: number | null | undefined): string {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return '';
  const total = Math.round(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
