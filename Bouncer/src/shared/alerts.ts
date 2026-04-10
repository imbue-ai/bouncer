// Unified alert system configuration
// Each alert type defines its CSS class, priority (lower = higher priority), and how to compute its display config

import type { AlertDisplayConfig, AlertState } from '../types';

type AlertConfigEntry<K extends keyof AlertState> = {
  cssClass: string;
  priority: number;
  getConfig: (state: AlertState[K]) => AlertDisplayConfig | null;
};

export const ALERT_CONFIG: {
  [K in keyof AlertState]: AlertConfigEntry<K>;
} = {
  latency: {
    cssClass: 'latency-warning-banner',
    priority: 1,
    getConfig: (state) => {
      if (!state.isHighLatency) return null;

      if (state.selectedModel === 'imbue') {
        return state.hasAlternativeApis
          ? {
              message: "Our service is under heavy load and we're unable to keep up. Use another model to turn Bouncer back on.",
              buttonText: 'Switch Model'
            }
          : {
              message: "Our service is under heavy load and we're unable to keep up. Configure an alternate model provider to turn Bouncer back on.",
              buttonText: 'Configure'
            };
      }
      return {
        message: 'This model has high latency right now. You may have better results switching to another model.',
        buttonText: 'Switch Model'
      };
    }
  },
  error: {
    cssClass: 'api-error-banner',
    priority: 2,
    getConfig: (state) => {
      if (!state.type) return null;

      switch (state.type) {
        case 'auth':
          return {
            message: `Looks like you're not authenticated properly for ${state.apiDisplayName || 'your provider'}. Check over your API key or switch to another provider.`,
            buttonText: 'Fix'
          };
        case 'rate_limit': {
          // Provider-specific rate limit messages
          if (state.subType === 'openrouter_credits') {
            return { message: 'OpenRouter free limit reached. Add credits or switch provider.', buttonText: 'Fix' };
          }
          if (state.subType === 'gemini_free_tier') {
            return { message: 'Gemini free limit reached. Upgrade plan or switch provider.', buttonText: 'Fix' };
          }
          // Generic rate limit
          if (state.count === 0) return null;
          const count = state.count;
          return state.hasAlternativeApis
            ? {
                message: `Rate limited. ${count} post${count !== 1 ? 's' : ''} queued. Try another model.`,
                buttonText: 'Switch Model'
              }
            : {
                message: `Rate limited. ${count} post${count !== 1 ? 's' : ''} queued. Configure another provider or wait 1 min.`,
                buttonText: 'Configure'
              };
        }
        case 'not_found':
          return { message: 'API returned 404 - model or endpoint not found. Check your model settings.', buttonText: 'Fix' };
        case 'server_error':
          return { message: 'API server error. The service may be temporarily unavailable.', buttonText: 'Settings' };
        default:
          return { message: 'API error occurred. Some posts could not be evaluated.', buttonText: 'Settings' };
      }
    }
  },
  queue_backlog: {
    cssClass: 'queue-backlog-banner',
    priority: 4,
    getConfig: (state) => {
      // Show if model is initializing (regardless of queue size)
      if (state.modelInitializing) {
        if (state.pendingCount > 0) {
          return {
            message: `Model loading... ${state.pendingCount} post${state.pendingCount !== 1 ? 's' : ''} queued.`,
            buttonText: null // No button during loading
          };
        }
        return null; // Model loading but no posts queued - don't show banner
      }
      // Only show for local models when there are pending posts being processed
      // Don't show if all queued posts are deferred - those won't evaluate until the user scrolls anyway
      if (!state.isLocalModel || state.pendingCount < 5) return null;
      return {
        message: `${state.pendingCount} posts queued. Wait for the model to catch up before scrolling more.`,
        buttonText: 'Switch Model'
      };
    }
  }
};
