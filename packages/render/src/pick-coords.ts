import type { Scene } from "@babylonjs/core";

export type PointerCanvasSize = {
  width: number;
  height: number;
};

/**
 * CSS-pixel size Babylon `scene.pick` expects: Engine drawing buffer ×
 * hardware scaling (CreatePickingRayToRef multiplies by 1/level).
 */
export function pickBufferSize(scene: Scene): PointerCanvasSize {
  const engine = scene.getEngine();
  const scale = engine.getHardwareScalingLevel() || 1;
  return {
    width: Math.max(1, engine.getRenderWidth() * scale),
    height: Math.max(1, engine.getRenderHeight() * scale),
  };
}

/** Map a point on a canvas into Engine pick pixels. */
export function mapCanvasToPick(
  canvasX: number,
  canvasY: number,
  canvas: PointerCanvasSize,
  pick: PointerCanvasSize,
): { x: number; y: number } {
  const width = canvas.width > 0 ? canvas.width : 1;
  const height = canvas.height > 0 ? canvas.height : 1;
  return {
    x: canvasX * (pick.width / width),
    y: canvasY * (pick.height / height),
  };
}

/** Identity when `canvas` is omitted or empty. */
export function mapCanvasPointer(
  scene: Scene,
  canvasX: number,
  canvasY: number,
  canvas?: PointerCanvasSize,
): { x: number; y: number } {
  if (!canvas || canvas.width <= 0 || canvas.height <= 0) {
    return { x: canvasX, y: canvasY };
  }
  return mapCanvasToPick(canvasX, canvasY, canvas, pickBufferSize(scene));
}
