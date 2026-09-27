// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { popupStorageKeys, setupJevSettings } from '../../src/popup/index.js';

function installJevControls(): HTMLSelectElement {
  document.body.replaceChildren();
  const route = document.createElement('select');
  route.id = 'jevRoute';
  for (const value of ['openrouter', 'typesafe']) {
    const option = document.createElement('option');
    option.value = value;
    route.appendChild(option);
  }
  route.value = 'openrouter';
  route.dataset.savedRoute = 'openrouter';
  document.body.appendChild(route);

  for (const id of ['jevHelpfulBadge', 'jevHideUnhelpful', 'jevHideHateful']) {
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.id = id;
    document.body.appendChild(input);
  }
  const directField = document.createElement('div');
  directField.id = 'typesafeApiKeyField';
  document.body.appendChild(directField);
  const routerHint = document.createElement('div');
  routerHint.id = 'jevOpenRouterKeyHint';
  document.body.appendChild(routerHint);
  return route;
}

describe('Jev settings permissions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (chrome as unknown as { permissions: { request: Mock } }).permissions = {
      request: vi.fn(),
    };
  });

  it('does not request the TypeSafe credential for native in-page settings', () => {
    expect(popupStorageKeys(false)).not.toContain('typesafeApiKey');
    expect(popupStorageKeys(true)).toContain('typesafeApiKey');
  });

  it('keeps the prior route when permission is denied for an enabled feature', async () => {
    const route = installJevControls();
    (document.getElementById('jevHelpfulBadge') as HTMLInputElement).checked = true;
    (chrome.permissions.request as Mock).mockResolvedValue(false);
    setupJevSettings();

    route.value = 'typesafe';
    route.dispatchEvent(new Event('change'));

    await vi.waitFor(() => {
      expect(chrome.permissions.request).toHaveBeenCalledWith({
        origins: ['https://api.typesafe.ai/*'],
      });
      expect(route.value).toBe('openrouter');
    });
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
  });

  it('persists a route after permission is granted for an enabled feature', async () => {
    const route = installJevControls();
    (document.getElementById('jevHideHateful') as HTMLInputElement).checked = true;
    (chrome.permissions.request as Mock).mockResolvedValue(true);
    setupJevSettings();

    route.value = 'typesafe';
    route.dispatchEvent(new Event('change'));

    await vi.waitFor(() => expect(chrome.storage.local.set).toHaveBeenCalledWith({
      jevRoute: 'typesafe',
    }));
    expect(route.dataset.savedRoute).toBe('typesafe');
  });
});
