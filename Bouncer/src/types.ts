// ==================== Site IDs ====================

/** Known platform adapter identifiers. Add new entries when adding adapters. */
export type SiteId = 'twitter' | 'kick';

// ==================== Core Evaluation ====================

/** The cached verdict for a post — what parseAPIResponse produces and what gets stored. */
export interface EvaluationResult {
  shouldHide: boolean;
  reasoning: string;
  category?: string | null;
  rawResponse?: string | null;
  timestamp?: number;
  /** Which model produced this evaluation. */
  model?: string;
  /** Set by the background when the result came from the evaluation cache. */
  cached?: boolean;
}

/** The post data sent to a model for evaluation. */
export interface EvaluationPostData {
  text: string;
  imageUrls: string[];
}

// ==================== Pipeline Response ====================

/** What the pipeline returns to content scripts via chrome.runtime.sendMessage. */
export type PipelineResponse = EvaluationResult | PipelineError | PipelineRetry | null;

/** Evaluation failed — content should track for retry via error broadcasts. */
export interface PipelineError {
  error: 'auth' | 'rate_limit' | 'not_found' | 'server_error' | 'no_api_key';
  reasoning: string;
}

/** Transient signal — content should remove from processed and retry later. */
export interface PipelineRetry {
  retry: true;
  reasoning: string;
}

// ==================== Post Content ====================

/** Quoted tweet metadata, extracted from DOM or store. */
export interface QuoteContent {
  textHtml: string;
  author: string;
  handle: string;
  avatarUrl: string | null;
  timeText: string | null;
}

/** Extracted from DOM by the platform adapter. */
export interface PostContent {
  text: string;
  author: string;
  handle: string;
  avatarUrl: string | null;
  timeText: string | null;
  textHtml: string;
  quote: QuoteContent | null;
  postUrl: string | null;
  imageUrls: string[];
  hasMediaContainer: boolean;
  fromStore?: boolean;
}

/** Stored for the "filtered posts" panel — includes captured display data for re-rendering. */
export interface FilteredPost {
  /** Snapshot of the post content at the time it was filtered. */
  post: PostContent;
  /** The evaluation text string sent to the AI (for cache key / feedback). */
  evaluationText: string;
  reasoning: string;
  rawResponse: string;
  category: string | null;
  timestamp: number;
}

// ==================== Models & Config ====================

/** A model in the catalog — covers predefined and custom models. */
export interface ModelDef {
  name: string;
  display: string;
  isFree?: boolean;
  supportsImages?: boolean;
  sizeGB?: number;
  apiKwargs?: Record<string, unknown>;
  api?: string;
}

/** A local model with WebLLM-specific configuration. */
export interface LocalModelDef extends ModelDef {
  isLocal?: boolean;
  extraBody?: Record<string, unknown>;
  inferenceParams?: Record<string, unknown>;
  webllmConfig?: {
    model?: string;
    model_lib?: string;
    model_type?: number;
    overrides?: Record<string, unknown>;
  };
}

/** Typed map for PREDEFINED_MODELS — local models get extended fields. */
export interface PredefinedModelsMap {
  local: LocalModelDef[];
  [provider: string]: (ModelDef | LocalModelDef)[];
}

/** Runtime config for making an API call. Built by processBatch from Settings + ModelDef. */
export interface APIConfig {
  apiName: string;
  modelName: string;
  apiKey?: string | null;
  apiBase?: string;
  apiKwargs?: Record<string, unknown>;
  modelConfig?: ModelDef;
}

/** Fields shared between runtime Settings and the chrome.storage.local schema. */
interface SettingsBase {
  apiKey: string;
  openaiApiKey: string;
  openaiApiBase: string;
  openrouterApiKey: string;
  geminiApiKey: string;
  anthropicApiKey: string;
  enabled: boolean;
  useEmbeddings: boolean;
  selectedModel: string;
  customModels: ModelDef[];
  predefinedModelKwargs: Record<string, Record<string, unknown>>;
}

export interface Settings extends SettingsBase {
  descriptions: string[];
}

export interface LocalModelStatus {
  state: 'not_downloaded' | 'downloading' | 'cached' | 'ready'
    | 'initializing' | 'error' | 'unsupported';
  progress?: number;
  text?: string;
  error?: string;
  reason?: string;
}

// ==================== Platform Adapter ====================

export interface PlatformSelectors {
  post: string;
  sidebar: string;
  sidebarContent: string;
  primaryColumn: string;
  nav: string;
  bottomBar: string;
  mutations: string;
  textContent: string;
}

export interface PlatformAdapter {
  siteId: SiteId;
  selectors: PlatformSelectors;
  extractPostContent(article: HTMLElement): PostContent;
  shouldProcessCurrentPage(): boolean;
  isMainPost(article: HTMLElement): boolean;
  getPostUrl(article: HTMLElement): string | null;
  getPostContentKey(article: HTMLElement): string;
  getPostContainer(article: HTMLElement): HTMLElement;
  hidePost(article: HTMLElement): void;
  getThemeMode(): 'light' | 'dim' | 'dark';
  extractPostContentFromStore(article: HTMLElement): Promise<PostContent | null>;
  cleanupFilteredPostHtml(tweetContent: HTMLElement, imageUrls: string[]): void;
  getShareButton(article: HTMLElement): HTMLElement | null;
  insertActionButton(article: HTMLElement, button: HTMLElement): void;
  getSearchForm(): HTMLElement | null;
}

// ==================== Pipeline Internals ====================

export interface ErrorState {
  type: 'auth' | 'rate_limit' | 'not_found' | 'server_error' | null;
  subType: string | null;
  count: number;
  apiDisplayName: string | null;
}

export interface PendingEvaluation {
  post: string;
  imageUrls: string[];
  resolve: (result: PipelineResponse) => void;
  cacheKey: string;
  tabId: number | undefined;
  postUrl: string | null;
  siteId: SiteId;
}

// ==================== Alert System ====================

/** Model/provider context shared across alert subsystems. */
export interface ModelContext {
  selectedModel: string;
  hasAlternativeApis: boolean;
}

export interface AlertState {
  latency: {
    isHighLatency: boolean;
    medianLatency: number;
  } & ModelContext;
  error: {
    type: string | null;
    subType: string | null;
    count: number;
    apiDisplayName: string | null;
  } & ModelContext;
  queue_backlog: {
    pendingCount: number;
    isLocalModel: boolean;
    modelInitializing: boolean;
  };
}

export interface AlertDisplayConfig {
  message: string;
  buttonText: string | null;
}

// ==================== Chat Messages ====================

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | Array<{ type: string; text?: string; image_url?: { url: string } }>;
}

// ==================== Chrome Extension Messages ====================

export type ContentToBackgroundMessage =
  | { type: 'pageLoad' }
  | { type: 'evaluatePost'; post: string; imageUrls: string[]; postUrl: string | null; siteId: SiteId }
  | { type: 'suggestAnnoyingReasons'; post: string; imageUrls: string[]; siteId?: SiteId }
  | { type: 'clearCache' }
  | { type: 'clearSinglePost'; post: string; imageUrls: string[] }
  | { type: 'getStats' }
  | { type: 'getReasoning'; post: string; imageUrls: string[] }
  | { type: 'getErrorStatus' }
  | { type: 'getAllLocalModelStatuses' }
  | { type: 'initializeWebLLM'; modelId: string }
  | { type: 'cancelLocalModelDownload'; modelId: string }
  | { type: 'preemptInference' }
  | { type: 'overrideCacheEntry'; post: string; imageUrls: string[]; shouldHide: boolean; reasoning?: string }
  | { type: 'sendFeedback'; decision: string; tweetData: { text: string; imageUrls: string[] }; reasoning?: string; rawResponse?: string; siteId?: SiteId }
  | { type: 'getAuthStatus' }
  | { type: 'launchGoogleAuth' };

export type BackgroundToContentMessage =
  | { type: 'ping' }
  | { type: 'latencyUpdate'; isHighLatency: boolean; medianLatency: number; selectedModel: string; hasAlternativeApis: boolean }
  | { type: 'errorStatusUpdate'; errorType: string | null; subType: string | null; count: number; apiDisplayName: string | null; selectedModel: string; hasAlternativeApis: boolean }
  | { type: 'reEvaluateErrors' }
  | { type: 'queueStatusUpdate'; pendingCount: number; isLocalModel: boolean; modelInitializing: boolean }
  | { type: 'getPositions'; postUrls: string[] }
  | { type: 'processingPost'; postUrl: string }
  | { type: 'annoyingProgress'; verified: number; total: number }
  | { type: 'authStateChanged'; authenticated: boolean };

// ==================== Dependency Injection ====================

export interface PlatformContext {
  adapter: PlatformAdapter;
  descriptionsKey: DescriptionKey;
  IS_IOS: boolean;
}

export interface IOSUICallbacks {
  getIOSPageContainer: () => HTMLElement | null;
  getFFFabButton: () => HTMLElement | null;
  updateIOSFilteredCount: () => void;
  renderIOSCategories: (page: HTMLElement) => void;
}

export interface PostOperations {
  findPosts: () => HTMLElement[];
  extractPostContent: (article: HTMLElement) => PostContent;
  reEvaluateAllPosts: () => void;
  processExistingPosts: () => void;
  evaluatePost: (article: HTMLElement) => Promise<void>;
  reEvaluateSinglePost: (article: HTMLElement) => Promise<void>;
}

export interface PostState {
  processedPosts: WeakSet<HTMLElement>;
  postReasonings: WeakMap<HTMLElement, { shouldHide: boolean; reasoning: string; rawResponse?: string | null; isApiError?: boolean }>;
  pendingPosts: Set<HTMLElement>;
}

export interface ContentUIDeps extends PlatformContext, IOSUICallbacks, PostOperations, PostState {}

export interface IOSDeps {
  adapter: PlatformAdapter;
  descriptionsKey: DescriptionKey;
  showSettingsModal: () => void;
  renderFilteredPostsView: (container: HTMLElement) => void;
  updateTheme: () => void;
  addFilterPhrase: (phrase: string) => Promise<boolean>;
  removeFilterPhrase: (phrase: string) => Promise<void>;
  getFilteredPosts: () => FilteredPost[];
}

// ==================== Chrome Storage Schema ====================

/** Per-site description keys, derived from SiteId. */
type DescriptionKeys = { [K in SiteId as `descriptions_${K}`]: string[] };

/** Valid storage keys for site-specific descriptions. */
export type DescriptionKey = `descriptions_${SiteId}`;

/** Typed schema for chrome.storage.local keys. */
export type StorageSchema = SettingsBase & {
  authErrorApis: Record<string, boolean>;
  localModelsEnabled: boolean;
  localModelStatuses: Record<string, LocalModelStatus>;
  evaluationCache: Record<string, EvaluationResult>;
  stats: { filtered: number; evaluated: number; totalCost: number };
  googleAuthToken: string;
  openrouterCodeVerifier: string;
} & DescriptionKeys;

// ==================== API Response Types ====================

/** Shape of an OpenAI-compatible chat completions response. */
export interface DirectAPIResponse {
  choices: Array<{
    message: { content: string };
  }>;
}

// ==================== Imbue Backend Responses ====================

/** Common metadata fields present on all Imbue WebSocket responses. */
interface ImbueResponseBase {
  processingTime: number;
  gpuId: string;
  jobId: string;
  rawResponse: string;
}

/** Response from the filterPost / validatePhrase actions.
 *  The backend parses the LLM output server-side into shouldHide/reasoning/category. */
export interface ImbueFilterResponse extends ImbueResponseBase {
  shouldHide: boolean;
  reasoning: string | null;
  category?: string | null;
}

/** Response from the suggestAnnoying action.
 *  The backend parses one category label per line from the LLM output. */
export interface ImbueSuggestResponse extends ImbueResponseBase {
  suggestions: string[];
}

/** Discriminated Imbue response — callers should narrow via the action they sent. */
export type ImbueAPIResponse = ImbueFilterResponse | ImbueSuggestResponse;
