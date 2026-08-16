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
  let generation = 0;
  return {
    schedule(work: () => void): void {
      if (handle) return;
      const token = ++generation;
      handle = clock.now(() => {
        handle = 0;
        if (token !== generation) return;
        work();
      });
    },
    cancel(): void {
      if (!handle) return;
      clock.cancel(handle);
      handle = 0;
      generation += 1;
    },
  };
}
