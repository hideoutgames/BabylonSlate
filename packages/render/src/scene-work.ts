/** Steps between forced yields; the time budget normally yields sooner. */
const SCENE_WORK_STEPS_PER_YIELD = 256;
/** Milliseconds of work between yields. */
const SCENE_WORK_BUDGET_MS = 8;

export interface SceneWorkOptions {
  signal: AbortSignal;
  onProgress?: (progress: number) => void;
  /** Hosts may provide a different cooperative scheduler. */
  yieldControl?: (signal: AbortSignal) => Promise<void>;
  /** Upper bound on steps between yields (default `SCENE_WORK_STEPS_PER_YIELD`). */
  stepsPerYield?: number;
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

/**
 * Yield between indivisible actor operations. The time budget keeps the editor
 * responsive; the step bound only caps a run of steps too cheap to reach it, since
 * every yield costs a task turn (at least 4 ms once timers nest).
 */
export async function runSceneWork(
  steps: Generator<number, void, unknown>,
  options: SceneWorkOptions,
): Promise<void> {
  const yieldControl = options.yieldControl ?? yieldSceneWork;
  const stepsPerYield = options.stepsPerYield ?? SCENE_WORK_STEPS_PER_YIELD;
  let start = performance.now();
  let count = 0;
  try {
    while (true) {
      options.signal.throwIfAborted();
      const step = steps.next();
      if (step.done === true) return;
      options.onProgress?.(step.value);
      if (++count >= stepsPerYield || performance.now() - start >= SCENE_WORK_BUDGET_MS) {
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
