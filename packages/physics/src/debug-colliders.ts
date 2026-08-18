import type { ColliderDesc, PhysicsTransform, Quat, Vec3 } from "./types";

export type DebugColliderShape = "box" | "sphere" | "circle" | "polyline";

export type DebugColliderPrimitive = {
  id: string;
  shape: DebugColliderShape;
  position: Vec3;
  rotation: Quat;
  halfExtents?: Vec3;
  radius?: number;
  points?: Vec3[];
};

function identityQuat(): Quat {
  return { x: 0, y: 0, z: 0, w: 1 };
}

export function colliderWorldPosition(desc: ColliderDesc, bodyPos: Vec3): Vec3 {
  const offset = desc.translation;
  if (!offset) return { ...bodyPos };
  return {
    x: bodyPos.x + offset.x,
    y: bodyPos.y + offset.y,
    z: bodyPos.z + offset.z,
  };
}

function polylinePoints(
  points: ReadonlyArray<{ x: number; y: number; z?: number }>,
  position: Vec3,
): Vec3[] {
  return points.map((point) => ({
    x: position.x + point.x,
    y: position.y + point.y,
    z: position.z + (point.z ?? 0),
  }));
}

/** Boxes, spheres, circles, and polylines only — skip convex/mesh authorship. */
export function debugColliderFromDesc(
  desc: ColliderDesc,
  bodyTransform: PhysicsTransform,
): DebugColliderPrimitive | null {
  const position = colliderWorldPosition(desc, bodyTransform.position);
  const rotation = bodyTransform.rotation ?? identityQuat();
  const shape = desc.shape;
  switch (shape.kind) {
    case "box":
      return {
        id: desc.id,
        shape: "box",
        position,
        rotation,
        halfExtents: { ...shape.halfExtents },
      };
    case "box2d":
      return {
        id: desc.id,
        shape: "box",
        position,
        rotation,
        halfExtents: {
          x: shape.halfExtents.x,
          y: shape.halfExtents.y,
          z: 0.01,
        },
      };
    case "sphere":
      return {
        id: desc.id,
        shape: "sphere",
        position,
        rotation,
        radius: shape.radius,
      };
    case "circle":
      return {
        id: desc.id,
        shape: "circle",
        position,
        rotation,
        radius: shape.radius,
      };
    case "polygon":
    case "chain":
      return {
        id: desc.id,
        shape: "polyline",
        position,
        rotation,
        points: polylinePoints(shape.points, position),
      };
    default:
      return null;
  }
}

export function listDebugCollidersFromRecords(
  colliders: Iterable<{ desc: ColliderDesc }>,
  getBodyTransform: (bodyId: string) => PhysicsTransform | null,
): DebugColliderPrimitive[] {
  const out: DebugColliderPrimitive[] = [];
  for (const record of colliders) {
    const body = getBodyTransform(record.desc.bodyId);
    if (!body) continue;
    const primitive = debugColliderFromDesc(record.desc, body);
    if (primitive) out.push(primitive);
  }
  return out;
}
