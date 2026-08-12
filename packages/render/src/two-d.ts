import { Matrix, Vector3, Viewport, type Scene } from "@babylonjs/core";

export interface CanvasPoint {
  x: number;
  y: number;
}

export interface CanvasRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Project a world point to canvas pixels through the active camera.
 *
 * This is the function the 2D handedness golden pins: Babylon stays
 * left-handed and the 2D camera sits at negative Z looking toward +Z, so a
 * point at world +X must land to the *right* of the origin on screen. Getting
 * the camera on the other side silently mirrors every 2D scene.
 */
export function projectToCanvas(
  scene: Scene,
  point: Vector3,
  width: number,
  height: number,
): CanvasPoint | null {
  const camera = scene.activeCamera;
  if (!camera || width <= 0 || height <= 0) return null;
  const projected = Vector3.Project(
    point,
    Matrix.Identity(),
    scene.getTransformMatrix(),
    new Viewport(0, 0, width, height),
  );
  return { x: projected.x, y: projected.y };
}

export function rectContains(rect: CanvasRect, point: CanvasPoint): boolean {
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.width &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.height
  );
}

/**
 * Names of pickable meshes whose origin projects inside a canvas rectangle;
 * this is the marquee selection 2D mode uses for a one-finger drag.
 */
export function meshNamesInCanvasRect(
  scene: Scene,
  rect: CanvasRect,
  width: number,
  height: number,
): string[] {
  scene.updateTransformMatrix();
  const hits: string[] = [];
  for (const mesh of scene.meshes) {
    if (!mesh.isPickable || !mesh.isVisible) continue;
    // A marquee can run before the next render, so the world matrix a freshly
    // moved or freshly created mesh carries is still stale.
    mesh.computeWorldMatrix(true);
    const point = projectToCanvas(scene, mesh.getAbsolutePosition(), width, height);
    if (point && rectContains(rect, point)) {
      hits.push(mesh.name);
    }
  }
  return hits;
}

/** Snap a world coordinate to the nearest multiple of `step`. */
export function snapToGrid(value: number, step: number): number {
  if (step <= 0) return value;
  return Math.round(value / step) * step;
}
