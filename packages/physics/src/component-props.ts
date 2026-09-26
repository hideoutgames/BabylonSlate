import { validateColliderShape } from "./collider-validation";
import type { ColliderShape, ConstraintDesc, MotionType, Quat, Vec3 } from "./types";

export type ConstraintProperties = {
  kind: ConstraintDesc["kind"];
  targetActorId: string;
  enabled: boolean;
  collideConnected: boolean;
  anchorA: Vec3;
  anchorB: Vec3;
  axisA: Vec3;
  axisB: Vec3;
  referenceAxisA: Vec3;
  referenceAxisB: Vec3;
  frameA: Quat;
  frameB: Quat;
  limitsEnabled: boolean;
  /** Authoring uses degrees; the runtime converts to backend radians. */
  minAngle: number;
  maxAngle: number;
  distance: number;
};

export function parseConstraintProperties(
  properties: Record<string, unknown> | undefined,
  worldKind: "3d" | "2d",
): ConstraintProperties {
  const source = properties ?? {};
  const kind = source.kind ?? "ballSocket";
  if (kind !== "fixed" && kind !== "ballSocket" && kind !== "hinge" && kind !== "distance")
    throw new Error("Unsupported constraint kind");
  const vector = (value: unknown, fallback: Vec3): Vec3 => {
    if (value !== undefined && (value === null || typeof value !== "object" || Array.isArray(value)))
      throw new Error("Constraint vectors must be objects with finite coordinates");
    const v = (value ?? {}) as Partial<Vec3>;
    return { x: constraintNumber(v.x, fallback.x), y: constraintNumber(v.y, fallback.y), z: constraintNumber(v.z, fallback.z) };
  };
  const frame = (value: unknown): Quat => {
    if (value !== undefined && (value === null || typeof value !== "object" || Array.isArray(value)))
      throw new Error("Constraint frames must be quaternion objects");
    const q = (value ?? {}) as Partial<Quat>;
    return { ...vector(q, { x: 0, y: 0, z: 0 }), w: constraintNumber(q.w, 1) };
  };
  const axis = worldKind === "2d" ? { x: 0, y: 0, z: 1 } : { x: 0, y: 1, z: 0 };
  return {
    kind, targetActorId: typeof source.targetActorId === "string" ? source.targetActorId : "",
    enabled: source.enabled !== false, collideConnected: source.collideConnected === true,
    anchorA: vector(source.anchorA, { x: 0, y: 0, z: 0 }), anchorB: vector(source.anchorB, { x: 0, y: 0, z: 0 }),
    axisA: vector(source.axisA, axis), axisB: vector(source.axisB, axis),
    referenceAxisA: vector(source.referenceAxisA, { x: 1, y: 0, z: 0 }),
    referenceAxisB: vector(source.referenceAxisB, { x: 1, y: 0, z: 0 }),
    frameA: frame(source.frameA), frameB: frame(source.frameB),
    limitsEnabled: source.limitsEnabled === true,
    minAngle: constraintNumber(source.minAngle, -45), maxAngle: constraintNumber(source.maxAngle, 45),
    distance: constraintNumber(source.distance, 1),
  };
}

function constraintNumber(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error("Constraint values must be finite numbers");
  return value;
}

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
  /** Play/export world dashes; editor always draws them. Default false. */
  renderInGame: boolean;
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
  options: { validation?: "native" | "authoring" } = {},
): ColliderProperties {
  const source = properties ?? {};
  const shape = parseShape(source.shape, worldKind);
  // The inspector must display unfinished point clouds and zero-sized draft
  // primitives. Simulation callers retain strict geometry validation.
  if (options.validation !== "authoring") validateColliderShape(shape);
  return {
    shape,
    friction: numberOr(source.friction, 0.5),
    restitution: numberOr(source.restitution, 0),
    isTrigger: source.isTrigger === true,
    layer: numberOr(source.layer, 1),
    mask: numberOr(source.mask, 0xffffffff),
    renderInGame: source.renderInGame === true,
  };
}

function parseShape(value: unknown, worldKind: "3d" | "2d"): ColliderShape {
  const source = (value ?? {}) as Record<string, unknown>;
  const kind = typeof source.kind === "string" ? source.kind : null;
  const supported =
    worldKind === "2d"
      ? ["box", "box2d", "circle", "capsule2d", "polygon", "chain"]
      : ["box", "sphere", "capsule", "cylinder", "convex", "mesh"];
  if (source.kind != null && !supported.includes(String(source.kind)))
    throw new Error("Unsupported collider shape");
  if (worldKind === "2d") {
    switch (kind) {
      case "circle":
        return { kind: "circle", radius: shapeNumber(source.radius, 0.5) };
      case "capsule2d":
        return {
          kind: "capsule2d",
          radius: shapeNumber(source.radius, 0.25),
          halfHeight: shapeNumber(source.halfHeight, 0.5),
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
      // SceneLayer colliders also accept the shared authored box dimensions.
      case "box":
      case "box2d":
      default:
        return {
          kind: "box2d",
          halfExtents: {
            x: shapeNumber(
              (source.halfExtents as { x?: number } | undefined)?.x,
              0.5,
            ),
            y: shapeNumber(
              (source.halfExtents as { y?: number } | undefined)?.y,
              0.5,
            ),
          },
        };
    }
  }

  switch (kind) {
    case "sphere":
      return { kind: "sphere", radius: shapeNumber(source.radius, 0.5) };
    case "capsule":
      return {
        kind: "capsule",
        radius: shapeNumber(source.radius, 0.25),
        halfHeight: shapeNumber(source.halfHeight, 0.5),
      };
    case "cylinder":
      return {
        kind: "cylinder",
        radius: shapeNumber(source.radius, 0.5),
        height: shapeNumber(source.height, 1),
      };
    case "convex":
      return { kind: "convex", points: parsePoints3(source.points) };
    case "mesh":
      return {
        kind: "mesh",
        vertices: parsePoints3(source.vertices),
        indices: Array.isArray(source.indices)
          ? source.indices.map((n) => shapeNumber(n, 0))
          : [],
      };
    case "box":
    default:
      return {
        kind: "box",
        halfExtents: {
          x: shapeNumber(
            (source.halfExtents as { x?: number } | undefined)?.x,
            0.5,
          ),
          y: shapeNumber(
            (source.halfExtents as { y?: number } | undefined)?.y,
            0.5,
          ),
          z: shapeNumber(
            (source.halfExtents as { z?: number } | undefined)?.z,
            0.5,
          ),
        },
      };
  }
}

function parsePoints2(value: unknown): Array<{ x: number; y: number }> {
  if (!Array.isArray(value)) return [];
  return value.map((p) => {
    if (!p || typeof p !== "object") throw new Error("Invalid collider point");
    const pt = p as { x?: number; y?: number };
    return { x: shapeNumber(pt.x, 0), y: shapeNumber(pt.y, 0) };
  });
}

function parsePoints3(
  value: unknown,
): Array<{ x: number; y: number; z: number }> {
  if (!Array.isArray(value)) return [];
  return value.map((p) => {
    if (!p || typeof p !== "object") throw new Error("Invalid collider point");
    const pt = p as { x?: number; y?: number; z?: number };
    return {
      x: shapeNumber(pt.x, 0),
      y: shapeNumber(pt.y, 0),
      z: shapeNumber(pt.z, 0),
    };
  });
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function shapeNumber(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error("Collider geometry values must be finite numbers");
  return value;
}
