// iOS overlay, FAB, scroll lock

import type { IOSDeps } from '../types';
import { getDescriptions } from '../shared/storage';

// Dependencies (set by initIOS from index.ts)
let _deps: IOSDeps;

// iOS Safari detection (for Safari Web Extension on iOS)
export function isIOSSafari() {
  const ua = navigator.userAgent;
  const isIOS = /iPad|iPhone|iPod/.test(ua) ||
                (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isSafari = /Safari/.test(ua) && !/Chrome|CriOS|FxiOS/.test(ua);
  return isIOS && isSafari;
}

export const IS_IOS = isIOSSafari();

// State
let ffPageActive = false;
let iosPageContainer: HTMLElement | null = null;
let ffFabButton: HTMLElement | null = null;

export function initIOS(deps: IOSDeps) {
  _deps = deps;
}

// State accessors
export function getFFPageActive() { return ffPageActive; }
export function getIOSPageContainer() { return iosPageContainer; }
export function getFFFabButton() { return ffFabButton; }

// Inject a Bouncer FAB button on iOS, inside the compose button's container
// so it moves with the compose button automatically (no scroll/resize listeners needed)
export function injectBouncerFAB() {
  // Don't duplicate
  if (document.querySelector('.ff-fab-button')) return;

  // Only show on pages where filtering is active
  if (!_deps.adapter.shouldProcessCurrentPage()) return;

  // Find the FloatingActionButtonBase container that holds the compose <a>
  const fabBase = document.querySelector<HTMLElement>('div[data-testid="FloatingActionButtonBase"]');
  if (!fabBase) return;

  const fab = document.createElement('button');
  fab.className = 'ff-fab-button';
  fab.setAttribute('aria-label', 'Bouncer');
  fab.innerHTML = `
    <svg viewBox="17 25 166 166" width="20" height="20">
      <ellipse cx="45" cy="178" rx="26" ry="8" fill="white"/>
      <rect x="19" y="170" width="52" height="8" rx="3" fill="white"/>
      <rect x="38" y="48" width="14" height="122" fill="white" rx="3"/>
      <circle cx="45" cy="43" r="13" fill="white"/>
      <ellipse cx="155" cy="178" rx="26" ry="8" fill="white"/>
      <rect x="129" y="170" width="52" height="8" rx="3" fill="white"/>
      <rect x="148" y="48" width="14" height="122" fill="white" rx="3"/>
      <circle cx="155" cy="43" r="13" fill="white"/>
      <rect x="52" y="60" width="8" height="6" rx="2" fill="white"/>
      <rect x="140" y="60" width="8" height="6" rx="2" fill="white"/>
      <path d="M 58 63 Q 100 128 142 63" stroke="white" stroke-width="9" fill="none" stroke-linecap="round"/>
      <circle cx="58" cy="63" r="6" fill="white"/>
      <circle cx="142" cy="63" r="6" fill="white"/>
    </svg>
    <span class="ff-fab-badge" style="display: none;">0</span>
  `;

  fab.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (ffPageActive) {
      hideBouncerPage();
    } else {
      showBouncerPage();
    }
  });

  // Make the container a positioning context and insert the FAB
  fabBase.style.position = 'relative';
  fabBase.appendChild(fab);
  ffFabButton = fab;
}

// Show the full-page Bouncer view as a fixed overlay on document.body
export function showBouncerPage() {
  // Create the Bouncer overlay if it doesn't already exist
  if (!iosPageContainer || !iosPageContainer.isConnected) {
    iosPageContainer = document.createElement('div');
    iosPageContainer.className = 'ff-ios-page';
    iosPageContainer.innerHTML = `
      <div class="ff-ios-page-header">
        <button class="ff-ios-settings-btn" aria-label="Settings">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor">
            <path d="M10.54 1.75h2.92l1.57 2.36c.11.17.32.25.53.21l2.53-.59 2.17 2.17-.58 2.54c-.05.2.04.41.21.53l2.36 1.57v2.92l-2.36 1.57c-.17.12-.26.33-.21.53l.58 2.54-2.17 2.17-2.53-.59c-.21-.04-.42.04-.53.21l-1.57 2.36h-2.92l-1.58-2.36c-.11-.17-.32-.25-.52-.21l-2.54.59-2.17-2.17.58-2.54c.05-.2-.03-.41-.21-.53l-2.35-1.57v-2.92L4.1 8.97c.18-.12.26-.33.21-.53L3.73 5.9 5.9 3.73l2.54.59c.2.04.41-.04.52-.21l1.58-2.36zm1.07 2l-.98 1.47C10.05 6.08 9 6.5 7.99 6.27l-1.46-.34-.6.6.33 1.46c.24 1.01-.18 2.07-1.05 2.64l-1.46.98v.78l1.46.98c.87.57 1.29 1.63 1.05 2.64l-.33 1.46.6.6 1.46-.34c1.01-.23 2.06.19 2.64 1.05l.98 1.47h.78l.97-1.47c.58-.86 1.63-1.28 2.65-1.05l1.45.34.61-.6-.34-1.46c-.23-1.01.18-2.07 1.05-2.64l1.47-.98v-.78l-1.47-.98c-.87-.57-1.28-1.63-1.05-2.64l.34-1.46-.61-.6-1.45.34c-1.02.23-2.07-.19-2.65-1.05l-.97-1.47h-.78zM12 10.5c-.83 0-1.5.67-1.5 1.5s.67 1.5 1.5 1.5c.82 0 1.5-.67 1.5-1.5s-.68-1.5-1.5-1.5zM8.5 12c0-1.93 1.56-3.5 3.5-3.5 1.93 0 3.5 1.57 3.5 3.5s-1.57 3.5-3.5 3.5c-1.94 0-3.5-1.57-3.5-3.5z"/>
          </svg>
        </button>
        <span class="ff-ios-page-title">Bouncer</span>
        <button class="ff-ios-close-btn" aria-label="Close">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor">
            <path d="M10.59 12L4.54 5.96l1.42-1.42L12 10.59l6.04-6.05 1.42 1.42L13.41 12l6.05 6.04-1.42 1.42L12 13.41l-6.04 6.05-1.42-1.42L10.59 12z"/>
          </svg>
        </button>
      </div>
      <div class="ff-ios-subtitle">Filter out these terms:</div>
      <div class="ff-ios-categories-list"></div>
      <div class="ff-ios-bottom-bar">
        <button class="ff-ios-view-filtered-btn">View filtered (0)</button>
        <div class="ff-ios-input-bar">
          <input type="text" class="ff-ios-phrase-input" placeholder="Add a topic to filter...">
          <button class="ff-ios-send-btn" aria-label="Add">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="white">
              <path d="M3.478 2.405a.75.75 0 0 0-.926.94l2.432 7.905H13.5a.75.75 0 0 1 0 1.5H4.984l-2.432 7.905a.75.75 0 0 0 .926.94l18-8a.75.75 0 0 0 0-1.38l-18-8z"/>
            </svg>
          </button>
        </div>
      </div>
    `;

    // Append to body so position:fixed works relative to viewport
    // (BottomBar ancestors have transforms that break fixed positioning)
    document.body.appendChild(iosPageContainer);
    setupIOSPageEventHandlers(iosPageContainer);
  }

  // Lock body scroll to prevent bleed-through on iOS
  document.body.style.setProperty('--ff-scroll-y', `-${window.scrollY}px`);
  document.body.classList.add('ff-scroll-locked');

  // Play entrance animations (keep class until staggered row animations finish)
  iosPageContainer.classList.add('entering');
  setTimeout(() => {
    if (iosPageContainer) iosPageContainer.classList.remove('entering');
  }, 1500);

  // Render categories from storage
  renderIOSCategories(iosPageContainer);

  // Update theme, count
  _deps.updateTheme();
  updateIOSFilteredCount();

  ffPageActive = true;
}

// Render category rows from storage into the iOS page
export function renderIOSCategories(page: HTMLElement) {
  const list = page.querySelector('.ff-ios-categories-list');
  if (!list) return;

  getDescriptions(_deps.descriptionsKey).then((descriptions) => {
    // Clear inside the callback to prevent race condition duplicates
    list.innerHTML = '';
    const subtitle = page.querySelector<HTMLElement>('.ff-ios-subtitle');
    if (descriptions.length === 0) {
      if (subtitle) subtitle.style.display = 'none';
      list.innerHTML = '<div class="ff-ios-categories-empty">No topics added yet. Use the input below to add topics you want to filter out.</div>';
      return;
    }
    if (subtitle) subtitle.style.display = '';
    descriptions.forEach((phrase, index) => {
      const row = document.createElement('div');
      row.className = 'ff-ios-category-row';
      row.style.setProperty('--row-index', String(index));
      row.innerHTML = `
        <span class="ff-ios-category-text">${phrase}</span>
        <button class="ff-ios-category-remove" aria-label="Remove ${phrase}">&times;</button>
      `;
      row.querySelector('.ff-ios-category-remove')!.addEventListener('click', () => {
        _deps.removeFilterPhrase(phrase).catch(err => console.error('[iOS] removeFilterPhrase failed:', err));
        // Re-render after removal
        renderIOSCategories(page);
      });
      list.appendChild(row);
    });
  }).catch(err => console.error('[iOS] Failed to load descriptions:', err));
}

// Update the "View filtered (N)" button count on iOS page
export function updateIOSFilteredCount() {
  if (!iosPageContainer || !iosPageContainer.isConnected) return;
  const btn = iosPageContainer.querySelector('.ff-ios-view-filtered-btn');
  if (btn) {
    btn.textContent = `View filtered (${_deps.getFilteredPosts().length})`;
  }
}

// Wire up event handlers for the iOS overlay page
function setupIOSPageEventHandlers(page: HTMLElement) {
  // Close (X) button
  const closeBtn = page.querySelector('.ff-ios-close-btn');
  if (closeBtn) {
    closeBtn.addEventListener('click', () => hideBouncerPage());
  }

  // Settings gear button
  const settingsBtn = page.querySelector('.ff-ios-settings-btn');
  if (settingsBtn) {
    settingsBtn.addEventListener('click', () => _deps.showSettingsModal());
  }

  // "View filtered" button opens modal
  const viewFilteredBtn = page.querySelector('.ff-ios-view-filtered-btn');
  if (viewFilteredBtn) {
    viewFilteredBtn.addEventListener('click', () => showIOSFilteredModal());
  }

  // Input + send button
  const input = page.querySelector<HTMLInputElement>('.ff-ios-phrase-input');
  const sendBtn = page.querySelector('.ff-ios-send-btn');

  // Dismiss keyboard on scroll and fix iOS Safari viewport desync
  if (input) {
    page.addEventListener('touchmove', () => {
      if (document.activeElement === input) {
        input.blur();
      }
    });
    input.addEventListener('blur', () => {
      window.scrollTo(0, 0);
      page.style.transform = 'translateZ(1px)';
      void page.offsetHeight;
      page.style.transform = '';
    });
  }

  if (sendBtn && input) {
    const handleSend = async () => {
      const text = input.value.trim();
      if (text) {
        try {
          const added = await _deps.addFilterPhrase(text);
          if (added) {
            input.value = '';
            input.blur();
            renderIOSCategories(page);
            updateIOSFilteredCount();
          }
        } catch (err) {
          console.error('[Bouncer] addFilterPhrase threw:', err);
        }
      }
    };
    sendBtn.addEventListener('touchend', (e) => {
      e.preventDefault();
      handleSend().catch(err => console.error('[iOS] handleSend failed:', err));
    });
    sendBtn.addEventListener('click', () => { handleSend().catch(err => console.error('[iOS] handleSend failed:', err)); });
  } else {
    console.warn('[Bouncer] sendBtn or input NOT found. sendBtn:', sendBtn, 'input:', input);
  }

  if (input) {
    input.addEventListener('keypress', (e) => {
      (async () => {
        if (e.key === 'Enter') {
          e.preventDefault();
          const text = input.value.trim();
          if (text) {
            try {
              const added = await _deps.addFilterPhrase(text);
              if (added) {
                input.value = '';
                input.blur();
                renderIOSCategories(page);
                updateIOSFilteredCount();
              }
            } catch (err) {
              console.error('[Bouncer] addFilterPhrase threw:', err);
            }
          }
        }
      })().catch(err => console.error('[iOS] keypress handler failed:', err));
    });
  }
}

// Show iOS filtered posts modal
export function showIOSFilteredModal() {
  // Remove existing modal if any
  hideIOSFilteredModal();

  const backdrop = document.createElement('div');
  backdrop.className = 'ff-ios-filtered-modal-backdrop';
  backdrop.innerHTML = `
    <div class="ff-ios-filtered-modal">
      <div class="ff-ios-filtered-modal-header">
        <span class="ff-ios-filtered-modal-title">Filtered posts</span>
        <button class="ff-ios-filtered-modal-close" aria-label="Close">&times;</button>
      </div>
      <div class="ff-ios-filtered-modal-content"></div>
    </div>
  `;

  document.body.appendChild(backdrop);

  // Render filtered posts into modal content
  const content = backdrop.querySelector<HTMLElement>('.ff-ios-filtered-modal-content');
  if (content) {
    _deps.renderFilteredPostsView(content);
  }

  // Apply theme
  const theme = _deps.adapter.getThemeMode();
  backdrop.classList.add(`${theme}-mode`);

  // Animate in
  requestAnimationFrame(() => {
    backdrop.classList.add('visible');
  });

  // Close on X button
  backdrop.querySelector('.ff-ios-filtered-modal-close')!.addEventListener('click', () => {
    hideIOSFilteredModal();
  });

  // Close on backdrop click
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) {
      hideIOSFilteredModal();
    }
  });
}

// Hide iOS filtered posts modal
export function hideIOSFilteredModal() {
  const existing = document.querySelector('.ff-ios-filtered-modal-backdrop');
  if (existing) {
    existing.classList.add('closing');
    existing.classList.remove('visible');
    setTimeout(() => {
      if (existing.isConnected) existing.remove();
    }, 350);
  }
}

// Hide the Bouncer page overlay
export function hideBouncerPage() {
  if (!ffPageActive) return;
  ffPageActive = false;

  // Also dismiss any open filtered modal
  hideIOSFilteredModal();

  // Unlock body scroll and restore position
  const scrollY = parseInt(document.body.style.getPropertyValue('--ff-scroll-y') || '0');
  document.body.classList.remove('ff-scroll-locked');
  document.body.style.removeProperty('--ff-scroll-y');
  window.scrollTo(0, -scrollY);

  // Play close animation, then remove
  if (iosPageContainer && iosPageContainer.isConnected) {
    iosPageContainer.classList.add('closing');
    iosPageContainer.addEventListener('animationend', () => {
      if (iosPageContainer && iosPageContainer.isConnected) {
        iosPageContainer.remove();
      }
      iosPageContainer = null;
    }, { once: true });
  } else {
    iosPageContainer = null;
  }
}

// Handle DOM mutations related to iOS elements (called from index.ts uiObserver)
export function handleDOMMutationIOS() {
  if (!IS_IOS) return;

  if (ffFabButton && ffFabButton.isConnected && !_deps.adapter.shouldProcessCurrentPage()) {
    ffFabButton.remove();
    ffFabButton = null;
  } else if (!ffFabButton || !ffFabButton.isConnected) {
    ffFabButton = null;
    injectBouncerFAB();
  }
  // Detect if ff-ios-page was disconnected (SPA navigation replaced primaryColumn)
  if (ffPageActive && iosPageContainer && !iosPageContainer.isConnected) {
    iosPageContainer = null;
    ffPageActive = false;
  }
}
