/**
 * Combine console intent with temporary app lifecycle suspension and the view's
 * hold for compiling render pipelines. Each setter returns whether the game
 * runtime is paused; `viewPaused` is whether the view stops drawing, which a
 * rendering hold never asks for (the view must keep drawing to end it).
 */
export function createPlayerPauseState() {
  let consolePaused = false;
  let lifecyclePaused = false;
  let renderingPaused = false;
  const runtimePaused = () => consolePaused || lifecyclePaused || renderingPaused;
  return {
    setConsolePaused(paused: boolean): boolean {
      consolePaused = paused;
      return runtimePaused();
    },
    setLifecyclePaused(paused: boolean): boolean {
      lifecyclePaused = paused;
      return runtimePaused();
    },
    setRenderingPaused(paused: boolean): boolean {
      renderingPaused = paused;
      return runtimePaused();
    },
    viewPaused(): boolean {
      return consolePaused || lifecyclePaused;
    },
  };
}
