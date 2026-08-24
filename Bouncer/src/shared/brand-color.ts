// Bouncer brand accent color — user-customizable via the popup's
// "Accent Color" picker. Shared between the popup (picker UI) and the
// content script (applies the choice to the in-feed UI).
//
// The chosen color is stored in chrome.storage.local under `brandColor` as a
// normalized "#rrggbb" hex string. The content script converts it to raw RGB
// channels and overrides the `--bouncer-brand-rgb` CSS variable that
// content.css defines on :root; every accent usage (panel outline, CTA
// buttons, focus rings, brand icons) flows through that variable.

/** Default brand orange. Must match the `--bouncer-brand-rgb` fallback in
 *  content.css's :root (234, 133, 84). */
export const DEFAULT_BRAND_COLOR = '#ea8554';

/** Preset swatches offered by the popup picker. First entry is the default. */
export const BRAND_COLOR_PRESETS: readonly string[] = [
  DEFAULT_BRAND_COLOR, // Bouncer orange
  '#f4212e', // red
  '#f59e0b', // amber
  '#22c55e', // green
  '#1d9bf0', // Twitter blue
  '#6366f1', // indigo
  '#8b5cf6', // violet
  '#ec4899', // pink
];

/** Normalize a user-entered hex color ("EA8554", "#ea8554", "#e85") to
 *  lowercase "#rrggbb". Returns null for anything else. */
export function normalizeHexColor(input: string): string | null {
  const m = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(input.trim());
  if (!m) return null;
  let hex = m[1].toLowerCase();
  if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
  return `#${hex}`;
}

/** "#rrggbb" → [r, g, b] in 0-255. Returns null unless the input normalizes. */
export function hexToRgb(input: string): [number, number, number] | null {
  const hex = normalizeHexColor(input);
  if (!hex) return null;
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

/** [r, g, b] (clamped/rounded to 0-255) → "#rrggbb". */
export function rgbToHex(r: number, g: number, b: number): string {
  const c = (v: number) =>
    Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** "#rrggbb" → "r, g, b" channel list for the --bouncer-brand-rgb variable
 *  (which is consumed as both rgb(var(...)) and rgba(var(...), a)).
 *  Returns null unless the input normalizes. */
export function hexToRgbChannels(input: string): string | null {
  const rgb = hexToRgb(input);
  return rgb ? rgb.join(', ') : null;
}

/** Darkened variant for --bouncer-brand-dark-rgb: light mode uses a deeper
 *  shade of the accent (better contrast on white) for outlines, the active
 *  sparkle, and badge backgrounds. 0.85 per channel reproduces the stock
 *  pairing: default orange 234,133,84 darkens to ≈ the hand-picked
 *  200,110,65 that content.css ships as the fallback. */
export function hexToDarkRgbChannels(input: string): string | null {
  const rgb = hexToRgb(input);
  return rgb ? rgb.map(c => Math.round(c * 0.85)).join(', ') : null;
}

/** WCAG relative luminance of a hex color: 0 (black) to 1 (white). */
export function relativeLuminance(input: string): number | null {
  const rgb = hexToRgb(input);
  if (!rgb) return null;
  const [r, g, b] = rgb.map(c => {
    const cn = c / 255;
    return cn <= 0.03928 ? cn / 12.92 : Math.pow((cn + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Text color for content sitting ON the accent (badge pills, filled
 *  buttons): white on most accents, black once the accent is light enough
 *  that white text loses contrast. The 0.45 luminance threshold keeps white
 *  text on every preset (the lightest, amber #f59e0b, is ≈0.41) and flips
 *  only for genuinely pale picks. Backs --bouncer-brand-contrast. */
export function contrastTextColor(input: string): '#000000' | '#ffffff' {
  const luminance = relativeLuminance(input);
  return luminance !== null && luminance > 0.45 ? '#000000' : '#ffffff';
}

/** RGB (0-255) → HSV with h in [0, 360), s and v in [0, 1]. */
export function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === rn) h = 60 * (((gn - bn) / d) % 6);
    else if (max === gn) h = 60 * ((bn - rn) / d + 2);
    else h = 60 * ((rn - gn) / d + 4);
  }
  if (h < 0) h += 360;
  const s = max === 0 ? 0 : d / max;
  return [h, s, max];
}

/** HSV (h in [0, 360], s and v in [0, 1]) → RGB in 0-255. */
export function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const hh = ((h % 360) + 360) % 360;
  const c = v * s;
  const x = c * (1 - Math.abs(((hh / 60) % 2) - 1));
  const m = v - c;
  let rn = 0, gn = 0, bn = 0;
  if (hh < 60) { rn = c; gn = x; }
  else if (hh < 120) { rn = x; gn = c; }
  else if (hh < 180) { gn = c; bn = x; }
  else if (hh < 240) { gn = x; bn = c; }
  else if (hh < 300) { rn = x; bn = c; }
  else { rn = c; bn = x; }
  return [
    Math.round((rn + m) * 255),
    Math.round((gn + m) * 255),
    Math.round((bn + m) * 255),
  ];
}
