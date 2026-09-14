export interface CooperativeSceneLoadingOptions {
  /** Host scheduler override; production yields a task between bounded chunks. */
  yieldControl?: (signal: AbortSignal) => Promise<void>;
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

/** Actor operations stay indivisible; both time and item bounds force a yield. */
export async function runSceneRealizationWork(
  steps: Generator<void, void, unknown>,
  signal: AbortSignal,
  options: CooperativeSceneLoadingOptions,
): Promise<void> {
  let started = performance.now();
  let count = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      if (steps.next().done) return;
      if (++count >= 32 || performance.now() - started >= 8) {
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
