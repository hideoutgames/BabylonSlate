/**
 * Combine console intent with temporary app lifecycle suspension. Each setter
 * returns whether the game runtime is paused by either; `viewPaused` is whether
 * the view stops drawing. The view's hold for GPU work is not part of either: it
 * pauses game time only, under its own runtime reason, and the view keeps
 * drawing to end it.
 */
export function createPlayerPauseState() {
  let consolePaused = false;
  let lifecyclePaused = false;
  const runtimePaused = () => consolePaused || lifecyclePaused;
  return {
    setConsolePaused(paused: boolean): boolean {
      consolePaused = paused;
      return runtimePaused();
    },
    setLifecyclePaused(paused: boolean): boolean {
      lifecyclePaused = paused;
      return runtimePaused();
    },
    viewPaused(): boolean {
      return runtimePaused();
    },
  };
}
