import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import type { Scene } from "@babylonjs/core/scene";
import type { PhysicsBody } from "@babylonjs/core/Physics/v2/physicsBody";
import {
  PhysicsShapeBox,
  PhysicsShapeCapsule,
  PhysicsShapeConvexHull,
  PhysicsShapeCylinder,
  PhysicsShapeMesh,
  PhysicsShapeSphere,
  type PhysicsShape,
  type PhysicsShapeContainer,
} from "@babylonjs/core/Physics/v2/physicsShape";
import type { ColliderDesc, ColliderShape, PhysicsTransform, RigidBodyDesc, Vec3 } from "./types";
import { validateColliderShape } from "./collider-validation";
import type { LocalBounds } from "./contact-shape";

// The Havok backend's body and collider records and the shape helpers its world, queries, contacts and characters share.

export type BodyRecord = {
  /** Position in the backend's `bodies` map order, assigned at creation: results that list bodies sort by it. */
  order: number;
  desc: RigidBodyDesc;
  node: TransformNode;
  body: PhysicsBody;
  /** Whether the native body is asked for contact events (`RigidBodyDesc.reportContacts`, `setContactReporting`). */
  reporting: boolean;
  colliders: Map<string, ColliderRecord>;
  container: PhysicsShapeContainer | null;
  /** The compound includes shapes hosted for other actors; hits resolve per shape. */
  hostsShapes: boolean;
  /** Failed rollback keeps possibly attached resources alive until body teardown. */
  uncertainShapes: Set<PhysicsShape>;
  mutationFailure?: Error;
};

export type ColliderRecord = {
  desc: ColliderDesc;
  shape: PhysicsShape;
  /**
   * Overlap proxy: a massless trigger copy of `shape` whose collide mask is the layers this collider overlaps. Havok
   * has no per-pair response, so solids keep `[layer, mask]` (blocking) and the proxy raises the trigger events of
   * Overlap pairs: exactly one shape pair passes the filter for each Overlap pair, and none for a Block pair.
   */
  proxy?: PhysicsShape;
  /** Convex and mesh bounds for contact attribution, computed on first use. */
  bounds?: LocalBounds | null;
  /**
   * Position in the backend's `colliders` map order: assigned each time a transaction re-inserts the collider, so the
   * lowest sequence among an owner's colliders is the one a `colliders` scan would reach first.
   */
  seq: number;
};

export function colliderShapes(collider: ColliderRecord): PhysicsShape[] {
  return collider.proxy ? [collider.shape, collider.proxy] : [collider.shape];
}

export function toVector3(v: Vec3): Vector3 {
  return new Vector3(v.x, v.y, v.z);
}

export function toQuaternion(r: PhysicsTransform["rotation"]): Quaternion {
  return new Quaternion(r.x, r.y, r.z, r.w);
}

export function isShape3D(shape: ColliderShape): boolean {
  return (
    shape.kind === "box" ||
    shape.kind === "sphere" ||
    shape.kind === "capsule" ||
    shape.kind === "cylinder" ||
    shape.kind === "convex" ||
    shape.kind === "mesh"
  );
}

/** Shape construction owns helpers from their first allocation. Havok copies
 * mesh data synchronously; descriptors retain reconstruction inputs. */
export function createHavokShape(shape: ColliderShape, scene: Scene): PhysicsShape {
  validateColliderShape(shape);
  const origin = Vector3.Zero();
  switch (shape.kind) {
    case "box":
      return new PhysicsShapeBox(
        origin,
        Quaternion.Identity(),
        toVector3({
          x: shape.halfExtents.x * 2,
          y: shape.halfExtents.y * 2,
          z: shape.halfExtents.z * 2,
        }),
        scene,
      );
    case "sphere":
      return new PhysicsShapeSphere(origin, shape.radius, scene);
    case "capsule":
      return new PhysicsShapeCapsule(
        new Vector3(0, -shape.halfHeight, 0),
        new Vector3(0, shape.halfHeight, 0),
        shape.radius,
        scene,
      );
    case "cylinder":
      return new PhysicsShapeCylinder(
        new Vector3(0, -shape.height / 2, 0),
        new Vector3(0, shape.height / 2, 0),
        shape.radius,
        scene,
      );
    case "convex":
    case "mesh": {
      const mesh = new Mesh(`physics-${shape.kind}`, scene);
      try {
        mesh.isVisible = false;
        const data = new VertexData();
        // Packed mesh geometry passes through; Havok copies it into native memory.
        data.positions =
          shape.kind === "convex"
            ? shape.points.flatMap((p) => [p.x, p.y, p.z])
            : shape.positions;
        data.indices = shape.kind === "mesh" ? shape.indices : [];
        data.applyToMesh(mesh);
        return shape.kind === "convex"
          ? new PhysicsShapeConvexHull(mesh, scene)
          : new PhysicsShapeMesh(mesh, scene);
      } finally {
        mesh.dispose();
      }
    }
    default:
      throw new Error("Unsupported 3D collider shape");
  }
}
