import type { ColliderShape, Quat, Vec3 } from "./types";
import { normalizedPhysicsPose } from "./collider-validation";

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
    rotation.x === 0 && rotation.y === 0 && rotation.z === 0 && rotation.w === 1
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
  const prepared = colliderLocalPose(shape.kind, local, actorScale);
  return {
    shape: scaleColliderShape(shape, prepared.scale),
    translation: prepared.translation,
    rotation: prepared.rotation,
  };
}

const PLANAR_KINDS: ReadonlySet<ColliderShape["kind"]> = new Set(["box2d", "circle", "capsule2d", "polygon", "chain"]);
/** The rotated axes `checkColliderLocal` writes, scaled by the parent: x, y, z of each in turn. */
const axesScratch = new Float64Array(9);

/**
 * Validates a collider's local pose under `actorScale` (a finite position and a nonzero quaternion, finite nonzero
 * scales, no shear from a nonuniform parent scale under an oblique rotation) and writes the parent-scaled rotated axes
 * into `axes`. Returns whether `kind` is planar. Allocation-free: physics validates every parented actor each step.
 */
function checkColliderLocal(
  kind: ColliderShape["kind"],
  local: ColliderLocalTransform,
  actorScale: Vec3,
  axes: Float64Array,
): boolean {
  const q = local.rotation;
  const length = Math.hypot(q.x, q.y, q.z, q.w);
  if (
    !Number.isFinite(local.position.x) ||
    !Number.isFinite(local.position.y) ||
    !Number.isFinite(local.position.z) ||
    !Number.isFinite(length) ||
    length < 1e-12
  ) {
    throw new Error(
      "Physics pose must contain a finite position and a nonzero quaternion",
    );
  }
  const is2d = PLANAR_KINDS.has(kind);
  for (const axis of is2d
    ? (["x", "y"] as const)
    : (["x", "y", "z"] as const)) {
    if (
      !Number.isFinite(local.scale[axis]) ||
      !Number.isFinite(actorScale[axis]) ||
      local.scale[axis] === 0 ||
      actorScale[axis] === 0
    ) {
      throw new Error("Collider scale must be finite and nonzero");
    }
  }
  // A rigid attachment cannot represent shear induced by non-uniform ancestor
  // scaling and an oblique local rotation. Do not silently approximate it.
  const x = q.x / length, y = q.y / length, z = q.z / length, w = q.w / length;
  const sx = actorScale.x, sy = actorScale.y, sz = is2d ? 1 : actorScale.z;
  for (let i = 0; i < 3; i++) {
    // `rotateQuatVec` of the unit axis i.
    const ox = i === 0 ? 1 : 0, oy = i === 1 ? 1 : 0, oz = i === 2 ? 1 : 0;
    const tx = 2 * (y * oz - z * oy);
    const ty = 2 * (z * ox - x * oz);
    const tz = 2 * (x * oy - y * ox);
    axes[i * 3] = (ox + w * tx + (y * tz - z * ty)) * sx;
    axes[i * 3 + 1] = (oy + w * ty + (z * tx - x * tz)) * sy;
    axes[i * 3 + 2] = (oz + w * tz + (x * ty - y * tx)) * sz;
  }
  for (let i = 0; i < (is2d ? 2 : 3); i++)
    for (let j = i + 1; j < (is2d ? 2 : 3); j++) {
      const ax = axes[i * 3]!, ay = axes[i * 3 + 1]!, az = axes[i * 3 + 2]!;
      const bx = axes[j * 3]!, by = axes[j * 3 + 1]!, bz = axes[j * 3 + 2]!;
      const relativeDot =
        (ax * bx + ay * by + az * bz) /
        (Math.hypot(ax, ay, az) * Math.hypot(bx, by, bz));
      if (Math.abs(relativeDot) > 1e-6)
        throw new Error("Collider transform contains unsupported shear");
    }
  return is2d;
}

/** Throws exactly where `colliderLocalPose` would, without building the pose. */
export function assertColliderLocalPose(
  kind: ColliderShape["kind"],
  local: ColliderLocalTransform,
  actorScale: Vec3,
): void {
  checkColliderLocal(kind, local, actorScale, axesScratch);
}

/** Fixed-size TRS decomposition, independent of collision vertex data. */
export function colliderLocalPose(
  kind: ColliderShape["kind"],
  local: ColliderLocalTransform,
  actorScale: Vec3,
): { scale: Vec3; translation: Vec3; rotation: Quat } {
  const is2d = checkColliderLocal(kind, local, actorScale, axesScratch);
  const parentScale = is2d ? { ...actorScale, z: 1 } : actorScale;
  const axes = [0, 1, 2].map((i) => ({
    x: axesScratch[i * 3]!,
    y: axesScratch[i * 3 + 1]!,
    z: axesScratch[i * 3 + 2]!,
  }));
  // Decompose S_parent * R_local into an orthonormal attachment and the
  // canonical geometry scale. A quarter-turn permutes nonuniform scale axes.
  // Put any reflection on X so the attachment remains a proper rotation.
  const uniformXY = Math.abs(parentScale.x) === Math.abs(parentScale.y);
  const uniform =
    uniformXY && (is2d || Math.abs(parentScale.x) === Math.abs(parentScale.z));
  const lengths = axes.map((axis, index) =>
    uniform && (!is2d || index < 2)
      ? Math.abs(parentScale.x)
      : Math.hypot(axis.x, axis.y, axis.z),
  );
  lengths[0] =
    lengths[0]! * Math.sign(parentScale.x * parentScale.y * parentScale.z);
  const basis = axes.map((axis, index) => ({
    x: axis.x / lengths[index]!,
    y: axis.y / lengths[index]!,
    z: axis.z / lengths[index]!,
  }));
  const scale = {
    x: lengths[0]! * local.scale.x,
    y: lengths[1]! * local.scale.y,
    z: lengths[2]! * local.scale.z,
  };
  return {
    scale,
    translation: {
      x: local.position.x * actorScale.x,
      y: local.position.y * actorScale.y,
      z: local.position.z * actorScale.z,
    },
    rotation: quaternionFromBasis(basis[0]!, basis[1]!, basis[2]!),
  };
}

/** Matrix columns are a proper orthonormal basis after shear validation. */
function quaternionFromBasis(x: Vec3, y: Vec3, z: Vec3): Quat {
  const trace = x.x + y.y + z.z;
  let q: Quat;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    q = {
      x: (y.z - z.y) / s,
      y: (z.x - x.z) / s,
      z: (x.y - y.x) / s,
      w: s / 4,
    };
  } else if (x.x > y.y && x.x > z.z) {
    const s = Math.sqrt(1 + x.x - y.y - z.z) * 2;
    q = {
      x: s / 4,
      y: (y.x + x.y) / s,
      z: (z.x + x.z) / s,
      w: (y.z - z.y) / s,
    };
  } else if (y.y > z.z) {
    const s = Math.sqrt(1 + y.y - x.x - z.z) * 2;
    q = {
      x: (y.x + x.y) / s,
      y: s / 4,
      z: (z.y + y.z) / s,
      w: (z.x - x.z) / s,
    };
  } else {
    const s = Math.sqrt(1 + z.z - x.x - y.y) * 2;
    q = {
      x: (z.x + x.z) / s,
      y: (z.y + y.z) / s,
      z: s / 4,
      w: (x.y - y.x) / s,
    };
  }
  return normalizedPhysicsPose({ position: { x: 0, y: 0, z: 0 }, rotation: q })
    .rotation;
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
    case "cylinder":
      return {
        kind: "cylinder",
        radius: shape.radius * xz,
        height: shape.height * sy,
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
        points: shape.points.map((p) => ({
          x: p.x * scale.x,
          y: p.y * scale.y,
        })),
      };
    case "chain":
      return {
        kind: "chain",
        points: shape.points.map((p) => ({
          x: p.x * scale.x,
          y: p.y * scale.y,
        })),
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
    case "mesh": {
      const positions = new Float32Array(shape.positions.length);
      for (let i = 0; i < positions.length; i += 3) {
        positions[i] = shape.positions[i]! * scale.x;
        positions[i + 1] = shape.positions[i + 1]! * scale.y;
        positions[i + 2] = shape.positions[i + 2]! * scale.z;
      }
      // Indices are immutable topology; scaled copies share them.
      return { kind: "mesh", positions, indices: shape.indices };
    }
  }
}
