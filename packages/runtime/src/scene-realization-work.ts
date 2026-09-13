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
        await (options.yieldControl ?? yieldTask)(signal);
        signal.throwIfAborted();
        count = 0;
        started = performance.now();
      }
    }
  } finally {
    steps.return();
  }
}
