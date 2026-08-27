import type { ColliderDesc, PhysicsTransform, Quat, Vec3 } from "./types";

export type DebugColliderShape = "box" | "sphere" | "circle" | "polyline" | "capsule";

export type DebugColliderPrimitive = {
  id: string;
  shape: DebugColliderShape;
  position: Vec3;
  rotation: Quat;
  halfExtents?: Vec3;
  radius?: number;
  halfHeight?: number;
  points?: Vec3[];
};

function identityQuat(): Quat {
  return { x: 0, y: 0, z: 0, w: 1 };
}

function rotateOffset(rotation: Quat, offset: Vec3): Vec3 {
  const { x, y, z, w } = rotation;
  const tx = 2 * (y * offset.z - z * offset.y);
  const ty = 2 * (z * offset.x - x * offset.z);
  const tz = 2 * (x * offset.y - y * offset.x);
  return {
    x: offset.x + w * tx + (y * tz - z * ty),
    y: offset.y + w * ty + (z * tx - x * tz),
    z: offset.z + w * tz + (x * ty - y * tx),
  };
}

function multiplyQuat(a: Quat, b: Quat): Quat {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}

export function colliderWorldPosition(
  desc: ColliderDesc,
  bodyTransform: Pick<PhysicsTransform, "position" | "rotation">,
): Vec3 {
  const offset = desc.translation;
  if (!offset) return { ...bodyTransform.position };
  const rotated = rotateOffset(bodyTransform.rotation ?? identityQuat(), offset);
  return {
    x: bodyTransform.position.x + rotated.x,
    y: bodyTransform.position.y + rotated.y,
    z: bodyTransform.position.z + rotated.z,
  };
}

function polylinePoints(
  points: ReadonlyArray<{ x: number; y: number; z?: number }>,
  origin: Vec3,
  rotation: Quat,
): Vec3[] {
  return points.map((point) => {
    const rotated = rotateOffset(rotation, {
      x: point.x,
      y: point.y,
      z: point.z ?? 0,
    });
    return {
      x: origin.x + rotated.x,
      y: origin.y + rotated.y,
      z: origin.z + rotated.z,
    };
  });
}

/** Boxes, spheres, circles, capsules, and polylines only — skip convex/mesh authorship. */
export function debugColliderFromDesc(
  desc: ColliderDesc,
  bodyTransform: PhysicsTransform,
): DebugColliderPrimitive | null {
  const position = colliderWorldPosition(desc, bodyTransform);
  const rotation = multiplyQuat(
    bodyTransform.rotation ?? identityQuat(),
    desc.rotation ?? identityQuat(),
  );
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
    case "capsule":
    case "capsule2d":
      return {
        id: desc.id,
        shape: "capsule",
        position,
        rotation,
        radius: shape.radius,
        halfHeight: shape.halfHeight,
      };
    case "cylinder":
      return {
        id: desc.id,
        shape: "box",
        position,
        rotation,
        halfExtents: {
          x: shape.radius,
          y: shape.height / 2,
          z: shape.radius,
        },
      };
    case "polygon":
    case "chain":
      return {
        id: desc.id,
        shape: "polyline",
        position,
        rotation,
        points: polylinePoints(shape.points, position, rotation),
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
