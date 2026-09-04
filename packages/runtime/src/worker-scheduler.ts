const FALLBACK_FRAME_MS = 1000 / 60;

export interface WorkerSchedulerHost {
  performance: Pick<Performance, "now">;
  requestAnimationFrame?: (callback: FrameRequestCallback) => number;
  cancelAnimationFrame?: (handle: number) => void;
  setTimeout(callback: () => void, delay: number): number;
  clearTimeout(handle: number): void;
}

export interface WorkerScheduler {
  start(): void;
  stop(): void;
}

/** Schedules a worker loop using its best available monotonic frame clock. */
export function createWorkerScheduler(
  host: WorkerSchedulerHost,
  advance: (elapsedSeconds: number) => void,
): WorkerScheduler {
  const useAnimationFrame =
    typeof host.requestAnimationFrame === "function" &&
    typeof host.cancelAnimationFrame === "function";
  let running = false;
  let handle: number | null = null;
  let lastTick: number | null = null;

  const schedule = (): void => {
    if (!running) return;
    handle = useAnimationFrame
      ? host.requestAnimationFrame!(tick)
      : host.setTimeout(() => tick(host.performance.now()), FALLBACK_FRAME_MS);
  };

  const tick = (now: number): void => {
    if (!running) return;
    handle = null;
    const elapsed = lastTick === null ? 0 : (now - lastTick) / 1000;
    lastTick = now;
    advance(elapsed);
    schedule();
  };

  return {
    start() {
      if (running) return;
      running = true;
      lastTick = null;
      schedule();
    },
    stop() {
      if (!running) return;
      running = false;
      lastTick = null;
      if (handle === null) return;
      if (useAnimationFrame) host.cancelAnimationFrame!(handle);
      else host.clearTimeout(handle);
      handle = null;
    },
  };
}
