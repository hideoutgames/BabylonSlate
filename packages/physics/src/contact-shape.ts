import type { ColliderDesc, ColliderShape } from "./types";

/** Local axis-aligned bounds `[minX, minY, minZ, maxX, maxY, maxZ]` of a point set. */
export type LocalBounds = readonly [number, number, number, number, number, number];

/**
 * Contacts within this distance (metres) of the nearest shape count as touching
 * it too; among those, the lowest collider ID wins so attribution is deterministic.
 */
export const CONTACT_SHAPE_TIE_TOLERANCE = 1e-3;

/** Bounds that convex hulls and triangle meshes resolve contact points against. */
export function localShapeBounds(shape: ColliderShape): LocalBounds | null {
  let points: ArrayLike<number>;
  if (shape.kind === "mesh") points = shape.positions;
  else if (shape.kind === "convex") points = shape.points.flatMap((p) => [p.x, p.y, p.z]);
  else return null;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i + 2 < points.length; i += 3) {
    const x = points[i]!, y = points[i + 1]!, z = points[i + 2]!;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  return minX <= maxX ? [minX, minY, minZ, maxX, maxY, maxZ] : null;
}

type XYZ = { x: number; y: number; z: number };

const scratch: XYZ = { x: 0, y: 0, z: 0 };

/** Writes `rotation⁻¹ · (point − origin)` into `out`: a point in a frame given by its pose. */
export function inverseTransformPoint(
  out: XYZ,
  px: number,
  py: number,
  pz: number,
  origin: Readonly<XYZ> | undefined,
  rotation: Readonly<XYZ & { w: number }> | null | undefined,
): XYZ {
  const x = px - (origin?.x ?? 0), y = py - (origin?.y ?? 0), z = pz - (origin?.z ?? 0);
  if (!rotation || (rotation.x === 0 && rotation.y === 0 && rotation.z === 0)) {
    out.x = x;
    out.y = y;
    out.z = z;
    return out;
  }
  // The conjugate rotates by the inverse of a unit quaternion.
  const qx = -rotation.x, qy = -rotation.y, qz = -rotation.z, qw = rotation.w;
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  out.x = x + qw * tx + (qy * tz - qz * ty);
  out.y = y + qw * ty + (qz * tx - qx * tz);
  out.z = z + qw * tz + (qx * ty - qy * tx);
  return out;
}

function boxDistance(x: number, y: number, z: number, hx: number, hy: number, hz: number): number {
  const qx = Math.abs(x) - hx, qy = Math.abs(y) - hy, qz = Math.abs(z) - hz;
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0));
  return outside + Math.min(Math.max(qx, qy, qz), 0);
}

/**
 * Signed distance from a point in the body's frame to a collider placed by its
 * body-local pose: negative inside, zero on the surface. Spheres, boxes,
 * capsules and cylinders are exact; convex hulls and triangle meshes use their
 * local bounds (`bounds`). Allocation-free, for per-contact use.
 */
export function colliderSignedDistance(
  desc: ColliderDesc,
  bounds: LocalBounds | null,
  px: number,
  py: number,
  pz: number,
): number {
  const local = inverseTransformPoint(scratch, px, py, pz, desc.translation, desc.rotation);
  const x = local.x, y = local.y, z = local.z;
  const shape = desc.shape;
  switch (shape.kind) {
    case "box":
      return boxDistance(x, y, z, shape.halfExtents.x, shape.halfExtents.y, shape.halfExtents.z);
    case "sphere":
      return Math.hypot(x, y, z) - shape.radius;
    case "capsule": {
      const axial = Math.min(Math.max(y, -shape.halfHeight), shape.halfHeight);
      return Math.hypot(x, y - axial, z) - shape.radius;
    }
    case "cylinder": {
      const radial = Math.hypot(x, z) - shape.radius;
      const axial = Math.abs(y) - shape.height / 2;
      return Math.min(Math.max(radial, axial), 0) + Math.hypot(Math.max(radial, 0), Math.max(axial, 0));
    }
    case "convex":
    case "mesh": {
      if (!bounds) return Infinity;
      return boxDistance(
        x - (bounds[0] + bounds[3]) / 2, y - (bounds[1] + bounds[4]) / 2, z - (bounds[2] + bounds[5]) / 2,
        (bounds[3] - bounds[0]) / 2, (bounds[4] - bounds[1]) / 2, (bounds[5] - bounds[2]) / 2,
      );
    }
    default:
      return Infinity;
  }
}
