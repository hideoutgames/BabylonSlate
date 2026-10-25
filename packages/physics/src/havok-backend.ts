import "@babylonjs/core/Physics/physicsEngineComponent";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { HavokPlugin } from "@babylonjs/core/Physics/v2/Plugins/havokPlugin";
import { PhysicsBody } from "@babylonjs/core/Physics/v2/physicsBody";
import type { Physics6DoFConstraint } from "@babylonjs/core/Physics/v2/physicsConstraint";
import {
  PhysicsMotionType,
  PhysicsPrestepType,
  PhysicsActivationControl,
} from "@babylonjs/core/Physics/v2/IPhysicsEnginePlugin";
import {
  PhysicsShape,
  PhysicsShapeContainer,
} from "@babylonjs/core/Physics/v2/physicsShape";
import type { PhysicsBackend, SphereSweepQuery } from "./backend";
import type {
  CharacterControllerDesc,
  CharacterMovementResult,
  BodyVelocity,
  ConstraintDesc,
  ColliderDesc,
  ColliderChanges,
  HitResult,
  LineTraceOptions,
  MotionType,
  OverlapResult,
  PhysicsBackendOptions,
  PhysicsTransform,
  TeleportOptions,
  RigidBodyDesc,
  RigidBodyTuning,
  Vec3,
  PhysicsContactEvent,
} from "./types";
import {
  copyColliderDesc,
  identityColliderPose,
  normalizedPhysicsPose,
  sameColliderGeometry,
  sameColliderPose,
} from "./collider-validation";
import { attachHavokShape, teleportHavokBody } from "./havok-native-adapter";
import { listDebugCollidersFromRecords } from "./debug-colliders";
import { loadHavokModule } from "./havok-loader";
import { rotateQuatVec } from "./collider-bake";
import { copyConstraintDesc } from "./constraint-validation";
import { assertHavokConstraintAttached, disposeHavokConstraint, makeHavokConstraint } from "./havok-constraints";
import {
  colliderShapes,
  createHavokShape,
  isShape3D,
  toQuaternion,
  toVector3,
  type BodyRecord,
  type ColliderRecord,
} from "./havok-records";
import { HavokQueries } from "./havok-queries";
import { HavokContacts } from "./havok-contacts";
import { HavokCharacters } from "./havok-characters";

/** A non-trigger collider that overlaps some layer gets a trigger proxy (`ColliderRecord.proxy`). */
function needsOverlapProxy(desc: ColliderDesc): boolean {
  return !desc.isTrigger && (desc.overlapMask ?? 0) !== 0;
}

function motionTypeOf(motion: MotionType): PhysicsMotionType {
  switch (motion) {
    case "static":
      return PhysicsMotionType.STATIC;
    case "kinematic":
      return PhysicsMotionType.ANIMATED;
    default:
      return PhysicsMotionType.DYNAMIC;
  }
}

/**
 * 3D backend: explicitly owned Babylon Physics V2 bodies and shapes on a
 * worker-local `NullEngine` Scene. This Scene is not the editor/render Scene;
 * `@haptic/runtime` still does not import Babylon.
 */
export class HavokPhysicsBackend implements PhysicsBackend {
  readonly kind = "3d" as const;
  readonly supportsConstraints = true;
  readonly plugin: HavokPlugin;
  readonly scene: Scene;
  private readonly engine: NullEngine;
  private readonly bodies = new Map<string, BodyRecord>();
  /** Each actor's live bodies, so `setContactReporting` reaches them without scanning every body. */
  private readonly bodiesByActor = new Map<string, Set<BodyRecord>>();
  private bodySeq = 0;
  /** Bodies with a `mutationFailure`, so `flushMutations` scans `bodies` only when one exists. */
  private readonly failedBodies = new Set<BodyRecord>();
  private readonly colliders = new Map<string, ColliderRecord>();
  /**
   * Every live body's colliders by shape owner (`desc.actorId`, else the body's actor, so a hosted shape sits under the
   * child it was hosted for) and the trigger subset. Mirrors each `BodyRecord.colliders`, so a filtered query masks only
   * the shapes it excludes instead of scanning every shape.
   */
  private readonly collidersByOwner = new Map<string, Set<ColliderRecord>>();
  private readonly triggerColliders = new Set<ColliderRecord>();
  private readonly constraints = new Map<string, { desc: ConstraintDesc; constraint: Physics6DoFConstraint }>();
  private readonly bodyIdByPhysicsBody = new Map<PhysicsBody, string>();
  private readonly tmpImpulse = new Vector3();
  private readonly tmpLocation = new Vector3();
  private disposed = false;
  private stepping = false;
  private pendingMutations: Array<() => void> = [];
  private colliderSeq = 0;
  private readonly queries: HavokQueries;
  private readonly contacts: HavokContacts;
  private readonly characterControllers: HavokCharacters;

  private constructor(engine: NullEngine, scene: Scene, plugin: HavokPlugin) {
    this.engine = engine;
    this.scene = scene;
    this.plugin = plugin;
    // Hosts pass the live maps and call back through closures, so a dispose queued during a query and spies on
    // public methods still apply.
    this.queries = new HavokQueries({
      scene,
      plugin,
      bodies: this.bodies,
      bodyIdByPhysicsBody: this.bodyIdByPhysicsBody,
      collidersByOwner: this.collidersByOwner,
      triggerColliders: this.triggerColliders,
      isDisposed: () => this.disposed,
      flushMutations: () => this.flushMutations(),
    });
    this.characterControllers = new HavokCharacters({
      scene,
      plugin,
      bodies: this.bodies,
      flushMutations: () => this.flushMutations(),
      failMutation: (record, failure) => this.failMutation(record, failure),
      getBodyTransform: (bodyId) => this.getBodyTransform(bodyId),
      setBodyTargetTransform: (bodyId, transform) => this.setBodyTargetTransform(bodyId, transform),
      teleportBody: (bodyId, transform) => this.teleportBody(bodyId, transform),
    });
    this.contacts = new HavokContacts({
      plugin,
      bodies: this.bodies,
      bodyIdByPhysicsBody: this.bodyIdByPhysicsBody,
      collidersByOwner: this.collidersByOwner,
    });
  }

  static async create(
    options: PhysicsBackendOptions,
  ): Promise<HavokPhysicsBackend> {
    const havok = await loadHavokModule(options.havokWasmUrl);
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const plugin = new HavokPlugin(true, havok);
    const gravity = new Vector3(
      options.gravity.x,
      options.gravity.y,
      options.gravity.z,
    );
    if (!scene.enablePhysics(gravity, plugin)) {
      engine.dispose();
      throw new Error("scene.enablePhysics failed to initialize HavokPlugin");
    }
    return new HavokPhysicsBackend(engine, scene, plugin);
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
    for (const record of this.constraints.values()) disposeHavokConstraint(this.plugin, record.constraint);
    this.constraints.clear();
    this.colliders.clear();
    for (const record of this.bodies.values()) {
      this.disposeBodyRecord(record);
    }
    this.bodies.clear();
    this.bodiesByActor.clear();
    this.collidersByOwner.clear();
    this.triggerColliders.clear();
    this.failedBodies.clear();
    this.bodyIdByPhysicsBody.clear();
    this.pendingMutations = [];
    this.contacts.clear();
    this.scene.disablePhysicsEngine();
    this.scene.dispose();
    this.engine.dispose();
  }

  setGravity(gravity: Vec3): void {
    this.scene.getPhysicsEngine()?.setGravity(toVector3(gravity));
  }

  createBody(desc: RigidBodyDesc): void {
    this.assertLive();
    if (this.stepping)
      throw new Error("Cannot create a physics body during native stepping");
    if (this.bodies.has(desc.id))
      throw new Error(`Physics body already exists: ${desc.id}`);
    const transform = normalizedPhysicsPose(desc.transform);
    const node = new TransformNode(desc.id, this.scene);
    let body: PhysicsBody | undefined;
    try {
      node.position.copyFrom(toVector3(transform.position));
      node.rotationQuaternion = toQuaternion(transform.rotation);
      node.computeWorldMatrix(true);
      body = new PhysicsBody(
        node,
        motionTypeOf(desc.motionType),
        false,
        this.scene,
      );
      const record: BodyRecord = {
        order: ++this.bodySeq,
        desc: { ...desc, transform },
        node,
        body,
        reporting: desc.reportContacts !== false,
        colliders: new Map(),
        container: null,
        hostsShapes: false,
        uncertainShapes: new Set(),
      };
      this.applyMotionType(record);
      this.applyBodyTuning(record);
      body.setCollisionCallbackEnabled(record.reporting);
      this.bodies.set(desc.id, record);
      this.bodyIdByPhysicsBody.set(body, desc.id);
      let owned = this.bodiesByActor.get(desc.actorId);
      if (!owned) this.bodiesByActor.set(desc.actorId, (owned = new Set()));
      owned.add(record);
    } catch (error) {
      body?.dispose();
      node.dispose();
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
      if (constraint.desc.bodyAId === bodyId || constraint.desc.bodyBId === bodyId) this.destroyConstraint(id);
    }
    this.contacts.retireTriggerPairs(record);
    // The body's colliders are exactly the backend entries naming it (a collider id belongs to one body).
    for (const id of record.colliders.keys()) this.colliders.delete(id);
    this.characterControllers.destroyForBody(bodyId);
    this.disposeBodyRecord(record);
    this.bodies.delete(bodyId);
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
    for (const record of this.bodiesByActor.get(actorId) ?? []) this.contacts.requestReporting(record, enabled);
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
    const constraint = makeHavokConstraint(desc, this.scene);
    try {
      a.body.addConstraint(b.body, constraint);
      assertHavokConstraintAttached(this.plugin, constraint, a.body, b.body);
      const previous = this.constraints.get(desc.id);
      if (previous) disposeHavokConstraint(this.plugin, previous.constraint);
      this.constraints.set(desc.id, { desc, constraint });
    } catch (error) {
      disposeHavokConstraint(this.plugin, constraint);
      throw error;
    }
  }

  destroyConstraint(id: string): void {
    if (this.stepping) {
      this.pendingMutations.push(() => this.destroyConstraint(id));
      return;
    }
    const record = this.constraints.get(id);
    if (!record) return;
    disposeHavokConstraint(this.plugin, record.constraint);
    this.constraints.delete(id);
  }

  teleportBody(
    bodyId: string,
    transform: PhysicsTransform,
    options: TeleportOptions = {},
  ): void {
    const pose = normalizedPhysicsPose(transform);
    const velocity = options.velocity;
    if (this.stepping) {
      this.pendingMutations.push(() =>
        this.teleportBody(bodyId, pose, { velocity }),
      );
      return;
    }
    const record = this.bodies.get(bodyId);
    if (!record) return;
    this.assertHealthy(record);
    const body = record.body;
    const previousPose = this.getBodyTransform(bodyId)!;
    const previousLinear = body.getLinearVelocity(),
      previousAngular = body.getAngularVelocity();
    const linear = velocity === "reset" ? Vector3.Zero() : previousLinear;
    const angular = velocity === "reset" ? Vector3.Zero() : previousAngular;
    record.node.position.copyFrom(toVector3(pose.position));
    record.node.rotationQuaternion = toQuaternion(pose.rotation);
    try {
      teleportHavokBody(this.plugin, body);
      body.setLinearVelocity(linear);
      body.setAngularVelocity(angular);
      // Explicit teleports wake sleeping bodies, then restore ordinary simulation control.
      this.plugin.setActivationControl(
        body,
        PhysicsActivationControl.ALWAYS_ACTIVE,
      );
      this.plugin.setActivationControl(
        body,
        PhysicsActivationControl.SIMULATION_CONTROLLED,
      );
    } catch (error) {
      record.node.position.copyFrom(toVector3(previousPose.position));
      record.node.rotationQuaternion = toQuaternion(previousPose.rotation);
      try {
        teleportHavokBody(this.plugin, body);
        body.setLinearVelocity(previousLinear);
        body.setAngularVelocity(previousAngular);
      } catch (rollbackError) {
        throw this.failMutation(record, new AggregateError(
          [error, rollbackError],
          `Havok teleport rollback failed for ${bodyId}`,
        ));
      }
      this.contacts.retireTriggerPairs(record);
      throw error;
    }
    record.desc.transform = pose;
    // World membership refresh drops native pairs without emitting exits.
    this.contacts.refreshTriggerPairs(record);
    this.characterControllers.bodyTeleported(bodyId, pose.position);
  }

  setBodyTargetTransform(bodyId: string, transform: PhysicsTransform): void {
    const pose = normalizedPhysicsPose(transform);
    if (this.stepping) {
      this.pendingMutations.push(() =>
        this.setBodyTargetTransform(bodyId, pose),
      );
      return;
    }
    const record = this.bodies.get(bodyId);
    if (!record) return;
    this.assertHealthy(record);
    if (record.desc.motionType !== "kinematic")
      throw new Error("Only kinematic bodies accept motion targets");
    record.body.setTargetTransform(
      toVector3(pose.position),
      toQuaternion(pose.rotation),
    );
  }

  getBodyTransform(bodyId: string): PhysicsTransform | null {
    const out = { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } };
    return this.readBodyTransform(bodyId, out) ? out : null;
  }

  readBodyTransform(bodyId: string, out: PhysicsTransform): boolean {
    const record = this.bodies.get(bodyId);
    if (!record) return false;
    const { position, rotationQuaternion: q } = record.node;
    out.position.x = position.x;
    out.position.y = position.y;
    out.position.z = position.z;
    out.rotation.x = q?.x ?? 0;
    out.rotation.y = q?.y ?? 0;
    out.rotation.z = q?.z ?? 0;
    out.rotation.w = q ? q.w : 1;
    return true;
  }

  getBodyVelocity(bodyId: string): BodyVelocity | null {
    const record = this.bodies.get(bodyId);
    const transform = this.getBodyTransform(bodyId);
    if (!record || !transform) return null;
    const linear = record.body.getLinearVelocity();
    const angular = record.body.getAngularVelocity();
    const offset = rotateQuatVec(transform.rotation, record.body.getMassProperties().centerOfMass ?? { x: 0, y: 0, z: 0 });
    return {
      linear: { x: linear.x, y: linear.y, z: linear.z },
      angular: { x: angular.x, y: angular.y, z: angular.z },
      centerOfMass: { x: transform.position.x + offset.x, y: transform.position.y + offset.y, z: transform.position.z + offset.z },
    };
  }

  setBodyAngularVelocity(bodyId: string, velocity: Vec3): void {
    if (![velocity.x, velocity.y, velocity.z].every(Number.isFinite))
      throw new Error("Angular velocity must be finite");
    if (this.stepping) {
      const owned = { ...velocity };
      this.pendingMutations.push(() => this.setBodyAngularVelocity(bodyId, owned));
      return;
    }
    const record = this.bodies.get(bodyId);
    if (!record || record.desc.motionType !== "dynamic") return;
    this.assertHealthy(record);
    record.body.setAngularVelocity(toVector3(velocity));
  }

  setBodyLinearVelocity(bodyId: string, velocity: Partial<Vec3>): void {
    const record = this.bodies.get(bodyId);
    const body = record?.body;
    if (!body || record.desc.motionType !== "dynamic") return;
    const current = body.getLinearVelocity();
    for (const axis of ["x", "y", "z"] as const) {
      const value = velocity[axis];
      if (typeof value === "number" && Number.isFinite(value))
        current[axis] = value;
    }
    body.setLinearVelocity(current);
  }

  addImpulse(bodyId: string, impulse: Vec3, strength = 1): void {
    const record = this.bodies.get(bodyId);
    const body = record?.body;
    if (!body || record.desc.motionType !== "dynamic") return;
    this.tmpImpulse.set(
      impulse.x * strength,
      impulse.y * strength,
      impulse.z * strength,
    );
    body.getObjectCenterWorldToRef(this.tmpLocation);
    body.applyImpulse(this.tmpImpulse, this.tmpLocation);
  }

  addImpulseAtPoint(bodyId: string, impulse: Vec3, point: Vec3): void {
    const record = this.bodies.get(bodyId);
    if (!record?.body || record.desc.motionType !== "dynamic") return;
    if (![impulse.x, impulse.y, impulse.z, point.x, point.y, point.z].every(Number.isFinite)) return;
    this.tmpImpulse.set(impulse.x, impulse.y, impulse.z);
    this.tmpLocation.set(point.x, point.y, point.z);
    record.body.applyImpulse(this.tmpImpulse, this.tmpLocation);
  }

  getBodyImpulseResponse(bodyId: string, impulse: Vec3, point: Vec3) {
    const record = this.bodies.get(bodyId);
    if (!record || record.desc.motionType !== "dynamic") return null;
    const props = record.body.getMassProperties();
    const mass = props.mass ?? record.desc.mass;
    if (mass <= 0) return null;
    const rotation = record.node.rotationQuaternion ?? Quaternion.Identity();
    const center = props.centerOfMass?.clone() ?? Vector3.Zero();
    center.rotateByQuaternionToRef(rotation, center);
    center.addInPlace(record.node.position);
    const orientation = rotation.multiply(props.inertiaOrientation ?? Quaternion.Identity());
    const torque = Vector3.Cross(new Vector3(point.x, point.y, point.z).subtract(center), new Vector3(impulse.x, impulse.y, impulse.z));
    torque.rotateByQuaternionToRef(orientation.conjugate(), torque);
    // Havok reports principal inertia per unit mass; zero means a locked axis.
    for (const axis of ["x", "y", "z"] as const)
      torque[axis] = props.inertia && props.inertia[axis] > 0 ? torque[axis] / (mass * props.inertia[axis]) : 0;
    torque.rotateByQuaternionToRef(orientation, torque);
    return {
      linear: { x: impulse.x / mass, y: impulse.y / mass, z: impulse.z / mass },
      angular: { x: torque.x, y: torque.y, z: torque.z },
      centerOfMass: { x: center.x, y: center.y, z: center.z },
    };
  }

  updateBody(bodyId: string, tuning: RigidBodyTuning): void {
    const record = this.bodies.get(bodyId);
    if (!record) return;
    if (tuning.motionType) record.desc.motionType = tuning.motionType;
    if (typeof tuning.mass === "number" && Number.isFinite(tuning.mass)) {
      record.desc.mass = tuning.mass;
    }
    if (
      typeof tuning.linearDamping === "number" &&
      Number.isFinite(tuning.linearDamping)
    ) {
      record.desc.linearDamping = tuning.linearDamping;
    }
    if (
      typeof tuning.angularDamping === "number" &&
      Number.isFinite(tuning.angularDamping)
    ) {
      record.desc.angularDamping = tuning.angularDamping;
    }
    if (
      typeof tuning.gravityScale === "number" &&
      Number.isFinite(tuning.gravityScale)
    ) {
      record.desc.gravityScale = tuning.gravityScale;
    }
    if (typeof tuning.lockRotation === "boolean") {
      record.desc.lockRotation = tuning.lockRotation;
    }
    if (tuning.motionType) this.applyMotionType(record);
    this.applyBodyTuning(record);
  }

  createCollider(desc: ColliderDesc): void {
    this.applyColliderChanges(desc.bodyId, { upsert: [desc], remove: [] });
  }

  destroyCollider(colliderId: string): void {
    const collider = this.colliders.get(colliderId);
    if (collider)
      this.applyColliderChanges(collider.desc.bodyId, {
        upsert: [],
        remove: [colliderId],
      });
  }

  applyColliderChanges(bodyId: string, changes: ColliderChanges): void {
    this.assertLive();
    // Copy and validate every descriptor before any native allocation or mutation.
    const upsert = changes.upsert.map(copyColliderDesc);
    if (new Set(upsert.map((desc) => desc.id)).size !== upsert.length)
      throw new Error("Duplicate collider ID in transaction");
    const remove = [...changes.remove];
    if (this.stepping) {
      this.pendingMutations.push(() =>
        this.applyColliderChanges(bodyId, { upsert, remove }),
      );
      return;
    }
    const record = this.bodies.get(bodyId);
    if (!record) return;
    this.assertHealthy(record);
    const next = new Map(record.colliders);
    for (const id of remove) next.delete(id);
    const provisional = new Set<PhysicsShape>();
    let container: PhysicsShapeContainer | null = null;
    let topologyChanged = remove.some((id) => record.colliders.has(id));
    try {
      for (const desc of upsert) {
        if (desc.bodyId !== bodyId)
          throw new Error("Collider transaction crosses body ownership");
        if (!isShape3D(desc.shape))
          throw new Error("A 3D body cannot own a planar collider");
        const previous = this.colliders.get(desc.id);
        if (previous && previous.desc.bodyId !== bodyId)
          throw new Error(`Collider belongs to another body: ${desc.id}`);
        const sameGeometry =
          previous && sameColliderGeometry(previous.desc.shape, desc.shape);
        const shape = sameGeometry
          ? previous.shape
          : createHavokShape(desc.shape, this.scene);
        if (!sameGeometry) provisional.add(shape);
        let proxy: PhysicsShape | undefined;
        if (needsOverlapProxy(desc)) {
          proxy = sameGeometry && previous.proxy ? previous.proxy : createHavokShape(desc.shape, this.scene);
          if (proxy !== previous?.proxy) provisional.add(proxy);
        }
        topologyChanged ||=
          !previous || !sameGeometry || !sameColliderPose(previous.desc, desc) || proxy !== previous.proxy;
        next.set(desc.id, { desc, shape, ...(proxy ? { proxy } : {}), seq: 0 });
      }
      // Container child indices are derived from this live order, never used as IDs.
      if (
        topologyChanged &&
        next.size &&
        !(
          next.size === 1 &&
          !next.values().next().value!.proxy &&
          identityColliderPose(next.values().next().value!.desc)
        )
      ) {
        container = new PhysicsShapeContainer(this.scene);
        provisional.add(container);
        for (const child of next.values())
          for (const shape of child.proxy ? [child.shape, child.proxy] : [child.shape])
            container.addChild(
              shape,
              toVector3(child.desc.translation!),
              toQuaternion(child.desc.rotation!),
            );
      }
    } catch (error) {
      container?.dispose();
      for (const shape of provisional) if (shape !== container) shape.dispose();
      throw error;
    }
    const body = record.body;
    const oldAttachment = body.shape;
    const linear = body.getLinearVelocity(),
      angular = body.getAngularVelocity();
    const attachment = container ?? next.values().next().value?.shape ?? null;
    try {
      if (topologyChanged) attachHavokShape(this.plugin, body, attachment);
      for (const child of next.values())
        this.applyColliderTuning(child);
      if (topologyChanged) this.applyBodyTuning(record);
      body.setLinearVelocity(linear);
      body.setAngularVelocity(angular);
    } catch (error) {
      try {
        if (topologyChanged) attachHavokShape(this.plugin, body, oldAttachment);
        for (const child of record.colliders.values())
          this.applyColliderTuning(child);
        this.applyBodyTuning(record);
        body.setLinearVelocity(linear);
        body.setAngularVelocity(angular);
      } catch (rollbackError) {
        for (const shape of provisional) record.uncertainShapes.add(shape);
        throw this.failMutation(record, new AggregateError(
          [error, rollbackError],
          `Havok collider rollback failed for ${bodyId}`,
        ));
      }
      if (topologyChanged) this.contacts.retireTriggerPairs(record);
      container?.dispose();
      for (const shape of provisional) if (shape !== container) shape.dispose();
      throw error;
    }
    const oldColliders = record.colliders,
      oldContainer = record.container;
    record.colliders = next;
    for (const [id, collider] of oldColliders) if (next.get(id) !== collider) this.unindexCollider(record, collider);
    for (const [id, collider] of next) if (oldColliders.get(id) !== collider) this.indexCollider(record, collider);
    record.hostsShapes = false;
    for (const child of next.values())
      if (child.desc.actorId !== undefined && child.desc.actorId !== record.desc.actorId) record.hostsShapes = true;
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
      next.size === oldColliders.size &&
      [...next.keys()].every((id) => oldColliders.has(id));
    // New poses or shapes under the same IDs (a hosted child moving on its
    // host) keep overlaps open as a teleport does; the next step re-confirms them.
    if (changedContactPolicy || (topologyChanged && !sameColliderIds))
      this.contacts.retireTriggerPairs(record);
    else if (topologyChanged) this.contacts.refreshTriggerPairs(record);
    if (topologyChanged) {
      oldContainer?.dispose();
    }
    const liveShapes = new Set([...next.values()].flatMap((child) => colliderShapes(child)));
    for (const child of oldColliders.values())
      for (const shape of colliderShapes(child)) if (!liveShapes.has(shape)) shape.dispose();
  }

  private applyColliderTuning(collider: ColliderRecord): void {
    const { desc, shape, proxy } = collider;
    shape.isTrigger = desc.isTrigger;
    shape.material = { friction: desc.friction, restitution: desc.restitution };
    shape.filterMembershipMask = desc.layer;
    // A trigger reports overlaps with every layer it does not ignore.
    shape.filterCollideMask = desc.isTrigger ? (desc.mask | (desc.overlapMask ?? 0)) >>> 0 : desc.mask;
    if (!proxy) return;
    proxy.isTrigger = true;
    proxy.density = 0;
    proxy.filterMembershipMask = desc.layer;
    proxy.filterCollideMask = desc.overlapMask ?? 0;
  }

  listDebugColliders() {
    return listDebugCollidersFromRecords(this.colliders.values(), (bodyId) =>
      this.getBodyTransform(bodyId),
    );
  }

  pollContacts(): PhysicsContactEvent[] {
    return this.contacts.poll();
  }

  step(dt: number): void {
    this.flushMutations();
    if (dt <= 0) return;
    this.stepping = true;
    try {
      this.scene.getPhysicsEngine()?._step(dt);
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

  private applyMotionType(record: BodyRecord): void {
    const body = record.body;
    if (!body) return;
    const motion = motionTypeOf(record.desc.motionType);
    body.setMotionType(motion);
    body.setPrestepType(PhysicsPrestepType.DISABLED);
    body.disableSync = motion === PhysicsMotionType.STATIC;
  }

  private applyBodyTuning(record: BodyRecord): void {
    const body = record.body;
    if (!body) return;
    body.setLinearDamping(record.desc.linearDamping);
    body.setAngularDamping(record.desc.angularDamping);
    body.setGravityFactor(record.desc.gravityScale);
    body.setMassProperties({
      mass:
        record.desc.motionType === "static"
          ? 0
          : Math.max(record.desc.mass, 1e-6),
      // Zero inertia is Havok's locked rotation; without it the shape's inertia is recomputed.
      inertia:
        record.desc.lockRotation && record.desc.motionType === "dynamic"
          ? Vector3.Zero()
          : undefined,
    });
  }

  private disposeBodyRecord(record: BodyRecord): void {
    this.bodyIdByPhysicsBody.delete(record.body);
    record.body.dispose();
    record.container?.dispose();
    // If rollback failed, both generations remain owned until the native user is gone.
    for (const shape of record.uncertainShapes)
      if (shape instanceof PhysicsShapeContainer) shape.dispose();
    for (const collider of record.colliders.values()) for (const shape of colliderShapes(collider)) shape.dispose();
    for (const shape of record.uncertainShapes) shape.dispose();
    record.uncertainShapes.clear();
    for (const collider of record.colliders.values()) this.unindexCollider(record, collider);
    record.colliders.clear();
    record.node.dispose();
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
    if (this.stepping && this.pendingMutations.length)
      throw new Error(
        "Queued physics mutations cannot be queried from native callbacks",
      );
    if (this.stepping) return;
    while (this.pendingMutations.length && !this.disposed)
      this.pendingMutations.shift()!();
    // The scan keeps the first failed body in `bodies` order as the error raised.
    if (this.failedBodies.size > 0)
      for (const record of this.bodies.values()) this.assertHealthy(record);
  }

  private assertLive(): void {
    if (this.disposed) throw new Error("HavokPhysicsBackend is disposed");
  }
}
