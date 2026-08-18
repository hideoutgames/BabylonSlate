import { Matrix, Vector3, type ArcRotateCamera } from "@babylonjs/core";
import type { ViewportMode } from "@babylonslate/core";

/** Closest a new actor may sit along the view ray, in world units. */
export const EDITOR_PLACE_MIN_DISTANCE = 4;

export type PlaceCanvas = {
  width: number;
  height: number;
};

function asTuple(point: Vector3): [number, number, number] {
  return [point.x, point.y, point.z];
}

function placeDepth(radius: number): number {
  return Math.max(EDITOR_PLACE_MIN_DISTANCE, radius * 0.75);
}

function viewCenter3d(camera: ArcRotateCamera): Vector3 {
  camera.getViewMatrix();
  const origin = camera.position;
  const forward = camera.target.subtract(origin);
  const distance = forward.length();
  if (distance < 1e-8) {
    return origin.add(new Vector3(0, 0, placeDepth(camera.radius)));
  }
  forward.scaleInPlace(1 / distance);
  return origin.add(forward.scale(placeDepth(camera.radius)));
}

/**
 * World point in the middle of the editor view, a short distance in front of
 * the camera so Place Actors is neither in the lens nor at the camera origin.
 */
export function viewCenterWorldPosition(
  camera: ArcRotateCamera,
  mode: ViewportMode,
): [number, number, number] {
  camera.getViewMatrix();
  if (mode === "2d") {
    return [camera.target.x, camera.target.y, 0];
  }
  return asTuple(viewCenter3d(camera));
}

function unprojectCanvas(
  camera: ArcRotateCamera,
  canvasX: number,
  canvasY: number,
  canvas: PlaceCanvas,
  depth: number,
): Vector3 {
  return Vector3.Unproject(
    new Vector3(canvasX, canvasY, depth),
    canvas.width,
    canvas.height,
    Matrix.Identity(),
    camera.getViewMatrix(),
    camera.getProjectionMatrix(),
  );
}

function rayHitOnViewPlane(
  camera: ArcRotateCamera,
  canvasX: number,
  canvasY: number,
  canvas: PlaceCanvas,
): Vector3 {
  const planePoint = viewCenter3d(camera);
  const origin = camera.position;
  const normal = planePoint.subtract(origin);
  if (normal.lengthSquared() < 1e-8) {
    return planePoint;
  }
  normal.normalize();
  const near = unprojectCanvas(camera, canvasX, canvasY, canvas, 0);
  const far = unprojectCanvas(camera, canvasX, canvasY, canvas, 1);
  const dir = far.subtract(near);
  const denom = Vector3.Dot(dir, normal);
  if (Math.abs(denom) < 1e-8) {
    return planePoint;
  }
  const t = Vector3.Dot(planePoint.subtract(near), normal) / denom;
  return near.add(dir.scale(t));
}

/**
 * World point under a canvas pixel. 3D sits on the same view-facing plane as
 * {@link viewCenterWorldPosition}; 2D maps onto the XY plane at Z = 0.
 */
export function worldPositionFromCanvas(
  camera: ArcRotateCamera,
  canvasX: number,
  canvasY: number,
  canvas: PlaceCanvas,
  mode: ViewportMode,
): [number, number, number] {
  camera.getViewMatrix();
  if (mode === "2d") {
    const left = camera.orthoLeft ?? 0;
    const right = camera.orthoRight ?? 0;
    const top = camera.orthoTop ?? 0;
    const bottom = camera.orthoBottom ?? 0;
    const u = canvas.width > 0 ? canvasX / canvas.width : 0.5;
    const v = canvas.height > 0 ? canvasY / canvas.height : 0.5;
    return [
      camera.target.x + left + u * (right - left),
      camera.target.y + top + v * (bottom - top),
      0,
    ];
  }
  if (canvas.width <= 0 || canvas.height <= 0) {
    return viewCenterWorldPosition(camera, mode);
  }
  return asTuple(rayHitOnViewPlane(camera, canvasX, canvasY, canvas));
}
