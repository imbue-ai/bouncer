// Background script entry point: message handler, storage listener, startup, tab tracking

import { PREDEFINED_MODELS } from '../shared/models';
import { cacheKeyFor, GUEST_FILTER_LIMIT, isEmbeddedApp } from '../shared/utils';
import { getStorage, setStorage, removeStorage, phraseSetKey } from '../shared/storage';
import type { AiFilterIntentState, ContentToBackgroundMessage, LocalModelStatus } from '../types';
import { refreshAiFilterIntent, pruneAiFilterPhrases, canJudgeAiIntent } from './ai-intent';
import { STRUCTURAL_FILTER_SITES, structuralFilterKind } from '../shared/structural-filters';
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
import { imbueWebSocket, type ForceLoginMessage } from './ws-manager';
import { launchAuthFlow, signInAnon, isAnonymousUser, refreshAuthToken, getAuthToken, handleAppleSignIn, signOut, setOnIdentityChanged, getCurrentUid, IS_SAFARI } from './auth';
import { initOptionalPlatforms, syncOptionalPlatformScripts } from './optional-platforms';
import { CURRENT_TARGET, optionalPlatforms } from '../shared/platforms';

// Register/unregister content scripts for user-granted optional platforms.
// Runs at every service worker startup because dynamic registrations don't
// survive extension updates.
initOptionalPlatforms();

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
    console.log('[LocalModel] No active tabs remaining, unloading engine for', modelId);
    localEngine.drainQueue(async () => {
      await localEngine.reset();
      if (modelId) {
        await localEngine.updateStatus(modelId, { state: 'cached' });
      }
    }).catch(err => {
      console.error('[LocalModel] Error unloading engine on last tab close:', err);
    });
  }
});

// ==================== Backend-forced sign-in ====================

// The backend can push a `forceLogin` message (e.g. the anonymous tweet limit
// was reached server-side). Mirror the local guest-limit gate: persist it via
// `anonFilterCount` so it survives reloads, then prompt every content tab with
// the same `guestLimitReached` signal the local path uses.
imbueWebSocket.onForceLogin = (_msg: ForceLoginMessage) => {
  void (async () => {
    const { anonFilterCount } = await getStorage(['anonFilterCount']);
    if ((anonFilterCount || 0) < GUEST_FILTER_LIMIT) {
      await setStorage({ anonFilterCount: GUEST_FILTER_LIMIT });
    }
  })();
  for (const tid of activeContentTabs) {
    void sendToTab(tid, { type: 'guestLimitReached' });
  }
};

// When the user's identity changes mid-session (e.g. "Skip for now" anonymous
// -> Google/Apple sign-in), the live WebSocket still carries the old token, so
// the backend keeps applying anonymous limits to that connection. Reconnect to
// re-run $connect with the new token and register the real identity server-side.
setOnIdentityChanged(() => {
  void imbueWebSocket.reconnect();
  // Keep the uninstall URL's UID in sync with the new identity (e.g.
  // anonymous -> Google sign-in), so uninstall logs attribute to the right user.
  updateUninstallUrl();
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

// Open the uninstall page when the extension is removed (not supported in
// Safari). Imbue builds point at a redirect page on imbue.com that logs the
// uninstall (with the Firebase UID, for cohort-level uninstall analytics) to
// the backend before forwarding to the survey form; BYOK builds go straight
// to the survey. Called at startup (before auth restores, as a fallback),
// once auth is ready, and on every identity change so the UID stays current.
const UNINSTALL_SURVEY_URL = 'https://forms.gle/41CSXsBcRMnjofVw8';
const UNINSTALL_PAGE_URL = 'https://imbue.com/product/bouncer/uninstall.html';

function updateUninstallUrl(): void {
  if (!chrome.runtime.setUninstallURL) return;
  let url = UNINSTALL_SURVEY_URL;
  if (process.env.HAS_IMBUE_BACKEND === 'true') {
    const params = new URLSearchParams({ v: chrome.runtime.getManifest().version });
    const uid = getCurrentUid();
    if (uid) params.set('uid', uid);
    if (process.env.BOUNCER_ENV === 'dev') params.set('env', 'dev');
    url = `${UNINSTALL_PAGE_URL}?${params}`;
  }
  chrome.runtime.setUninstallURL(url)
    .catch(err => console.error('[Startup] setUninstallURL failed:', err));
}
updateUninstallUrl();

// One-shot migration: clear any stored selection that points at a local model
// we no longer ship (e.g. an old Qwen ID from before LiteRT-LM was the sole
// local backend). Without this, the popup would render a permanent "error"
// badge until the user picked a new model.
async function migrateStaleLocalSelection(): Promise<void> {
  const { selectedModel } = await getStorage(['selectedModel']);
  if (typeof selectedModel !== 'string' || !selectedModel.startsWith('local:')) return;
  const modelId = selectedModel.split(':')[1];
  const isKnownLocal = PREDEFINED_MODELS.local.some(m => m.name === modelId);
  if (!isKnownLocal) {
    console.log('[Migration] Cleared stale local model selection:', modelId);
    await removeStorage(['selectedModel']);
  }
}

// Initialize cache, sync model statuses, and auto-init local model on startup
// Wrapped in try/catch to prevent unhandled rejections from destabilizing the service worker
(async () => {
  try {
    await migrateStaleLocalSelection();
    await loadCache();

    refreshAiFilterIntent().catch(err =>
      console.warn('[AiIntent] startup refresh failed:', (err as Error).message));

    await refreshAuthToken();
    // Auth has restored by now, so the uninstall URL can carry the real UID.
    updateUninstallUrl();
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

// Lifeline ports held open by content-script overlays (the platform
// onboarding popup). No traffic flows over them — their only job is that
// port.onDisconnect fires in the content script when this extension is
// reloaded or removed, so the overlay can take its backdrop down instead of
// lingering as an orphaned grey layer over the page.
//
// MUST stay guarded: in the mobile apps this bundle runs as a page script
// against ChromePolyfill, whose chrome.runtime historically lacked onConnect.
// An unguarded call here threw at top level and killed the whole background
// script BEFORE the message handler below registered — every sendMessage in
// both apps then resolved undefined via the polyfill's no-listener timeout
// (no suggestions, no classification, no visible error).
chrome.runtime.onConnect?.addListener(() => { /* held open, nothing to do */ });

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
      const cacheKey = cacheKeyFor(message.siteId, message.post, imageUrls, message.postUrl);

      // Check main cache
      if (evaluationCache.has(cacheKey)) {
        const cached = evaluationCache.get(cacheKey)!;
        if (tabId !== undefined) replayDetectorStates(tabId, message.evaluationId, cached);
        return { ...cached, cached: true };
      }

      // Check if already in queue - add another resolver for this item
      if (tabId !== undefined && isKeyPending(tabId, cacheKey)) {
        return new Promise(resolve => {
          const item = { evaluationId: message.evaluationId, post: message.post, rawText: message.rawText, imageUrls, resolve, cacheKey, tabId, postUrl: message.postUrl, siteId: message.siteId, isReply: message.isReply === true };
          enqueuePost(tabId, item);
        });
      }

      // Queue for batch processing
      // processBatch will prioritize posts closest to viewport center for local models
      const resultPromise = new Promise(resolve => {
        const item = { evaluationId: message.evaluationId, post: message.post, rawText: message.rawText, imageUrls, resolve, cacheKey, tabId, postUrl: message.postUrl, siteId: message.siteId, isReply: message.isReply === true };
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

    // Sent by the settings toggle right after the user grants an optional
    // platform's host permission. permissions.onAdded already triggers the
    // same sync, but the popup awaits this one so it doesn't open the
    // platform's feed before the content script is registered.
    case 'syncOptionalPlatforms': {
      await syncOptionalPlatformScripts();
      return { success: true };
    }

    // Should the sender's tab show the platform-onboarding popup? True only
    // for the designated tab (set by onInstalled). If the designated tab no
    // longer exists — closed before the popup was dismissed — the first tab
    // to ask inherits the claim, so the onboarding isn't lost.
    case 'claimPlatformOnboarding': {
      if (tabId === undefined) return { show: false };
      const { showPlatformOnboarding, platformOnboardingTabId } =
        await getStorage(['showPlatformOnboarding', 'platformOnboardingTabId']);
      if (showPlatformOnboarding !== true) return { show: false };
      if (platformOnboardingTabId === tabId) return { show: true };
      if (platformOnboardingTabId !== undefined) {
        const designatedStillOpen = await chrome.tabs.get(platformOnboardingTabId)
          .then(() => true).catch(() => false);
        if (designatedStillOpen) return { show: false };
      }
      await setStorage({ platformOnboardingTabId: tabId });
      return { show: true };
    }

    case 'clearSinglePost': {
      await loadCache();
      const cacheKey = cacheKeyFor(message.siteId, message.post, message.imageUrls || [], message.postUrl);
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
        const cacheKey = cacheKeyFor(message.siteId, postText, imageUrls, message.postUrl);
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
      const cacheKey = cacheKeyFor(message.siteId, message.post, message.imageUrls || [], message.postUrl);
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
      const cacheKey = cacheKeyFor(message.siteId, message.post, message.imageUrls || [], message.postUrl);
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
      return { authenticated: !!token, isSafari: IS_SAFARI, isAnonymous: isAnonymousUser() };
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
            void sendToTab(tid, { type: 'authStateChanged', authenticated: true, isAnonymous: isAnonymousUser() });
          }
        }
        return { success: !!token };
      } catch (err) {
        console.error('[Auth] On-demand auth flow error:', err);
        return { success: false, error: (err as Error).message };
      }
    }

    case 'skipAuth': {
      // "Skip for now" — sign in anonymously so the user can use Bouncer
      // without a Google/Apple account.
      try {
        const token = await signInAnon();
        if (token) {
          for (const tid of activeContentTabs) {
            void sendToTab(tid, { type: 'authStateChanged', authenticated: true, isAnonymous: true });
          }
        }
        return { success: !!token };
      } catch (err) {
        console.error('[Auth] Anonymous auth flow error:', err);
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

  // --- Fire-and-forget: initializeLocalModel responds synchronously, starts async work ---
  if (message.type === 'initializeLocalModel') {
    console.log('[Background] initializeLocalModel received, modelId:', message.modelId, 'hasNativeBridge:', typeof window !== 'undefined' && !!(window as unknown as Record<string, unknown>)?.webkit);
    const modelId = message.modelId;
    if (!modelId) {
      sendResponse({ success: false, error: 'No model ID provided' });
      return false;
    }
    // Start initialization but respond immediately - progress is tracked via storage
    localEngine.initialize(modelId).catch(err => {
      console.error('[LocalModel] Initialization error for', modelId, ':', err);
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
            console.error('[LocalModel] Auto-init on model switch failed:', err);
          });
        }
      }

      // Switching TO a filter model that has an AI-intent judge (Imbue's
      // detectAiIntent route, or a local model judging on-device): phrases
      // added while on a model without one (BYOK) were never judged for
      // AI-removal intent — judge them now so AI detection and the phrase
      // exclusion engage without waiting for the next phrase edit.
      if (typeof newModel === 'string' && canJudgeAiIntent(newModel)) {
        await refreshAiFilterIntent();
      }

      // Model change: flush pipeline state and wipe cache — classifications from a different model are no longer valid.
      await handleSettingsChange(changes);
    }

    // A headline-radio Local pick made before the model was downloaded is
    // parked in pendingLocalModelSelection (the prior model keeps filtering).
    // Complete the switch here, off the model-status stream, so it happens
    // even when the popup that parked it is long closed.
    if (changes.localModelStatuses) {
      const { pendingLocalModelSelection } = await getStorage(['pendingLocalModelSelection']);
      if (pendingLocalModelSelection) {
        const statuses = (changes.localModelStatuses.newValue || {}) as Record<string, LocalModelStatus>;
        const state = statuses[pendingLocalModelSelection.split(':')[1]]?.state;
        if (state === 'ready' || state === 'cached') {
          console.log('[Background] Pending local model downloaded — switching to', pendingLocalModelSelection);
          await removeStorage('pendingLocalModelSelection');
          // This write re-enters this listener as a selectedModel change,
          // which flushes the pipeline and wipes the classification cache.
          await setStorage({ selectedModel: pendingLocalModelSelection });
        }
      }
    }

    const changedDescriptionKeys = Object.keys(changes).filter(
      key => key.startsWith('descriptions_')
    );
    const filtersChanged = changedDescriptionKeys.length > 0;
    // Structural phrases ("no retweets", "videos") never reach the model —
    // getSettings excludes them from its category list and the content
    // script resolves them deterministically. An edit that only touches
    // structural phrases leaves the model-visible set identical, so wiping
    // the verdict cache (and flushing in-flight batches) would just force a
    // pointless re-classification of the whole feed.
    const modelVisibleChangedKey = changedDescriptionKeys.find(key => {
      const siteId = key.slice('descriptions_'.length);
      const modelVisible = (v: unknown): string[] => {
        const arr = Array.isArray(v) ? (v as string[]) : [];
        return STRUCTURAL_FILTER_SITES.has(siteId)
          ? arr.filter(p => structuralFilterKind(p) === null)
          : arr;
      };
      return phraseSetKey(modelVisible(changes[key].oldValue))
        !== phraseSetKey(modelVisible(changes[key].newValue));
    });
    if (modelVisibleChangedKey !== undefined) {
      handleFilterPackChange(changes[modelVisibleChangedKey]);
    }
    if (filtersChanged) {
      // Deletions resolve locally and immediately: dropping the last AI
      // phrase turns AI detection off right now, not after the debounce.
      pruneAiFilterPhrases().catch(err =>
        console.warn('[AiIntent] prune failed:', (err as Error).message));
      // Phrase edits are also the natural moment to re-derive whether the
      // user wants AI-generated content removed (detectAiIntent probe,
      // debounced — it judges added phrases).
      await refreshAiFilterIntent();
    }

    // The intent state also persists bookkeeping (judgedSetKey) — only a
    // change to the AI-phrase set itself warrants flushing the pipeline: it
    // flips the detectors and changes which phrases are excluded from the
    // filter categories. Old-shape values (no aiPhrases array) compare as
    // empty sets.
    const intentChange = changes.aiFilterIntent;
    const aiPhrasesOf = (v: unknown): string[] => {
      const phrases = (v as AiFilterIntentState | undefined)?.aiPhrases;
      return Array.isArray(phrases) ? phrases : [];
    };
    const intentSetChanged = !!intentChange
      && phraseSetKey(aiPhrasesOf(intentChange.oldValue))
        !== phraseSetKey(aiPhrasesOf(intentChange.newValue));

    if (changes.aiTextDetectionThreshold
        || changes.aiTextReplyDetectionThreshold
        || changes.aiImageDetectionThreshold
        || intentSetChanged) {
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

// Post-install landing page: runs the Google Ads and X Ads install-conversion
// snippets first-party on imbue.com — where they can read the _gcl_aw /
// twclid ad-click cookies the ad landing page stores on that domain — then
// forwards the user to x.com. The snippets can't run inside the extension
// itself: the MV3 worker has no DOM and bans remote code, and content-script
// fetches are subject to the host page's CSP. Open-source builds (no Imbue
// backend), dev builds, and --no-ad builds skip straight to x.com — those
// installs are never real conversions, so the X/Google pixels must not fire.
const INSTALL_LANDING_URL =
  process.env.HAS_IMBUE_BACKEND === 'true' &&
  process.env.BOUNCER_ENV !== 'dev' &&
  process.env.BOUNCER_NO_AD !== 'true'
    ? 'https://imbue.com/product/bouncer/just_installed_redirect.html'
    : null;

// Check local model statuses on extension install/update
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    // Fresh install only (not updates): open the just-installed landing page.
    //
    // Two guards keep this to one tab per real install:
    //  - In the iOS/Android app webviews, ChromePolyfill synthesizes this
    //    'install' event on EVERY page load — skip entirely there (app
    //    installs must not report as extension install conversions, and the
    //    landing page fires the conversion snippets every time it loads).
    //  - installPixelArmed persists across repeat 'install' events that keep
    //    storage (e.g. Chrome's extension Repair), so those never re-open
    //    the landing page.
    // The welcome flags sit behind the same guards: synthetic embedded
    // 'install' events would otherwise re-arm the banner after every dismissal.
    (async () => {
      if (isEmbeddedApp()) return;
      const { installPixelArmed } = await getStorage(['installPixelArmed']);
      if (installPixelArmed) return;
      // On Gecko the "activate other platforms?" UI cannot run as an iframe
      // overlaid on x.com: extension pages in web-page iframes only get
      // content-script privileges there (no chrome.permissions — Bugzilla
      // 1443253), and a user gesture doesn't survive a message hop to the
      // background (Bugzilla 1397658). So Firefox opens onboarding.html as a
      // top-level extension tab instead, where permissions.request() works
      // directly from the checkbox click; the page forwards to x.com (or the
      // install landing page) when done. Chrome keeps the x.com overlay.
      const onboardingAsTab =
        CURRENT_TARGET === 'firefox' && optionalPlatforms().length > 0;
      await setStorage({
        installPixelArmed: true,
        // New installs get the plain border ("Colored border on Bouncer box"
        // toggle off). Seeded here rather than flipping what key-absence
        // means: pre-existing installs store "on" as key-absence, so they
        // keep their colored border with no migration. The guards above
        // matter — a repeat 'install' that kept storage (Chrome Repair)
        // must not overwrite an existing user's on-by-absence state.
        coloredBorder: false,
        // First-run banner (shown once the user is past the sign-in gate), and
        // suppress the "what's new" banner for this version — a fresh install
        // has nothing to catch up on.
        showWelcomeBanner: true,
        // One-time "activate other platforms?" popup, shown on x.com ahead
        // of (and independent of) the sign-in gate — but only in the tab
        // created below (see claimPlatformOnboarding). Never set when the
        // onboarding runs as its own tab instead.
        showPlatformOnboarding: !onboardingAsTab,
        lastSeenVersion: chrome.runtime.getManifest().version,
      });
      const tab = await chrome.tabs.create({
        url: onboardingAsTab
          ? chrome.runtime.getURL('onboarding.html')
          : INSTALL_LANDING_URL ?? 'https://x.com',
      });
      // Pin the popup to this tab. Pre-existing x.com tabs (whose overlays
      // would outlive an extension reload as orphaned grey backdrops) must
      // never show it.
      if (!onboardingAsTab && tab.id !== undefined) {
        await setStorage({ platformOnboardingTabId: tab.id });
      }
    })().catch(err => console.error('[Background] Failed to open tab on install:', err));
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


