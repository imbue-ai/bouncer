// Bouncer - Popup Script

import type { ModelDef, LocalModelStatus, StorageSchema, SiteId } from '../types';
import { PREDEFINED_MODELS, DEFAULT_MODEL } from '../shared/models';
import { escapeHtml, parseHTML } from '../shared/utils';
import { getStorage, setStorage, removeStorage, clampThreshold, clampImageThreshold, clampReplyThreshold, aiIntentAutoActive } from '../shared/storage';
import { asyncHandler } from '../shared/async';
import type { PlatformDef } from '../shared/platforms';
import { PLATFORMS, PLATFORMS_FOR_TARGET, enabledStorageKey, isOptionalPlatform } from '../shared/platforms';

// DOM id helpers — keep these in one place so the render path, hydration,
// and change-handlers all agree on the naming convention.
const platformRowId    = (id: SiteId) => `platformProvider${id.charAt(0).toUpperCase()}${id.slice(1)}`;
const platformToggleId = (id: SiteId) => `enable${id.charAt(0).toUpperCase()}${id.slice(1)}`;

// Optional platforms (Instagram) sit behind optional_host_permissions:
// Bouncer has no access to those sites until the user flips the toggle and
// accepts the browser's permission prompt. Their row therefore reads as "on"
// only when BOTH the host permission is granted and the enabled flag isn't
// false — a revoke from chrome://extensions reads back here as off.
async function platformPermissionGranted(p: PlatformDef): Promise<boolean> {
  if (!isOptionalPlatform(p)) return true;
  if (!chrome.permissions?.contains) return false;
  try {
    return await chrome.permissions.contains({ origins: [p.manifestHost] });
  } catch {
    return false;
  }
}

// Platform-specific accordion sub-content (Twitter's "Filter replies",
// YouTube's "Show placeholder", etc.). Add an entry here when a platform
// needs its own row-nested toggle; LinkedIn-style platforms (no sub-row)
// just return ''.
function platformSubContentHTML(id: SiteId): string {
  switch (id) {
    case 'youtube':
      return '<div class="api-provider-content"><label class="checkbox-label">'
        + '<input type="checkbox" id="enableYoutubePlaceholder">'
        + '<span>Show "Filtered by Bouncer" placeholder instead of removing</span>'
        + '</label></div>';
    default:
      return '';
  }
}

// Render the per-platform master-toggle rows into #platformsContainer. The
// accordion expand/collapse handler in this file targets data-platform, so
// the rendered DOM exposes that attribute on each row's header.
function renderPlatformRows(): void {
  const container = document.getElementById('platformsContainer');
  if (!container) return;
  const html = PLATFORMS_FOR_TARGET.map(p => {
    const hasSub = platformSubContentHTML(p.id).length > 0;
    // Optional platforms render off (and dimmed) until loadSettings confirms
    // the host permission is actually granted; the rest stay on by default so
    // existing installs see no change.
    const startChecked = !isOptionalPlatform(p);
    return `
      <div class="api-provider platform-provider${startChecked ? '' : ' disabled'}" id="${platformRowId(p.id)}">
        <div class="api-provider-header" data-platform="${p.id}">
          <span class="api-provider-name">${escapeHtml(p.displayName)}</span>
          <div class="api-provider-header-right">
            <label class="ts-inline" title="Enable Bouncer on ${escapeHtml(p.displayName)}">
              <input type="checkbox" id="${platformToggleId(p.id)}"${startChecked ? ' checked' : ''}>
              <span class="ts-inline-slider" aria-hidden="true"></span>
            </label>
            ${hasSub ? '<span class="api-provider-arrow">&#9662;</span>' : ''}
          </div>
        </div>
        ${platformSubContentHTML(p.id)}
      </div>
    `;
  }).join('');
  container.replaceChildren(parseHTML(html));
}

// Storage key for predefined model API kwargs overrides
// Format: { "api:modelName": { key: value, ... }, ... }
let predefinedModelKwargs: Record<string, Record<string, unknown>> = {};

const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  ...(process.env.HAS_IMBUE_BACKEND === 'true' ? { imbue: 'Imbue (Default)' } : {}),
  local: 'On-Device',
  openrouter: 'OpenRouter',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  gemini: 'Gemini'
};

// Track local model statuses (per-model)
let localModelStatuses: Record<string, LocalModelStatus> = {};
let webgpuSupported = true;
const isIOSDevice = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

// In-app mode detection
const isInAppMode = typeof chrome !== 'undefined' && chrome._polyfilled;

// Model key the "On-Device (E2B)" headline radio writes. In the iOS app the
// native bridge runs the on-device model (iosLocal:, entries injected from
// the Swift registry — see shared/models.ts), everywhere else it's the
// WebGPU litert-lm web build (local:).
const IOS_LOCAL_MODEL = PREDEFINED_MODELS.iosLocal[0];
const LOCAL_RADIO_MODEL_KEY = isInAppMode && IOS_LOCAL_MODEL
  ? `iosLocal:${IOS_LOCAL_MODEL.name}`
  : 'local:gemma-4-E2B-it-web';

// User-friendly error message mapping for local-model errors
const LOCAL_ERROR_MESSAGES: Record<string, { display: string; hint: string }> = {
  'device lost': {
    display: 'GPU device was lost',
    hint: 'Try closing other tabs or restarting your browser.'
  },
  'device destroyed': {
    display: 'GPU device error',
    hint: 'Try closing other GPU-intensive tabs or restart browser.'
  },
  'out of memory': {
    display: 'Not enough GPU memory',
    hint: 'Close other GPU-intensive applications or use a smaller model.'
  },
  'oom': {
    display: 'GPU memory exhausted',
    hint: 'Close other tabs or use a smaller model.'
  },
  'gpu memory': {
    display: 'GPU memory issue',
    hint: 'Try a smaller model or close other GPU-intensive tabs.'
  },
  'webgpu not': {
    display: 'WebGPU not supported',
    hint: 'Your browser or device does not support on-device AI models.'
  },
  'network': {
    display: 'Network error',
    hint: 'Check your internet connection and try again.'
  },
  'download failed': {
    display: 'Download failed',
    hint: 'Check your internet connection and try again.'
  },
  'fetch': {
    display: 'Download failed',
    hint: 'Check your internet connection and try again.'
  },
  'timeout': {
    display: 'Model response timeout',
    hint: 'The model took too long to respond. Try again or use a smaller model.'
  },
  'inference timeout': {
    display: 'Inference timeout',
    hint: 'The model was too slow. Try again or switch to a smaller model.'
  }
};

// Get user-friendly error message for local-model errors
function getUserFriendlyError(errorMessage: string | undefined): { display: string; hint: string } {
  if (!errorMessage) return { display: 'Unknown error', hint: 'Try again or switch models.' };

  const lowerError = errorMessage.toLowerCase();
  for (const [pattern, info] of Object.entries(LOCAL_ERROR_MESSAGES)) {
    if (lowerError.includes(pattern)) {
      return info;
    }
  }
  // If already user-friendly (from background), use as-is
  if (errorMessage.includes('Try ') || errorMessage.includes('Close ') || errorMessage.includes('Check ')) {
    return { display: errorMessage, hint: '' };
  }
  return { display: errorMessage, hint: 'Try again or switch to a different model.' };
}

document.addEventListener('DOMContentLoaded', () => { init().catch(err => console.error('[Popup] Init failed:', err)); });

export async function init() {
  console.log('[Popup] init() called');
  try {
  // Render the registry-driven platform rows into #platformsContainer
  // before any handler tries to find them by id.
  renderPlatformRows();
  const isModal = window.self !== window.top;

  // Detect if we're in an iframe (modal mode)
  if (isModal) {
    document.body.classList.add('modal-mode');

    // Set up close buttons to message parent
    for (const btn of document.querySelectorAll('.modal-close-btn')) {
      btn.addEventListener('click', () => {
        window.parent.postMessage({ type: 'closeSettingsModal' }, '*');
      });
    }

    // Listen for theme message from parent
    window.addEventListener('message', (event) => {
      const data = event.data as { type?: string; theme?: string } | null;
      if (data && data.type === 'setTheme') {
        const theme = data.theme;
        document.body.classList.remove('light-mode', 'dim-mode', 'dark-mode');
        document.body.classList.add(`${theme}-mode`);
      }
    });

    // Report content height changes to parent so iframe can resize dynamically
    const sendSize = () => {
      const height = document.body.scrollHeight + 2;
      window.parent.postMessage({ type: 'settingsResize', height }, '*');
    };
    const resizeObserver = new ResizeObserver(sendSize);
    resizeObserver.observe(document.body);
    sendSize();
  }

  // Check auth status and show appropriate screen.
  //
  // On open-source / BYOK-only builds (HAS_IMBUE_BACKEND !== 'true') there's
  // nothing to sign in to, so the whole sign-in screen is dead code and we
  // skip the round-trip entirely. The background's getAuthStatus returns
  // authenticated:true in that case anyway, but Safari's MV3 message round-
  // trip is flakier than Chrome/Firefox — an undefined response there would
  // surface the sign-in screen with a dead "Activate Bouncer" button. Gating
  // at build time eliminates the failure mode and the bytes.
  const signinContainer = document.getElementById('signinContainer');
  const mainContainer = document.getElementById('mainContainer');
  const popupGoogleSignIn = document.getElementById('popupGoogleSignIn');
  if (process.env.HAS_IMBUE_BACKEND === 'true') {
    try {
      const authResponse: { authenticated?: boolean; isSafari?: boolean } = await chrome.runtime.sendMessage({ type: 'getAuthStatus' });
      if (!authResponse?.authenticated) {
        if (signinContainer) signinContainer.style.display = '';
        if (mainContainer) mainContainer.style.display = 'none';

        // On Safari, show Apple sign-in button instead of Google
        if (authResponse?.isSafari && popupGoogleSignIn) {
          popupGoogleSignIn.replaceChildren(parseHTML(`
            <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" width="18" height="18" style="margin-right: 8px;">
              <path d="M17.05 20.28c-.98.95-2.05.88-3.08.4-1.09-.5-2.08-.48-3.24 0-1.44.62-2.2.44-3.06-.4C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.54 4.09zM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z" fill="currentColor"/>
            </svg>
            Activate Bouncer
          `));
          const explanation = signinContainer?.querySelector('.signin-description');
          if (explanation) explanation.textContent = 'Sign in with Apple to start filtering your feed.';
        }

        // Wire up sign-in button
        popupGoogleSignIn?.addEventListener('click', () => { (async () => {
          const result: { success?: boolean } = await chrome.runtime.sendMessage({ type: 'launchAuth' });
          if (result?.success) {
            if (signinContainer) signinContainer.style.display = 'none';
            if (mainContainer) mainContainer.style.display = '';
            await loadSettings();
            setupEventListeners();
            await updateOpenRouterStatus();
            await updateRateLimitAlert();
            await updateLocalModelStatus();
            setupLocalModelListeners();
            setupStorageListener();
          }
        })().catch(err => console.error('[Popup] Sign-in failed:', err)); });
        return;
      }
    } catch {
      // If we can't check auth, show main UI anyway
    }
  }

  console.log('[Popup] About to loadSettings');
  await loadSettings();
  console.log('[Popup] loadSettings done, setupEventListeners');
  setupEventListeners();
  console.log('[Popup] setupEventListeners done');

  // In-app mode: skip OpenRouter status and rate limit (DOM elements may not exist, messages may hang)
  if (!isInAppMode) {
    await updateOpenRouterStatus();
    await updateRateLimitAlert();
  } else {
    console.log('[Popup] Skipping updateOpenRouterStatus and updateRateLimitAlert in in-app mode');
  }

  // Initialize local model UI
  console.log('[Popup] About to updateLocalModelStatus');
  await updateLocalModelStatus();
  console.log('[Popup] About to setupLocalModelListeners');
  setupLocalModelListeners();

  setupStorageListener();

  // Deep link from the in-feed trial notice ("Download local model"): select
  // the Local radio so its download section is immediately visible. click()
  // runs the exact same selectModel flow as a user tap; a no-op if already
  // selected (checked radios don't re-fire change).
  if (window.location.hash === '#local') {
    const localRadio = document.getElementById('modelRadioLocal') as HTMLInputElement | null;
    if (localRadio && !localRadio.checked) localRadio.click();
  }

  console.log('[Popup] init() completed successfully');
  } catch (e) {
    console.error('[Popup] init() ERROR:', e, (e as Error).stack);
  }
}

function setupStorageListener() {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && changes.authErrorApis) {
      loadSettings().catch(err => console.error('[Popup] loadSettings failed:', err));
    }
    if (areaName === 'local' && changes.localModelStatuses) {
      localModelStatuses = (changes.localModelStatuses.newValue as Record<string, LocalModelStatus>) || {};
      updateLocalModelSectionUI();
      refreshModelDropdownWithLocal().catch(err => console.error('[Popup] refreshModelDropdownWithLocal failed:', err));
    }
    // Parked On-Device choice set/cleared (possibly by the background flipping
    // selectedModel when the download finished) — re-sync radios + panel.
    if (areaName === 'local' && changes.pendingLocalModelSelection) {
      pendingLocalSelection = (changes.pendingLocalModelSelection.newValue as string) || null;
      updateModelRadioUI();
      updateLocalModelSectionVisibility();
      updateLocalModelSectionUI();
    }
    // The inferred AI-removal intent changed — re-sync the passive
    // AI-detection indicator from storage.
    if (areaName === 'local' && AI_DETECTION_UI_KEYS.some(k => changes[k])) {
      getStorage([...AI_DETECTION_UI_KEYS])
        .then(applyAiDetectionUI)
        .catch(err => console.error('[Popup] applyAiDetectionUI failed:', err));
    }
    if (areaName === 'local' && changes.filterReplies) {
      const checked = changes.filterReplies.newValue !== false;
      const el = document.getElementById('enableFilterReplies') as HTMLInputElement | null;
      if (el && el.checked !== checked) el.checked = checked;
    }
    // Per-platform master-toggle storage-change handlers — iterated. For
    // optional platforms the row only turns on if the host permission is
    // actually granted (a storage write alone can't enable them).
    if (areaName === 'local') {
      for (const p of PLATFORMS) {
        const key = enabledStorageKey(p.id);
        const change = changes[key];
        if (!change) continue;
        const apply = (checked: boolean) => {
          const el = document.getElementById(platformToggleId(p.id)) as HTMLInputElement | null;
          if (el && el.checked !== checked) el.checked = checked;
          document.getElementById(platformRowId(p.id))?.classList.toggle('disabled', !checked);
        };
        const checked = change.newValue !== false;
        if (!checked) { apply(false); continue; }
        platformPermissionGranted(p)
          .then(apply)
          .catch(err => console.error(`[Popup] Permission check for ${p.id} failed:`, err));
      }
    }
    if (areaName === 'local' && changes.youtubeShowPlaceholder) {
      const checked = changes.youtubeShowPlaceholder.newValue === true;
      const el = document.getElementById('enableYoutubePlaceholder') as HTMLInputElement | null;
      if (el && el.checked !== checked) el.checked = checked;
    }
    if (areaName === 'local' && changes.aiTextDetectionThreshold) {
      const v = clampThreshold(changes.aiTextDetectionThreshold.newValue);
      const thresholdEl = document.getElementById('aiTextThreshold') as HTMLInputElement | null;
      if (thresholdEl) thresholdEl.value = String(v);
      const valueEl = document.getElementById('aiTextThresholdValue');
      if (valueEl) valueEl.textContent = `${Math.round(v * 100)}%`;
    }
    if (areaName === 'local' && changes.aiTextReplyDetectionThreshold) {
      const v = clampReplyThreshold(changes.aiTextReplyDetectionThreshold.newValue);
      const thresholdEl = document.getElementById('aiTextReplyThreshold') as HTMLInputElement | null;
      if (thresholdEl) thresholdEl.value = String(v);
      const valueEl = document.getElementById('aiTextReplyThresholdValue');
      if (valueEl) valueEl.textContent = `${Math.round(v * 100)}%`;
    }
    // Another surface (a second popup window, the iOS native sheet) changed
    // the model — re-render so the radios and dropdown don't go stale. Skip
    // when the value already matches: that's the echo of our own write.
    if (areaName === 'local' && changes.selectedModel) {
      const v = (changes.selectedModel.newValue as string) || DEFAULT_MODEL;
      if (v !== dropdownState.selectedModel) {
        refreshModelDropdownWithLocal().catch(err => console.error('[Popup] refreshModelDropdownWithLocal failed:', err));
      }
    }
    if (areaName === 'local' && changes.aiImageDetectionThreshold) {
      const v = clampImageThreshold(changes.aiImageDetectionThreshold.newValue);
      const thresholdEl = document.getElementById('aiImageThreshold') as HTMLInputElement | null;
      if (thresholdEl) thresholdEl.value = String(v);
      const valueEl = document.getElementById('aiImageThresholdValue');
      if (valueEl) valueEl.textContent = `${Math.round(v * 100)}%`;
    }
  });
}

async function loadSettings() {
  const data = await getStorage([
    'enabled',
    'selectedModel',
    'customModels',
    'openrouterApiKey',
    'openaiApiKey',
    'openaiApiBase',
    'geminiApiKey',
    'anthropicApiKey',
    'predefinedModelKwargs',
    'authErrorApis',
    'aiTextDetectionThreshold',
    'aiTextReplyDetectionThreshold',
    'aiImageDetectionThreshold',
    'aiFilterIntent',
    'pendingLocalModelSelection',
    'filterReplies',
    'youtubeShowPlaceholder',
    // Per-platform master-switch keys come from the registry.
    ...PLATFORMS.map(p => enabledStorageKey(p.id)),
  ]);

  // Load predefined model kwargs overrides
  predefinedModelKwargs = data.predefinedModelKwargs || {};

  // Parked "On-Device, once downloaded" choice (cleared by the background when
  // the download lands, or by any explicit model selection).
  pendingLocalSelection = data.pendingLocalModelSelection || null;

  // API keys
  (document.getElementById('openaiApiKey') as HTMLInputElement).value = data.openaiApiKey || '';
  (document.getElementById('openaiApiBase') as HTMLInputElement).value = data.openaiApiBase || '';
  (document.getElementById('geminiApiKey') as HTMLInputElement).value = data.geminiApiKey || '';
  (document.getElementById('anthropicApiKey') as HTMLInputElement).value = data.anthropicApiKey || '';
  updateAnthropicEnabledUI(!!data.anthropicApiKey);

  // "Filter replies in conversations" toggle (defaults to true so existing
  // installs keep filtering replies). The content script reads the same
  // key and skips reply evaluation on permalink pages when this is off.
  const filterRepliesEl = document.getElementById('enableFilterReplies') as HTMLInputElement | null;
  if (filterRepliesEl) filterRepliesEl.checked = data.filterReplies !== false;

  // Platform master toggles. Default to true for backwards compatibility.
  // The expanded/disabled visual state mirrors the toggle's value so the
  // row reads as "Bouncer is/isn't doing anything on this platform".
  // Per-platform master-toggle initial hydration — iterated from the
  // registry. Defaults to "checked" (treat missing as true) for backwards
  // compatibility with installs predating this toggle. Optional platforms are
  // additionally gated on their host permission being granted, so a revoke
  // via browser settings reads back as "off" here.
  for (const p of PLATFORMS) {
    const enabled = data[enabledStorageKey(p.id)] !== false
      && await platformPermissionGranted(p);
    const el = document.getElementById(platformToggleId(p.id)) as HTMLInputElement | null;
    if (el) el.checked = enabled;
    document.getElementById(platformRowId(p.id))?.classList.toggle('disabled', !enabled);
  }

  // YouTube placeholder toggle (off by default — match Twitter's "remove"
  // behavior unless the user opts in).
  const ytPlaceholderEl = document.getElementById('enableYoutubePlaceholder') as HTMLInputElement | null;
  if (ytPlaceholderEl) ytPlaceholderEl.checked = data.youtubeShowPlaceholder === true;

  // Passive AI-detection indicator + threshold sliders. On/off state is
  // driven entirely by the inferred AI-removal intent (natural language) —
  // there is no manual toggle.
  applyAiDetectionUI(data);

  const thresholdEl = document.getElementById('aiTextThreshold') as HTMLInputElement | null;
  if (thresholdEl) {
    const v = clampThreshold(data.aiTextDetectionThreshold);
    thresholdEl.value = String(v);
    const valueEl = document.getElementById('aiTextThresholdValue');
    if (valueEl) valueEl.textContent = `${Math.round(v * 100)}%`;
  }
  const replyThresholdEl = document.getElementById('aiTextReplyThreshold') as HTMLInputElement | null;
  if (replyThresholdEl) {
    const v = clampReplyThreshold(data.aiTextReplyDetectionThreshold);
    replyThresholdEl.value = String(v);
    const valueEl = document.getElementById('aiTextReplyThresholdValue');
    if (valueEl) valueEl.textContent = `${Math.round(v * 100)}%`;
  }

  const imageThresholdEl = document.getElementById('aiImageThreshold') as HTMLInputElement | null;
  if (imageThresholdEl) {
    const v = clampImageThreshold(data.aiImageDetectionThreshold);
    imageThresholdEl.value = String(v);
    const valueEl = document.getElementById('aiImageThresholdValue');
    if (valueEl) valueEl.textContent = `${Math.round(v * 100)}%`;
  }

  // Update API provider states
  updateApiProviderStates(data);

  // Model selection
  renderModelDropdown(data.customModels || [], data.selectedModel || DEFAULT_MODEL);

  // Update local model section visibility
  updateLocalModelSectionVisibility();
}

// Storage keys that feed the AI-detection status UI. Kept in one place so the
// hydration path and the storage-change listener stay in sync.
const AI_DETECTION_UI_KEYS = ['aiFilterIntent'] as const;

// Sync the passive AI-detection indicator (and the threshold sliders'
// enabled state) to the inferred AI-removal intent (see
// background/ai-intent.ts). Purely informational — AI detection has no
// manual toggle; it engages and disengages through the user's
// natural-language filter phrases. The popup isn't tied to a platform, so
// this shows the cross-platform union: "On" means detection is engaged on
// at least one platform (per-platform state lives in each page's sparkle).
function applyAiDetectionUI(data: Partial<StorageSchema>) {
  // The AI detectors are Imbue-only (callImbueAiTextDetection), so hide the
  // entire section when the Imbue backend isn't configured at build time.
  const section = document.getElementById('aiDetectionSection');
  if (process.env.HAS_IMBUE_BACKEND !== 'true') {
    if (section) section.style.display = 'none';
    return;
  }

  const on = aiIntentAutoActive(data);
  const indicator = document.getElementById('aiDetectionIndicator');
  if (indicator) indicator.classList.toggle('on', on);
  const stateEl = document.getElementById('aiDetectionIndicatorState');
  if (stateEl) stateEl.textContent = on ? 'On' : 'Off';

  setThresholdBlockEnabled(on);
  setImageThresholdBlockEnabled(on);
}

// Toggle the AI threshold block's disabled visual + interaction state.
// Driven from both the load path and the toggle's change handler so the
// slider always reflects whether the feature is on.
function setThresholdBlockEnabled(enabled: boolean) {
  const block = document.getElementById('aiTextThresholdBlock');
  if (block) block.setAttribute('aria-disabled', enabled ? 'false' : 'true');
  const replyBlock = document.getElementById('aiTextReplyThresholdBlock');
  if (replyBlock) replyBlock.setAttribute('aria-disabled', enabled ? 'false' : 'true');
}

function setImageThresholdBlockEnabled(enabled: boolean) {
  const block = document.getElementById('aiImageThresholdBlock');
  if (block) block.setAttribute('aria-disabled', enabled ? 'false' : 'true');
}

function updateAnthropicEnabledUI(isEnabled: boolean) {
  document.getElementById('anthropicKeyEntry')!.style.display = isEnabled ? 'none' : 'block';
  document.getElementById('anthropicEnabled')!.style.display = isEnabled ? 'block' : 'none';
  document.getElementById('anthropicError')!.style.display = 'none';
  (document.getElementById('anthropicEnableBtn') as HTMLButtonElement).disabled = true;
  (document.getElementById('anthropicEnableBtn') as HTMLButtonElement).textContent = 'Enable';
  (document.getElementById('anthropicEnableBtn') as HTMLButtonElement).classList.remove('verifying');
}

function updateApiProviderStates(data: Partial<StorageSchema>) {
  // Update dropdownState with which APIs are authenticated
  // Note: 'local' and 'iosLocal' are always available (no auth required) —
  // without the iosLocal entry the reset guard below would silently revert
  // the iOS radio's on-device selection to the default on every popup open.
  dropdownState.authenticatedApis = {
    openrouter: !!data.openrouterApiKey,
    openai: !!data.openaiApiKey,
    gemini: !!data.geminiApiKey,
    anthropic: !!data.anthropicApiKey,
    local: true,
    iosLocal: true
  };

  // Get providers with auth errors (object mapping provider name -> boolean)
  const authErrorApis = data.authErrorApis || {};

  // Update OpenRouter badge
  const openrouterBadge = document.getElementById('openrouterStatusBadge')!;
  openrouterBadge.classList.remove('connected', 'auth-error');
  if (authErrorApis.openrouter && data.openrouterApiKey) {
    openrouterBadge.textContent = 'Auth error';
    openrouterBadge.classList.add('auth-error');
  } else if (data.openrouterApiKey) {
    openrouterBadge.textContent = 'Enabled';
    openrouterBadge.classList.add('connected');
  } else {
    openrouterBadge.textContent = 'Not enabled';
  }

  // Update OpenAI badge
  const openaiBadge = document.getElementById('openaiStatusBadge')!;
  openaiBadge.classList.remove('connected', 'auth-error');
  if (authErrorApis.openai && data.openaiApiKey) {
    openaiBadge.textContent = 'Auth error';
    openaiBadge.classList.add('auth-error');
  } else if (data.openaiApiKey) {
    openaiBadge.textContent = 'Enabled';
    openaiBadge.classList.add('connected');
  } else {
    openaiBadge.textContent = 'Not enabled';
  }

  // Update Gemini badge
  const geminiBadge = document.getElementById('geminiStatusBadge')!;
  geminiBadge.classList.remove('connected', 'auth-error');
  if (authErrorApis.gemini && data.geminiApiKey) {
    geminiBadge.textContent = 'Auth error';
    geminiBadge.classList.add('auth-error');
  } else if (data.geminiApiKey) {
    geminiBadge.textContent = 'Enabled';
    geminiBadge.classList.add('connected');
  } else {
    geminiBadge.textContent = 'Not enabled';
  }

  // Update Anthropic badge
  const anthropicBadge = document.getElementById('anthropicStatusBadge')!;
  anthropicBadge.classList.remove('connected', 'auth-error');
  if (authErrorApis.anthropic && data.anthropicApiKey) {
    anthropicBadge.textContent = 'Auth error';
    anthropicBadge.classList.add('auth-error');
  } else if (data.anthropicApiKey) {
    anthropicBadge.textContent = 'Enabled';
    anthropicBadge.classList.add('connected');
  } else {
    anthropicBadge.textContent = 'Not enabled';
  }

  // Check if selected model's provider is still authenticated
  if (dropdownState.selectedModel && dropdownState.selectedModel !== 'imbue') {
    const [api] = dropdownState.selectedModel.split(':');
    if (!dropdownState.authenticatedApis[api]) {
      // Provider no longer authenticated, reset to default
      selectModel(DEFAULT_MODEL).catch(err => console.error('[Popup] selectModel failed:', err));
    }
  }
}

function setupEventListeners() {

  // Headline model radios (Imbue vs Local E2B)
  setupModelRadios();

  // Model dropdown
  setupModelDropdown();

  // API provider + platform collapsible headers. Both reuse the same
  // accordion classes. Clicks that originate inside the inline platform
  // toggle (`.ts-inline`) must not bubble up to the header — otherwise
  // toggling on/off would also collapse/expand the row.
  document.querySelectorAll('.api-provider-header').forEach(header => {
    header.addEventListener('click', (e) => {
      if ((e.target as HTMLElement | null)?.closest('.ts-inline')) return;
      const provider = header.closest('.api-provider');
      provider?.classList.toggle('expanded');
    });
  });

  // OpenAI API key
  document.getElementById('openaiApiKey')!.addEventListener('change', (e) => { (async () => {
    const key = (e.target as HTMLInputElement).value.trim();
    await setStorage({ openaiApiKey: key });
    const data = await getStorage(['openrouterApiKey', 'openaiApiKey', 'openaiApiBase', 'geminiApiKey', 'anthropicApiKey', 'customModels', 'selectedModel', 'authErrorApis']);
    updateApiProviderStates(data);
    renderModelDropdown(data.customModels || [], data.selectedModel || DEFAULT_MODEL);
  })().catch(err => console.error('[Popup] openaiApiKey change failed:', err)); });

  // OpenAI API base URL
  document.getElementById('openaiApiBase')!.addEventListener('change', (e) => { (async () => {
    const base = (e.target as HTMLInputElement).value.trim();
    await setStorage({ openaiApiBase: base });
  })().catch(err => console.error('[Popup] openaiApiBase change failed:', err)); });

  // Anthropic API key - enable/disable button to input field
  const anthropicKeyInput = document.getElementById('anthropicApiKey') as HTMLInputElement;
  const anthropicEnableBtn = document.getElementById('anthropicEnableBtn') as HTMLButtonElement;

  anthropicKeyInput.addEventListener('input', () => {
    anthropicEnableBtn.disabled = !anthropicKeyInput.value.trim();
    document.getElementById('anthropicError')!.style.display = 'none';
  });

  anthropicEnableBtn.addEventListener('click', () => { (async () => {
    const key = anthropicKeyInput.value.trim();
    if (!key) return;

    const errorEl = document.getElementById('anthropicError')!;
    errorEl.style.display = 'none';
    anthropicEnableBtn.disabled = true;
    anthropicEnableBtn.classList.add('verifying');
    anthropicEnableBtn.textContent = 'Verifying...';

    try {
      const requestBody = {
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }]
      };
      const requestHeaders: Record<string, string> = {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      };
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: requestHeaders,
        body: JSON.stringify(requestBody)
      });

      if (!response.ok) {
        const body = await response.text();
        let msg = 'Invalid API key';
        if (response.status === 401 || response.status === 403) {
          msg = 'Invalid API key. Check that your key is correct.';
        } else if (response.status === 429) {
          msg = 'Rate limited. Key looks valid — try again shortly.';
        } else {
          try {
            const parsed = JSON.parse(body) as { error?: { message?: string } };
            msg = parsed.error?.message || `API error (${response.status})`;
          } catch { msg = `API error (${response.status})`; }
        }

        // 429 means the key is valid, just rate limited — allow enabling
        if (response.status === 429) {
          // Clear any stale auth error for anthropic
          const authErrors429 = (await getStorage(['authErrorApis'])).authErrorApis || {};
          if (authErrors429.anthropic) {
            delete authErrors429.anthropic;
            await setStorage({ authErrorApis: authErrors429 });
          }
          await setStorage({ anthropicApiKey: key });
          const data = await getStorage(['openrouterApiKey', 'openaiApiKey', 'geminiApiKey', 'anthropicApiKey', 'customModels', 'selectedModel', 'authErrorApis']);
          updateApiProviderStates(data);
          updateAnthropicEnabledUI(true);
          renderModelDropdown(data.customModels || [], data.selectedModel || DEFAULT_MODEL);
        } else {
          errorEl.textContent = msg;
          errorEl.style.display = 'block';
          anthropicEnableBtn.disabled = false;
        }
      } else {
        // Clear any stale auth error for anthropic
        const authErrorsOk = (await getStorage(['authErrorApis'])).authErrorApis || {};
        if (authErrorsOk.anthropic) {
          delete authErrorsOk.anthropic;
          await setStorage({ authErrorApis: authErrorsOk });
        }
        // Success — save the key
        await setStorage({ anthropicApiKey: key });
        const data = await getStorage(['openrouterApiKey', 'openaiApiKey', 'geminiApiKey', 'anthropicApiKey', 'customModels', 'selectedModel', 'authErrorApis']);
        updateApiProviderStates(data);
        updateAnthropicEnabledUI(true);
        renderModelDropdown(data.customModels || [], data.selectedModel || DEFAULT_MODEL);
      }
    } catch (err) {
      console.error('[Anthropic] Network error during verification:', err);
      errorEl.textContent = 'Network error. Could not reach Anthropic API.';
      errorEl.style.display = 'block';
      anthropicEnableBtn.disabled = false;
    }

    anthropicEnableBtn.classList.remove('verifying');
    anthropicEnableBtn.textContent = 'Enable';
  })().catch(err => console.error('[Popup] Anthropic enable failed:', err)); });

  // Anthropic disable button
  document.getElementById('anthropicDisableBtn')!.addEventListener('click', () => { (async () => {
    await removeStorage('anthropicApiKey');
    anthropicKeyInput.value = '';
    updateAnthropicEnabledUI(false);
    const data = await getStorage(['openrouterApiKey', 'openaiApiKey', 'geminiApiKey', 'anthropicApiKey', 'customModels', 'selectedModel', 'authErrorApis']);
    updateApiProviderStates(data);
    renderModelDropdown(data.customModels || [], data.selectedModel || DEFAULT_MODEL);
  })().catch(err => console.error('[Popup] Anthropic disable failed:', err)); });

  // Gemini API key
  document.getElementById('geminiApiKey')!.addEventListener('change', (e) => { (async () => {
    const key = (e.target as HTMLInputElement).value.trim();
    await setStorage({ geminiApiKey: key });
    const data = await getStorage(['openrouterApiKey', 'openaiApiKey', 'geminiApiKey', 'anthropicApiKey', 'customModels', 'selectedModel', 'authErrorApis']);
    updateApiProviderStates(data);
    renderModelDropdown(data.customModels || [], data.selectedModel || DEFAULT_MODEL);
  })().catch(err => console.error('[Popup] geminiApiKey change failed:', err)); });

  // OpenRouter: Safari has no chrome.identity, so launchWebAuthFlow throws.
  // Show the API-key paste input instead and hide the OAuth button. The
  // input mirrors the same chrome.storage.local.openrouterApiKey field the
  // OAuth flow would have written, so everything downstream is identical.
  const isSafariPopup = /^((?!chrome|android|crios|fxios|edg|opr).)*safari/i.test(navigator.userAgent);
  const isFirefoxPopup = navigator.userAgent.includes('Firefox');

  // Per-store "Rate us" link. HTML defaults to the Chrome Web Store URL;
  // override for Firefox + Safari at runtime.
  const rateUsLink = document.getElementById('rateUsLink') as HTMLAnchorElement | null;
  if (rateUsLink) {
    if (isFirefoxPopup) {
      rateUsLink.href = 'https://addons.mozilla.org/en-US/firefox/addon/bouncer-heal-your-feed/';
    } else if (isSafariPopup) {
      rateUsLink.href = 'https://apps.apple.com/us/app/bouncer-heal-your-feed/id6762687153';
    }
  }
  if (isSafariPopup) {
    const signInBtn = document.getElementById('openrouterSignIn') as HTMLButtonElement | null;
    if (signInBtn) signInBtn.style.display = 'none';
    const keyField = document.getElementById('openrouterApiKeyField');
    if (keyField) keyField.style.display = '';
    const keyInput = document.getElementById('openrouterApiKey') as HTMLInputElement | null;
    if (keyInput) {
      // Seed input from storage (async, but fine — `loadSettings` already
      // populated other inputs before we got here; this is just a backstop).
      getStorage(['openrouterApiKey'])
        .then((d) => { keyInput.value = d.openrouterApiKey || ''; })
        .catch((err) => console.error('[Popup] seed openrouterApiKey failed:', err));
      keyInput.addEventListener('change', (e) => { (async () => {
        const key = (e.target as HTMLInputElement).value.trim();
        await setStorage({ openrouterApiKey: key });
        await updateOpenRouterStatus();
      })().catch(err => console.error('[Popup] openrouterApiKey change failed:', err)); });
    }
  } else {
    document.getElementById('openrouterSignIn')!.addEventListener('click', asyncHandler(startOpenRouterOAuth));
  }

  // OpenRouter sign out
  document.getElementById('openrouterSignOut')!.addEventListener('click', asyncHandler(signOutOpenRouter));

  document.getElementById('enableFilterReplies')?.addEventListener('change', (e) => { (async () => {
    const checked = (e.target as HTMLInputElement).checked;
    await setStorage({ filterReplies: checked });
  })().catch(err => console.error('[Popup] enableFilterReplies change failed:', err)); });

  // Platform master toggles. Iterate the registry instead of one
  // handler-per-platform. Dim the body in-line so the user sees the
  // platform's sub-settings become inert without waiting for storage to
  // round-trip. Persisting drives the content script's gate.
  //
  // Optional platforms first go through the browser's permission prompt.
  // permissions.request() must run inside the user gesture, so it is the
  // first await in the handler. Denying (or dismissing) the prompt snaps the
  // toggle back off. Turning the toggle off keeps the permission — the
  // content script goes inert via storage, and re-enabling is prompt-free.
  //
  // Switching an optional platform on then opens its feed in a new tab, so
  // the user lands on a page where Bouncer is actually running. The content
  // script only exists there once the background has registered it, so we
  // await that sync before opening rather than racing permissions.onAdded.
  for (const p of PLATFORMS) {
    document.getElementById(platformToggleId(p.id))?.addEventListener('change', (e) => {
      (async () => {
        const input = e.target as HTMLInputElement;
        const checked = input.checked;
        // No permission pre-check here: any await before request() can spend
        // the user gesture. request() is a no-op returning true when the
        // origin is already granted.
        if (checked && isOptionalPlatform(p)) {
          let granted = false;
          try {
            granted = await chrome.permissions.request({ origins: [p.manifestHost] });
          } catch (err) {
            console.error(`[Popup] Permission request for ${p.id} failed:`, err);
          }
          if (!granted) {
            input.checked = false;
            return;
          }
        }
        document.getElementById(platformRowId(p.id))?.classList.toggle('disabled', !checked);
        await setStorage({ [enabledStorageKey(p.id)]: checked });
        if (checked && isOptionalPlatform(p)) {
          await chrome.runtime.sendMessage({ type: 'syncOptionalPlatforms' })
            .catch(err => console.error(`[Popup] Optional platform sync for ${p.id} failed:`, err));
          await chrome.tabs.create({ url: p.feedUrl });
        }
      })().catch(err => console.error(`[Popup] ${platformToggleId(p.id)} change failed:`, err));
    });
  }

  document.getElementById('enableYoutubePlaceholder')?.addEventListener('change', (e) => { (async () => {
    const checked = (e.target as HTMLInputElement).checked;
    await setStorage({ youtubeShowPlaceholder: checked });
  })().catch(err => console.error('[Popup] enableYoutubePlaceholder change failed:', err)); });

  // AI-text-detection threshold (range slider). Live-update the percentage
  // display on `input` (every drag tick); persist only on `change` (release)
  // so we don't write to storage 100 times mid-drag.
  const thresholdInputEl = document.getElementById('aiTextThreshold') as HTMLInputElement | null;
  const thresholdValueEl = document.getElementById('aiTextThresholdValue');
  const renderThresholdPercent = (v: number) => {
    if (thresholdValueEl) thresholdValueEl.textContent = `${Math.round(v * 100)}%`;
  };
  thresholdInputEl?.addEventListener('input', (e) => {
    renderThresholdPercent(parseFloat((e.target as HTMLInputElement).value));
  });
  thresholdInputEl?.addEventListener('change', (e) => { (async () => {
    const v = parseFloat((e.target as HTMLInputElement).value);
    if (!Number.isFinite(v)) return;
    const clamped = Math.min(1, Math.max(0, v));
    renderThresholdPercent(clamped);
    await setStorage({ aiTextDetectionThreshold: clamped });
  })().catch(err => console.error('[Popup] aiTextThreshold change failed:', err)); });

  // Reply/comment threshold (applied instead of the one above when the
  // evaluated post is a reply). Same input/change split as its sibling.
  const replyThresholdInputEl = document.getElementById('aiTextReplyThreshold') as HTMLInputElement | null;
  const replyThresholdValueEl = document.getElementById('aiTextReplyThresholdValue');
  const renderReplyThresholdPercent = (v: number) => {
    if (replyThresholdValueEl) replyThresholdValueEl.textContent = `${Math.round(v * 100)}%`;
  };
  replyThresholdInputEl?.addEventListener('input', (e) => {
    renderReplyThresholdPercent(parseFloat((e.target as HTMLInputElement).value));
  });
  replyThresholdInputEl?.addEventListener('change', (e) => { (async () => {
    const v = parseFloat((e.target as HTMLInputElement).value);
    if (!Number.isFinite(v)) return;
    const clamped = Math.min(1, Math.max(0, v));
    renderReplyThresholdPercent(clamped);
    await setStorage({ aiTextReplyDetectionThreshold: clamped });
  })().catch(err => console.error('[Popup] aiTextReplyThreshold change failed:', err)); });

  // AI-image-detection threshold (mirrors the AI text threshold above).
  const imageThresholdInputEl = document.getElementById('aiImageThreshold') as HTMLInputElement | null;
  const imageThresholdValueEl = document.getElementById('aiImageThresholdValue');
  const renderImageThresholdPercent = (v: number) => {
    if (imageThresholdValueEl) imageThresholdValueEl.textContent = `${Math.round(v * 100)}%`;
  };
  imageThresholdInputEl?.addEventListener('input', (e) => {
    renderImageThresholdPercent(parseFloat((e.target as HTMLInputElement).value));
  });
  imageThresholdInputEl?.addEventListener('change', (e) => { (async () => {
    const v = parseFloat((e.target as HTMLInputElement).value);
    if (!Number.isFinite(v)) return;
    const clamped = Math.min(1, Math.max(0, v));
    renderImageThresholdPercent(clamped);
    await setStorage({ aiImageDetectionThreshold: clamped });
  })().catch(err => console.error('[Popup] aiImageThreshold change failed:', err)); });

}

// The user's parked "switch to On-Device once it's downloaded" choice. Mirrors
// the pendingLocalModelSelection storage key; while set, the previous model
// keeps filtering and stays selected in the radios — only the download
// panel and a note under Local reflect the parked choice. The background
// flips selectedModel (and clears the key) when the download completes, so
// the switch happens even if this popup is closed mid-download.
let pendingLocalSelection: string | null = null;

async function clearPendingLocalSelection() {
  if (!pendingLocalSelection) return;
  pendingLocalSelection = null;
  await removeStorage('pendingLocalModelSelection');
}

// True when the model behind the headline Local radio has its weights on
// disk (ready to select outright).
function localRadioModelDownloaded(): boolean {
  const state = localModelStatuses[LOCAL_RADIO_MODEL_KEY.split(':')[1]]?.state;
  return state === 'ready' || state === 'cached';
}

// Wire the headline radios. selectModel() persists, re-renders the dropdown
// (which re-syncs the radios via updateModelRadioUI), clears the
// classification cache, and shows the download section when a not-yet-
// downloaded local model is picked — no radio-specific follow-up needed.
function setupModelRadios() {
  document.getElementById('modelRadioImbue')?.addEventListener('change', asyncHandler(() => selectModel('imbue')));
  document.getElementById('modelRadioLocal')?.addEventListener('change', asyncHandler(async () => {
    // Only switch outright when the model is already on disk (or in the iOS
    // app, where the native sheet owns the download flow). Otherwise park
    // the choice: Cloud stays selected and filtering, and the download
    // panel appears below.
    if (isInAppMode || localRadioModelDownloaded()) {
      await selectModel(LOCAL_RADIO_MODEL_KEY);
      return;
    }
    pendingLocalSelection = LOCAL_RADIO_MODEL_KEY;
    await setStorage({ pendingLocalModelSelection: LOCAL_RADIO_MODEL_KEY });
    updateModelRadioUI();
    updateLocalModelSectionVisibility();
    updateLocalModelSectionUI();
  }));

  // The Imbue option doesn't exist on open-source builds with no Imbue
  // backend (same gate as the dropdown's Imbue entry).
  if (process.env.HAS_IMBUE_BACKEND !== 'true') {
    const row = document.getElementById('modelRadioImbueRow');
    if (row) row.style.display = 'none';
  }
}

// ==================== Custom Model Dropdown ====================

interface DropdownState {
  isOpen: boolean;
  customModels: ModelDef[];
  selectedModel: string;
  authenticatedApis: Record<string, boolean>;
}

const dropdownState: DropdownState = {
  isOpen: false,
  customModels: [],
  selectedModel: DEFAULT_MODEL,
  authenticatedApis: {
    openrouter: false,
    openai: false,
    gemini: false,
    anthropic: false
  }
};

function setupModelDropdown() {
  const dropdown = document.getElementById('modelDropdown')!;
  const selected = document.getElementById('modelDropdownSelected')!;

  // Toggle dropdown on click
  selected.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleDropdown();
  });

  // Close dropdown when clicking outside
  document.addEventListener('click', (e) => {
    if (!dropdown.contains(e.target as Node)) {
      closeDropdown();
    }
  });
}

function toggleDropdown() {
  if (dropdownState.isOpen) {
    closeDropdown();
  } else {
    openDropdown();
  }
}

function openDropdown() {
  dropdownState.isOpen = true;
  document.getElementById('modelDropdown')!.classList.add('open');
}

function closeDropdown() {
  dropdownState.isOpen = false;
  document.getElementById('modelDropdown')!.classList.remove('open');
}

async function selectModel(modelKey: string) {
  // Any explicit selection supersedes a parked "On-Device, once downloaded"
  // choice — without this, the grey pending radio would linger next to
  // whatever the user just picked.
  await clearPendingLocalSelection();
  dropdownState.selectedModel = modelKey;
  await setStorage({ selectedModel: modelKey });
  renderModelDropdown(dropdownState.customModels, modelKey);
  closeDropdown();
  // Clear cache since model changed
  await chrome.runtime.sendMessage({ type: 'clearCache' });

  // Clear auto-init tracking when switching models to allow re-initialization
  autoInitTriggered.clear();

  // Update local model section visibility and UI when selection changes
  updateLocalModelSectionVisibility();
  updateLocalModelSectionUI();

  // Remove rate limit alert if switching away from OpenRouter or if alert exists
  const alert = document.querySelector('.rate-limit-alert');
  if (alert) {
    const isOpenRouter = modelKey.startsWith('openrouter:');
    if (!isOpenRouter) {
      alert.remove();
    }
  }
}

// Show/hide the local model section based on whether a local model is
// selected — or parked as the pending choice, so its download panel is
// reachable before the switch actually happens.
function updateLocalModelSectionVisibility() {
  const localModelSection = document.getElementById('localModelSection')!;
  const isLocalModelSelected = dropdownState.selectedModel?.startsWith('local:')
    || pendingLocalSelection?.startsWith('local:');
  localModelSection.style.display = isLocalModelSelected ? 'block' : 'none';
}

async function removeModel(modelKey: string, e: Event) {
  e.stopPropagation();

  // Parse the model key to find the model to remove
  const [api, ...nameParts] = modelKey.split(':');
  const name = nameParts.join(':');

  const newModels = dropdownState.customModels.filter(
    m => !(m.api === api && m.name === name)
  );
  dropdownState.customModels = newModels;

  // If we're removing the currently selected model, switch to default
  if (dropdownState.selectedModel === modelKey) {
    dropdownState.selectedModel = DEFAULT_MODEL;
    await setStorage({ customModels: newModels, selectedModel: DEFAULT_MODEL });
    // Clear cache since model changed
    await chrome.runtime.sendMessage({ type: 'clearCache' });
  } else {
    await setStorage({ customModels: newModels });
  }

  renderModelDropdown(newModels, dropdownState.selectedModel);
}

function getApiDisplayName(api: string) {
  return PROVIDER_DISPLAY_NAMES[api] || api;
}

function getModelsForProvider(api: string) {
  const predefined = PREDEFINED_MODELS[api] || [];
  const custom = dropdownState.customModels.filter(m => m.api === api);
  return { predefined, custom };
}

// Human-readable label for a selected model key ("api:modelName" or
// "imbue"). Shared by the dropdown's selected text and the radios'
// "set in Advanced" note.
function getModelDisplayLabel(selectedModel: string, customModels: ModelDef[]): string {
  if (!selectedModel) return 'Select a model';
  if (selectedModel === 'imbue') return 'Imbue (Default)';
  // Parse model key (format: api:modelName)
  const [api, ...nameParts] = selectedModel.split(':');
  const modelName = nameParts.join(':');
  // Find display name from predefined models
  const predefinedModel = (PREDEFINED_MODELS[api] || []).find(m => m.name === modelName);
  const displayName = predefinedModel ? predefinedModel.display : modelName;
  // Check if this model has apiKwargs configured (only show indicator for custom models)
  let kwargsIndicator = '';
  if (!predefinedModel) {
    // Only show gear indicator for custom models
    const customModel = customModels.find(m => m.api === api && m.name === modelName);
    const hasKwargs = customModel && customModel.apiKwargs && Object.keys(customModel.apiKwargs).length > 0;
    kwargsIndicator = hasKwargs ? ' \u2699' : '';
  }
  // Don't append API name for local models since their display names already
  // make it clear (and "iosLocal" has no user-facing provider name).
  const apiSuffix = api === 'local' || api === 'iosLocal' ? '' : ` (${getApiDisplayName(api)})`;
  return `${displayName}${kwargsIndicator}${apiSuffix}`;
}

function renderModelDropdown(customModels: ModelDef[], selectedModel: string) {
  // Update state
  dropdownState.customModels = customModels;
  dropdownState.selectedModel = selectedModel;

  // Update selected display text
  const selectedText = document.querySelector('.model-dropdown-text')!;
  selectedText.textContent = getModelDisplayLabel(selectedModel, customModels);

  // Build menu items
  const menu = document.getElementById('modelDropdownMenu')!;
  menu.replaceChildren();

  // Add Imbue option (direct select, no submenu). Hidden in open-source
  // builds with no Imbue backend wired up.
  if (process.env.HAS_IMBUE_BACKEND === 'true') {
    const imbueItem = document.createElement('div');
    imbueItem.className = 'model-dropdown-item' + (selectedModel === 'imbue' ? ' selected' : '');
    imbueItem.replaceChildren(parseHTML('<span class="model-dropdown-item-text">Imbue (Default) <span class="free-badge">free</span></span>'));
    imbueItem.addEventListener('click', asyncHandler(() => selectModel('imbue')));
    menu.appendChild(imbueItem);
  }

  // Add local models (only where the runtime can actually execute them)
  if ((webgpuSupported || isIOSDevice) && PREDEFINED_MODELS.local) {
    // Add predefined local models
    PREDEFINED_MODELS.local.forEach(model => {
      const modelKey = `local:${model.name}`;
      const status = localModelStatuses[model.name] || { state: 'not_downloaded' };
      const isReady = status.state === 'ready' || status.state === 'cached'; // cached models are available for auto-load
      const isDownloading = status.state === 'downloading' || status.state === 'initializing';

      const localItem = document.createElement('div');
      localItem.className = 'model-dropdown-item' + (selectedModel === modelKey ? ' selected' : '');

      // Show different indicators based on status
      let statusIndicator = '';
      if (isDownloading) {
        statusIndicator = '<span class="download-indicator">\u23F3</span>';
      } else if (!isReady) {
        statusIndicator = '<span class="download-indicator">\u2B07</span>';
      }

      localItem.replaceChildren(parseHTML(`<span class="model-dropdown-item-text">${escapeHtml(model.display)} <span class="local-badge">local</span>${statusIndicator}</span>`));
      localItem.addEventListener('click', asyncHandler(() => selectModel(modelKey)));
      menu.appendChild(localItem);
    });

    // Add custom local models (user-added local models)
    const customLocalModels = customModels.filter(m => m.api === 'local');
    customLocalModels.forEach(model => {
      const modelKey = `local:${model.name}`;
      const status = localModelStatuses[model.name] || { state: 'not_downloaded' };
      const isReady = status.state === 'ready' || status.state === 'cached'; // cached models are available for auto-load
      const isDownloading = status.state === 'downloading' || status.state === 'initializing';

      const localItem = document.createElement('div');
      localItem.className = 'model-dropdown-item' + (selectedModel === modelKey ? ' selected' : '');

      // Show different indicators based on status
      let statusIndicator = '';
      if (isDownloading) {
        statusIndicator = '<span class="download-indicator">\u23F3</span>';
      } else if (!isReady) {
        statusIndicator = '<span class="download-indicator">\u2B07</span>';
      }

      localItem.replaceChildren(parseHTML(`
        <span class="model-dropdown-item-text">${escapeHtml(model.name)} <span class="local-badge">local</span>${statusIndicator}</span>
        <button class="model-dropdown-item-remove" title="Remove model">&times;</button>
      `));
      localItem.querySelector('.model-dropdown-item-text')!.addEventListener('click', asyncHandler(() => selectModel(modelKey)));
      localItem.querySelector('.model-dropdown-item-remove')!.addEventListener('click', (e) => { removeModel(modelKey, e).catch(err => console.error('[Popup] removeModel failed:', err)); });
      menu.appendChild(localItem);
    });
  }

  // Count how many alternative APIs are configured and have models
  const providers = ['openai', 'anthropic', 'gemini', 'openrouter'];
  const configuredProviders = providers.filter(api => {
    if (!dropdownState.authenticatedApis[api]) return false;
    const { predefined, custom } = getModelsForProvider(api);
    return predefined.length > 0 || custom.length > 0;
  });

  // If only one alternative API is configured, show models directly (flat list)
  if (configuredProviders.length === 1) {
    const api = configuredProviders[0];
    const { predefined, custom } = getModelsForProvider(api);

    // Add predefined models directly
    predefined.forEach(model => {
      const modelKey = `${api}:${model.name}`;
      const freeBadge = model.isFree ? ' <span class="free-badge">FREE*</span>' : '';
      const modelItem = document.createElement('div');
      modelItem.className = 'model-dropdown-item' + (selectedModel === modelKey ? ' selected' : '');
      modelItem.replaceChildren(parseHTML(`
        <span class="model-dropdown-item-text">${escapeHtml(model.display)}${freeBadge}</span>
      `));
      modelItem.querySelector('.model-dropdown-item-text')!.addEventListener('click', asyncHandler(() => selectModel(modelKey)));
      menu.appendChild(modelItem);
    });

    // Add custom models directly
    custom.forEach(model => {
      const modelKey = `${api}:${model.name}`;
      const hasKwargs = model.apiKwargs && Object.keys(model.apiKwargs).length > 0;
      const modelItem = document.createElement('div');
      modelItem.className = 'model-dropdown-item' + (selectedModel === modelKey ? ' selected' : '');
      modelItem.replaceChildren(parseHTML(`
        <span class="model-dropdown-item-text">${escapeHtml(model.name)}</span>
        <button class="model-dropdown-item-settings${hasKwargs ? ' has-kwargs' : ''}" title="Configure provider options">\u2699</button>
        <button class="model-dropdown-item-remove" title="Remove model">&times;</button>
      `));
      modelItem.querySelector('.model-dropdown-item-text')!.addEventListener('click', asyncHandler(() => selectModel(modelKey)));
      modelItem.querySelector('.model-dropdown-item-settings')!.addEventListener('click', (e) => {
        e.stopPropagation();
        openModelKwargsEditor(modelKey, model.name, false);
      });
      modelItem.querySelector('.model-dropdown-item-remove')!.addEventListener('click', (e) => { removeModel(modelKey, e).catch(err => console.error('[Popup] removeModel failed:', err)); });
      menu.appendChild(modelItem);
    });
  } else if (configuredProviders.length > 1) {
    // Multiple APIs configured - use nested accordion
    configuredProviders.forEach(api => {
      const { predefined, custom } = getModelsForProvider(api);
      const providerItem = createProviderItem(api, predefined, custom, selectedModel);
      menu.appendChild(providerItem);
    });
  }

  // Empty-state placeholder. Fires for fresh installs of open-source
  // builds where nothing has been configured yet (Imbue gated off, no
  // local models enabled, no provider keys, no custom models) — without
  // this the dropdown opens to a blank panel.
  if (menu.childElementCount === 0) {
    const empty = document.createElement('div');
    empty.className = 'model-dropdown-empty';
    empty.textContent = 'Enable a provider below to start filtering';
    menu.appendChild(empty);
  }

  // Keep the headline radios in sync — this is the single funnel every
  // selection/auth change already flows through.
  updateModelRadioUI();
}

// Sync the headline radios (and their notes) with the current selection.
function updateModelRadioUI() {
  const imbueRadio = document.getElementById('modelRadioImbue') as HTMLInputElement | null;
  const localRadio = document.getElementById('modelRadioLocal') as HTMLInputElement | null;
  if (!imbueRadio || !localRadio) return;

  const selected = dropdownState.selectedModel;
  // A parked On-Device choice (model still downloading) leaves the radios
  // showing what's actually filtering — Cloud stays checked, On-Device stays
  // unchecked — and the row's note explains that On-Device activates once
  // the download finishes.
  const localPending = !!pendingLocalSelection && selected !== LOCAL_RADIO_MODEL_KEY;
  imbueRadio.checked = selected === 'imbue';
  localRadio.checked = selected === LOCAL_RADIO_MODEL_KEY;

  // A model picked from the Advanced dropdown matches neither radio —
  // explain where the active selection lives instead of showing two
  // unchecked radios with no context.
  const advancedNote = document.getElementById('modelRadioAdvancedNote');
  if (advancedNote) {
    const isAdvancedSelection = !!selected && !imbueRadio.checked && !localRadio.checked;
    advancedNote.style.display = isAdvancedSelection ? '' : 'none';
    advancedNote.textContent = isAdvancedSelection
      ? `Using ${getModelDisplayLabel(selected, dropdownState.customModels)} (set in Advanced Settings)`
      : '';
  }

  // The On-Device option is first-class but hardware-gated: WebGPU on desktop, the
  // native bridge + enough device RAM in the iOS app (the support flag comes
  // from the Swift registry via the injected catalog). iOS Safari extension
  // mode has neither.
  const localSupported = isInAppMode
    ? (IOS_LOCAL_MODEL?.isSupportedOnThisDevice ?? false)
    : webgpuSupported;
  localRadio.disabled = !localSupported;
  document.getElementById('modelRadioLocalRow')?.classList.toggle('disabled', !localSupported);
  const localNote = document.getElementById('modelRadioLocalNote');
  if (localNote) {
    if (!localSupported) {
      localNote.style.display = '';
      localNote.textContent = 'Not supported on this device.';
    } else if (localPending) {
      localNote.style.display = '';
      localNote.textContent = 'Turns on after the download finishes.';
    } else {
      localNote.style.display = 'none';
      localNote.textContent = '';
    }
  }
}


// Open the kwargs editor modal for a model
function openModelKwargsEditor(modelKey: string, displayName: string, isPredefined: boolean) {
  const [api, ...nameParts] = modelKey.split(':');
  const modelName = nameParts.join(':');

  // Get existing kwargs
  let existingKwargs: Record<string, unknown> = {};
  if (isPredefined) {
    // If user has previously saved custom kwargs for this model, use those directly
    // (this preserves removals of default keys)
    if (modelKey in predefinedModelKwargs) {
      existingKwargs = { ...predefinedModelKwargs[modelKey] };
    } else {
      // Otherwise, use predefined defaults
      const predefinedModel = (PREDEFINED_MODELS[api] || []).find(m => m.name === modelName);
      if (predefinedModel && predefinedModel.apiKwargs) {
        existingKwargs = { ...predefinedModel.apiKwargs };
      }
    }
  } else {
    const customModel = dropdownState.customModels.find(m => m.api === api && m.name === modelName);
    existingKwargs = customModel?.apiKwargs || {};
  }

  // Create modal
  const modal = document.createElement('div');
  modal.className = 'kwargs-editor-modal';
  modal.replaceChildren(parseHTML(`
    <div class="kwargs-editor-content">
      <div class="kwargs-editor-header">
        <span>API Options: ${escapeHtml(displayName)}</span>
        <button class="kwargs-editor-close">&times;</button>
      </div>
      <div class="kwargs-editor-body">
        <p class="hint" style="margin-bottom: 8px;">Configure API parameters (e.g., reasoning_effort, temperature)</p>
        <div class="kwargs-editor-rows"></div>
        <button type="button" class="add-kwargs-btn kwargs-editor-add">+ Add Parameter</button>
      </div>
      <div class="kwargs-editor-actions">
        <button class="cancel-btn kwargs-editor-cancel">Cancel</button>
        <button class="add-btn kwargs-editor-save">Save</button>
      </div>
    </div>
  `));

  document.body.appendChild(modal);

  const rowsContainer = modal.querySelector('.kwargs-editor-rows')!;

  // Add existing kwargs as rows
  const entries = Object.entries(existingKwargs);
  if (entries.length === 0) {
    addKwargsEditorRow(rowsContainer);
  } else {
    entries.forEach(([key, value]) => {
      addKwargsEditorRow(rowsContainer, key, typeof value === 'string' ? value : JSON.stringify(value));
    });
  }

  // Event listeners
  modal.querySelector('.kwargs-editor-close')!.addEventListener('click', () => modal.remove());
  modal.querySelector('.kwargs-editor-cancel')!.addEventListener('click', () => modal.remove());
  modal.querySelector('.kwargs-editor-add')!.addEventListener('click', () => addKwargsEditorRow(rowsContainer));
  modal.querySelector('.kwargs-editor-save')!.addEventListener('click', () => { (async () => {
    const kwargs = collectKwargsFromEditor(rowsContainer);
    await saveModelKwargs(modelKey, kwargs, isPredefined);
    modal.remove();
    // Re-render dropdown to show updated indicators
    renderModelDropdown(dropdownState.customModels, dropdownState.selectedModel);
  })().catch(err => console.error('[Popup] kwargs save failed:', err)); });

  // Close on backdrop click
  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.remove();
  });
}

// Add a row to the kwargs editor
function addKwargsEditorRow(container: Element, key = '', value = '') {
  const row = document.createElement('div');
  row.className = 'api-kwargs-row';
  row.replaceChildren(parseHTML(`
    <input type="text" class="api-kwargs-key" placeholder="key" value="${escapeHtml(key)}">
    <input type="text" class="api-kwargs-value" placeholder="value" value="${escapeHtml(value)}">
    <button type="button" class="api-kwargs-remove" title="Remove">&times;</button>
  `));

  row.querySelector('.api-kwargs-remove')!.addEventListener('click', () => {
    row.remove();
    if (container.querySelectorAll('.api-kwargs-row').length === 0) {
      addKwargsEditorRow(container);
    }
  });

  container.appendChild(row);
}

// Collect kwargs from the editor
function collectKwargsFromEditor(container: Element) {
  const kwargs: Record<string, unknown> = {};
  container.querySelectorAll('.api-kwargs-row').forEach(row => {
    const key = (row.querySelector('.api-kwargs-key') as HTMLInputElement).value.trim();
    const value = (row.querySelector('.api-kwargs-value') as HTMLInputElement).value.trim();
    if (key && value) {
      try {
        kwargs[key] = JSON.parse(value);
      } catch {
        kwargs[key] = value;
      }
    }
  });
  return kwargs;
}

// Save model kwargs
async function saveModelKwargs(modelKey: string, kwargs: Record<string, unknown>, isPredefined: boolean) {
  const [api, ...nameParts] = modelKey.split(':');
  const modelName = nameParts.join(':');

  if (isPredefined) {
    // Always save to predefinedModelKwargs (even if empty) to track that user has customized this model
    // This ensures that if the user removes all defaults, they stay removed
    predefinedModelKwargs[modelKey] = kwargs;
    await setStorage({ predefinedModelKwargs });
  } else {
    // Save to custom model
    const modelIndex = dropdownState.customModels.findIndex(m => m.api === api && m.name === modelName);
    if (modelIndex !== -1) {
      if (Object.keys(kwargs).length > 0) {
        dropdownState.customModels[modelIndex].apiKwargs = kwargs;
      } else {
        delete dropdownState.customModels[modelIndex].apiKwargs;
      }
      await setStorage({ customModels: dropdownState.customModels });
    }
  }

  // Clear cache since model config changed
  await chrome.runtime.sendMessage({ type: 'clearCache' });
}

function createProviderItem(api: string, predefinedModels: ModelDef[], customModels: ModelDef[], selectedModel: string) {
  const item = document.createElement('div');
  item.className = 'model-dropdown-item provider-item';
  item.dataset.provider = api;

  // Check if any model from this provider is selected
  const isProviderSelected = selectedModel.startsWith(`${api}:`);

  // Create header (clickable to expand/collapse)
  const header = document.createElement('div');
  header.className = 'provider-item-header';
  header.replaceChildren(parseHTML(`
    <span class="model-dropdown-item-text">${getApiDisplayName(api)}</span>
    ${isProviderSelected ? '<span class="provider-selected-indicator">&#8226;</span>' : ''}
    <span class="provider-arrow">&#9656;</span>
  `));

  // Toggle expand/collapse on header click
  header.addEventListener('click', (e) => {
    e.stopPropagation();
    item.classList.toggle('expanded');
  });

  item.appendChild(header);

  // Create submenu
  const submenu = document.createElement('div');
  submenu.className = 'model-submenu';

  // Add predefined models
  predefinedModels.forEach(model => {
    const modelKey = `${api}:${model.name}`;
    const freeBadge = model.isFree ? ' <span class="free-badge">FREE*</span>' : '';
    const modelItem = document.createElement('div');
    modelItem.className = 'model-dropdown-item submenu-item' +
      (selectedModel === modelKey ? ' selected' : '');
    modelItem.dataset.model = modelKey;
    modelItem.replaceChildren(parseHTML(`
      <span class="model-dropdown-item-text">${escapeHtml(model.display)}${freeBadge}</span>
    `));
    modelItem.querySelector('.model-dropdown-item-text')!.addEventListener('click', (e) => {
      e.stopPropagation();
      selectModel(modelKey).catch(err => console.error('[Popup] selectModel failed:', err));
    });
    submenu.appendChild(modelItem);
  });

  // Add custom models
  customModels.forEach(model => {
    const modelKey = `${api}:${model.name}`;
    const hasKwargs = model.apiKwargs && Object.keys(model.apiKwargs).length > 0;
    const modelItem = document.createElement('div');
    modelItem.className = 'model-dropdown-item submenu-item' +
      (selectedModel === modelKey ? ' selected' : '');
    modelItem.dataset.model = modelKey;
    modelItem.replaceChildren(parseHTML(`
      <span class="model-dropdown-item-text">${escapeHtml(model.name)}</span>
      <button class="model-dropdown-item-settings${hasKwargs ? ' has-kwargs' : ''}" title="Configure provider options">\u2699</button>
      <button class="model-dropdown-item-remove" title="Remove model">&times;</button>
    `));

    modelItem.querySelector('.model-dropdown-item-text')!.addEventListener('click', (e) => {
      e.stopPropagation();
      selectModel(modelKey).catch(err => console.error('[Popup] selectModel failed:', err));
    });
    modelItem.querySelector('.model-dropdown-item-settings')!.addEventListener('click', (e) => {
      e.stopPropagation();
      openModelKwargsEditor(modelKey, model.name, false);
    });
    modelItem.querySelector('.model-dropdown-item-remove')!.addEventListener('click', (e) => {
      removeModel(modelKey, e).catch(err => console.error('[Popup] removeModel failed:', err));
    });

    submenu.appendChild(modelItem);
  });

  item.appendChild(submenu);

  return item;
}

// ==================== OpenRouter OAuth ====================

// Generate a random code verifier for PKCE
// Start the OpenRouter OAuth flow via background script
async function startOpenRouterOAuth() {
  const signInBtn = document.getElementById('openrouterSignIn') as HTMLButtonElement;
  signInBtn.disabled = true;
  signInBtn.textContent = 'Signing in...';

  try {
    const response: { success?: boolean; error?: string; cancelled?: boolean } =
      await chrome.runtime.sendMessage({ type: 'launchOpenRouterAuth' });

    if (response?.success) {
      await updateOpenRouterStatus();
    } else if (response?.error) {
      console.error('OpenRouter OAuth error:', response.error);
    }
  } catch (error: unknown) {
    console.error('OpenRouter OAuth error:', error);
  } finally {
    signInBtn.disabled = false;
    signInBtn.replaceChildren(parseHTML(`
      <svg class="openrouter-icon" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M12 2L2 7L12 12L22 7L12 2Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M2 17L12 22L22 17" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M2 12L12 17L22 12" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      Sign in with OpenRouter
    `));
  }
}

// Update the UI to show OpenRouter connection status
async function updateOpenRouterStatus() {
  const data = await getStorage(['openrouterApiKey', 'openaiApiKey', 'geminiApiKey', 'anthropicApiKey', 'customModels', 'selectedModel', 'authErrorApis']);
  const signedOutSection = document.getElementById('openrouterSignedOut')!;
  const signedInSection = document.getElementById('openrouterSignedIn')!;

  const isSignedIn = !!data.openrouterApiKey;

  if (isSignedIn) {
    signedOutSection.style.display = 'none';
    signedInSection.style.display = 'block';
  } else {
    signedOutSection.style.display = 'block';
    signedInSection.style.display = 'none';
  }

  // Update all API provider states
  updateApiProviderStates(data);
  renderModelDropdown(data.customModels || [], data.selectedModel || DEFAULT_MODEL);
}

// Sign out from OpenRouter
async function signOutOpenRouter() {
  await removeStorage('openrouterApiKey');
  // Clear the Safari paste-input so re-opening signed-out view doesn't
  // show the stale (just-removed) key.
  const keyInput = document.getElementById('openrouterApiKey') as HTMLInputElement | null;
  if (keyInput) keyInput.value = '';
  await updateOpenRouterStatus();
}

// ==================== Rate Limit Alert ====================

// Configuration for provider-specific rate limit alerts
const RATE_LIMIT_ALERT_CONFIG: Record<string, { title: string; description: string; link: string; linkText: string; otherProviders: string }> = {
  openrouter_credits: {
    title: 'OpenRouter Free Limit Reached',
    description: 'Your OpenRouter account has used all free requests for today. To continue filtering:',
    link: 'https://openrouter.ai/credits',
    linkText: 'Add credits to your OpenRouter account',
    otherProviders: 'OpenAI, Gemini'
  },
  gemini_free_tier: {
    title: 'Gemini Free Limit Reached',
    description: 'Your Gemini usage has exceeded the free tier quota. To continue filtering:',
    link: 'https://ai.google.dev/gemini-api/docs/rate-limits',
    linkText: 'Check your rate limits and upgrade your plan',
    otherProviders: 'OpenAI, OpenRouter'
  }
};

// Check error status from background and show rate limit alert if applicable
async function updateRateLimitAlert() {
  try {
    const status: { errorType?: string | null; subType?: string | null } | null = await chrome.runtime.sendMessage({ type: 'getErrorStatus' });

    if (status?.errorType === 'rate_limit' && status.subType && RATE_LIMIT_ALERT_CONFIG[status.subType]) {
      createRateLimitAlert(status.subType);
    } else {
      clearRateLimitAlert();
    }
  } catch (err) {
    console.debug('Failed to check error status:', err);
  }
}

// Create and show a rate limit alert banner for the given type
function createRateLimitAlert(rateLimitType: string) {
  const config = RATE_LIMIT_ALERT_CONFIG[rateLimitType];
  if (!config) return;

  // Don't add duplicate alerts
  if (document.querySelector(`.rate-limit-alert[data-type="${rateLimitType}"]`)) return;

  // Clear any other rate limit alerts first
  clearRateLimitAlert();

  const alert = document.createElement('div');
  alert.className = 'rate-limit-alert';
  alert.dataset.type = rateLimitType;
  alert.replaceChildren(parseHTML(`
    <div class="rate-limit-alert-content">
      <strong>${config.title}</strong>
      <p>${config.description}</p>
      <ul>
        <li><a href="${config.link}" target="_blank" rel="noopener">${config.linkText}</a></li>
        <li>Or switch to the free Imbue model below</li>
        <li>Or configure a different provider (${config.otherProviders})</li>
      </ul>
    </div>
  `));

  // Insert at the beginning of the container
  const container = document.querySelector('.container');
  if (container) {
    container.insertBefore(alert, container.firstChild);
  }
}

// Clear all rate limit alert banners
function clearRateLimitAlert() {
  const alerts = document.querySelectorAll('.rate-limit-alert');
  for (const alert of alerts) {
    alert.remove();
  }
}


// ==================== Local Model ====================

// Get current statuses for all local models from background
async function updateLocalModelStatus() {
  try {
    const response: { statuses?: Record<string, LocalModelStatus>; webgpuSupported?: boolean } = await chrome.runtime.sendMessage({ type: 'getAllLocalModelStatuses' });
    localModelStatuses = response?.statuses || {};
    webgpuSupported = response?.webgpuSupported !== false;
  } catch (err) {
    console.debug('Failed to get local model statuses:', err);
    localModelStatuses = {};
    webgpuSupported = true; // Assume supported, will be corrected if not
  }

  // Always update UI, even on error. webgpuSupported resolves async, so the
  // radio's disabled state must be refreshed here too, not just from
  // renderModelDropdown.
  updateLocalModelSectionUI();
  updateModelRadioUI();
}

// Get the currently selected local model (if any)
function getSelectedLocalModel(): ModelDef | null {
  // A parked pending choice counts: the download panel below the radios
  // must describe/drive the model the user asked for before it's selected.
  const modelKey = dropdownState.selectedModel?.startsWith('local:')
    ? dropdownState.selectedModel
    : (pendingLocalSelection?.startsWith('local:') ? pendingLocalSelection : null);
  if (!modelKey) {
    return null;
  }
  const modelName = modelKey.split(':')[1];
  // First check predefined models
  const predefinedModel = PREDEFINED_MODELS.local.find(m => m.name === modelName);
  if (predefinedModel) {
    return predefinedModel;
  }
  // Then check custom local models
  const customModel = dropdownState.customModels.find(m => m.api === 'local' && m.name === modelName);
  return customModel || null;
}

// Track which models we've already triggered auto-initialization for to prevent duplicate calls
const autoInitTriggered = new Set<string>();

// Auto-initialize a cached model (called when 'cached' state is detected)
async function autoInitializeCachedModel(modelId: string) {
  // Prevent duplicate initialization triggers
  if (autoInitTriggered.has(modelId)) {
    return;
  }
  autoInitTriggered.add(modelId);

  console.log('[LocalModel] Auto-initializing cached model:', modelId);
  try {
    await chrome.runtime.sendMessage({ type: 'initializeLocalModel', modelId });
  } catch (err) {
    console.error('[LocalModel] Failed to auto-initialize cached model:', err);
    autoInitTriggered.delete(modelId);
  }
}

// Update the local model section UI based on selected model and its status
function updateLocalModelSectionUI() {
  const badge = document.getElementById('localModelStatusBadge')!;
  const unsupported = document.getElementById('localModelUnsupported')!;
  const notDownloaded = document.getElementById('localModelNotDownloaded')!;
  const downloading = document.getElementById('localModelDownloading')!;
  const ready = document.getElementById('localModelReady')!;
  const errorDiv = document.getElementById('localModelError')!;
  const progressFill = document.getElementById('localProgressFill')!;
  const progressText = document.getElementById('localProgressText')!;
  const errorText = document.getElementById('localModelErrorText')!;
  const downloadHint = document.getElementById('localModelDownloadHint');
  const readyHint = document.getElementById('localModelReadyHint');
  const noImageWarning = document.getElementById('localModelNoImageWarning');

  // Hide all states first
  unsupported.style.display = 'none';
  notDownloaded.style.display = 'none';
  downloading.style.display = 'none';
  ready.style.display = 'none';
  errorDiv.style.display = 'none';
  if (noImageWarning) noImageWarning.style.display = 'none';

  // Reset badge classes
  badge.classList.remove('connected', 'downloading', 'ready', 'error', 'auth-error');

  // Check if a local model is selected
  const selectedLocalModel = getSelectedLocalModel();

  const inAppLocalSupported = isInAppMode && (IOS_LOCAL_MODEL?.isSupportedOnThisDevice ?? false);
  if (isInAppMode ? !inAppLocalSupported : !webgpuSupported) {
    // Hardware can't run the local model (no WebGPU on desktop; not enough
    // device RAM in the iOS app) - show unsupported message
    badge.textContent = 'Unsupported';
    badge.classList.add('error');
    unsupported.style.display = 'block';
    if (isInAppMode) {
      const hint = unsupported.querySelector('.hint');
      if (hint) {
        hint.textContent =
          `Local inference isn't available on this iPhone — it requires ${IOS_LOCAL_MODEL?.requiredRAMDisplay ?? '6 GB'}+ RAM.`;
      }
    }
    return;
  }

  if (!selectedLocalModel) {
    // No local model selected - show hint to select one
    badge.textContent = 'Select a model';
    notDownloaded.style.display = 'block';
    if (downloadHint) {
      downloadHint.textContent = 'Choose an on-device model in Advanced Settings.';
    }
    document.getElementById('downloadLocalModel')!.style.display = 'none';
    return;
  }

  // Check if the model supports images and show warning if not
  if (noImageWarning && !selectedLocalModel.supportsImages) {
    noImageWarning.style.display = 'block';
  }

  // Get status for the selected model
  const status = localModelStatuses[selectedLocalModel.name] || { state: 'not_downloaded' };
  const state = status.state || 'not_downloaded';

  switch (state) {
    case 'unsupported':
      badge.textContent = 'Unsupported';
      badge.classList.add('error');
      unsupported.style.display = 'block';
      break;

    case 'cached':
      // Model is cached but not loaded - auto-initialize it
      badge.textContent = 'Loading...';
      badge.classList.add('downloading');
      downloading.style.display = 'block';
      progressFill.style.width = '0%';
      progressText.textContent = 'Loading cached model...';
      // Trigger auto-initialization (async, don't await)
      autoInitializeCachedModel(selectedLocalModel.name).catch(err => console.error('[LocalModel] autoInitializeCachedModel failed:', err));
      break;

    case 'not_downloaded': {
      badge.textContent = 'Not downloaded';
      notDownloaded.style.display = 'block';
      if (downloadHint) {
        const sizeText = selectedLocalModel.sizeGB ? ` (~${selectedLocalModel.sizeGB}GB)` : '';
        downloadHint.textContent = `One-time download${sizeText}.`;
      }
      const downloadBtn = document.getElementById('downloadLocalModel') as HTMLButtonElement;
      downloadBtn.style.display = 'inline-flex';
      downloadBtn.disabled = false;
      downloadBtn.replaceChildren(parseHTML('<span class="download-icon">&#8595;</span> Download Model'));
      break;
    }

    case 'initializing':
    case 'downloading': {
      badge.textContent = 'Downloading...';
      badge.classList.add('downloading');
      downloading.style.display = 'block';
      const progress = status.progress || 0;
      progressFill.style.width = `${(progress * 100).toFixed(1)}%`;
      progressText.textContent = status.text || `${(progress * 100).toFixed(1)}%`;
      break;
    }

    case 'ready':
      badge.textContent = 'Ready';
      badge.classList.add('ready');
      ready.style.display = 'block';
      if (readyHint) {
        readyHint.textContent = 'Model ready.';
      }
      break;

    case 'error': {
      badge.textContent = 'Error';
      badge.classList.add('error');
      errorDiv.style.display = 'block';
      const friendlyError = getUserFriendlyError(status.error);
      const hintText = friendlyError.hint ? ` ${friendlyError.hint}` : '';
      errorText.textContent = (friendlyError.display || 'An error occurred') + hintText;
      break;
    }

    default:
      badge.textContent = 'Unknown';
      notDownloaded.style.display = 'block';
  }
}

// Set up event listeners for local model UI
function setupLocalModelListeners() {
  const downloadBtn = document.getElementById('downloadLocalModel') as HTMLButtonElement | null;
  const retryBtn = document.getElementById('retryLocalModel') as HTMLButtonElement | null;
  console.log('[Popup] setupLocalModelListeners: downloadBtn=', !!downloadBtn, 'retryBtn=', !!retryBtn);

  if (downloadBtn) {
    downloadBtn.addEventListener('click', () => { (async () => {
      const selectedLocalModel = getSelectedLocalModel();
      if (!selectedLocalModel) {
        console.error('No local model selected');
        return;
      }

      console.log('[Popup] Download button clicked, model:', selectedLocalModel.name);
      downloadBtn.disabled = true;
      downloadBtn.replaceChildren(parseHTML('<span class="download-icon">&#8987;</span> Starting...'));

      try {
        console.log('[Popup] Sending initializeLocalModel message for:', selectedLocalModel.name);
        const result: unknown = await chrome.runtime.sendMessage({ type: 'initializeLocalModel', modelId: selectedLocalModel.name });
        console.log('[Popup] initializeLocalModel response:', result);
      } catch (err) {
        console.error('[Popup] Failed to start model download:', err);
        downloadBtn.disabled = false;
        downloadBtn.replaceChildren(parseHTML('<span class="download-icon">&#8595;</span> Download Model'));
      }
    })().catch(err => console.error('[Popup] download click failed:', err)); });
  }

  if (retryBtn) {
    retryBtn.addEventListener('click', () => { (async () => {
      const selectedLocalModel = getSelectedLocalModel();
      if (!selectedLocalModel) {
        console.error('No local model selected');
        return;
      }

      retryBtn.disabled = true;
      retryBtn.textContent = 'Retrying...';

      try {
        await chrome.runtime.sendMessage({ type: 'initializeLocalModel', modelId: selectedLocalModel.name });
      } catch (err) {
        console.error('Failed to retry model download:', err);
        retryBtn.disabled = false;
        retryBtn.textContent = 'Retry';
      }
    })().catch(err => console.error('[Popup] retry click failed:', err)); });
  }

  const cancelBtn = document.getElementById('cancelLocalModelDownload') as HTMLButtonElement | null;
  if (cancelBtn) {
    cancelBtn.addEventListener('click', () => { (async () => {
      const selectedLocalModel = getSelectedLocalModel();
      if (!selectedLocalModel) return;

      cancelBtn.disabled = true;
      try {
        await chrome.runtime.sendMessage({ type: 'cancelLocalModelDownload', modelId: selectedLocalModel.name });
        // Cancelling also un-parks a pending "On-Device, once downloaded" choice
        // — otherwise the radio would stay grey-checked with nothing coming.
        await clearPendingLocalSelection();
        updateModelRadioUI();
        updateLocalModelSectionVisibility();
      } catch (err) {
        console.error('Failed to cancel download:', err);
      }
      cancelBtn.disabled = false;
    })().catch(err => console.error('[Popup] cancel download failed:', err)); });
  }
}

// Refresh model dropdown with current local model statuses
async function refreshModelDropdownWithLocal() {
  const data = await getStorage(['customModels', 'selectedModel']);
  renderModelDropdown(data.customModels || [], data.selectedModel || DEFAULT_MODEL);
}
