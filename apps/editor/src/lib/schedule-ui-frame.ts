export interface UiFrameClock {
  now: (callback: FrameRequestCallback) => number;
  cancel: (handle: number) => void;
}

function defaultClock(): UiFrameClock {
  return {
    now: (callback) => requestAnimationFrame(callback),
    cancel: (handle) => cancelAnimationFrame(handle),
  };
}

/** Coalesce resize/present work onto the next animation frame. */
export function createUiFrameScheduler(clock: UiFrameClock = defaultClock()) {
  let handle = 0;
  let scheduled = false;
  let generation = 0;
  let pending: (() => void) | undefined;
  return {
    schedule(work: () => void): void {
      pending = work;
      if (scheduled) return;
      scheduled = true;
      const token = ++generation;
      handle = clock.now(() => {
        scheduled = false;
        handle = 0;
        if (token !== generation) return;
        const run = pending;
        pending = undefined;
        run?.();
      });
    },
    cancel(): void {
      if (!scheduled) return;
      clock.cancel(handle);
      scheduled = false;
      handle = 0;
      pending = undefined;
      generation += 1;
    },
  };
}
