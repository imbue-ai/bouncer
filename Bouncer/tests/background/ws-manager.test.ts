import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock auth module before importing ws-manager
vi.mock('../../src/background/auth.js', () => ({
  getAuthToken: vi.fn().mockResolvedValue('fake-firebase-token'),
}));

// Mock WebSocket — onopen is triggered manually by tests, not via setTimeout
class MockWebSocket {
  static CONNECTING = 0 as const;
  static OPEN = 1 as const;
  static CLOSING = 2 as const;
  static CLOSED = 3 as const;
  static lastInstance: MockWebSocket | null = null;
  static instances: MockWebSocket[] = [];

  url: string;
  readyState: number;
  sentMessages: Record<string, unknown>[];
  onopen: ((ev?: unknown) => void) | null = null;
  onclose: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev?: unknown) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;

  constructor(url: string | URL) {
    this.url = String(url);
    this.readyState = 0; // CONNECTING
    this.sentMessages = [];
    MockWebSocket.instances.push(this);
    MockWebSocket.lastInstance = this;
    // Auto-connect on next microtask
    Promise.resolve().then(() => {
      if (this.readyState === 0) {
        this.readyState = 1; // OPEN
        if (this.onopen) this.onopen();
      }
    });
  }
  send(data: string) {
    this.sentMessages.push(JSON.parse(data) as Record<string, unknown>);
  }
  close() {
    this.readyState = 3; // CLOSED
    if (this.onclose) this.onclose({ code: 1000, wasClean: true });
  }
}

globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;

// Import after mocks are set up
const { imbueWebSocket } = await import('../../src/background/ws-manager.js');

describe('ImbueWebSocket', () => {
  beforeEach(() => {
    // Reset the ws-manager state without triggering close handlers
    imbueWebSocket.ws = null;
    imbueWebSocket.unackedRequests.clear();
    imbueWebSocket.pendingRequests.clear();
    imbueWebSocket.connectPromise = null;
    MockWebSocket.lastInstance = null;
    MockWebSocket.instances = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('ensureConnected', () => {
    it('creates a new WebSocket connection with auth token', async () => {
      await imbueWebSocket.ensureConnected();
      const ws = MockWebSocket.lastInstance!;
      expect(ws).not.toBeNull();
      expect(ws.url).toContain('token=fake-firebase-token');
    });

    it('reuses existing connection', async () => {
      await imbueWebSocket.ensureConnected();
      const first = MockWebSocket.lastInstance;
      await imbueWebSocket.ensureConnected();
      expect(MockWebSocket.instances.length).toBe(1);
      expect(MockWebSocket.lastInstance).toBe(first);
    });

    it('deduplicates concurrent connect attempts', async () => {
      const p1 = imbueWebSocket.ensureConnected();
      const p2 = imbueWebSocket.ensureConnected();
      await Promise.all([p1, p2]);
      expect(MockWebSocket.instances.length).toBe(1);
    });
  });

  describe('send and message correlation', () => {
    it('injects requestId into outgoing messages', async () => {
      const sendPromise = imbueWebSocket.send({ action: 'test' });
      await new Promise(r => setTimeout(r, 10));
      const ws = MockWebSocket.lastInstance!;
      expect(ws.sentMessages.length).toBe(1);
      expect(ws.sentMessages[0].requestId).toBeDefined();
      expect(ws.sentMessages[0].action).toBe('test');

      const requestId = ws.sentMessages[0].requestId;
      ws.onmessage!({ data: JSON.stringify({ requestId, jobId: 'job-1' }) });
      ws.onmessage!({ data: JSON.stringify({ jobId: 'job-1', rawResponse: 'done' }) });
      const result = await sendPromise;
      expect(result.rawResponse).toBe('done');
      expect(result.jobId).toBe('job-1');
    });

    it('correlates ack by requestId when backend echoes it', async () => {
      const send1 = imbueWebSocket.send({ action: 'first' });
      const send2 = imbueWebSocket.send({ action: 'second' });
      await new Promise(r => setTimeout(r, 10));
      const ws = MockWebSocket.lastInstance!;

      const reqId1 = ws.sentMessages[0].requestId;
      const reqId2 = ws.sentMessages[1].requestId;

      // Acks arrive out of order
      ws.onmessage!({ data: JSON.stringify({ requestId: reqId2, jobId: 'job-B' }) });
      ws.onmessage!({ data: JSON.stringify({ requestId: reqId1, jobId: 'job-A' }) });

      // Results
      ws.onmessage!({ data: JSON.stringify({ jobId: 'job-A', rawResponse: 'result-A' }) });
      ws.onmessage!({ data: JSON.stringify({ jobId: 'job-B', rawResponse: 'result-B' }) });

      const result1 = await send1;
      const result2 = await send2;
      expect(result1.rawResponse).toBe('result-A');
      expect(result2.rawResponse).toBe('result-B');
    });

    it('correlates ack by FIFO when backend does not echo requestId', async () => {
      const send1 = imbueWebSocket.send({ action: 'first' });
      const send2 = imbueWebSocket.send({ action: 'second' });
      await new Promise(r => setTimeout(r, 10));
      const ws = MockWebSocket.lastInstance!;

      ws.onmessage!({ data: JSON.stringify({ jobId: 'job-A' }) });
      ws.onmessage!({ data: JSON.stringify({ jobId: 'job-B' }) });

      ws.onmessage!({ data: JSON.stringify({ jobId: 'job-A', rawResponse: 'result-A' }) });
      ws.onmessage!({ data: JSON.stringify({ jobId: 'job-B', rawResponse: 'result-B' }) });

      const result1 = await send1;
      const result2 = await send2;
      expect(result1.rawResponse).toBe('result-A');
      expect(result2.rawResponse).toBe('result-B');
    });

    it('rejects on ack error', async () => {
      const sendPromise = imbueWebSocket.send({ action: 'test' });
      await new Promise(r => setTimeout(r, 10));
      const ws = MockWebSocket.lastInstance!;
      const requestId = ws.sentMessages[0].requestId;

      ws.onmessage!({ data: JSON.stringify({ requestId, error: 'bad request', message: 'invalid' }) });

      await expect(sendPromise).rejects.toThrow('bad request: invalid');
    });

    it('rejects on job failed result', async () => {
      const sendPromise = imbueWebSocket.send({ action: 'test' });
      await new Promise(r => setTimeout(r, 10));
      const ws = MockWebSocket.lastInstance!;
      const requestId = ws.sentMessages[0].requestId;

      ws.onmessage!({ data: JSON.stringify({ requestId, jobId: 'job-1' }) });
      ws.onmessage!({ data: JSON.stringify({ jobId: 'job-1', type: 'jobFailed', error: 'GPU error' }) });

      await expect(sendPromise).rejects.toThrow('GPU error');
    });
  });

  describe('timeout handling', () => {
    it('cleans up unacked request on timeout', async () => {
      // Use a very short real timeout
      const sendPromise = imbueWebSocket.send({ action: 'test' }, { timeout: 50 });
      await new Promise(r => setTimeout(r, 10));

      expect(imbueWebSocket.unackedRequests.size).toBe(1);

      await expect(sendPromise).rejects.toThrow('timed out');
      expect(imbueWebSocket.unackedRequests.size).toBe(0);
    });

    it('cleans up pending request on timeout (already acked)', async () => {
      const sendPromise = imbueWebSocket.send({ action: 'test' }, { timeout: 100 });
      await new Promise(r => setTimeout(r, 10));

      const ws = MockWebSocket.lastInstance!;
      const requestId = ws.sentMessages[0].requestId;

      // Ack arrives — moves to pendingRequests
      ws.onmessage!({ data: JSON.stringify({ requestId, jobId: 'job-1' }) });
      expect(imbueWebSocket.unackedRequests.size).toBe(0);
      expect(imbueWebSocket.pendingRequests.size).toBe(1);

      // Wait for timeout
      await expect(sendPromise).rejects.toThrow('timed out');
      expect(imbueWebSocket.pendingRequests.size).toBe(0);
    });
  });

  describe('connection lifecycle', () => {
    it('rejects all pending requests on connection close', async () => {
      const send1 = imbueWebSocket.send({ action: 'first' });
      const send2 = imbueWebSocket.send({ action: 'second' });
      await new Promise(r => setTimeout(r, 10));
      const ws = MockWebSocket.lastInstance!;

      // Simulate unexpected close
      ws.readyState = 3;
      imbueWebSocket.ws = null;
      ws.onclose!({ code: 1006, wasClean: false });

      await expect(send1).rejects.toThrow('WebSocket closed');
      await expect(send2).rejects.toThrow('WebSocket closed');
      expect(imbueWebSocket.ws).toBeNull();
    });

    it('reconnects after disconnect', async () => {
      await imbueWebSocket.ensureConnected();
      const first = MockWebSocket.lastInstance;

      // Manually reset state (simulate disconnect)
      imbueWebSocket.ws = null;
      imbueWebSocket.connectPromise = null;

      await imbueWebSocket.ensureConnected();
      const second = MockWebSocket.lastInstance;
      expect(second).not.toBe(first);
      expect(MockWebSocket.instances.length).toBe(2);
    });
  });

  describe('sendFireAndForget', () => {
    it('sends message without waiting for response', async () => {
      await imbueWebSocket.sendFireAndForget({ action: 'feedback', data: 'test' });
      const ws = MockWebSocket.lastInstance!;
      expect(ws.sentMessages.length).toBe(1);
      expect(ws.sentMessages[0].action).toBe('feedback');
      expect(imbueWebSocket.unackedRequests.size).toBe(0);
      expect(imbueWebSocket.pendingRequests.size).toBe(0);
    });
  });

  describe('malformed messages', () => {
    it('handles malformed JSON without crashing', async () => {
      await imbueWebSocket.ensureConnected();
      const ws = MockWebSocket.lastInstance!;
      // Should not throw
      ws.onmessage!({ data: 'not valid json{{{' });
      expect(imbueWebSocket.ws).not.toBeNull();
    });
  });
});
