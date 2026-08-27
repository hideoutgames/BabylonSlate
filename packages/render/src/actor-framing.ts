import type { AbstractMesh } from "@babylonjs/core";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import {
  DEFAULT_CAMERA_RADIUS,
  MAX_CAMERA_RADIUS,
  MIN_CAMERA_RADIUS,
} from "./editor-camera";
import { visualHierarchyBoundingVectors } from "./visual-meshes";

/** Extra orbit radius as a multiple of the visual AABB diagonal. */
export const ACTOR_FRAMING_RADIUS_PADDING = 1.5;

/** World-space center of drawn parts (not only the actor origin). */
export function actorFramingTarget(root: AbstractMesh): Vector3 {
  const { min, max } = visualHierarchyBoundingVectors(root);
  return min.add(max).scale(0.5);
}

/**
 * One-shot 3D viewing distance: default pull-back for helpers, bounds padding
 * so large meshes do not swallow the eye, and a floor above the near plane.
 */
export function actorFramingRadius(
  root: AbstractMesh,
  options?: { minZ?: number; defaultRadius?: number },
): number {
  const { min, max } = visualHierarchyBoundingVectors(root);
  const diagonal = Vector3.Distance(min, max);
  const minZ = options?.minZ ?? 1;
  const defaultRadius = options?.defaultRadius ?? DEFAULT_CAMERA_RADIUS;
  const desired = Math.max(
    defaultRadius,
    diagonal * ACTOR_FRAMING_RADIUS_PADDING,
    minZ * 2,
    MIN_CAMERA_RADIUS,
  );
  return Math.min(MAX_CAMERA_RADIUS, desired);
}
