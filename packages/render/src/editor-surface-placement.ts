import {
  LinesMesh,
  Matrix,
  Ray,
  Vector3,
  type AbstractMesh,
  type ArcRotateCamera,
  type Scene,
} from "@babylonjs/core";
import type { SerializedScene, ViewportMode } from "@haptic/core";
import { isColliderVisualTree } from "./collider-visual";
import type { EditorDropTransform } from "./editor-drop";
import { actorVisualBounds } from "./editor-drop";
import { viewCenterWorldPosition, worldPositionFromCanvas, type PlaceCanvas } from "./editor-place";
import { isEditorHelperMesh } from "./helper-mesh";
import { isSkyboxMesh } from "./skybox";

/** Where a placement trace put a new actor. */
export interface SurfacePlacement {
  position: [number, number, number];
  /** Normal of the surface it hit, facing the camera; null when nothing was within range. */
  normal: [number, number, number] | null;
}

/** A placed actor and the surface point it should rest against. */
export interface SurfaceRest {
  actorId: string;
  point: [number, number, number];
  normal: [number, number, number];
}

const tuple = (v: Vector3): [number, number, number] => [v.x, v.y, v.z];

/** Visible world geometry a placement may land on: no editor helpers, sky, lines or collider visuals. */
export function isPlacementSurface(mesh: AbstractMesh): boolean {
  return (
    mesh.isEnabled() &&
    mesh.isVisible &&
    mesh.visibility > 0 &&
    !(mesh instanceof LinesMesh) &&
    mesh.getTotalVertices() > 0 &&
    !mesh.infiniteDistance &&
    !isSkyboxMesh(mesh) &&
    !isEditorHelperMesh(mesh) &&
    !isColliderVisualTree(mesh)
  );
}

/**
 * Trace from `origin` along `direction` up to `maxDistance`: the first
 * surface hit, or the point at the end of the trace with no normal.
 */
export function traceSurfacePlacement(
  scene: Scene,
  origin: Vector3,
  direction: Vector3,
  maxDistance: number,
  isSurface: (mesh: AbstractMesh) => boolean = isPlacementSurface,
): SurfacePlacement {
  const forward = direction.normalizeToNew();
  const pick = scene.pickWithRay(new Ray(origin, forward, maxDistance), isSurface, false);
  if (pick?.hit && pick.pickedPoint && pick.distance <= maxDistance) {
    const normal = pick.getNormal(true, true) ?? forward.negate();
    // A back face (or a flipped normal) still places on the side facing the camera.
    if (Vector3.Dot(normal, forward) > 0) normal.negateInPlace();
    return { position: tuple(pick.pickedPoint), normal: tuple(normal.normalize()) };
  }
  return { position: tuple(origin.add(forward.scale(maxDistance))), normal: null };
}

function rayFromCanvas(
  camera: ArcRotateCamera,
  canvasX: number,
  canvasY: number,
  canvas: PlaceCanvas,
): { origin: Vector3; direction: Vector3 } {
  const view = camera.getViewMatrix();
  const projection = camera.getProjectionMatrix();
  const near = Vector3.Unproject(new Vector3(canvasX, canvasY, 0), canvas.width, canvas.height, Matrix.Identity(), view, projection);
  const far = Vector3.Unproject(new Vector3(canvasX, canvasY, 1), canvas.width, canvas.height, Matrix.Identity(), view, projection);
  return { origin: camera.position.clone(), direction: far.subtract(near) };
}

/**
 * Placement under a canvas point: in 3D a trace from the camera through the
 * point; 2D keeps the XY plane position.
 */
export function surfacePlacementFromCanvas(
  scene: Scene,
  camera: ArcRotateCamera,
  canvasX: number,
  canvasY: number,
  canvas: PlaceCanvas,
  mode: ViewportMode,
  maxDistance: number,
): SurfacePlacement {
  if (mode === "2d" || canvas.width <= 0 || canvas.height <= 0) {
    return { position: worldPositionFromCanvas(camera, canvasX, canvasY, canvas, mode), normal: null };
  }
  const { origin, direction } = rayFromCanvas(camera, canvasX, canvasY, canvas);
  return traceSurfacePlacement(scene, origin, direction, maxDistance);
}

/** Placement in the middle of the view: in 3D a trace along the camera's view direction. */
export function surfacePlacementAtViewCenter(
  scene: Scene,
  camera: ArcRotateCamera,
  mode: ViewportMode,
  maxDistance: number,
): SurfacePlacement {
  camera.getViewMatrix();
  const direction = camera.target.subtract(camera.position);
  if (mode === "2d" || direction.lengthSquared() < 1e-12) {
    return { position: viewCenterWorldPosition(camera, mode), normal: null };
  }
  return traceSurfacePlacement(scene, camera.position.clone(), direction, maxDistance);
}

/**
 * Moves each placed actor along its surface normal until its visual bounds
 * touch the surface plane through `point` from the front: a box placed by its
 * centre stops sinking into the floor, and a model whose origin is under its
 * feet is not lifted. Actors without visual bounds (lights, empties) stay.
 */
export function calculateSurfaceRestTransforms(options: {
  sceneData: SerializedScene;
  rests: readonly SurfaceRest[];
  meshForActor: (id: string) => AbstractMesh | null;
}): EditorDropTransform[] {
  const { sceneData, meshForActor } = options;
  const actors = new Map(sceneData.actors.map((actor) => [actor.id, actor]));
  const actorRoots = new Set(
    sceneData.actors.flatMap((actor) => {
      const root = meshForActor(actor.id);
      return root ? [root] : [];
    }),
  );
  const changes: EditorDropTransform[] = [];
  for (const rest of options.rests) {
    const actor = actors.get(rest.actorId);
    const root = meshForActor(rest.actorId);
    if (!actor || !root) continue;
    const bounds = actorVisualBounds(root, actorRoots);
    if (!bounds) continue;
    const point = Vector3.FromArray(rest.point);
    const normal = Vector3.FromArray(rest.normal).normalize();
    // How far the deepest corner sits behind the surface plane.
    let depth = Number.NEGATIVE_INFINITY;
    for (const x of [bounds.min.x, bounds.max.x]) {
      for (const y of [bounds.min.y, bounds.max.y]) {
        for (const z of [bounds.min.z, bounds.max.z]) {
          depth = Math.max(depth, Vector3.Dot(point.subtract(new Vector3(x, y, z)), normal));
        }
      }
    }
    if (!Number.isFinite(depth) || Math.abs(depth) < 1e-6) continue;
    let delta = normal.scale(depth);
    const parent = root.parent as AbstractMesh | null;
    if (parent && typeof (parent as { computeWorldMatrix?: unknown }).computeWorldMatrix === "function") {
      const parentWorld = parent.computeWorldMatrix(true);
      const determinant = parentWorld.determinant();
      if (!Number.isFinite(determinant) || determinant === 0) continue;
      delta = Vector3.TransformNormal(delta, Matrix.Invert(parentWorld));
    }
    const [x, y, z] = actor.transform.position;
    changes.push({
      actorId: actor.id,
      position: [x + delta.x, y + delta.y, z + delta.z],
      rotation: [...actor.transform.rotation],
      scale: [...actor.transform.scale],
    });
  }
  return changes;
}
