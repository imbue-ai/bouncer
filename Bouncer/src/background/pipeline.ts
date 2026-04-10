// Post processing pipeline: queue, cache, error/latency state

import {
  generateCacheKey,
  parseAPIResponse, checkRateLimitError, checkApiError, checkAuthenticationError,
  RATE_LIMIT_TYPE_CONFIG, API_ERROR_TYPE_CONFIG,
} from '../shared/utils';
import { PREDEFINED_MODELS, API_DISPLAY_NAMES } from '../shared/models';
import { buildAPIMessages } from '../shared/prompts';
import { callDirectAPI, callAnthropicAPI, callImbueAPI } from './providers';
import { callLocalInference, localEngine } from './local-model';
import { getAuthToken } from './auth';
import { getStorage, setStorage, removeStorage, getDescriptions } from '../shared/storage';
import type {
  EvaluationResult, PipelineResponse, PipelineError, PendingEvaluation,
  ErrorState, Settings, APIConfig, ChatMessage, BackgroundToContentMessage, LocalModelDef,
  SiteId,
} from '../types';

// ==================== Constants ====================

const CACHE_SIZE = 500; // Increased for persistent storage
const BATCH_DELAY_MS = 1000; // Wait time to collect posts before sending batch
const MAX_CONCURRENT_BATCHES = 100; // Allow parallel batch processing

// Latency tracking
const LATENCY_WINDOW_SIZE = 5;
const LATENCY_THRESHOLD_SECONDS = 8;

// Error retry
const RATE_LIMIT_RETRY_INTERVAL_MS = 60000; // 1 minute

// Queue backlog
export const QUEUE_BACKLOG_THRESHOLD = 5;

// Map API names to their corresponding settings key for API key lookup
const API_KEY_SETTINGS: Record<string, keyof Settings> = {
  openrouter: 'openrouterApiKey',
  openai: 'openaiApiKey',
  gemini: 'geminiApiKey',
  anthropic: 'anthropicApiKey'
};

// ==================== Pipeline State ====================

export let evaluationCache = new Map<string, EvaluationResult>();
let batchTimeout: ReturnType<typeof setTimeout> | null = null;
let inFlightBatches = 0; // Counter for concurrent batch processing
let cacheLoaded = false;

// Per-tab queue management
const tabQueues = new Map<number, PendingEvaluation[]>();      // tabId -> array of queue items
const tabPendingKeys = new Map<number, Set<string>>(); // tabId -> Set of cacheKeys
const tabDuplicateResolvers = new Map<number, Map<string, Array<(result: PipelineResponse) => void>>>(); // tabId -> Map<cacheKey, [resolve]>
let activeTabId: number | null = null;

// Latency tracking for warning banner
const latencyWindow: number[] = [];

// Unified error state
export let errorState: ErrorState = {
  type: null,           // 'auth' | 'rate_limit' | 'not_found' | 'server_error' | null
  subType: null,        // rate limit provider: 'openrouter_credits' | 'gemini_free_tier' | 'generic'
  count: 0,             // number of tracked error posts
  apiDisplayName: null   // for auth errors: provider display name
};
let errorRetryTimeout: ReturnType<typeof setTimeout> | null = null;
let serverErrorRetried = false; // Track whether we've already done a one-time retry for transient server errors

// Track last broadcast state to avoid spamming updates
let lastQueueBroadcastState = { pendingCount: 0, modelInitializing: false };

// Tab set reference (set from index.ts)
let activeContentTabsRef: Set<number> | null = null;

// ==================== Initialization ====================

export function initPipeline(tabs: Set<number>): void {
  activeContentTabsRef = tabs;
}

// ==================== Per-tab queue management ====================

// Update active tab. Clears inference queue (stale closures) and schedules batch for new tab.
export function setActiveTab(tabId: number | null): void {
  activeTabId = tabId;
  localEngine.clearQueue();
  if (tabId !== null && tabQueues.has(tabId) && tabQueues.get(tabId)!.length > 0) {
    scheduleBatch();
  }
}

// Enqueue a post for a specific tab. Returns true if the cacheKey was already queued (duplicate).
// Duplicates are NOT added to the queue array — their resolve callbacks are stored separately
// and called when the original item completes, avoiding redundant processing cycles.
export function enqueuePost(tabId: number, item: PendingEvaluation): boolean {
  if (!tabQueues.has(tabId)) {
    tabQueues.set(tabId, []);
    tabPendingKeys.set(tabId, new Set());
    tabDuplicateResolvers.set(tabId, new Map());
  }
  const keys = tabPendingKeys.get(tabId)!;
  const isDuplicate = keys.has(item.cacheKey);
  if (isDuplicate) {
    // Store resolver to be called when the original item completes
    const dupes = tabDuplicateResolvers.get(tabId)!;
    if (!dupes.has(item.cacheKey)) dupes.set(item.cacheKey, []);
    dupes.get(item.cacheKey)!.push(item.resolve);
    return true;
  }
  keys.add(item.cacheKey);
  tabQueues.get(tabId)!.push(item);
  return false;
}

// Check if a cacheKey is pending in a specific tab's queue.
export function isKeyPending(tabId: number, cacheKey: string): boolean {
  const keys = tabPendingKeys.get(tabId);
  return keys ? keys.has(cacheKey) : false;
}

// Resolve an item AND any duplicate resolvers waiting on the same cacheKey.
function resolveWithDuplicates(tabId: number, item: PendingEvaluation, result: PipelineResponse): void {
  item.resolve(result);
  const dupes = tabDuplicateResolvers.get(tabId);
  if (dupes && item.cacheKey && dupes.has(item.cacheKey)) {
    for (const resolve of dupes.get(item.cacheKey)!) {
      resolve(result);
    }
    dupes.delete(item.cacheKey);
  }
}

// Clear a specific tab's queue — resolved items are silently dropped (null).
export function clearTabQueue(tabId: number): void {
  const queue = tabQueues.get(tabId);
  if (queue) {
    for (const item of queue) {
      resolveWithDuplicates(tabId, item, null);
    }
    tabQueues.delete(tabId);
    tabPendingKeys.delete(tabId);
    tabDuplicateResolvers.delete(tabId);
  }
}

// ==================== Broadcast helpers ====================

// Send a typed message to a single tab
export function sendToTab(tabId: number, message: BackgroundToContentMessage): Promise<unknown> {
  return chrome.tabs.sendMessage(tabId, message).catch(() => {});
}

// Generic helper to broadcast messages to all tabs with active content scripts
function broadcastToTabs(message: BackgroundToContentMessage): void {
  const tabs = activeContentTabsRef;
  if (!tabs) return;
  for (const tabId of tabs) {
    void sendToTab(tabId, message);
  }
}

// ==================== Settings helper ====================

// Get user settings
// siteId is optional - if provided, fetches site-specific descriptions
export async function getSettings(siteId?: SiteId): Promise<Settings> {
  const descriptionsKey = siteId ? `descriptions_${siteId}` as const : undefined;
  const settingsKeys = [
    'apiKey', 'openaiApiKey', 'openaiApiBase', 'openrouterApiKey', 'geminiApiKey',
    'anthropicApiKey', 'enabled', 'useEmbeddings', 'selectedModel',
    'customModels', 'predefinedModelKwargs'
  ] as const;
  const [data, descriptions] = await Promise.all([
    getStorage([...settingsKeys]),
    descriptionsKey ? getDescriptions(descriptionsKey) : Promise.resolve([] as string[])
  ]);
  return {
    apiKey: data.apiKey || '',
    openaiApiKey: data.openaiApiKey || '',
    openaiApiBase: data.openaiApiBase || '',
    openrouterApiKey: data.openrouterApiKey || '',
    geminiApiKey: data.geminiApiKey || '',
    anthropicApiKey: data.anthropicApiKey || '',
    enabled: data.enabled !== false,
    descriptions,
    useEmbeddings: data.useEmbeddings || false,
    selectedModel: data.selectedModel || 'imbue',
    customModels: data.customModels || [],
    predefinedModelKwargs: data.predefinedModelKwargs || {}
  };
}

// ==================== Error state management ====================

// Broadcast unified error status to all tabs
export async function broadcastErrorStatus(): Promise<void> {
  const settings = await getSettings();
  const hasAlternativeApis = !!(settings.openaiApiKey || settings.geminiApiKey || settings.openrouterApiKey || settings.anthropicApiKey);

  const status: BackgroundToContentMessage = {
    type: 'errorStatusUpdate',
    errorType: errorState.type,
    subType: errorState.subType,
    count: errorState.count,
    apiDisplayName: errorState.apiDisplayName,
    selectedModel: settings.selectedModel,
    hasAlternativeApis
  };
  broadcastToTabs(status);
}

// Reset error state and broadcast
// Only clears the auth error for the current model's provider, preserving errors for other providers
export async function clearErrorState(): Promise<void> {
  const settings = await getSettings();
  if (settings.selectedModel && settings.selectedModel !== 'imbue') {
    const [apiName] = settings.selectedModel.split(':');
    const data = await getStorage(['authErrorApis']);
    const authErrorApis = { ...(data.authErrorApis || {}) };
    if (authErrorApis[apiName]) {
      delete authErrorApis[apiName];
      await setStorage({ authErrorApis });
    }
  }
  errorState = { type: null, subType: null, count: 0, apiDisplayName: null };
  serverErrorRetried = false;
  if (errorRetryTimeout) {
    clearTimeout(errorRetryTimeout);
    errorRetryTimeout = null;
  }
  await broadcastErrorStatus();
}

// Trigger re-evaluation of error posts in content scripts
export async function triggerErrorRetry(): Promise<void> {
  if (errorState.count === 0) return;
  errorState.count = 0;
  errorState.type = null;
  errorState.subType = null;
  errorState.apiDisplayName = null;
  serverErrorRetried = false;
  if (errorRetryTimeout) {
    clearTimeout(errorRetryTimeout);
    errorRetryTimeout = null;
  }
  // Don't clear authErrorApis here - auth errors persist per-provider
  // They get cleared when the provider succeeds (clearErrorState) or when its API key changes
  await broadcastErrorStatus();
  broadcastToTabs({ type: 'reEvaluateErrors' });
}

// Schedule auto-retry for rate limit errors
function scheduleAutoRetry(): void {
  if (errorRetryTimeout) {
    clearTimeout(errorRetryTimeout);
  }

  errorRetryTimeout = setTimeout(() => {
    if (errorState.count > 0 && errorState.type === 'rate_limit') {
      console.log(`[Error] Retry interval elapsed, retrying ${errorState.count} rate-limited posts`);
      triggerErrorRetry().catch(err => console.error('[Error] triggerErrorRetry failed:', err));
    }
  }, RATE_LIMIT_RETRY_INTERVAL_MS);
}

// ==================== Latency tracking ====================

function recordLatency(seconds: number): void {
  latencyWindow.push(seconds);
  if (latencyWindow.length > LATENCY_WINDOW_SIZE) {
    latencyWindow.shift();
  }
  broadcastLatencyStatus().catch(err => console.error('[Latency] Broadcast failed:', err));
}

function getMedianLatency(): number {
  if (latencyWindow.length === 0) return 0;
  const sorted = [...latencyWindow].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function isHighLatency(): boolean {
  // Only trigger if we have enough samples and median is above threshold
  return latencyWindow.length >= 3 && getMedianLatency() > LATENCY_THRESHOLD_SECONDS;
}

export function getMedianLatencyValue(): number {
  return getMedianLatency();
}

export function getLatencySampleCount(): number {
  return latencyWindow.length;
}

async function broadcastLatencyStatus(): Promise<void> {
  const settings = await getSettings();
  const hasAlternativeApis = !!(settings.openaiApiKey || settings.geminiApiKey || settings.openrouterApiKey || settings.anthropicApiKey);

  const status: BackgroundToContentMessage = {
    type: 'latencyUpdate',
    isHighLatency: isHighLatency(),
    medianLatency: getMedianLatency(),
    selectedModel: settings.selectedModel,
    hasAlternativeApis
  };
  broadcastToTabs(status);
}

// ==================== Queue status ====================

// Broadcast queue status to all tabs (for local model backlog warning)
export async function broadcastQueueStatus(): Promise<void> {
  const settings = await getSettings();
  const isLocalModel = settings.selectedModel?.startsWith('local:');
  // Use active tab's pending keys for accurate count of unique pending posts
  const activeKeys = activeTabId !== null ? tabPendingKeys.get(activeTabId) : null;
  const pendingCount = activeKeys ? activeKeys.size : 0;

  // Check if model is initializing
  let modelInitializing = false;
  if (isLocalModel) {
    const modelId = settings.selectedModel.split(':')[1];
    modelInitializing = localEngine.isInitializing() ||
      (!localEngine.isModelLoaded(modelId) && pendingCount > 0);
  }

  // Only broadcast if state actually changed
  if (pendingCount === lastQueueBroadcastState.pendingCount &&
      modelInitializing === lastQueueBroadcastState.modelInitializing) {
    return;
  }

  lastQueueBroadcastState = { pendingCount, modelInitializing };

  const status: BackgroundToContentMessage = {
    type: 'queueStatusUpdate',
    pendingCount,
    isLocalModel: !!isLocalModel,
    modelInitializing
  };
  broadcastToTabs(status);
}

// ==================== Cache ====================

// Load cache from persistent storage on startup
export async function loadCache(): Promise<void> {
  if (cacheLoaded) return;
  try {
    const data = await getStorage(['evaluationCache']);
    if (data.evaluationCache && typeof data.evaluationCache === 'object') {
      evaluationCache = new Map(Object.entries(data.evaluationCache));
    }
    cacheLoaded = true;
  } catch (err) {
    console.error('Failed to load cache:', err);
    cacheLoaded = true;
  }
}

// Save cache to persistent storage
export async function saveCache(): Promise<void> {
  try {
    const cacheObj = Object.fromEntries(evaluationCache);
    await setStorage({ evaluationCache: cacheObj });
  } catch (err) {
    console.error('Failed to save cache:', err);
  }
}

// ==================== Viewport prioritization ====================

// Prioritize pending posts by their distance to viewport center
// Requests current positions from content scripts and sorts the queue
async function prioritizeByViewportDistance(queue: PendingEvaluation[]): Promise<void> {
  if (queue.length === 0) return;

  // Group pending posts by tabId, using postUrl for position lookups
  const postsByTab = new Map<number | undefined, string[]>();
  queue.forEach(item => {
    if (!item.postUrl) return; // Skip items without postUrl
    if (!postsByTab.has(item.tabId)) {
      postsByTab.set(item.tabId, []);
    }
    postsByTab.get(item.tabId)!.push(item.postUrl);
  });

  // Request positions from each tab
  const positionPromises: Promise<{ tabId: number | undefined; positions: Record<string, number> }>[] = [];
  for (const [tabId, postUrls] of postsByTab) {
    positionPromises.push(
      chrome.tabs.sendMessage(tabId!, { type: 'getPositions', postUrls })
        .then((response: { positions?: Record<string, number> } | undefined) => ({ tabId, positions: response?.positions || {} }))
        .catch(() => {
          return { tabId, positions: {} as Record<string, number> };
        })
    );
  }

  const results = await Promise.all(positionPromises);

  // Build distance map: postUrl -> distance to viewport center
  const distanceMap = new Map<string, number>();
  for (const { positions } of results) {
    for (const [postUrl, distance] of Object.entries(positions)) {
      distanceMap.set(postUrl, distance);
    }
  }

  // Sort by distance (closest first), posts not found in DOM go to end
  queue.sort((a, b) => {
    const distA = distanceMap.get(a.postUrl!) ?? Infinity;
    const distB = distanceMap.get(b.postUrl!) ?? Infinity;
    return distA - distB;
  });

}


// ==================== Error classification ====================

// Classify an error message into a type using priority ordering: auth > rate_limit > api_error.
// apiName is needed to determine if auth errors should be checked (excluded for imbue/local).
// Returns { errorType, subType } where both may be null if no pattern matches.
export function classifyError(errorMessage: string, apiName: string): { errorType: ErrorState['type']; subType: string | null } {
  // Auth errors only apply to external API providers
  if (apiName !== 'imbue' && apiName !== 'local' && checkAuthenticationError(errorMessage)) {
    return { errorType: 'auth', subType: null };
  }

  const rateLimitCheck = checkRateLimitError(errorMessage);
  if (rateLimitCheck.isRateLimited) {
    return { errorType: 'rate_limit', subType: rateLimitCheck.type };
  }

  const apiErrorCheck = checkApiError(errorMessage);
  if (apiErrorCheck.isApiError) {
    return { errorType: apiErrorCheck.type as ErrorState['type'], subType: null };
  }

  return { errorType: null, subType: null };
}

// ==================== Batch processing ====================

// Process a batch of posts
async function processBatch(): Promise<void> {
  batchTimeout = null; // Clear timeout first, before any early returns

  if (activeTabId === null) return;

  if (inFlightBatches >= MAX_CONCURRENT_BATCHES) {
    // Max concurrent batches reached, schedule another batch for later
    const activeQueue = tabQueues.get(activeTabId);
    if (activeQueue && activeQueue.length > 0) {
      batchTimeout = setTimeout(() => { processBatch().catch(err => console.error('[Pipeline] processBatch failed:', err)); }, BATCH_DELAY_MS);
    }
    return;
  }

  // Capture tab ID before any async work
  const batchTabId = activeTabId;
  const pendingEvaluations = tabQueues.get(batchTabId);
  const pendingKeys = tabPendingKeys.get(batchTabId);

  if (!pendingEvaluations || pendingEvaluations.length === 0) return;

  inFlightBatches++;

  const settings = await getSettings(pendingEvaluations[0]?.siteId);
  const isLocalModel = settings.selectedModel?.startsWith('local:');

  // Local models serialize inference, so limit to 1 in-flight batch to ensure
  // viewport prioritization stays fresh (re-sorted before each dequeue).
  // Don't schedule a deferred retry here — the current in-flight batch will
  // call scheduleBatch() when it completes, which re-sorts by viewport.
  if (isLocalModel && inFlightBatches > 1) {
    inFlightBatches--;
    return;
  }

  // For local models, prioritize posts closest to viewport center
  if (isLocalModel && pendingEvaluations.length > 0) {
    await prioritizeByViewportDistance(pendingEvaluations);
  }

  // Grab one post from the queue (re-check length — async ops above may have drained it)
  if (pendingEvaluations.length === 0) {
    inFlightBatches--;
    return;
  }
  const item = pendingEvaluations.shift()!;
  if (item.cacheKey) pendingKeys!.delete(item.cacheKey);
  broadcastQueueStatus().catch(err => console.error('[Queue] Broadcast failed:', err));

  // Handle disabled case
  if (!settings.enabled) {
    resolveWithDuplicates(batchTabId, item, { shouldHide: false, reasoning: 'Filtering is disabled' });
    inFlightBatches--;
    return;
  }

  // Check if filter rules are defined
  if (!settings.descriptions || settings.descriptions.length === 0) {
    resolveWithDuplicates(batchTabId, item, { shouldHide: false, reasoning: 'No filter categories defined.' });
    inFlightBatches--;
    return;
  }

  // Check cache
  const imageUrls = item.imageUrls || [];
  const cacheKey = generateCacheKey(item.post, imageUrls);
  if (evaluationCache.has(cacheKey)) {
    const cached = evaluationCache.get(cacheKey)!;
    resolveWithDuplicates(batchTabId, item, { ...cached, cached: true });
    inFlightBatches--;
    if (pendingEvaluations.length > 0) scheduleBatch();
    return;
  }

  const postData = { text: item.post, imageUrls };
  const startTime = Date.now();

  // Build API config
  let apiConfig: APIConfig;

  if (settings.selectedModel === 'imbue') {
    apiConfig = { modelName: 'imbue', apiName: 'imbue', apiKey: null };
  } else if (isLocalModel) {
    const modelName = settings.selectedModel.split(':')[1];
    const modelConfig = PREDEFINED_MODELS.local?.find(m => m.name === modelName) || {} as LocalModelDef;
    apiConfig = { modelName, apiName: 'local', modelConfig };
  } else {
    const [apiName, ...nameParts] = settings.selectedModel.split(':');
    const modelName = nameParts.join(':');
    const apiKey = (settings[API_KEY_SETTINGS[apiName]] as string) || null;
    apiConfig = { modelName, apiName, apiKey };

    if (apiName === 'openai' && settings.openaiApiBase) {
      apiConfig.apiBase = settings.openaiApiBase;
    }

    let apiKwargs: Record<string, unknown> = {};
    const predefinedModels = PREDEFINED_MODELS[apiName] || [];
    const predefinedModel = predefinedModels.find(m => m.name === modelName);
    if (predefinedModel) {
      if (settings.selectedModel in settings.predefinedModelKwargs) {
        apiKwargs = { ...settings.predefinedModelKwargs[settings.selectedModel] };
      } else if (predefinedModel.apiKwargs) {
        apiKwargs = { ...predefinedModel.apiKwargs };
      }
    }
    const customModel = settings.customModels.find(m => m.api === apiName && m.name === modelName);
    if (customModel?.apiKwargs) apiKwargs = customModel.apiKwargs;
    if (Object.keys(apiKwargs).length > 0) apiConfig.apiKwargs = apiKwargs;
  }

  try {
    let result: { shouldHide: boolean; reasoning: string; category?: string | null; rawResponse?: string | null; inferenceTime?: number };

    if (isLocalModel) {
      const postUrl = item.postUrl;
      const onInferenceStart = postUrl
        ? () => { void sendToTab(batchTabId, { type: 'processingPost', postUrl }); }
        : undefined;
      result = await callLocalInference(postData, settings.descriptions, apiConfig.modelConfig as LocalModelDef | null, apiConfig.modelName, { onInferenceStart });
    } else if (apiConfig.apiName === 'imbue') {
      const authToken = await getAuthToken();
      const imbueResponse = await callImbueAPI(postData, settings.descriptions, 'filterPost', authToken);
      result = {
        shouldHide: imbueResponse.shouldHide,
        reasoning: imbueResponse.reasoning || 'No reasoning provided',
        category: imbueResponse.category || null,
        rawResponse: imbueResponse.rawResponse || null,
      };
    } else if (apiConfig.apiName === 'anthropic') {
      const messages = buildAPIMessages(postData, settings.descriptions);
      const rawContent = await callAnthropicAPI(messages, apiConfig);
      result = { ...parseAPIResponse(rawContent), rawResponse: rawContent };
    } else {
      const messages = buildAPIMessages(postData, settings.descriptions);
      const rawContent = await callDirectAPI(messages, apiConfig);
      result = { ...parseAPIResponse(rawContent), rawResponse: rawContent };
    }

    console.log(`[Eval] shouldHide=${result.shouldHide}, category="${result.category}", reasoning="${result.reasoning?.substring(0, 80)}"`);

    const evalResult: EvaluationResult = {
      shouldHide: result.shouldHide,
      reasoning: result.reasoning,
      category: result.category || null,
      rawResponse: result.rawResponse || null,
      model: settings.selectedModel || 'unknown',
      timestamp: Date.now()
    };

    // Update cache
    evaluationCache.set(cacheKey, evalResult);
    if (evaluationCache.size > CACHE_SIZE) {
      const firstKey = evaluationCache.keys().next().value;
      if (firstKey !== undefined) evaluationCache.delete(firstKey);
    }

    // Update stats
    const statsData = await getStorage(['stats']);
    const stats = statsData.stats || { filtered: 0, evaluated: 0, totalCost: 0 };
    stats.evaluated++;
    if (evalResult.shouldHide) {
      stats.filtered++;
    }
    await setStorage({ stats });
    await saveCache();

    const wallTime = ((Date.now() - startTime) / 1000).toFixed(2);
    const latencyTime = isLocalModel && result.inferenceTime != null ? result.inferenceTime : parseFloat(wallTime);
    recordLatency(latencyTime);

    // Successful evaluation — clear error state and re-evaluate stuck error posts
    if (errorState.type) {
      await clearErrorState();
      broadcastToTabs({ type: 'reEvaluateErrors' });
    }
    resolveWithDuplicates(batchTabId, item, evalResult);
  } catch (error) {
    // Handle inference preempted (user scrolled past) — re-queue and process next
    if ((error as Error).message === 'Inference preempted') {
      const currentQueue = tabQueues.get(batchTabId);
      const currentKeys = tabPendingKeys.get(batchTabId);
      if (currentQueue && currentKeys) {
        currentQueue.push(item);
        if (item.cacheKey) currentKeys.add(item.cacheKey);
      } else {
        resolveWithDuplicates(batchTabId, item, null);
      }
      inFlightBatches--;
      scheduleBatch(); // Re-sort by viewport and process the now-visible post
      return;
    }

    // Handle inference queue cleared (tab switch) — re-queue item to original tab
    if ((error as Error).message === 'Inference queue cleared') {
      const currentQueue = tabQueues.get(batchTabId);
      const currentKeys = tabPendingKeys.get(batchTabId);

      // Only re-queue if the tab's queue is the SAME object we shifted from.
      // If it was deleted (tab closed) or replaced (page reload), resolve gracefully.
      if (currentQueue === pendingEvaluations && currentKeys) {
        currentQueue.push(item);
        if (item.cacheKey) currentKeys.add(item.cacheKey);
      } else {
        resolveWithDuplicates(batchTabId, item, null);
      }
      inFlightBatches--;
      return; // setActiveTab handles scheduling for the new tab
    }

    console.error('Inference error:', error);

    const classified = classifyError((error as Error).message, apiConfig.apiName);
    const errorType = classified.errorType;
    const subType = classified.subType;
    let reasoning = (error as Error).message;

    if (errorType === 'auth') {
      const displayName = API_DISPLAY_NAMES[apiConfig.apiName] || apiConfig.apiName;
      errorState.apiDisplayName = displayName;
      const authData = await getStorage(['authErrorApis']);
      const authErrorApis = { ...(authData.authErrorApis || {}) };
      authErrorApis[apiConfig.apiName] = true;
      await setStorage({ authErrorApis });
    } else if (errorType === 'rate_limit') {
      const typeConfig = RATE_LIMIT_TYPE_CONFIG[subType!];
      reasoning = typeConfig?.reasoning || 'Rate limited - will retry when model is switched or after 1 minute of inactivity';
    } else if (errorType === 'not_found' || errorType === 'server_error') {
      const typeConfig = API_ERROR_TYPE_CONFIG[errorType];
      reasoning = typeConfig?.message || `API error: ${(error as Error).message}`;
    }

    if (errorType) {
      errorState.type = errorType;
      errorState.subType = subType;
      errorState.count++;
      broadcastErrorStatus().catch(err => console.error('[Error] Broadcast failed:', err));

      if (errorType === 'rate_limit') {
        scheduleAutoRetry();
      } else if (errorType === 'server_error' && !serverErrorRetried) {
        serverErrorRetried = true;
        setTimeout(() => {
          if (errorState.count > 0 && errorState.type === 'server_error') {
            triggerErrorRetry().catch(err => console.error('[Error] triggerErrorRetry failed:', err));
          }
        }, 5000);
      }
    }

    const errorResult: PipelineError = { error: errorType || 'server_error', reasoning };
    resolveWithDuplicates(batchTabId, item, errorResult);
  }

  inFlightBatches--;

  // Clean up empty tab queue entries to prevent memory leak over long sessions
  const batchQueue = tabQueues.get(batchTabId);
  if (batchQueue && batchQueue.length === 0) {
    tabQueues.delete(batchTabId);
    tabPendingKeys.delete(batchTabId);
    tabDuplicateResolvers.delete(batchTabId);
  }

  // Process next post if there are more pending in the active tab
  const activeQueue = activeTabId !== null ? tabQueues.get(activeTabId) : null;
  if (activeQueue && activeQueue.length > 0) {
    scheduleBatch();
  }
}

// Schedule processing for the next pending post
export function scheduleBatch(): void {
  if (batchTimeout) return; // Already scheduled
  if (activeTabId === null) return;

  const activeQueue = tabQueues.get(activeTabId);
  if (!activeQueue || activeQueue.length === 0) return;

  if (activeQueue.length > 0) {
    processBatch().catch(err => console.error('[Pipeline] processBatch failed:', err));
  }
}

// ==================== Settings change handling ====================

// Called from index.ts when settings change to reset pipeline state
export async function handleSettingsChange(changes: Record<string, chrome.storage.StorageChange>): Promise<void> {
  // Cancel any pending batch
  if (batchTimeout) {
    clearTimeout(batchTimeout);
    batchTimeout = null;
  }

  // Clear all tab queues
  for (const [tabId, queue] of tabQueues.entries()) {
    const result: PipelineResponse = { retry: true as const, reasoning: 'Settings changed, re-evaluating...' };
    for (const queueItem of queue) {
      resolveWithDuplicates(tabId, queueItem, result);
    }
    tabQueues.delete(tabId);
    tabPendingKeys.delete(tabId);
    tabDuplicateResolvers.delete(tabId);
  }
  localEngine.clearQueue();

  broadcastQueueStatus().catch(err => console.error('[Queue] Broadcast failed:', err)); // Clear queue backlog warning

  // Reset processing state
  inFlightBatches = 0;

  // Clear cache
  evaluationCache.clear();
  await removeStorage('evaluationCache');
  // If settings changed and we have error posts, retry them
  if ((changes.selectedModel || changes.openaiApiKey || changes.geminiApiKey || changes.openrouterApiKey || changes.anthropicApiKey) && errorState.count > 0) {
    triggerErrorRetry().catch(err => console.error('[Error] triggerErrorRetry failed:', err));
  }
}

// Handle page load: clear pending evaluations for a specific tab
export function handlePageLoad(tabId: number): void {
  clearTabQueue(tabId);
  if (tabId === activeTabId) {
    localEngine.clearQueue();
  }
}

// ==================== Suggest annoying reasons ====================

// Validate a single filter phrase by running the post through the actual filter model
async function validateFilterPhrase(postText: string, imageUrls: string[], phrase: string, settings: Settings): Promise<boolean> {
  const postData = { text: postText, imageUrls: imageUrls || [] };
  const isLocalModel = settings.selectedModel?.startsWith('local:');

  if (settings.selectedModel === 'imbue') {
    const authToken = await getAuthToken();
    const imbueResponse = await callImbueAPI(postData, [phrase], 'validatePhrase', authToken);
    return imbueResponse.shouldHide === true;
  } else if (isLocalModel) {
    const modelName = settings.selectedModel.split(':')[1];
    const modelConfig = PREDEFINED_MODELS.local?.find(m => m.name === modelName) || {} as LocalModelDef;
    const localResult = await callLocalInference(postData, [phrase], modelConfig, modelName, { priority: 1 });
    return localResult.shouldHide === true;
  } else {
    const [apiName, ...nameParts] = settings.selectedModel.split(':');
    const modelName = nameParts.join(':');
    const apiKey = (settings[API_KEY_SETTINGS[apiName]] as string) || null;
    const apiConfig: APIConfig = { modelName, apiName, apiKey };
    if (apiName === 'openai' && settings.openaiApiBase) {
      apiConfig.apiBase = settings.openaiApiBase;
    }
    const messages = buildAPIMessages(postData, [phrase]);
    const callFn = apiName === 'anthropic' ? callAnthropicAPI : callDirectAPI;
    const rawContent = await callFn(messages, apiConfig);
    const parsed = parseAPIResponse(rawContent);
    return parsed.shouldHide === true;
  }
}

// Generate candidate filter phrases using the configured model
async function generateCandidatePhrases(postText: string, imageUrls: string[], count: number, rejectPhrases: string[], settings: Settings): Promise<string[]> {
  const isLocalModel = settings.selectedModel?.startsWith('local:');

  const rejected = rejectPhrases.length > 0
    ? ` Do NOT suggest any of these: ${rejectPhrases.join(', ')}.`
    : '';

  const hasImages = imageUrls && imageUrls.length > 0;
  const imageNote = hasImages ? ' Consider BOTH the text and any attached images when suggesting categories.' : '';
  const simpleSystemPrompt = `Given a social media post, suggest exactly ${count} broad content category labels (1-3 words each) that someone might want to filter out because the post is annoying, obnoxious, or unpleasant. Each label must be a general topic or content type such that if another model were asked "does this post relate to [label]?", it would say yes. Focus on what makes the post grating or unwelcome. At least one of the ${count} labels MUST describe a negative emotional tone or off-putting quality of the post. ${imageNote}${rejected} Output ONLY the ${count} category labels, one per line, nothing else.`;
  let result: string[];

  if (settings.selectedModel === 'imbue') {
    const postData = { text: postText, imageUrls: imageUrls || [] };
    const authToken = await getAuthToken();
    const imbueResponse = await callImbueAPI(postData, undefined, 'suggestAnnoying', authToken);
    const suggestions = imbueResponse.suggestions || [];
    result = suggestions.slice(0, count);
  } else if (isLocalModel) {
    // Local WebLLM models don't support image inputs — use text only
    const modelName = settings.selectedModel.split(':')[1];
    await localEngine.ensureLoaded(modelName);
    const rawText = await localEngine.generate([
      { role: 'system', content: simpleSystemPrompt },
      { role: 'user', content: postText }
    ], 150, { priority: 1, temperature: 0.7 });
    result = rawText.split('\n')
      .map(l => l.replace(/^\d+[.)-]\s*/, '').trim())
      .filter(l => l && l.length <= 40 && !l.startsWith('<'))
      .slice(0, count);
  } else {
    const [apiName, ...nameParts] = settings.selectedModel.split(':');
    const modelName = nameParts.join(':');
    const apiKey = (settings[API_KEY_SETTINGS[apiName]] as string) || null;
    const apiConfig: APIConfig = { modelName, apiName, apiKey };
    if (apiName === 'openai' && settings.openaiApiBase) {
      apiConfig.apiBase = settings.openaiApiBase;
    }
    // Build multimodal user content when images are present
    const userContent: ChatMessage['content'] = hasImages
      ? [
          { type: 'text', text: postText },
          ...imageUrls.map(url => ({ type: 'image_url', image_url: { url } }))
        ]
      : postText;
    const callFn = apiName === 'anthropic' ? callAnthropicAPI : callDirectAPI;
    const rawText = await callFn([
      { role: 'system', content: simpleSystemPrompt },
      { role: 'user', content: userContent }
    ], apiConfig);
    result = rawText.split('\n').map(l => l.replace(/^\d+[.)-]\s*/, '').trim()).filter(l => l && l.length <= 40 && !l.startsWith('<')).slice(0, count);
  }
  return result.map(item => item.toLowerCase());
}

// Generate 9 candidate filter phrases up front, then return the first 3 that validate
export async function suggestAnnoyingReasons(postText: string, imageUrls: string[], siteId?: SiteId, tabId?: number): Promise<string[]> {
  const settings = await getSettings(siteId);
  const rejected: string[] = [];

  const candidates = await generateCandidatePhrases(postText, imageUrls, 9, rejected, settings);

  const uniqueCandidates = [...new Set(candidates)];
  let validatedCount = 0;

  function sendProgress(): void {
    if (tabId) {
      void sendToTab(tabId, {
        type: 'annoyingProgress',
        verified: validatedCount,
        total: 3
      });
    }
  }

  const results = await Promise.all(uniqueCandidates.map(async (phrase) => {
    try {
      const passes = await validateFilterPhrase(postText, imageUrls, phrase, settings);
      if (passes && validatedCount < 3) {
        validatedCount++;
        sendProgress();
      }
      return { phrase, passes };
    } catch (err) {
      console.warn(`[Suggest] Validation error for "${phrase}":`, (err as Error).message);
      return { phrase, passes: false };
    }
  }));

  const finalValidated = results.filter(r => r.passes).map(r => r.phrase).slice(0, 3);
  return finalValidated;
}
