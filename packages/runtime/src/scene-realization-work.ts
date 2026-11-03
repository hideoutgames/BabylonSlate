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

type TaskScheduler = (callback: () => void) => () => void;

let scheduler: TaskScheduler | null = null;

/**
 * Queue `callback` as a task and return its cancellation. A message-channel
 * task runs as soon as the queue reaches it: nested `setTimeout(0)` is clamped
 * to 4 ms, which a large Scene would spend a third of its realization waiting on.
 */
function scheduleTask(callback: () => void): () => void {
  scheduler ??= createTaskScheduler();
  return scheduler(callback);
}

function createTaskScheduler(): TaskScheduler {
  if (typeof MessageChannel !== "function") {
    return (callback) => {
      const timer = setTimeout(callback, 0);
      return () => clearTimeout(timer);
    };
  }
  const channel = new MessageChannel();
  const queued = new Map<number, () => void>();
  let next = 0;
  channel.port1.onmessage = (event: MessageEvent<number>) => {
    const callback = queued.get(event.data);
    queued.delete(event.data);
    callback?.();
  };
  // Node: an idle port must not keep the process alive.
  (channel.port1 as { unref?: () => void }).unref?.();
  return (callback) => {
    const id = ++next;
    queued.set(id, callback);
    channel.port2.postMessage(id);
    return () => { queued.delete(id); };
  };
}

function yieldTask(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => {
      cancel();
      reject(signal.reason);
    };
    const cancel = scheduleTask(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    });
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
 * task turn.
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
