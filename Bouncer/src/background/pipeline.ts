// Post processing pipeline: queue, cache, error/latency state

import {
  generateCacheKey,
  parseAPIResponse, checkRateLimitError, checkApiError, checkAuthenticationError,
  RATE_LIMIT_TYPE_CONFIG, API_ERROR_TYPE_CONFIG,
} from '../shared/utils';
import { PREDEFINED_MODELS, API_DISPLAY_NAMES, DEFAULT_MODEL } from '../shared/models';
import { buildAPIMessages } from '../shared/prompts';
import { callDirectAPI, callAnthropicAPI, callImbueAPI, callImbueAiTextDetection } from './providers';
import { runDetectors, type Detector, type DetectorResult } from './detectors';
import { callLocalInference, localEngine } from './local-model';
import { getStorage, setStorage, removeStorage, getDescriptions, clampThreshold, DEFAULT_AI_TEXT_DETECTION_THRESHOLD } from '../shared/storage';
export { DEFAULT_AI_TEXT_DETECTION_THRESHOLD };
import type {
  EvaluationResult, PipelineResponse, PipelineError, PendingEvaluation,
  ErrorState, Settings, APIConfig, ChatMessage, BackgroundToContentMessage, LocalModelDef,
  SiteId, DetectorSnapshot,
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


// Posts shorter than this aren't sent to the AI-text detector. Short text
// produces unreliable scores and burns quota.
const AI_TEXT_DETECTION_MIN_WORDS = 10;

// Word count using ICU word-boundary segmentation (Unicode UAX #29). Counts
// word-like segments — handles contractions ("don't" → 1), hyphenated forms
// ("well-known" → 1), URLs sensibly, and CJK / Thai dictionary segmentation.
const wordSegmenter = new Intl.Segmenter(undefined, { granularity: 'word' });
function countWords(text: string): number {
  if (!text) return 0;
  let n = 0;
  for (const seg of wordSegmenter.segment(text)) if (seg.isWordLike) n++;
  return n;
}

// =============================================================================
// Multi-detector orchestration helpers used by processBatch.
// =============================================================================

interface TabPlanEntry {
  name: string;
  willRun: boolean;
  skipReason?: string;
}

// Why AI detection won't run for a given post (or null if it will). Priority:
// toggle off → post too short. Auth is handled at WS handshake time (Google
// token on Chrome, App Check on iOS); we mirror the filter detector and let
// any handshake failure surface through the existing auth-error banner
// rather than gating per-post here.
function computeAiSkipReason(
  aiToggleOn: boolean,
  rawText: string,
): string | null {
  // AI text detection is currently Imbue-only (callImbueAiTextDetection).
  // Open-source builds without the Imbue backend always skip this detector.
  if (process.env.HAS_IMBUE_BACKEND !== 'true') return 'AI detection requires Imbue backend';
  if (!aiToggleOn) return 'AI detection disabled';
  const wc = countWords(rawText);
  if (wc < AI_TEXT_DETECTION_MIN_WORDS) {
    return `Post too short (${wc} words; need ${AI_TEXT_DETECTION_MIN_WORDS})`;
  }
  return null;
}

// The full per-post plan. Always two entries so the popup is consistent. A
// detector that can't run gets a skipReason instead of a willRun=true flag.
function buildTabPlan(
  filterEnabled: boolean,
  aiSkipReason: string | null,
): TabPlanEntry[] {
  return [
    {
      name: 'filter',
      willRun: filterEnabled,
      skipReason: filterEnabled ? undefined : 'No filter phrases configured',
    },
    {
      name: 'aiText',
      willRun: !aiSkipReason,
      skipReason: aiSkipReason ?? undefined,
    },
  ];
}

// Send the initial evaluationStarted + per-skipped detectorResponse messages
// and seed the snapshots map so cache writes capture skipped state too.
function dispatchInitialTabs(
  tabId: number,
  evaluationId: string,
  tabPlan: TabPlanEntry[],
): Map<string, DetectorSnapshot> {
  const snapshots = new Map<string, DetectorSnapshot>();
  if (tabPlan.length === 0) return snapshots;

  void sendToTab(tabId, {
    type: 'evaluationStarted',
    evaluationId,
    detectorNames: tabPlan.map(t => t.name),
  });
  for (const entry of tabPlan) {
    if (!entry.willRun) {
      snapshots.set(entry.name, { status: 'skipped', skipReason: entry.skipReason });
      void sendToTab(tabId, {
        type: 'detectorResponse',
        evaluationId,
        detectorName: entry.name,
        skipped: true,
        skipReason: entry.skipReason,
      });
    }
  }
  return snapshots;
}

// Run the detector race, mirror each settle to live tab updates, and capture
// each settle into the snapshots map for cache persistence. Also marks any
// detector that didn't finish (because a sibling hid first) as aborted.
async function runDetectorsAndCaptureSnapshots(
  detectors: Detector[],
  snapshots: Map<string, DetectorSnapshot>,
  tabId: number,
  evaluationId: string,
): Promise<DetectorResult> {
  const result = await runDetectors(detectors, {
    onResponse: (detName, value, error) => {
      if (value) {
        snapshots.set(detName, {
          status: 'success',
          shouldHide: value.shouldHide,
          reasoning: value.reasoning,
          category: value.category ?? null,
        });
      } else if (error) {
        snapshots.set(detName, { status: 'error', error: error.message });
      }
      void sendToTab(tabId, {
        type: 'detectorResponse',
        evaluationId,
        detectorName: detName,
        ...(value && {
          shouldHide: value.shouldHide,
          reasoning: value.reasoning,
          category: value.category ?? null,
        }),
        ...(error && { error: error.message }),
      });
    },
  });
  for (const det of detectors) {
    if (!snapshots.has(det.name)) {
      snapshots.set(det.name, {
        status: 'skipped',
        skipReason: 'Aborted (other detector hid first)',
      });
    }
  }
  return result;
}

// Construct the live detector list from settings + per-post gates. Filter is
// index 0 (highest priority); AI is index 1 when it'll actually run.
function buildLiveDetectors(args: {
  filterEnabled: boolean;
  aiEnabled: boolean;
  runFilter: () => Promise<DetectorResult>;
  rawText: string;
  imageUrls: string[];
  aiThreshold: number;
}): Detector[] {
  const detectors: Detector[] = [];
  if (args.filterEnabled) {
    detectors.push({ name: 'filter', promise: args.runFilter() });
  }
  if (args.aiEnabled) {
    detectors.push({
      name: 'aiText',
      promise: (async (): Promise<DetectorResult> => {
        // AI detection sees only the post content — no "Author: " prefix.
        const aiResp = await callImbueAiTextDetection(
          { text: args.rawText, imageUrls: args.imageUrls },
        );
        const isAi = aiResp.confidence >= args.aiThreshold;
        const pct = `${(aiResp.confidence * 100).toFixed(0)}%`;
        return {
          shouldHide: isAi,
          reasoning: isAi
            ? `AI-generated text detected (confidence ${pct})`
            : `Text not detected as AI-generated (confidence ${pct})`,
          category: isAi ? 'AI-generated' : null,
          rawResponse: null,
        };
      })(),
    });
  }
  return detectors;
}

// Build a stable detectorStates blob from a tab plan + accumulated snapshots,
// suitable for persisting on EvaluationResult.
function buildDetectorStates(
  tabPlan: TabPlanEntry[],
  snapshots: Map<string, DetectorSnapshot>,
): EvaluationResult['detectorStates'] {
  if (tabPlan.length === 0) return undefined;
  return {
    names: tabPlan.map(t => t.name),
    map: Object.fromEntries(snapshots),
  };
}


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
  return chrome.tabs.sendMessage(tabId, message);
}

// Replay a cached evaluation as per-tab messages so the popup looks the same
// for cache hits as for fresh runs. New entries with `detectorStates` replay
// exactly; legacy entries get synthesized two-tab output where the cached
// reasoning is attributed to the right detector by category.
export function replayDetectorStates(tabId: number, evaluationId: string, evalResult: EvaluationResult): void {
  if (evalResult.detectorStates) {
    const { names, map } = evalResult.detectorStates;
    void sendToTab(tabId, { type: 'evaluationStarted', evaluationId, detectorNames: names });
    for (const name of names) {
      const snap = map[name];
      if (!snap) continue;
      void sendToTab(tabId, {
        type: 'detectorResponse',
        evaluationId,
        detectorName: name,
        ...(snap.status === 'success' && {
          shouldHide: snap.shouldHide,
          reasoning: snap.reasoning,
          category: snap.category ?? null,
        }),
        ...(snap.status === 'error' && { error: snap.error }),
        ...(snap.status === 'skipped' && { skipped: true, skipReason: snap.skipReason }),
      });
    }
    return;
  }

  // Legacy entry without per-detector state. Show two tabs and attribute the
  // cached reasoning to whichever detector likely produced it (by category).
  const isAi = evalResult.category === 'AI-generated';
  const winnerName = isAi ? 'aiText' : 'filter';
  const otherName = isAi ? 'filter' : 'aiText';
  void sendToTab(tabId, { type: 'evaluationStarted', evaluationId, detectorNames: ['filter', 'aiText'] });
  void sendToTab(tabId, {
    type: 'detectorResponse',
    evaluationId,
    detectorName: winnerName,
    shouldHide: evalResult.shouldHide,
    reasoning: evalResult.reasoning,
    category: evalResult.category ?? null,
  });
  void sendToTab(tabId, {
    type: 'detectorResponse',
    evaluationId,
    detectorName: otherName,
    skipped: true,
    skipReason: 'No detail available (cached before tabs were added)',
  });
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
    'customModels', 'predefinedModelKwargs', 'aiTextFilterEnabled', 'aiTextDetectionThreshold'
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
    selectedModel: data.selectedModel || DEFAULT_MODEL,
    customModels: data.customModels || [],
    predefinedModelKwargs: data.predefinedModelKwargs || {},
    aiTextFilterEnabled: data.aiTextFilterEnabled === true,
    aiTextDetectionThreshold: clampThreshold(data.aiTextDetectionThreshold)
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

export async function clearEvaluationCache(): Promise<void> {
  evaluationCache.clear();
  await removeStorage('evaluationCache');
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

  // Filter and AI detection are independent gating mechanisms. Even when both
  // are off we still flow through the tab-dispatch logic below so the popup
  // always shows two tabs (both marked skipped).
  const filterEnabled = !!(settings.descriptions && settings.descriptions.length > 0);
  const aiToggleOn = settings.aiTextFilterEnabled;

  // Check cache
  const imageUrls = item.imageUrls || [];
  const cacheKey = generateCacheKey(item.post, imageUrls);
  if (evaluationCache.has(cacheKey)) {
    const cached = evaluationCache.get(cacheKey)!;
    replayDetectorStates(batchTabId, item.evaluationId, cached);
    resolveWithDuplicates(batchTabId, item, { ...cached, cached: true });
    inFlightBatches--;
    if (pendingEvaluations.length > 0) scheduleBatch();
    return;
  }

  const postData = { text: item.post, imageUrls };
  const startTime = Date.now();

  // Even with no filter phrases configured, still send the tweet to our
  // servers (with empty categories) so we capture feed contents for
  // analytics. Fire-and-forget — the result is discarded and no UI
  // indicators are shown. Only runs when the Imbue backend is wired up
  // at build time; open-source builds skip this telemetry.
  if (
    process.env.HAS_IMBUE_BACKEND === 'true'
    && !filterEnabled
    && settings.selectedModel === 'imbue'
  ) {
    void callImbueAPI(postData, [], 'filterPost').catch(err =>
      console.warn('[Bouncer] Empty-filter tweet send failed:', (err as Error).message)
    );
  }

  // Build API config (only used when the filter path runs)
  let apiConfig: APIConfig;

  if (process.env.HAS_IMBUE_BACKEND === 'true' && settings.selectedModel === 'imbue') {
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
    let result: DetectorResult;

    // The user-selected filter pipeline. Returns whether the user's filter rules apply.
    const runFilter = async (): Promise<DetectorResult> => {
      if (isLocalModel) {
        const postUrl = item.postUrl;
        const onInferenceStart = postUrl
          ? () => { void sendToTab(batchTabId, { type: 'processingPost', postUrl }); }
          : undefined;
        return await callLocalInference(postData, settings.descriptions, apiConfig.modelConfig as LocalModelDef | null, apiConfig.modelName, { onInferenceStart });
      } else if (apiConfig.apiName === 'imbue') {
        const imbueResponse = await callImbueAPI(postData, settings.descriptions, 'filterPost');
        return {
          shouldHide: imbueResponse.shouldHide,
          reasoning: imbueResponse.reasoning || 'No reasoning provided',
          category: imbueResponse.category || null,
          rawResponse: imbueResponse.rawResponse || null,
        };
      } else if (apiConfig.apiName === 'anthropic') {
        const messages = buildAPIMessages(postData, settings.descriptions);
        const rawContent = await callAnthropicAPI(messages, apiConfig);
        return { ...parseAPIResponse(rawContent), rawResponse: rawContent };
      } else {
        const messages = buildAPIMessages(postData, settings.descriptions);
        const rawContent = await callDirectAPI(messages, apiConfig);
        return { ...parseAPIResponse(rawContent), rawResponse: rawContent };
      }
    };

    // Per-post detector orchestration. Three logical phases: plan tabs and
    // dispatch their initial state to the content script; build the live
    // detector list; race them and capture snapshots for cache persistence.
    const aiSkipReason = computeAiSkipReason(aiToggleOn, item.rawText);
    const aiEnabled = !aiSkipReason;

    const tabPlan = buildTabPlan(filterEnabled, aiSkipReason);
    const snapshots = dispatchInitialTabs(batchTabId, item.evaluationId, tabPlan);

    const detectors = buildLiveDetectors({
      filterEnabled,
      aiEnabled,
      runFilter,
      rawText: item.rawText,
      imageUrls,
      aiThreshold: settings.aiTextDetectionThreshold,
    });

    if (detectors.length === 0) {
      // Nothing to run — tabs were already dispatched as skipped above.
      result = tabPlan.length > 0
        ? { shouldHide: false, reasoning: `All detectors skipped: ${tabPlan.map(t => `${t.name} (${t.skipReason})`).join(', ')}` }
        : { shouldHide: false, reasoning: 'AI detection unavailable (signed out) and no filter phrases set.' };
    } else {
      result = await runDetectorsAndCaptureSnapshots(
        detectors,
        snapshots,
        batchTabId,
        item.evaluationId,
      );
    }

    console.log(`[Eval] shouldHide=${result.shouldHide}, category="${result.category}", reasoning="${result.reasoning?.substring(0, 80)}"`);

    const evalResult: EvaluationResult = {
      shouldHide: result.shouldHide,
      reasoning: result.reasoning,
      category: result.category || null,
      rawResponse: result.rawResponse || null,
      model: settings.selectedModel || 'unknown',
      timestamp: Date.now(),
      detectorStates: buildDetectorStates(tabPlan, snapshots),
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

// Drain in-flight pipeline state without touching the cache. Used when we want in-flight
// and queued classifications to be retried against fresh settings while keeping cached
// classifications intact.
function flushPipelineQueues(reason: string): void {
  if (batchTimeout) {
    clearTimeout(batchTimeout);
    batchTimeout = null;
  }
  for (const [tabId, queue] of tabQueues.entries()) {
    const result: PipelineResponse = { retry: true as const, reasoning: reason };
    for (const queueItem of queue) {
      resolveWithDuplicates(tabId, queueItem, result);
    }
    tabQueues.delete(tabId);
    tabPendingKeys.delete(tabId);
    tabDuplicateResolvers.delete(tabId);
  }
  localEngine.clearQueue();
  broadcastQueueStatus().catch(err => console.error('[Queue] Broadcast failed:', err));
  inFlightBatches = 0;
}

// Called from index.ts when settings change to reset pipeline state.
// Model changes wipe the entire cache (classifications from a prior model are meaningless);
// API-key changes just flush queues and retry errored posts. Phrase edits are handled
// separately and never reach this path.
export async function handleSettingsChange(changes: Record<string, chrome.storage.StorageChange>): Promise<void> {
  flushPipelineQueues('Settings changed, re-evaluating...');

  if (changes.selectedModel) {
    await clearEvaluationCache();
  }

  if ((changes.selectedModel || changes.openaiApiKey || changes.geminiApiKey || changes.openrouterApiKey || changes.anthropicApiKey) && errorState.count > 0) {
    triggerErrorRetry().catch(err => console.error('[Error] triggerErrorRetry failed:', err));
  }
}

// Called when the filter phrase list changed. Clears the cache and flushes in-flight
// batches so they re-run against the updated phrase set.
export function handleFilterPackChange(): void {
  evaluationCache.clear();
  removeStorage('evaluationCache').catch(err => console.error('[Cache] clear failed:', err));
  flushPipelineQueues('Filter phrases changed, re-evaluating...');
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

  if (process.env.HAS_IMBUE_BACKEND === 'true' && settings.selectedModel === 'imbue') {
    const imbueResponse = await callImbueAPI(postData, [phrase], 'validatePhrase');
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

  if (process.env.HAS_IMBUE_BACKEND === 'true' && settings.selectedModel === 'imbue') {
    const postData = { text: postText, imageUrls: imageUrls || [] };
    const imbueResponse = await callImbueAPI(postData, undefined, 'suggestAnnoying');
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
