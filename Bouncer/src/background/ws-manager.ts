// Persistent WebSocket manager for Imbue backend
// Reuses a single connection across multiple requests. Reconnects transparently
// when the connection drops (e.g., service worker suspend, network issues).

import { getAuthToken } from './auth';
import type { ImbueAPIResponse } from '../types';

const IMBUE_WS_URL = process.env.IMBUE_WS_URL || '';

const DEFAULT_TIMEOUT_MS = 60000;

/** Internal state for a request that has been sent but not yet fully resolved. */
interface PendingRequest {
  requestId: string;
  jobId: string | null;
  resolve: (value: ImbueAPIResponse) => void;
  reject: (reason: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
  submissionTime: number | null;
}

/** Server ack message — confirms job submission. */
interface WSAckMessage {
  requestId?: string;
  jobId?: string;
  tweetCount?: number;
  error?: string;
  message?: string;
  queueDepth?: number;
}

/** Server result message — final response for a completed job.
 *  The backend parses the LLM output server-side; the shape depends on the request reason. */
interface WSResultMessage {
  jobId: string;
  processingTime: number;
  gpuId: string;
  rawResponse: string;
  // Filter responses (filterPost / validatePhrase)
  shouldHide?: boolean;
  reasoning?: string | null;
  category?: string | null;
  // Suggest responses (suggestAnnoying)
  suggestions?: string[];
  // WebSocket envelope fields
  type?: string;
  error?: string;
}

class ImbueWebSocket {
  ws: WebSocket | null;
  connectPromise: Promise<WebSocket> | null;
  // Requests that have been sent but not yet acked (waiting for jobId)
  // Keyed by requestId, ordered by insertion (Map preserves order)
  unackedRequests: Map<string, PendingRequest>;
  // Requests that have been acked (have a jobId) but waiting for result
  pendingRequests: Map<string, PendingRequest>;

  constructor() {
    this.ws = null;
    this.connectPromise = null;
    this.unackedRequests = new Map();
    this.pendingRequests = new Map();
  }

  // Returns a connected WebSocket, reusing existing or creating new
  async ensureConnected(): Promise<WebSocket> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      return this.ws;
    }

    // If already connecting, wait for that attempt
    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.connectPromise = this._connect();
    try {
      const ws = await this.connectPromise;
      return ws;
    } finally {
      this.connectPromise = null;
    }
  }

  private async _connect(): Promise<WebSocket> {
    const authToken = await getAuthToken();
    const baseUrl = IMBUE_WS_URL;
    const wsUrl = authToken ? `${baseUrl}?token=${encodeURIComponent(authToken)}` : baseUrl;

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);

      const connectTimeout = setTimeout(() => {
        ws.close();
        reject(new Error('WebSocket connection timed out'));
      }, 10000);

      ws.onopen = () => {
        clearTimeout(connectTimeout);
        this.ws = ws;
        resolve(ws);
      };

      ws.onmessage = (event: MessageEvent) => {
        try {
          this._handleMessage(JSON.parse(event.data as string) as WSAckMessage & WSResultMessage);
        } catch (err) {
          console.error('[WS Manager] Failed to parse message:', (err as Error).message, (event.data as string)?.substring?.(0, 100));
        }
      };

      ws.onerror = (error) => {
        clearTimeout(connectTimeout);
        console.error('[WS Manager] Connection error:', error);
        reject(new Error('WebSocket connection error'));
      };

      ws.onclose = (event) => {
        clearTimeout(connectTimeout);
        console.log(`[WS Manager] Closed (code: ${event.code}, clean: ${event.wasClean})`);
        this.ws = null;
        this._rejectAll(new Error(`WebSocket closed (code: ${event.code})`));
      };
    });
  }

  // Send a message and wait for the 2-message response (ack + result)
  async send(message: Record<string, unknown>, { timeout = DEFAULT_TIMEOUT_MS } = {}): Promise<ImbueAPIResponse> {
    const ws = await this.ensureConnected();

    const requestId = crypto.randomUUID();
    message.requestId = requestId;

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        // Clean up from whichever map the request is in
        const unacked = this.unackedRequests.get(requestId);
        if (unacked) {
          this.unackedRequests.delete(requestId);
        } else {
          // Already acked — find and remove from pendingRequests by jobId
          for (const [jobId, pending] of this.pendingRequests) {
            if (pending.requestId === requestId) {
              this.pendingRequests.delete(jobId);
              break;
            }
          }
        }
        reject(new Error('Request timed out after 60 seconds.'));
      }, timeout);

      this.unackedRequests.set(requestId, {
        requestId,
        jobId: null,
        resolve,
        reject,
        timeoutId,
        submissionTime: null,
      });

      ws.send(JSON.stringify(message));
    });
  }

  // Send a message without waiting for a response
  async sendFireAndForget(message: object): Promise<void> {
    const ws = await this.ensureConnected();
    ws.send(JSON.stringify(message));
  }

  // Route incoming messages to the correct pending request
  private _handleMessage(data: WSAckMessage & WSResultMessage): void {
    // Try to match by requestId first (if backend echoes it)
    if (data.requestId && this.unackedRequests.has(data.requestId)) {
      this._handleAck(data, this.unackedRequests.get(data.requestId)!);
      this.unackedRequests.delete(data.requestId);
      return;
    }

    // Check if this is a result for an acked request (has jobId)
    if (data.jobId && this.pendingRequests.has(data.jobId)) {
      this._handleResult(data as WSResultMessage, this.pendingRequests.get(data.jobId)!);
      this.pendingRequests.delete(data.jobId);
      return;
    }

    // Fallback: FIFO ordering for ack messages (oldest unacked request)
    if (this.unackedRequests.size > 0) {
      const [firstRequestId, firstRequest] = this.unackedRequests.entries().next().value as [string, PendingRequest];
      this._handleAck(data, firstRequest);
      this.unackedRequests.delete(firstRequestId);
      return;
    }

    console.warn('[WS Manager] Unmatched message:', data);
  }

  private _handleAck(data: WSAckMessage, request: PendingRequest): void {
    if (data.error) {
      clearTimeout(request.timeoutId);
      if (data.queueDepth !== undefined) {
        request.reject(new Error(`Service temporarily unavailable: ${data.message}`));
      } else {
        request.reject(new Error(data.error + (data.message ? `: ${data.message}` : '')));
      }
      return;
    }

    request.jobId = data.jobId ?? null;
    request.submissionTime = Date.now();

    // Move to pendingRequests keyed by jobId
    if (data.jobId) {
      this.pendingRequests.set(data.jobId, request);
    }
  }

  private _handleResult(data: WSResultMessage, request: PendingRequest): void {
    clearTimeout(request.timeoutId);

    if (data.type === 'jobFailed' || data.error) {
      console.error(`[WS Manager] Job failed: ${data.jobId}`, data.error);
      request.reject(new Error(data.error || 'Processing failed after multiple attempts. Please try again later.'));
      return;
    }

    request.resolve(data as ImbueAPIResponse);
  }

  // Reject all pending requests (called on connection close/error)
  private _rejectAll(error: Error): void {
    for (const [, request] of this.unackedRequests) {
      clearTimeout(request.timeoutId);
      request.reject(error);
    }
    for (const [, request] of this.pendingRequests) {
      clearTimeout(request.timeoutId);
      request.reject(error);
    }
    this.unackedRequests.clear();
    this.pendingRequests.clear();
  }

  // Clean close — call from onSuspend
  disconnect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}

export const imbueWebSocket = new ImbueWebSocket();
