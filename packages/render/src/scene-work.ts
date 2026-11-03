/** Steps between forced yields; the time budget normally yields sooner. */
const SCENE_WORK_STEPS_PER_YIELD = 256;
/** Milliseconds of work between yields. */
const SCENE_WORK_BUDGET_MS = 8;

export interface SceneWorkOptions {
  signal: AbortSignal;
  onProgress?: (progress: number) => void;
  /** Hosts may provide a different cooperative scheduler. */
  yieldControl?: (signal: AbortSignal) => Promise<void>;
  /**
   * Upper bound on steps between yields. It exists for tests that observe partial
   * realization and for tuning; production callers use the default
   * (`SCENE_WORK_STEPS_PER_YIELD`).
   */
  stepsPerYield?: number;
}

/**
 * A task turn through a message port: unlike `setTimeout(0)`, which browsers clamp to 4 ms once timers nest (and
 * these always do), it costs only the turn itself, while the page still paints and handles input between turns.
 */
let channel: MessageChannel | null | undefined;
const waiting: Array<() => void> = [];

function nextTask(): Promise<void> | null {
  if (channel === undefined) {
    channel = typeof MessageChannel === "function" ? new MessageChannel() : null;
    if (channel) {
      channel.port1.onmessage = () => waiting.shift()?.();
      // Node test runs: an open port must not keep the process alive.
      (channel.port1 as { unref?: () => void }).unref?.();
      (channel.port2 as { unref?: () => void }).unref?.();
    }
  }
  if (!channel) return null;
  const port = channel.port2;
  return new Promise((resolve) => {
    waiting.push(resolve);
    port.postMessage(0);
  });
}

function yieldSceneWork(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const abort = () => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      reject(signal.reason);
    };
    const done = () => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      resolve();
    };
    signal.addEventListener("abort", abort, { once: true });
    const turn = nextTask();
    if (turn) void turn.then(done);
    else timer = setTimeout(done, 0);
  });
}

/**
 * Yield between indivisible actor operations. The time budget keeps the editor
 * responsive; the step bound only caps a run of steps too cheap to reach it, since
 * every yield costs a task turn. Progress is reported once per run, before its
 * yield, and at the end: each report re-renders the loading dialog.
 */
export async function runSceneWork(
  steps: Generator<number, void, unknown>,
  options: SceneWorkOptions,
): Promise<void> {
  const yieldControl = options.yieldControl ?? yieldSceneWork;
  const stepsPerYield = options.stepsPerYield ?? SCENE_WORK_STEPS_PER_YIELD;
  let start = performance.now();
  let count = 0;
  let progress: number | null = null;
  const report = () => {
    if (progress === null) return;
    options.onProgress?.(progress);
    progress = null;
  };
  try {
    while (true) {
      options.signal.throwIfAborted();
      const step = steps.next();
      if (step.done === true) {
        report();
        return;
      }
      progress = step.value;
      if (++count >= stepsPerYield || performance.now() - start >= SCENE_WORK_BUDGET_MS) {
        report();
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
