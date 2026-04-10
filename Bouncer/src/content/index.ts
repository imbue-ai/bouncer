// Bouncer - Content Script
// Entry point: post processing, observers, init, storage/message listeners

import type { PlatformAdapter, PostContent, PipelineResponse, BackgroundToContentMessage, DescriptionKey } from '../types';
import { getStorage, removeStorage, getDescriptions, setDescriptions } from '../shared/storage';

import {
  IS_IOS, initIOS,
  getFFPageActive, getIOSPageContainer, getFFFabButton,
  renderIOSCategories, updateIOSFilteredCount,
  handleDOMMutationIOS,
} from './ios';

import {
  initUI, checkAuthStatus,
  getFilteredPosts, getFilteredTabActive, updateAlertState, alertState,
  updateTheme,
  injectFilterPhrasesInput, injectBottomFilterBox, injectMobileFilterBox,
  syncFilterPhrases, addFilterPhrase, removeFilterPhrase,
  showSettingsModal, renderFilteredPostsView,
  updateAlertBanners, initModelLoadingListener,
  markPostPending, markPostVerified, getVerificationBar,
  storeFilteredPost, hidePost, showApiKeyWarning,
  addContextMenuHandler,
  addWhyAnnoyingButton,
  handleDOMMutation,
  setupSearchBarHide,
  checkViewportPendingLatency,
} from './ui';

import { formatPostForEvaluation } from '../shared/utils';

(function() {
  'use strict';

  // Platform adapter (loaded by manifest before content.js)
  if (typeof BouncerAdapter === 'undefined') {
    console.error('[Bouncer] No platform adapter found');
    return;
  }
  const adapter: PlatformAdapter = new BouncerAdapter();
  document.body.classList.add(`site-${adapter.siteId}`);

  if (IS_IOS) document.body.classList.add('ff-ios');

  // Site-specific storage key for filter phrases
  const descriptionsKey: DescriptionKey = `descriptions_${adapter.siteId}`;

  // One-time migration: move descriptions from sync to local storage
  (async () => {
    const localArr = await getDescriptions(descriptionsKey);
    if (localArr.length) return; // already migrated
    const syncArr = await getDescriptions(descriptionsKey);
    if (syncArr.length) {
      await setDescriptions(descriptionsKey, syncArr);
      await removeStorage(descriptionsKey);
    }
  })().catch(err => console.error('[Bouncer] Migration failed:', err));


  // ==================== Core State ====================

  const processedPosts = new WeakSet<HTMLElement>();
  const postReasonings = new WeakMap<HTMLElement, { shouldHide: boolean; reasoning: string; rawResponse?: string | null; isApiError?: boolean }>();
  const errorPostUrls = new Set<string>();
  const lastProcessedContent = new WeakMap<HTMLElement, string>();
  const pendingPostReeval = new Map<HTMLElement, ReturnType<typeof setTimeout>>();
  const POST_REEVAL_DELAY = 50;

  const pendingPosts = new Set<HTMLElement>();
  const stuckPostCheckDelay = 5000;
  let isLocalModelActive = false;
  let enabled = true;
  let currentlyProcessingPostUrl: string | null = null;

  // ==================== Wire up modules ====================

  initUI({
    adapter,
    descriptionsKey,
    IS_IOS,
    // iOS state/functions
    getIOSPageContainer,
    getFFFabButton,
    updateIOSFilteredCount,
    renderIOSCategories,
    // Index functions
    findPosts: () => findPosts(),
    extractPostContent: (article: HTMLElement) => extractPostContent(article),
    reEvaluateAllPosts: () => reEvaluateAllPosts(),
    processExistingPosts: () => processExistingPosts(),
    evaluatePost: (article: HTMLElement) => evaluatePost(article),
    reEvaluateSinglePost: (article: HTMLElement) => reEvaluateSinglePost(article),
    // Shared state (refs)
    processedPosts,
    postReasonings,
    pendingPosts,
  });

  initIOS({
    adapter,
    descriptionsKey,
    // UI functions
    showSettingsModal,
    renderFilteredPostsView,
    updateTheme,
    addFilterPhrase,
    removeFilterPhrase,
    getFilteredPosts,
  });

  // ==================== Core Functions ====================

  function findPosts(): HTMLElement[] {
    return Array.from(document.querySelectorAll<HTMLElement>(adapter.selectors.post));
  }

  function extractPostContent(article: HTMLElement): PostContent {
    return adapter.extractPostContent(article);
  }

  async function checkLocalModelActive() {
    try {
      const data = await getStorage(['selectedModel']);
      const defaultModel = process.env.HAS_IMBUE_BACKEND === 'true' ? 'imbue' : '';
      const model = data.selectedModel || defaultModel;
      isLocalModelActive = model.startsWith('local:');
      // Keep latency alert state in sync so the viewport-based latency check
      // knows which model is active before any latencyUpdate message arrives.
      alertState.latency.selectedModel = model;
    } catch (err) {
      console.debug('[Bouncer] Failed to check model type:', err);
      isLocalModelActive = false;
    }
  }

  // Re-evaluate a single post
  async function reEvaluateSinglePost(article: HTMLElement) {
    // Use store data for cache clearing (same source as evaluatePost)
    let content: PostContent | undefined;
    try {
      content = await adapter.extractPostContentFromStore(article) ?? undefined;
    } catch { /* store not ready */ }
    if (!content) return;

    const hasContent = content.text.trim() || (content.imageUrls && content.imageUrls.length > 0);
    if (!hasContent) return;

    await chrome.runtime.sendMessage({
      type: 'clearSinglePost',
      post: formatPostForEvaluation(content),
      imageUrls: content.imageUrls || []
    });

    postReasonings.delete(article);
    await evaluatePost(article);
  }

  const MAX_STORE_RETRIES = 3;

  // Evaluate a post using the background script
  async function evaluatePost(article: HTMLElement) {
    // Extract post content from platform store (sole source of evaluation data)
    let content: PostContent | undefined;
    try {
      content = await adapter.extractPostContentFromStore(article) ?? undefined;
    } catch { /* store not ready */ }

    // If store returned nothing, defer for MutationObserver to retry
    if (!content) {
      const retries = parseInt(article.dataset.ffStoreRetries || '0', 10);
      if (retries >= MAX_STORE_RETRIES) {
        console.warn('[Bouncer] Store extraction failed after', MAX_STORE_RETRIES, 'retries, skipping post');
        postReasonings.set(article, {
          shouldHide: false,
          reasoning: 'Could not extract post data from store.'
        });
        markPostVerified(article);
        return;
      }
      article.dataset.ffStoreRetries = String(retries + 1);
      processedPosts.delete(article);
      return;
    }

    // Clear retry counter on success
    delete article.dataset.ffStoreRetries;

    const hasText = content.text.trim().length > 0;
    const hasImages = content.imageUrls && content.imageUrls.length > 0;

    if (!hasText && !hasImages) {
      postReasonings.set(article, {
        shouldHide: false,
        reasoning: 'No text or images to evaluate.'
      });
      markPostVerified(article);
      return;
    }

    try {
      const evaluatePromise = chrome.runtime.sendMessage({
          type: 'evaluatePost',
          post: formatPostForEvaluation(content),
          imageUrls: content.imageUrls || [],
          postUrl: content.postUrl || null,
          siteId: adapter.siteId
        });
      const response = await evaluatePromise as PipelineResponse;

      // Clear processing tracker when this post's evaluation completes
      if (content.postUrl && content.postUrl === currentlyProcessingPostUrl) {
        currentlyProcessingPostUrl = null;
      }

      if (response === null) {
        // Skip - post stays as-is (pending). Covers: disabled, no_rules, page_reload.
        return;
      }

      if ('retry' in response) {
        // Retry cases (model_not_downloaded, settings_changed) - remove from processed so post retries
        processedPosts.delete(article);
        return;
      }

      if ('error' in response) {
        if (response.error === 'no_api_key') {
          showApiKeyWarning();
          postReasonings.set(article, {
            shouldHide: false,
            reasoning: 'No API key configured.'
          });
          markPostVerified(article);
          return;
        }
        // PipelineError - track for retry via error broadcasts
        postReasonings.set(article, { shouldHide: false, isApiError: true, reasoning: response.reasoning });
        if (content.postUrl) errorPostUrls.add(content.postUrl);
        article.dataset.errorType = response.error;
        const verificationBar = getVerificationBar(article);
        verificationBar.classList.remove('pending', 'verified', 'api-error');
        verificationBar.classList.add(response.error === 'rate_limit' ? 'pending' : 'api-error');
        article.removeAttribute('data-ff-pending');
        article.classList.add('ff-error');
        return;
      }

      // EvaluationResult
      postReasonings.set(article, {
        shouldHide: response.shouldHide,
        reasoning: response.reasoning || 'No reasoning available',
        rawResponse: response.rawResponse || null
      });

      if (response.shouldHide) {
        if (content.postUrl) {
          errorPostUrls.delete(content.postUrl);
        }

        // Re-extract fresh DOM data for display HTML (links, emojis, formatting)
        const freshContent = extractPostContent(article);
        const mergedContent: PostContent = {
          ...content,
          // Images: always use store data (complete from the start)
          imageUrls: content.imageUrls?.length > 0 ? content.imageUrls : freshContent.imageUrls,
          // Display HTML: always prefer DOM (has rich formatting)
          textHtml: freshContent.textHtml || content.textHtml,
          quote: freshContent.quote || content.quote,
          // Best of both for metadata
          postUrl: content.postUrl || freshContent.postUrl,
          avatarUrl: freshContent.avatarUrl || content.avatarUrl,
        };

        // Store in filtered posts list
        storeFilteredPost(article, mergedContent, response.reasoning, response.rawResponse || '', response.category || null);

        const bar = article.querySelector('.post-verification-bar');
        const wasVerified = bar && bar.classList.contains('verified');

        // Skip the fade-out animation for posts above the viewport —
        // they'll be hidden later by the observer when they scroll into view
        const container = adapter.getPostContainer(article);
        const isAboveViewport = container && container.getBoundingClientRect().bottom <= 0;

        if (isAboveViewport) {
          hidePost(article);
        } else if (wasVerified) {
          article.style.transition = 'opacity 0.3s ease';
          article.style.opacity = '0';
          setTimeout(() => hidePost(article), 300);
        } else if (response.cached) {
          // Instant hide for cache hits (post was already evaluated in a prior scroll)
          hidePost(article);
        } else {
          // Animated fade-out for fresh evaluations
          article.style.transition = 'opacity 0.3s ease';
          article.style.opacity = '0';
          setTimeout(() => hidePost(article), 300);
        }
      } else {
        if (content.postUrl) {
          errorPostUrls.delete(content.postUrl);
        }
        markPostVerified(article);
      }
    } catch (err) {
      console.debug('Post evaluation error:', err);
      postReasonings.set(article, {
        shouldHide: false,
        reasoning: `Error evaluating: ${(err instanceof Error) ? err.message : 'Unknown error'}`
      });
      markPostVerified(article);
    }
  }

  // Process a single post - sends it to background for evaluation
  function processPost(article: HTMLElement, forceForYou = false) {
    if (getFFPageActive()) return;
    if (!forceForYou && !adapter.shouldProcessCurrentPage()) return;

    if (adapter.isMainPost(article)) return;

    if (processedPosts.has(article)) return;
    if (article.dataset.filteredByExtension) return;

    if (article.closest('.filtered-view-container') || article.closest('.ff-ios-page')) return;

    processedPosts.add(article);

    // Track post identity via URL (lightweight - avoids full DOM extraction)
    const contentKey = adapter.getPostContentKey(article);
    lastProcessedContent.set(article, contentKey);

    addContextMenuHandler(article);

    // Add inline "why annoying" trash-can button next to Share
    addWhyAnnoyingButton(article);

    if (forceForYou || adapter.shouldProcessCurrentPage()) {
      evaluatePost(article).catch(err => console.error('[Bouncer] evaluatePost failed:', err));
    }
  }

  function processExistingPosts(forceForYou = false) {
    const posts = findPosts();
    posts.forEach(article => processPost(article, forceForYou));
  }

  function reEvaluateAllPosts() {
    const posts = findPosts();
    posts.forEach(article => {
      if (adapter.getPostContainer(article).dataset.filteredByExtension) {
        return;
      }
      if (adapter.isMainPost(article)) return;

      processedPosts.delete(article);
      markPostPending(article);
      evaluatePost(article).catch(err => console.error('[Bouncer] evaluatePost failed:', err));
    });
  }

  // ==================== Post Re-evaluation ====================

  function schedulePostReeval(article: HTMLElement) {
    if (!article.isConnected) return;
    if (adapter.isMainPost(article)) return;
    if (adapter.getPostContainer(article).dataset.filteredByExtension) return;

    if (pendingPostReeval.has(article)) {
      clearTimeout(pendingPostReeval.get(article));
    }

    const timeoutId = setTimeout(() => {
      pendingPostReeval.delete(article);

      if (!article.isConnected) return;

      // Lightweight content key to detect DOM recycling
      const contentKey = adapter.getPostContentKey(article);

      const previousKey = lastProcessedContent.get(article);
      if (previousKey === contentKey) {
        return;
      }

      processedPosts.delete(article);
      postReasonings.delete(article);
      const oldBar = article.querySelector('.post-verification-bar');
      if (oldBar) oldBar.remove();

      lastProcessedContent.set(article, contentKey);

      processPost(article, true);
    }, POST_REEVAL_DELAY);

    pendingPostReeval.set(article, timeoutId);
  }

  // ==================== Observer ====================

  function observePosts() {
    const existingPosts = findPosts();
    existingPosts.forEach(article => processPost(article));

    const observer = new MutationObserver((mutations) => {
      if (!enabled) return;
      if (!adapter.shouldProcessCurrentPage()) return;
      if (getFilteredTabActive() || getFFPageActive()) return;

      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          const el = node as HTMLElement;
          if (!el.querySelectorAll) continue;

          if (el.matches?.(adapter.selectors.post)) {
            processPost(el);
          }

          el.querySelectorAll<HTMLElement>(adapter.selectors.post).forEach(article => processPost(article));

          // Watch for text mutations (DOM recycling detection)
          el.querySelectorAll(adapter.selectors.mutations)
            .forEach(mutEl => {
              const article = mutEl.closest<HTMLElement>(adapter.selectors.post);
              if (article) {
                schedulePostReeval(article);
              }
            });
        }
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true
    });
  }

  // ==================== Init ====================

  async function init() {
    const data = await getStorage(['enabled']);
    enabled = data.enabled !== false;

    await checkLocalModelActive();
    await checkAuthStatus();

    if (enabled) {
      observePosts();
      processExistingPosts();
    }

    injectFilterPhrasesInput();
    injectBottomFilterBox();
    injectMobileFilterBox();

    initModelLoadingListener();

    // Observe for sidebar appearing later or being replaced during SPA navigation
    const uiObserver = new MutationObserver(() => {
      handleDOMMutation();
      handleDOMMutationIOS();
    });
    uiObserver.observe(document.body, { childList: true, subtree: true });

    // Hide bouncer sidebar when Twitter's search bar is focused
    setupSearchBarHide();

    // Observe for theme changes (platform changes body background color)
    const themeObserver = new MutationObserver(() => {
      updateTheme();
    });
    themeObserver.observe(document.body, { attributes: true, attributeFilter: ['style', 'class'] });

    // Restore BottomBar opacity when clicked
    document.addEventListener('click', (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      const bottomBar = adapter.selectors.bottomBar && target ? target.closest<HTMLElement>(adapter.selectors.bottomBar) : null;
      if (bottomBar) {
        bottomBar.style.opacity = '1';
      }
    });

    // Listen for settings changes
    chrome.storage.onChanged.addListener((changes) => {
      if (changes.enabled) {
        enabled = changes.enabled.newValue as boolean;
        if (enabled) {
          observePosts();
          processExistingPosts();
        }
      }
      if (changes.selectedModel) {
        const defaultModel = process.env.HAS_IMBUE_BACKEND === 'true' ? 'imbue' : '';
        const newModel = (changes.selectedModel.newValue as string) || defaultModel;
        isLocalModelActive = newModel.startsWith('local:') || false;
        updateAlertState('latency', { isHighLatency: false, medianLatency: 0, selectedModel: newModel, hasAlternativeApis: false });
        updateAlertState('error', { type: null, subType: null, count: 0, apiDisplayName: null, selectedModel: newModel, hasAlternativeApis: false });
        updateAlertBanners();
      }
      if (changes[descriptionsKey]) {
        syncFilterPhrases();
        const oldDescs = (changes[descriptionsKey].oldValue as string[] | undefined) || [];
        const newDescs = (changes[descriptionsKey].newValue as string[] | undefined) || [];
        // Only re-evaluate when a phrase was added, not removed
        if (newDescs.length > oldDescs.length) {
          reEvaluateAllPosts();
        }
      }
    });

    // Fallback recovery: periodically check for posts stuck in pending state
    setInterval(() => {
      if (!enabled || getFilteredTabActive() || getFFPageActive()) return;
      if (pendingPosts.size === 0) return;

      const now = Date.now();
      let recoveredCount = 0;
      let cleanedCount = 0;

      for (const article of pendingPosts) {
        if (!article.isConnected) {
          pendingPosts.delete(article);
          cleanedCount++;
          continue;
        }

        if (article.dataset.filteredByExtension) {
          pendingPosts.delete(article);
          continue;
        }
        if (article.dataset.rateLimited === 'true') continue;

        const startTime = parseInt(article.dataset.pendingStartTime || '0', 10);
        if (now - startTime < stuckPostCheckDelay) continue;

        const content = extractPostContent(article);
        if (content.postUrl && errorPostUrls.has(content.postUrl)) continue;

        if (processedPosts.has(article)) {
          processedPosts.delete(article);
          pendingPosts.delete(article);
          processPost(article, true);
          recoveredCount++;
        }
      }

      if (recoveredCount > 0 || cleanedCount > 0) {
        checkViewportPendingLatency();
      }
    }, stuckPostCheckDelay);

    // Poll viewport latency every second
    setInterval(checkViewportPendingLatency, 1000);

    // Preempt local model inference when user scrolls past the processing post
    let preemptScrollTimeout: ReturnType<typeof setTimeout> | null = null;
    window.addEventListener('scroll', () => {
      if (!isLocalModelActive || !currentlyProcessingPostUrl) return;
      if (preemptScrollTimeout) return; // Already debouncing
      preemptScrollTimeout = setTimeout(() => {
        preemptScrollTimeout = null;
        if (!currentlyProcessingPostUrl) return;

        // Check if the processing post is still in the viewport
        let processingInViewport = false;
        let pendingInViewport = false;
        const allPosts = findPosts();
        for (const article of allPosts) {
          const rect = article.getBoundingClientRect();
          const inViewport = rect.bottom > 0 && rect.top < window.innerHeight;
          if (!inViewport) continue;

          const postUrl = adapter.getPostUrl(article);
          if (postUrl === currentlyProcessingPostUrl) {
            processingInViewport = true;
            break; // No need to preempt
          }
          if (pendingPosts.has(article)) {
            pendingInViewport = true;
          }
        }

        if (!processingInViewport && pendingInViewport) {
          currentlyProcessingPostUrl = null;
          chrome.runtime.sendMessage({ type: 'preemptInference' }).catch(() => {});
        }
      }, 200);
    }, { passive: true });
  }

  // ==================== Message Listener ====================

  chrome.runtime.onMessage.addListener((message: BackgroundToContentMessage, _sender, sendResponse) => {
    switch (message.type) {
      case 'ping':
        sendResponse({ alive: true });
        return;
      case 'latencyUpdate':
        // Only update model info from background; isHighLatency is computed locally
        // based on whether any viewport post has been pending > 5s
        alertState.latency.selectedModel = message.selectedModel;
        alertState.latency.hasAlternativeApis = message.hasAlternativeApis || false;
        sendResponse({ received: true });
        break;
      case 'errorStatusUpdate':
        updateAlertState('error', {
          type: message.errorType || null,
          subType: message.subType || null,
          count: message.count || 0,
          apiDisplayName: message.apiDisplayName || null,
          selectedModel: message.selectedModel,
          hasAlternativeApis: message.hasAlternativeApis || false
        });
        updateAlertBanners();
        sendResponse({ received: true });
        break;
      case 'reEvaluateErrors': {
        const posts = findPosts();
        let reEvaluatedCount = 0;
        posts.forEach(article => {
          if (article.dataset.filteredByExtension) return;

          const content = extractPostContent(article);
          const isErrorByAttr = !!article.dataset.errorType;
          const isErrorByUrl = content.postUrl && errorPostUrls.has(content.postUrl);

          if (isErrorByAttr || isErrorByUrl) {
            delete article.dataset.errorType;
            if (content.postUrl) {
              errorPostUrls.delete(content.postUrl);
            }
            processedPosts.delete(article);
            processPost(article, true);
            reEvaluatedCount++;
          }
        });
        errorPostUrls.clear();
        sendResponse({ success: true, count: reEvaluatedCount });
        break;
      }
      case 'queueStatusUpdate':
        updateAlertState('queue_backlog', {
          pendingCount: message.pendingCount,
          isLocalModel: message.isLocalModel,
          modelInitializing: message.modelInitializing || false
        });
        updateAlertBanners();
        sendResponse({ received: true });
        break;
      case 'processingPost':
        currentlyProcessingPostUrl = message.postUrl;
        sendResponse({ received: true });
        break;
      case 'getPositions': {
        const positions: Record<string, number> = {};
        const viewportCenter = window.innerHeight / 2;
        const postUrlsSet = new Set<string>(message.postUrls || []);

        const allPosts = findPosts();
        allPosts.forEach(article => {
          const content = extractPostContent(article);
          if (!content.postUrl) return;

          const rect = article.getBoundingClientRect();
          const postCenter = rect.top + rect.height / 2;
          const distance = Math.abs(postCenter - viewportCenter);

          if (postUrlsSet.has(content.postUrl)) {
            positions[content.postUrl] = distance;
          }
        });

        sendResponse({ positions });
        break;
      }
    }
    return true;
  });

  // Notify background to reset queue state for this page load
  chrome.runtime.sendMessage({ type: 'pageLoad' }).catch(() => {
    // Ignore errors if background isn't ready yet
  });

  // Start when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { init().catch(err => console.error('[Bouncer] Init failed:', err)); });
  } else {
    init().catch(err => console.error('[Bouncer] Init failed:', err));
  }
})();
