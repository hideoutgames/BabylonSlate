export type PlayPauseTarget = {
  pause: () => void;
  resume: () => void;
};

/**
 * Hold Pause / Resume until `boot.play` finishes. `play()` always ends in
 * `start()` + `resume()`, which would otherwise undo a Pause On Play
 * `setPaused(true)` that arrived while scripts/physics were still loading.
 */
export function createPlayPauseGate(target: PlayPauseTarget) {
  let booting = false;
  let pauseWhenReady = false;

  return {
    beginPlay(play: () => Promise<void>): Promise<void> {
      booting = true;
      return play().then(
        () => {
          booting = false;
          if (pauseWhenReady) target.pause();
          pauseWhenReady = false;
        },
        (error: unknown) => {
          booting = false;
          throw error;
        },
      );
    },
    setPaused(paused: boolean) {
      if (booting) {
        pauseWhenReady = paused;
        return;
      }
      if (paused) target.pause();
      else target.resume();
    },
  };
}
