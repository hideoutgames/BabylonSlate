import type { PhysicsBackend } from "./backend";
import { copyColliderDesc, linearSweepPoses, normalizedPhysicsPose } from "./collider-validation";
import { listDebugCollidersFromRecords } from "./debug-colliders";
import { isIdentityQuat, rotateQuatVec, multiplyQuat } from "./collider-bake";
import type {
  CharacterControllerDesc,
  CharacterMovementResult,
  BodyVelocity,
  ConstraintDesc,
  ColliderDesc,
  ColliderChanges,
  ColliderShape,
  HitResult,
  LineTraceOptions,
  OverlapResult,
  PhysicsContactEvent,
  PhysicsTransform,
  TeleportOptions,
  PhysicsWorldKind,
  RigidBodyDesc,
  RigidBodyTuning,
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
  grounded: boolean;
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

function colliderWorldPosition(desc: ColliderDesc, body: PhysicsTransform): Vec3 {
  const bodyPos = body.position;
  if (!desc.translation) return bodyPos;
  const offset = rotateQuatVec(body.rotation, desc.translation);
  return {
    x: bodyPos.x + offset.x,
    y: bodyPos.y + offset.y,
    z: bodyPos.z + offset.z,
  };
}

function aabbForCollider(
  desc: ColliderDesc,
  body: PhysicsTransform,
): { min: Vec3; max: Vec3 } {
  return aabbForShape(
    desc.shape,
    colliderWorldPosition(desc, body),
    desc.rotation ? multiplyQuat(body.rotation, desc.rotation) : body.rotation,
  );
}

function aabbForShape(
  shape: ColliderShape,
  position: Vec3,
  rotation?: { x: number; y: number; z: number; w: number },
): { min: Vec3; max: Vec3 } {
  const oriented = rotation && !isIdentityQuat(rotation);
  switch (shape.kind) {
    case "box": {
      const h = shape.halfExtents;
      if (!oriented) {
        return {
          min: vec(position.x - h.x, position.y - h.y, position.z - h.z),
          max: vec(position.x + h.x, position.y + h.y, position.z + h.z),
        };
      }
      return aabbFromLocalPoints(position, rotation, boxCorners(h.x, h.y, h.z));
    }
    case "box2d": {
      const h = shape.halfExtents;
      if (!oriented) {
        return planar(position, {
          min: vec(position.x - h.x, position.y - h.y),
          max: vec(position.x + h.x, position.y + h.y),
        });
      }
      return planar(position, aabbFromLocalPoints(
        position,
        rotation,
        boxCorners(h.x, h.y, 0),
      ));
    }
    case "sphere":
    case "circle": {
      const r = shape.radius;
      const box = {
        min: vec(position.x - r, position.y - r, position.z - r),
        max: vec(position.x + r, position.y + r, position.z + r),
      };
      return shape.kind === "circle" ? planar(position, box) : box;
    }
    case "capsule":
    case "capsule2d": {
      const r = shape.radius;
      const hh = shape.halfHeight;
      const segment = oriented
        ? aabbFromLocalPoints(position, rotation, [
            { x: 0, y: -hh, z: 0 },
            { x: 0, y: hh, z: 0 },
          ])
        : {
            min: vec(position.x, position.y - hh, position.z),
            max: vec(position.x, position.y + hh, position.z),
          };
      const box = {
        min: vec(segment.min.x - r, segment.min.y - r, segment.min.z - r),
        max: vec(segment.max.x + r, segment.max.y + r, segment.max.z + r),
      };
      return shape.kind === "capsule2d" ? planar(position, box) : box;
    }
    case "cylinder": {
      const r = shape.radius;
      const hh = shape.height / 2;
      const axis = oriented
        ? rotateQuatVec(rotation, { x: 0, y: 1, z: 0 })
        : { x: 0, y: 1, z: 0 };
      // The axis segment plus the end discs, whose radius spans r·√(1 − a²) on each world axis.
      const extent = (a: number) =>
        hh * Math.abs(a) + r * Math.sqrt(Math.max(0, 1 - a * a));
      const ex = extent(axis.x);
      const ey = extent(axis.y);
      const ez = extent(axis.z);
      return {
        min: vec(position.x - ex, position.y - ey, position.z - ez),
        max: vec(position.x + ex, position.y + ey, position.z + ez),
      };
    }
    case "convex":
    case "mesh": {
      const pts =
        shape.kind === "convex"
          ? shape.points
          : Array.from({ length: shape.positions.length / 3 }, (_, i) => ({
              x: shape.positions[i * 3]!,
              y: shape.positions[i * 3 + 1]!,
              z: shape.positions[i * 3 + 2]!,
            }));
      return aabbFromLocalPoints(
        position,
        oriented ? rotation : undefined,
        pts,
      );
    }
    case "polygon":
    case "chain": {
      const pts = shape.points.map((p) => ({ x: p.x, y: p.y, z: 0 }));
      return planar(position, aabbFromLocalPoints(
        position,
        oriented ? rotation : undefined,
        pts,
      ));
    }
  }
}

/** Every 2D shape is the same thin slab around its body's Z, whatever its planar size. */
const PLANAR_HALF_DEPTH = 0.01;

function planar(position: Vec3, box: { min: Vec3; max: Vec3 }): { min: Vec3; max: Vec3 } {
  return {
    min: vec(box.min.x, box.min.y, position.z - PLANAR_HALF_DEPTH),
    max: vec(box.max.x, box.max.y, position.z + PLANAR_HALF_DEPTH),
  };
}

function boxCorners(hx: number, hy: number, hz: number): Vec3[] {
  const points: Vec3[] = [];
  for (const x of [-hx, hx]) {
    for (const y of [-hy, hy]) {
      for (const z of [-hz, hz]) {
        points.push({ x, y, z });
      }
    }
  }
  return points;
}

function aabbFromLocalPoints(
  position: Vec3,
  rotation: { x: number; y: number; z: number; w: number } | undefined,
  points: readonly Vec3[],
): { min: Vec3; max: Vec3 } {
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (const p of points) {
    const rotated = rotation ? rotateQuatVec(rotation, p) : p;
    const x = position.x + rotated.x;
    const y = position.y + rotated.y;
    const z = position.z + rotated.z;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    minZ = Math.min(minZ, z);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
    maxZ = Math.max(maxZ, z);
  }
  if (!Number.isFinite(minX)) {
    return { min: { ...position }, max: { ...position } };
  }
  return { min: vec(minX, minY, minZ), max: vec(maxX, maxY, maxZ) };
}

function rayAabb(start: Vec3, dir: Vec3, min: Vec3, max: Vec3): { time: number; normal: Vec3 } | null {
  let tMin = 0;
  let tMax = 1;
  let normal = vec();
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
    if (t1 >= tMin) {
      tMin = t1;
      normal = vec();
      normal[axis] = d > 0 ? -1 : 1;
    }
    tMax = Math.min(tMax, t2);
    if (tMin > tMax) return null;
  }
  return { time: tMin, normal };
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
  readonly supportsConstraints = false;
  readonly kind: PhysicsWorldKind;
  private gravity: Vec3;
  private readonly bodies = new Map<string, BodyState>();
  private readonly colliders = new Map<string, ColliderState>();
  private readonly characters = new Map<string, CharacterState>();
  private previousOverlapKeys = new Set<string>();
  private disposed = false;

  constructor(kind: PhysicsWorldKind, gravity: Vec3) {
    this.kind = kind;
    this.gravity =
      kind === "2d" ? { x: gravity.x, y: gravity.y, z: 0 } : { ...gravity };
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

  createConstraint(desc: ConstraintDesc): never {
    void desc;
    throw new Error("Constraints require a native physics backend");
  }

  destroyConstraint(id: string): void { void id; }

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

  teleportBody(
    bodyId: string,
    transform: PhysicsTransform,
    options: TeleportOptions = {},
  ): void {
    const body = this.bodies.get(bodyId);
    if (!body) return;
    body.transform = normalizedPhysicsPose(transform);
    if (options.velocity === "reset") {
      body.linearVelocity = vec();
      body.angularVelocity = vec();
    }
  }

  setBodyTargetTransform(bodyId: string, transform: PhysicsTransform): void {
    const body = this.bodies.get(bodyId);
    if (!body) return;
    if (body.desc.motionType !== "kinematic")
      throw new Error("Only kinematic bodies accept motion targets");
    body.transform = normalizedPhysicsPose(transform);
  }

  getBodyTransform(bodyId: string): PhysicsTransform | null {
    const body = this.bodies.get(bodyId);
    return body ? cloneTransform(body.transform) : null;
  }

  getBodyVelocity(bodyId: string): BodyVelocity | null {
    const body = this.bodies.get(bodyId);
    // The approximate software solver treats its body origin as its mass center.
    return body ? { linear: { ...body.linearVelocity }, angular: { ...body.angularVelocity }, centerOfMass: { ...body.transform.position } } : null;
  }

  setBodyAngularVelocity(bodyId: string, velocity: Vec3): void {
    if (![velocity.x, velocity.y, velocity.z].every(Number.isFinite))
      throw new Error("Angular velocity must be finite");
    const body = this.bodies.get(bodyId);
    if (!body || body.desc.motionType !== "dynamic") return;
    body.angularVelocity = this.kind === "2d" ? { x: 0, y: 0, z: velocity.z } : { ...velocity };
  }

  setBodyLinearVelocity(bodyId: string, velocity: Partial<Vec3>): void {
    const body = this.bodies.get(bodyId);
    if (!body || body.desc.motionType !== "dynamic") return;
    for (const axis of ["x", "y", "z"] as const) {
      const value = velocity[axis];
      if (typeof value === "number" && Number.isFinite(value)) {
        body.linearVelocity[axis] =
          axis === "z" && this.kind === "2d" ? 0 : value;
      }
    }
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

  addImpulseAtPoint(bodyId: string, impulse: Vec3, point: Vec3): void {
    const body = this.bodies.get(bodyId);
    if (!body || body.desc.motionType !== "dynamic") return;
    if (![impulse.x, impulse.y, impulse.z, point.x, point.y, point.z].every(Number.isFinite)) return;
    this.addImpulse(bodyId, impulse);
    // The software fallback uses unit diagonal inertia; native backends use collider inertia.
    const r = { x: point.x - body.transform.position.x, y: point.y - body.transform.position.y, z: point.z - body.transform.position.z };
    const mass = Math.max(body.desc.mass, 1e-6);
    if (this.kind === "3d") {
      body.angularVelocity.x += (r.y * impulse.z - r.z * impulse.y) / mass;
      body.angularVelocity.y += (r.z * impulse.x - r.x * impulse.z) / mass;
    }
    body.angularVelocity.z += (r.x * impulse.y - r.y * impulse.x) / mass;
  }

  getBodyImpulseResponse(bodyId: string, impulse: Vec3, point: Vec3) {
    const body = this.bodies.get(bodyId);
    if (!body || body.desc.motionType !== "dynamic") return null;
    const mass = Math.max(body.desc.mass, 1e-6);
    const r = { x: point.x - body.transform.position.x, y: point.y - body.transform.position.y, z: point.z - body.transform.position.z };
    return {
      linear: { x: impulse.x / mass, y: impulse.y / mass, z: this.kind === "3d" ? impulse.z / mass : 0 },
      angular: {
        x: this.kind === "3d" ? (r.y * impulse.z - r.z * impulse.y) / mass : 0,
        y: this.kind === "3d" ? (r.z * impulse.x - r.x * impulse.z) / mass : 0,
        z: (r.x * impulse.y - r.y * impulse.x) / mass,
      },
      centerOfMass: { ...body.transform.position },
    };
  }

  updateBody(bodyId: string, tuning: RigidBodyTuning): void {
    const body = this.bodies.get(bodyId);
    if (!body) return;
    if (tuning.motionType) body.desc.motionType = tuning.motionType;
    if (typeof tuning.mass === "number" && Number.isFinite(tuning.mass)) {
      body.desc.mass = tuning.mass;
    }
    if (
      typeof tuning.linearDamping === "number" &&
      Number.isFinite(tuning.linearDamping)
    ) {
      body.desc.linearDamping = tuning.linearDamping;
    }
    if (
      typeof tuning.angularDamping === "number" &&
      Number.isFinite(tuning.angularDamping)
    ) {
      body.desc.angularDamping = tuning.angularDamping;
    }
    if (
      typeof tuning.gravityScale === "number" &&
      Number.isFinite(tuning.gravityScale)
    ) {
      body.desc.gravityScale = tuning.gravityScale;
    }
  }

  createCollider(desc: ColliderDesc): void {
    this.assertLive();
    if (this.kind === "2d" && isShape3D(desc.shape)) return;
    if (this.kind === "3d" && isShape2D(desc.shape)) return;
    this.applyColliderChanges(desc.bodyId, { upsert: [desc], remove: [] });
  }

  applyColliderChanges(bodyId: string, changes: ColliderChanges): void {
    this.assertLive();
    const prepared = changes.upsert.map(copyColliderDesc);
    if (new Set(prepared.map((desc) => desc.id)).size !== prepared.length)
      throw new Error("Duplicate collider upsert identity");
    for (const desc of prepared) {
      if (
        desc.bodyId !== bodyId ||
        (this.colliders.has(desc.id) &&
          this.colliders.get(desc.id)!.desc.bodyId !== bodyId)
      )
        throw new Error("Collider transaction crosses body ownership");
    }
    for (const id of changes.remove) {
      if (this.colliders.get(id)?.desc.bodyId === bodyId)
        this.colliders.delete(id);
    }
    for (const desc of prepared) this.colliders.set(desc.id, { desc });
  }

  destroyCollider(colliderId: string): void {
    this.colliders.delete(colliderId);
  }

  listDebugColliders() {
    return listDebugCollidersFromRecords(this.colliders.values(), (bodyId) =>
      this.bodies.get(bodyId)
        ? cloneTransform(this.bodies.get(bodyId)!.transform)
        : null,
    );
  }

  pollContacts(): PhysicsContactEvent[] {
    this.assertLive();
    const events: PhysicsContactEvent[] = [];
    const currentOverlap = new Set<string>();
    const hitKeys = new Set<string>();
    const list = [...this.colliders.values()];
    // Bodies do not move during a poll: a collider's box is built when its first pair needs it and shared by the rest.
    const boxes: Array<{ min: Vec3; max: Vec3 } | undefined> = new Array(list.length);
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const colliderA = list[i]!;
        const colliderB = list[j]!;
        if (!(colliderA.desc.layer & colliderB.desc.mask) || !(colliderB.desc.layer & colliderA.desc.mask)) continue;
        const bodyA = this.bodies.get(colliderA.desc.bodyId);
        const bodyB = this.bodies.get(colliderB.desc.bodyId);
        if (!bodyA || !bodyB || bodyA === bodyB) continue;
        // Contacts name each shape's owner, including hosted child shapes.
        let actorAId = colliderA.desc.actorId ?? bodyA.desc.actorId;
        let actorBId = colliderB.desc.actorId ?? bodyB.desc.actorId;
        if (actorAId === actorBId) continue;
        const boxA = (boxes[i] ??= aabbForCollider(colliderA.desc, bodyA.transform));
        const boxB = (boxes[j] ??= aabbForCollider(colliderB.desc, bodyB.transform));
        if (!aabbOverlap(boxA, boxB)) continue;
        let colliderAId = colliderA.desc.id;
        let colliderBId = colliderB.desc.id;
        const swapped = actorAId > actorBId;
        if (swapped) {
          const swapId = actorAId;
          actorAId = actorBId;
          actorBId = swapId;
          const swapCollider = colliderAId;
          colliderAId = colliderBId;
          colliderBId = swapCollider;
        }
        const key = `${actorAId}\t${colliderAId}\t${actorBId}\t${colliderBId}`;
        const isTrigger = colliderA.desc.isTrigger || colliderB.desc.isTrigger;
        if (isTrigger) {
          currentOverlap.add(key);
          if (!this.previousOverlapKeys.has(key))
            events.push({ kind: "overlapBegin", actorAId, actorBId, colliderAId, colliderBId });
        } else if (!hitKeys.has(key)) {
          hitKeys.add(key);
          const centerA = aabbCenter(swapped ? boxB : boxA);
          const centerB = aabbCenter(swapped ? boxA : boxB);
          const dx = centerB.x - centerA.x;
          const dy = centerB.y - centerA.y;
          const dz = centerB.z - centerA.z;
          const length = Math.hypot(dx, dy, dz);
          events.push({
            kind: "hit",
            actorAId,
            actorBId,
            colliderAId,
            colliderBId,
            location: {
              x: (centerA.x + centerB.x) * 0.5,
              y: (centerA.y + centerB.y) * 0.5,
              z: (centerA.z + centerB.z) * 0.5,
            },
            normal: length < 1e-8 ? { x: 0, y: 1, z: 0 } : { x: dx / length, y: dy / length, z: dz / length },
          });
        }
      }
    }
    for (const key of this.previousOverlapKeys) {
      if (currentOverlap.has(key)) continue;
      const [actorAId, colliderAId, actorBId, colliderBId] = key.split("\t");
      if (!actorAId || !actorBId) continue;
      events.push({ kind: "overlapEnd", actorAId, actorBId, colliderAId, colliderBId });
    }
    this.previousOverlapKeys = currentOverlap;
    return events;
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

      const angularDamp = Math.max(0, 1 - body.desc.angularDamping * dt);
      body.angularVelocity.x *= angularDamp;
      body.angularVelocity.y *= angularDamp;
      body.angularVelocity.z *= angularDamp;
      const speed = Math.hypot(body.angularVelocity.x, body.angularVelocity.y, body.angularVelocity.z);
      if (speed > 0) {
        const sine = Math.sin(speed * dt / 2) / speed;
        body.transform.rotation = multiplyQuat({ x: body.angularVelocity.x * sine, y: body.angularVelocity.y * sine,
          z: body.angularVelocity.z * sine, w: Math.cos(speed * dt / 2) }, body.transform.rotation);
      }

      body.transform.position.x += body.linearVelocity.x * dt;
      body.transform.position.y += body.linearVelocity.y * dt;
      if (this.kind === "3d") {
        body.transform.position.z += body.linearVelocity.z * dt;
      }
    }

    this.separateOverlaps();
  }

  /**
   * Pushes overlapping solid shapes apart along their least-penetrating axis,
   * for the same pairs that report contacts (layer/mask both ways, distinct
   * owners). Dynamic pairs share the correction by inverse mass; any approaching
   * velocity along that axis is removed. A box is rebuilt only after a
   * correction moves its body, so each correction sees the earlier ones.
   */
  private separateOverlaps(): void {
    const axes = this.kind === "3d" ? AXES_3D : AXES_2D;
    type Solid = {
      desc: ColliderDesc;
      body: BodyState;
      actorId: string;
      inverseMass: number;
      box: { min: Vec3; max: Vec3 } | null;
      boxMoves: number;
    };
    const solids: Solid[] = [];
    for (const collider of this.colliders.values()) {
      const body = this.bodies.get(collider.desc.bodyId);
      if (!body || collider.desc.isTrigger) continue;
      solids.push({
        desc: collider.desc,
        body,
        actorId: collider.desc.actorId ?? body.desc.actorId,
        inverseMass: body.desc.motionType === "dynamic" ? 1 / Math.max(body.desc.mass, 1e-6) : 0,
        box: null,
        boxMoves: 0,
      });
    }
    // Corrections applied to each body so far; a cached box from fewer is stale.
    const moves = new Map<BodyState, number>();
    const boxOf = (solid: Solid) => {
      const bodyMoves = moves.get(solid.body) ?? 0;
      if (!solid.box || solid.boxMoves !== bodyMoves) {
        solid.box = aabbForCollider(solid.desc, solid.body.transform);
        solid.boxMoves = bodyMoves;
      }
      return solid.box;
    };
    for (let i = 0; i < solids.length; i++) {
      const a = solids[i]!;
      if (a.inverseMass === 0) continue;
      for (let j = 0; j < solids.length; j++) {
        const b = solids[j]!;
        // A dynamic pair is visited once, from its earlier collider.
        if (j === i || (b.inverseMass > 0 && j < i)) continue;
        if (a.body === b.body || a.actorId === b.actorId) continue;
        if (!(a.desc.layer & b.desc.mask) || !(b.desc.layer & a.desc.mask)) continue;
        const separation = separationAxis(boxOf(a), boxOf(b), axes);
        if (!separation) continue;
        const { axis, sign, depth } = separation;
        const total = a.inverseMass + b.inverseMass;
        a.body.transform.position[axis] += (sign * depth * a.inverseMass) / total;
        b.body.transform.position[axis] -= (sign * depth * b.inverseMass) / total;
        moves.set(a.body, (moves.get(a.body) ?? 0) + 1);
        if (b.inverseMass > 0) moves.set(b.body, (moves.get(b.body) ?? 0) + 1);
        // Bodies that are not dynamic do not integrate a velocity here.
        const approach =
          sign * (a.body.linearVelocity[axis] - (b.inverseMass > 0 ? b.body.linearVelocity[axis] : 0));
        if (approach < 0) {
          const impulse = -approach / total;
          a.body.linearVelocity[axis] += sign * impulse * a.inverseMass;
          b.body.linearVelocity[axis] -= sign * impulse * b.inverseMass;
        }
      }
    }
  }

  lineTrace(start: Vec3, end: Vec3, options?: LineTraceOptions): HitResult {
    const dir = vec(end.x - start.x, end.y - start.y, end.z - start.z);
    const ignored = new Set(options?.ignoreActorIds);
    let bestT = Infinity;
    let best: HitResult = miss();
    for (const collider of this.colliders.values()) {
      const body = this.bodies.get(collider.desc.bodyId);
      if (!body) continue;
      const actorId = collider.desc.actorId ?? body.desc.actorId;
      if (ignored.has(actorId) || (options?.includeTriggers === false && collider.desc.isTrigger)) continue;
      const box = aabbForCollider(collider.desc, body.transform);
      const intersection = rayAabb(start, dir, box.min, box.max);
      if (!intersection) continue;
      const t = intersection.time;
      if (t < 0 || t > 1 || t >= bestT) continue;
      bestT = t;
      const location = vec(
        start.x + dir.x * t,
        start.y + dir.y * t,
        start.z + dir.z * t,
      );
      best = {
        hit: true,
        location,
        normal: intersection.normal,
        distance: Math.hypot(dir.x, dir.y, dir.z) * t,
        actorId,
        bodyId: body.desc.id,
      };
    }
    return best;
  }

  sphereOverlap(center: Vec3, radius: number, options?: LineTraceOptions): OverlapResult {
    const ignored = new Set(options?.ignoreActorIds);
    const actorIds: string[] = [];
    const bodyIds: string[] = [];
    // A body reports each shape owner once, however many of its shapes overlap.
    const reported = new Set<string>();
    for (const collider of this.colliders.values()) {
      const body = this.bodies.get(collider.desc.bodyId);
      if (!body) continue;
      const actorId = collider.desc.actorId ?? body.desc.actorId;
      if (ignored.has(actorId) || (options?.includeTriggers === false && collider.desc.isTrigger)) continue;
      const box = aabbForCollider(collider.desc, body.transform);
      const cx = Math.max(box.min.x, Math.min(center.x, box.max.x));
      const cy = Math.max(box.min.y, Math.min(center.y, box.max.y));
      const cz = Math.max(box.min.z, Math.min(center.z, box.max.z));
      const dx = center.x - cx;
      const dy = center.y - cy;
      // A 2D world has no depth, as in Rapier: only X/Y decide an overlap.
      const dz = this.kind === "2d" ? 0 : center.z - cz;
      if (!(dx * dx + dy * dy + dz * dz <= radius * radius)) continue;
      const key = `${body.desc.id}\t${actorId}`;
      if (!reported.has(key)) {
        reported.add(key);
        actorIds.push(actorId);
        bodyIds.push(body.desc.id);
      }
    }
    return { actorIds, bodyIds };
  }

  /**
   * Sweeps the shape's box (at its start rotation) against each collider's box:
   * the center traces the collider box grown by the shape's extents. An initial
   * overlap reports distance zero with the least-penetrating face's normal.
   */
  shapeSweep(
    shape: ColliderDesc["shape"],
    start: PhysicsTransform,
    end: PhysicsTransform,
    options?: LineTraceOptions,
  ): HitResult {
    const sweep = linearSweepPoses(start, end);
    if (!sweep) return miss();
    const from = sweep.start.position;
    const extents = aabbForShape(shape, vec(), sweep.start.rotation);
    const dir = vec(sweep.end.x - from.x, sweep.end.y - from.y, sweep.end.z - from.z);
    const ignored = new Set(options?.ignoreActorIds);
    const axes = this.kind === "3d" ? AXES_3D : AXES_2D;
    let bestT = Infinity;
    let best: HitResult = miss();
    for (const collider of this.colliders.values()) {
      const body = this.bodies.get(collider.desc.bodyId);
      if (!body) continue;
      const actorId = collider.desc.actorId ?? body.desc.actorId;
      if (ignored.has(actorId) || (options?.includeTriggers === false && collider.desc.isTrigger)) continue;
      const box = aabbForCollider(collider.desc, body.transform);
      const grown = {
        min: vec(box.min.x - extents.max.x, box.min.y - extents.max.y, box.min.z - extents.max.z),
        max: vec(box.max.x - extents.min.x, box.max.y - extents.min.y, box.max.z - extents.min.z),
      };
      const intersection = rayAabb(from, dir, grown.min, grown.max);
      if (!intersection || intersection.time >= bestT) continue;
      const t = intersection.time;
      const center = vec(from.x + dir.x * t, from.y + dir.y * t, from.z + dir.z * t);
      const location = vec(
        Math.max(box.min.x, Math.min(center.x, box.max.x)),
        Math.max(box.min.y, Math.min(center.y, box.max.y)),
        Math.max(box.min.z, Math.min(center.z, box.max.z)),
      );
      let normal = intersection.normal;
      if (t === 0) {
        const separation = separationAxis(
          { min: vec(from.x + extents.min.x, from.y + extents.min.y, from.z + extents.min.z),
            max: vec(from.x + extents.max.x, from.y + extents.max.y, from.z + extents.max.z) },
          box,
          axes,
        );
        if (separation) {
          normal = vec();
          normal[separation.axis] = separation.sign;
          location[separation.axis] = separation.sign > 0 ? box.max[separation.axis] : box.min[separation.axis];
        }
      }
      bestT = t;
      best = {
        hit: true,
        location,
        normal,
        distance: Math.hypot(dir.x, dir.y, dir.z) * t,
        actorId,
        bodyId: body.desc.id,
      };
    }
    return best;
  }

  createCharacterController(desc: CharacterControllerDesc): void {
    this.characters.set(desc.id, { desc: { ...desc }, grounded: false });
  }

  destroyCharacterController(id: string): void {
    this.characters.delete(id);
  }

  moveCharacter(
    id: string,
    translation: Vec3,
    dt: number,
    startPose?: PhysicsTransform,
  ): CharacterMovementResult | null {
    const character = this.characters.get(id);
    if (!character) return null;
    const body = this.bodies.get(character.desc.bodyId);
    if (!body || !Number.isFinite(dt) || dt < 0) return null;
    if (startPose) body.transform = normalizedPhysicsPose(startPose);
    // Discrete graph events can request a displacement before the first tick.
    const inverseDt = dt > 0 ? 1 / dt : 0;
    const before = { ...body.transform.position };
    // The controller's own shape, never a child shape that the body hosts.
    const self = [...this.colliders.values()].find((c) => c.desc.bodyId === body.desc.id && !c.desc.isTrigger &&
      (c.desc.actorId ?? body.desc.actorId) === body.desc.actorId);
    const obstacles = [...this.colliders.values()].flatMap((c) => {
      const other = this.bodies.get(c.desc.bodyId);
      if (!self || !other || c.desc.bodyId === body.desc.id || c.desc.isTrigger ||
        !(self.desc.layer & c.desc.mask) || !(c.desc.layer & self.desc.mask)) return [];
      return [aabbForCollider(c.desc, other.transform)];
    });
    const axes = this.kind === "3d" ? ["x", "z", "y"] as const : ["x", "y"] as const;
    if (self) for (const b of obstacles) {
      const a = aabbForCollider(self.desc, body.transform);
      if (!axes.every((axis) => a.min[axis] < b.max[axis] && a.max[axis] > b.min[axis])) continue;
      let recoveryAxis: "x" | "y" | "z" = "y";
      let recovery = Infinity;
      for (const axis of axes) {
        const negative = b.min[axis] - a.max[axis], positive = b.max[axis] - a.min[axis];
        const candidate = Math.abs(negative) < Math.abs(positive) ? negative : positive;
        if (Math.abs(candidate) < Math.abs(recovery)) { recovery = candidate; recoveryAxis = axis; }
      }
      body.transform.position[recoveryAxis] += recovery + Math.sign(recovery) * character.desc.offset;
    }
    // Swept AABB fallback: resolve each axis without tunnelling through thin walls.
    // Native backends retain capsule, slope and corner accuracy.
    for (const axis of axes) {
      let delta = translation[axis];
      const a = self && aabbForCollider(self.desc, body.transform);
      if (a) for (const b of obstacles) {
        const crossAxes = axes.filter((candidate) => candidate !== axis);
        if (!crossAxes.every((cross) => a.min[cross] < b.max[cross] - 1e-7 && a.max[cross] > b.min[cross] + 1e-7)) continue;
        if (delta > 0 && a.max[axis] <= b.min[axis] + 1e-7)
          delta = Math.min(delta, Math.max(0, b.min[axis] - a.max[axis] - character.desc.offset));
        else if (delta < 0 && a.min[axis] >= b.max[axis] - 1e-7)
          delta = Math.max(delta, Math.min(0, b.max[axis] - a.min[axis] + character.desc.offset));
      }
      body.transform.position[axis] += delta;
    }
    const a = self && aabbForCollider(self.desc, body.transform);
    const snap = character.desc.groundSnapDistance ?? 0.1;
    let grounded = false;
    if (translation.y <= 0 && a) {
      let closest = Infinity;
      for (const b of obstacles) {
        const gap = a.min.y - b.max.y;
        if (gap >= -1e-6 && a.min.x < b.max.x && a.max.x > b.min.x &&
          (this.kind === "2d" || (a.min.z < b.max.z && a.max.z > b.min.z))) closest = Math.min(closest, gap);
      }
      grounded = closest <= character.desc.offset + 1e-6;
      if (!grounded && character.grounded && closest <= snap + character.desc.offset) {
        body.transform.position.y -= Math.max(0, closest - character.desc.offset);
        grounded = true;
      }
    }
    character.grounded = grounded;
    return {
      ...cloneTransform(body.transform), grounded,
      velocity: {
        x: (body.transform.position.x - before.x) * inverseDt,
        y: (body.transform.position.y - before.y) * inverseDt,
        z: (body.transform.position.z - before.z) * inverseDt,
      },
    };
  }

  private assertLive(): void {
    if (this.disposed) throw new Error("SoftwarePhysicsBackend is disposed");
  }
}

function aabbCenter(box: { min: Vec3; max: Vec3 }): Vec3 {
  return {
    x: (box.min.x + box.max.x) * 0.5,
    y: (box.min.y + box.max.y) * 0.5,
    z: (box.min.z + box.max.z) * 0.5,
  };
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

const AXES_3D = ["x", "y", "z"] as const;
const AXES_2D = ["x", "y"] as const;

/**
 * The least-penetrating axis of two overlapping boxes, and the direction
 * (`sign`) that moves `a` out of `b` by `depth`. Null when they do not overlap.
 */
function separationAxis(
  a: { min: Vec3; max: Vec3 },
  b: { min: Vec3; max: Vec3 },
  axes: readonly ("x" | "y" | "z")[],
): { axis: "x" | "y" | "z"; sign: 1 | -1; depth: number } | null {
  if (!aabbOverlap(a, b)) return null;
  let best: { axis: "x" | "y" | "z"; sign: 1 | -1; depth: number } | null = null;
  for (const axis of axes) {
    const up = b.max[axis] - a.min[axis];
    const down = a.max[axis] - b.min[axis];
    const candidate = up <= down
      ? { axis, sign: 1 as const, depth: up }
      : { axis, sign: -1 as const, depth: down };
    if (!best || candidate.depth < best.depth) best = candidate;
  }
  return best && best.depth > 0 ? best : null;
}

function isShape3D(shape: ColliderShape): boolean {
  return (
    shape.kind === "box" ||
    shape.kind === "sphere" ||
    shape.kind === "capsule" ||
    shape.kind === "cylinder" ||
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
