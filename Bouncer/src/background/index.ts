// Background script entry point: message handler, storage listener, startup, tab tracking

import { PREDEFINED_MODELS } from '../shared/models';
import { generateCacheKey } from '../shared/utils';
import { getStorage, setStorage } from '../shared/storage';
import type { ContentToBackgroundMessage, LocalModelStatus } from '../types';
import { localEngine } from './local-model';
import {
  initPipeline, loadCache, saveCache,
  setActiveTab, enqueuePost, isKeyPending, clearTabQueue,
  scheduleBatch, broadcastQueueStatus, getSettings, sendToTab,
  errorState, triggerErrorRetry,
  evaluationCache, clearEvaluationCache,
  handleSettingsChange, handleFilterPackChange, handlePageLoad, suggestAnnoyingReasons,
  replayDetectorStates,
} from './pipeline';
import { sendFeedback } from './providers';
import { imbueWebSocket } from './ws-manager';
import { launchAuthFlow, refreshAuthToken, getAuthToken, handleAppleSignIn, signOut, IS_SAFARI } from './auth';

// ==================== Tab tracking ====================

// Set of tab IDs with active content scripts (for broadcasting)
const activeContentTabs = new Set<number>();

// Active tab tracking for per-tab queue processing
let activeTabId: number | null = null;

function updateActiveTab(tabId: number | undefined | null): void {
  const isBouncerTab = tabId && activeContentTabs.has(tabId);
  const newActiveId = isBouncerTab ? tabId : null;
  if (newActiveId !== activeTabId) {
    activeTabId = newActiveId;
    setActiveTab(newActiveId);
  }
}

// Listen for tab activation (user switches tabs)
chrome.tabs.onActivated.addListener(({ tabId }) => {
  updateActiveTab(tabId);
});

// On tab update (page load/navigation), access the tab to trigger Safari's permission prompt.
// Safari only shows the permission prompt when the extension actively accesses a tab's info.
// Without this, the prompt is deferred until the user switches away and back.

// Listen for window focus changes (user switches windows)
chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return; // keep current
  chrome.tabs.query({ active: true, windowId }).then(([tab]) => {
    if (tab) updateActiveTab(tab.id);
  }).catch(() => { /* ignore */ });
});

// Clean up tab tracking when tabs are closed
chrome.tabs.onRemoved.addListener((tabId) => {
  activeContentTabs.delete(tabId);
  clearTabQueue(tabId);
  if (activeTabId === tabId) {
    activeTabId = null;
    setActiveTab(null);
  }

  // When no tabs remain, immediately unload the local model to free GPU memory.
  // Model weights stay in Cache Storage for fast reload when a tab opens again.
  if (activeContentTabs.size === 0 && localEngine.engine) {
    const modelId = localEngine.loadedModel;
    console.log('[WebLLM] No active tabs remaining, unloading engine for', modelId);
    localEngine.drainQueue(async () => {
      await localEngine.reset();
      if (modelId) {
        await localEngine.updateStatus(modelId, { state: 'cached' });
      }
    }).catch(err => {
      console.error('[WebLLM] Error unloading engine on last tab close:', err);
    });
  }
});

// ==================== Startup ====================

// On Safari, access cookies for key domains on startup to trigger permission prompts early.
// chrome.cookies.get requires the "cookies" permission + host permission for the URL,
// which reliably surfaces Safari's "Allow on Websites" dialog.
if (IS_SAFARI && chrome.cookies) {
  // On open-source / BYOK-only builds BOUNCER_SIGNIN_DOMAIN is unset, which
  // would produce `https:///` — Safari's cookies.get throws synchronously on
  // invalid URLs, killing the rest of this module (including the
  // chrome.runtime.onMessage listener registration below). Skip any empty
  // domain entries so the background script always finishes loading.
  const signinDomain = process.env.BOUNCER_SIGNIN_DOMAIN;
  const domains = [
    'https://x.com/',
    ...(signinDomain ? [`https://${signinDomain}/`] : []),
  ];
  for (const url of domains) {
    chrome.cookies.get({ url, name: '_dummy' }, (cookie) => {
      console.log(`[Startup] cookies.get for ${url}: cookie=${cookie ? 'present' : 'null'}, lastError=${chrome.runtime.lastError?.message ?? 'none'}`);
    });
  }
}

// Open uninstall survey when the extension is removed (not supported in Safari)
if (chrome.runtime.setUninstallURL) {
  chrome.runtime.setUninstallURL("https://forms.gle/41CSXsBcRMnjofVw8")
    .catch(err => console.error('[Startup] setUninstallURL failed:', err));
}

// Initialize cache, sync model statuses, and auto-init local model on startup
// Wrapped in try/catch to prevent unhandled rejections from destabilizing the service worker
(async () => {
  try {
    await loadCache();
    await refreshAuthToken();
    // Wire up pipeline with shared state
    initPipeline(activeContentTabs);
    await localEngine.syncAllStatuses();
    await localEngine.autoInitSelected();

    // Proactively detect active Bouncer tabs after service worker restart.
    // Without this, activeTabId stays null until a content script sends a message,
    // leaving the per-tab queue idle even if posts are already queued.
    try {
      const tabs = await chrome.tabs.query({ url: ['*://x.com/*'] });
      for (const tab of tabs) {
        try {
          await chrome.tabs.sendMessage(tab.id!, { type: 'ping' });
          activeContentTabs.add(tab.id!);
        } catch {
          // Content script not loaded or not responding — skip
        }
      }
      if (activeContentTabs.size > 0) {
        const [focusedTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (focusedTab && activeContentTabs.has(focusedTab.id!)) {
          updateActiveTab(focusedTab.id);
        }
      }
    } catch {
      // Tab detection can fail non-fatally (e.g. no Twitter tabs open)
    }
  } catch (e) {
    console.error('[Background] Startup initialization error (non-fatal):', e);
  }
})().catch(err => console.error('[Background] Startup error:', err));

// ==================== Message handler ====================

// Async message handler — each case returns the response object.
// Centralized .catch() in the listener ensures sendResponse is always called.
async function handleMessage(
  message: ContentToBackgroundMessage,
  sender: chrome.runtime.MessageSender,
  _sendResponse: (response?: unknown) => void
): Promise<unknown> {
  const tabId = sender.tab?.id;

  switch (message.type) {
    case 'evaluatePost': {
      console.log('[Bouncer][diag] evaluatePost received: tabId=', tabId, 'activeTabId=', activeTabId, 'sender.tab=', !!sender.tab);
      // Ensure tab is registered (re-registers after service worker restart)
      if (tabId) activeContentTabs.add(tabId);

      // Posts always flow through processBatch so the popup gets a consistent
      // two-tab dispatch (filter + aiText), even when neither is configured.
      // The detectors then mark themselves skipped with appropriate reasons.
      const settings = await getSettings(message.siteId);

      // Check if local model is selected but not ready
      const isLocalModel = settings.selectedModel?.startsWith('local:');
      if (isLocalModel) {
        const modelId = settings.selectedModel.split(':')[1];
        const notDownloaded = !localEngine.isModelLoaded(modelId) && !localEngine.isInitializing();

        if (notDownloaded) {
          // Check if model is cached - if not, return early
          const cached = await localEngine.checkCached(modelId);
          if (!cached) {
            return { retry: true as const, reasoning: 'Local model not downloaded yet.' };
          }
        }
      }

      await loadCache();
      const imageUrls = message.imageUrls || [];
      const cacheKey = generateCacheKey(message.post, imageUrls);

      // Check main cache
      if (evaluationCache.has(cacheKey)) {
        const cached = evaluationCache.get(cacheKey)!;
        if (tabId !== undefined) replayDetectorStates(tabId, message.evaluationId, cached);
        return { ...cached, cached: true };
      }

      // Check if already in queue - add another resolver for this item
      if (tabId !== undefined && isKeyPending(tabId, cacheKey)) {
        return new Promise(resolve => {
          const item = { evaluationId: message.evaluationId, post: message.post, rawText: message.rawText, imageUrls, resolve, cacheKey, tabId, postUrl: message.postUrl, siteId: message.siteId };
          enqueuePost(tabId, item);
        });
      }

      // Queue for batch processing
      // processBatch will prioritize posts closest to viewport center for local models
      const resultPromise = new Promise(resolve => {
        const item = { evaluationId: message.evaluationId, post: message.post, rawText: message.rawText, imageUrls, resolve, cacheKey, tabId, postUrl: message.postUrl, siteId: message.siteId };
        enqueuePost(tabId!, item);
      });
      console.log('[Bouncer][diag] evaluatePost enqueued for tab', tabId);

      // On first evaluatePost when activeTabId is unknown, detect if this tab is active
      if (activeTabId === null) {
        chrome.tabs.query({ active: true, lastFocusedWindow: true }).then((tabs) => {
          console.log('[Bouncer][diag] tabs.query(active,lastFocused) returned', tabs.length, 'tab(s); first.id=', tabs[0]?.id, 'msg.tabId=', tabId);
          const tab = tabs[0];
          if (tab && tab.id === tabId) updateActiveTab(tabId);
        }).catch((err) => { console.log('[Bouncer][diag] tabs.query failed:', err); });
      }

      console.log('[Bouncer][diag] calling scheduleBatch; activeTabId=', activeTabId);
      scheduleBatch();
      broadcastQueueStatus().catch(err => console.error('[Background] broadcastQueueStatus error:', err));
      return resultPromise;
    }

    case 'suggestAnnoyingReasons': {
      try {
        const imageUrls = message.imageUrls || [];
        const reasons = await suggestAnnoyingReasons(message.post, imageUrls, message.siteId || 'twitter', sender.tab?.id);
        return { reasons, hadImages: imageUrls.length > 0 };
      } catch (err) {
        console.error('[Bouncer] suggestAnnoyingReasons error:', err);
        return { reasons: [], error: (err as Error).message };
      }
    }

    case 'clearCache': {
      await clearEvaluationCache();
      return { success: true };
    }

    case 'clearSinglePost': {
      await loadCache();
      const cacheKey = generateCacheKey(message.post, message.imageUrls || []);
      if (evaluationCache.has(cacheKey)) {
        evaluationCache.delete(cacheKey);
        await saveCache();
      }
      return { success: true };
    }

    case 'sendFeedback': {
      try {
        const settings = await getSettings(message.siteId || 'twitter');

        // Look up cached evaluation to get the actual rawResponse and parsed reasoning
        const postText = message.tweetData?.text || '';
        const imageUrls = message.tweetData?.imageUrls || [];
        const cacheKey = generateCacheKey(postText, imageUrls);
        const cached = evaluationCache.get(cacheKey);

        const feedbackMessage = {
          action: "feedback" as const,
          tweetData: message.tweetData,
          categories: settings.descriptions || [],
          version: chrome.runtime?.getManifest?.()?.version || 'unknown',
          model: cached?.model || settings.selectedModel || 'unknown',
          rawResponse: message.rawResponse || cached?.rawResponse || '',
          reasoning: message.reasoning || cached?.reasoning || '',
          decision: message.decision || ''
        };
        const authToken = await getAuthToken();
        void sendFeedback(feedbackMessage, authToken);
        return { success: true };
      } catch (err) {
        console.error('[Bouncer] sendFeedback error:', err);
        return { success: false, error: (err as Error).message };
      }
    }

    case 'overrideCacheEntry': {
      await loadCache();
      const cacheKey = generateCacheKey(message.post, message.imageUrls || []);
      evaluationCache.set(cacheKey, {
        shouldHide: message.shouldHide,
        reasoning: message.reasoning || 'User override',
      });
      await saveCache();
      return { success: true };
    }

    case 'getStats': {
      const data = await getStorage(['stats']);
      return data.stats || { filtered: 0, evaluated: 0, totalCost: 0 };
    }

    case 'getReasoning': {
      await loadCache();
      const cacheKey = generateCacheKey(message.post, message.imageUrls || []);
      if (evaluationCache.has(cacheKey)) {
        const cached = evaluationCache.get(cacheKey)!;
        return {
          found: true,
          shouldHide: cached.shouldHide,
          reasoning: cached.reasoning || 'No reasoning available',
          category: cached.category || null,
          rawResponse: cached.rawResponse || null
        };
      }
      return {
        found: false,
        reasoning: 'Post not yet evaluated'
      };
    }

    case 'getErrorStatus': {
      const settings = await getSettings();
      const hasAlternativeApis = !!(settings.openaiApiKey || settings.geminiApiKey || settings.openrouterApiKey || settings.anthropicApiKey);
      return {
        errorType: errorState.type,
        subType: errorState.subType,
        count: errorState.count,
        apiDisplayName: errorState.apiDisplayName,
        selectedModel: settings.selectedModel,
        hasAlternativeApis: hasAlternativeApis
      };
    }

    case 'getAllLocalModelStatuses': {
      const data = await getStorage(['localModelStatuses']);
      const statuses: Record<string, { state: string; reason?: string }> = (data.localModelStatuses || {});

      // Check WebGPU support
      const webgpuSupported = !!navigator.gpu;

      // Always check cache status for models not currently in a loading state
      for (const model of PREDEFINED_MODELS.local) {
        const currentStatus = statuses[model.name];
        // Skip cache check only if actively downloading/initializing
        const isLoading = currentStatus?.state === 'downloading' || currentStatus?.state === 'initializing';

        if (!isLoading) {
          if (!webgpuSupported) {
            statuses[model.name] = { state: 'unsupported', reason: 'WebGPU not supported' };
          } else if (localEngine.isModelLoaded(model.name)) {
            // Model is currently loaded in GPU memory
            statuses[model.name] = { state: 'ready' };
          } else {
            // Check if model is in cache
            const cached = await localEngine.checkCached(model.name);
            statuses[model.name] = { state: cached ? 'cached' : 'not_downloaded' };
          }
        }
      }

      return { statuses, webgpuSupported };
    }

    case 'getAuthStatus': {
      // When no Imbue backend is configured (open-source build), there's
      // nothing to sign in to. Tell the UI we're "authenticated" so the
      // sign-in prompts stay hidden and the filter UI renders directly.
      if (process.env.HAS_IMBUE_BACKEND !== 'true') {
        return { authenticated: true, isSafari: IS_SAFARI };
      }
      const token = await getAuthToken();
      return { authenticated: !!token, isSafari: IS_SAFARI };
    }

    case 'launchAuth': {
      if (process.env.HAS_IMBUE_BACKEND !== 'true') {
        return { success: false, error: 'Imbue backend not configured' };
      }
      // iOS: no Google OAuth available -- use anonymous auth (already handled by getAuthToken)
      const isIOS = typeof window !== 'undefined' && typeof (window as unknown as Record<string, unknown>).__ff_getAppCheckToken === 'function';
      if (isIOS) {
        const token = await getAuthToken();
        if (token) {
          for (const tid of activeContentTabs) {
            void sendToTab(tid, { type: 'authStateChanged', authenticated: true });
          }
        }
        return { success: !!token };
      }

      try {
        const method = (message as { method?: string }).method;
        const token = await launchAuthFlow(method);
        if (token) {
          for (const tid of activeContentTabs) {
            void sendToTab(tid, { type: 'authStateChanged', authenticated: true });
          }
        }
        return { success: !!token };
      } catch (err) {
        console.error('[Auth] On-demand auth flow error:', err);
        return { success: false, error: (err as Error).message };
      }
    }

    case 'nativeAppleSignIn': {
      try {
        console.log('[Auth] Requesting native Apple sign-in via sendNativeMessage...');
        interface NativeResponse {
          action?: string;
          hostBundleId?: string;
          identityToken?: string;
          rawNonce?: string;
          error?: string;
        }
        const browserApi = (globalThis as unknown as { browser?: { runtime: { sendNativeMessage: (id: string, msg: unknown) => Promise<NativeResponse> } } }).browser;
        if (!browserApi) {
          return { success: false, error: 'Native messaging not available' };
        }
        const nativeResponse = await browserApi.runtime.sendNativeMessage(
          'application.id',
          { type: 'signInWithApple' }
        );
        console.log('[Auth] Native response:', JSON.stringify(nativeResponse));

        // If the extension handler tells us to open the host app
        if (nativeResponse?.action === 'openHostApp') {
          console.log('[Auth] Opening host app for sign-in...');
          // Open the host app — it will handle Sign in with Apple
          // and store the token in shared UserDefaults
          await chrome.tabs.create({ url: `bouncer://signin` });
          return { success: false, error: 'Please complete sign-in in the Bouncer app' };
        }

        if (nativeResponse?.identityToken) {
          const token = await handleAppleSignIn(
            nativeResponse.identityToken,
            nativeResponse.rawNonce || '',
            undefined,
            'apple.com'
          );
          if (token) {
            for (const tid of activeContentTabs) {
              void sendToTab(tid, { type: 'authStateChanged', authenticated: true });
            }
          }
          return { success: !!token };
        } else {
          console.error('[Auth] Native sign-in returned no token:', nativeResponse);
          return { success: false, error: nativeResponse?.error || 'No token returned' };
        }
      } catch (err) {
        console.error('[Auth] Native Apple sign-in error:', err);
        return { success: false, error: (err as Error).message };
      }
    }

    case 'signOut': {
      try {
        await signOut();
        for (const tid of activeContentTabs) {
          void sendToTab(tid, { type: 'authStateChanged', authenticated: false });
        }
        return { success: true };
      } catch (err) {
        console.error('[Auth] Sign out error:', err);
        return { success: false, error: (err as Error).message };
      }
    }

    case 'appleSignIn': {
      try {
        const appleMsg = message as {
          idToken: string;
          rawNonce: string;
          firebaseToken?: string;
          providerId?: string;
        };
        console.log('[Auth] appleSignIn received, providerId:', appleMsg.providerId);
        const token = await handleAppleSignIn(
          appleMsg.idToken,
          appleMsg.rawNonce,
          appleMsg.firebaseToken,
          appleMsg.providerId,
        );
        console.log('[Auth] handleAppleSignIn result:', !!token);
        if (token) {
          console.log('[Auth] Broadcasting authStateChanged to', activeContentTabs.size, 'tabs:', [...activeContentTabs]);
          for (const tid of activeContentTabs) {
            sendToTab(tid, { type: 'authStateChanged', authenticated: true })
              .then((r) => console.log('[Auth] authStateChanged delivered to tab', tid, 'response=', r))
              .catch((err: unknown) => {
                const msg = err instanceof Error ? err.message : String(err);
                console.error('[Auth] authStateChanged FAILED to tab', tid, ':', msg);
              });
          }
        }


        return { success: !!token };
      } catch (err) {
        console.error('[Auth] Sign-in error:', err);
        return { success: false, error: (err as Error).message };
      }
    }

    case 'launchOpenRouterAuth': {
      try {
        // Generate PKCE codes
        const array = new Uint8Array(32);
        crypto.getRandomValues(array);
        const codeVerifier = btoa(String.fromCharCode(...array))
          .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

        const encoder = new TextEncoder();
        const hash = await crypto.subtle.digest('SHA-256', encoder.encode(codeVerifier));
        const codeChallenge = btoa(String.fromCharCode(...new Uint8Array(hash)))
          .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

        const redirectUrl = chrome.identity.getRedirectURL();

        const authUrl = new URL('https://openrouter.ai/auth');
        authUrl.searchParams.set('callback_url', redirectUrl);
        authUrl.searchParams.set('code_challenge', codeChallenge);
        authUrl.searchParams.set('code_challenge_method', 'S256');
        authUrl.searchParams.set('title', 'Bouncer');

        const responseUrl = await chrome.identity.launchWebAuthFlow({
          url: authUrl.toString(),
          interactive: true,
        });

        if (!responseUrl) {
          return { success: false, error: 'No response URL from OAuth flow' };
        }

        const url = new URL(responseUrl);
        const code = url.searchParams.get('code');
        if (!code) {
          return { success: false, error: 'No authorization code received' };
        }

        // Exchange code for API key
        const tokenResponse = await fetch('https://openrouter.ai/api/v1/auth/keys', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            code,
            code_verifier: codeVerifier,
            code_challenge_method: 'S256',
          }),
        });

        if (!tokenResponse.ok) {
          const errorText = await tokenResponse.text();
          console.error('[OpenRouter] Token exchange failed:', tokenResponse.status, errorText);
          return { success: false, error: `Token exchange failed: ${tokenResponse.status}` };
        }

        const data = await tokenResponse.json() as { key?: string };
        if (!data.key) {
          return { success: false, error: 'No API key in response' };
        }

        // Check if first auth for auto-model-switch. Users on the default
        // (Imbue when configured, empty string otherwise) get bumped onto
        // the free model so they have a working configuration
        // immediately after signing in.
        const storageData = await getStorage(['openrouterApiKey', 'selectedModel']);
        const isFirstAuth = !storageData.openrouterApiKey;
        const currentModel = storageData.selectedModel || '';

        await setStorage({ openrouterApiKey: data.key });

        if (isFirstAuth && (currentModel === 'imbue' || !currentModel)) {
          await setStorage({ selectedModel: 'openrouter:nvidia/nemotron-nano-12b-v2-vl:free' });
        }

        return { success: true };
      } catch (err) {
        const message = (err as Error).message || '';
        if (message.includes('canceled') || message.includes('closed')) {
          return { success: false, cancelled: true };
        }
        console.error('[OpenRouter] OAuth error:', err);
        return { success: false, error: message };
      }
    }

    case 'cancelLocalModelDownload': {
      const modelId = message.modelId;
      if (!modelId) {
        return { success: false, error: 'No model ID provided' };
      }
      const cancelled = await localEngine.cancelDownload(modelId);
      return { success: true, cancelled, modelId };
    }

    default:
      return { error: `Unknown message type: ${(message as { type: string }).type}` };
  }
}

// Handle messages from content script
chrome.runtime.onMessage.addListener((message: ContentToBackgroundMessage, sender, sendResponse) => {
  const tabId = sender.tab?.id;
  console.log('[Background] onMessage:', message?.type, 'from:', sender?.url?.substring(0, 60), 'tab:', tabId);

  // --- Sync-only: pageLoad does not need async, just side effects ---
  if (message.type === 'pageLoad') {
    if (!tabId) return;

    // Track this tab as having an active content script
    activeContentTabs.add(tabId);
    handlePageLoad(tabId);

    // Detect active tab (handles service worker restart where onActivated doesn't re-fire)
    chrome.tabs.query({ active: true, lastFocusedWindow: true }).then(([tab]) => {
      if (tab && tab.id === tabId) updateActiveTab(tabId);
    }).catch(() => {});
    return;
  }

  // --- Sync-only: preemptInference fires and forgets ---
  if (message.type === 'preemptInference') {
    localEngine.preempt();
    return;
  }

  // --- Fire-and-forget: initializeWebLLM responds synchronously, starts async work ---
  if (message.type === 'initializeWebLLM') {
    console.log('[Background] initializeWebLLM received, modelId:', message.modelId, 'hasNativeBridge:', typeof window !== 'undefined' && !!(window as unknown as Record<string, unknown>)?.webkit);
    const modelId = message.modelId;
    if (!modelId) {
      sendResponse({ success: false, error: 'No model ID provided' });
      return false;
    }
    // Start initialization but respond immediately - progress is tracked via storage
    localEngine.initialize(modelId).catch(err => {
      console.error('[WebLLM] Initialization error for', modelId, ':', err);
    });
    sendResponse({ success: true, started: true, modelId });
    return false; // Synchronous response
  }

  // --- All other message types: async with centralized error handling ---
  handleMessage(message, sender, sendResponse)
    .then(response => sendResponse(response))
    .catch(err => {
      console.error(`[Background] Error handling message type '${message.type}':`, err);
      sendResponse({ error: (err as Error).message });
    });

  return true; // Keep channel open for async response
});


// ==================== Storage change listener ====================

chrome.storage.onChanged.addListener((changes, areaName) => {
  (async () => {
    if (areaName !== 'local') return;

    if (changes.selectedModel) {
      // If switching away from local model, unload the engine to free GPU memory
      const oldModel = changes.selectedModel.oldValue as string | undefined;
      const newModel = changes.selectedModel.newValue as string | undefined;
      const wasLocal = oldModel?.startsWith('local:');
      const isLocal = newModel?.startsWith('local:');

      if (wasLocal && !isLocal && localEngine.engine) {
        const unloadedModelId = oldModel!.split(':')[1];
        // Drain inference queue so any in-flight task finishes before disposal
        await localEngine.drainQueue(async () => {
          await localEngine.reset();
        });
        // Update status so popup shows 'cached' instead of stale 'ready'
        await localEngine.updateStatus(unloadedModelId, { state: 'cached' });
      }

      // If switching to a local model, auto-initialize if cached
      if (isLocal) {
        const modelId = newModel!.split(':')[1];
        const cached = await localEngine.checkCached(modelId);
        if (cached) {
          localEngine.initialize(modelId).catch(err => {
            console.error('[WebLLM] Auto-init on model switch failed:', err);
          });
        }
      }

      // Model change: flush pipeline state and wipe cache — classifications from a different model are no longer valid.
      await handleSettingsChange(changes);
    }

    const filtersChanged = Object.keys(changes).some(
      key => key.startsWith('descriptions_')
    );
    if (filtersChanged) {
      handleFilterPackChange();
    }

    if (changes.aiTextFilterEnabled || changes.aiTextDetectionThreshold) {
      await handleSettingsChange(changes);
    }

    // Also retry error posts when API keys change (even without other settings changes)
    if (changes.openaiApiKey || changes.geminiApiKey || changes.openrouterApiKey || changes.anthropicApiKey) {
      // Clear auth error for the provider whose key changed
      const authData = await getStorage(['authErrorApis']);
      const authErrorApis = { ...(authData.authErrorApis || {}) };
      let authChanged = false;
      if (changes.openaiApiKey && authErrorApis.openai) { delete authErrorApis.openai; authChanged = true; }
      if (changes.geminiApiKey && authErrorApis.gemini) { delete authErrorApis.gemini; authChanged = true; }
      if (changes.openrouterApiKey && authErrorApis.openrouter) { delete authErrorApis.openrouter; authChanged = true; }
      if (changes.anthropicApiKey && authErrorApis.anthropic) { delete authErrorApis.anthropic; authChanged = true; }
      if (authChanged) await setStorage({ authErrorApis });

      if (errorState.count > 0) {
        triggerErrorRetry().catch(err => console.error('[Background] triggerErrorRetry error:', err));
      }
    }
  })().catch(err => console.error('[Background] Storage change handler error:', err));
});

// ==================== Extension lifecycle ====================

// Check local model statuses on extension install/update
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    chrome.tabs.create({ url: 'https://x.com' }).catch(err => console.error('[Background] Failed to open x.com on install:', err));
  }

  if (details.reason === 'install' || details.reason === 'update') {
    (async () => {

      const statuses: Record<string, LocalModelStatus> = {};
      const webgpuSupported = !!navigator.gpu;

      for (const model of PREDEFINED_MODELS.local) {
        if (!webgpuSupported) {
          statuses[model.name] = { state: 'unsupported', reason: 'WebGPU not supported' };
        } else {
          const cached = await localEngine.checkCached(model.name);
          // Use 'cached' for models in cache but not loaded (they will auto-load when selected)
          statuses[model.name] = { state: cached ? 'cached' : 'not_downloaded' };
        }
      }

      await setStorage({ localModelStatuses: statuses });
    })().catch(err => console.error('[Background] onInstalled error:', err));
  }
});

// Clean up references before service worker terminates.
// Don't call engine.unload() — it's async and can't complete before Chrome kills
// the worker. GPU memory is freed automatically when Chrome's GPU process tears
// down the Dawn Wire IPC channel for the terminated worker.
// Note: onSuspend is not available in Safari service workers
if (chrome.runtime.onSuspend) {
  chrome.runtime.onSuspend.addListener(() => {
    imbueWebSocket.disconnect();
    localEngine.teardown();
  });
}


