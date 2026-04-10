import { describe, it, expect } from 'vitest';
import { ALERT_CONFIG } from '../../src/shared/alerts.js';

// Default state factories to avoid partial objects
const latencyState = (overrides: Partial<{ isHighLatency: boolean; medianLatency: number; selectedModel: string; hasAlternativeApis: boolean }> = {}) => ({
  isHighLatency: false,
  medianLatency: 0,
  selectedModel: '',
  hasAlternativeApis: false,
  ...overrides,
});

const errorState = (overrides: Partial<{ type: string | null; subType: string | null; count: number; apiDisplayName: string | null; selectedModel: string; hasAlternativeApis: boolean }> = {}) => ({
  type: null as string | null,
  subType: null as string | null,
  count: 0,
  apiDisplayName: null as string | null,
  selectedModel: '',
  hasAlternativeApis: false,
  ...overrides,
});

const queueState = (overrides: Partial<{ pendingCount: number; isLocalModel: boolean; modelInitializing: boolean }> = {}) => ({
  pendingCount: 0,
  isLocalModel: false,
  modelInitializing: false,
  ...overrides,
});

// ==================== ALERT_CONFIG.latency ====================

describe('ALERT_CONFIG.latency.getConfig', () => {
  const getConfig = ALERT_CONFIG.latency.getConfig;

  it('returns null when not high latency', () => {
    expect(getConfig(latencyState({ isHighLatency: false }))).toBeNull();
  });

  it('returns "Switch Model" for imbue with alternatives', () => {
    const config = getConfig(latencyState({ isHighLatency: true, selectedModel: 'imbue', hasAlternativeApis: true }));
    expect(config!.buttonText).toBe('Switch Model');
    expect(config!.message).toBeTruthy();
  });

  it('returns "Configure" for imbue without alternatives', () => {
    const config = getConfig(latencyState({ isHighLatency: true, selectedModel: 'imbue', hasAlternativeApis: false }));
    expect(config!.buttonText).toBe('Configure');
    expect(config!.message).toBeTruthy();
  });

  it('returns "Switch Model" for non-imbue models', () => {
    const config = getConfig(latencyState({ isHighLatency: true, selectedModel: 'openai:gpt-4', hasAlternativeApis: true }));
    expect(config!.buttonText).toBe('Switch Model');
    expect(config!.message).toBeTruthy();
  });
});

// ==================== ALERT_CONFIG.error ====================

describe('ALERT_CONFIG.error.getConfig', () => {
  const getConfig = ALERT_CONFIG.error.getConfig;

  it('returns null when no error type', () => {
    expect(getConfig(errorState({ type: null }))).toBeNull();
  });

  it('handles auth error', () => {
    const config = getConfig(errorState({ type: 'auth', apiDisplayName: 'OpenAI' }));
    expect(config!.buttonText).toBe('Fix');
    expect(config!.message).toBeTruthy();
  });

  it('handles auth error with default provider name', () => {
    const config = getConfig(errorState({ type: 'auth', apiDisplayName: null }));
    expect(config!.message).toBeTruthy();
  });

  it('handles openrouter_credits rate limit', () => {
    const config = getConfig(errorState({ type: 'rate_limit', subType: 'openrouter_credits' }));
    expect(config!.buttonText).toBe('Fix');
    expect(config!.message).toBeTruthy();
  });

  it('handles gemini_free_tier rate limit', () => {
    const config = getConfig(errorState({ type: 'rate_limit', subType: 'gemini_free_tier' }));
    expect(config!.message).toBeTruthy();
  });

  it('handles generic rate limit with alternatives', () => {
    const config = getConfig(errorState({ type: 'rate_limit', subType: 'generic', count: 3, hasAlternativeApis: true }));
    expect(config!.buttonText).toBe('Switch Model');
    expect(config!.message).toBeTruthy();
  });

  it('handles generic rate limit without alternatives', () => {
    const config = getConfig(errorState({ type: 'rate_limit', subType: 'generic', count: 1, hasAlternativeApis: false }));
    expect(config!.buttonText).toBe('Configure');
    expect(config!.message).toBeTruthy();
  });

  it('returns null for generic rate limit with count 0', () => {
    const config = getConfig(errorState({ type: 'rate_limit', subType: 'generic', count: 0 }));
    expect(config).toBeNull();
  });

  it('handles singular vs plural posts', () => {
    const single = getConfig(errorState({ type: 'rate_limit', subType: 'generic', count: 1, hasAlternativeApis: true }));
    const plural = getConfig(errorState({ type: 'rate_limit', subType: 'generic', count: 5, hasAlternativeApis: true }));
    expect(single!.message).toBeTruthy();
    expect(plural!.message).toBeTruthy();
  });

  it('handles not_found error', () => {
    const config = getConfig(errorState({ type: 'not_found' }));
    expect(config!.buttonText).toBe('Fix');
    expect(config!.message).toBeTruthy();
  });

  it('handles server_error', () => {
    const config = getConfig(errorState({ type: 'server_error' }));
    expect(config!.buttonText).toBe('Settings');
    expect(config!.message).toBeTruthy();
  });

  it('handles unknown error type', () => {
    const config = getConfig(errorState({ type: 'unknown_type' }));
    expect(config!.buttonText).toBe('Settings');
    expect(config!.message).toBeTruthy();
  });
});

// ==================== ALERT_CONFIG.queue_backlog ====================

describe('ALERT_CONFIG.queue_backlog.getConfig', () => {
  const getConfig = ALERT_CONFIG.queue_backlog.getConfig;

  it('shows loading message when model is initializing with pending posts', () => {
    const config = getConfig(queueState({ modelInitializing: true, pendingCount: 3 }));
    expect(config!.message).toBeTruthy();
    expect(config!.buttonText).toBeNull();
  });

  it('returns null when model is initializing with no pending posts', () => {
    expect(getConfig(queueState({ modelInitializing: true, pendingCount: 0 }))).toBeNull();
  });

  it('returns null when not local model', () => {
    expect(getConfig(queueState({ modelInitializing: false, isLocalModel: false, pendingCount: 10 }))).toBeNull();
  });

  it('returns null when pending count is below threshold', () => {
    expect(getConfig(queueState({ modelInitializing: false, isLocalModel: true, pendingCount: 4 }))).toBeNull();
  });

  it('shows backlog warning for local model with enough pending posts', () => {
    const config = getConfig(queueState({ modelInitializing: false, isLocalModel: true, pendingCount: 10 }));
    expect(config!.message).toBeTruthy();
    expect(config!.buttonText).toBe('Switch Model');
  });

  it('handles singular post in initializing state', () => {
    const config = getConfig(queueState({ modelInitializing: true, pendingCount: 1 }));
    expect(config!.message).toBeTruthy();
  });
});
