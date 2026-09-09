/** Combine console intent with temporary app lifecycle suspension. */
export function createPlayerPauseState() {
  return {
    setConsolePaused(paused: boolean): boolean {
      return paused;
    },
    setLifecyclePaused(paused: boolean): boolean {
      return paused;
    },
  };
}
