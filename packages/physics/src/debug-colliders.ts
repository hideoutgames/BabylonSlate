import type { ColliderDesc, PhysicsTransform, Quat, Vec3 } from "./types";
import { identityQuat, multiplyQuat, rotateQuatVec } from "./collider-bake";

export type DebugColliderShape = "box" | "sphere" | "circle" | "polyline" | "capsule" | "capsule2d" | "cylinder" | "convex" | "mesh";

export type DebugColliderPrimitive = {
  id: string;
  shape: DebugColliderShape;
  position: Vec3;
  rotation: Quat;
  halfExtents?: Vec3;
  radius?: number;
  halfHeight?: number;
  height?: number;
  points?: Vec3[];
  indices?: number[];
};

export function colliderWorldPosition(
  desc: ColliderDesc,
  bodyTransform: Pick<PhysicsTransform, "position" | "rotation">,
): Vec3 {
  const offset = desc.translation;
  if (!offset) return { ...bodyTransform.position };
  const rotated = rotateQuatVec(bodyTransform.rotation ?? identityQuat(), offset);
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
    const rotated = rotateQuatVec(rotation, {
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

/** Snapshot the simulation geometry with its current body and local collider pose. */
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
        shape: shape.kind,
        position,
        rotation,
        radius: shape.radius,
        halfHeight: shape.halfHeight,
      };
    case "cylinder":
      return {
        id: desc.id,
        shape: "cylinder",
        position,
        rotation,
        radius: shape.radius,
        height: shape.height,
      };
    case "polygon":
    case "chain": {
      const points = polylinePoints(shape.points, position, rotation);
      if (points.length > 1 && (shape.kind === "polygon" || shape.loop)) {
        const first = points[0]!;
        const last = points[points.length - 1]!;
        if (first.x !== last.x || first.y !== last.y || first.z !== last.z) {
          points.push({ ...first });
        }
      }
      return {
        id: desc.id,
        shape: "polyline",
        position,
        rotation,
        points,
      };
    }
    case "convex":
      return {
        id: desc.id,
        shape: "convex",
        position,
        rotation,
        points: shape.points.map((point) => ({ ...point })),
      };
    case "mesh":
      if (shape.vertices.length < 3 || shape.indices.length < 3) return null;
      return {
        id: desc.id,
        shape: "mesh",
        position,
        rotation,
        points: shape.vertices.map((point) => ({ ...point })),
        indices: [...shape.indices],
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
