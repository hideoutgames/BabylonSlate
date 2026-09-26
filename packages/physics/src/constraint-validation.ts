import { normalizedPhysicsPose } from "./collider-validation";
import type { ConstraintDesc, PhysicsWorldKind, Quat, Vec3 } from "./types";

const identity: Quat = { x: 0, y: 0, z: 0, w: 1 };
const tolerance = 1e-7;

function vector(value: Vec3): Vec3 {
  if (!value || ![value.x, value.y, value.z].every(Number.isFinite))
    throw new Error("Constraint vectors must be finite");
  return { x: value.x, y: value.y, z: value.z };
}

function direction(value: Vec3): Vec3 {
  const copy = vector(value);
  const length = Math.hypot(copy.x, copy.y, copy.z);
  if (length < tolerance) throw new Error("Constraint axes must be nonzero");
  return { x: copy.x / length, y: copy.y / length, z: copy.z / length };
}

function perpendicular(axis: Vec3, reference?: Vec3): Vec3 {
  const ref = vector(reference ?? (Math.abs(axis.x) < 0.9
    ? { x: 1, y: 0, z: 0 }
    : { x: 0, y: 1, z: 0 }));
  const dot = axis.x * ref.x + axis.y * ref.y + axis.z * ref.z;
  return direction({ x: ref.x - dot * axis.x, y: ref.y - dot * axis.y, z: ref.z - dot * axis.z });
}

function frame(value: Quat | undefined, kind: PhysicsWorldKind): Quat {
  const result = normalizedPhysicsPose({ position: { x: 0, y: 0, z: 0 }, rotation: value ?? identity }).rotation;
  if (kind === "2d" && (Math.abs(result.x) > tolerance || Math.abs(result.y) > tolerance))
    throw new Error("2D constraint frames must rotate only around Z");
  return result;
}

/** Validation and owned copies precede any mutation of native constraint state. */
export function copyConstraintDesc(desc: ConstraintDesc, kind: PhysicsWorldKind): ConstraintDesc {
  if (![desc.id, desc.bodyAId, desc.bodyBId].every((id) => typeof id === "string" && id.length > 0))
    throw new Error("Constraint and body identities must be nonempty");
  if (desc.bodyAId === desc.bodyBId) throw new Error("A constraint needs two different bodies");
  if (desc.collideConnected !== undefined && typeof desc.collideConnected !== "boolean")
    throw new Error("Constraint collision policy must be a boolean");
  const base = {
    id: desc.id, bodyAId: desc.bodyAId, bodyBId: desc.bodyBId,
    anchorA: vector(desc.anchorA), anchorB: vector(desc.anchorB),
    collideConnected: desc.collideConnected ?? false,
  };
  if (kind === "2d" && (Math.abs(base.anchorA.z) > tolerance || Math.abs(base.anchorB.z) > tolerance))
    throw new Error("2D constraint anchors must lie in the XY plane");
  switch (desc.kind) {
    case "fixed": return { ...base, kind: desc.kind, frameA: frame(desc.frameA, kind), frameB: frame(desc.frameB, kind) };
    case "ballSocket": {
      if (kind === "2d" && desc.angularLimits)
        throw new Error("Ball/socket angular limits are supported only in 3D; use a 2D hinge");
      const angularLimits = desc.angularLimits
        ? { min: vector(desc.angularLimits.min), max: vector(desc.angularLimits.max) } : undefined;
      if (angularLimits && (["x", "y", "z"] as const).some((axis) =>
        angularLimits.min[axis] > angularLimits.max[axis] ||
        angularLimits.min[axis] < -Math.PI || angularLimits.max[axis] > Math.PI))
        throw new Error("Ball/socket limits must be ordered angles between -PI and PI");
      return { ...base, kind: desc.kind, frameA: frame(desc.frameA, kind), frameB: frame(desc.frameB, kind),
        ...(angularLimits ? { angularLimits } : {}) };
    }
    case "distance":
      if (kind === "2d") throw new Error("Exact distance constraints are not supported in 2D");
      if (!Number.isFinite(desc.distance) || desc.distance < 0)
        throw new Error("Constraint distance must be finite and nonnegative");
      return { ...base, kind: desc.kind, distance: desc.distance };
    case "hinge": {
      const axisA = direction(desc.axisA);
      const axisB = direction(desc.axisB);
      if (kind === "2d" && (
        Math.abs(axisA.x) > tolerance || Math.abs(axisA.y) > tolerance ||
        Math.abs(axisB.x) > tolerance || Math.abs(axisB.y) > tolerance || axisA.z * axisB.z < 0
      )) throw new Error("2D hinge axes must point in the same direction along Z");
      const referenceAxisA = perpendicular(axisA, desc.referenceAxisA);
      const referenceAxisB = perpendicular(axisB, desc.referenceAxisB);
      if (desc.limits && (!Number.isFinite(desc.limits.min) || !Number.isFinite(desc.limits.max) ||
        desc.limits.min > desc.limits.max || desc.limits.min < -Math.PI || desc.limits.max > Math.PI))
        throw new Error("Hinge limits must be ordered angles between -PI and PI");
      return { ...base, kind: desc.kind, axisA, axisB, referenceAxisA, referenceAxisB,
        ...(desc.limits ? { limits: { ...desc.limits } } : {}) };
    }
    default: throw new Error("Unsupported constraint kind");
  }
}
