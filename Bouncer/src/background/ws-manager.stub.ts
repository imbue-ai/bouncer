// Stub: WebSocket manager not available (no Imbue backend configured at build time)
// Matches the export interface of ws-manager.ts so all imports compile unchanged.

import type { ImbueAPIResponse } from '../types';

export const imbueWebSocket = {
  ws: null as WebSocket | null,
  connectPromise: null as Promise<WebSocket> | null,
  unackedRequests: new Map(),
  pendingRequests: new Map(),

  disconnect(): void {},

  send(_message: Record<string, unknown>): Promise<ImbueAPIResponse> {
    return Promise.reject(new Error('Imbue backend not configured'));
  },

  sendFireAndForget(_message: object): Promise<void> {
    return Promise.resolve();
  },
};
