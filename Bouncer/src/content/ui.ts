// All UI injection, modals, alerts, theming, filter phrase management

import { ALERT_CONFIG } from '../shared/alerts';
import { asyncHandler } from '../shared/async';
import { cleanReasoning, escapeHtml, formatPostForEvaluation } from '../shared/utils';
import type { AlertState, BackgroundToContentMessage, ContentUIDeps, FilteredPost, PostContent, AlertDisplayConfig, LocalModelStatus } from '../types';
import { getStorage, getDescriptions, setDescriptions } from '../shared/storage';

// Dependencies (set by initUI from index.ts)
let _deps: ContentUIDeps;

export function initUI(deps: ContentUIDeps) {
  _deps = deps;

  // Listen for auth state changes from background
  chrome.runtime.onMessage.addListener((message: BackgroundToContentMessage) => {
    if (message.type === 'authStateChanged') {
      isAuthenticated = message.authenticated;
      if (isAuthenticated) {
        refreshAllFilterBoxes();
      }
    }
  });
}

// Must be called before injecting filter boxes
export { checkAuthStatus };

// ==================== UI State ====================

// Filtered posts storage
const filteredPosts: FilteredPost[] = [];
const filteredPostKeys = new Set<string>();

let filteredTabActive = false;
let filteredModalBackdrop: HTMLElement | null = null;
let filteredViewContainer: HTMLElement | null = null;
let filterPhrasesContainer: HTMLElement | null = null;
let bottomFilterContainer: HTMLElement | null = null;
let mobileFilterContainer: HTMLElement | null = null;
let bottomFilterExpanded = true;
let settingsModal: HTMLElement | null = null;


let activePopup: HTMLElement | null = null;
let toastContainer: HTMLElement | null = null;
const annoyingReasonsCache: WeakMap<HTMLElement, Promise<{ reasons: string[]; hadImages?: boolean }>> = new WeakMap();

// Unified alert state
export const alertState: AlertState = {
  latency: { isHighLatency: false, medianLatency: 0, selectedModel: 'imbue', hasAlternativeApis: false },
  error: { type: null, subType: null, count: 0, apiDisplayName: null, selectedModel: 'imbue', hasAlternativeApis: false },
  queue_backlog: { pendingCount: 0, isLocalModel: false, modelInitializing: false }
};

// Track previous count for animation
let previousFilteredCount = 0;

// Track current model loading state

// Track if we've shown the API key warning
let apiKeyWarningShown = false;

// ==================== Auth State ====================

let isAuthenticated = false;

// Check auth status from background and cache it
async function checkAuthStatus() {
  try {
    const response: { authenticated?: boolean } = await chrome.runtime.sendMessage({ type: 'getAuthStatus' });
    isAuthenticated = response?.authenticated ?? false;
  } catch {
    isAuthenticated = false;
  }
  return isAuthenticated;
}

// Launch Google sign-in via background script
async function launchGoogleSignIn() {
  try {
    const response: { success?: boolean } = await chrome.runtime.sendMessage({ type: 'launchGoogleAuth' });
    if (response?.success) {
      isAuthenticated = true;
      // Re-inject all filter boxes to switch from sign-in to normal UI
      refreshAllFilterBoxes();
    }
  } catch (err) {
    console.error('[Bouncer] Sign-in failed:', err);
  }
}

// Destroy and re-create all filter box UIs (after auth state change)
function refreshAllFilterBoxes() {
  if (filterPhrasesContainer && filterPhrasesContainer.isConnected) {
    filterPhrasesContainer.remove();
  }
  filterPhrasesContainer = null;

  if (bottomFilterContainer && bottomFilterContainer.isConnected) {
    bottomFilterContainer.remove();
  }
  bottomFilterContainer = null;

  if (mobileFilterContainer && mobileFilterContainer.isConnected) {
    mobileFilterContainer.remove();
  }
  mobileFilterContainer = null;

  injectFilterPhrasesInput();
  injectBottomFilterBox();
  injectMobileFilterBox();

  // Trigger post processing now that we're authenticated
  if (isAuthenticated && _deps.processExistingPosts) {
    _deps.processExistingPosts();
  }
}

// HTML for the sign-in state shown inside filter boxes
function getSignInHTML() {
  return `
    <div class="filter-phrases-container">
      <span class="filter-phrases-box-name">Bouncer</span>
      <div class="filter-signin-prompt">
        <button class="google-signin-btn">
          <svg class="google-icon" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
            <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/>
            <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
            <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
            <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
          </svg>
          Activate Bouncer
        </button>
        <p class="ff-signin-explanation">Google sign-in helps us prevent abuse</p>
      </div>
    </div>
  `;
}

// Wire up the sign-in button click handler inside a container
function setupSignInButton(container: HTMLElement) {
  const btn = container.querySelector('.google-signin-btn');
  if (btn) {
    btn.addEventListener('click', asyncHandler(launchGoogleSignIn));
  }
}

// ==================== Placeholder animation ====================

const PLACEHOLDER_PHRASES = ['politics', 'negativity', 'pessimism', 'political outrage', 'ragebait', 'humblebragging', 'virtue signaling', 'idolizing elites', 'Elon Musk'];
const PLACEHOLDER_DURATION = 10; // seconds for full cycle

// Build placeholder HTML and inject dynamic keyframes once
const placeholderItemsHTML = [...PLACEHOLDER_PHRASES, PLACEHOLDER_PHRASES[0]]
  .map(p => `<span>${p}</span>`).join('');
const placeholderHTML = `<span class="filter-input-wrapper"><input type="text" class="filter-phrases-input"><span class="filter-placeholder-cycle" aria-hidden="true"><span class="filter-placeholder-track">${placeholderItemsHTML}</span></span></span>`;

function injectPlaceholderKeyframes() {
  const n = PLACEHOLDER_PHRASES.length;
  const step = 100 / n;
  const holdPct = 0.8; // fraction of each step spent holding
  const frames: string[] = [];
  for (let i = 0; i < n; i++) {
    const start = step * i;
    const holdEnd = start + step * holdPct;
    frames.push(`${start}%, ${holdEnd}% { transform: translateY(calc(-1.2em * ${i})); }`);
  }
  frames.push(`100% { transform: translateY(calc(-1.2em * ${n})); }`);
  const style = document.createElement('style');
  const duration = (PLACEHOLDER_DURATION / 5) * n; // scale with phrase count
  style.textContent = `
    @keyframes ff-placeholder-scroll { ${frames.join(' ')} }
    .filter-placeholder-track { animation-duration: ${duration}s; }
  `;
  document.head.appendChild(style);
}

// Inject keyframes on load
injectPlaceholderKeyframes();

// ==================== State Accessors ====================

export function getFilteredPosts() { return filteredPosts; }
export function getFilteredTabActive() { return filteredTabActive; }

export function updateAlertState<K extends keyof AlertState>(type: K, state: AlertState[K]) {
  alertState[type] = state;
}

// ==================== Filtered Posts ====================

export function clearFilteredPosts() {
  filteredPosts.length = 0;
  filteredPostKeys.clear();
  updateFilteredTabCount();
  // Re-render filtered view if it's currently showing
  if (filteredTabActive && filteredViewContainer) {
    const content = filteredViewContainer.querySelector('.filtered-modal-content');
    if (content) renderFilteredPostsView(content);
  }
}

// ==================== Theme ====================

export function updateTheme() {
  const theme = _deps.adapter.getThemeMode();
  const iosFilteredModal = document.querySelector('.ff-ios-filtered-modal-backdrop');
  const iosPageContainer = _deps.getIOSPageContainer();
  const elements = [filterPhrasesContainer, filteredViewContainer, bottomFilterContainer, mobileFilterContainer, iosPageContainer, iosFilteredModal].filter(Boolean) as Element[];

  for (const el of elements) {
    el.classList.remove('light-mode', 'dim-mode', 'dark-mode');
    el.classList.add(`${theme}-mode`);
  }

  // Also update the document element for CSS selectors that need it
  document.documentElement.classList.remove('twitter-light', 'twitter-dim', 'twitter-dark');
  document.documentElement.classList.add(`twitter-${theme}`);
}

// ==================== Sidebar Filter ====================

function updateSidebarFilterVisibility() {
  if (!filterPhrasesContainer || !filterPhrasesContainer.isConnected) return;

  if (!_deps.adapter.shouldProcessCurrentPage()) {
    filterPhrasesContainer.remove();
    filterPhrasesContainer = null;
  }
}

export function injectFilterPhrasesInput() {
  // Already exists and connected, just update visibility
  if (filterPhrasesContainer && filterPhrasesContainer.isConnected) {
    updateSidebarFilterVisibility();
    return;
  }

  // Don't inject on non-applicable pages
  if (!_deps.adapter.shouldProcessCurrentPage()) return;

  // Find the right sidebar
  const sidebar = document.querySelector(_deps.adapter.selectors.sidebar);
  if (!sidebar) return;

  // Find the insertion target in the sidebar
  const sidebarContent = _deps.adapter.selectors.sidebarContent
    ? sidebar.querySelector(_deps.adapter.selectors.sidebarContent)
    : sidebar;
  if (!sidebarContent) return;

  // Create the filter phrases container
  filterPhrasesContainer = document.createElement('div');
  filterPhrasesContainer.className = 'filter-phrases-sidebar';

  if (!isAuthenticated) {
    filterPhrasesContainer.innerHTML = getSignInHTML();
    sidebarContent.insertBefore(filterPhrasesContainer, sidebarContent.firstChild);
    updateTheme();
    setupSignInButton(filterPhrasesContainer);
    updateSidebarFilterVisibility();
    return;
  }

  filterPhrasesContainer.innerHTML = `
    <div class="filter-phrases-container">
      <span class="filter-phrases-box-name">
        Bouncer
      </span>
      <div class="filter-phrases-header">
        <span class="filter-phrases-label">Filter out</span>
        <span class="filter-phrases-list"></span>
        <span class="filter-phrases-and-input">
          <span class="filter-phrases-and">and</span>
          ${placeholderHTML}
        </span>
      </div>
      <div class="filter-model-loading" style="display: none;">
        <div class="model-loading-text">Loading model...</div>
        <div class="model-loading-progress">
          <div class="model-loading-progress-fill"></div>
        </div>
      </div>
      <div class="filter-phrases-actions">
        <button class="filtered-toggle-btn">
          <span class="filtered-toggle-text">View filtered</span>
          <span class="filtered-toggle-count">(0)</span>
        </button>
        <button class="filter-settings-btn">Settings</button>
      </div>
    </div>
  `;

  // Insert at the very top of the sidebar content
  sidebarContent.insertBefore(filterPhrasesContainer, sidebarContent.firstChild);

  // Apply theme and update count
  updateTheme();
  updateFilteredTabCount();

  setupFilterBoxEventHandlers(filterPhrasesContainer);

  // Update visibility based on current page
  updateSidebarFilterVisibility();
}

// Common event handler setup for filter boxes (sidebar and bottom)
function setupFilterBoxEventHandlers(container: HTMLElement) {
  const phrasesListContainer = container.querySelector('.filter-phrases-list')!;
  const input = container.querySelector<HTMLInputElement>('.filter-phrases-input')!;
  const placeholderCycle = container.querySelector('.filter-placeholder-cycle');
  const toggleBtn = container.querySelector('.filtered-toggle-btn')!;
  const settingsBtn = container.querySelector('.filter-settings-btn')!;

  // Show/hide animated placeholder based on input state and existing phrases
  function updatePlaceholderVisibility() {
    if (!placeholderCycle) return;
    const hasPhrases = phrasesListContainer.children.length > 0;
    const hasText = input.value.length > 0;
    placeholderCycle.classList.toggle('hidden', hasPhrases || hasText);
  }
  input.addEventListener('input', updatePlaceholderVisibility);

  // Settings button click
  settingsBtn.addEventListener('click', () => showSettingsModal());

  // Toggle filtered view on button click
  toggleBtn.addEventListener('click', () => {
    toggleFilteredTab(!filteredTabActive);
    updateFilteredToggleButtons();
  });

  // Load and render saved descriptions
  getDescriptions(_deps.descriptionsKey).then((descriptions) => {
    if (descriptions.length > 0) {
      renderPhrasesInContainer(phrasesListContainer, descriptions);
    }
  }).catch(err => console.error('[UI] Failed to load descriptions:', err));

  // Enter or comma key to add phrase
  input.addEventListener('keypress', (e) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      (async () => {
        const added = await addFilterPhrase(input.value.trim());
        if (added) input.value = '';
        updatePlaceholderVisibility();
      })().catch(err => console.error('[UI] filter phrase keypress handler failed:', err));
    }
  });

  // Handle pasting comma-separated lists
  input.addEventListener('paste', (e) => {
    const pasted = e.clipboardData!.getData('text');
    if (pasted.includes(',')) {
      e.preventDefault();
      (async () => {
        const phrases = pasted.split(',').map(s => s.trim()).filter(Boolean);
        for (const phrase of phrases) {
          await addFilterPhrase(phrase);
        }
        input.value = '';
        updatePlaceholderVisibility();
      })().catch(err => console.error('[UI] filter phrase paste handler failed:', err));
    }
  });

  // Update visibility based on current page
  updateSidebarFilterVisibility();
}

// ==================== Bottom Filter ====================

function toggleBottomFilter(expanded: boolean) {
  bottomFilterExpanded = expanded;

  if (bottomFilterContainer) {
    if (expanded) {
      bottomFilterContainer.classList.add('expanded');
      bottomFilterContainer.classList.remove('collapsed');
    } else {
      bottomFilterContainer.classList.remove('expanded');
      bottomFilterContainer.classList.add('collapsed');
    }
  }
}

function updateBottomFilterPosition() {
  if (!bottomFilterContainer || !bottomFilterContainer.isConnected) return;

  const primaryColumn = document.querySelector(_deps.adapter.selectors.primaryColumn);
  if (primaryColumn) {
    const style = window.getComputedStyle(primaryColumn);
    const borderLeft = parseFloat(style.borderLeftWidth) || 0;
    const borderRight = parseFloat(style.borderRightWidth) || 0;
    const rect = primaryColumn.getBoundingClientRect();

    bottomFilterContainer.style.left = (rect.left + borderLeft) + 'px';
    bottomFilterContainer.style.width = (rect.width - borderLeft - borderRight) + 'px';
  }
}

function updateBottomFilterVisibility() {
  if (!bottomFilterContainer || !bottomFilterContainer.isConnected) return;

  if (!_deps.adapter.shouldProcessCurrentPage()) {
    bottomFilterContainer.remove();
    bottomFilterContainer = null;
  }
}

export function injectBottomFilterBox() {
  if (_deps.IS_IOS) return;
  // Already exists and connected, check if we should remove it
  if (bottomFilterContainer && bottomFilterContainer.isConnected) {
    updateBottomFilterVisibility();
    return;
  }

  // Don't inject on non-applicable pages
  if (!_deps.adapter.shouldProcessCurrentPage()) return;

  // Create the bottom filter container - just the pill itself
  bottomFilterContainer = document.createElement('div');
  bottomFilterContainer.className = 'filter-phrases-bottom expanded';

  if (!isAuthenticated) {
    bottomFilterContainer.innerHTML = `
      <div class="filter-collapse-handle">
        <span class="filter-collapse-chevron"></span>
      </div>
      ${getSignInHTML()}
    `;
    document.body.appendChild(bottomFilterContainer);
    updateBottomFilterPosition();
    updateBottomFilterVisibility();
    updateTheme();
    setupSignInButton(bottomFilterContainer);
    const collapseHandle = bottomFilterContainer.querySelector('.filter-collapse-handle')!;
    collapseHandle.addEventListener('click', () => {
      toggleBottomFilter(!bottomFilterExpanded);
    });
    return;
  }

  bottomFilterContainer.innerHTML = `
    <div class="filter-collapse-handle">
      <span class="filter-collapse-chevron"></span>
    </div>
    <div class="filter-phrases-container">
      <span class="filter-phrases-box-name">
        Bouncer
      </span>
      <div class="filter-phrases-header">
        <span class="filter-phrases-label">Filter out</span>
        <span class="filter-phrases-list"></span>
        <span class="filter-phrases-and-input">
          <span class="filter-phrases-and">and</span>
          ${placeholderHTML}
        </span>
      </div>
      <div class="filter-model-loading" style="display: none;">
        <div class="model-loading-text">Loading model...</div>
        <div class="model-loading-progress">
          <div class="model-loading-progress-fill"></div>
        </div>
      </div>
      <div class="filter-phrases-actions">
        <button class="filtered-toggle-btn">
          <span class="filtered-toggle-text">View filtered</span>
          <span class="filtered-toggle-count">(0)</span>
        </button>
        <button class="filter-settings-btn">Settings</button>
      </div>
    </div>
  `;

  // Append to body
  document.body.appendChild(bottomFilterContainer);

  // Position to match primary column and check visibility
  updateBottomFilterPosition();
  updateBottomFilterVisibility();
  // Update position on resize
  window.addEventListener('resize', updateBottomFilterPosition);
  // Also update position and visibility periodically (for SPA navigation that changes layout)
  const positionInterval = setInterval(() => {
    if (!bottomFilterContainer || !bottomFilterContainer.isConnected) {
      clearInterval(positionInterval);
      return;
    }
    updateBottomFilterPosition();
    updateBottomFilterVisibility();
  }, 500);

  // Apply theme and update count
  updateTheme();
  updateFilteredTabCount();

  setupFilterBoxEventHandlers(bottomFilterContainer);

  // Toggle expand/collapse when clicking the collapse handle
  const collapseHandle = bottomFilterContainer.querySelector('.filter-collapse-handle')!;
  collapseHandle.addEventListener('click', () => {
    toggleBottomFilter(!bottomFilterExpanded);
  });
}

// ==================== Mobile Filter ====================

function updateMobileFilterVisibility() {
  if (!mobileFilterContainer || !mobileFilterContainer.isConnected) return;

  if (!_deps.adapter.shouldProcessCurrentPage()) {
    mobileFilterContainer.remove();
    mobileFilterContainer = null;
  }
}

export function injectMobileFilterBox() {
  if (_deps.IS_IOS) return;
  // Already exists and connected, check if we should remove it
  if (mobileFilterContainer && mobileFilterContainer.isConnected) {
    updateMobileFilterVisibility();
    return;
  }

  // Don't inject on non-applicable pages
  if (!_deps.adapter.shouldProcessCurrentPage()) return;

  // Find the navigation element
  const nav = document.querySelector(_deps.adapter.selectors.nav);
  if (!nav) return;

  // Create the mobile filter container
  mobileFilterContainer = document.createElement('div');
  mobileFilterContainer.className = 'filter-phrases-mobile';

  if (!isAuthenticated) {
    mobileFilterContainer.innerHTML = getSignInHTML();
    nav.parentNode!.insertBefore(mobileFilterContainer, nav);
    updateTheme();
    setupSignInButton(mobileFilterContainer);
    updateMobileFilterVisibility();
    return;
  }

  mobileFilterContainer.innerHTML = `
    <div class="filter-phrases-container">
      <span class="filter-phrases-box-name">
        Bouncer
      </span>
      <div class="filter-phrases-header">
        <span class="filter-phrases-label">Filter out</span>
        <span class="filter-phrases-list"></span>
        <span class="filter-phrases-and-input">
          <span class="filter-phrases-and">and</span>
          ${placeholderHTML}
        </span>
      </div>
      <div class="filter-model-loading" style="display: none;">
        <div class="model-loading-text">Loading model...</div>
        <div class="model-loading-progress">
          <div class="model-loading-progress-fill"></div>
        </div>
      </div>
      <div class="filter-phrases-actions">
        <button class="filtered-toggle-btn">
          <span class="filtered-toggle-text">View filtered</span>
          <span class="filtered-toggle-count">(0)</span>
        </button>
        <button class="filter-settings-btn">Settings</button>
      </div>
    </div>
  `;

  // Insert before the navigation element
  nav.parentNode!.insertBefore(mobileFilterContainer, nav);

  // Apply theme and update count
  updateTheme();
  updateFilteredTabCount();

  setupFilterBoxEventHandlers(mobileFilterContainer);

  // Update visibility based on current page
  updateMobileFilterVisibility();
}

// ==================== Filter Phrases ====================

export function syncFilterPhrases() {
  getDescriptions(_deps.descriptionsKey).then((descriptions) => {

    // Update desktop/tablet/mobile containers
    [filterPhrasesContainer, bottomFilterContainer, mobileFilterContainer].forEach(container => {
      if (container && container.isConnected) {
        const phrasesListContainer = container.querySelector('.filter-phrases-list');
        if (phrasesListContainer) {
          renderPhrasesInContainer(phrasesListContainer, descriptions);
        }
      }
    });

    // Update iOS overlay categories if visible
    const iosPageContainer = _deps.getIOSPageContainer();
    if (iosPageContainer && iosPageContainer.isConnected) {
      _deps.renderIOSCategories(iosPageContainer);
    }
  }).catch(err => console.error('[UI] Failed to sync filter phrases:', err));
}

function renderPhrasesInContainer(container: Element, descriptions: string[]) {
  container.innerHTML = '';
  const len = descriptions.length;
  descriptions.forEach((desc, index) => {
    const phrase = document.createElement('span');
    phrase.className = 'filter-phrase-inline';
    phrase.textContent = desc;
    phrase.title = 'Click to remove';
    phrase.addEventListener('click', asyncHandler(() => removeFilterPhrase(desc)));
    container.appendChild(phrase);

    if (index < len - 1) {
      const separator = document.createElement('span');
      separator.className = 'filter-phrase-separator';
      separator.textContent = ', ';
      container.appendChild(separator);
    } else if (len > 1) {
      // Oxford comma before "and" (which lives in the wrapper element)
      const separator = document.createElement('span');
      separator.className = 'filter-phrase-separator';
      separator.textContent = ', ';
      container.appendChild(separator);
    }
  });

  // Hide placeholder when there are any phrases
  const placeholderCycle = container.parentElement?.querySelector('.filter-placeholder-cycle');
  if (placeholderCycle) {
    placeholderCycle.classList.toggle('hidden', len > 0);
  }
}

const MAX_CATEGORIES_LENGTH = 1000;

export async function addFilterPhrase(text: string) {
  if (!text) return false;

  const descriptions = await getDescriptions(_deps.descriptionsKey);

  if (descriptions.includes(text)) return false;

  // Check total character length with the new phrase
  const totalLength = [...descriptions, text].reduce((sum, d) => sum + d.length, 0);
  if (totalLength > MAX_CATEGORIES_LENGTH) {
    showCategoryLimitWarning();
    return false;
  }

  descriptions.push(text);
  await setDescriptions(_deps.descriptionsKey, descriptions);
  await chrome.runtime.sendMessage({ type: 'clearCache' });
  syncFilterPhrases();
  _deps.reEvaluateAllPosts();
  return true;
}

export async function removeFilterPhrase(phrase: string) {
  const descriptions = await getDescriptions(_deps.descriptionsKey);
  const newDescriptions = descriptions.filter((d: string) => d !== phrase);
  await setDescriptions(_deps.descriptionsKey, newDescriptions);
  await chrome.runtime.sendMessage({ type: 'clearCache' });
  clearFilteredPosts();
  syncFilterPhrases();
}

// ==================== Settings Modal ====================

export function showSettingsModal() {
  // Remove existing modal if any
  if (settingsModal && settingsModal.isConnected) {
    settingsModal.remove();
  }

  // Create modal overlay
  settingsModal = document.createElement('div');
  settingsModal.className = 'settings-modal-overlay';

  // Create iframe that loads the actual popup.html
  const iframe = document.createElement('iframe');
  iframe.className = 'settings-modal-iframe';
  iframe.src = chrome.runtime.getURL('popup.html');

  // Send current theme to iframe once it loads
  iframe.addEventListener('load', () => {
    const theme = _deps.adapter.getThemeMode();
    iframe.contentWindow!.postMessage({ type: 'setTheme', theme }, '*');
  });

  settingsModal.appendChild(iframe);
  document.body.appendChild(settingsModal);

  // Listen for messages from iframe
  let hasResized = false;
  const messageHandler = (event: MessageEvent<{ type?: string; height?: number }>) => {
    if (!event.data) return;
    if (event.data.type === 'closeSettingsModal') {
      closeSettingsModal();
      window.removeEventListener('message', messageHandler);
    } else if (event.data.type === 'settingsResize') {
      if (!hasResized) {
        // First resize: set height without transition, then fade in
        hasResized = true;
        iframe.style.transition = 'transform 0.2s ease';
        iframe.style.height = event.data.height + 'px';
        requestAnimationFrame(() => {
          settingsModal!.classList.add('visible');
          // Re-enable height transitions for subsequent resizes
          setTimeout(() => {
            iframe.style.transition = '';
          }, 200);
        });
      } else {
        iframe.style.height = event.data.height + 'px';
      }
    }
  };
  window.addEventListener('message', messageHandler);

  // Close on overlay click (but not iframe click)
  const modal = settingsModal;
  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      closeSettingsModal();
    }
  });

  // Close on escape key
  const escHandler = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      closeSettingsModal();
      document.removeEventListener('keydown', escHandler);
    }
  };
  document.addEventListener('keydown', escHandler);
}

function closeSettingsModal() {
  if (settingsModal && settingsModal.isConnected) {
    settingsModal.classList.remove('visible');
    setTimeout(() => {
      if (settingsModal && settingsModal.isConnected) {
        settingsModal.remove();
      }
      settingsModal = null;
    }, 200);
  } else {
    settingsModal = null;
  }
}

// ==================== Alert Banners ====================

function createAlertBanner(alertType: keyof AlertState, config: AlertDisplayConfig) {
  const alertDef = ALERT_CONFIG[alertType];
  const banner = document.createElement('div');
  banner.className = alertDef.cssClass;
  banner.dataset.alertType = alertType;

  const textClass = alertDef.cssClass.replace('-banner', '-text');
  const actionsClass = alertDef.cssClass.replace('-banner', '-actions');
  const btnClass = alertDef.cssClass.replace('-warning-banner', '-configure-btn').replace('-error-banner', '-error-configure-btn').replace('-backlog-banner', '-backlog-configure-btn');

  banner.innerHTML = `
    <span class="${textClass}">
      ${config.message}
    </span>
    ${config.buttonText ? `<div class="${actionsClass}">
      <button class="${btnClass}">${config.buttonText}</button>
    </div>` : ''}
  `;

  const btn = banner.querySelector('button');
  if (btn) {
    btn.addEventListener('click', () => {
      showSettingsModal();
    });
  }

  return banner;
}

function insertBannerByPriority(container: HTMLElement, banner: HTMLElement, priority: number) {
  const existingBanners = container.querySelectorAll('[data-alert-type]');
  let insertBefore: Element | null = null;

  for (const existing of existingBanners) {
    const existingType = (existing as HTMLElement).dataset.alertType;
    const existingDef = existingType && existingType in ALERT_CONFIG ? ALERT_CONFIG[existingType as keyof AlertState] : null;
    if (existingDef && existingDef.priority > priority) {
      insertBefore = existing;
      break;
    }
  }

  if (insertBefore) {
    container.insertBefore(banner, insertBefore);
  } else if (existingBanners.length > 0) {
    existingBanners[existingBanners.length - 1].after(banner);
  } else {
    container.insertBefore(banner, container.firstChild);
  }
}

function updateBannerInContainer(container: HTMLElement, alertType: keyof AlertState, alertDef: { cssClass: string; priority: number }, config: AlertDisplayConfig | null, shouldShow: boolean) {
  const banner = container.querySelector(`.${alertDef.cssClass}`);

  if (shouldShow && !banner) {
    const newBanner = createAlertBanner(alertType, config!);
    insertBannerByPriority(container, newBanner, alertDef.priority);
  } else if (shouldShow && banner) {
    banner.remove();
    const newBanner = createAlertBanner(alertType, config!);
    insertBannerByPriority(container, newBanner, alertDef.priority);
  } else if (!shouldShow && banner) {
    banner.remove();
  }
}

export function updateAlertBanners() {
  const containers = [
    filterPhrasesContainer?.querySelector('.filter-phrases-container'),
    bottomFilterContainer?.querySelector('.filter-phrases-container'),
    mobileFilterContainer?.querySelector('.filter-phrases-container')
  ].filter((c): c is HTMLElement => c != null && c.isConnected);

  function processAlert<K extends keyof AlertState>(alertType: K) {
    const alertDef = ALERT_CONFIG[alertType];
    const state = alertState[alertType];
    const config = alertDef.getConfig(state);
    const shouldShow = config !== null;

    for (const container of containers) {
      updateBannerInContainer(container, alertType, alertDef, config, shouldShow);
    }
  }

  (Object.keys(ALERT_CONFIG) as (keyof AlertState)[]).forEach(processAlert);
}

// ==================== Filtered Toggle Buttons ====================

export function updateFilteredToggleButtons() {
  const containers = [filterPhrasesContainer, bottomFilterContainer, mobileFilterContainer];
  containers.forEach(container => {
    if (container && container.isConnected) {
      const toggleBtn = container.querySelector('.filtered-toggle-btn');
      if (toggleBtn) {
        if (filteredTabActive) {
          toggleBtn.classList.add('active');
        } else {
          toggleBtn.classList.remove('active');
        }
      }
    }
  });
}

export function updateFilteredTabCount() {
  const newCount = filteredPosts.length;
  const countText = `(${newCount})`;
  const shouldAnimate = newCount > previousFilteredCount;
  previousFilteredCount = newCount;

  const containers = [filterPhrasesContainer, bottomFilterContainer, mobileFilterContainer];
  containers.forEach(container => {
    if (container && container.isConnected) {
      const countEl = container.querySelector('.filtered-toggle-count');
      if (countEl) {
        countEl.textContent = countText;
        if (shouldAnimate) {
          countEl.classList.remove('bump');
          void (countEl as HTMLElement).offsetWidth;
          countEl.classList.add('bump');
        }
      }
    }
  });

  // Also update iOS overlay "View filtered (N)" button
  _deps.updateIOSFilteredCount();

  // Update FAB badge
  const ffFabButton = _deps.getFFFabButton();
  if (ffFabButton && ffFabButton.isConnected) {
    const badge = ffFabButton.querySelector<HTMLElement>('.ff-fab-badge');
    if (badge) {
      badge.textContent = String(newCount);
      badge.style.display = newCount > 0 ? '' : 'none';
      if (shouldAnimate) {
        ffFabButton.classList.remove('ff-fab-bounce');
        void ffFabButton.offsetWidth;
        ffFabButton.classList.add('ff-fab-bounce');
      }
    }
  }
}

// ==================== Model Loading Progress ====================

export function updateModelLoadingProgress(statuses: Record<string, LocalModelStatus>, selectedModel: string) {
  const containers = [filterPhrasesContainer, bottomFilterContainer, mobileFilterContainer];

  const isLocalModel = selectedModel && selectedModel.startsWith('local:');
  if (!isLocalModel) {
    containers.forEach(container => {
      if (container && container.isConnected) {
        const loadingEl = container.querySelector<HTMLElement>('.filter-model-loading');
        if (loadingEl) loadingEl.style.display = 'none';
      }
    });

    return;
  }

  const modelId = selectedModel.split(':')[1];
  const status = statuses[modelId];

  if (!status) return;

  const isLoading = status.state === 'downloading' || status.state === 'initializing' || status.state === 'cached';

  containers.forEach(container => {
    if (container && container.isConnected) {
      const loadingEl = container.querySelector<HTMLElement>('.filter-model-loading');
      if (!loadingEl) return;

      if (isLoading) {
        loadingEl.style.display = 'block';
        const textEl = loadingEl.querySelector('.model-loading-text')!;
        const fillEl = loadingEl.querySelector<HTMLElement>('.model-loading-progress-fill')!;

        if (status.state === 'cached') {
          textEl.textContent = 'Loading model...';
          fillEl.style.width = '0%';
        } else if (status.text) {
          textEl.textContent = status.text;
          fillEl.style.width = `${(status.progress || 0) * 100}%`;
        } else {
          textEl.textContent = status.state === 'initializing' ? 'Initializing...' : 'Downloading...';
          fillEl.style.width = `${(status.progress || 0) * 100}%`;
        }
      } else {
        loadingEl.style.display = 'none';
      }
    }
  });

}

export function initModelLoadingListener() {
  // Get initial state
  getStorage(['localModelStatuses', 'selectedModel']).then((data) => {
    if (data.localModelStatuses) {
      updateModelLoadingProgress(
        data.localModelStatuses,
        data.selectedModel || ''
      );
    }
  }).catch(err => console.error('[UI] Failed to load model statuses:', err));

  // Listen for changes
  chrome.storage.onChanged.addListener((changes: Record<string, chrome.storage.StorageChange>, areaName: string) => {
    if (areaName === 'local' && changes.localModelStatuses) {
      getStorage(['selectedModel']).then((data) => {
        const newStatuses = (changes.localModelStatuses.newValue || {}) as Record<string, LocalModelStatus>;
        const oldStatuses = (changes.localModelStatuses.oldValue || {}) as Record<string, LocalModelStatus>;
        const selectedModel = data.selectedModel || '';

        updateModelLoadingProgress(newStatuses, selectedModel);

        // Check if selected local model just became ready - trigger re-evaluation
        if (selectedModel?.startsWith('local:')) {
          const modelId = selectedModel.split(':')[1];
          const oldState = oldStatuses[modelId]?.state;
          const newState = newStatuses[modelId]?.state;

          if (newState === 'ready' && oldState && oldState !== 'ready') {
            _deps.processExistingPosts();
          }
        }
      }).catch(err => console.error('[UI] Failed to get selected model:', err));
    }
    if (areaName === 'local' && changes.selectedModel) {
      getStorage(['localModelStatuses']).then((data) => {
        updateModelLoadingProgress(data.localModelStatuses || {}, changes.selectedModel.newValue as string);
      }).catch(err => console.error('[UI] Failed to get model statuses:', err));
    }
  });
}

// ==================== Filtered Tab / Modal ====================

export function toggleFilteredTab(active: boolean) {
  if (active === filteredTabActive) return;
  filteredTabActive = active;

  if (active) {
    if (!filteredModalBackdrop || !filteredModalBackdrop.isConnected) {
      filteredModalBackdrop = document.createElement('div');
      filteredModalBackdrop.className = 'filtered-modal-backdrop';

      filteredViewContainer = document.createElement('div');
      filteredViewContainer.className = 'filtered-view-container';

      const header = document.createElement('div');
      header.className = 'filtered-modal-header';
      header.innerHTML = `
        <button class="filtered-modal-close" aria-label="Close">
          <svg viewBox="0 0 24 24"><path d="M10.59 12L4.54 5.96l1.42-1.42L12 10.59l6.04-6.05 1.42 1.42L13.41 12l6.05 6.04-1.42 1.42L12 13.41l-6.04 6.05-1.42-1.42L10.59 12z"></path></svg>
        </button>
        <span class="filtered-modal-title">Filtered posts</span>
      `;

      const content = document.createElement('div');
      content.className = 'filtered-modal-content';

      filteredViewContainer.appendChild(header);
      filteredViewContainer.appendChild(content);
      filteredModalBackdrop.appendChild(filteredViewContainer);
      document.body.appendChild(filteredModalBackdrop);

      filteredModalBackdrop.addEventListener('click', (e) => {
        if (e.target === filteredModalBackdrop) {
          toggleFilteredTab(false);
          updateFilteredToggleButtons();
        }
      });

      header.querySelector('.filtered-modal-close')!.addEventListener('click', () => {
        toggleFilteredTab(false);
        updateFilteredToggleButtons();
      });

      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && filteredTabActive) {
          toggleFilteredTab(false);
          updateFilteredToggleButtons();
        }
      });

      updateTheme();
    }

    filteredModalBackdrop.classList.add('visible');
    renderFilteredPostsView(filteredViewContainer!.querySelector('.filtered-modal-content')!);
  } else {
    if (filteredModalBackdrop) {
      filteredModalBackdrop.classList.remove('visible');
    }

    // Restore verification bars that may have been removed while on Filtered tab
    restoreVerificationBars();
  }
}

export function renderFilteredPostsView(container: Element) {
  if (filteredPosts.length === 0) {
    container.innerHTML = `
      <div class="filtered-posts-container">
        <div class="filtered-posts-empty">
          No posts have been filtered out in this session.<br>
          Removed posts will appear here.
        </div>
      </div>
    `;
    return;
  }

  // Create a container for the posts
  container.innerHTML = '<div class="slop-posts-container"></div>';
  const postsContainer = container.querySelector('.slop-posts-container')!;

  // Render posts in reverse order (newest first)
  [...filteredPosts].reverse().forEach((post) => {
    const { post: postContent } = post;
    const wrapper = document.createElement('div');
    wrapper.className = 'slop-post-wrapper';

    // Main post row: avatar + body
    const postRow = document.createElement('div');
    postRow.className = 'slop-post';

    // Avatar — show image if available, otherwise show initial as fallback
    const avatar = document.createElement('div');
    avatar.className = 'slop-post-avatar';
    if (postContent.avatarUrl) {
      const img = document.createElement('img');
      img.src = postContent.avatarUrl;
      avatar.appendChild(img);
    } else {
      // Fallback: show first letter of display name or handle
      const initial = (postContent.author?.[0] || postContent.handle?.[1] || '?').toUpperCase();
      const fallback = document.createElement('span');
      fallback.className = 'slop-avatar-initial';
      fallback.textContent = initial;
      avatar.appendChild(fallback);
    }
    postRow.appendChild(avatar);

    // Body
    const body = document.createElement('div');
    body.className = 'slop-post-body';

    // Top row: meta + category tag
    const top = document.createElement('div');
    top.className = 'slop-post-top';

    const meta = document.createElement('div');
    meta.className = 'slop-post-meta';
    if (postContent.author) {
      // Extract display name — author field has "DisplayName@handle · time" concatenated
      // Use handle to split if available, otherwise use full author string
      let displayName = postContent.author;
      if (postContent.handle) {
        const handleIdx = displayName.indexOf(postContent.handle);
        if (handleIdx > 0) displayName = displayName.substring(0, handleIdx);
      }
      const nameSpan = document.createElement('span');
      nameSpan.className = 'slop-post-name';
      nameSpan.textContent = displayName;
      meta.appendChild(nameSpan);
    }
    if (postContent.handle || postContent.timeText) {
      const handleSpan = document.createElement('span');
      handleSpan.className = 'slop-post-handle';
      const parts = [postContent.handle, postContent.timeText].filter(Boolean);
      handleSpan.textContent = parts.join(' · ');
      meta.appendChild(handleSpan);
    }
    top.appendChild(meta);

    if (post.category) {
      const tag = document.createElement('span');
      tag.className = 'slop-category-tag';
      tag.textContent = post.category.toUpperCase();
      top.appendChild(tag);
    }
    body.appendChild(top);

    // Tweet text — use sanitized HTML to preserve links/emojis/formatting
    if (postContent.textHtml) {
      const textDiv = document.createElement('div');
      textDiv.className = 'slop-post-text';
      textDiv.innerHTML = DOMPurify.sanitize(postContent.textHtml);
      body.appendChild(textDiv);
    } else if (post.evaluationText) {
      const textDiv = document.createElement('div');
      textDiv.className = 'slop-post-text';
      textDiv.textContent = post.evaluationText;
      body.appendChild(textDiv);
    }

    // Quote tweet — render as a mini-card with avatar, author, and text
    if (postContent.quote) {
      const quoteBox = document.createElement('div');
      quoteBox.className = 'slop-quote-box';

      // Quote header: avatar + author info
      const quoteHeader = document.createElement('div');
      quoteHeader.className = 'slop-quote-header';

      if (postContent.quote.avatarUrl) {
        const qAvatar = document.createElement('img');
        qAvatar.className = 'slop-quote-avatar';
        qAvatar.src = postContent.quote.avatarUrl;
        quoteHeader.appendChild(qAvatar);
      }

      if (postContent.quote.author) {
        let qDisplayName = postContent.quote.author;
        if (postContent.quote.handle) {
          const idx = qDisplayName.indexOf(postContent.quote.handle);
          if (idx > 0) qDisplayName = qDisplayName.substring(0, idx);
        }
        const qName = document.createElement('span');
        qName.className = 'slop-quote-name';
        qName.textContent = qDisplayName;
        quoteHeader.appendChild(qName);
      }
      if (postContent.quote.handle || postContent.quote.timeText) {
        const qMeta = document.createElement('span');
        qMeta.className = 'slop-quote-handle';
        const parts = [postContent.quote.handle, postContent.quote.timeText].filter(Boolean);
        qMeta.textContent = parts.join(' · ');
        quoteHeader.appendChild(qMeta);
      }
      quoteBox.appendChild(quoteHeader);

      // Quote text
      if (postContent.quote.textHtml) {
        const quoteText = document.createElement('div');
        quoteText.className = 'slop-quote-text';
        quoteText.innerHTML = DOMPurify.sanitize(postContent.quote.textHtml);
        quoteBox.appendChild(quoteText);
      }

      body.appendChild(quoteBox);
    }

    // Images
    if (postContent.imageUrls && postContent.imageUrls.length > 0) {
      const mediaContainer = document.createElement('div');
      mediaContainer.className = 'slop-media-container';
      postContent.imageUrls.forEach(url => {
        const img = document.createElement('img');
        img.src = url;
        img.className = 'slop-media-image';
        img.loading = 'lazy';
        mediaContainer.appendChild(img);
      });
      body.appendChild(mediaContainer);
    }

    // Reasoning
    const reasoning = document.createElement('div');
    reasoning.className = 'slop-post-reasoning';
    reasoning.textContent = cleanReasoning(post.reasoning) || 'Filtered';
    body.appendChild(reasoning);

    // Actions row
    const actions = document.createElement('div');
    actions.className = 'slop-post-actions';

    const restoreBtn = document.createElement('button');
    restoreBtn.className = 'slop-restore';
    restoreBtn.textContent = 'Restore';
    restoreBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      chrome.runtime.sendMessage({
        type: 'sendFeedback',
        siteId: _deps.adapter.siteId,
        tweetData: { text: post.evaluationText, imageUrls: postContent.imageUrls || [] },
        rawResponse: post.rawResponse || '',
        reasoning: post.reasoning || '',
        decision: 'false_positive'
      }).catch(err => console.error('[Bouncer] Undo feedback error:', err));

      // Remove from filtered posts list
      const key = postContent.postUrl || post.evaluationText.substring(0, 200);
      const idx = filteredPosts.findIndex(p => (p.post.postUrl || p.evaluationText.substring(0, 200)) === key);
      if (idx !== -1) filteredPosts.splice(idx, 1);
      filteredPostKeys.delete(key);

      // Try to unhide original article in the feed
      for (const article of _deps.findPosts()) {
        const postUrl = _deps.adapter.getPostUrl(article);
        if (postUrl && postContent.postUrl && postUrl.includes(postContent.postUrl)) {
          const container = _deps.adapter.getPostContainer(article);
          container.style.display = '';
          container.style.visibility = '';
          delete container.dataset.filteredByExtension;
          article.style.opacity = '';
          article.style.transition = '';
          _deps.processedPosts.delete(article);
          markPostVerified(article);
          break;
        }
      }

      // Override cache so re-evaluation keeps post visible
      chrome.runtime.sendMessage({
        type: 'overrideCacheEntry',
        post: post.evaluationText,
        imageUrls: postContent.imageUrls || [],
        shouldHide: false,
        reasoning: 'User reported: false positive'
      }).catch(err => console.error('[Bouncer] Override cache error:', err));

      updateFilteredTabCount();
      const outerContainer = restoreBtn.closest('.filtered-view-container') || restoreBtn.closest('.ff-ios-filtered-modal-backdrop');
      const innerContainer = outerContainer?.querySelector('.filtered-modal-content') || outerContainer?.querySelector('.ff-ios-filtered-modal-content');
      if (innerContainer) renderFilteredPostsView(innerContainer);
    });
    actions.appendChild(restoreBtn);
    body.appendChild(actions);

    postRow.appendChild(body);

    // Wrap in a real <a> so middle-click / ctrl-click open in new tab natively
    if (postContent.postUrl) {
      const link = document.createElement('a');
      link.href = postContent.postUrl;
      link.className = 'slop-post-link';
      link.addEventListener('click', (e) => {
        if ((e.target as Element).closest('button, [role="button"], .slop-restore, .slop-post-actions')) {
          e.preventDefault();
        }
      });
      link.appendChild(postRow);
      wrapper.appendChild(link);
    } else {
      wrapper.appendChild(postRow);
    }

    postsContainer.appendChild(wrapper);
  });
}

// ==================== Filtered Post Storage ====================

export function storeFilteredPost(article: HTMLElement, contentObj: PostContent, reasoning: string, rawResponse = '', category: string | null = null) {
  // Use postUrl or content hash as dedup key
  const evalText = formatPostForEvaluation(contentObj);
  const key = contentObj.postUrl || evalText.substring(0, 200);
  if (filteredPostKeys.has(key)) {
    return; // Already stored
  }
  filteredPostKeys.add(key);

  filteredPosts.push({
    post: contentObj,
    evaluationText: evalText,
    reasoning,
    rawResponse,
    category: category || null,
    timestamp: Date.now()
  });
  updateFilteredTabCount();
}

// ==================== Verification Bars ====================

export function getVerificationBar(article: HTMLElement) {
  let bar = article.querySelector('.post-verification-bar');
  if (!bar) {
    article.style.position = 'relative';
    bar = document.createElement('div');
    bar.className = 'post-verification-bar';
    article.insertBefore(bar, article.firstChild);
  }
  return bar;
}

// Check if any pending post in the viewport has been waiting > 5 seconds
const VIEWPORT_LATENCY_THRESHOLD_MS = 5000;
export function checkViewportPendingLatency() {
  // Local models run on-device — don't show the "service under heavy load" warning
  if (alertState.latency.selectedModel?.startsWith('local:')) {
    if (alertState.latency.isHighLatency) {
      alertState.latency.isHighLatency = false;
      updateAlertBanners();
    }
    return;
  }

  const now = Date.now();
  let anySlowInViewport = false;

  for (const article of _deps.pendingPosts) {
    if (!article.isConnected) continue;
    const startTime = parseInt(article.dataset.pendingStartTime || '0', 10);
    if (now - startTime < VIEWPORT_LATENCY_THRESHOLD_MS) continue;

    // Check if this pending post is in the viewport
    const rect = article.getBoundingClientRect();
    if (rect.bottom > 0 && rect.top < window.innerHeight) {
      anySlowInViewport = true;
      break;
    }
  }

  const prev = alertState.latency.isHighLatency;
  alertState.latency.isHighLatency = anySlowInViewport;
  if (prev !== anySlowInViewport) {
    updateAlertBanners();
  }
}

export function markPostPending(article: HTMLElement) {
  const bar = getVerificationBar(article);
  bar.classList.remove('verified', 'api-error');
  bar.classList.add('pending');
  article.setAttribute('data-ff-pending', '');
  article.classList.remove('ff-error');
  _deps.pendingPosts.add(article);
  article.dataset.pendingStartTime = Date.now().toString();
}

export function markPostVerified(article: HTMLElement) {
  const bar = getVerificationBar(article);
  bar.classList.remove('pending', 'api-error');
  bar.classList.add('verified');
  article.removeAttribute('data-ff-pending');
  article.classList.remove('ff-error');
  _deps.pendingPosts.delete(article);
  delete article.dataset.pendingStartTime;
  checkViewportPendingLatency();
}

export function restoreVerificationBars() {
  const posts = _deps.findPosts();
  posts.forEach(article => {
    if (_deps.processedPosts.has(article) && _deps.postReasonings.has(article)) {
      const stored = _deps.postReasonings.get(article)!;
      if (!stored.shouldHide) {
        const existingBar = article.querySelector('.post-verification-bar');
        if (!existingBar) {
          markPostVerified(article);
        }
      }
    }
  });
}

// ==================== Post Hiding ====================

export function hidePost(article: HTMLElement) {
  _deps.pendingPosts.delete(article);
  delete article.dataset.pendingStartTime;
  article.removeAttribute('data-ff-pending');
  checkViewportPendingLatency();

  _deps.adapter.hidePost(article);
}

// ==================== Reasoning Popup ====================

export function showReasoningPopup(article: HTMLElement, x: number, y: number) {
  hideReasoningPopup();

  const content = _deps.extractPostContent(article);
  const stored = _deps.postReasonings.get(article);

  const popup = document.createElement('div');
  popup.className = 'post-filter-reasoning-popup';

  if (stored) {
    let statusClass: string, statusText: string;
    if (stored.isApiError) {
      statusClass = 'status-error';
      statusText = 'ERROR';
    } else if (stored.shouldHide) {
      statusClass = 'status-hide';
      statusText = 'HIDDEN';
    } else {
      statusClass = 'status-show';
      statusText = 'KEPT';
    }
    const rawResponseSection = stored.rawResponse ? `
      <details class="reasoning-debug">
        <summary>Raw Model Response</summary>
        <pre class="reasoning-debug-html">${escapeHtml(stored.rawResponse)}</pre>
      </details>
    ` : '';
    popup.innerHTML = `
      <div class="reasoning-header">
        <span class="reasoning-status ${statusClass}">${statusText}</span>
        <button class="reasoning-close">&times;</button>
      </div>
      <div class="reasoning-text">${escapeHtml(cleanReasoning(stored.reasoning) ?? '')}</div>
      <div class="reasoning-post">${escapeHtml(content.text.substring(0, 100))}${content.text.length > 100 ? '...' : ''}</div>
      ${rawResponseSection}
      <button class="reasoning-reeval-btn">Re-evaluate</button>
      <button class="reasoning-suggest-btn">Why is this annoying?</button>
      <div class="reasoning-suggestions"></div>
    `;
  } else {
    popup.innerHTML = `
      <div class="reasoning-header">
        <span class="reasoning-status status-pending">PENDING</span>
        <button class="reasoning-close">&times;</button>
      </div>
      <div class="reasoning-text">Post not yet evaluated. It may be queued or no filter rules are set.</div>
      <button class="reasoning-reeval-btn">Evaluate Now</button>
      <button class="reasoning-suggest-btn">Why is this annoying?</button>
      <div class="reasoning-suggestions"></div>
    `;
  }

  popup.style.left = `${x}px`;
  popup.style.top = `${y}px`;

  document.body.appendChild(popup);
  activePopup = popup;

  popup.querySelector('.reasoning-close')!.addEventListener('click', hideReasoningPopup);

  popup.querySelector('.reasoning-reeval-btn')!.addEventListener('click', () => {
    (async () => {
      hideReasoningPopup();
      try {
        await _deps.reEvaluateSinglePost(article);
      } catch (err) {
        console.error('[Bouncer] Re-evaluate error:', err);
      }
    })().catch(err => console.error('[UI] reeval handler failed:', err));
  });

  // Suggest annoying reasons button handler
  popup.querySelector('.reasoning-suggest-btn')!.addEventListener('click', (e) => {
    (async () => {
      const btn = e.currentTarget as HTMLButtonElement;
      const suggestionsDiv = popup.querySelector('.reasoning-suggestions')!;
      btn.disabled = true;
      btn.textContent = 'Thinking...';
      suggestionsDiv.innerHTML = '';
      try {
        const response: { reasons?: string[] } | undefined = await chrome.runtime.sendMessage({
          type: 'suggestAnnoyingReasons',
          post: content.text,
          imageUrls: content.imageUrls || [],
          siteId: _deps.adapter.siteId
        });
        if (response?.reasons?.length) {
          btn.style.display = 'none';
          suggestionsDiv.innerHTML = response.reasons.map(r =>
            `<button class="reasoning-suggestion-chip">${escapeHtml(r)}</button>`
          ).join('');
          suggestionsDiv.querySelectorAll('.reasoning-suggestion-chip').forEach(chip => {
            chip.addEventListener('click', () => {
              const phrase = chip.textContent ?? '';
              addFilterPhrase(phrase).catch(err => console.error('[UI] addFilterPhrase failed:', err));
              chip.classList.add('suggestion-added');
              chip.textContent = `+ ${phrase}`;
              (chip as HTMLButtonElement).disabled = true;
            });
          });
        } else {
          btn.textContent = 'No suggestions';
          btn.disabled = true;
        }
      } catch (err) {
        console.error('[Bouncer] Suggest reasons error:', err);
        btn.textContent = 'Error - try again';
        btn.disabled = false;
      }
    })().catch(err => console.error('[UI] suggest handler failed:', err));
  });

  const rect = popup.getBoundingClientRect();
  if (rect.right > window.innerWidth) {
    popup.style.left = `${window.innerWidth - rect.width - 10}px`;
  }
  if (rect.bottom > window.innerHeight) {
    popup.style.top = `${window.innerHeight - rect.height - 10}px`;
  }

  setTimeout(() => {
    document.addEventListener('click', handleOutsideClick);
  }, 0);
}

export function hideReasoningPopup() {
  if (activePopup) {
    activePopup.remove();
    activePopup = null;
  }
  document.removeEventListener('click', handleOutsideClick);
}

function handleOutsideClick(e: MouseEvent) {
  if (activePopup && !activePopup.contains(e.target as Node)) {
    hideReasoningPopup();
  }
}

// ==================== Toasts ====================

function getToastContainer() {
  if (!toastContainer || !document.body.contains(toastContainer)) {
    toastContainer = document.createElement('div');
    toastContainer.className = 'post-filter-toast-container';
    document.body.appendChild(toastContainer);
  }
  return toastContainer;
}

function dismissToast(toast: HTMLElement) {
  if (!toast || !toast.parentNode) return;
  toast.classList.remove('toast-visible');
  toast.classList.add('toast-hiding');
  setTimeout(() => {
    if (toast.parentNode) {
      toast.parentNode.removeChild(toast);
    }
  }, 300);
}

export function showApiKeyWarning() {
  if (apiKeyWarningShown) return;
  apiKeyWarningShown = true;

  const container = getToastContainer();
  const toast = document.createElement('div');
  toast.className = 'post-filter-toast post-filter-warning';
  toast.innerHTML = `
    <div class="toast-header">
      <span class="toast-title">Feed Filter</span>
      <button class="toast-close">&times;</button>
    </div>
    <div class="toast-content">No API key configured. Click the extension icon to add your Claude API key.</div>
  `;
  container.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('toast-visible'));
  toast.querySelector('.toast-close')!.addEventListener('click', () => dismissToast(toast));
}

function showCategoryLimitWarning() {
  // Show warning in all filter box containers
  const containers = [filterPhrasesContainer, bottomFilterContainer, mobileFilterContainer].filter(Boolean) as HTMLElement[];
  for (const container of containers) {
    // Don't add duplicate warnings
    if (container.querySelector('.ff-category-limit-warning')) continue;
    const warning = document.createElement('div');
    warning.className = 'ff-category-limit-warning';
    warning.textContent = 'You have too many filter categories - please remove some before adding more';
    const actionsRow = container.querySelector('.filter-phrases-actions');
    if (actionsRow) {
      actionsRow.parentNode!.insertBefore(warning, actionsRow);
    }
    // Remove when user types or clicks elsewhere
    const input = container.querySelector<HTMLInputElement>('.filter-phrases-input');
    if (input) {
      const dismiss = () => {
        warning.remove();
        input.removeEventListener('input', dismiss);
        input.removeEventListener('blur', dismiss);
      };
      input.addEventListener('input', dismiss);
      input.addEventListener('blur', dismiss);
    }
  }
}

// ==================== Context Menu ====================

export function addContextMenuHandler(article: HTMLElement) {
  article.addEventListener('contextmenu', (e) => {
    if (!e.ctrlKey) {
      return;
    }

    e.preventDefault();

    const content = _deps.extractPostContent(article);

    const hasContent = content.text.trim() || (content.imageUrls && content.imageUrls.length > 0);
    if (!_deps.postReasonings.has(article) && hasContent) {
      (async () => {
        try {
          const response: { found?: boolean; shouldHide?: boolean; reasoning?: string; rawResponse?: string } | undefined = await chrome.runtime.sendMessage({
            type: 'getReasoning',
            post: formatPostForEvaluation(content),
            imageUrls: content.imageUrls || []
          });
          if (response && response.found) {
            _deps.postReasonings.set(article, {
              shouldHide: response.shouldHide ?? false,
              reasoning: response.reasoning ?? '',
              rawResponse: response.rawResponse ?? null
            });
          }
        } catch (err) {
          console.debug('Failed to get reasoning:', err);
        }
        showReasoningPopup(article, e.clientX, e.clientY);
      })().catch(err => console.error('[UI] getReasoning handler failed:', err));
    } else {
      showReasoningPopup(article, e.clientX, e.clientY);
    }
  });
}

// ==================== DOM Mutation Handler ====================

// ==================== Why Annoying Button ====================

const DEBUG = false;

// Add inline "why annoying" button next to Share post button
export function addWhyAnnoyingButton(article: HTMLElement) {
  if (!_deps.adapter.getShareButton(article)) {
    return;
  }
  // Don't add twice
  if (article.querySelector('.ff-why-annoying-btn')) {
    return;
  }

  const btn = document.createElement('button');
  btn.className = 'ff-why-annoying-btn';
  btn.title = 'Bounce this tweet';
  btn.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M5 6v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V6"/><line x1="10" y1="10" x2="10" y2="17"/><line x1="14" y1="10" x2="14" y2="17"/></svg>`;

  _deps.adapter.insertActionButton(article, btn);

  // Track tooltip reference on the button element
  let btnTooltip: HTMLElement | null = null;

  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();

    // Require Google OAuth before allowing suggest annoyances
    if (!isAuthenticated) {
      document.querySelectorAll('.ff-annoying-tooltip').forEach(t => t.remove());
      const tooltip = document.createElement('div');
      tooltip.className = 'ff-annoying-tooltip';
      btn.style.position = 'relative';
      tooltip.innerHTML = '<span class="ff-annoying-empty">Sign in with Google to use this feature</span>';
      btn.appendChild(tooltip);
      return;
    }

    // If tooltip already open on this button, close it
    if (btnTooltip && btnTooltip.isConnected) {
      btnTooltip.remove();
      btnTooltip = null;
      return;
    }

    // Close any other open tooltips
    document.querySelectorAll('.ff-annoying-tooltip').forEach(t => t.remove());

    const content = _deps.extractPostContent(article);

    // Create tooltip — append to body with fixed positioning so it escapes
    // any overflow:hidden ancestors in Twitter's DOM
    const tooltip = document.createElement('div');
    tooltip.className = 'ff-annoying-tooltip';
    document.body.appendChild(tooltip);
    btnTooltip = tooltip;

    // Position the tooltip above the button
    const positionTooltip = () => {
      const btnRect = btn.getBoundingClientRect();
      tooltip.style.position = 'fixed';
      tooltip.style.right = `${document.documentElement.clientWidth - btnRect.right}px`;
      // Place above the button; if clipped, place below
      tooltip.style.bottom = '';
      tooltip.style.top = '';
      const tentativeTop = btnRect.top - tooltip.offsetHeight - 8;
      if (tentativeTop < 0) {
        tooltip.style.top = `${btnRect.bottom + 8}px`;
        tooltip.classList.add('ff-annoying-tooltip--flipped');
      } else {
        tooltip.style.bottom = `${window.innerHeight - btnRect.top + 8}px`;
        tooltip.classList.remove('ff-annoying-tooltip--flipped');
      }
    };
    requestAnimationFrame(positionTooltip);

    // Reposition on scroll; dismiss if button leaves viewport
    const onScroll = () => {
      if (!tooltip.isConnected) {
        window.removeEventListener('scroll', onScroll, true);
        return;
      }
      const btnRect = btn.getBoundingClientRect();
      if (btnRect.bottom < 0 || btnRect.top > window.innerHeight) {
        tooltip.remove();
        window.removeEventListener('scroll', onScroll, true);
        return;
      }
      positionTooltip();
    };
    window.addEventListener('scroll', onScroll, true);

    // Use prefetched result if available, otherwise fire a new request
    let cachedPromise = annoyingReasonsCache.get(article);
    if (!cachedPromise) {
      cachedPromise = chrome.runtime.sendMessage({
        type: 'suggestAnnoyingReasons',
        post: content.text,
        imageUrls: content.imageUrls || [],
        siteId: _deps.adapter.siteId
      });
      annoyingReasonsCache.set(article, cachedPromise);
    }

    (async () => {
    // Check if the promise is already resolved (settled) by racing with an instant resolve
    let response: { reasons: string[]; hadImages?: boolean } | null = null;
    const settled = await Promise.race([
      cachedPromise.then((r: { reasons: string[]; hadImages?: boolean }) => { response = r; return 'done' as const; }),
      Promise.resolve('pending' as const)
    ]);
    const alreadyDone = settled === 'done';

    if (!alreadyDone) {
      // Still loading — show spinner while we wait
      tooltip.innerHTML = `<div class="ff-annoying-spinner"><div class="ff-spinner-dot"></div><div class="ff-spinner-dot"></div><div class="ff-spinner-dot"></div></div><span class="ff-annoying-thinking">Diagnosing annoyances</span><div class="ff-progress-bar"><div class="ff-progress-track"><div class="ff-progress-fill" data-stage="0"></div></div></div><a href="#" class="ff-missed-link">This should already be filtered</a>`;

      const progressListener = (message: { type: string; verified: number }) => {
        if (message.type === 'annoyingProgress') {
          const fill = tooltip.querySelector<HTMLElement>('.ff-progress-fill');
          if (fill) {
            const stage = Math.min(message.verified, 3);
            fill.dataset.stage = String(stage);
            fill.style.width = `${(stage / 3) * 100}%`;
          }
        }
      };
      chrome.runtime.onMessage.addListener(progressListener);

      const cleanupProgress = () => {
        chrome.runtime.onMessage.removeListener(progressListener);
      };

      tooltip.querySelector('.ff-missed-link')!.addEventListener('click', (linkEvent) => {
        linkEvent.preventDefault();
        linkEvent.stopPropagation();
        const reasoning = _deps.postReasonings.get(article);
        chrome.runtime.sendMessage({
          type: 'sendFeedback',
          siteId: _deps.adapter.siteId,
          tweetData: { text: formatPostForEvaluation(content), imageUrls: content.imageUrls || [] },
          rawResponse: reasoning?.rawResponse || '',
          reasoning: reasoning?.reasoning || '',
          decision: 'false_negative'
        }).catch(err => console.error('[Bouncer] Missed feedback error:', err));
        tooltip.remove();
        storeFilteredPost(article, content, 'User reported: should have been filtered');
        article.style.transition = 'opacity 0.3s ease';
        article.style.opacity = '0';
        setTimeout(() => hidePost(article), 300);
        chrome.runtime.sendMessage({
          type: 'overrideCacheEntry',
          post: formatPostForEvaluation(content),
          imageUrls: content.imageUrls || [],
          shouldHide: true,
          reasoning: 'User reported: should have been filtered'
        }).catch(err => console.error('[Bouncer] Override cache error:', err));
      });
      try {
        response = await cachedPromise as { reasons: string[]; hadImages?: boolean };
      } catch (err) {
        console.error('[Bouncer] Why annoying error:', err);
        cleanupProgress();
        tooltip.innerHTML = '<span class="ff-annoying-empty">Error - try again</span>';
        annoyingReasonsCache.delete(article);
        return;
      }
      cleanupProgress();
    }

    // Render results
    tooltip.innerHTML = '';
    if (response && response.reasons?.length) {
      const resp = response;
      const label = document.createElement('span');
      label.className = 'ff-annoying-label';
      label.textContent = 'Block this due to:';
      tooltip.appendChild(label);
      resp.reasons.forEach(r => {
        const chip = document.createElement('button');
        chip.className = 'ff-annoying-chip';
        chip.textContent = r;
        if (DEBUG) {
          const imgBadge = document.createElement('span');
          imgBadge.className = 'ff-img-badge';
          imgBadge.textContent = resp.hadImages ? '[img]' : '[txt]';
          chip.appendChild(imgBadge);
        }
        chip.addEventListener('click', (ce) => {
          ce.stopPropagation();
          // Remove tooltip before the filter triggers re-evaluation and captures the post
          tooltip.remove();
          addFilterPhrase(r).catch(err => console.error('[UI] addFilterPhrase failed:', err));
        });
        tooltip.appendChild(chip);
      });
    } else {
      tooltip.innerHTML = '<span class="ff-annoying-empty">No suggestions</span>';
    }
      // "Should have been filtered" link
      const missedLink = document.createElement('a');
      missedLink.className = 'ff-missed-link';
      missedLink.textContent = 'This should already be filtered';
      missedLink.href = '#';
      missedLink.addEventListener('click', (linkEvent) => {
        linkEvent.preventDefault();
        linkEvent.stopPropagation();
        const reasoning = _deps.postReasonings.get(article);
        chrome.runtime.sendMessage({
          type: 'sendFeedback',
          siteId: _deps.adapter.siteId,
          tweetData: { text: formatPostForEvaluation(content), imageUrls: content.imageUrls || [] },
          rawResponse: reasoning?.rawResponse || '',
          reasoning: reasoning?.reasoning || '',
          decision: 'false_negative'
        }).catch(err => console.error('[Bouncer] Missed feedback error:', err));
        tooltip.remove();
        storeFilteredPost(article, content, 'User reported: should have been filtered');
        article.style.transition = 'opacity 0.3s ease';
        article.style.opacity = '0';
        setTimeout(() => hidePost(article), 300);
        chrome.runtime.sendMessage({
          type: 'overrideCacheEntry',
          post: formatPostForEvaluation(content),
          imageUrls: content.imageUrls || [],
          shouldHide: true,
          reasoning: 'User reported: should have been filtered'
        }).catch(err => console.error('[Bouncer] Override cache error:', err));
      });
      tooltip.appendChild(missedLink);

    // Reposition after content change (height may differ from spinner)
    requestAnimationFrame(positionTooltip);
    })().catch(err => console.error('[UI] annoying reasons tooltip failed:', err));
  });

  // Close tooltip when clicking outside
  document.addEventListener('click', (e) => {
    if (!btn.contains(e.target as Node)) {
      document.querySelectorAll('.ff-annoying-tooltip').forEach(t => {
        if (!t.contains(e.target as Node)) t.remove();
      });
    }
  });
}

// Hide bouncer sidebar when Twitter's search suggestions menu is open (so it doesn't cover the dropdown)
export function setupSearchBarHide() {
  new MutationObserver(() => {
    const form = _deps.adapter.getSearchForm();
    const secondChild = form?.children[1];
    const menuOpen = secondChild && secondChild.innerHTML.trim() !== '';
    if (filterPhrasesContainer) {
      filterPhrasesContainer.style.display = menuOpen ? 'none' : '';
    }
  }).observe(document.body, { childList: true, subtree: true });
}

export function handleDOMMutation() {
  // Check if containers were disconnected
  if (filterPhrasesContainer && !filterPhrasesContainer.isConnected) {
    filterPhrasesContainer = null;
    filteredTabActive = false;
  }
  if (bottomFilterContainer && !bottomFilterContainer.isConnected) {
    bottomFilterContainer = null;
    bottomFilterExpanded = true;
  }
  if (mobileFilterContainer && !mobileFilterContainer.isConnected) {
    mobileFilterContainer = null;
  }
  // Inject filter phrases input if not present
  if (!filterPhrasesContainer && document.querySelector(_deps.adapter.selectors.sidebar)) {
    injectFilterPhrasesInput();
  } else {
    updateSidebarFilterVisibility();
  }
  // Inject bottom filter box if not present
  if (!bottomFilterContainer) {
    injectBottomFilterBox();
  } else {
    updateBottomFilterVisibility();
  }
  // Inject mobile filter box if not present
  if (!mobileFilterContainer && document.querySelector(_deps.adapter.selectors.nav)) {
    injectMobileFilterBox();
  } else {
    updateMobileFilterVisibility();
  }
}
