// Bouncer - Popup Script

import type { ModelDef, LocalModelStatus, StorageSchema } from '../types';
import { PREDEFINED_MODELS, DEFAULT_MODEL } from '../shared/models';
import { escapeHtml } from '../shared/utils';
import { getStorage, setStorage, removeStorage } from '../shared/storage';
import { asyncHandler } from '../shared/async';

// Storage key for predefined model API kwargs overrides
// Format: { "api:modelName": { key: value, ... }, ... }
let predefinedModelKwargs: Record<string, Record<string, unknown>> = {};

const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  ...(process.env.HAS_IMBUE_BACKEND === 'true' ? { imbue: 'Imbue (Default)' } : {}),
  local: 'Local',
  openrouter: 'OpenRouter',
  openai: 'OpenAI',
  gemini: 'Gemini'
};

// Track local model statuses (per-model)
let localModelStatuses: Record<string, LocalModelStatus> = {};
let webgpuSupported = true;
const isIOSDevice = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

// User-friendly error message mapping for WebLLM errors
const WEBLLM_ERROR_MESSAGES: Record<string, { display: string; hint: string }> = {
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
    hint: 'Your browser or device does not support local AI models.'
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

// Get user-friendly error message for WebLLM errors
function getUserFriendlyError(errorMessage: string | undefined): { display: string; hint: string } {
  if (!errorMessage) return { display: 'Unknown error', hint: 'Try again or switch models.' };

  const lowerError = errorMessage.toLowerCase();
  for (const [pattern, info] of Object.entries(WEBLLM_ERROR_MESSAGES)) {
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

async function init() {
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

  // Check auth status and show appropriate screen (only when Imbue backend is configured)
  if (process.env.HAS_IMBUE_BACKEND === 'true') {
    const signinContainer = document.getElementById('signinContainer');
    const mainContainer = document.getElementById('mainContainer');
    const popupGoogleSignIn = document.getElementById('popupGoogleSignIn');
    try {
      const authResponse: { authenticated?: boolean } = await chrome.runtime.sendMessage({ type: 'getAuthStatus' });
      if (!authResponse?.authenticated) {
        if (signinContainer) signinContainer.style.display = '';
        if (mainContainer) mainContainer.style.display = 'none';

        // Wire up sign-in button
        popupGoogleSignIn?.addEventListener('click', () => { (async () => {
          const result: { success?: boolean } = await chrome.runtime.sendMessage({ type: 'launchGoogleAuth' });
          if (result?.success) {
            if (signinContainer) signinContainer.style.display = 'none';
            if (mainContainer) mainContainer.style.display = '';
            // Continue with normal init
            await loadSettings();
            setupEventListeners();
            await updateOpenRouterStatus();
            await updateRateLimitAlert();
            await updateLocalModelStatus();
            setupLocalModelListeners();
            setupStorageListener();
          }
        })().catch(err => console.error('[Popup] Google sign-in failed:', err)); });
        return;
      }
    } catch {
      // If we can't check auth, show main UI anyway
    }
  }

  await loadSettings();
  setupEventListeners();
  await updateOpenRouterStatus();

  // Check rate limit status and update alert if needed
  await updateRateLimitAlert();

  // Initialize local model UI
  await updateLocalModelStatus();
  setupLocalModelListeners();

  setupStorageListener();
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
    'localModelsEnabled'
  ]);

  // Load predefined model kwargs overrides
  predefinedModelKwargs = data.predefinedModelKwargs || {};

  // API keys
  (document.getElementById('openaiApiKey') as HTMLInputElement).value = data.openaiApiKey || '';
  (document.getElementById('openaiApiBase') as HTMLInputElement).value = data.openaiApiBase || '';
  (document.getElementById('geminiApiKey') as HTMLInputElement).value = data.geminiApiKey || '';
  (document.getElementById('anthropicApiKey') as HTMLInputElement).value = data.anthropicApiKey || '';
  updateAnthropicEnabledUI(!!data.anthropicApiKey);

  // Local models toggle
  const localModelsEnabled = data.localModelsEnabled || false;
  (document.getElementById('enableLocalModels') as HTMLInputElement).checked = localModelsEnabled;
  dropdownState.localModelsEnabled = localModelsEnabled;

  // Update API provider states
  updateApiProviderStates(data);

  // Model selection
  renderModelDropdown(data.customModels || [], data.selectedModel || DEFAULT_MODEL);

  // Update local model section visibility
  updateLocalModelSectionVisibility();
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
  // Note: 'local' is always available (no auth required)
  dropdownState.authenticatedApis = {
    openrouter: !!data.openrouterApiKey,
    openai: !!data.openaiApiKey,
    gemini: !!data.geminiApiKey,
    anthropic: !!data.anthropicApiKey,
    local: true
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
    // For local models, check if local models are enabled
    if (api === 'local') {
      if (!dropdownState.localModelsEnabled) {
        selectModel(DEFAULT_MODEL).catch(err => console.error('[Popup] selectModel failed:', err));
      }
    } else if (!dropdownState.authenticatedApis[api]) {
      // Provider no longer authenticated, reset to default
      selectModel(DEFAULT_MODEL).catch(err => console.error('[Popup] selectModel failed:', err));
    }
  }
}

function setupEventListeners() {

  // Model dropdown
  setupModelDropdown();

  // API provider collapsible headers
  document.querySelectorAll('.api-provider-header').forEach(header => {
    header.addEventListener('click', () => {
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

  // OpenRouter sign in
  document.getElementById('openrouterSignIn')!.addEventListener('click', asyncHandler(startOpenRouterOAuth));

  // OpenRouter sign out
  document.getElementById('openrouterSignOut')!.addEventListener('click', asyncHandler(signOutOpenRouter));

  // Local models toggle
  document.getElementById('enableLocalModels')!.addEventListener('change', (e) => { (async () => {
    const enabled = (e.target as HTMLInputElement).checked;
    dropdownState.localModelsEnabled = enabled;
    await setStorage({ localModelsEnabled: enabled });

    // If disabling local models and a local model was selected, switch to imbue
    if (!enabled && dropdownState.selectedModel?.startsWith('local:')) {
      await selectModel('imbue');
    }

    // Re-render dropdown to show/hide local models
    const data = await getStorage(['customModels', 'selectedModel']);
    renderModelDropdown(data.customModels || [], data.selectedModel || DEFAULT_MODEL);

    // Update local model section visibility
    updateLocalModelSectionVisibility();
  })().catch(err => console.error('[Popup] enableLocalModels change failed:', err)); });

}

// ==================== Custom Model Dropdown ====================

interface DropdownState {
  isOpen: boolean;
  customModels: ModelDef[];
  selectedModel: string;
  localModelsEnabled: boolean;
  authenticatedApis: Record<string, boolean>;
}

const dropdownState: DropdownState = {
  isOpen: false,
  customModels: [],
  selectedModel: DEFAULT_MODEL,
  localModelsEnabled: false,
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

// Show/hide the local model section based on whether a local model is selected
function updateLocalModelSectionVisibility() {
  const localModelSection = document.getElementById('localModelSection')!;
  const isLocalModelSelected = dropdownState.selectedModel?.startsWith('local:');
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

function renderModelDropdown(customModels: ModelDef[], selectedModel: string) {
  // Update state
  dropdownState.customModels = customModels;
  dropdownState.selectedModel = selectedModel;

  // Update selected display text
  const selectedText = document.querySelector('.model-dropdown-text')!;
  if (!selectedModel) {
    selectedText.textContent = 'Select a model';
  } else if (selectedModel === 'imbue') {
    selectedText.textContent = 'Imbue (Default)';
  } else {
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
    // Don't append API name for local models since their display names already include "(Local)"
    const apiSuffix = api === 'local' ? '' : ` (${getApiDisplayName(api)})`;
    selectedText.textContent = `${displayName}${kwargsIndicator}${apiSuffix}`;
  }

  // Build menu items
  const menu = document.getElementById('modelDropdownMenu')!;
  menu.innerHTML = '';

  // Add Imbue option (direct select, no submenu) — only when Imbue backend is configured
  if (process.env.HAS_IMBUE_BACKEND === 'true') {
    const imbueItem = document.createElement('div');
    imbueItem.className = 'model-dropdown-item' + (selectedModel === 'imbue' ? ' selected' : '');
    imbueItem.innerHTML = '<span class="model-dropdown-item-text">Imbue (Default) <span class="free-badge">free</span></span>';
    imbueItem.addEventListener('click', asyncHandler(() => selectModel('imbue')));
    menu.appendChild(imbueItem);
  }

  // Add local models (only show if enabled and WebGPU supported)
  if (dropdownState.localModelsEnabled && webgpuSupported && !isIOSDevice && PREDEFINED_MODELS.local) {
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

      localItem.innerHTML = `<span class="model-dropdown-item-text">${escapeHtml(model.display)} <span class="local-badge">local</span>${statusIndicator}</span>`;
      localItem.addEventListener('click', asyncHandler(() => selectModel(modelKey)));
      menu.appendChild(localItem);
    });

    // Add custom local models (user-added WebLLM models)
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

      localItem.innerHTML = `
        <span class="model-dropdown-item-text">${escapeHtml(model.name)} <span class="local-badge">local</span>${statusIndicator}</span>
        <button class="model-dropdown-item-remove" title="Remove model">&times;</button>
      `;
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
      modelItem.innerHTML = `
        <span class="model-dropdown-item-text">${escapeHtml(model.display)}${freeBadge}</span>
      `;
      modelItem.querySelector('.model-dropdown-item-text')!.addEventListener('click', asyncHandler(() => selectModel(modelKey)));
      menu.appendChild(modelItem);
    });

    // Add custom models directly
    custom.forEach(model => {
      const modelKey = `${api}:${model.name}`;
      const hasKwargs = model.apiKwargs && Object.keys(model.apiKwargs).length > 0;
      const modelItem = document.createElement('div');
      modelItem.className = 'model-dropdown-item' + (selectedModel === modelKey ? ' selected' : '');
      modelItem.innerHTML = `
        <span class="model-dropdown-item-text">${escapeHtml(model.name)}</span>
        <button class="model-dropdown-item-settings${hasKwargs ? ' has-kwargs' : ''}" title="Configure provider options">\u2699</button>
        <button class="model-dropdown-item-remove" title="Remove model">&times;</button>
      `;
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
  modal.innerHTML = `
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
  `;

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
  row.innerHTML = `
    <input type="text" class="api-kwargs-key" placeholder="key" value="${escapeHtml(key)}">
    <input type="text" class="api-kwargs-value" placeholder="value" value="${escapeHtml(value)}">
    <button type="button" class="api-kwargs-remove" title="Remove">&times;</button>
  `;

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
  header.innerHTML = `
    <span class="model-dropdown-item-text">${getApiDisplayName(api)}</span>
    ${isProviderSelected ? '<span class="provider-selected-indicator">&#8226;</span>' : ''}
    <span class="provider-arrow">&#9656;</span>
  `;

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
    modelItem.innerHTML = `
      <span class="model-dropdown-item-text">${escapeHtml(model.display)}${freeBadge}</span>
    `;
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
    modelItem.innerHTML = `
      <span class="model-dropdown-item-text">${escapeHtml(model.name)}</span>
      <button class="model-dropdown-item-settings${hasKwargs ? ' has-kwargs' : ''}" title="Configure provider options">\u2699</button>
      <button class="model-dropdown-item-remove" title="Remove model">&times;</button>
    `;

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
function generateCodeVerifier() {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return base64UrlEncode(array);
}

// Generate SHA-256 code challenge from verifier
async function generateCodeChallenge(verifier: string) {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return base64UrlEncode(new Uint8Array(hash));
}

// Base64 URL encode (no padding, URL-safe characters)
function base64UrlEncode(buffer: Uint8Array) {
  const base64 = btoa(String.fromCharCode(...buffer));
  return base64
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

// Start the OpenRouter OAuth flow
async function startOpenRouterOAuth() {
  const signInBtn = document.getElementById('openrouterSignIn') as HTMLButtonElement;
  signInBtn.disabled = true;
  signInBtn.textContent = 'Signing in...';

  try {
    // Generate PKCE codes
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = await generateCodeChallenge(codeVerifier);

    // Store the verifier temporarily (needed for token exchange)
    await setStorage({ openrouterCodeVerifier: codeVerifier });

    // Get the redirect URL for this extension
    const redirectUrl = chrome.identity.getRedirectURL();

    // Build the authorization URL
    const authUrl = new URL('https://openrouter.ai/auth');
    authUrl.searchParams.set('callback_url', redirectUrl);
    authUrl.searchParams.set('code_challenge', codeChallenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');
    authUrl.searchParams.set('title', 'Bouncer');

    // Launch the OAuth flow
    const responseUrl = await chrome.identity.launchWebAuthFlow({
      url: authUrl.toString(),
      interactive: true
    });

    if (!responseUrl) {
      throw new Error('No response URL from OAuth flow');
    }

    // Extract the authorization code from the response URL
    const url = new URL(responseUrl);
    const code = url.searchParams.get('code');

    if (!code) {
      throw new Error('No authorization code received');
    }

    // Exchange the code for an API key
    await exchangeCodeForKey(code, codeVerifier);

    // Update the UI
    await updateOpenRouterStatus();

  } catch (error: unknown) {
    console.error('OpenRouter OAuth error:', error);

    // Check if user cancelled
    const message = error instanceof Error ? error.message : '';
    if (message.includes('canceled') || message.includes('closed')) {
      // User cancelled — not an error
    }
  } finally {
    // Clean up temporary storage
    await removeStorage('openrouterCodeVerifier');

    // Reset button state
    signInBtn.disabled = false;
    signInBtn.innerHTML = `
      <svg class="openrouter-icon" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M12 2L2 7L12 12L22 7L12 2Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M2 17L12 22L22 17" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M2 12L12 17L22 12" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      Sign in with OpenRouter
    `;
  }
}

// Exchange authorization code for API key
async function exchangeCodeForKey(code: string, codeVerifier: string) {
  const response = await fetch('https://openrouter.ai/api/v1/auth/keys', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      code: code,
      code_verifier: codeVerifier,
      code_challenge_method: 'S256'
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('Token exchange failed:', response.status, errorText);
    throw new Error(`Token exchange failed: ${response.status}`);
  }

  const data = await response.json() as { key?: string };

  if (!data.key) {
    throw new Error('No API key in response');
  }

  // Check if this is the first time authenticating OpenRouter
  const storageData = await getStorage(['openrouterApiKey', 'selectedModel']);
  const isFirstAuth = !storageData.openrouterApiKey;
  const currentModel = storageData.selectedModel || DEFAULT_MODEL;

  // Store the API key
  await setStorage({ openrouterApiKey: data.key });

  // If first authentication and user is on default/no model, auto-switch to Nemotron
  if (isFirstAuth && (currentModel === 'imbue' || !currentModel)) {
    await setStorage({ selectedModel: 'openrouter:nvidia/nemotron-nano-12b-v2-vl:free' });
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
  alert.innerHTML = `
    <div class="rate-limit-alert-content">
      <strong>${config.title}</strong>
      <p>${config.description}</p>
      <ul>
        <li><a href="${config.link}" target="_blank" rel="noopener">${config.linkText}</a></li>
        <li>Or switch to the free Imbue model below</li>
        <li>Or configure a different provider (${config.otherProviders})</li>
      </ul>
    </div>
  `;

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


// ==================== Local Model (WebLLM) ====================

// Get current statuses for all local models from background
async function updateLocalModelStatus() {
  try {
    const response: { statuses?: Record<string, LocalModelStatus>; webgpuSupported?: boolean } = await chrome.runtime.sendMessage({ type: 'getAllLocalModelStatuses' });
    localModelStatuses = response.statuses || {};
    webgpuSupported = response.webgpuSupported !== false;
  } catch (err) {
    console.debug('Failed to get local model statuses:', err);
    localModelStatuses = {};
    webgpuSupported = true; // Assume supported, will be corrected if not
  }
  // Hide the local models toggle on iOS (insufficient memory for local inference)
  // or if WebGPU is not supported
  const localModelsToggle = document.querySelector<HTMLElement>('.local-models-toggle');
  if (localModelsToggle) {
    localModelsToggle.style.display = (webgpuSupported && !isIOSDevice) ? '' : 'none';
  }

  // Always update UI, even on error
  updateLocalModelSectionUI();
}

// Get the currently selected local model (if any)
function getSelectedLocalModel(): ModelDef | null {
  if (!dropdownState.selectedModel || !dropdownState.selectedModel.startsWith('local:')) {
    return null;
  }
  const modelName = dropdownState.selectedModel.split(':')[1];
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

  try {
    await chrome.runtime.sendMessage({ type: 'initializeWebLLM', modelId });
  } catch (err) {
    console.error('[WebLLM] Failed to auto-initialize cached model:', err);
    // Remove from triggered set so it can be retried
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

  if (!webgpuSupported) {
    // WebGPU not supported - show unsupported message
    badge.textContent = 'Unsupported';
    badge.classList.add('error');
    unsupported.style.display = 'block';
    return;
  }

  if (!selectedLocalModel) {
    // No local model selected - show hint to select one
    badge.textContent = 'Select a model';
    notDownloaded.style.display = 'block';
    if (downloadHint) {
      downloadHint.textContent = 'Select a local model from the dropdown above to use local inference.';
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
      autoInitializeCachedModel(selectedLocalModel.name).catch(err => console.error('[WebLLM] autoInitializeCachedModel failed:', err));
      break;

    case 'not_downloaded': {
      badge.textContent = 'Not downloaded';
      notDownloaded.style.display = 'block';
      if (downloadHint) {
        const sizeText = selectedLocalModel.sizeGB ? `(~${selectedLocalModel.sizeGB}GB)` : '';
        downloadHint.textContent = `Download ${selectedLocalModel.display} ${sizeText} to run inference locally without API calls.`;
      }
      const downloadBtn = document.getElementById('downloadLocalModel') as HTMLButtonElement;
      downloadBtn.style.display = 'inline-flex';
      downloadBtn.disabled = false;
      downloadBtn.innerHTML = '<span class="download-icon">&#8595;</span> Download Model';
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
        readyHint.textContent = `${selectedLocalModel.display} is ready for local inference.`;
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

  if (downloadBtn) {
    downloadBtn.addEventListener('click', () => { (async () => {
      const selectedLocalModel = getSelectedLocalModel();
      if (!selectedLocalModel) {
        console.error('No local model selected');
        return;
      }

      downloadBtn.disabled = true;
      downloadBtn.innerHTML = '<span class="download-icon">&#8987;</span> Starting...';

      try {
        await chrome.runtime.sendMessage({ type: 'initializeWebLLM', modelId: selectedLocalModel.name });
      } catch (err) {
        console.error('Failed to start WebLLM download:', err);
        downloadBtn.disabled = false;
        downloadBtn.innerHTML = '<span class="download-icon">&#8595;</span> Download Model';
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
        await chrome.runtime.sendMessage({ type: 'initializeWebLLM', modelId: selectedLocalModel.name });
      } catch (err) {
        console.error('Failed to retry WebLLM download:', err);
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
