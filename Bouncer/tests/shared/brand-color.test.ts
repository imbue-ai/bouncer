import { describe, it, expect } from 'vitest';
import {
  DEFAULT_BRAND_COLOR,
  BRAND_COLOR_PRESETS,
  normalizeHexColor,
  hexToRgb,
  rgbToHex,
  hexToRgbChannels,
  hexToDarkRgbChannels,
  relativeLuminance,
  contrastTextColor,
  rgbToHsv,
  hsvToRgb,
} from '../../src/shared/brand-color.js';

describe('normalizeHexColor', () => {
  it('normalizes 6-digit hex with or without # and mixed case', () => {
    expect(normalizeHexColor('#EA8554')).toBe('#ea8554');
    expect(normalizeHexColor('ea8554')).toBe('#ea8554');
    expect(normalizeHexColor('  #ea8554  ')).toBe('#ea8554');
  });

  it('expands 3-digit shorthand', () => {
    expect(normalizeHexColor('#e85')).toBe('#ee8855');
    expect(normalizeHexColor('fff')).toBe('#ffffff');
  });

  it('rejects invalid input', () => {
    expect(normalizeHexColor('')).toBeNull();
    expect(normalizeHexColor('#ea855')).toBeNull();
    expect(normalizeHexColor('#gghhii')).toBeNull();
    expect(normalizeHexColor('rgb(1,2,3)')).toBeNull();
    expect(normalizeHexColor('#ea8554ff')).toBeNull();
  });
});

describe('hexToRgb / rgbToHex', () => {
  it('round-trips the default brand color', () => {
    expect(hexToRgb(DEFAULT_BRAND_COLOR)).toEqual([234, 133, 84]);
    expect(rgbToHex(234, 133, 84)).toBe(DEFAULT_BRAND_COLOR);
  });

  it('clamps and rounds out-of-range channels', () => {
    expect(rgbToHex(-5, 300, 127.6)).toBe('#00ff80');
  });

  it('returns null for invalid hex', () => {
    expect(hexToRgb('nope')).toBeNull();
  });
});

describe('hexToRgbChannels', () => {
  it('matches the --bouncer-brand-rgb format in content.css', () => {
    expect(hexToRgbChannels(DEFAULT_BRAND_COLOR)).toBe('234, 133, 84');
  });

  it('returns null for invalid input', () => {
    expect(hexToRgbChannels('not-a-color')).toBeNull();
  });
});

describe('hexToDarkRgbChannels', () => {
  it('darkens the default orange to approximately the stock light-mode shade', () => {
    // content.css ships 200, 110, 65 as the --bouncer-brand-dark-rgb fallback.
    expect(hexToDarkRgbChannels(DEFAULT_BRAND_COLOR)).toBe('199, 113, 71');
  });

  it('returns null for invalid input', () => {
    expect(hexToDarkRgbChannels('nope')).toBeNull();
  });
});

describe('relativeLuminance / contrastTextColor', () => {
  it('spans 0 (black) to 1 (white)', () => {
    expect(relativeLuminance('#000000')).toBe(0);
    expect(relativeLuminance('#ffffff')).toBeCloseTo(1);
    expect(relativeLuminance('nope')).toBeNull();
  });

  it('keeps white text on every preset', () => {
    for (const preset of BRAND_COLOR_PRESETS) {
      expect(contrastTextColor(preset)).toBe('#ffffff');
    }
  });

  it('flips to black text on very light accents', () => {
    expect(contrastTextColor('#ffffff')).toBe('#000000');
    expect(contrastTextColor('#ffe680')).toBe('#000000'); // pale yellow
    expect(contrastTextColor('#00ffff')).toBe('#000000'); // cyan
  });

  it('stays white on dark and mid accents', () => {
    expect(contrastTextColor('#000000')).toBe('#ffffff');
    expect(contrastTextColor('#1d9bf0')).toBe('#ffffff');
  });
});

describe('rgbToHsv / hsvToRgb', () => {
  it('converts primaries', () => {
    expect(rgbToHsv(255, 0, 0)).toEqual([0, 1, 1]);
    expect(rgbToHsv(0, 255, 0)).toEqual([120, 1, 1]);
    expect(rgbToHsv(0, 0, 255)).toEqual([240, 1, 1]);
    expect(hsvToRgb(0, 1, 1)).toEqual([255, 0, 0]);
    expect(hsvToRgb(120, 1, 1)).toEqual([0, 255, 0]);
    expect(hsvToRgb(240, 1, 1)).toEqual([0, 0, 255]);
  });

  it('handles greys (zero saturation) and black', () => {
    expect(rgbToHsv(128, 128, 128)).toEqual([0, 0, 128 / 255]);
    expect(rgbToHsv(0, 0, 0)).toEqual([0, 0, 0]);
    expect(hsvToRgb(210, 0, 0.5)).toEqual([128, 128, 128]);
  });

  it('wraps hue outside [0, 360)', () => {
    expect(hsvToRgb(360, 1, 1)).toEqual([255, 0, 0]);
    expect(hsvToRgb(-120, 1, 1)).toEqual([0, 0, 255]);
  });

  it('round-trips every preset through HSV and back', () => {
    for (const preset of BRAND_COLOR_PRESETS) {
      const [r, g, b] = hexToRgb(preset)!;
      const [h, s, v] = rgbToHsv(r, g, b);
      expect(rgbToHex(...hsvToRgb(h, s, v))).toBe(preset);
    }
  });
});
