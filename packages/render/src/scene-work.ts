export interface SceneWorkOptions {
  signal: AbortSignal;
  onProgress?: (progress: number) => void;
  /** Hosts may provide a different cooperative scheduler. */
  yieldControl?: (signal: AbortSignal) => Promise<void>;
}

function yieldSceneWork(signal: AbortSignal): Promise<void> {
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

/** Yield between indivisible actor operations, with both time and item bounds. */
export async function runSceneWork(
  steps: Generator<number, void, unknown>,
  options: SceneWorkOptions,
): Promise<void> {
  const yieldControl = options.yieldControl ?? yieldSceneWork;
  let start = performance.now();
  let count = 0;
  try {
    while (true) {
      options.signal.throwIfAborted();
      const step = steps.next();
      if (step.done) return;
      options.onProgress?.(step.value);
      if (++count >= 32 || performance.now() - start >= 8) {
        await yieldControl(options.signal);
        options.signal.throwIfAborted();
        start = performance.now();
        count = 0;
      }
    }
  } finally {
    steps.return();
  }
}
