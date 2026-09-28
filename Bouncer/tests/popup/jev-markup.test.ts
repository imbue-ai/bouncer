// @vitest-environment happy-dom

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const popupHtml = readFileSync(resolve(process.cwd(), 'popup.html'), 'utf8')
  .replace(/<link\b[^>]*>/gi, '');
const popup = new DOMParser().parseFromString(popupHtml, 'text/html');

describe('Jev settings markup', () => {
  it('is opt-in and keeps the direct credential in a password field', () => {
    const section = popup.getElementById('jevSettingsSection');
    expect(section).not.toBeNull();
    expect(section?.closest('#advancedSettingsContent')).not.toBeNull();

    for (const id of ['jevHelpfulBadge', 'jevHideUnhelpful', 'jevHideHateful']) {
      const input = popup.getElementById(id) as HTMLInputElement | null;
      expect(input?.type).toBe('checkbox');
      expect(input?.checked).toBe(false);
    }

    const key = popup.getElementById('typesafeApiKey') as HTMLInputElement | null;
    expect(key?.type).toBe('password');
    expect(key?.autocomplete).toBe('off');
    expect(popup.getElementById('typesafeApiKeyField')?.getAttribute('style')).toContain('display: none');
  });

  it('ships conservative default thresholds that match the policy defaults', () => {
    const value = (id: string) =>
      Number((popup.getElementById(id) as HTMLInputElement | null)?.value);
    expect(value('jevHelpfulBadgeThreshold')).toBe(0.75);
    expect(value('jevUnhelpfulThreshold')).toBe(0.25);
    expect(value('jevHatefulThreshold')).toBe(0.8);
  });
});
