// SW-side proxy to the LiteRT-LM offscreen document. Manages the offscreen
// lifecycle (createDocument / closeDocument) and routes per-call messages.
// All public methods mirror LitertlmRuntime so the backend can swap one in
// for the other without conditionals at the call sites.

import type { LocalModelDef, ChatMessage } from '../../types';
import type { InitProgress } from './types';

const OFFSCREEN_URL = 'offscreen.html';

let nextRequestId = 1;

// Listeners keyed by request id receive streaming progress events sent from
// the offscreen runtime during init().
const progressListeners = new Map<number, (p: InitProgress) => void>();

chrome.runtime.onMessage.addListener((message: unknown) => {
  const m = message as { channel?: string; id?: number; progress?: number; text?: string };
  if (m?.channel !== 'litertlm-progress') return false;
  if (typeof m.id !== 'number') return false;
  const cb = progressListeners.get(m.id);
  if (cb && typeof m.progress === 'number') {
    cb({ progress: m.progress, text: m.text ?? '' });
  }
  return false;
});

async function ensureOffscreen(): Promise<void> {
  // Newer Chromes have hasDocument(); fall back to scanning client URLs.
  const offscreenApi = chrome.offscreen as unknown as {
    hasDocument?: () => Promise<boolean>;
    createDocument: (opts: { url: string; reasons: string[]; justification: string }) => Promise<void>;
  };
  if (typeof offscreenApi.hasDocument === 'function') {
    if (await offscreenApi.hasDocument()) return;
  } else {
    const matched = await (self as unknown as { clients: { matchAll: (opts: { includeUncontrolled: boolean }) => Promise<{ url: string }[]> } })
      .clients.matchAll({ includeUncontrolled: true });
    const target = chrome.runtime.getURL(OFFSCREEN_URL);
    if (matched.some(c => c.url === target)) return;
  }
  await offscreenApi.createDocument({
    url: OFFSCREEN_URL,
    reasons: ['WORKERS'],
    justification: 'Run LiteRT-LM Engine, whose wasm loader uses <script>-tag injection not available in MV3 service workers.',
  });
}

interface OffscreenResponse<T = unknown> { ok: boolean; value?: T; error?: string }

async function send<T>(payload: Record<string, unknown>): Promise<T> {
  await ensureOffscreen();
  const id = nextRequestId++;
  const resp = await chrome.runtime.sendMessage<unknown, OffscreenResponse<T>>({
    target: 'litertlm-offscreen',
    id,
    ...payload,
  });
  if (!resp?.ok) throw new Error(resp?.error ?? 'Offscreen request failed');
  return resp.value as T;
}

async function sendWithProgress<T>(
  payload: Record<string, unknown>,
  onProgress: (p: InitProgress) => void,
): Promise<T> {
  await ensureOffscreen();
  const id = nextRequestId++;
  progressListeners.set(id, onProgress);
  try {
    const resp = await chrome.runtime.sendMessage<unknown, OffscreenResponse<T>>({
      target: 'litertlm-offscreen',
      id,
      ...payload,
    });
    if (!resp?.ok) throw new Error(resp?.error ?? 'Offscreen request failed');
    return resp.value as T;
  } finally {
    progressListeners.delete(id);
  }
}

export class LitertlmProxy {
  async initialize(
    modelDef: LocalModelDef,
    onProgress: (p: InitProgress) => void,
    abortSignal: AbortSignal,
  ): Promise<void> {
    const onAbort = (): void => {
      // Best-effort cancellation; the offscreen runtime aborts its download.
      send({ method: 'cancelInit' }).catch(() => { /* may already be done */ });
    };
    abortSignal.addEventListener('abort', onAbort, { once: true });
    try {
      await sendWithProgress<void>({ method: 'init', modelDef }, onProgress);
    } finally {
      abortSignal.removeEventListener('abort', onAbort);
    }
  }

  async unload(): Promise<void> {
    try {
      await send<void>({ method: 'unload' });
    } catch (e) {
      console.error('[LitertlmProxy] unload failed:', e);
    }
    // Tear the offscreen down so the next init starts fresh and we don't keep
    // the WebGPU device pinned. closeDocument is safe even if the offscreen
    // page is gone — swallow errors to keep teardown idempotent.
    try {
      await chrome.offscreen.closeDocument();
    } catch { /* no offscreen open */ }
  }

  async generate(messages: ChatMessage[], maxTokens: number, params: Record<string, unknown>): Promise<string> {
    return send<string>({ method: 'generate', messages, maxTokens, params });
  }

  async interrupt(): Promise<void> {
    try {
      await send<void>({ method: 'interrupt' });
    } catch (e) {
      console.error('[LitertlmProxy] interrupt failed:', e);
    }
  }

  async countTokens(text: string): Promise<number> {
    return send<number>({ method: 'countTokens', text });
  }

  async truncateText(text: string, maxTokens: number): Promise<string> {
    return send<string>({ method: 'truncateText', text, maxTokens });
  }
}
