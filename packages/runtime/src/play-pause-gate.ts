export type PlayPauseTarget = {
  pause: () => void;
  resume: () => void;
};

/** Apply explicit Pause as soon as cooperative Game Instance ticks can begin. */
export function createPlayPauseGate(target: PlayPauseTarget) {
  let booting = false;
  let started = false;
  let pauseWhenReady = false;
  let generation = 0;

  return {
    reset() {
      generation++;
      booting = false;
      started = false;
      pauseWhenReady = false;
    },
    beginPlay(play: (onStarted: () => void) => Promise<void>): Promise<void> {
      const current = ++generation;
      booting = true;
      started = false;
      return play(() => {
        if (current !== generation) return;
        started = true;
        if (pauseWhenReady) target.pause();
      }).then(
        () => {
          if (current !== generation) return;
          booting = false;
          if (!started && pauseWhenReady) target.pause();
          pauseWhenReady = false;
        },
        (error: unknown) => {
          if (current === generation) booting = false;
          throw error;
        },
      );
    },
    setPaused(paused: boolean) {
      if (booting) {
        pauseWhenReady = paused;
        if (!started) return;
      }
      if (paused) target.pause();
      else target.resume();
    },
  };
}
