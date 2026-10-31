import type { Scene } from "@babylonjs/core";

const scales = new WeakMap<Scene, number>();

/**
 * The world's render size relative to its view's output, for a scene view that
 * draws into the backbuffer (1 by default). Play with Scene Layers sets it: the
 * backbuffer keeps the view's device pixels for the layers while the world
 * renders at its render scale, and the world graph's output pass fills the
 * backbuffer (`ForwardSceneFrameGraph`). A view with an output target ignores it.
 */
export function setSceneOutputScale(scene: Scene, scale: number): void {
  const next = Number.isFinite(scale) && scale > 0 ? Math.min(1, scale) : 1;
  if (next === 1) scales.delete(scene);
  else scales.set(scene, next);
}

export function sceneOutputScale(scene: Scene): number {
  return scales.get(scene) ?? 1;
}

/** `width` × `height` at `scale`, never below one pixel. */
export function scaledOutputSize(width: number, height: number, scale: number): { width: number; height: number } {
  return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)) };
}

/**
 * The size the world renders at for `camera`'s view: its output target's, or the
 * Engine's backbuffer at the Scene's output scale.
 */
export function sceneViewRenderSize(scene: Scene, target: { getRenderWidth(): number; getRenderHeight(): number } | null | undefined): { width: number; height: number } {
  if (target) return { width: target.getRenderWidth(), height: target.getRenderHeight() };
  const engine = scene.getEngine();
  return scaledOutputSize(engine.getRenderWidth(true), engine.getRenderHeight(true), sceneOutputScale(scene));
}
