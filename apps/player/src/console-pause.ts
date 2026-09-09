/** Combine console intent with temporary app lifecycle suspension. */
export function createPlayerPauseState() {
  let consolePaused = false;
  let lifecyclePaused = false;
  return {
    setConsolePaused(paused: boolean): boolean {
      consolePaused = paused;
      return consolePaused || lifecyclePaused;
    },
    setLifecyclePaused(paused: boolean): boolean {
      lifecyclePaused = paused;
      return consolePaused || lifecyclePaused;
    },
  };
}
