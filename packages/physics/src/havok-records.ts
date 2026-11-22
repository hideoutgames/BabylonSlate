import type { HavokPhysicsWithBindings, HP_BodyId, HP_ShapeId } from "@babylonjs/havok";
import type { ColliderDesc, ColliderShape, PhysicsTransform, RigidBodyDesc } from "./types";
import { validateColliderShape } from "./collider-validation";
import type { LocalBounds } from "./contact-shape";
import {
  checked,
  checkedValue,
  IDENTITY_HAVOK_QUAT,
  withFloat32Heap,
  withInt32Heap,
  ZERO_HAVOK_VEC3,
} from "./havok-wasm-memory";

// The direct Havok WASM backend's body and collider records and native shape helpers.

export type BodyRecord = {
  /** Position in the backend's `bodies` map order, assigned at creation: results that list bodies sort by it. */
  order: number;
  desc: RigidBodyDesc;
  hpBodyId: HP_BodyId;
  /** Current world pose, synced on creation, teleport, and post-step body-buffer readback. */
  pose: PhysicsTransform;
  /** Byte offset inside `HP_World_GetBodyBuffer(worldId)`; refreshed whenever added to the world. */
  worldTransformOffset: number;
  /** Whether `hpBodyId` is currently added to the Havok world. */
  inWorld: boolean;
  /** Currently attached native shape (compound container or single collider shape), or null. */
  attachedShape: HP_ShapeId | null;
  /** User mass override properties applied after native shape mass recomputation. */
  massProps: { mass: number; lockRotation: boolean };
  /** Whether the native body is asked for contact events (`RigidBodyDesc.reportContacts`, `setContactReporting`). */
  reporting: boolean;
  colliders: Map<string, ColliderRecord>;
  container: HP_ShapeId | null;
  /** The compound includes shapes hosted for other actors; hits resolve per shape. */
  hostsShapes: boolean;
  /** Last stepped 12 matrix floats (cols 0..3 xyz) read from the Havok body buffer, or null before first step/after mutation. */
  lastBufferMatrix: Float32Array | null;
  /** True when the last step observed a pose change (or before the first step / after an explicit mutation). */
  movedLastStep: boolean;
  /** Failed rollback keeps possibly attached native shapes alive until body teardown. */
  uncertainShapes: Set<HP_ShapeId>;
  mutationFailure?: Error;
};

export type ColliderRecord = {
  desc: ColliderDesc;
  shape: HP_ShapeId;
  /**
   * Overlap proxy: a massless trigger copy of `shape` whose collide mask is the layers this collider overlaps. Havok
   * has no per-pair response, so solids keep `[layer, mask]` (blocking) and the proxy raises the trigger events of
   * Overlap pairs: exactly one shape pair passes the filter for each Overlap pair, and none for a Block pair.
   */
  proxy?: HP_ShapeId;
  /** Convex and mesh bounds for contact attribution, computed on first use. */
  bounds?: LocalBounds | null;
  /**
   * Position in the backend's `colliders` map order: assigned each time a transaction re-inserts the collider, so the
   * lowest sequence among an owner's colliders is the one a `colliders` scan would reach first.
   */
  seq: number;
};

export function colliderShapes(collider: ColliderRecord): HP_ShapeId[] {
  return collider.proxy ? [collider.shape, collider.proxy] : [collider.shape];
}

export function isShape3D(shape: ColliderShape): boolean {
  return (
    shape.kind === "box" ||
    shape.kind === "sphere" ||
    shape.kind === "capsule" ||
    shape.kind === "cylinder" ||
    shape.kind === "convex" ||
    shape.kind === "mesh" ||
    shape.kind === "heightfield"
  );
}

/** Release a native Havok shape handle safely. */
export function releaseHavokShape(
  havok: HavokPhysicsWithBindings,
  shape: HP_ShapeId | null | undefined,
): void {
  if (!shape || shape[0] === 0n) return;
  havok.HP_Shape_Release(shape);
}

/** Read a native shape's `[membershipMask, collideMask]` filter tuple. */
function getShapeFilterInfo(
  havok: HavokPhysicsWithBindings,
  shape: HP_ShapeId,
): [number, number] {
  return checkedValue(havok, havok.HP_Shape_GetFilterInfo(shape), "shape filter read");
}

/** Update only a native shape's membership mask while preserving its collide mask. */
export function setShapeMembershipMask(
  havok: HavokPhysicsWithBindings,
  shape: HP_ShapeId,
  membershipMask: number,
): number {
  const [prevMembership, collideMask] = getShapeFilterInfo(havok, shape);
  checked(
    havok,
    havok.HP_Shape_SetFilterInfo(shape, [membershipMask >>> 0, collideMask >>> 0]),
    "shape filter update",
  );
  return prevMembership;
}

/**
 * Create a native Havok `HP_ShapeId` directly via `HP_Shape_Create*` with no Babylon `Mesh` or `VertexData` wrapper.
 * Havok copies convex/mesh buffers synchronously before WASM scratch memory is freed.
 */
export function createHavokShape(
  havok: HavokPhysicsWithBindings,
  shape: ColliderShape,
): HP_ShapeId {
  validateColliderShape(shape);
  switch (shape.kind) {
    case "box":
      return checkedValue(
        havok,
        havok.HP_Shape_CreateBox(
          ZERO_HAVOK_VEC3,
          IDENTITY_HAVOK_QUAT,
          [shape.halfExtents.x * 2, shape.halfExtents.y * 2, shape.halfExtents.z * 2],
        ),
        "box shape creation",
      );
    case "sphere":
      return checkedValue(
        havok,
        havok.HP_Shape_CreateSphere(ZERO_HAVOK_VEC3, shape.radius),
        "sphere shape creation",
      );
    case "capsule":
      return checkedValue(
        havok,
        havok.HP_Shape_CreateCapsule(
          [0, -shape.halfHeight, 0],
          [0, shape.halfHeight, 0],
          shape.radius,
        ),
        "capsule shape creation",
      );
    case "cylinder":
      return checkedValue(
        havok,
        havok.HP_Shape_CreateCylinder(
          [0, -shape.height / 2, 0],
          [0, shape.height / 2, 0],
          shape.radius,
        ),
        "cylinder shape creation",
      );
    case "convex": {
      const flat = new Float32Array(shape.points.length * 3);
      for (let i = 0; i < shape.points.length; i++) {
        const p = shape.points[i]!;
        flat[i * 3] = p.x;
        flat[i * 3 + 1] = p.y;
        flat[i * 3 + 2] = p.z;
      }
      return withFloat32Heap(havok, flat, (ptr) =>
        checkedValue(
          havok,
          havok.HP_Shape_CreateConvexHull(ptr, shape.points.length),
          "convex hull shape creation",
        ),
      );
    }
    case "mesh": {
      const numVertices = Math.floor(shape.positions.length / 3);
      const numTriangles = Math.floor(shape.indices.length / 3);
      return withFloat32Heap(havok, shape.positions, (vPtr) =>
        withInt32Heap(havok, shape.indices, (tPtr) =>
          checkedValue(
            havok,
            havok.HP_Shape_CreateMesh(vPtr, numVertices, tPtr, numTriangles),
            "mesh shape creation",
          ),
        ),
      );
    }
    case "heightfield": {
      const { numXSamples, numZSamples, width, depth, heights } = shape;
      // Havok HP_Shape_CreateHeightField expects X-major order `heights[ix * numZSamples + iz]`
      // and already centers the grid at `[-width/2, +width/2] x [-depth/2, +depth/2]`.
      const transposed = new Float32Array(numXSamples * numZSamples);
      for (let ix = 0; ix < numXSamples; ix++) {
        const dstBase = ix * numZSamples;
        for (let iz = 0; iz < numZSamples; iz++) {
          transposed[dstBase + iz] = heights[iz * numXSamples + ix]!;
        }
      }
      const dx = width / (numXSamples - 1);
      const dz = depth / (numZSamples - 1);
      return withFloat32Heap(havok, transposed, (ptr) =>
        checkedValue(
          havok,
          havok.HP_Shape_CreateHeightField(numXSamples, numZSamples, [dx, 1, dz], ptr),
          "heightfield shape creation",
        ),
      );
    }
    default:
      throw new Error("Unsupported 3D collider shape");
  }
}
