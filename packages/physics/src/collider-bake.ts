import type { ColliderShape, Quat, Vec3 } from "./types";

export type ColliderLocalTransform = {
  position: Vec3;
  rotation: Quat;
  scale: Vec3;
};

export function identityQuat(): Quat {
  return { x: 0, y: 0, z: 0, w: 1 };
}

export function rotateQuatVec(rotation: Quat, offset: Vec3): Vec3 {
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

export function multiplyQuat(a: Quat, b: Quat): Quat {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}

export function isIdentityQuat(rotation: Quat | undefined): boolean {
  if (!rotation) return true;
  return (
    rotation.x === 0 &&
    rotation.y === 0 &&
    rotation.z === 0 &&
    rotation.w === 1
  );
}

/** 2D Rapier collider angle (XY plane) from a quaternion. */
export function quatToPlanarAngle(rotation: Quat): number {
  return Math.atan2(
    2 * (rotation.w * rotation.z + rotation.x * rotation.y),
    1 - 2 * (rotation.y * rotation.y + rotation.z * rotation.z),
  );
}

/**
 * Bake actor × component scale into shape sizes, scale local translation by
 * actor scale only (same as light/camera offsets), and keep local rotation.
 */
export function bakeColliderLocal(
  shape: ColliderShape,
  local: ColliderLocalTransform,
  actorScale: Vec3,
): { shape: ColliderShape; translation: Vec3; rotation: Quat } {
  const scale = {
    x: actorScale.x * local.scale.x,
    y: actorScale.y * local.scale.y,
    z: actorScale.z * local.scale.z,
  };
  return {
    shape: scaleColliderShape(shape, scale),
    translation: {
      x: local.position.x * actorScale.x,
      y: local.position.y * actorScale.y,
      z: local.position.z * actorScale.z,
    },
    rotation: { ...local.rotation },
  };
}

export function scaleColliderShape(
  shape: ColliderShape,
  scale: Vec3,
): ColliderShape {
  const sx = Math.abs(scale.x);
  const sy = Math.abs(scale.y);
  const sz = Math.abs(scale.z);
  const maxAbs = Math.max(sx, sy, sz, 0);
  const xz = Math.max(sx, sz, 0);
  switch (shape.kind) {
    case "box":
      return {
        kind: "box",
        halfExtents: {
          x: shape.halfExtents.x * sx,
          y: shape.halfExtents.y * sy,
          z: shape.halfExtents.z * sz,
        },
      };
    case "box2d":
      return {
        kind: "box2d",
        halfExtents: {
          x: shape.halfExtents.x * sx,
          y: shape.halfExtents.y * sy,
        },
      };
    case "sphere":
      return { kind: "sphere", radius: shape.radius * maxAbs };
    case "circle":
      return { kind: "circle", radius: shape.radius * Math.max(sx, sy, 0) };
    case "capsule":
      return {
        kind: "capsule",
        radius: shape.radius * xz,
        halfHeight: shape.halfHeight * sy,
      };
    case "capsule2d":
      return {
        kind: "capsule2d",
        radius: shape.radius * sx,
        halfHeight: shape.halfHeight * sy,
      };
    case "polygon":
      return {
        kind: "polygon",
        points: shape.points.map((p) => ({ x: p.x * scale.x, y: p.y * scale.y })),
      };
    case "chain":
      return {
        kind: "chain",
        points: shape.points.map((p) => ({ x: p.x * scale.x, y: p.y * scale.y })),
        loop: shape.loop,
      };
    case "convex":
      return {
        kind: "convex",
        points: shape.points.map((p) => ({
          x: p.x * scale.x,
          y: p.y * scale.y,
          z: p.z * scale.z,
        })),
      };
    case "mesh":
      return {
        kind: "mesh",
        vertices: shape.vertices.map((p) => ({
          x: p.x * scale.x,
          y: p.y * scale.y,
          z: p.z * scale.z,
        })),
        indices: [...shape.indices],
      };
  }
}
