import type {
  HavokPhysicsWithBindings,
  HP_ConstraintId,
  HP_ShapeId,
  HP_WorldId,
  MassProperties,
  MotionType as HavokMotionType,
  Quaternion as HavokQuat,
  Vector3 as HavokVec3,
} from "@babylonjs/havok";
import type { PhysicsBackend, SphereSweepQuery } from "./backend";
import type {
  BodyVelocity,
  CharacterControllerDesc,
  CharacterMovementResult,
  ColliderChanges,
  ColliderDesc,
  ConstraintDesc,
  HitResult,
  LineTraceOptions,
  MotionType,
  OverlapResult,
  PhysicsBackendOptions,
  PhysicsContactEvent,
  PhysicsTransform,
  RigidBodyDesc,
  RigidBodyTuning,
  TeleportOptions,
  Vec3,
} from "./types";
import {
  copyColliderDesc,
  identityColliderPose,
  normalizePhysicsPoseInto,
  normalizedPhysicsPose,
  sameColliderGeometry,
  sameColliderPose,
} from "./collider-validation";
import { listDebugCollidersFromRecords } from "./debug-colliders";
import { loadHavokModule } from "./havok-loader";
import { multiplyQuat, rotateQuatVec } from "./collider-bake";
import { copyConstraintDesc } from "./constraint-validation";
import { createHavokConstraint, disposeHavokConstraint } from "./havok-constraints";
import {
  colliderShapes,
  createHavokShape,
  isShape3D,
  releaseHavokShape,
  type BodyRecord,
  type ColliderRecord,
} from "./havok-records";
import { HavokQueries } from "./havok-queries";
import { HavokContacts } from "./havok-contacts";
import { HavokCharacters } from "./havok-characters";
import {
  checked,
  checkedValue,
  conjugateQuat,
  NULL_SHAPE_ID,
  readBodyBufferTransform,
  toHavokQuat,
  toHavokVec3,
  vec3Cross,
  ZERO_HAVOK_VEC3,
} from "./havok-wasm-memory";

/** A non-trigger collider that overlaps some layer gets a trigger proxy (`ColliderRecord.proxy`). */
function needsOverlapProxy(desc: ColliderDesc): boolean {
  return !desc.isTrigger && (desc.overlapMask ?? 0) !== 0;
}

/** The longest native step: a longer `dt` (a hitch, or a large time dilation) simulates only this much, as Babylon's physics engine did. */
const MAX_STEP_SECONDS = 0.1;
/** The ideal step time a new world starts with. */
const INITIAL_IDEAL_STEP_SECONDS = 1 / 60;

function havokMotionType(havok: HavokPhysicsWithBindings, motion: MotionType): HavokMotionType {
  switch (motion) {
    case "static":
      return havok.MotionType.STATIC;
    case "kinematic":
      return havok.MotionType.KINEMATIC;
    default:
      return havok.MotionType.DYNAMIC;
  }
}

/**
 * Direct 3D physics backend talking straight to `@babylonjs/havok` WASM (`HP_World_*`, `HP_Body_*`, `HP_Shape_*`,
 * `HP_Constraint_*`, `HP_QueryCollector_*`) with zero `@babylonjs/core` `NullEngine`, `Scene`, or `TransformNode`
 * overhead inside the game worker.
 */
export class HavokPhysicsBackend implements PhysicsBackend {
  readonly kind = "3d" as const;
  readonly supportsConstraints = true;
  readonly havok: HavokPhysicsWithBindings;
  readonly worldId: HP_WorldId;
  private readonly bodies = new Map<string, BodyRecord>();
  /** Non-static bodies so `syncSteppedBodyTransforms` skips static level geometry in O(0). */
  private readonly activeMotionBodies = new Set<BodyRecord>();
  /** Each actor's live bodies, so `setContactReporting` reaches them without scanning every body. */
  private readonly bodiesByActor = new Map<string, Set<BodyRecord>>();
  private bodySeq = 0;
  /** Bodies with a `mutationFailure`, so `flushMutations` scans `bodies` only when one exists. */
  private readonly failedBodies = new Set<BodyRecord>();
  private readonly colliders = new Map<string, ColliderRecord>();
  private readonly collidersByOwner = new Map<string, Set<ColliderRecord>>();
  private readonly triggerColliders = new Set<ColliderRecord>();
  private readonly constraints = new Map<string, { desc: ConstraintDesc; jointId: HP_ConstraintId }>();
  private readonly bodyIdByHpId = new Map<bigint, string>();
  /** A kinematic target normalized in place before writing to Havok. */
  private readonly targetPose: PhysicsTransform = {
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
  };
  private readonly targetQTransform: [HavokVec3, HavokQuat] = [
    [0, 0, 0],
    [0, 0, 0, 1],
  ];
  /** Cached Float32Array view over `havok.HEAPU8.buffer` (recreated only if WASM memory grows). */
  private heapFloat32: Float32Array | null = null;
  private disposed = false;
  private stepping = false;
  private pendingMutations: Array<() => void> = [];
  private colliderSeq = 0;
  /** The ideal step time last given to Havok; every step's length becomes the ideal before the step runs. */
  private idealStepTime = INITIAL_IDEAL_STEP_SECONDS;
  private readonly queries: HavokQueries;
  private readonly contacts: HavokContacts;
  private readonly characterControllers: HavokCharacters;
  /** Optional hook invoked during native collision draining (used by tests to verify callback-deferred mutations). */
  onStepCollision?: () => void;

  private constructor(havok: HavokPhysicsWithBindings, worldId: HP_WorldId) {
    this.havok = havok;
    this.worldId = worldId;
    this.queries = new HavokQueries({
      havok,
      worldId,
      bodies: this.bodies,
      bodyIdByHpId: this.bodyIdByHpId,
      collidersByOwner: this.collidersByOwner,
      triggerColliders: this.triggerColliders,
      isDisposed: () => this.disposed,
      flushMutations: () => this.flushMutations(),
    });
    this.characterControllers = new HavokCharacters({
      havok,
      worldId,
      bodies: this.bodies,
      bodyIdByHpId: this.bodyIdByHpId,
      flushMutations: () => this.flushMutations(),
      failMutation: (record, failure) => this.failMutation(record, failure),
      setBodyPoseBeforeStep: (record) => this.setBodyPoseBeforeStep(record),
      getBodyTransform: (bodyId) => this.getBodyTransform(bodyId),
      setBodyTargetTransform: (bodyId, transform) => this.setBodyTargetTransform(bodyId, transform),
      teleportBody: (bodyId, transform) => this.teleportBody(bodyId, transform),
    });
    this.contacts = new HavokContacts({
      havok,
      worldId,
      bodies: this.bodies,
      bodyIdByHpId: this.bodyIdByHpId,
      collidersByOwner: this.collidersByOwner,
    });
  }

  /** Load and compile the Havok module `create` uses, without creating a world. */
  static async preload(havokWasmUrl?: string): Promise<void> {
    await loadHavokModule(havokWasmUrl);
  }

  static async create(options: PhysicsBackendOptions): Promise<HavokPhysicsBackend> {
    const havok = await loadHavokModule(options.havokWasmUrl);
    const worldId = checkedValue(havok, havok.HP_World_Create(), "world creation");
    try {
      checked(havok, havok.HP_World_SetGravity(worldId, toHavokVec3(options.gravity)), "world gravity");
      checked(havok, havok.HP_World_SetIdealStepTime(worldId, INITIAL_IDEAL_STEP_SECONDS), "world ideal step time");
      return new HavokPhysicsBackend(havok, worldId);
    } catch (error) {
      havok.HP_World_Release(worldId);
      throw error;
    }
  }

  /** Whether this backend has been disposed. */
  get isDisposed(): boolean {
    return this.disposed;
  }

  /** Number of native bodies currently registered in the Havok world. */
  get numBodies(): number {
    if (this.disposed) return 0;
    return checkedValue(this.havok, this.havok.HP_World_GetNumBodies(this.worldId), "world body count");
  }

  /** Native Havok body handle for `bodyId`, if live (for diagnostics and white-box tests). */
  getNativeBodyId(bodyId: string): [bigint] | null {
    return this.bodies.get(bodyId)?.hpBodyId ?? null;
  }

  dispose(): void {
    if (this.disposed) return;
    if (this.stepping) {
      this.pendingMutations.push(() => this.dispose());
      return;
    }
    this.disposed = true;
    this.queries.dispose();
    this.contacts.dispose();
    this.characterControllers.dispose();
    for (const record of this.constraints.values()) {
      disposeHavokConstraint(this.havok, record.jointId);
    }
    this.constraints.clear();
    this.colliders.clear();
    for (const record of this.bodies.values()) {
      this.disposeBodyRecord(record);
    }
    this.bodies.clear();
    this.activeMotionBodies.clear();
    this.bodiesByActor.clear();
    this.collidersByOwner.clear();
    this.triggerColliders.clear();
    this.failedBodies.clear();
    this.bodyIdByHpId.clear();
    this.pendingMutations = [];
    this.contacts.clear();
    this.havok.HP_World_Release(this.worldId);
  }

  setGravity(gravity: Vec3): void {
    if (this.disposed) return;
    checked(this.havok, this.havok.HP_World_SetGravity(this.worldId, toHavokVec3(gravity)), "world gravity");
  }

  createBody(desc: RigidBodyDesc): void {
    this.assertLive();
    if (this.stepping)
      throw new Error("Cannot create a physics body during native stepping");
    if (this.bodies.has(desc.id))
      throw new Error(`Physics body already exists: ${desc.id}`);
    const transform = normalizedPhysicsPose(desc.transform);
    const hpBodyId = checkedValue(this.havok, this.havok.HP_Body_Create(), "body creation");
    let addedToWorld = false;
    try {
      checked(
        this.havok,
        this.havok.HP_Body_SetMotionType(hpBodyId, havokMotionType(this.havok, desc.motionType)),
        "body motion type",
      );
      checked(
        this.havok,
        this.havok.HP_Body_SetQTransform(hpBodyId, [
          toHavokVec3(transform.position),
          toHavokQuat(transform.rotation),
        ]),
        "body initial transform",
      );
      checked(this.havok, this.havok.HP_World_AddBody(this.worldId, hpBodyId, false), "world add body");
      addedToWorld = true;
      const worldTransformOffset = checkedValue(
        this.havok,
        this.havok.HP_Body_GetWorldTransformOffset(hpBodyId),
        "body transform offset",
      );
      const record: BodyRecord = {
        order: ++this.bodySeq,
        desc: { ...desc, transform },
        hpBodyId,
        pose: {
          position: { ...transform.position },
          rotation: { ...transform.rotation },
        },
        worldTransformOffset,
        inWorld: true,
        attachedShape: null,
        massProps: {
          mass: desc.motionType === "static" ? 0 : Math.max(desc.mass, 1e-6),
          lockRotation: desc.lockRotation === true && desc.motionType === "dynamic",
        },
        reporting: desc.reportContacts !== false,
        colliders: new Map(),
        container: null,
        hostsShapes: false,
        lastBufferMatrix: null,
        movedLastStep: desc.motionType !== "static",
        uncertainShapes: new Set(),
      };
      this.applyBodyTuning(record);
      this.contacts.applyEventMask(record);
      this.bodies.set(desc.id, record);
      if (desc.motionType !== "static") this.activeMotionBodies.add(record);
      this.bodyIdByHpId.set(hpBodyId[0], desc.id);
      let owned = this.bodiesByActor.get(desc.actorId);
      if (!owned) this.bodiesByActor.set(desc.actorId, (owned = new Set()));
      owned.add(record);
    } catch (error) {
      if (addedToWorld) this.havok.HP_World_RemoveBody(this.worldId, hpBodyId);
      this.havok.HP_Body_Release(hpBodyId);
      throw error;
    }
  }

  destroyBody(bodyId: string): void {
    if (this.stepping) {
      this.pendingMutations.push(() => this.destroyBody(bodyId));
      return;
    }
    const record = this.bodies.get(bodyId);
    if (!record) return;
    for (const [id, constraint] of this.constraints) {
      if (constraint.desc.bodyAId === bodyId || constraint.desc.bodyBId === bodyId) {
        this.destroyConstraint(id);
      }
    }
    this.contacts.retireTriggerPairs(record);
    for (const id of record.colliders.keys()) this.colliders.delete(id);
    this.characterControllers.destroyForBody(bodyId);
    this.disposeBodyRecord(record);
    this.bodies.delete(bodyId);
    this.activeMotionBodies.delete(record);
    const owned = this.bodiesByActor.get(record.desc.actorId);
    if (owned?.delete(record) && !owned.size) this.bodiesByActor.delete(record.desc.actorId);
    this.contacts.forgetBody(record);
    this.failedBodies.delete(record);
  }

  setContactReporting(actorId: string, enabled: boolean): void {
    if (this.stepping) {
      this.pendingMutations.push(() => this.setContactReporting(actorId, enabled));
      return;
    }
    for (const record of this.bodiesByActor.get(actorId) ?? []) {
      this.contacts.requestReporting(record, enabled);
    }
  }

  createConstraint(input: ConstraintDesc): void {
    this.assertLive();
    if (this.stepping) throw new Error("Cannot create a constraint during native stepping");
    const desc = copyConstraintDesc(input, this.kind);
    const a = this.bodies.get(desc.bodyAId);
    const b = this.bodies.get(desc.bodyBId);
    if (!a || !b) throw new Error("Constraint bodies must exist in the same physics world");
    this.assertHealthy(a);
    this.assertHealthy(b);
    const jointId = createHavokConstraint(this.havok, desc, a.hpBodyId, b.hpBodyId);
    const previous = this.constraints.get(desc.id);
    if (previous) disposeHavokConstraint(this.havok, previous.jointId);
    this.constraints.set(desc.id, { desc, jointId });
    this.markBodyAwake(a);
    this.markBodyAwake(b);
  }

  destroyConstraint(id: string): void {
    if (this.stepping) {
      this.pendingMutations.push(() => this.destroyConstraint(id));
      return;
    }
    const record = this.constraints.get(id);
    if (!record) return;
    disposeHavokConstraint(this.havok, record.jointId);
    this.constraints.delete(id);
    const a = this.bodies.get(record.desc.bodyAId);
    const b = this.bodies.get(record.desc.bodyBId);
    if (a) this.markBodyAwake(a);
    if (b) this.markBodyAwake(b);
  }

  teleportBody(
    bodyId: string,
    transform: PhysicsTransform,
    options: TeleportOptions = {},
  ): void {
    const pose = normalizedPhysicsPose(transform);
    const velocity = options.velocity;
    if (this.stepping) {
      this.pendingMutations.push(() => this.teleportBody(bodyId, pose, { velocity }));
      return;
    }
    const record = this.bodies.get(bodyId);
    if (!record) return;
    this.assertHealthy(record);
    const previousPose: PhysicsTransform = {
      position: { ...record.pose.position },
      rotation: { ...record.pose.rotation },
    };
    const previousLinear = checkedValue(
      this.havok,
      this.havok.HP_Body_GetLinearVelocity(record.hpBodyId),
      "read linear velocity",
    );
    const previousAngular = checkedValue(
      this.havok,
      this.havok.HP_Body_GetAngularVelocity(record.hpBodyId),
      "read angular velocity",
    );
    const linear: HavokVec3 = velocity === "reset" ? ZERO_HAVOK_VEC3 : previousLinear;
    const angular: HavokVec3 = velocity === "reset" ? ZERO_HAVOK_VEC3 : previousAngular;
    record.pose.position.x = pose.position.x;
    record.pose.position.y = pose.position.y;
    record.pose.position.z = pose.position.z;
    record.pose.rotation.x = pose.rotation.x;
    record.pose.rotation.y = pose.rotation.y;
    record.pose.rotation.z = pose.rotation.z;
    record.pose.rotation.w = pose.rotation.w;
    try {
      this.teleportNativeBody(record);
      checked(this.havok, this.havok.HP_Body_SetLinearVelocity(record.hpBodyId, linear), "teleport linear velocity");
      checked(this.havok, this.havok.HP_Body_SetAngularVelocity(record.hpBodyId, angular), "teleport angular velocity");
      // Explicit teleports wake sleeping bodies, then restore ordinary simulation control.
      checked(
        this.havok,
        this.havok.HP_Body_SetActivationControl(record.hpBodyId, this.havok.ActivationControl.ALWAYS_ACTIVE),
        "teleport wake",
      );
      checked(
        this.havok,
        this.havok.HP_Body_SetActivationControl(record.hpBodyId, this.havok.ActivationControl.SIMULATION_CONTROLLED),
        "teleport restore activation",
      );
    } catch (error) {
      record.pose.position.x = previousPose.position.x;
      record.pose.position.y = previousPose.position.y;
      record.pose.position.z = previousPose.position.z;
      record.pose.rotation.x = previousPose.rotation.x;
      record.pose.rotation.y = previousPose.rotation.y;
      record.pose.rotation.z = previousPose.rotation.z;
      record.pose.rotation.w = previousPose.rotation.w;
      try {
        this.teleportNativeBody(record);
        checked(this.havok, this.havok.HP_Body_SetLinearVelocity(record.hpBodyId, previousLinear), "rollback linear velocity");
        checked(this.havok, this.havok.HP_Body_SetAngularVelocity(record.hpBodyId, previousAngular), "rollback angular velocity");
      } catch (rollbackError) {
        throw this.failMutation(
          record,
          new AggregateError([error, rollbackError], `Havok teleport rollback failed for ${bodyId}`),
        );
      }
      this.contacts.retireTriggerPairs(record);
      throw error;
    }
    record.desc.transform = pose;
    this.markBodyAwake(record);
    // World membership refresh drops native pairs without emitting exits.
    this.contacts.refreshTriggerPairs(record);
    this.characterControllers.bodyTeleported(bodyId, pose.position);
  }

  setBodyTargetTransform(bodyId: string, transform: PhysicsTransform): void {
    if (this.stepping) {
      const pose = normalizedPhysicsPose(transform);
      this.pendingMutations.push(() => this.setBodyTargetTransform(bodyId, pose));
      return;
    }
    const { position, rotation } = normalizePhysicsPoseInto(transform, this.targetPose);
    const record = this.bodies.get(bodyId);
    if (!record) return;
    this.assertHealthy(record);
    if (record.desc.motionType !== "kinematic") {
      throw new Error("Only kinematic bodies accept motion targets");
    }
    const targetPos = this.targetQTransform[0];
    const targetRot = this.targetQTransform[1];
    targetPos[0] = position.x;
    targetPos[1] = position.y;
    targetPos[2] = position.z;
    targetRot[0] = rotation.x;
    targetRot[1] = rotation.y;
    targetRot[2] = rotation.z;
    targetRot[3] = rotation.w;
    checked(
      this.havok,
      this.havok.HP_Body_SetTargetQTransform(record.hpBodyId, this.targetQTransform),
      "kinematic target transform",
    );
    this.markBodyAwake(record);
  }

  getBodyTransform(bodyId: string): PhysicsTransform | null {
    const out = { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } };
    return this.readBodyTransform(bodyId, out) ? out : null;
  }

  readBodyTransform(bodyId: string, out: PhysicsTransform): boolean {
    const record = this.bodies.get(bodyId);
    if (!record) return false;
    out.position.x = record.pose.position.x;
    out.position.y = record.pose.position.y;
    out.position.z = record.pose.position.z;
    out.rotation.x = record.pose.rotation.x;
    out.rotation.y = record.pose.rotation.y;
    out.rotation.z = record.pose.rotation.z;
    out.rotation.w = record.pose.rotation.w;
    return true;
  }

  didBodyMoveLastStep(bodyId: string): boolean {
    const record = this.bodies.get(bodyId);
    return record !== undefined && record.desc.motionType !== "static" && record.movedLastStep;
  }

  getBodyVelocity(bodyId: string): BodyVelocity | null {
    const record = this.bodies.get(bodyId);
    const transform = this.getBodyTransform(bodyId);
    if (!record || !transform) return null;
    const linear = checkedValue(this.havok, this.havok.HP_Body_GetLinearVelocity(record.hpBodyId), "read linear velocity");
    const angular = checkedValue(this.havok, this.havok.HP_Body_GetAngularVelocity(record.hpBodyId), "read angular velocity");
    const massProps = checkedValue(this.havok, this.havok.HP_Body_GetMassProperties(record.hpBodyId), "read mass properties");
    const com = massProps[0];
    const offset = rotateQuatVec(transform.rotation, { x: com[0], y: com[1], z: com[2] });
    return {
      linear: { x: linear[0], y: linear[1], z: linear[2] },
      angular: { x: angular[0], y: angular[1], z: angular[2] },
      centerOfMass: {
        x: transform.position.x + offset.x,
        y: transform.position.y + offset.y,
        z: transform.position.z + offset.z,
      },
    };
  }

  setBodyAngularVelocity(bodyId: string, velocity: Vec3): void {
    if (![velocity.x, velocity.y, velocity.z].every(Number.isFinite)) {
      throw new Error("Angular velocity must be finite");
    }
    if (this.stepping) {
      const owned = { ...velocity };
      this.pendingMutations.push(() => this.setBodyAngularVelocity(bodyId, owned));
      return;
    }
    const record = this.bodies.get(bodyId);
    if (!record || record.desc.motionType !== "dynamic") return;
    this.assertHealthy(record);
    checked(
      this.havok,
      this.havok.HP_Body_SetAngularVelocity(record.hpBodyId, toHavokVec3(velocity)),
      "set angular velocity",
    );
    this.markBodyAwake(record);
  }

  setBodyLinearVelocity(bodyId: string, velocity: Partial<Vec3>): void {
    const record = this.bodies.get(bodyId);
    if (!record || record.desc.motionType !== "dynamic") return;
    const current = checkedValue(this.havok, this.havok.HP_Body_GetLinearVelocity(record.hpBodyId), "read linear velocity");
    const next: HavokVec3 = [current[0], current[1], current[2]];
    if (typeof velocity.x === "number" && Number.isFinite(velocity.x)) next[0] = velocity.x;
    if (typeof velocity.y === "number" && Number.isFinite(velocity.y)) next[1] = velocity.y;
    if (typeof velocity.z === "number" && Number.isFinite(velocity.z)) next[2] = velocity.z;
    checked(this.havok, this.havok.HP_Body_SetLinearVelocity(record.hpBodyId, next), "set linear velocity");
    this.markBodyAwake(record);
  }

  addImpulse(bodyId: string, impulse: Vec3, strength = 1): void {
    const record = this.bodies.get(bodyId);
    if (!record || record.desc.motionType !== "dynamic") return;
    const massProps = checkedValue(this.havok, this.havok.HP_Body_GetMassProperties(record.hpBodyId), "read mass properties");
    const com = massProps[0];
    const offset = rotateQuatVec(record.pose.rotation, { x: com[0], y: com[1], z: com[2] });
    const location: HavokVec3 = [
      record.pose.position.x + offset.x,
      record.pose.position.y + offset.y,
      record.pose.position.z + offset.z,
    ];
    checked(
      this.havok,
      this.havok.HP_Body_ApplyImpulse(record.hpBodyId, location, [
        impulse.x * strength,
        impulse.y * strength,
        impulse.z * strength,
      ]),
      "apply impulse",
    );
    this.markBodyAwake(record);
  }

  addImpulseAtPoint(bodyId: string, impulse: Vec3, point: Vec3): void {
    const record = this.bodies.get(bodyId);
    if (!record || record.desc.motionType !== "dynamic") return;
    if (![impulse.x, impulse.y, impulse.z, point.x, point.y, point.z].every(Number.isFinite)) return;
    checked(
      this.havok,
      this.havok.HP_Body_ApplyImpulse(record.hpBodyId, toHavokVec3(point), toHavokVec3(impulse)),
      "apply impulse at point",
    );
    this.markBodyAwake(record);
  }

  getBodyImpulseResponse(bodyId: string, impulse: Vec3, point: Vec3) {
    const record = this.bodies.get(bodyId);
    if (!record || record.desc.motionType !== "dynamic") return null;
    const [com, rawMass, inertia, inertiaOri] = checkedValue(
      this.havok,
      this.havok.HP_Body_GetMassProperties(record.hpBodyId),
      "read mass properties",
    );
    const mass = rawMass ?? record.desc.mass;
    if (mass <= 0) return null;
    const rotation = record.pose.rotation;
    const centerOffset = rotateQuatVec(rotation, { x: com[0], y: com[1], z: com[2] });
    const center: Vec3 = {
      x: record.pose.position.x + centerOffset.x,
      y: record.pose.position.y + centerOffset.y,
      z: record.pose.position.z + centerOffset.z,
    };
    const orientation = multiplyQuat(rotation, {
      x: inertiaOri[0],
      y: inertiaOri[1],
      z: inertiaOri[2],
      w: inertiaOri[3],
    });
    const arm: Vec3 = { x: point.x - center.x, y: point.y - center.y, z: point.z - center.z };
    const worldTorque = vec3Cross(arm, impulse);
    const localTorque = rotateQuatVec(conjugateQuat(orientation), worldTorque);
    // Havok reports principal inertia per unit mass; zero means a locked axis.
    const scaledLocal: Vec3 = {
      x: inertia[0] > 0 ? localTorque.x / (mass * inertia[0]) : 0,
      y: inertia[1] > 0 ? localTorque.y / (mass * inertia[1]) : 0,
      z: inertia[2] > 0 ? localTorque.z / (mass * inertia[2]) : 0,
    };
    const angular = rotateQuatVec(orientation, scaledLocal);
    return {
      linear: { x: impulse.x / mass, y: impulse.y / mass, z: impulse.z / mass },
      angular,
      centerOfMass: center,
    };
  }

  updateBody(bodyId: string, tuning: RigidBodyTuning): void {
    const record = this.bodies.get(bodyId);
    if (!record) return;
    if (tuning.motionType) {
      record.desc.motionType = tuning.motionType;
      if (tuning.motionType === "static") this.activeMotionBodies.delete(record);
      else this.activeMotionBodies.add(record);
    }
    if (typeof tuning.mass === "number" && Number.isFinite(tuning.mass)) {
      record.desc.mass = tuning.mass;
    }
    if (typeof tuning.linearDamping === "number" && Number.isFinite(tuning.linearDamping)) {
      record.desc.linearDamping = tuning.linearDamping;
    }
    if (typeof tuning.angularDamping === "number" && Number.isFinite(tuning.angularDamping)) {
      record.desc.angularDamping = tuning.angularDamping;
    }
    if (typeof tuning.gravityScale === "number" && Number.isFinite(tuning.gravityScale)) {
      record.desc.gravityScale = tuning.gravityScale;
    }
    if (typeof tuning.lockRotation === "boolean") {
      record.desc.lockRotation = tuning.lockRotation;
    }
    if (tuning.motionType) this.applyMotionType(record);
    this.applyBodyTuning(record);
    this.markBodyAwake(record);
  }

  createCollider(desc: ColliderDesc): void {
    this.applyColliderChanges(desc.bodyId, { upsert: [desc], remove: [] });
  }

  destroyCollider(colliderId: string): void {
    const collider = this.colliders.get(colliderId);
    if (collider) {
      this.applyColliderChanges(collider.desc.bodyId, { upsert: [], remove: [colliderId] });
    }
  }

  applyColliderChanges(bodyId: string, changes: ColliderChanges): void {
    this.assertLive();
    const upsert = changes.upsert.map(copyColliderDesc);
    if (new Set(upsert.map((desc) => desc.id)).size !== upsert.length) {
      throw new Error("Duplicate collider ID in transaction");
    }
    const remove = [...changes.remove];
    if (this.stepping) {
      this.pendingMutations.push(() => this.applyColliderChanges(bodyId, { upsert, remove }));
      return;
    }
    const record = this.bodies.get(bodyId);
    if (!record) return;
    this.assertHealthy(record);
    const next = new Map(record.colliders);
    for (const id of remove) next.delete(id);
    const provisional = new Set<HP_ShapeId>();
    let container: HP_ShapeId | null = null;
    let topologyChanged = remove.some((id) => record.colliders.has(id));
    try {
      for (const desc of upsert) {
        if (desc.bodyId !== bodyId) throw new Error("Collider transaction crosses body ownership");
        if (!isShape3D(desc.shape)) throw new Error("A 3D body cannot own a planar collider");
        const previous = this.colliders.get(desc.id);
        if (previous && previous.desc.bodyId !== bodyId) {
          throw new Error(`Collider belongs to another body: ${desc.id}`);
        }
        const sameGeometry = previous && sameColliderGeometry(previous.desc.shape, desc.shape);
        const shape = sameGeometry ? previous.shape : createHavokShape(this.havok, desc.shape);
        if (!sameGeometry) provisional.add(shape);
        let proxy: HP_ShapeId | undefined;
        if (needsOverlapProxy(desc)) {
          proxy = sameGeometry && previous.proxy ? previous.proxy : createHavokShape(this.havok, desc.shape);
          if (proxy !== previous?.proxy) provisional.add(proxy);
        }
        topologyChanged ||=
          !previous || !sameGeometry || !sameColliderPose(previous.desc, desc) || proxy !== previous.proxy;
        next.set(desc.id, { desc, shape, ...(proxy ? { proxy } : {}), seq: 0 });
      }
      if (
        topologyChanged &&
        next.size &&
        !(
          next.size === 1 &&
          !next.values().next().value!.proxy &&
          identityColliderPose(next.values().next().value!.desc)
        )
      ) {
        container = checkedValue(this.havok, this.havok.HP_Shape_CreateContainer(), "container creation");
        provisional.add(container);
        for (const child of next.values()) {
          for (const shape of child.proxy ? [child.shape, child.proxy] : [child.shape]) {
            checked(
              this.havok,
              this.havok.HP_Shape_AddChild(container, shape, [
                toHavokVec3(child.desc.translation!),
                toHavokQuat(child.desc.rotation!),
                [1, 1, 1],
              ]),
              "container add child",
            );
          }
        }
      }
    } catch (error) {
      if (container) releaseHavokShape(this.havok, container);
      for (const shape of provisional) if (shape !== container) releaseHavokShape(this.havok, shape);
      throw error;
    }

    const oldAttachment = record.attachedShape;
    const linear = checkedValue(this.havok, this.havok.HP_Body_GetLinearVelocity(record.hpBodyId), "read linear velocity");
    const angular = checkedValue(this.havok, this.havok.HP_Body_GetAngularVelocity(record.hpBodyId), "read angular velocity");
    const attachment = container ?? next.values().next().value?.shape ?? null;

    try {
      if (topologyChanged) this.attachShape(record, attachment);
      for (const child of next.values()) this.applyColliderTuning(child);
      if (topologyChanged) this.applyBodyTuning(record);
      checked(this.havok, this.havok.HP_Body_SetLinearVelocity(record.hpBodyId, linear), "restore linear velocity");
      checked(this.havok, this.havok.HP_Body_SetAngularVelocity(record.hpBodyId, angular), "restore angular velocity");
    } catch (error) {
      try {
        if (topologyChanged) this.attachShape(record, oldAttachment);
        for (const child of record.colliders.values()) this.applyColliderTuning(child);
        this.applyBodyTuning(record);
        checked(this.havok, this.havok.HP_Body_SetLinearVelocity(record.hpBodyId, linear), "rollback linear velocity");
        checked(this.havok, this.havok.HP_Body_SetAngularVelocity(record.hpBodyId, angular), "rollback angular velocity");
      } catch (rollbackError) {
        for (const shape of provisional) record.uncertainShapes.add(shape);
        throw this.failMutation(
          record,
          new AggregateError([error, rollbackError], `Havok collider rollback failed for ${bodyId}`),
        );
      }
      if (topologyChanged) this.contacts.retireTriggerPairs(record);
      if (container) releaseHavokShape(this.havok, container);
      for (const shape of provisional) if (shape !== container) releaseHavokShape(this.havok, shape);
      throw error;
    }

    const oldColliders = record.colliders;
    const oldContainer = record.container;
    record.colliders = next;
    for (const [id, collider] of oldColliders) if (next.get(id) !== collider) this.unindexCollider(record, collider);
    for (const [id, collider] of next) if (oldColliders.get(id) !== collider) this.indexCollider(record, collider);
    record.hostsShapes = false;
    for (const child of next.values()) {
      if (child.desc.actorId !== undefined && child.desc.actorId !== record.desc.actorId) {
        record.hostsShapes = true;
      }
    }
    if (topologyChanged) record.container = container;
    for (const id of oldColliders.keys()) this.colliders.delete(id);
    for (const [id, collider] of next) {
      collider.seq = ++this.colliderSeq;
      this.colliders.set(id, collider);
    }

    const changedContactPolicy = upsert.some((desc) => {
      const previous = oldColliders.get(desc.id)?.desc;
      return (
        previous &&
        (previous.isTrigger !== desc.isTrigger ||
          previous.layer !== desc.layer ||
          previous.mask !== desc.mask ||
          (previous.overlapMask ?? 0) !== (desc.overlapMask ?? 0) ||
          previous.actorId !== desc.actorId)
      );
    });
    const sameColliderIds =
      next.size === oldColliders.size && [...next.keys()].every((id) => oldColliders.has(id));
    if (changedContactPolicy || (topologyChanged && !sameColliderIds)) {
      this.contacts.retireTriggerPairs(record);
    } else if (topologyChanged) {
      this.contacts.refreshTriggerPairs(record);
    }
    if (topologyChanged && oldContainer) {
      releaseHavokShape(this.havok, oldContainer);
    }
    const liveShapes = new Set([...next.values()].flatMap((child) => colliderShapes(child)));
    for (const child of oldColliders.values()) {
      for (const shape of colliderShapes(child)) {
        if (!liveShapes.has(shape)) releaseHavokShape(this.havok, shape);
      }
    }
    this.markBodyAwake(record);
  }

  private applyColliderTuning(collider: ColliderRecord): void {
    const havok = this.havok;
    const { desc, shape, proxy } = collider;
    checked(havok, havok.HP_Shape_SetTrigger(shape, desc.isTrigger), "shape trigger flag");
    checked(
      havok,
      havok.HP_Shape_SetMaterial(shape, [
        desc.friction,
        desc.friction,
        desc.restitution,
        havok.MaterialCombine.MINIMUM,
        havok.MaterialCombine.MAXIMUM,
      ]),
      "shape material",
    );
    const collideMask = desc.isTrigger ? (desc.mask | (desc.overlapMask ?? 0)) >>> 0 : desc.mask >>> 0;
    checked(havok, havok.HP_Shape_SetFilterInfo(shape, [desc.layer >>> 0, collideMask]), "shape filter");
    if (!proxy) return;
    checked(havok, havok.HP_Shape_SetTrigger(proxy, true), "proxy trigger flag");
    // Havok 1.3.14 rejects density 0 (`E_INVALIDARG`); 1e-6 keeps the proxy negligible vs default 1000.
    checked(havok, havok.HP_Shape_SetDensity(proxy, 1e-6), "proxy density");
    checked(
      havok,
      havok.HP_Shape_SetFilterInfo(proxy, [desc.layer >>> 0, (desc.overlapMask ?? 0) >>> 0]),
      "proxy filter",
    );
  }

  listDebugColliders() {
    return listDebugCollidersFromRecords(this.colliders.values(), (bodyId) => this.getBodyTransform(bodyId));
  }

  pollContacts(): PhysicsContactEvent[] {
    return this.contacts.poll();
  }

  step(dt: number): void {
    this.flushMutations();
    if (dt <= 0) return;
    const stepTime = Math.min(dt, MAX_STEP_SECONDS);
    // Havok tunes its solver to the ideal step time, so a step of another length (time dilation) must announce it.
    if (stepTime !== this.idealStepTime) {
      checked(this.havok, this.havok.HP_World_SetIdealStepTime(this.worldId, stepTime), "world ideal step time");
      this.idealStepTime = stepTime;
    }
    this.stepping = true;
    try {
      checked(this.havok, this.havok.HP_World_Step(this.worldId, stepTime), "world step");
      this.syncSteppedBodyTransforms();
      this.contacts.drainNativeEvents(this.onStepCollision);
    } finally {
      this.stepping = false;
      this.contacts.nativeStepEnded();
    }
    // Before queued callback mutations, whose teleports await the next step.
    this.contacts.endUnconfirmedTriggerPairs();
    this.contacts.applyPendingReporting();
    this.flushMutations();
  }

  lineTrace(start: Vec3, end: Vec3, options?: LineTraceOptions): HitResult {
    return this.queries.lineTrace(start, end, options);
  }

  sphereOverlap(center: Vec3, radius: number, options?: LineTraceOptions): OverlapResult {
    return this.queries.sphereOverlap(center, radius, options);
  }

  shapeSweep(
    shape: ColliderDesc["shape"],
    start: PhysicsTransform,
    end: PhysicsTransform,
    options?: LineTraceOptions,
  ): HitResult {
    return this.queries.shapeSweep(shape, start, end, options);
  }

  createSphereSweep(radius: number): SphereSweepQuery {
    return this.queries.createSphereSweep(radius);
  }

  createCharacterController(desc: CharacterControllerDesc): void {
    this.characterControllers.createCharacterController(desc);
  }

  destroyCharacterController(id: string): void {
    this.characterControllers.destroyCharacterController(id);
  }

  moveCharacter(
    id: string,
    translation: Vec3,
    dt: number,
    startPose?: PhysicsTransform,
  ): CharacterMovementResult | null {
    return this.characterControllers.moveCharacter(id, translation, dt, startPose);
  }

  private markBodyAwake(record: BodyRecord): void {
    record.lastBufferMatrix = null;
    record.movedLastStep = record.desc.motionType !== "static";
  }

  /**
   * Read every non-static stepped body's pose directly from Havok's world body buffer (`HP_World_GetBodyBuffer` +
   * `HP_Body_GetWorldTransformOffset`) with zero per-body WASM calls and zero allocations.
   * When a body's 12 raw matrix floats are bit-identical to the previous step, skips quaternion extraction
   * and marks `movedLastStep = false` so `PhysicsReadback` can skip resting/sleeping bodies too.
   */
  private syncSteppedBodyTransforms(): void {
    if (this.activeMotionBodies.size === 0) return;
    const [res, bufferAddress] = this.havok.HP_World_GetBodyBuffer(this.worldId);
    const canReadBuffer = res === this.havok.Result.RESULT_OK && bufferAddress !== 0;
    if (canReadBuffer && this.heapFloat32?.buffer !== this.havok.HEAPU8.buffer) {
      this.heapFloat32 = new Float32Array(this.havok.HEAPU8.buffer);
    }
    const heap = this.heapFloat32;
    for (const record of this.activeMotionBodies) {
      if (!record.inWorld) {
        record.movedLastStep = false;
        continue;
      }
      const start = bufferAddress + record.worldTransformOffset;
      if (canReadBuffer && heap && start % 4 === 0) {
        const m = start >> 2;
        const m0 = heap[m]!, m1 = heap[m + 1]!, m2 = heap[m + 2]!;
        const m4 = heap[m + 4]!, m5 = heap[m + 5]!, m6 = heap[m + 6]!;
        const m8 = heap[m + 8]!, m9 = heap[m + 9]!, m10 = heap[m + 10]!;
        const m12 = heap[m + 12]!, m13 = heap[m + 13]!, m14 = heap[m + 14]!;
        let prev = record.lastBufferMatrix;
        if (
          prev !== null &&
          prev[0] === m0 && prev[1] === m1 && prev[2] === m2 &&
          prev[3] === m4 && prev[4] === m5 && prev[5] === m6 &&
          prev[6] === m8 && prev[7] === m9 && prev[8] === m10 &&
          prev[9] === m12 && prev[10] === m13 && prev[11] === m14
        ) {
          record.movedLastStep = false;
          continue;
        }
        if (prev === null) {
          prev = new Float32Array(12);
          record.lastBufferMatrix = prev;
        }
        prev[0] = m0; prev[1] = m1; prev[2] = m2;
        prev[3] = m4; prev[4] = m5; prev[5] = m6;
        prev[6] = m8; prev[7] = m9; prev[8] = m10;
        prev[9] = m12; prev[10] = m13; prev[11] = m14;
        readBodyBufferTransform(heap, m, record.pose);
        record.movedLastStep = true;
      } else {
        record.lastBufferMatrix = null;
        const [qRes, [pos, rot]] = this.havok.HP_Body_GetQTransform(record.hpBodyId);
        if (qRes === this.havok.Result.RESULT_OK) {
          const p = record.pose.position;
          const r = record.pose.rotation;
          const changed =
            p.x !== pos[0] || p.y !== pos[1] || p.z !== pos[2] ||
            r.x !== rot[0] || r.y !== rot[1] || r.z !== rot[2] || r.w !== rot[3];
          p.x = pos[0]; p.y = pos[1]; p.z = pos[2];
          r.x = rot[0]; r.y = rot[1]; r.z = rot[2]; r.w = rot[3];
          record.movedLastStep = changed || record.movedLastStep;
        }
      }
    }
  }

  private removeWorldMembership(record: BodyRecord): void {
    if (!record.inWorld) return;
    checked(this.havok, this.havok.HP_World_RemoveBody(this.worldId, record.hpBodyId), "query membership removal");
    record.inWorld = false;
  }

  private restoreWorldMembership(record: BodyRecord): void {
    if (record.inWorld) return;
    checked(this.havok, this.havok.HP_World_AddBody(this.worldId, record.hpBodyId, false), "query membership insertion");
    record.inWorld = true;
    record.worldTransformOffset = checkedValue(
      this.havok,
      this.havok.HP_Body_GetWorldTransformOffset(record.hpBodyId),
      "body transform offset",
    );
  }

  /**
   * Retire native contact pairs while the original shape is still attached (prevents Havok 1.3.14 hangs when
   * replacing an overlapping compound in-world), attach `shape`, and re-add the body.
   */
  private attachShape(record: BodyRecord, shape: HP_ShapeId | null): void {
    this.removeWorldMembership(record);
    checked(
      this.havok,
      this.havok.HP_Body_SetShape(record.hpBodyId, shape ?? NULL_SHAPE_ID),
      "native shape attachment",
    );
    record.attachedShape = shape;
    this.updateMassProperties(record);
    this.restoreWorldMembership(record);
  }

  /** Write `record.pose` into Havok without removing world membership (preserves active contacts). */
  private setBodyPoseBeforeStep(record: BodyRecord): void {
    checked(
      this.havok,
      this.havok.HP_Body_SetQTransform(record.hpBodyId, [
        toHavokVec3(record.pose.position),
        toHavokQuat(record.pose.rotation),
      ]),
      "native body teleport",
    );
    this.markBodyAwake(record);
  }

  /** Update `record.pose` and refresh Havok's query broadphase immediately via remove/re-add. */
  private teleportNativeBody(record: BodyRecord): void {
    this.setBodyPoseBeforeStep(record);
    this.removeWorldMembership(record);
    this.restoreWorldMembership(record);
  }

  private indexCollider(record: BodyRecord, collider: ColliderRecord): void {
    const owner = collider.desc.actorId ?? record.desc.actorId;
    let owned = this.collidersByOwner.get(owner);
    if (!owned) this.collidersByOwner.set(owner, (owned = new Set()));
    owned.add(collider);
    if (collider.desc.isTrigger) this.triggerColliders.add(collider);
  }

  private unindexCollider(record: BodyRecord, collider: ColliderRecord): void {
    const owner = collider.desc.actorId ?? record.desc.actorId;
    const owned = this.collidersByOwner.get(owner);
    if (owned?.delete(collider) && !owned.size) this.collidersByOwner.delete(owner);
    this.triggerColliders.delete(collider);
  }

  private applyMotionType(record: BodyRecord): void {
    checked(
      this.havok,
      this.havok.HP_Body_SetMotionType(record.hpBodyId, havokMotionType(this.havok, record.desc.motionType)),
      "body motion type",
    );
  }

  private applyBodyTuning(record: BodyRecord): void {
    checked(this.havok, this.havok.HP_Body_SetLinearDamping(record.hpBodyId, record.desc.linearDamping), "linear damping");
    checked(this.havok, this.havok.HP_Body_SetAngularDamping(record.hpBodyId, record.desc.angularDamping), "angular damping");
    checked(this.havok, this.havok.HP_Body_SetGravityFactor(record.hpBodyId, record.desc.gravityScale), "gravity factor");
    record.massProps.mass = record.desc.motionType === "static" ? 0 : Math.max(record.desc.mass, 1e-6);
    record.massProps.lockRotation = record.desc.lockRotation === true && record.desc.motionType === "dynamic";
    this.updateMassProperties(record);
  }

  private updateMassProperties(record: BodyRecord): void {
    let computed: MassProperties = [[0, 0, 0], 1, [1, 1, 1], [0, 0, 0, 1]];
    const shapeRes = this.havok.HP_Body_GetShape(record.hpBodyId);
    if (shapeRes[0] === this.havok.Result.RESULT_OK && shapeRes[1][0] !== 0n) {
      const shapeMass = this.havok.HP_Shape_BuildMassProperties(shapeRes[1]);
      if (shapeMass[0] === this.havok.Result.RESULT_OK) {
        computed = shapeMass[1];
      }
    }
    const next: MassProperties = [
      computed[0],
      record.massProps.mass,
      record.massProps.lockRotation ? [0, 0, 0] : computed[2],
      computed[3],
    ];
    checked(this.havok, this.havok.HP_Body_SetMassProperties(record.hpBodyId, next), "mass properties");
  }

  private disposeBodyRecord(record: BodyRecord): void {
    this.bodyIdByHpId.delete(record.hpBodyId[0]);
    if (record.inWorld) {
      this.havok.HP_World_RemoveBody(this.worldId, record.hpBodyId);
      record.inWorld = false;
    }
    this.havok.HP_Body_Release(record.hpBodyId);
    if (record.container) releaseHavokShape(this.havok, record.container);
    // Partition uncertain containers vs child shapes before releasing either so containers release first without double-freeing.
    const uncertainContainers: HP_ShapeId[] = [];
    const uncertainChildren: HP_ShapeId[] = [];
    for (const shape of record.uncertainShapes) {
      const typeRes = this.havok.HP_Shape_GetType(shape);
      if (typeRes[0] === this.havok.Result.RESULT_OK && typeRes[1] === this.havok.ShapeType.CONTAINER) {
        uncertainContainers.push(shape);
      } else {
        uncertainChildren.push(shape);
      }
    }
    for (const shape of uncertainContainers) releaseHavokShape(this.havok, shape);
    for (const collider of record.colliders.values()) {
      for (const shape of colliderShapes(collider)) releaseHavokShape(this.havok, shape);
    }
    for (const shape of uncertainChildren) releaseHavokShape(this.havok, shape);
    record.uncertainShapes.clear();
    for (const collider of record.colliders.values()) this.unindexCollider(record, collider);
    record.colliders.clear();
  }

  private assertHealthy(record: BodyRecord): void {
    if (record.mutationFailure) throw record.mutationFailure;
  }

  private failMutation(record: BodyRecord, failure: Error): Error {
    record.mutationFailure = failure;
    this.failedBodies.add(record);
    return failure;
  }

  private flushMutations(): void {
    this.assertLive();
    if (this.stepping && this.pendingMutations.length) {
      throw new Error("Queued physics mutations cannot be queried from native callbacks");
    }
    if (this.stepping) return;
    while (this.pendingMutations.length && !this.disposed) {
      this.pendingMutations.shift()!();
    }
    if (this.failedBodies.size > 0) {
      for (const record of this.bodies.values()) this.assertHealthy(record);
    }
  }

  private assertLive(): void {
    if (this.disposed) throw new Error("HavokPhysicsBackend is disposed");
  }
}
