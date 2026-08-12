import type { ColliderShape, MotionType } from "./types";

export type RigidBodyProperties = {
  motionType: MotionType;
  mass: number;
  linearDamping: number;
  angularDamping: number;
  gravityScale: number;
};

export type ColliderProperties = {
  shape: ColliderShape;
  friction: number;
  restitution: number;
  isTrigger: boolean;
  layer: number;
  mask: number;
};

export function parseRigidBodyProperties(
  properties: Record<string, unknown> | undefined,
): RigidBodyProperties {
  const source = properties ?? {};
  const motionType =
    source.motionType === "static" ||
    source.motionType === "kinematic" ||
    source.motionType === "dynamic"
      ? source.motionType
      : "dynamic";
  return {
    motionType,
    mass: numberOr(source.mass, 1),
    linearDamping: numberOr(source.linearDamping, 0),
    angularDamping: numberOr(source.angularDamping, 0),
    gravityScale: numberOr(source.gravityScale, 1),
  };
}

export function parseColliderProperties(
  properties: Record<string, unknown> | undefined,
  worldKind: "3d" | "2d",
): ColliderProperties {
  const source = properties ?? {};
  return {
    shape: parseShape(source.shape, worldKind),
    friction: numberOr(source.friction, 0.5),
    restitution: numberOr(source.restitution, 0),
    isTrigger: source.isTrigger === true,
    layer: numberOr(source.layer, 1),
    mask: numberOr(source.mask, 0xffffffff),
  };
}

function parseShape(
  value: unknown,
  worldKind: "3d" | "2d",
): ColliderShape {
  const source = (value ?? {}) as Record<string, unknown>;
  const kind = typeof source.kind === "string" ? source.kind : null;
  if (worldKind === "2d") {
    switch (kind) {
      case "circle":
        return { kind: "circle", radius: numberOr(source.radius, 0.5) };
      case "capsule2d":
        return {
          kind: "capsule2d",
          radius: numberOr(source.radius, 0.25),
          halfHeight: numberOr(source.halfHeight, 0.5),
        };
      case "polygon":
        return {
          kind: "polygon",
          points: parsePoints2(source.points),
        };
      case "chain":
        return {
          kind: "chain",
          points: parsePoints2(source.points),
          loop: source.loop === true,
        };
      case "box2d":
      default:
        return {
          kind: "box2d",
          halfExtents: {
            x: numberOr((source.halfExtents as { x?: number } | undefined)?.x, 0.5),
            y: numberOr((source.halfExtents as { y?: number } | undefined)?.y, 0.5),
          },
        };
    }
  }

  switch (kind) {
    case "sphere":
      return { kind: "sphere", radius: numberOr(source.radius, 0.5) };
    case "capsule":
      return {
        kind: "capsule",
        radius: numberOr(source.radius, 0.25),
        halfHeight: numberOr(source.halfHeight, 0.5),
      };
    case "convex":
      return { kind: "convex", points: parsePoints3(source.points) };
    case "mesh":
      return {
        kind: "mesh",
        vertices: parsePoints3(source.vertices),
        indices: Array.isArray(source.indices)
          ? source.indices.map((n) => Number(n) || 0)
          : [],
      };
    case "box":
    default:
      return {
        kind: "box",
        halfExtents: {
          x: numberOr((source.halfExtents as { x?: number } | undefined)?.x, 0.5),
          y: numberOr((source.halfExtents as { y?: number } | undefined)?.y, 0.5),
          z: numberOr((source.halfExtents as { z?: number } | undefined)?.z, 0.5),
        },
      };
  }
}

function parsePoints2(
  value: unknown,
): Array<{ x: number; y: number }> {
  if (!Array.isArray(value)) return [];
  return value.map((p) => {
    const pt = (p ?? {}) as { x?: number; y?: number };
    return { x: numberOr(pt.x, 0), y: numberOr(pt.y, 0) };
  });
}

function parsePoints3(
  value: unknown,
): Array<{ x: number; y: number; z: number }> {
  if (!Array.isArray(value)) return [];
  return value.map((p) => {
    const pt = (p ?? {}) as { x?: number; y?: number; z?: number };
    return {
      x: numberOr(pt.x, 0),
      y: numberOr(pt.y, 0),
      z: numberOr(pt.z, 0),
    };
  });
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
