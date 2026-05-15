// Bouncer - Content Script
// Entry point: post processing, observers, init, storage/message listeners

import type { PlatformAdapter, PostContent, PipelineResponse, BackgroundToContentMessage, DescriptionKey } from '../types';
import { getStorage, removeStorage, getDescriptions, setDescriptions } from '../shared/storage';
import { FILTER_PACK_CODE_PREFIX } from '../shared/share-encoding';

import {
  IS_IOS, initIOS,
  getFFPageActive, getIOSPageContainer, getFFFabButton,
  renderIOSCategories, updateIOSFilteredCount,
  handleDOMMutationIOS,
} from './ios';

import {
  initUI, checkAuthStatus,
  getFilteredPosts, getFilteredTabActive,
  updateTheme,
  injectFilterPhrasesInput, injectBottomFilterBox, injectMobileFilterBox,
  syncFilterPhrases, addFilterPhrase, removeFilterPhrase,
  showSettingsModal, renderFilteredPostsView,
  initModelLoadingListener,
  markPostPending, markPostVerified, getVerificationBar,
  storeFilteredPost, hidePost, showApiKeyWarning,
  addContextMenuHandler,
  addWhyAnnoyingButton,
  processImportCodeInPost,
  handleDOMMutation,
  setupSearchBarHide,
  initDetectorStates,
  updateDetectorState,
} from './ui';

import { formatPostForEvaluation } from '../shared/utils';

(function() {
  'use strict';

  // Safari re-injects content scripts when extension permissions change on
  // an already-loaded tab. Each re-injection has a fresh module scope and
  // would register duplicate listeners + create duplicate UI. Guard with a
  // window-level sentinel so only the first injection per page runs.
  interface BouncerWindow extends Window { __bouncerContentScriptLoaded?: boolean }
  const w = window as unknown as BouncerWindow;
  if (w.__bouncerContentScriptLoaded) {
    console.log('[Bouncer] Content script already loaded in this tab — skipping re-init');
    return;
  }
  w.__bouncerContentScriptLoaded = true;

  // Platform adapter (loaded by manifest before content.js)
  if (typeof BouncerAdapter === 'undefined') {
    console.error('[Bouncer] No platform adapter found');
    return;
  }
  console.log('[Bouncer] Content script starting, IS_IOS:', IS_IOS);
  const adapter: PlatformAdapter = new BouncerAdapter();
  console.log('[Bouncer] Adapter loaded:', adapter.siteId);
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
  // Cached `filterReplies` setting; loaded on init and kept current by the
  // storage-change listener below. Defaults to true so the gate is a no-op
  // until the user explicitly opts out.
  let filterReplies = true;
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

  // Tab-dispatch messages from background reference an evaluation by a UUID
  // we generated when sending the evaluatePost message. This map gives us the
  // article back regardless of postUrl (some posts have no time link / no
  // store URL). Entries auto-expire 30s after the evaluation completes so
  // late-arriving detector responses (e.g. AI taking 14s post-race) still
  // route correctly.
  const articleByEvaluationId = new Map<string, HTMLElement>();
  const EVALUATION_ID_TTL_MS = 30000;

  function registerEvaluation(id: string, article: HTMLElement) {
    articleByEvaluationId.set(id, article);
  }
  function releaseEvaluation(id: string) {
    setTimeout(() => articleByEvaluationId.delete(id), EVALUATION_ID_TTL_MS);
  }
  function articleForEvaluation(id: string | undefined): HTMLElement | null {
    if (!id) return null;
    return articleByEvaluationId.get(id) ?? null;
  }

  function extractPostContent(article: HTMLElement): PostContent {
    return adapter.extractPostContent(article);
  }

  async function checkLocalModelActive() {
    try {
      const data = await getStorage(['selectedModel']);
      const model = data.selectedModel || 'imbue';
      isLocalModelActive = model.startsWith('local:');
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

  // In-app WKWebView mode: fiber-extractor can't load, use DOM extraction directly
  const isInApp = typeof chrome !== 'undefined' && chrome._polyfilled;

  // Evaluate a post using the background script
  async function evaluatePost(article: HTMLElement) {
    console.log('[Bouncer] evaluatePost called, isInApp:', isInApp);
    let content: PostContent | undefined;

    if (isInApp) {
      // WKWebView: use DOM-based extraction (store extraction unavailable)
      content = extractPostContent(article);
      console.log('[Bouncer] DOM extraction result:', content?.text?.substring(0, 80));
    } else {
      // Extension: extract post content from platform store (preferred source)
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

    const evaluationId = crypto.randomUUID();
    registerEvaluation(evaluationId, article);
    try {
      console.log('[Bouncer] Sending evaluatePost message for:', content.text?.substring(0, 60));
      const evaluatePromise = chrome.runtime.sendMessage({
          type: 'evaluatePost',
          evaluationId,
          post: formatPostForEvaluation(content),
          rawText: content.text,
          imageUrls: content.imageUrls || [],
          postUrl: content.postUrl || null,
          siteId: adapter.siteId
        });
      const response = await evaluatePromise as PipelineResponse;
      releaseEvaluation(evaluationId);
      console.log('[Bouncer] evaluatePost response:', JSON.stringify(response)?.substring(0, 200));

      // Clear processing tracker when this post's evaluation completes
      if (content.postUrl && content.postUrl === currentlyProcessingPostUrl) {
        currentlyProcessingPostUrl = null;
      }

      if (response == null) {
        // Skip - post stays as-is (pending). Covers: disabled, no_rules,
        // page_reload, and Safari's MV3 quirk of resolving sendMessage with
        // `undefined` when the service worker tears the channel down before
        // sendResponse is called (Chrome/Firefox keep the promise pending).
        // Treat both as "leave the post alone" rather than letting the
        // `'retry' in response` check below throw on a non-object.
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
        // Rate-limit errors fall back to the pending state; all other API errors
        // leave the bar invisible. The red .api-error stripe has been removed
        // entirely — a red stripe on a tweet is always wrong.
        if (response.error === 'rate_limit') verificationBar.classList.add('pending');
        article.removeAttribute('data-ff-pending');
        article.classList.add('ff-error');
        return;
      }

      // EvaluationResult. Tweets that share a Bouncer filter pack are exempt
      // from auto-hiding — otherwise the import button would get filtered
      // before the recipient could click it. The substring check is robust:
      // bncr2_ is the share-code prefix and is unique enough that false
      // positives are effectively zero. Manual user-flagged hides (in ui.ts)
      // remain unaffected — this only vetoes the AI's automatic decision.
      const containsShareCode = (article.textContent || '').includes(FILTER_PACK_CODE_PREFIX);
      const effectiveShouldHide = response.shouldHide && !containsShareCode;

      postReasonings.set(article, {
        shouldHide: effectiveShouldHide,
        reasoning: response.reasoning || 'No reasoning available',
        rawResponse: response.rawResponse || null
      });

      if (effectiveShouldHide) {
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
      releaseEvaluation(evaluationId);
      postReasonings.set(article, {
        shouldHide: false,
        reasoning: `Error evaluating: ${(err instanceof Error) ? err.message : 'Unknown error'}`
      });
      markPostVerified(article);
    }
  }

  // Process a single post - sends it to background for evaluation
  function processPost(article: HTMLElement, forceForYou = false) {
    if (getFFPageActive()) { console.log('[Bouncer] processPost: skipped (FF page active)'); return; }
    if (!forceForYou && !adapter.shouldProcessCurrentPage()) { console.log('[Bouncer] processPost: skipped (shouldProcessCurrentPage false, path:', window.location.pathname, ')'); return; }

    if (adapter.isMainPost(article)) return;

    // "Filter replies/comments" toggle: on a permalink page everything
    // below the main post is a reply. The main-timeline filter is
    // unaffected because adapter.isPermalinkView() is false there.
    if (!filterReplies && adapter.isPermalinkView()) return;

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
    const skipReplies = !filterReplies && adapter.isPermalinkView();
    posts.forEach(article => {
      if (adapter.getPostContainer(article).dataset.filteredByExtension) {
        return;
      }
      if (adapter.isMainPost(article)) return;
      if (skipReplies) return;

      processedPosts.delete(article);

      // Defer the pending indicator — cache hits resolve quickly and we don't
      // want posts to flash the dim/bar state when the evaluation comes back
      // before the timer fires. If the evaluation resolves before the timer
      // fires, the post never goes through the pending UI; true cache misses
      // still show pending after the short delay.
      const pendingTimer = setTimeout(() => markPostPending(article), 120);
      evaluatePost(article)
        .catch(err => console.error('[Bouncer] evaluatePost failed:', err))
        .finally(() => clearTimeout(pendingTimer));
    });
  }

  // ==================== Post Re-evaluation ====================

  function schedulePostReeval(article: HTMLElement) {
    if (!article.isConnected) return;
    if (adapter.isMainPost(article)) return;
    if (!filterReplies && adapter.isPermalinkView()) return;
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

  // ==================== Import-Code Observer ====================

  // The "import filter pack" transform is a pure DOM enhancement — it doesn't
  // classify or filter anything. Run it on every visible tweet regardless of
  // adapter.shouldProcessCurrentPage(), so profile pages, the explore feed,
  // search, and individual tweet permalinks all get the button swap too.
  function observeImportCodes() {
    const scan = (root: ParentNode) => {
      root.querySelectorAll<HTMLElement>(adapter.selectors.post).forEach(processImportCodeInPost);
    };
    scan(document);
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          const el = node as HTMLElement;
          if (!el.querySelectorAll) continue;
          if (el.matches?.(adapter.selectors.post)) processImportCodeInPost(el);
          scan(el);
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // ==================== Observer ====================

  function observePosts() {
    const existingPosts = findPosts();
    console.log('[Bouncer] observePosts: found', existingPosts.length, 'existing posts, shouldProcess:', adapter.shouldProcessCurrentPage());
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
    const data = await getStorage(['enabled', 'filterReplies']);
    enabled = data.enabled !== false;
    // Treat undefined as true so users on builds released before this
    // setting existed keep their current behavior.
    filterReplies = data.filterReplies !== false;

    await checkLocalModelActive();
    await checkAuthStatus();

    if (enabled) {
      observePosts();
      processExistingPosts();
    }

    // Always run the import-code transform, even on pages where filter
    // classification is gated off (profiles, notifications, lists, etc.) —
    // users should be able to import shared filter packs from anywhere.
    observeImportCodes();

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
        const newModel = (changes.selectedModel.newValue as string) || 'imbue';
        isLocalModelActive = newModel.startsWith('local:') || false;
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
      if (changes.aiTextFilterEnabled) {
        // Sync each filter box's checkbox to the new value, then re-evaluate
        // all posts since the cache has been invalidated by the background.
        const checked = changes.aiTextFilterEnabled.newValue === true;
        document.querySelectorAll<HTMLInputElement>('.filter-ai-text-toggle-input')
          .forEach(el => { if (el.checked !== checked) el.checked = checked; });
        reEvaluateAllPosts();
      }
      if (changes.aiTextFilterExperimental) {
        const expEnabled = changes.aiTextFilterExperimental.newValue === true;
        document.querySelectorAll<HTMLElement>('.filter-ai-text-toggle')
          .forEach(el => { el.style.display = expEnabled ? '' : 'none'; });
      }
      if (changes.filterReplies) {
        filterReplies = changes.filterReplies.newValue !== false;
        if (filterReplies) {
          // Toggling back on: replies the user scrolled past while the
          // setting was off were never submitted; re-evaluate them now.
          reEvaluateAllPosts();
        } else if (adapter.isPermalinkView()) {
          // Toggling off: undo what we'd already hidden on this permalink
          // page so the user sees the replies they wanted without a
          // reload. We deliberately only touch replies on this page —
          // home-timeline filtering is unaffected by this setting.
          document.querySelectorAll<HTMLElement>('[data-filtered-by-extension="true"]').forEach(cell => {
            const article = cell.querySelector<HTMLElement>(adapter.selectors.post);
            if (!article || adapter.isMainPost(article)) return;
            cell.style.display = '';
            delete cell.dataset.filteredByExtension;
            processedPosts.delete(article);
          });
        }
      }
    });

    // Fallback recovery: periodically check for posts stuck in pending state
    setInterval(() => {
      if (!enabled || getFilteredTabActive() || getFFPageActive()) return;
      if (pendingPosts.size === 0) return;

      const now = Date.now();

      for (const article of pendingPosts) {
        if (!article.isConnected) {
          pendingPosts.delete(article);
          continue;
        }

        if (article.dataset.filteredByExtension) {
          pendingPosts.delete(article);
          continue;
        }
        if (article.dataset.rateLimited === 'true') continue;

        const startTime = parseInt(article.dataset.pendingStartTime || '0', 10);
        if (now - startTime < stuckPostCheckDelay) continue;

        if (processedPosts.has(article)) {
          const content = extractPostContent(article);
          if (content.postUrl && errorPostUrls.has(content.postUrl)) continue;
          processedPosts.delete(article);
          pendingPosts.delete(article);
          processPost(article, true);
        } else {
          // Article stuck in pendingPosts with no active evaluation (e.g. came
          // from reEvaluateAllPosts which clears processedPosts before evaluating).
          // Release it so it's visible at full opacity instead of lingering.
          markPostVerified(article);
        }
      }
    }, stuckPostCheckDelay);

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
      case 'errorStatusUpdate':
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
        sendResponse({ received: true });
        break;
      case 'processingPost':
        currentlyProcessingPostUrl = message.postUrl;
        sendResponse({ received: true });
        break;
      case 'evaluationStarted': {
        const article = articleForEvaluation(message.evaluationId);
        if (article) initDetectorStates(article, message.detectorNames);
        sendResponse({ received: true });
        break;
      }
      case 'detectorResponse': {
        const article = articleForEvaluation(message.evaluationId);
        if (article) {
          const status = message.skipped ? 'skipped'
                       : message.error ? 'error'
                       : 'success';
          updateDetectorState(article, message.detectorName, {
            status,
            shouldHide: message.shouldHide,
            reasoning: message.reasoning,
            category: message.category ?? null,
            error: message.error,
            skipReason: message.skipReason,
          });
        } else {
          console.debug('[Bouncer] detectorResponse: no article for id', message.evaluationId);
        }
        sendResponse({ received: true });
        break;
      }
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
