import type { AbstractEngine } from "@babylonjs/core";
import type { SceneLoadProgress } from "@babylonslate/render";

/**
 * Preview Build and exported players own no loading chrome: authored Scene
 * Layers present loading through Game Instance events. The host only mirrors
 * the transaction onto the player root so tests and embedders can observe it.
 */
export function publishPlayerSceneLoading(
  root: HTMLElement,
  state: SceneLoadProgress | null,
): void {
  if (state) {
    root.dataset.sceneLoading = "true";
    root.dataset.sceneLoadPhase = state.phase;
    root.dataset.sceneLoadProgress = String(Math.round(state.progress));
    root.dataset.sceneLoadId = String(state.sceneLoadId);
    return;
  }
  root.dataset.sceneLoading = "false";
}

/**
 * Cross one engine end-frame so an authored loading layer can present before
 * the painted acknowledgement. When the loop is not producing end-frames
 * (paused or stopped), two animation frames still cross a browser paint.
 */
export function waitForPlayerLoadingPaint(
  engine: AbstractEngine,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    let settled = false;
    let raf = 0;
    let remaining = 2;
    const observer = engine.onEndFrameObservable.add(finish);
    const step = () => {
      if (--remaining <= 0) finish();
      else raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    function finish() {
      if (settled) return;
      settled = true;
      cancelAnimationFrame(raf);
      signal.removeEventListener("abort", cancel);
      engine.onEndFrameObservable.remove(observer);
      resolve();
    }
    function cancel() {
      if (settled) return;
      settled = true;
      cancelAnimationFrame(raf);
      engine.onEndFrameObservable.remove(observer);
      reject(signal.reason);
    }
    signal.addEventListener("abort", cancel, { once: true });
  });
}
