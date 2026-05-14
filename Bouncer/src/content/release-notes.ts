// Release notes shown in the "What's new" banner inside the filter box.
// Each entry targets a specific platform because Chrome/Safari and iOS have
// drifted in functionality (e.g. iOS has no local inference) and the notes
// users see should match the build they're running.
//
// Add an entry here whenever you bump manifest.json's version and want users
// to see what changed. `version` must match the manifest version exactly.
// If no entry matches the current (version, platform) pair, no banner is
// shown and lastSeenVersion advances silently.

export type ReleaseNotePlatform = 'desktop' | 'ios';

export interface ReleaseNote {
  version: string;
  platform: ReleaseNotePlatform;
  title: string;
  bullets: string[];
}

export const RELEASE_NOTES: ReleaseNote[] = [
  {
    version: '1.1.1',
    platform: 'desktop',
    title: "What's new in Bouncer",
    bullets: [
      'Share filters.',
      'Experimental AI Text Detection',
    ],
  },
];

export function getReleaseNote(version: string, platform: ReleaseNotePlatform): ReleaseNote | undefined {
  return RELEASE_NOTES.find(n => n.version === version && n.platform === platform);
}
