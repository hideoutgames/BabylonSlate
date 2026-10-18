import type { Scene } from "@babylonjs/core";

/**
 * Auxiliary views (Full Quality Render Target Captures) draw inside the scene
 * view's FrameGraph, after Babylon's per-frame evaluation (world matrices,
 * skeletons, particle steps) and the view's shadow maps, and before its
 * clustered light mask, which every view redraws for its camera.
 * One drawer per Scene: the latest registration wins.
 */
const drawers = new WeakMap<Scene, () => void>();

/** Returns the release; it clears only its own registration. */
export function registerSceneAuxiliaryViews(scene: Scene, draw: () => void): () => void {
  drawers.set(scene, draw);
  return () => { if (drawers.get(scene) === draw) drawers.delete(scene); };
}

/** Called by the scene view's graph at that point of its frame. */
export function drawSceneAuxiliaryViews(scene: Scene): void {
  drawers.get(scene)?.();
}
