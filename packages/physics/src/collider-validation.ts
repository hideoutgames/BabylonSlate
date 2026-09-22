import type {
  ColliderDesc,
  ColliderShape,
  PhysicsTransform,
  Vec3,
} from "./types";

function finiteVector(value: Vec3): boolean {
  return (
    Number.isFinite(value.x) &&
    Number.isFinite(value.y) &&
    Number.isFinite(value.z)
  );
}

/** Copies and normalizes at the command boundary; caller mutations cannot change pending work. */
export function normalizedPhysicsPose(
  pose: PhysicsTransform,
): PhysicsTransform {
  const q = pose.rotation;
  const length = Math.hypot(q.x, q.y, q.z, q.w);
  if (
    !finiteVector(pose.position) ||
    !Number.isFinite(length) ||
    length < 1e-12
  ) {
    throw new Error(
      "Physics pose must contain a finite position and a nonzero quaternion",
    );
  }
  return {
    position: { ...pose.position },
    rotation: {
      x: q.x / length,
      y: q.y / length,
      z: q.z / length,
      w: q.w / length,
    },
  };
}

export function copyColliderDesc(desc: ColliderDesc): ColliderDesc {
  const pose = normalizedPhysicsPose({
    position: desc.translation ?? { x: 0, y: 0, z: 0 },
    rotation: desc.rotation ?? { x: 0, y: 0, z: 0, w: 1 },
  });
  validateColliderShape(desc.shape);
  if (
    ![desc.friction, desc.restitution, desc.layer, desc.mask].every(
      Number.isFinite,
    )
  ) {
    throw new Error("Collider tuning must be finite");
  }
  return {
    ...desc,
    shape: structuredClone(desc.shape),
    translation: pose.position,
    rotation: pose.rotation,
  };
}

export function validateColliderShape(shape: ColliderShape): void {
  const positive = (...values: number[]) => {
    if (!values.every((v) => Number.isFinite(v) && v > 0))
      throw new Error("Collider dimensions must be finite and positive");
  };
  switch (shape.kind) {
    case "box":
      positive(shape.halfExtents.x, shape.halfExtents.y, shape.halfExtents.z);
      break;
    case "box2d":
      positive(shape.halfExtents.x, shape.halfExtents.y);
      break;
    case "sphere":
    case "circle":
      positive(shape.radius);
      break;
    case "capsule":
    case "capsule2d":
      positive(shape.radius);
      if (!Number.isFinite(shape.halfHeight) || shape.halfHeight < 0)
        throw new Error("Invalid capsule half height");
      break;
    case "cylinder":
      positive(shape.radius, shape.height);
      break;
    case "convex": {
      const points = shape.points;
      if (points.length < 4 || !points.every(finiteVector))
        throw new Error("Convex collider requires finite volumetric points");
      const a = points[0]!;
      const b = points.find(
        (p) => Math.hypot(p.x - a.x, p.y - a.y, p.z - a.z) > 1e-10,
      );
      if (!b) throw new Error("Degenerate convex collider");
      const u = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
      let normal: Vec3 | undefined;
      for (const c of points) {
        const v = { x: c.x - a.x, y: c.y - a.y, z: c.z - a.z };
        const n = {
          x: u.y * v.z - u.z * v.y,
          y: u.z * v.x - u.x * v.z,
          z: u.x * v.y - u.y * v.x,
        };
        if (Math.hypot(n.x, n.y, n.z) > 1e-10) {
          normal = n;
          break;
        }
      }
      if (
        !normal ||
        !points.some(
          (p) =>
            Math.abs(
              normal!.x * (p.x - a.x) +
                normal!.y * (p.y - a.y) +
                normal!.z * (p.z - a.z),
            ) > 1e-10,
        )
      ) {
        throw new Error("Degenerate convex collider");
      }
      break;
    }
    case "mesh": {
      if (
        shape.vertices.length < 3 ||
        !shape.vertices.every(finiteVector) ||
        shape.indices.length < 3 ||
        shape.indices.length % 3 !== 0 ||
        !shape.indices.every(
          (i) => Number.isInteger(i) && i >= 0 && i < shape.vertices.length,
        )
      )
        throw new Error("Invalid triangle mesh collider");
      for (let i = 0; i < shape.indices.length; i += 3) {
        const a = shape.vertices[shape.indices[i]!]!,
          b = shape.vertices[shape.indices[i + 1]!]!,
          c = shape.vertices[shape.indices[i + 2]!]!;
        const ux = b.x - a.x,
          uy = b.y - a.y,
          uz = b.z - a.z,
          vx = c.x - a.x,
          vy = c.y - a.y,
          vz = c.z - a.z;
        if (
          Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) <
          1e-12
        )
          throw new Error("Degenerate collider triangle");
      }
      break;
    }
    case "polygon":
    case "chain":
      if (
        shape.points.length < (shape.kind === "polygon" ? 3 : 2) ||
        !shape.points.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))
      )
        throw new Error("Invalid planar collider points");
      break;
  }
}

/** Only used at a mutation boundary, never for unchanged simulation ticks. */
export function sameColliderGeometry(
  a: ColliderShape,
  b: ColliderShape,
): boolean {
  if (a === b) return true;
  if (a.kind !== b.kind) return false;
  const samePoints = (p: readonly Vec3[], q: readonly Vec3[]) =>
    p.length === q.length &&
    p.every((v, i) => v.x === q[i]!.x && v.y === q[i]!.y && v.z === q[i]!.z);
  switch (a.kind) {
    case "box": {
      const other = b as typeof a;
      return (
        a.halfExtents.x === other.halfExtents.x &&
        a.halfExtents.y === other.halfExtents.y &&
        a.halfExtents.z === other.halfExtents.z
      );
    }
    case "box2d": {
      const other = b as typeof a;
      return (
        a.halfExtents.x === other.halfExtents.x &&
        a.halfExtents.y === other.halfExtents.y
      );
    }
    case "sphere":
    case "circle":
      return a.radius === (b as typeof a).radius;
    case "capsule":
    case "capsule2d": {
      const other = b as typeof a;
      return a.radius === other.radius && a.halfHeight === other.halfHeight;
    }
    case "cylinder": {
      const other = b as typeof a;
      return a.radius === other.radius && a.height === other.height;
    }
    case "convex":
      return samePoints(a.points, (b as typeof a).points);
    case "mesh": {
      const other = b as typeof a;
      return (
        samePoints(a.vertices, other.vertices) &&
        a.indices.length === other.indices.length &&
        a.indices.every((v, i) => v === other.indices[i])
      );
    }
    case "polygon":
    case "chain": {
      const other = b as typeof a;
      return (
        (a.kind !== "chain" || a.loop === (other as typeof a).loop) &&
        a.points.length === other.points.length &&
        a.points.every(
          (p, i) => p.x === other.points[i]!.x && p.y === other.points[i]!.y,
        )
      );
    }
  }
}

export function sameColliderPose(a: ColliderDesc, b: ColliderDesc): boolean {
  const p = a.translation!,
    q = b.translation!,
    r = a.rotation!,
    s = b.rotation!;
  return (
    p.x === q.x &&
    p.y === q.y &&
    p.z === q.z &&
    r.x === s.x &&
    r.y === s.y &&
    r.z === s.z &&
    r.w === s.w
  );
}

export function identityColliderPose(desc: ColliderDesc): boolean {
  const p = desc.translation!,
    q = desc.rotation!;
  return (
    p.x === 0 &&
    p.y === 0 &&
    p.z === 0 &&
    q.x === 0 &&
    q.y === 0 &&
    q.z === 0 &&
    Math.abs(q.w) === 1
  );
}
