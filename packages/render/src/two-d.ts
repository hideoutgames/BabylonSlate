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
 * used by 2D hold-marquee and by Drag Select in both viewport modes.
 * Hidden volumetric pick colliders (`visibility === 0`) are skipped so
 * origin-root helpers are not listed twice (icon + collider).
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
    if (!mesh.isPickable || !mesh.isVisible || mesh.visibility === 0) continue;
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

export interface OrthoFrustum {
  orthoLeft: number | null;
  orthoRight: number | null;
  orthoTop: number | null;
  orthoBottom: number | null;
}

/**
 * World pan for a canvas-pixel drag so the point under the pointer stays put.
 * Uses CSS canvas size (same space as pointer `clientX`/`clientY`), not the
 * hardware-scaled render buffer.
 */
export function orthoPanFromCanvasDelta(
  dxPx: number,
  dyPx: number,
  frustum: OrthoFrustum,
  canvas: { width: number; height: number },
): { deltaX: number; deltaY: number } {
  const { orthoLeft, orthoRight, orthoTop, orthoBottom } = frustum;
  if (
    canvas.width <= 0 ||
    canvas.height <= 0 ||
    orthoLeft == null ||
    orthoRight == null ||
    orthoTop == null ||
    orthoBottom == null
  ) {
    return { deltaX: 0, deltaY: 0 };
  }
  const worldWidth = orthoRight - orthoLeft;
  const worldHeight = orthoTop - orthoBottom;
  return {
    deltaX: -dxPx * (worldWidth / canvas.width),
    deltaY: dyPx * (worldHeight / canvas.height),
  };
}

/** Snap a world coordinate to the nearest multiple of `step`. */
export function snapToGrid(value: number, step: number): number {
  if (step <= 0) return value;
  return Math.round(value / step) * step;
}
