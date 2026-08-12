import type { PhysicsBackend } from "./backend";
import type {
  CharacterControllerDesc,
  ColliderDesc,
  ColliderShape,
  HitResult,
  MotionType,
  OverlapResult,
  PhysicsTransform,
  PhysicsWorldKind,
  RigidBodyDesc,
  Vec3,
} from "./types";

type BodyState = {
  desc: RigidBodyDesc;
  transform: PhysicsTransform;
  linearVelocity: Vec3;
  angularVelocity: Vec3;
};

type ColliderState = {
  desc: ColliderDesc;
};

type CharacterState = {
  desc: CharacterControllerDesc;
};

const IDENTITY_ROT: PhysicsTransform["rotation"] = {
  x: 0,
  y: 0,
  z: 0,
  w: 1,
};

function vec(x = 0, y = 0, z = 0): Vec3 {
  return { x, y, z };
}

function cloneTransform(t: PhysicsTransform): PhysicsTransform {
  return {
    position: { ...t.position },
    rotation: { ...t.rotation },
  };
}

function aabbForShape(
  shape: ColliderShape,
  position: Vec3,
): { min: Vec3; max: Vec3 } {
  switch (shape.kind) {
    case "box": {
      const h = shape.halfExtents;
      return {
        min: vec(position.x - h.x, position.y - h.y, position.z - h.z),
        max: vec(position.x + h.x, position.y + h.y, position.z + h.z),
      };
    }
    case "box2d": {
      const h = shape.halfExtents;
      return {
        min: vec(position.x - h.x, position.y - h.y, position.z - 0.01),
        max: vec(position.x + h.x, position.y + h.y, position.z + 0.01),
      };
    }
    case "sphere":
    case "circle": {
      const r = shape.radius;
      return {
        min: vec(position.x - r, position.y - r, position.z - r),
        max: vec(position.x + r, position.y + r, position.z + r),
      };
    }
    case "capsule":
    case "capsule2d": {
      const r = shape.radius;
      const hh = shape.halfHeight;
      return {
        min: vec(position.x - r, position.y - hh - r, position.z - r),
        max: vec(position.x + r, position.y + hh + r, position.z + r),
      };
    }
    case "convex":
    case "mesh": {
      const pts = shape.kind === "convex" ? shape.points : shape.vertices;
      let minX = Infinity;
      let minY = Infinity;
      let minZ = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      let maxZ = -Infinity;
      for (const p of pts) {
        minX = Math.min(minX, position.x + p.x);
        minY = Math.min(minY, position.y + p.y);
        minZ = Math.min(minZ, position.z + p.z);
        maxX = Math.max(maxX, position.x + p.x);
        maxY = Math.max(maxY, position.y + p.y);
        maxZ = Math.max(maxZ, position.z + p.z);
      }
      if (!Number.isFinite(minX)) {
        return { min: { ...position }, max: { ...position } };
      }
      return {
        min: vec(minX, minY, minZ),
        max: vec(maxX, maxY, maxZ),
      };
    }
    case "polygon":
    case "chain": {
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const p of shape.points) {
        minX = Math.min(minX, position.x + p.x);
        minY = Math.min(minY, position.y + p.y);
        maxX = Math.max(maxX, position.x + p.x);
        maxY = Math.max(maxY, position.y + p.y);
      }
      if (!Number.isFinite(minX)) {
        return {
          min: vec(position.x, position.y, position.z - 0.01),
          max: vec(position.x, position.y, position.z + 0.01),
        };
      }
      return {
        min: vec(minX, minY, position.z - 0.01),
        max: vec(maxX, maxY, position.z + 0.01),
      };
    }
  }
}

function rayAabb(
  start: Vec3,
  dir: Vec3,
  min: Vec3,
  max: Vec3,
): number | null {
  let tMin = 0;
  let tMax = 1;
  const axes: Array<"x" | "y" | "z"> = ["x", "y", "z"];
  for (const axis of axes) {
    const origin = start[axis];
    const d = dir[axis];
    const mn = min[axis];
    const mx = max[axis];
    if (Math.abs(d) < 1e-12) {
      if (origin < mn || origin > mx) return null;
      continue;
    }
    let t1 = (mn - origin) / d;
    let t2 = (mx - origin) / d;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
    }
    tMin = Math.max(tMin, t1);
    tMax = Math.min(tMax, t2);
    if (tMin > tMax) return null;
  }
  return tMin;
}

function miss(): HitResult {
  return {
    hit: false,
    location: null,
    normal: null,
    distance: 0,
    actorId: null,
    bodyId: null,
  };
}

/**
 * Deterministic AABB physics used for harness goldens and as a wasm-free backend.
 * Supports both 3d and 2d worlds (2d zeros Z velocity / gravity Z).
 */
export class SoftwarePhysicsBackend implements PhysicsBackend {
  readonly kind: PhysicsWorldKind;
  private gravity: Vec3;
  private readonly bodies = new Map<string, BodyState>();
  private readonly colliders = new Map<string, ColliderState>();
  private readonly characters = new Map<string, CharacterState>();
  private disposed = false;

  constructor(kind: PhysicsWorldKind, gravity: Vec3) {
    this.kind = kind;
    this.gravity =
      kind === "2d"
        ? { x: gravity.x, y: gravity.y, z: 0 }
        : { ...gravity };
  }

  dispose(): void {
    this.disposed = true;
    this.bodies.clear();
    this.colliders.clear();
    this.characters.clear();
  }

  setGravity(gravity: Vec3): void {
    this.gravity =
      this.kind === "2d"
        ? { x: gravity.x, y: gravity.y, z: 0 }
        : { ...gravity };
  }

  createBody(desc: RigidBodyDesc): void {
    this.assertLive();
    this.bodies.set(desc.id, {
      desc: { ...desc, transform: cloneTransform(desc.transform) },
      transform: cloneTransform(desc.transform),
      linearVelocity: vec(),
      angularVelocity: vec(),
    });
  }

  destroyBody(bodyId: string): void {
    this.bodies.delete(bodyId);
    for (const [id, collider] of [...this.colliders]) {
      if (collider.desc.bodyId === bodyId) this.colliders.delete(id);
    }
    for (const [id, character] of [...this.characters]) {
      if (character.desc.bodyId === bodyId) this.characters.delete(id);
    }
  }

  setBodyTransform(bodyId: string, transform: PhysicsTransform): void {
    const body = this.bodies.get(bodyId);
    if (!body) return;
    body.transform = cloneTransform(transform);
  }

  getBodyTransform(bodyId: string): PhysicsTransform | null {
    const body = this.bodies.get(bodyId);
    return body ? cloneTransform(body.transform) : null;
  }

  setBodyMotionType(bodyId: string, motionType: MotionType): void {
    const body = this.bodies.get(bodyId);
    if (!body) return;
    body.desc.motionType = motionType;
  }

  addImpulse(bodyId: string, impulse: Vec3, strength = 1): void {
    const body = this.bodies.get(bodyId);
    if (!body || body.desc.motionType !== "dynamic") return;
    const mass = Math.max(body.desc.mass, 1e-6);
    const s = strength / mass;
    body.linearVelocity.x += impulse.x * s;
    body.linearVelocity.y += impulse.y * s;
    body.linearVelocity.z += this.kind === "2d" ? 0 : impulse.z * s;
  }

  createCollider(desc: ColliderDesc): void {
    this.assertLive();
    if (this.kind === "2d" && isShape3D(desc.shape)) return;
    if (this.kind === "3d" && isShape2D(desc.shape)) return;
    this.colliders.set(desc.id, { desc: { ...desc } });
  }

  destroyCollider(colliderId: string): void {
    this.colliders.delete(colliderId);
  }

  step(dt: number): void {
    this.assertLive();
    if (dt <= 0) return;
    for (const body of this.bodies.values()) {
      if (body.desc.motionType !== "dynamic") continue;
      const gScale = body.desc.gravityScale;
      body.linearVelocity.x += this.gravity.x * gScale * dt;
      body.linearVelocity.y += this.gravity.y * gScale * dt;
      if (this.kind === "3d") {
        body.linearVelocity.z += this.gravity.z * gScale * dt;
      } else {
        body.linearVelocity.z = 0;
      }
      const damp = Math.max(0, 1 - body.desc.linearDamping * dt);
      body.linearVelocity.x *= damp;
      body.linearVelocity.y *= damp;
      body.linearVelocity.z *= damp;

      body.transform.position.x += body.linearVelocity.x * dt;
      body.transform.position.y += body.linearVelocity.y * dt;
      if (this.kind === "3d") {
        body.transform.position.z += body.linearVelocity.z * dt;
      }
    }

    // Resolve dynamic vs static AABB overlaps with simple positional correction.
    for (const collider of this.colliders.values()) {
      if (collider.desc.isTrigger) continue;
      const body = this.bodies.get(collider.desc.bodyId);
      if (!body || body.desc.motionType !== "dynamic") continue;
      const a = aabbForShape(collider.desc.shape, body.transform.position);
      for (const other of this.colliders.values()) {
        if (other.desc.id === collider.desc.id || other.desc.isTrigger) continue;
        const otherBody = this.bodies.get(other.desc.bodyId);
        if (!otherBody || otherBody.desc.motionType === "dynamic") continue;
        const b = aabbForShape(
          other.desc.shape,
          otherBody.transform.position,
        );
        if (!aabbOverlap(a, b)) continue;
        const overlapY = Math.min(a.max.y, b.max.y) - Math.max(a.min.y, b.min.y);
        if (overlapY > 0 && body.linearVelocity.y <= 0) {
          body.transform.position.y += overlapY;
          body.linearVelocity.y = 0;
        }
      }
    }
  }

  readTransforms(): ReadonlyMap<string, PhysicsTransform> {
    const out = new Map<string, PhysicsTransform>();
    for (const [id, body] of this.bodies) {
      out.set(id, cloneTransform(body.transform));
    }
    return out;
  }

  lineTrace(start: Vec3, end: Vec3): HitResult {
    const dir = vec(end.x - start.x, end.y - start.y, end.z - start.z);
    let bestT = Infinity;
    let best: HitResult = miss();
    for (const collider of this.colliders.values()) {
      const body = this.bodies.get(collider.desc.bodyId);
      if (!body) continue;
      const box = aabbForShape(collider.desc.shape, body.transform.position);
      const t = rayAabb(start, dir, box.min, box.max);
      if (t === null || t < 0 || t > 1 || t >= bestT) continue;
      bestT = t;
      const location = vec(
        start.x + dir.x * t,
        start.y + dir.y * t,
        start.z + dir.z * t,
      );
      best = {
        hit: true,
        location,
        normal: vec(0, 1, 0),
        distance: Math.hypot(dir.x, dir.y, dir.z) * t,
        actorId: body.desc.actorId,
        bodyId: body.desc.id,
      };
    }
    return best;
  }

  sphereOverlap(center: Vec3, radius: number): OverlapResult {
    const actorIds: string[] = [];
    const bodyIds: string[] = [];
    for (const collider of this.colliders.values()) {
      const body = this.bodies.get(collider.desc.bodyId);
      if (!body) continue;
      const box = aabbForShape(collider.desc.shape, body.transform.position);
      const cx = Math.max(box.min.x, Math.min(center.x, box.max.x));
      const cy = Math.max(box.min.y, Math.min(center.y, box.max.y));
      const cz = Math.max(box.min.z, Math.min(center.z, box.max.z));
      const dx = center.x - cx;
      const dy = center.y - cy;
      const dz = center.z - cz;
      if (dx * dx + dy * dy + dz * dz <= radius * radius) {
        actorIds.push(body.desc.actorId);
        bodyIds.push(body.desc.id);
      }
    }
    return { actorIds, bodyIds };
  }

  shapeSweep(
    shape: ColliderDesc["shape"],
    start: PhysicsTransform,
    end: PhysicsTransform,
  ): HitResult {
    // Approximate sweep as a line trace from start to end using shape AABB radius.
    const box = aabbForShape(shape, start.position);
    const radius = Math.max(
      box.max.x - box.min.x,
      box.max.y - box.min.y,
      box.max.z - box.min.z,
    ) * 0.5;
    const midStart = start.position;
    const hit = this.lineTrace(midStart, end.position);
    if (!hit.hit || !hit.location) return hit;
    // Inflate: if we would overlap at end, report hit.
    const overlap = this.sphereOverlap(end.position, radius);
    if (overlap.bodyIds.length === 0) {
      // Still report geometry hit along the path.
      return hit;
    }
    return hit;
  }

  createCharacterController(desc: CharacterControllerDesc): void {
    if (this.kind !== "2d") return;
    this.characters.set(desc.id, { desc: { ...desc } });
  }

  destroyCharacterController(id: string): void {
    this.characters.delete(id);
  }

  moveCharacter(
    id: string,
    translation: Vec3,
    _dt: number,
  ): PhysicsTransform | null {
    const character = this.characters.get(id);
    if (!character) return null;
    const body = this.bodies.get(character.desc.bodyId);
    if (!body) return null;
    body.transform.position.x += translation.x;
    body.transform.position.y += translation.y;
    if (this.kind === "3d") body.transform.position.z += translation.z;
    // Slide against static AABBs.
    for (const collider of this.colliders.values()) {
      if (collider.desc.bodyId === body.desc.id || collider.desc.isTrigger) {
        continue;
      }
      const other = this.bodies.get(collider.desc.bodyId);
      if (!other || other.desc.motionType === "dynamic") continue;
      const selfCollider = [...this.colliders.values()].find(
        (c) => c.desc.bodyId === body.desc.id,
      );
      if (!selfCollider) continue;
      const a = aabbForShape(selfCollider.desc.shape, body.transform.position);
      const b = aabbForShape(collider.desc.shape, other.transform.position);
      if (!aabbOverlap(a, b)) continue;
      const overlapX =
        Math.min(a.max.x, b.max.x) - Math.max(a.min.x, b.min.x);
      const overlapY =
        Math.min(a.max.y, b.max.y) - Math.max(a.min.y, b.min.y);
      if (overlapX < overlapY) {
        body.transform.position.x +=
          a.min.x < b.min.x ? -overlapX : overlapX;
      } else {
        body.transform.position.y +=
          a.min.y < b.min.y ? -overlapY : overlapY;
      }
    }
    return cloneTransform(body.transform);
  }

  private assertLive(): void {
    if (this.disposed) throw new Error("SoftwarePhysicsBackend is disposed");
  }
}

function aabbOverlap(
  a: { min: Vec3; max: Vec3 },
  b: { min: Vec3; max: Vec3 },
): boolean {
  return (
    a.min.x <= b.max.x &&
    a.max.x >= b.min.x &&
    a.min.y <= b.max.y &&
    a.max.y >= b.min.y &&
    a.min.z <= b.max.z &&
    a.max.z >= b.min.z
  );
}

function isShape3D(shape: ColliderShape): boolean {
  return (
    shape.kind === "box" ||
    shape.kind === "sphere" ||
    shape.kind === "capsule" ||
    shape.kind === "convex" ||
    shape.kind === "mesh"
  );
}

function isShape2D(shape: ColliderShape): boolean {
  return (
    shape.kind === "box2d" ||
    shape.kind === "circle" ||
    shape.kind === "capsule2d" ||
    shape.kind === "polygon" ||
    shape.kind === "chain"
  );
}

export function createNullPhysicsBackend(
  kind: PhysicsWorldKind = "3d",
): PhysicsBackend {
  return new SoftwarePhysicsBackend(kind, { x: 0, y: 0, z: 0 });
}
