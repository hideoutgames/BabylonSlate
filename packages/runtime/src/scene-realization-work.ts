/** Steps between forced yields; the time budget normally yields sooner. */
const SCENE_REALIZATION_STEPS_PER_YIELD = 256;
/** Milliseconds of work between yields. */
const SCENE_REALIZATION_BUDGET_MS = 8;

export interface CooperativeSceneLoadingOptions {
  /** Host scheduler override; production yields a task between bounded chunks. */
  yieldControl?: (signal: AbortSignal) => Promise<void>;
  /**
   * Upper bound on steps between yields. It exists for tests that observe partial
   * realization and for tuning; production callers use the default
   * (`SCENE_REALIZATION_STEPS_PER_YIELD`).
   */
  stepsPerYield?: number;
}

export function sceneRealizationCancelled(): Error {
  const error = new Error("Scene realization was cancelled.");
  error.name = "AbortError";
  return error;
}

function yieldTask(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, 0);
    signal.addEventListener("abort", abort, { once: true });
  });
}

/** Reject promptly on cancellation even if an external loader ignores the signal. */
export function waitForSceneWork<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (!signal.aborted) signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener("abort", abort); resolve(value); },
      (error: unknown) => { signal.removeEventListener("abort", abort); reject(error); },
    );
    if (signal.aborted) reject(signal.reason);
  });
}

/**
 * Actor operations stay indivisible. The time budget forces a yield; the step
 * bound only caps a run of steps too cheap to reach it, since every yield costs a
 * task turn (at least 4 ms once timers nest).
 */
export async function runSceneRealizationWork(
  steps: Generator<void, void, unknown>,
  signal: AbortSignal,
  options: CooperativeSceneLoadingOptions,
): Promise<void> {
  const stepsPerYield = options.stepsPerYield ?? SCENE_REALIZATION_STEPS_PER_YIELD;
  let started = performance.now();
  let count = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      if (steps.next().done) return;
      if (++count >= stepsPerYield || performance.now() - started >= SCENE_REALIZATION_BUDGET_MS) {
        await waitForSceneWork((options.yieldControl ?? yieldTask)(signal), signal);
        signal.throwIfAborted();
        count = 0;
        started = performance.now();
      }
    }
  } finally {
    steps.return();
  }
}
