import type {
  InteractionGroups,
  ImpulseJoint,
  JointData,
  RevoluteImpulseJoint,
  QueryFilterFlags,
  PhysicsHooks,
} from "@dimforge/rapier2d-compat";
import type { PhysicsBackend } from "./backend";
import type {
  CharacterControllerDesc,
  CharacterMovementResult,
  BodyVelocity,
  ConstraintDesc,
  ColliderDesc,
  ColliderChanges,
  HitResult,
  LineTraceOptions,
  OverlapResult,
  PhysicsBackendOptions,
  PhysicsTransform,
  TeleportOptions,
  RigidBodyDesc,
  RigidBodyTuning,
  Vec3,
  PhysicsContactEvent,
} from "./types";
import { listDebugCollidersFromRecords } from "./debug-colliders";
import { quatToPlanarAngle } from "./collider-bake";
import { copyColliderDesc, normalizedPhysicsPose } from "./collider-validation";
import { copyConstraintDesc } from "./constraint-validation";

type RapierEventQueue = {
  drainCollisionEvents(
    f: (handle1: number, handle2: number, started: boolean) => void,
  ): void;
  free(): void;
};

type RapierApi = {
  init(): Promise<void>;
  EventQueue: new (autoDrain: boolean) => RapierEventQueue;
  ActiveEvents: { COLLISION_EVENTS: number };
  ActiveCollisionTypes: { ALL: number };
  ActiveHooks: { FILTER_CONTACT_PAIRS: number; FILTER_INTERSECTION_PAIRS: number };
  SolverFlags: { COMPUTE_IMPULSE: number };
  World: new (gravity: { x: number; y: number }) => {
    gravity: { x: number; y: number };
    timestep: number;
    step(eventQueue?: RapierEventQueue, hooks?: PhysicsHooks): void;
    propagateModifiedBodyPositionsToColliders(): void;
    updateSceneQueries(): void;
    free(): void;
    createRigidBody(desc: unknown): RapierRigidBody;
    removeRigidBody(body: RapierRigidBody): void;
    createImpulseJoint(desc: JointData, bodyA: RapierRigidBody, bodyB: RapierRigidBody, wakeUp: boolean): ImpulseJoint;
    removeImpulseJoint(joint: ImpulseJoint, wakeUp: boolean): void;
    createCollider(desc: unknown, body: RapierRigidBody): RapierCollider;
    removeCollider(collider: RapierCollider, wakeUp: boolean): void;
    createCharacterController(offset: number): RapierCharacterController;
    removeCharacterController(controller: RapierCharacterController): void;
    castRayAndGetNormal(
      ray: unknown,
      maxToi: number,
      solid: boolean,
      filterFlags?: QueryFilterFlags,
      filterGroups?: InteractionGroups,
      filterExcludeCollider?: RapierCollider,
      filterExcludeRigidBody?: RapierRigidBody,
      filterPredicate?: (collider: RapierCollider) => boolean,
    ): { timeOfImpact: number; collider: RapierCollider; normal: { x: number; y: number } } | null;
    intersectionsWithPoint(
      point: { x: number; y: number },
      callback: (collider: RapierCollider) => boolean,
    ): void;
    intersectionsWithShape(
      position: { x: number; y: number },
      rotation: number,
      shape: unknown,
      callback: (collider: RapierCollider) => boolean,
    ): void;
  };
  RigidBodyDesc: {
    fixed(): RapierBodyDesc;
    kinematicPositionBased(): RapierBodyDesc;
    dynamic(): RapierBodyDesc;
  };
  JointData: typeof JointData;
  RigidBodyType: {
    Fixed: number;
    KinematicPositionBased: number;
    Dynamic: number;
  };
  ColliderDesc: {
    cuboid(hx: number, hy: number): RapierColliderDesc;
    ball(radius: number): RapierColliderDesc;
    capsule(halfHeight: number, radius: number): RapierColliderDesc;
    convexHull(points: Float32Array): RapierColliderDesc | null;
    polyline(points: Float32Array, indices?: Uint32Array): RapierColliderDesc;
  };
  Ray: new (
    origin: { x: number; y: number },
    dir: { x: number; y: number },
  ) => { pointAt(toi: number): { x: number; y: number } };
  Ball: new (radius: number) => unknown;
};

type RapierBodyDesc = {
  setTranslation(x: number, y: number): RapierBodyDesc;
  setRotation(angle: number): RapierBodyDesc;
  setLinearDamping(v: number): RapierBodyDesc;
  setAngularDamping(v: number): RapierBodyDesc;
  setGravityScale(v: number): RapierBodyDesc;
  setAdditionalMass(v: number): RapierBodyDesc;
};

type RapierColliderDesc = {
  setFriction(v: number): RapierColliderDesc;
  setRestitution(v: number): RapierColliderDesc;
  setSensor(v: boolean): RapierColliderDesc;
  setTranslation(x: number, y: number): RapierColliderDesc;
  setRotation(angle: number): RapierColliderDesc;
  setActiveEvents(events: number): RapierColliderDesc;
  setActiveCollisionTypes(types: number): RapierColliderDesc;
  setActiveHooks(hooks: number): RapierColliderDesc;
  setDensity(density: number): RapierColliderDesc;
};

type RapierRigidBody = {
  handle: number;
  translation(): { x: number; y: number };
  linvel(): { x: number; y: number };
  angvel(): number;
  worldCom(): { x: number; y: number };
  setLinvel(velocity: { x: number; y: number }, wakeUp: boolean): void;
  setTranslation(t: { x: number; y: number }, wakeUp: boolean): void;
  rotation(): number;
  setRotation(angle: number, wakeUp: boolean): void;
  setAngvel(velocity: number, wakeUp: boolean): void;
  setBodyType(type: number, wakeUp: boolean): void;
  applyImpulse(impulse: { x: number; y: number }, wakeUp: boolean): void;
  applyImpulseAtPoint(impulse: { x: number; y: number }, point: { x: number; y: number }, wakeUp: boolean): void;
  setNextKinematicTranslation(t: { x: number; y: number }): void;
  setNextKinematicRotation(angle: number): void;
  setGravityScale(scale: number, wakeUp: boolean): void;
  setLinearDamping(damping: number): void;
  setAngularDamping(damping: number): void;
  setAdditionalMass(mass: number, wakeUp: boolean): void;
};

type RapierCollider = {
  handle: number;
  parent(): RapierRigidBody | null;
  translation(): { x: number; y: number };
  setSensor(isSensor: boolean): void;
  setFriction(friction: number): void;
  setRestitution(restitution: number): void;
};

type RapierCharacterController = {
  computeColliderMovement(
    collider: RapierCollider,
    desired: { x: number; y: number },
    filterFlags?: QueryFilterFlags,
    filterGroups?: InteractionGroups,
    filterPredicate?: (collider: RapierCollider) => boolean,
  ): void;
  computedMovement(): { x: number; y: number };
  computedGrounded(): boolean;
  setMaxSlopeClimbAngle(angle: number): void;
  setMinSlopeSlideAngle(angle: number): void;
  enableSnapToGround(distance: number): void;
};

type BodyRecord = {
  desc: RigidBodyDesc;
  body: RapierRigidBody;
};

type ColliderRecord = {
  desc: ColliderDesc;
  collider: RapierCollider;
  extra?: RapierCollider;
};

type CharacterRecord = {
  desc: CharacterControllerDesc;
  controller: RapierCharacterController;
};

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

function identityRotation(): PhysicsTransform["rotation"] {
  return { x: 0, y: 0, z: 0, w: 1 };
}

/**
 * Rapier 2D backend. Loaded only for scenes that declare `physicsWorld: "2d"`.
 */
export class Rapier2DPhysicsBackend implements PhysicsBackend {
  readonly kind = "2d" as const;
  readonly supportsConstraints = true;
  private readonly RAPIER: RapierApi;
  private readonly world: InstanceType<RapierApi["World"]>;
  private readonly bodies = new Map<string, BodyRecord>();
  private readonly colliders = new Map<string, ColliderRecord>();
  private readonly characters = new Map<string, CharacterRecord>();
  private readonly constraints = new Map<string, { desc: ConstraintDesc; joint: ImpulseJoint }>();
  private readonly bodyIdByHandle = new Map<number, string>();
  private readonly colliderIdByHandle = new Map<number, string>();
  private readonly eventQueue: RapierEventQueue;
  private readonly collisionHooks: PhysicsHooks;
  private readonly pendingContacts: PhysicsContactEvent[] = [];
  private readonly blockingKeys = new Set<string>();
  private readonly triggerKeys = new Set<string>();
  /** Open overlaps of replaced colliders, which the next step must re-confirm. */
  private readonly refreshingTriggerKeys = new Set<string>();
  private disposed = false;
  private queriesDirty = false;

  private constructor(RAPIER: RapierApi, gravity: Vec3) {
    this.RAPIER = RAPIER;
    this.world = new RAPIER.World({ x: gravity.x, y: gravity.y });
    this.eventQueue = new RAPIER.EventQueue(true);
    // Rapier interaction groups only contain 16 membership bits; authored
    // BabylonSlate masks have 32. Hooks retain all bits for contacts and sensors.
    this.collisionHooks = {
      filterContactPair: (a, b) => this.collisionPairAllowed(a, b) ? RAPIER.SolverFlags.COMPUTE_IMPULSE : null,
      filterIntersectionPair: (a, b) => this.collisionPairAllowed(a, b),
    };
  }

  static async create(
    options: PhysicsBackendOptions,
  ): Promise<Rapier2DPhysicsBackend> {
    const mod = await import("@dimforge/rapier2d-compat");
    const RAPIER = (mod.default ?? mod) as unknown as RapierApi;
    await RAPIER.init();
    return new Rapier2DPhysicsBackend(RAPIER, options.gravity);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.characters.clear();
    this.constraints.clear();
    this.colliders.clear();
    this.bodies.clear();
    this.colliderIdByHandle.clear();
    this.blockingKeys.clear();
    this.triggerKeys.clear();
    this.refreshingTriggerKeys.clear();
    this.pendingContacts.length = 0;
    this.eventQueue.free();
    this.world.free();
  }

  setGravity(gravity: Vec3): void {
    this.world.gravity = { x: gravity.x, y: gravity.y };
  }

  createBody(desc: RigidBodyDesc): void {
    desc = { ...desc, transform: normalizedPhysicsPose(desc.transform) };
    const R = this.RAPIER;
    let bodyDesc;
    switch (desc.motionType) {
      case "static":
        bodyDesc = R.RigidBodyDesc.fixed();
        break;
      case "kinematic":
        bodyDesc = R.RigidBodyDesc.kinematicPositionBased();
        break;
      default:
        // Same floor as updateBody (and Havok): a zero or negative mass makes
        // Rapier integrate NaN and the body disappears.
        bodyDesc = R.RigidBodyDesc.dynamic().setAdditionalMass(
          Math.max(desc.mass, 1e-6),
        );
        break;
    }
    bodyDesc
      .setTranslation(desc.transform.position.x, desc.transform.position.y)
      .setRotation(quatToPlanarAngle(desc.transform.rotation))
      .setLinearDamping(desc.linearDamping)
      .setAngularDamping(desc.angularDamping)
      .setGravityScale(desc.gravityScale);
    const body = this.world.createRigidBody(bodyDesc);
    this.bodies.set(desc.id, { desc: { ...desc }, body });
    this.bodyIdByHandle.set(body.handle, desc.id);
    this.queriesDirty = true;
  }

  destroyBody(bodyId: string): void {
    const record = this.bodies.get(bodyId);
    if (!record) return;
    for (const [id, constraint] of this.constraints) {
      if (constraint.desc.bodyAId === bodyId || constraint.desc.bodyBId === bodyId) this.destroyConstraint(id);
    }
    for (const [id, collider] of [...this.colliders]) {
      if (collider.desc.bodyId === bodyId) this.destroyCollider(id);
    }
    for (const [id, character] of [...this.characters]) {
      if (character.desc.bodyId === bodyId) this.destroyCharacterController(id);
    }
    this.bodyIdByHandle.delete(record.body.handle);
    this.world.removeRigidBody(record.body);
    this.bodies.delete(bodyId);
    this.queriesDirty = true;
  }

  createConstraint(input: ConstraintDesc): void {
    if (this.disposed) throw new Error("Physics backend is disposed");
    const desc = copyConstraintDesc(input, this.kind);
    const a = this.bodies.get(desc.bodyAId);
    const b = this.bodies.get(desc.bodyBId);
    if (!a || !b) throw new Error("Constraint bodies must exist in the same physics world");
    const joints = this.RAPIER.JointData;
    const params = desc.kind === "fixed"
      ? joints.fixed(desc.anchorA, quatToPlanarAngle(desc.frameA!), desc.anchorB, quatToPlanarAngle(desc.frameB!))
      : joints.revolute(desc.anchorA, desc.anchorB);
    let limits: [number, number] | undefined;
    if (desc.kind === "hinge" && desc.limits) {
      const refA = desc.referenceAxisA!;
      const refB = desc.referenceAxisB!;
      const offset = Math.atan2(refB.y, refB.x) - Math.atan2(refA.y, refA.x);
      limits = desc.axisA.z > 0
        ? [desc.limits.min - offset, desc.limits.max - offset]
        : [-desc.limits.max - offset, -desc.limits.min - offset];
    }
    let joint: ImpulseJoint | undefined;
    try {
      joint = this.world.createImpulseJoint(params, a.body, b.body, true);
      // Rapier 0.14's revolute descriptor ignores limits; set them on the native joint.
      if (limits) (joint as RevoluteImpulseJoint).setLimits(limits[0], limits[1]);
      joint.setContactsEnabled(desc.collideConnected ?? false);
      const previous = this.constraints.get(desc.id);
      if (previous) this.world.removeImpulseJoint(previous.joint, true);
      this.constraints.set(desc.id, { desc, joint });
    } catch (error) {
      if (joint?.isValid()) this.world.removeImpulseJoint(joint, true);
      throw error;
    }
  }

  destroyConstraint(id: string): void {
    const record = this.constraints.get(id);
    if (!record) return;
    this.world.removeImpulseJoint(record.joint, true);
    this.constraints.delete(id);
  }

  teleportBody(
    bodyId: string,
    transform: PhysicsTransform,
    options: TeleportOptions = {},
  ): void {
    const record = this.bodies.get(bodyId);
    if (!record) return;
    transform = normalizedPhysicsPose(transform);
    record.body.setTranslation(
      { x: transform.position.x, y: transform.position.y },
      true,
    );
    record.desc.transform = {
      position: { ...transform.position, z: 0 },
      rotation: { ...transform.rotation },
    };
    record.body.setRotation(quatToPlanarAngle(transform.rotation), true);
    this.queriesDirty = true;
    if (options.velocity === "reset") {
      record.body.setLinvel({ x: 0, y: 0 }, true);
      record.body.setAngvel(0, true);
    }
  }

  setBodyTargetTransform(bodyId: string, transform: PhysicsTransform): void {
    const record = this.bodies.get(bodyId);
    if (!record) return;
    if (record.desc.motionType !== "kinematic")
      throw new Error("Only kinematic bodies accept motion targets");
    const pose = normalizedPhysicsPose(transform);
    record.body.setNextKinematicTranslation(pose.position);
    record.body.setNextKinematicRotation(quatToPlanarAngle(pose.rotation));
  }

  getBodyTransform(bodyId: string): PhysicsTransform | null {
    const record = this.bodies.get(bodyId);
    if (!record) return null;
    const t = record.body.translation();
    return {
      position: { x: t.x, y: t.y, z: 0 },
      rotation: {
        x: 0,
        y: 0,
        z: Math.sin(record.body.rotation() / 2),
        w: Math.cos(record.body.rotation() / 2),
      },
    };
  }

  private setBodyMotionType(
    bodyId: string,
    motionType: RigidBodyDesc["motionType"],
  ): void {
    const record = this.bodies.get(bodyId);
    if (!record) return;
    record.desc.motionType = motionType;
    const R = this.RAPIER;
    switch (motionType) {
      case "static":
        record.body.setBodyType(R.RigidBodyType.Fixed, true);
        break;
      case "kinematic":
        record.body.setBodyType(R.RigidBodyType.KinematicPositionBased, true);
        break;
      default:
        record.body.setBodyType(R.RigidBodyType.Dynamic, true);
        break;
    }
  }

  setBodyLinearVelocity(bodyId: string, velocity: Partial<Vec3>): void {
    const record = this.bodies.get(bodyId);
    if (!record || record.desc.motionType !== "dynamic") return;
    const current = record.body.linvel();
    const next = { x: current.x, y: current.y };
    for (const axis of ["x", "y"] as const) {
      const value = velocity[axis];
      if (typeof value === "number" && Number.isFinite(value))
        next[axis] = value;
    }
    record.body.setLinvel(next, true);
  }

  getBodyVelocity(bodyId: string): BodyVelocity | null {
    const record = this.bodies.get(bodyId);
    if (!record) return null;
    const linear = record.body.linvel();
    const center = record.body.worldCom();
    return { linear: { x: linear.x, y: linear.y, z: 0 },
      angular: { x: 0, y: 0, z: record.body.angvel() }, centerOfMass: { x: center.x, y: center.y, z: 0 } };
  }

  setBodyAngularVelocity(bodyId: string, velocity: Vec3): void {
    if (![velocity.x, velocity.y, velocity.z].every(Number.isFinite))
      throw new Error("Angular velocity must be finite");
    const record = this.bodies.get(bodyId);
    if (!record || record.desc.motionType !== "dynamic") return;
    record.body.setAngvel(velocity.z, true);
  }

  addImpulse(bodyId: string, impulse: Vec3, strength = 1): void {
    const record = this.bodies.get(bodyId);
    if (!record || record.desc.motionType !== "dynamic") return;
    record.body.applyImpulse(
      { x: impulse.x * strength, y: impulse.y * strength },
      true,
    );
  }

  addImpulseAtPoint(bodyId: string, impulse: Vec3, point: Vec3): void {
    const record = this.bodies.get(bodyId);
    if (!record || record.desc.motionType !== "dynamic") return;
    if (![impulse.x, impulse.y, point.x, point.y].every(Number.isFinite)) return;
    record.body.applyImpulseAtPoint({ x: impulse.x, y: impulse.y }, { x: point.x, y: point.y }, true);
  }

  updateBody(bodyId: string, tuning: RigidBodyTuning): void {
    const record = this.bodies.get(bodyId);
    if (!record) return;
    if (tuning.motionType) {
      record.desc.motionType = tuning.motionType;
      this.setBodyMotionType(bodyId, tuning.motionType);
    }
    if (typeof tuning.mass === "number" && Number.isFinite(tuning.mass)) {
      record.desc.mass = tuning.mass;
      record.body.setAdditionalMass(Math.max(tuning.mass, 1e-6), true);
    }
    if (
      typeof tuning.linearDamping === "number" &&
      Number.isFinite(tuning.linearDamping)
    ) {
      record.desc.linearDamping = tuning.linearDamping;
      record.body.setLinearDamping(tuning.linearDamping);
    }
    if (
      typeof tuning.angularDamping === "number" &&
      Number.isFinite(tuning.angularDamping)
    ) {
      record.desc.angularDamping = tuning.angularDamping;
      record.body.setAngularDamping(tuning.angularDamping);
    }
    if (
      typeof tuning.gravityScale === "number" &&
      Number.isFinite(tuning.gravityScale)
    ) {
      record.desc.gravityScale = tuning.gravityScale;
      record.body.setGravityScale(tuning.gravityScale, true);
    }
  }

  createCollider(desc: ColliderDesc): void {
    this.applyColliderChanges(desc.bodyId, { upsert: [desc], remove: [] });
  }

  applyColliderChanges(bodyId: string, changes: ColliderChanges): void {
    const body = this.bodies.get(bodyId);
    if (!body) return;
    if (
      new Set(changes.upsert.map((desc) => desc.id)).size !==
      changes.upsert.length
    )
      throw new Error("Duplicate collider upsert identity");
    const removed = new Set(changes.remove);
    // A replacement that keeps its ID and contact policy (a new pose or shape)
    // keeps its overlaps open until the next step re-confirms or ends them.
    const refreshed = new Set<string>();
    const prepared = changes.upsert.map(copyColliderDesc).map((desc) => {
      const existing = this.colliders.get(desc.id);
      if (desc.bodyId !== bodyId || (existing && existing.desc.bodyId !== bodyId))
        throw new Error("Collider transaction crosses body ownership");
      if (existing && !removed.has(desc.id) && sameContactPolicy(existing.desc, desc))
        refreshed.add(desc.id);
      const colliderDesc = this.toColliderDesc(desc);
      if (!colliderDesc) throw new Error("Unsupported planar collider shape");
      colliderDesc
        .setFriction(desc.friction)
        .setRestitution(desc.restitution)
        .setSensor(desc.isTrigger)
        .setActiveEvents(this.RAPIER.ActiveEvents.COLLISION_EVENTS)
        .setActiveHooks(this.RAPIER.ActiveHooks.FILTER_CONTACT_PAIRS | this.RAPIER.ActiveHooks.FILTER_INTERSECTION_PAIRS)
        .setActiveCollisionTypes(this.RAPIER.ActiveCollisionTypes.ALL);
      colliderDesc
        .setTranslation(desc.translation!.x, desc.translation!.y)
        .setRotation(quatToPlanarAngle(desc.rotation!));
      // Hosted child shapes are massless: the host keeps the mass and center
      // of mass that its authored mass and its own colliders give it.
      if (desc.actorId !== undefined && desc.actorId !== body.desc.actorId)
        colliderDesc.setDensity(0);
      return { desc, colliderDesc };
    });
    const provisional: ColliderRecord[] = [];
    try {
      for (const { desc, colliderDesc } of prepared) {
        const record: ColliderRecord = {
          desc,
          collider: this.world.createCollider(colliderDesc, body.body),
        };
        provisional.push(record);
        record.extra = this.createLoopCloseSegment(desc, body.body);
      }
    } catch (error) {
      for (const record of provisional) {
        this.world.removeCollider(record.collider, false);
        if (record.extra) this.world.removeCollider(record.extra, false);
      }
      throw error;
    }
    for (const id of new Set([
      ...changes.remove,
      ...prepared.map(({ desc }) => desc.id),
    ])) {
      if (this.colliders.get(id)?.desc.bodyId === bodyId)
        this.removeCollider(id, refreshed.has(id));
    }
    for (const record of provisional) {
      this.colliders.set(record.desc.id, record);
      this.colliderIdByHandle.set(record.collider.handle, record.desc.id);
      if (record.extra)
        this.colliderIdByHandle.set(record.extra.handle, record.desc.id);
    }
    this.queriesDirty = true;
  }

  destroyCollider(colliderId: string): void {
    this.removeCollider(colliderId, false);
  }

  private removeCollider(colliderId: string, refresh: boolean): void {
    const record = this.colliders.get(colliderId);
    if (!record) return;
    if (refresh) this.refreshColliderContacts(colliderId);
    else this.retireColliderContacts(colliderId);
    this.colliderIdByHandle.delete(record.collider.handle);
    if (record.extra) this.colliderIdByHandle.delete(record.extra.handle);
    this.world.removeCollider(record.collider, true);
    if (record.extra) this.world.removeCollider(record.extra, true);
    this.colliders.delete(colliderId);
    this.queriesDirty = true;
  }

  listDebugColliders() {
    return listDebugCollidersFromRecords(this.colliders.values(), (bodyId) =>
      this.getBodyTransform(bodyId),
    );
  }

  pollContacts(): PhysicsContactEvent[] {
    const events = [...this.pendingContacts];
    this.pendingContacts.length = 0;
    for (const key of this.blockingKeys) {
      const parsed = parseContactKey(key);
      if (!parsed) continue;
      events.push({
        kind: "hit",
        ...parsed,
        location: this.contactLocation(parsed.colliderAId, parsed.colliderBId),
        normal: this.contactNormal(parsed.colliderAId, parsed.colliderBId),
      });
    }
    return events;
  }

  step(dt: number): void {
    this.world.timestep = dt;
    this.world.step(this.eventQueue, this.collisionHooks);
    this.queriesDirty = false;
    this.eventQueue.drainCollisionEvents((handleA, handleB, started) => {
      this.recordCollisionEvent(handleA, handleB, started);
    });
    // A replaced collider's overlap that this step did not start again ended.
    for (const key of this.refreshingTriggerKeys) {
      const pair = parseContactKey(key);
      if (!pair || !this.triggerKeys.delete(key)) continue;
      this.pendingContacts.push({
        kind: "overlapEnd",
        ...pair,
        location: { x: 0, y: 0, z: 0 },
        normal: { x: 0, y: 1, z: 0 },
      });
    }
    this.refreshingTriggerKeys.clear();
  }

  lineTrace(start: Vec3, end: Vec3, options?: LineTraceOptions): HitResult {
    this.flushSceneQueries();
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-8) return miss();
    const ray = new this.RAPIER.Ray(
      { x: start.x, y: start.y },
      { x: dx / len, y: dy / len },
    );
    const ignored = new Set(options?.ignoreActorIds);
    const hit = this.world.castRayAndGetNormal(
      ray,
      len,
      true,
      undefined,
      undefined,
      undefined,
      undefined,
      ignored.size || options?.includeTriggers === false
        ? (collider) => {
            const actorId = this.colliderActorId(collider);
            const desc = this.colliders.get(this.colliderIdByHandle.get(collider.handle) ?? "")?.desc;
            return (actorId === null || !ignored.has(actorId)) &&
              !(options?.includeTriggers === false && desc?.isTrigger);
          }
        : undefined,
    );
    if (!hit) return miss();
    const point = ray.pointAt(hit.timeOfImpact);
    const bodyId = this.bodyIdByHandle.get(hit.collider.parent()?.handle ?? -1);
    const actorId = this.colliderActorId(hit.collider);
    return {
      hit: true,
      location: { x: point.x, y: point.y, z: 0 },
      normal: { x: hit.normal.x, y: hit.normal.y, z: 0 },
      distance: hit.timeOfImpact,
      actorId,
      bodyId: bodyId ?? null,
    };
  }

  sphereOverlap(center: Vec3, radius: number, options?: LineTraceOptions): OverlapResult {
    this.flushSceneQueries();
    const ignored = new Set(options?.ignoreActorIds);
    const allowed = (collider: RapierCollider) => {
      const desc = this.colliders.get(this.colliderIdByHandle.get(collider.handle) ?? "")?.desc;
      const actorId = desc ? this.colliderActorId(collider) : null;
      return actorId !== null && !ignored.has(actorId) && !(options?.includeTriggers === false && desc?.isTrigger);
    };
    const actorIds: string[] = [];
    const bodyIds: string[] = [];
    this.world.intersectionsWithPoint(
      { x: center.x, y: center.y },
      (collider) => {
        if (!allowed(collider)) return true;
        const bodyId = this.bodyIdByHandle.get(collider.parent()?.handle ?? -1);
        if (!bodyId || !this.bodies.has(bodyId)) return true;
        // Point query; approximate radius by also testing nearby with shape.
        bodyIds.push(bodyId);
        actorIds.push(this.colliderActorId(collider)!);
        return true;
      },
    );
    // Also collect via shape cast for radius > 0
    if (radius > 0) {
      const shape = new this.RAPIER.Ball(radius);
      this.world.intersectionsWithShape(
        { x: center.x, y: center.y },
        0,
        shape,
        (collider) => {
          if (!allowed(collider)) return true;
          const bodyId = this.bodyIdByHandle.get(
            collider.parent()?.handle ?? -1,
          );
          if (!bodyId || !this.bodies.has(bodyId)) return true;
          // A host body reports each shape owner once, including hosted children.
          const actorId = this.colliderActorId(collider)!;
          if (!bodyIds.some((id, index) => id === bodyId && actorIds[index] === actorId)) {
            bodyIds.push(bodyId);
            actorIds.push(actorId);
          }
          return true;
        },
      );
    }
    return { actorIds, bodyIds };
  }

  shapeSweep(
    _shape: ColliderDesc["shape"],
    start: PhysicsTransform,
    end: PhysicsTransform,
    options?: LineTraceOptions,
  ): HitResult {
    return this.lineTrace(start.position, end.position, options);
  }

  createCharacterController(desc: CharacterControllerDesc): void {
    if (this.characters.has(desc.id)) this.destroyCharacterController(desc.id);
    const controller = this.world.createCharacterController(desc.offset);
    const angle = (desc.maxSlopeAngle ?? 50) * Math.PI / 180;
    controller.setMaxSlopeClimbAngle(angle);
    controller.setMinSlopeSlideAngle(angle);
    if ((desc.groundSnapDistance ?? 0.1) > 0)
      controller.enableSnapToGround(desc.groundSnapDistance ?? 0.1);
    this.characters.set(desc.id, { desc: { ...desc }, controller });
  }

  destroyCharacterController(id: string): void {
    const record = this.characters.get(id);
    if (!record) return;
    this.world.removeCharacterController(record.controller);
    this.characters.delete(id);
  }

  moveCharacter(
    id: string,
    translation: Vec3,
    dt: number,
    startPose?: PhysicsTransform,
  ): CharacterMovementResult | null {
    if (!Number.isFinite(dt) || dt < 0) return null;
    // Collision resolution takes a displacement, including events outside a tick.
    const inverseDt = dt > 0 ? 1 / dt : 0;
    this.flushSceneQueries();
    const character = this.characters.get(id);
    if (!character) return null;
    const bodyRecord = this.bodies.get(character.desc.bodyId);
    if (!bodyRecord) return null;
    // The controller's own shape, never a child shape that the body hosts.
    const collider = [...this.colliders.values()].find(
      (c) => c.desc.bodyId === bodyRecord.desc.id && !c.desc.isTrigger &&
        (c.desc.actorId ?? bodyRecord.desc.actorId) === bodyRecord.desc.actorId,
    );
    if (!collider) return null;
    const current = bodyRecord.body.translation();
    const currentRotation = bodyRecord.body.rotation();
    const start = startPose ? normalizedPhysicsPose(startPose) : undefined;
    const position = start?.position ?? current;
    const rotation = start ? quatToPlanarAngle(start.rotation) : currentRotation;
    const reposition = position.x !== current.x || position.y !== current.y || rotation !== currentRotation;
    try {
      if (reposition) {
        // Query from the authored pose, including inherited parent motion.
        bodyRecord.body.setTranslation(position, true);
        bodyRecord.body.setRotation(rotation, true);
        this.queriesDirty = true;
        this.flushSceneQueries();
      }
      character.controller.computeColliderMovement(collider.collider, {
        x: translation.x,
        y: translation.y,
      }, undefined, undefined, (candidate) => {
        const candidateId = this.colliderIdByHandle.get(candidate.handle);
        const other = candidateId ? this.colliders.get(candidateId)?.desc : undefined;
        return !!other && other.bodyId !== bodyRecord.desc.id && !other.isTrigger &&
          (other.layer & collider.desc.mask) !== 0 && (collider.desc.layer & other.mask) !== 0;
      });
    } finally {
      if (reposition) {
        // Keep native contacts and old-to-target kinematic integration intact.
        bodyRecord.body.setTranslation(current, true);
        bodyRecord.body.setRotation(currentRotation, true);
        this.queriesDirty = true;
      }
    }
    const movement = character.controller.computedMovement();
    bodyRecord.body.setNextKinematicTranslation({
      x: position.x + movement.x,
      y: position.y + movement.y,
    });
    return {
      position: {
        x: position.x + movement.x,
        y: position.y + movement.y,
        z: 0,
      },
      rotation: this.getBodyTransform(character.desc.bodyId)?.rotation ?? identityRotation(),
      velocity: { x: movement.x * inverseDt, y: movement.y * inverseDt, z: 0 },
      grounded: translation.y <= 0 && character.controller.computedGrounded(),
    };
  }

  private toColliderDesc(desc: ColliderDesc) {
    const R = this.RAPIER;
    const shape = desc.shape;
    switch (shape.kind) {
      case "box2d":
        return R.ColliderDesc.cuboid(shape.halfExtents.x, shape.halfExtents.y);
      case "circle":
        return R.ColliderDesc.ball(shape.radius);
      case "capsule2d":
        return R.ColliderDesc.capsule(shape.halfHeight, shape.radius);
      case "polygon": {
        const flat = new Float32Array(shape.points.length * 2);
        shape.points.forEach((p, i) => {
          flat[i * 2] = p.x;
          flat[i * 2 + 1] = p.y;
        });
        return R.ColliderDesc.convexHull(flat);
      }
      case "chain": {
        const flat = new Float32Array(shape.points.length * 2);
        shape.points.forEach((p, i) => {
          flat[i * 2] = p.x;
          flat[i * 2 + 1] = p.y;
        });
        return R.ColliderDesc.polyline(flat);
      }
      default:
        return null;
    }
  }

  /**
   * Rapier line-strips do not include the closing edge, and repeating the first
   * point makes the whole polyline miss raycasts. Close loops with a segment.
   */
  private createLoopCloseSegment(
    desc: ColliderDesc,
    body: RapierRigidBody,
  ): RapierCollider | undefined {
    const shape = desc.shape;
    if (
      shape.kind !== "chain" ||
      shape.loop !== true ||
      shape.points.length < 2
    ) {
      return undefined;
    }
    const first = shape.points[0]!;
    const last = shape.points[shape.points.length - 1]!;
    if (first.x === last.x && first.y === last.y) return undefined;
    const flat = new Float32Array([last.x, last.y, first.x, first.y]);
    const segment = this.RAPIER.ColliderDesc.polyline(flat)
      .setFriction(desc.friction)
      .setRestitution(desc.restitution)
      .setSensor(desc.isTrigger)
      .setActiveEvents(this.RAPIER.ActiveEvents.COLLISION_EVENTS)
      .setActiveHooks(this.RAPIER.ActiveHooks.FILTER_CONTACT_PAIRS | this.RAPIER.ActiveHooks.FILTER_INTERSECTION_PAIRS)
      .setActiveCollisionTypes(this.RAPIER.ActiveCollisionTypes.ALL);
    segment
      .setTranslation(desc.translation?.x ?? 0, desc.translation?.y ?? 0)
      .setRotation(quatToPlanarAngle(desc.rotation ?? identityRotation()));
    return this.world.createCollider(segment, body);
  }

  private flushSceneQueries(): void {
    if (!this.queriesDirty) return;
    this.world.propagateModifiedBodyPositionsToColliders();
    this.world.updateSceneQueries();
    this.queriesDirty = false;
  }

  /** Native exits cannot resolve an old handle after its collider is removed. */
  private retireColliderContacts(colliderId: string): void {
    for (let i = this.pendingContacts.length - 1; i >= 0; i--) {
      const event = this.pendingContacts[i]!;
      if (
        event.kind !== "overlapEnd" &&
        (event.colliderAId === colliderId || event.colliderBId === colliderId)
      )
        this.pendingContacts.splice(i, 1);
    }
    for (const key of this.blockingKeys) {
      const pair = parseContactKey(key);
      if (
        pair &&
        (pair.colliderAId === colliderId || pair.colliderBId === colliderId)
      )
        this.blockingKeys.delete(key);
    }
    for (const key of this.triggerKeys) {
      const pair = parseContactKey(key);
      if (
        !pair ||
        (pair.colliderAId !== colliderId && pair.colliderBId !== colliderId)
      )
        continue;
      this.triggerKeys.delete(key);
      this.pendingContacts.push({
        kind: "overlapEnd",
        ...pair,
        location: { x: 0, y: 0, z: 0 },
        normal: { x: 0, y: 1, z: 0 },
      });
    }
  }

  /**
   * A collider replaced under the same ID and contact policy keeps its open
   * overlaps, as a teleport does: the next step's intersection events confirm
   * them, and the step ends the rest. Blocking pairs restart with that step.
   */
  private refreshColliderContacts(colliderId: string): void {
    for (const key of this.blockingKeys) {
      const pair = parseContactKey(key);
      if (pair && (pair.colliderAId === colliderId || pair.colliderBId === colliderId))
        this.blockingKeys.delete(key);
    }
    for (const key of this.triggerKeys) {
      const pair = parseContactKey(key);
      if (pair && (pair.colliderAId === colliderId || pair.colliderBId === colliderId))
        this.refreshingTriggerKeys.add(key);
    }
  }

  /** The shape's owner: a hosted child shape's actor, otherwise its body's actor. */
  private colliderActorId(collider: RapierCollider): string | null {
    const desc = this.colliders.get(this.colliderIdByHandle.get(collider.handle) ?? "")?.desc;
    if (desc?.actorId) return desc.actorId;
    const bodyId = this.bodyIdByHandle.get(collider.parent()?.handle ?? -1);
    return bodyId ? (this.bodies.get(bodyId)?.desc.actorId ?? null) : null;
  }

  private collisionPairAllowed(handleA: number, handleB: number): boolean {
    const a = this.colliders.get(this.colliderIdByHandle.get(handleA) ?? "")?.desc;
    const b = this.colliders.get(this.colliderIdByHandle.get(handleB) ?? "")?.desc;
    return !!a && !!b && (a.layer & b.mask) !== 0 && (b.layer & a.mask) !== 0;
  }

  private recordCollisionEvent(
    handleA: number,
    handleB: number,
    started: boolean,
  ): void {
    const colliderAId = this.colliderIdByHandle.get(handleA);
    const colliderBId = this.colliderIdByHandle.get(handleB);
    if (!colliderAId || !colliderBId || colliderAId === colliderBId) return;
    const colliderA = this.colliders.get(colliderAId);
    const colliderB = this.colliders.get(colliderBId);
    if (!colliderA || !colliderB) return;
    const bodyA = this.bodies.get(colliderA.desc.bodyId);
    const bodyB = this.bodies.get(colliderB.desc.bodyId);
    if (!bodyA || !bodyB || bodyA === bodyB) return;
    // Contacts name each shape's owner, including hosted child shapes.
    let actorAId = colliderA.desc.actorId ?? bodyA.desc.actorId;
    let actorBId = colliderB.desc.actorId ?? bodyB.desc.actorId;
    if (actorAId === actorBId) return;
    let idA = colliderAId;
    let idB = colliderBId;
    if (actorAId > actorBId) {
      const swapActor = actorAId;
      actorAId = actorBId;
      actorBId = swapActor;
      const swapCollider = idA;
      idA = idB;
      idB = swapCollider;
    }
    const key = contactKey(actorAId, idA, actorBId, idB);
    const isTrigger = colliderA.desc.isTrigger || colliderB.desc.isTrigger;
    if (isTrigger) {
      if (started) {
        if (this.triggerKeys.has(key)) {
          // A replaced collider's overlap continues without a second begin.
          this.refreshingTriggerKeys.delete(key);
          return;
        }
        this.triggerKeys.add(key);
        this.pendingContacts.push({
          kind: "overlapBegin",
          actorAId,
          actorBId,
          colliderAId: idA,
          colliderBId: idB,
          location: this.contactLocation(idA, idB),
          normal: this.contactNormal(idA, idB),
        });
      } else if (this.triggerKeys.delete(key)) {
        this.pendingContacts.push({
          kind: "overlapEnd",
          actorAId,
          actorBId,
          colliderAId: idA,
          colliderBId: idB,
          location: { x: 0, y: 0, z: 0 },
          normal: { x: 0, y: 1, z: 0 },
        });
      }
      return;
    }
    if (started) this.blockingKeys.add(key);
    else this.blockingKeys.delete(key);
  }

  private contactLocation(
    colliderAId: string,
    colliderBId: string,
  ): { x: number; y: number; z: number } {
    const a = this.colliderTranslation(colliderAId);
    const b = this.colliderTranslation(colliderBId);
    return {
      x: (a.x + b.x) * 0.5,
      y: (a.y + b.y) * 0.5,
      z: 0,
    };
  }

  private contactNormal(
    colliderAId: string,
    colliderBId: string,
  ): { x: number; y: number; z: number } {
    const a = this.colliderTranslation(colliderAId);
    const b = this.colliderTranslation(colliderBId);
    const x = b.x - a.x;
    const y = b.y - a.y;
    const length = Math.hypot(x, y);
    if (length < 1e-8) return { x: 0, y: 1, z: 0 };
    return { x: x / length, y: y / length, z: 0 };
  }

  private colliderTranslation(colliderId: string): { x: number; y: number } {
    const record = this.colliders.get(colliderId);
    if (!record) return { x: 0, y: 0 };
    return record.collider.translation();
  }
}

/** Whether a replacement reports the same pairs: same trigger, filter and owner. */
function sameContactPolicy(a: ColliderDesc, b: ColliderDesc): boolean {
  return (
    a.isTrigger === b.isTrigger &&
    a.layer === b.layer &&
    a.mask === b.mask &&
    a.actorId === b.actorId
  );
}

function contactKey(
  actorAId: string,
  colliderAId: string,
  actorBId: string,
  colliderBId: string,
): string {
  return `${actorAId}\t${colliderAId}\t${actorBId}\t${colliderBId}`;
}

function parseContactKey(key: string): {
  actorAId: string;
  actorBId: string;
  colliderAId: string;
  colliderBId: string;
} | null {
  const [actorAId, colliderAId, actorBId, colliderBId] = key.split("\t");
  if (!actorAId || !colliderAId || !actorBId || !colliderBId) return null;
  return { actorAId, colliderAId, actorBId, colliderBId };
}
