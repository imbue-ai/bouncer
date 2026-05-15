// Multi-detector orchestration.
//
// Each detector is an independent async path that produces a hide/keep verdict.
// Detectors are ordered by priority — index 0 is highest priority. Adding a new
// path is one push() at the call site; this file doesn't change.
//
// Decision rules (evaluated in this order, but rule 1 can fire at any moment
// during the race — including after higher-priority detectors have already
// returned shouldHide=false):
//   1. As soon as ANY detector resolves with shouldHide=true, the race ends
//      with that hide result. Priority is irrelevant for hide signals — a
//      lower-priority hide overrides a higher-priority no-hide. Other
//      detectors keep running but their results are dropped.
//   2. If every detector settles without any of them saying hide, return the
//      highest-priority detector's result. If that one rejected, throw its
//      error so the pipeline's existing error handling (rate-limit, auth)
//      still fires.
//   3. Lower-priority rejections are logged and ignored.
//
// To avoid one slow detector blocking the whole evaluation, each detector can
// declare a soft timeoutMs. A timed-out detector is treated as a rejection
// for that detector only — other detectors keep running and can still resolve
// the race normally.

/** Per-post verdict produced by a detector. */
export interface DetectorResult {
  shouldHide: boolean;
  reasoning: string;
  category?: string | null;
  rawResponse?: string | null;
  inferenceTime?: number;
}

export interface Detector {
  /** Short stable identifier used in logs (e.g. "filter", "aiText"). */
  name: string;
  /** Already-started detector promise. The caller is responsible for kicking
   *  off the request so all detectors run in parallel from the moment they're
   *  added to the array. */
  promise: Promise<DetectorResult>;
  /** Optional soft timeout for this detector. If the promise hasn't settled
   *  by then, it's treated as rejected for race purposes (other detectors
   *  keep running, just this one stops counting). Defaults to no timeout. */
  timeoutMs?: number;
}

export interface RunDetectorsOptions {
  /** Fires whenever any detector settles (success or rejection). Useful for
   *  incremental UI updates — e.g. a popup that shows the highest-priority
   *  reasoning received so far. */
  onResponse?: (name: string, result: DetectorResult | null, error: Error | null) => void;
}

/** Wrap a promise with a soft timeout. The wrapped promise rejects with a
 *  named timeout error if the original hasn't settled by then. The original
 *  promise is left running — we just stop awaiting it. */
function withTimeout<T>(name: string, p: Promise<T>, timeoutMs: number | undefined): Promise<T> {
  if (timeoutMs === undefined || timeoutMs <= 0) return p;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`${name} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    p.then(v => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    }, e => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(e instanceof Error ? e : new Error(String(e)));
    });
  });
}

export async function runDetectors(
  detectors: Detector[],
  options: RunDetectorsOptions = {},
): Promise<DetectorResult> {
  if (detectors.length === 0) {
    throw new Error('runDetectors: no detectors provided');
  }

  type Slot = { name: string; value?: DetectorResult; error?: Error; done: boolean };
  const slots: Slot[] = detectors.map(d => ({ name: d.name, done: false }));

  return new Promise<DetectorResult>((resolve, reject) => {
    let settled = false;

    // Rule 2: only fires once every detector has settled without anyone
    // signalling hide. Rule 1 (any hide → resolve immediately) is checked
    // inline in each .then handler below, so it can preempt this at any time.
    const finalize = () => {
      if (settled || slots.some(s => !s.done)) return;
      settled = true;
      const top = slots[0];
      if (top.error) {
        reject(top.error);
        return;
      }
      resolve(top.value!);
    };

    detectors.forEach((det, i) => {
      const p = withTimeout(det.name, det.promise, det.timeoutMs);
      p.then(value => {
        slots[i].value = value;
        slots[i].done = true;
        options.onResponse?.(det.name, value, null);
        // Rule 1: any hide ends the race regardless of priority. A lower-
        // priority detector saying hide here overrides a higher-priority
        // detector's earlier no-hide.
        if (!settled && value.shouldHide) {
          settled = true;
          resolve(value);
          return;
        }
        finalize();
      }, err => {
        const e = err instanceof Error ? err : new Error(String(err));
        slots[i].error = e;
        slots[i].done = true;
        options.onResponse?.(det.name, null, e);
        finalize();
      });
    });
  });
}
