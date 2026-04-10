// Serial priority queue for inference tasks.
// Ensures only one inference runs at a time against the WebLLM engine.
// Exported as a class so tests can create isolated instances.

interface QueueTask<T = unknown> {
  fn: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
  priority: number;
}

export class InferenceQueue {
  private _pending: QueueTask[];
  private _processing: boolean;
  private _drainPromise: Promise<unknown> | null;

  constructor() {
    this._pending = [];
    this._processing = false;
    this._drainPromise = null;
  }

  // Queue an async function to run serially. Higher priority values run first
  // among pending tasks. Returns a promise that resolves with the function's result.
  enqueue<T>(fn: () => Promise<T>, { priority = 0 } = {}): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const task: QueueTask<T> = { fn, resolve, reject, priority };
      const idx = this._pending.findIndex(t => t.priority < priority);
      if (idx === -1) {
        this._pending.push(task as QueueTask);
      } else {
        this._pending.splice(idx, 0, task as QueueTask);
      }
      void this._process();
    });
  }

  // Clear all pending (not currently executing) tasks.
  // The in-flight task (already shifted out) is unaffected.
  clear(): void {
    while (this._pending.length > 0) {
      const task = this._pending.shift()!;
      task.reject(new Error('Inference queue cleared'));
    }
  }

  // Wait for any in-flight task to finish, then run `fn`.
  // Pending tasks are cleared first so only the in-flight task must complete.
  // Used to safely dispose the engine without racing with active inference.
  // Serialized: concurrent drain calls chain instead of racing.
  drain<T>(fn: () => Promise<T>): Promise<T> {
    if (this._drainPromise) {
      // Chain after in-progress drain to prevent clear() from rejecting it
      this._drainPromise = this._drainPromise
        .catch(() => {}) // Don't let previous drain errors block the chain
        .then(() => this._executeDrain(fn));
    } else {
      this._drainPromise = this._executeDrain(fn);
    }
    const current = this._drainPromise;
    return (current as Promise<T>).finally(() => {
      if (this._drainPromise === current) {
        this._drainPromise = null;
      }
    });
  }

  private _executeDrain<T>(fn: () => Promise<T>): Promise<T> {
    this.clear();
    return this.enqueue(fn, { priority: Infinity });
  }

  // Reset the queue to its initial empty state.
  // Rejects all pending tasks and clears internal state.
  reset(): void {
    this.clear();
    this._processing = false;
    this._drainPromise = null;
  }

  private async _process(): Promise<void> {
    if (this._processing) return;
    this._processing = true;
    while (this._pending.length > 0) {
      const task = this._pending.shift()!;
      try {
        task.resolve(await task.fn());
      } catch (err) {
        task.reject(err);
      }
    }
    this._processing = false;
  }
}

// Singleton instance used by the production background script
export const inferenceQueue: InferenceQueue = new InferenceQueue();
