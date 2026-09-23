import "@babylonjs/core/Physics/physicsEngineComponent";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { HavokPlugin } from "@babylonjs/core/Physics/v2/Plugins/havokPlugin";
import { PhysicsBody } from "@babylonjs/core/Physics/v2/physicsBody";
import { PhysicsCharacterController } from "@babylonjs/core/Physics/v2/characterController";
import {
  PhysicsEventType,
  PhysicsMotionType,
  PhysicsPrestepType,
  PhysicsActivationControl,
} from "@babylonjs/core/Physics/v2/IPhysicsEnginePlugin";
import {
  PhysicsShape,
  PhysicsShapeBox,
  PhysicsShapeCapsule,
  PhysicsShapeContainer,
  PhysicsShapeConvexHull,
  PhysicsShapeCylinder,
  PhysicsShapeMesh,
  PhysicsShapeSphere,
} from "@babylonjs/core/Physics/v2/physicsShape";
import { ShapeCastResult } from "@babylonjs/core/Physics/shapeCastResult";
import type { PhysicsBackend } from "./backend";
import type {
  CharacterControllerDesc,
  ColliderDesc,
  ColliderChanges,
  ColliderShape,
  ColliderTuning,
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
  validateColliderShape,
} from "./collider-validation";
import { attachHavokShape, teleportHavokBody } from "./havok-native-adapter";
import { listDebugCollidersFromRecords } from "./debug-colliders";
import { loadHavokModule } from "./havok-loader";

type BodyRecord = {
  desc: RigidBodyDesc;
  node: TransformNode;
  body: PhysicsBody;
  colliders: Map<string, ColliderRecord>;
  container: PhysicsShapeContainer | null;
  /** Failed rollback keeps possibly attached resources alive until body teardown. */
  uncertainShapes: Set<PhysicsShape>;
  mutationFailure?: Error;
};

type ColliderRecord = {
  desc: ColliderDesc;
  shape: PhysicsShape;
};

type CharacterRecord = {
  desc: CharacterControllerDesc;
  controller: PhysicsCharacterController;
  shape: PhysicsShape;
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

function toVector3(v: Vec3): Vector3 {
  return new Vector3(v.x, v.y, v.z);
}

function toQuaternion(r: PhysicsTransform["rotation"]): Quaternion {
  return new Quaternion(r.x, r.y, r.z, r.w);
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

/**
 * 3D backend: explicitly owned Babylon Physics V2 bodies and shapes on a
 * worker-local `NullEngine` Scene. This Scene is not the editor/render Scene;
 * `@babylonslate/runtime` still does not import Babylon.
 */
export class HavokPhysicsBackend implements PhysicsBackend {
  readonly kind = "3d" as const;
  readonly plugin: HavokPlugin;
  readonly scene: Scene;
  private readonly engine: NullEngine;
  private readonly bodies = new Map<string, BodyRecord>();
  private readonly colliders = new Map<string, ColliderRecord>();
  private readonly characters = new Map<string, CharacterRecord>();
  private readonly bodyIdByPhysicsBody = new Map<PhysicsBody, string>();
  private readonly tmpFrom = new Vector3();
  private readonly tmpTo = new Vector3();
  private readonly tmpImpulse = new Vector3();
  private readonly tmpLocation = new Vector3();
  private readonly zeroGravity = Vector3.Zero();
  private readonly down = new Vector3(0, -1, 0);
  private disposed = false;
  private stepping = false;
  private pendingMutations: Array<() => void> = [];
  private readonly removeCollisionObservers: Array<() => void> = [];
  private readonly resetTriggerActors = new Set<string>();
  private pendingContacts: PhysicsContactEvent[] = [];
  private readonly activeTriggerPairs = new Map<
    string,
    {
      actorAId: string;
      actorBId: string;
      contacts: number;
    }
  >();

  private constructor(engine: NullEngine, scene: Scene, plugin: HavokPlugin) {
    this.engine = engine;
    this.scene = scene;
    this.plugin = plugin;
    this.bindCollisionObservables();
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
    for (const remove of this.removeCollisionObservers) remove();
    this.removeCollisionObservers.length = 0;
    for (const character of this.characters.values()) {
      character.controller.dispose();
      character.shape.dispose();
    }
    this.characters.clear();
    this.colliders.clear();
    for (const record of this.bodies.values()) {
      this.disposeBodyRecord(record);
    }
    this.bodies.clear();
    this.bodyIdByPhysicsBody.clear();
    this.activeTriggerPairs.clear();
    this.pendingContacts = [];
    this.pendingMutations = [];
    this.resetTriggerActors.clear();
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
        desc: { ...desc, transform },
        node,
        body,
        colliders: new Map(),
        container: null,
        uncertainShapes: new Set(),
      };
      this.applyMotionType(record);
      this.applyBodyTuning(record);
      this.enableCollisionCallbacks(body);
      this.bodies.set(desc.id, record);
      this.bodyIdByPhysicsBody.set(body, desc.id);
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
    this.retireTriggerPairs(record.desc.actorId);
    for (const [id, collider] of [...this.colliders]) {
      if (collider.desc.bodyId === bodyId) this.colliders.delete(id);
    }
    for (const [id, character] of [...this.characters]) {
      if (character.desc.bodyId === bodyId) {
        character.controller.dispose();
        character.shape.dispose();
        this.characters.delete(id);
      }
    }
    this.disposeBodyRecord(record);
    this.bodies.delete(bodyId);
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
        record.mutationFailure = new AggregateError(
          [error, rollbackError],
          `Havok teleport rollback failed for ${bodyId}`,
        );
        throw record.mutationFailure;
      }
      this.retireTriggerPairs(record.desc.actorId);
      throw error;
    }
    record.desc.transform = pose;
    // World membership refresh retires native pairs without emitting exits.
    this.retireTriggerPairs(record.desc.actorId);
    for (const character of this.characters.values()) {
      if (character.desc.bodyId === bodyId)
        character.controller.setPosition(toVector3(pose.position));
    }
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
    const record = this.bodies.get(bodyId);
    if (!record) return null;
    const q = record.node.rotationQuaternion ?? Quaternion.Identity();
    return {
      position: {
        x: record.node.position.x,
        y: record.node.position.y,
        z: record.node.position.z,
      },
      rotation: { x: q.x, y: q.y, z: q.z, w: q.w },
    };
  }

  setBodyMotionType(bodyId: string, motionType: MotionType): void {
    const record = this.bodies.get(bodyId);
    if (!record) return;
    record.desc.motionType = motionType;
    const body = record.body;
    if (!body) return;
    this.applyMotionType(record);
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
          : this.createQueryShape(desc.shape);
        if (!sameGeometry) provisional.add(shape);
        topologyChanged ||=
          !previous || !sameGeometry || !sameColliderPose(previous.desc, desc);
        next.set(desc.id, { desc, shape });
      }
      // Container child indices are derived from this live order, never used as IDs.
      if (
        topologyChanged &&
        next.size &&
        !(
          next.size === 1 &&
          identityColliderPose(next.values().next().value!.desc)
        )
      ) {
        container = new PhysicsShapeContainer(this.scene);
        provisional.add(container);
        for (const child of next.values())
          container.addChild(
            child.shape,
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
        this.applyShapeTuning(child.shape, child.desc);
      if (topologyChanged) this.applyBodyTuning(record);
      body.setLinearVelocity(linear);
      body.setAngularVelocity(angular);
    } catch (error) {
      try {
        if (topologyChanged) attachHavokShape(this.plugin, body, oldAttachment);
        for (const child of record.colliders.values())
          this.applyShapeTuning(child.shape, child.desc);
        this.applyBodyTuning(record);
        body.setLinearVelocity(linear);
        body.setAngularVelocity(angular);
      } catch (rollbackError) {
        for (const shape of provisional) record.uncertainShapes.add(shape);
        record.mutationFailure = new AggregateError(
          [error, rollbackError],
          `Havok collider rollback failed for ${bodyId}`,
        );
        throw record.mutationFailure;
      }
      if (topologyChanged) this.retireTriggerPairs(record.desc.actorId);
      container?.dispose();
      for (const shape of provisional) if (shape !== container) shape.dispose();
      throw error;
    }
    const oldColliders = record.colliders,
      oldContainer = record.container;
    record.colliders = next;
    if (topologyChanged) record.container = container;
    for (const id of oldColliders.keys()) this.colliders.delete(id);
    for (const [id, collider] of next) this.colliders.set(id, collider);
    const changedContactPolicy = upsert.some((desc) => {
      const previous = oldColliders.get(desc.id)?.desc;
      return (
        previous &&
        (previous.isTrigger !== desc.isTrigger ||
          previous.layer !== desc.layer ||
          previous.mask !== desc.mask)
      );
    });
    if (topologyChanged || changedContactPolicy)
      this.retireTriggerPairs(record.desc.actorId);
    if (topologyChanged) {
      oldContainer?.dispose();
    }
    const liveShapes = new Set([...next.values()].map((child) => child.shape));
    for (const child of oldColliders.values())
      if (!liveShapes.has(child.shape)) child.shape.dispose();
  }

  private applyShapeTuning(shape: PhysicsShape, desc: ColliderDesc): void {
    shape.isTrigger = desc.isTrigger;
    shape.material = { friction: desc.friction, restitution: desc.restitution };
    shape.filterMembershipMask = desc.layer;
    shape.filterCollideMask = desc.mask;
  }

  updateCollider(colliderId: string, tuning: ColliderTuning): void {
    const record = this.colliders.get(colliderId);
    if (!record) return;
    const next = { ...record.desc };
    if (typeof tuning.isTrigger === "boolean") {
      next.isTrigger = tuning.isTrigger;
    }
    if (
      typeof tuning.friction === "number" &&
      Number.isFinite(tuning.friction)
    ) {
      next.friction = tuning.friction;
    }
    if (
      typeof tuning.restitution === "number" &&
      Number.isFinite(tuning.restitution)
    ) {
      next.restitution = tuning.restitution;
    }
    if (typeof tuning.layer === "number" && Number.isFinite(tuning.layer)) {
      next.layer = tuning.layer;
    }
    if (typeof tuning.mask === "number" && Number.isFinite(tuning.mask)) {
      next.mask = tuning.mask;
    }
    this.applyColliderChanges(next.bodyId, { upsert: [next], remove: [] });
  }

  listDebugColliders() {
    return listDebugCollidersFromRecords(this.colliders.values(), (bodyId) =>
      this.getBodyTransform(bodyId),
    );
  }

  pollContacts(): PhysicsContactEvent[] {
    const events = this.pendingContacts;
    this.pendingContacts = [];
    return events;
  }

  step(dt: number): void {
    this.flushMutations();
    if (dt <= 0) return;
    this.stepping = true;
    try {
      this.scene.getPhysicsEngine()?._step(dt);
    } finally {
      this.stepping = false;
      this.resetTriggerActors.clear();
    }
    this.flushMutations();
  }

  readTransforms(): ReadonlyMap<string, PhysicsTransform> {
    const out = new Map<string, PhysicsTransform>();
    for (const id of this.bodies.keys()) {
      const transform = this.getBodyTransform(id);
      if (transform) out.set(id, transform);
    }
    return out;
  }

  lineTrace(start: Vec3, end: Vec3, options?: LineTraceOptions): HitResult {
    this.flushMutations();
    const engine = this.scene.getPhysicsEngine();
    if (!engine) return miss();
    this.tmpFrom.copyFrom(toVector3(start));
    this.tmpTo.copyFrom(toVector3(end));
    const ignored = new Set(options?.ignoreActorIds);
    const memberships = new Map<PhysicsShape, number>();
    // Havok exposes one ignoreBody, but the graph accepts multiple actors.
    // Mask all their shapes for this synchronous query, then restore them.
    // Filtering before raycast also avoids consuming a bounded hit collector.
    try {
      if (ignored.size) {
        for (const record of this.bodies.values()) {
          if (!ignored.has(record.desc.actorId)) continue;
          for (const shape of [
            record.body.shape,
            ...[...record.colliders.values()].map((c) => c.shape),
          ]) {
            if (!shape || memberships.has(shape)) continue;
            memberships.set(shape, shape.filterMembershipMask);
            shape.filterMembershipMask = 0;
          }
        }
      }
      const hit = engine.raycast(this.tmpFrom, this.tmpTo);
      if (!hit.hasHit) return miss();
      return this.hitFromCast(
        hit.hasHit,
        hit.hitPointWorld,
        hit.hitNormalWorld,
        hit.hitDistance,
        hit.body,
      );
    } finally {
      for (const [shape, membership] of memberships) {
        shape.filterMembershipMask = membership;
      }
    }
  }

  sphereOverlap(center: Vec3, radius: number): OverlapResult {
    this.flushMutations();
    const actorIds: string[] = [];
    const bodyIds: string[] = [];
    const c = toVector3(center);
    const r2 = radius * radius;
    for (const record of this.bodies.values()) {
      const body = record.body;
      if (!record.colliders.size) continue;
      const bb = body.getBoundingBox();
      const min = bb.minimumWorld;
      const max = bb.maximumWorld;
      const x = Math.max(min.x, Math.min(c.x, max.x));
      const y = Math.max(min.y, Math.min(c.y, max.y));
      const z = Math.max(min.z, Math.min(c.z, max.z));
      const dx = c.x - x;
      const dy = c.y - y;
      const dz = c.z - z;
      if (dx * dx + dy * dy + dz * dz <= r2) {
        actorIds.push(record.desc.actorId);
        bodyIds.push(record.desc.id);
      }
    }
    return { actorIds, bodyIds };
  }

  shapeSweep(
    shape: ColliderDesc["shape"],
    start: PhysicsTransform,
    end: PhysicsTransform,
  ): HitResult {
    this.flushMutations();
    if (!isShape3D(shape)) return miss();
    const queryShape = this.createQueryShape(shape);
    try {
      const input = new ShapeCastResult();
      const hit = new ShapeCastResult();
      this.plugin.shapeCast(
        {
          shape: queryShape,
          rotation: toQuaternion(start.rotation),
          startPosition: toVector3(start.position),
          endPosition: toVector3(end.position),
          shouldHitTriggers: false,
        },
        input,
        hit,
      );
      if (!hit.hasHit) return miss();
      const dx = end.position.x - start.position.x;
      const dy = end.position.y - start.position.y;
      const dz = end.position.z - start.position.z;
      const path = Math.hypot(dx, dy, dz);
      return this.hitFromCast(
        true,
        hit.hitPoint,
        hit.hitNormal,
        path * hit.hitFraction,
        hit.body,
      );
    } finally {
      queryShape.dispose();
    }
  }

  createCharacterController(desc: CharacterControllerDesc): void {
    const record = this.bodies.get(desc.bodyId);
    if (!record) return;
    if (this.characters.has(desc.id)) this.destroyCharacterController(desc.id);
    const shape = new PhysicsShapeCapsule(
      new Vector3(0, 0.5, 0),
      new Vector3(0, -0.5, 0),
      0.4,
      this.scene,
    );
    try {
      const controller = new PhysicsCharacterController(
        record.node.position.clone(),
        { shape, capsuleHeight: 1.8, capsuleRadius: 0.4 },
        this.scene,
      );
      controller.keepDistance = desc.offset;
      this.characters.set(desc.id, { desc: { ...desc }, controller, shape });
    } catch (error) {
      shape.dispose();
      throw error;
    }
  }

  destroyCharacterController(id: string): void {
    const character = this.characters.get(id);
    if (!character) return;
    character.controller.dispose();
    character.shape.dispose();
    this.characters.delete(id);
  }

  moveCharacter(
    id: string,
    translation: Vec3,
    dt: number,
  ): PhysicsTransform | null {
    const character = this.characters.get(id);
    if (!character) return null;
    const invDt = dt > 1e-8 ? 1 / dt : 0;
    character.controller.setVelocity(
      new Vector3(
        translation.x * invDt,
        translation.y * invDt,
        translation.z * invDt,
      ),
    );
    const support = character.controller.checkSupport(dt, this.down);
    character.controller.integrate(dt, support, this.zeroGravity);
    const pos = character.controller.getPosition();
    const body = this.bodies.get(character.desc.bodyId);
    if (!body) return null;
    this.teleportBody(character.desc.bodyId, {
      position: { x: pos.x, y: pos.y, z: pos.z },
      rotation: this.getBodyTransform(character.desc.bodyId)?.rotation ?? {
        x: 0,
        y: 0,
        z: 0,
        w: 1,
      },
    });
    return this.getBodyTransform(character.desc.bodyId);
  }

  private enableCollisionCallbacks(body: PhysicsBody): void {
    body.setCollisionCallbackEnabled(true);
  }

  private bindCollisionObservables(): void {
    const plugin = this.plugin;
    const collision = plugin.onCollisionObservable.add((event) => {
      this.recordPluginContact(event, false);
    });
    const trigger = plugin.onTriggerCollisionObservable.add((event) => {
      this.recordPluginContact(event, true);
    });
    this.removeCollisionObservers.push(
      () => plugin.onCollisionObservable.remove(collision),
      () => plugin.onTriggerCollisionObservable.remove(trigger),
    );
  }

  private recordPluginContact(
    raw: unknown,
    fromTriggerObservable: boolean,
  ): void {
    const event = raw as {
      type?: string;
      collider?: PhysicsBody;
      collidedAgainst?: PhysicsBody;
      point?: { x: number; y: number; z: number } | null;
      normal?: { x: number; y: number; z: number } | null;
    };
    const actorAId = this.actorIdForPhysicsBody(event.collider);
    const actorBId = this.actorIdForPhysicsBody(event.collidedAgainst);
    if (!actorAId || !actorBId || actorAId === actorBId) return;
    const type = String(event.type ?? "");
    let kind: PhysicsContactEvent["kind"] | null = null;
    const isTriggerEvent =
      fromTriggerObservable ||
      type === PhysicsEventType.TRIGGER_ENTERED ||
      type === PhysicsEventType.TRIGGER_EXITED;
    if (isTriggerEvent) {
      kind =
        type === PhysicsEventType.TRIGGER_EXITED
          ? "overlapEnd"
          : "overlapBegin";
    } else if (
      type === PhysicsEventType.COLLISION_STARTED ||
      type === PhysicsEventType.COLLISION_CONTINUED ||
      type === ""
    ) {
      kind = "hit";
    }
    if (!kind) return;
    let a = actorAId;
    let b = actorBId;
    // Havok reports bodies rather than child shapes. On a trigger actor route
    // overlap events to its trigger component, even after a blocking collider.
    let colliderAId = this.firstColliderIdForActor(actorAId, isTriggerEvent);
    let colliderBId = this.firstColliderIdForActor(actorBId, isTriggerEvent);
    let normal = {
      x: event.normal?.x ?? 0,
      y: event.normal?.y ?? 1,
      z: event.normal?.z ?? 0,
    };
    if (a > b) {
      const swap = a;
      a = b;
      b = swap;
      const swapCollider = colliderAId;
      colliderAId = colliderBId;
      colliderBId = swapCollider;
      normal = { x: -normal.x, y: -normal.y, z: -normal.z };
    }
    if (kind === "overlapBegin" || kind === "overlapEnd") {
      // Havok reports each overlapping child-shape pair. Keep the actor overlap
      // alive until its final shape leaves, including events on later ticks.
      const pairKey = JSON.stringify([a, b]);
      const pair = this.activeTriggerPairs.get(pairKey);
      if (kind === "overlapBegin") {
        if (pair) {
          pair.contacts += 1;
          return;
        }
        this.activeTriggerPairs.set(pairKey, {
          actorAId: a,
          actorBId: b,
          contacts: 1,
        });
      } else {
        if (this.resetTriggerActors.has(a) || this.resetTriggerActors.has(b))
          return;
        if (!pair) return;
        pair.contacts -= 1;
        if (pair.contacts > 0) return;
        this.activeTriggerPairs.delete(pairKey);
      }
    }
    const key = `${kind}|${a}|${b}`;
    if (
      this.pendingContacts.some(
        (existing) =>
          `${existing.kind}|${existing.actorAId}|${existing.actorBId}` === key,
      )
    ) {
      return;
    }
    this.pendingContacts.push({
      kind,
      actorAId: a,
      actorBId: b,
      ...(colliderAId ? { colliderAId } : {}),
      ...(colliderBId ? { colliderBId } : {}),
      location: {
        x: event.point?.x ?? 0,
        y: event.point?.y ?? 0,
        z: event.point?.z ?? 0,
      },
      normal,
    });
  }

  private firstColliderIdForActor(
    actorId: string,
    preferTrigger = false,
  ): string | undefined {
    let first: string | undefined;
    for (const [id, collider] of this.colliders) {
      const body = this.bodies.get(collider.desc.bodyId);
      if (body?.desc.actorId !== actorId) continue;
      first ??= id;
      if (!preferTrigger || collider.desc.isTrigger) return id;
    }
    return first;
  }

  private actorIdForPhysicsBody(body: PhysicsBody | undefined): string | null {
    if (!body) return null;
    const bodyId = this.bodyIdByPhysicsBody.get(body);
    if (!bodyId) return null;
    return this.bodies.get(bodyId)?.desc.actorId ?? null;
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
    });
  }

  /** Shape construction owns helpers from their first allocation. Havok copies
   * mesh data synchronously; descriptors retain reconstruction inputs. */
  private createQueryShape(shape: ColliderShape): PhysicsShape {
    validateColliderShape(shape);
    const origin = Vector3.Zero();
    switch (shape.kind) {
      case "box":
        return new PhysicsShapeBox(
          origin,
          Quaternion.Identity(),
          toVector3({
            x: shape.halfExtents.x * 2,
            y: shape.halfExtents.y * 2,
            z: shape.halfExtents.z * 2,
          }),
          this.scene,
        );
      case "sphere":
        return new PhysicsShapeSphere(origin, shape.radius, this.scene);
      case "capsule":
        return new PhysicsShapeCapsule(
          new Vector3(0, -shape.halfHeight, 0),
          new Vector3(0, shape.halfHeight, 0),
          shape.radius,
          this.scene,
        );
      case "cylinder":
        return new PhysicsShapeCylinder(
          new Vector3(0, -shape.height / 2, 0),
          new Vector3(0, shape.height / 2, 0),
          shape.radius,
          this.scene,
        );
      case "convex":
      case "mesh": {
        const mesh = new Mesh(`physics-${shape.kind}`, this.scene);
        try {
          mesh.isVisible = false;
          const data = new VertexData();
          const points =
            shape.kind === "convex" ? shape.points : shape.vertices;
          data.positions = points.flatMap((p) => [p.x, p.y, p.z]);
          data.indices = shape.kind === "mesh" ? [...shape.indices] : [];
          data.applyToMesh(mesh);
          return shape.kind === "convex"
            ? new PhysicsShapeConvexHull(mesh, this.scene)
            : new PhysicsShapeMesh(mesh, this.scene);
        } finally {
          mesh.dispose();
        }
      }
      default:
        throw new Error("Unsupported 3D collider shape");
    }
  }

  private hitFromCast(
    hasHit: boolean,
    point: Vector3,
    normal: Vector3,
    distance: number,
    body: PhysicsBody | undefined,
  ): HitResult {
    if (!hasHit) return miss();
    const bodyId = body ? (this.bodyIdByPhysicsBody.get(body) ?? null) : null;
    const actorId = bodyId
      ? (this.bodies.get(bodyId)?.desc.actorId ?? null)
      : null;
    return {
      hit: true,
      location: { x: point.x, y: point.y, z: point.z },
      normal: { x: normal.x, y: normal.y, z: normal.z },
      distance,
      actorId,
      bodyId,
    };
  }

  private disposeBodyRecord(record: BodyRecord): void {
    this.bodyIdByPhysicsBody.delete(record.body);
    record.body.dispose();
    record.container?.dispose();
    // If rollback failed, both generations remain owned until the native user is gone.
    for (const shape of record.uncertainShapes)
      if (shape instanceof PhysicsShapeContainer) shape.dispose();
    for (const collider of record.colliders.values()) collider.shape.dispose();
    for (const shape of record.uncertainShapes) shape.dispose();
    record.uncertainShapes.clear();
    record.colliders.clear();
    record.node.dispose();
  }

  private assertHealthy(record: BodyRecord): void {
    if (record.mutationFailure) throw record.mutationFailure;
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
    for (const record of this.bodies.values()) this.assertHealthy(record);
  }

  private retireTriggerPairs(actorId: string): void {
    this.pendingContacts = this.pendingContacts.filter(
      (event) =>
        event.kind === "overlapEnd" ||
        (event.actorAId !== actorId && event.actorBId !== actorId),
    );
    for (const [key, pair] of this.activeTriggerPairs) {
      if (pair.actorAId !== actorId && pair.actorBId !== actorId) continue;
      this.activeTriggerPairs.delete(key);
      this.pendingContacts.push({
        kind: "overlapEnd",
        actorAId: pair.actorAId,
        actorBId: pair.actorBId,
        location: { x: 0, y: 0, z: 0 },
        normal: { x: 0, y: 1, z: 0 },
      });
    }
    this.resetTriggerActors.add(actorId);
  }

  private assertLive(): void {
    if (this.disposed) throw new Error("HavokPhysicsBackend is disposed");
  }
}
