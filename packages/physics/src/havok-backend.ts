import "@babylonjs/core/Physics/physicsEngineComponent";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { HavokPlugin } from "@babylonjs/core/Physics/v2/Plugins/havokPlugin";
import { PhysicsBody } from "@babylonjs/core/Physics/v2/physicsBody";
import type { Physics6DoFConstraint } from "@babylonjs/core/Physics/v2/physicsConstraint";
import { CharacterSupportedState, PhysicsCharacterController } from "@babylonjs/core/Physics/v2/characterController";
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
import type { CastingResult } from "@babylonjs/core/Physics/castingResult";
import { ShapeCastResult } from "@babylonjs/core/Physics/shapeCastResult";
import { ProximityCastResult } from "@babylonjs/core/Physics/proximityCastResult";
import type { PhysicsBackend, SphereSweepQuery } from "./backend";
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
  linearSweepPoses,
  normalizedPhysicsPose,
  sameColliderGeometry,
  sameColliderPose,
  validateColliderShape,
} from "./collider-validation";
import { attachHavokShape, detachHavokCharacterBodyShape, setHavokBodyPoseBeforeStep, teleportHavokBody } from "./havok-native-adapter";
import { listDebugCollidersFromRecords } from "./debug-colliders";
import { loadHavokModule } from "./havok-loader";
import { rotateQuatVec } from "./collider-bake";
import { copyConstraintDesc } from "./constraint-validation";
import {
  CONTACT_SHAPE_TIE_TOLERANCE,
  colliderSignedDistance,
  inverseTransformPoint,
  localShapeBounds,
  type LocalBounds,
} from "./contact-shape";
import { assertHavokConstraintAttached, disposeHavokConstraint, makeHavokConstraint } from "./havok-constraints";

type BodyRecord = {
  /** Position in the backend's `bodies` map order, assigned at creation: results that list bodies sort by it. */
  order: number;
  desc: RigidBodyDesc;
  node: TransformNode;
  body: PhysicsBody;
  /** Whether the native body is asked for contact events (`RigidBodyDesc.reportContacts`, `setContactReporting`). */
  reporting: boolean;
  colliders: Map<string, ColliderRecord>;
  container: PhysicsShapeContainer | null;
  /** The compound includes shapes hosted for other actors; hits resolve per shape. */
  hostsShapes: boolean;
  /** Failed rollback keeps possibly attached resources alive until body teardown. */
  uncertainShapes: Set<PhysicsShape>;
  mutationFailure?: Error;
};

type ColliderRecord = {
  desc: ColliderDesc;
  shape: PhysicsShape;
  /** Convex and mesh bounds for contact attribution, computed on first use. */
  bounds?: LocalBounds | null;
  /**
   * Position in the backend's `colliders` map order: assigned each time a transaction re-inserts the collider, so the
   * lowest sequence among an owner's colliders is the one a `colliders` scan would reach first.
   */
  seq: number;
};

type CharacterRecord = {
  desc: CharacterControllerDesc;
  controller: PhysicsCharacterController;
  shape: PhysicsShape;
  grounded: boolean;
};

/** Character solves shorter than this integrate their displacement over the nominal step. */
/** Native shapes `shapeSweep` keeps for reuse; a script sweeping ever-changing sizes churns within this bound. */
const QUERY_SHAPE_LIMIT = 16;
const MIN_CHARACTER_SOLVE_DT = 1e-3;
const NOMINAL_CHARACTER_SOLVE_DT = 1 / 60;

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

/** Identifies a contact within one poll window: the first event of each kind per ordered actor pair wins. */
function contactKey(kind: PhysicsContactEvent["kind"], actorAId: string, actorBId: string): string {
  return `${kind}|${actorAId}|${actorBId}`;
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
  readonly supportsConstraints = true;
  readonly plugin: HavokPlugin;
  readonly scene: Scene;
  private readonly engine: NullEngine;
  private readonly bodies = new Map<string, BodyRecord>();
  /** Each actor's live bodies, so `setContactReporting` reaches them without scanning every body. */
  private readonly bodiesByActor = new Map<string, Set<BodyRecord>>();
  private bodySeq = 0;
  /** Contact reporting changes waiting for the body's open trigger overlaps to end (`requestReporting`). */
  private readonly pendingReporting = new Map<BodyRecord, boolean>();
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
  /** Shapes a running query filter masked and their memberships; empty between queries. */
  private readonly queryMemberships = new Map<PhysicsShape, number>();
  private readonly characters = new Map<string, CharacterRecord>();
  private readonly sphereSweeps = new Set<SphereSweepQuery>();
  /** Native shapes for primitive `shapeSweep` casts by kind and dimensions, least recently used first (`reusableQueryShape`). */
  private readonly queryShapes = new Map<string, PhysicsShape>();
  private readonly constraints = new Map<string, { desc: ConstraintDesc; constraint: Physics6DoFConstraint }>();
  private readonly bodyIdByPhysicsBody = new Map<PhysicsBody, string>();
  /** Result holders the synchronous queries share; the plugin resets them at the start of every query. */
  private readonly proximityInput = new ProximityCastResult();
  private readonly proximityHit = new ProximityCastResult();
  private readonly castInput = new ShapeCastResult();
  private readonly castHit = new ShapeCastResult();
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
  /** `contactKey` of each `pendingContacts` entry, index for index. */
  private pendingContactKeys: string[] = [];
  /** The distinct `pendingContactKeys`, so the first-event-wins check is one lookup instead of a scan. */
  private readonly pendingContactKeySet = new Set<string>();
  private colliderSeq = 0;
  /** The native bodies each pending hit came from; hits may name hosted actors. */
  private readonly hitBodies = new WeakMap<PhysicsContactEvent, readonly [PhysicsBody, PhysicsBody]>();
  private readonly tmpContactPoint = { x: 0, y: 0, z: 0 };
  private readonly activeTriggerPairs = new Map<
    string,
    {
      actorAId: string;
      actorBId: string;
      /** The begin event's colliders, so every end routes to the same components. */
      colliderAId?: string;
      colliderBId?: string;
      contacts: number;
      /** A teleport dropped the native pair; the next step must re-report it. */
      refreshing: boolean;
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
    for (const query of this.sphereSweeps) query.dispose();
    for (const shape of this.queryShapes.values()) shape.dispose();
    this.queryShapes.clear();
    for (const remove of this.removeCollisionObservers) remove();
    this.removeCollisionObservers.length = 0;
    for (const character of this.characters.values()) {
      character.controller.dispose();
      character.shape.dispose();
    }
    this.characters.clear();
    for (const record of this.constraints.values()) disposeHavokConstraint(this.plugin, record.constraint);
    this.constraints.clear();
    this.colliders.clear();
    for (const record of this.bodies.values()) {
      this.disposeBodyRecord(record);
    }
    this.bodies.clear();
    this.bodiesByActor.clear();
    this.pendingReporting.clear();
    this.collidersByOwner.clear();
    this.triggerColliders.clear();
    this.failedBodies.clear();
    this.bodyIdByPhysicsBody.clear();
    this.activeTriggerPairs.clear();
    this.clearPendingContacts();
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
    this.retireTriggerPairs(record);
    // The body's colliders are exactly the backend entries naming it (a collider id belongs to one body).
    for (const id of record.colliders.keys()) this.colliders.delete(id);
    for (const [id, character] of this.characters) {
      if (character.desc.bodyId === bodyId) {
        character.controller.dispose();
        character.shape.dispose();
        this.characters.delete(id);
      }
    }
    this.disposeBodyRecord(record);
    this.bodies.delete(bodyId);
    const owned = this.bodiesByActor.get(record.desc.actorId);
    if (owned?.delete(record) && !owned.size) this.bodiesByActor.delete(record.desc.actorId);
    this.pendingReporting.delete(record);
    this.failedBodies.delete(record);
  }

  setContactReporting(actorId: string, enabled: boolean): void {
    if (this.stepping) {
      this.pendingMutations.push(() => this.setContactReporting(actorId, enabled));
      return;
    }
    for (const record of this.bodiesByActor.get(actorId) ?? []) this.requestReporting(record, enabled);
  }

  /**
   * Changing a native body's event mask while it overlaps a trigger ends that overlap with an exit event the real
   * exit never follows, so a body in an open overlap keeps its mask and changes it once the overlap ends.
   * Hit events carry no state and follow the mask at once.
   */
  private requestReporting(record: BodyRecord, enabled: boolean): void {
    if (record.reporting === enabled) {
      this.pendingReporting.delete(record);
      return;
    }
    if (this.inOpenOverlap(record.desc.actorId)) {
      this.pendingReporting.set(record, enabled);
      return;
    }
    this.pendingReporting.delete(record);
    record.reporting = enabled;
    record.body.setCollisionCallbackEnabled(enabled);
  }

  private inOpenOverlap(actorId: string): boolean {
    for (const pair of this.activeTriggerPairs.values()) if (pair.actorAId === actorId || pair.actorBId === actorId) return true;
    return false;
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
      this.retireTriggerPairs(record);
      throw error;
    }
    record.desc.transform = pose;
    // World membership refresh drops native pairs without emitting exits.
    this.refreshTriggerPairs(record);
    for (const character of this.characters.values()) {
      if (character.desc.bodyId === bodyId) {
        character.controller.setPosition(toVector3(pose.position));
        character.grounded = false;
      }
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
        next.set(desc.id, { desc, shape, seq: 0 });
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
        throw this.failMutation(record, new AggregateError(
          [error, rollbackError],
          `Havok collider rollback failed for ${bodyId}`,
        ));
      }
      if (topologyChanged) this.retireTriggerPairs(record);
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
          previous.actorId !== desc.actorId)
      );
    });
    const sameColliderIds =
      next.size === oldColliders.size &&
      [...next.keys()].every((id) => oldColliders.has(id));
    // New poses or shapes under the same IDs (a hosted child moving on its
    // host) keep overlaps open as a teleport does; the next step re-confirms them.
    if (changedContactPolicy || (topologyChanged && !sameColliderIds))
      this.retireTriggerPairs(record);
    else if (topologyChanged) this.refreshTriggerPairs(record);
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

  listDebugColliders() {
    return listDebugCollidersFromRecords(this.colliders.values(), (bodyId) =>
      this.getBodyTransform(bodyId),
    );
  }

  pollContacts(): PhysicsContactEvent[] {
    const events = this.pendingContacts;
    this.clearPendingContacts();
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
    // Before queued callback mutations, whose teleports await the next step.
    this.endUnconfirmedTriggerPairs();
    if (this.pendingReporting.size)
      for (const [record, enabled] of [...this.pendingReporting]) this.requestReporting(record, enabled);
    this.flushMutations();
  }

  lineTrace(start: Vec3, end: Vec3, options?: LineTraceOptions): HitResult {
    this.flushMutations();
    const engine = this.scene.getPhysicsEngine();
    if (!engine) return miss();
    this.tmpFrom.copyFrom(toVector3(start));
    this.tmpTo.copyFrom(toVector3(end));
    return this.withQueryFilter(options, () => {
      // Triggers are hit unless excluded, as on every backend (Babylon's default skips them).
      const hit = engine.raycast(this.tmpFrom, this.tmpTo, { shouldHitTriggers: options?.includeTriggers !== false });
      if (!hit.hasHit) return miss();
      return this.hitFromCast(hit, hit.hitDistance);
    });
  }

  private withQueryFilter<T>(options: LineTraceOptions | undefined, query: () => T): T {
    const memberships = this.queryMemberships;
    // Havok exposes one ignoreBody, but the graph accepts multiple actors.
    // Mask all their shapes for this synchronous query, then restore them.
    // Filtering before raycast also avoids consuming a bounded hit collector.
    try {
      // Hits name each shape's owner, so ignoring an actor excludes only
      // its own shapes: a host's shapes, or the shapes hosted for a child.
      const ignored = options?.ignoreActorIds;
      if (ignored) {
        for (const actorId of ignored) {
          const owned = this.collidersByOwner.get(actorId);
          if (owned) for (const collider of owned) this.maskQueryShape(collider.shape);
        }
      }
      if (options?.includeTriggers === false) {
        for (const collider of this.triggerColliders) this.maskQueryShape(collider.shape);
      }
      return query();
    } finally {
      try {
        for (const [shape, membership] of memberships) {
          shape.filterMembershipMask = membership;
        }
      } finally {
        memberships.clear();
      }
    }
  }

  private maskQueryShape(shape: PhysicsShape): void {
    if (this.queryMemberships.has(shape)) return;
    this.queryMemberships.set(shape, shape.filterMembershipMask);
    shape.filterMembershipMask = 0;
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

  /**
   * Tests the collider shapes, not body bounds: a point proximity query within
   * `radius` finds the closest shape, whose owner's shapes on that body are then
   * excluded until no shape is left in range. Like traces, it names the shape's
   * owner, so a body lists itself and each actor it hosts once; ignored actors
   * and excluded triggers are masked shape by shape. Results keep body order.
   */
  sphereOverlap(center: Vec3, radius: number, options?: LineTraceOptions): OverlapResult {
    this.flushMutations();
    const found = new Map<BodyRecord, Set<string>>();
    if ([center.x, center.y, center.z, radius].every(Number.isFinite) && radius >= 0) {
      const query = {
        position: toVector3(center),
        maxDistance: radius,
        collisionFilter: {},
        shouldHitTriggers: options?.includeTriggers !== false,
      };
      const result = this.proximityHit;
      this.withQueryFilter(options, () => {
        const memberships = new Map<PhysicsShape, number>();
        try {
          for (;;) {
            this.plugin.pointProximity(query, result);
            const bodyId = result.hasHit && result.body ? this.bodyIdByPhysicsBody.get(result.body) : undefined;
            const record = bodyId ? this.bodies.get(bodyId) : undefined;
            if (!record) break;
            const owner = this.shapeOwner(record, result.shape);
            const owners = found.get(record) ?? new Set<string>();
            if (owners.has(owner)) break;
            owners.add(owner);
            found.set(record, owners);
            for (const collider of record.colliders.values()) {
              const shape = collider.shape;
              if ((collider.desc.actorId ?? record.desc.actorId) !== owner || memberships.has(shape)) continue;
              memberships.set(shape, shape.filterMembershipMask);
              shape.filterMembershipMask = 0;
            }
          }
        } finally {
          for (const [shape, membership] of memberships) shape.filterMembershipMask = membership;
        }
      });
    }
    const actorIds: string[] = [];
    const bodyIds: string[] = [];
    // Only the bodies the query found, in body order.
    const records = [...found.keys()].sort((a, b) => a.order - b.order);
    for (const record of records) {
      const owners = found.get(record)!;
      for (const collider of record.colliders.values()) {
        const owner = collider.desc.actorId ?? record.desc.actorId;
        if (!owners.delete(owner)) continue;
        actorIds.push(owner);
        bodyIds.push(record.desc.id);
      }
    }
    return { actorIds, bodyIds };
  }

  shapeSweep(
    shape: ColliderDesc["shape"],
    start: PhysicsTransform,
    end: PhysicsTransform,
    options?: LineTraceOptions,
  ): HitResult {
    this.flushMutations();
    const sweep = linearSweepPoses(start, end);
    if (!sweep || !isShape3D(shape)) return miss();
    const reused = this.reusableQueryShape(shape);
    const queryShape = reused ?? this.createQueryShape(shape);
    try {
      const rotation = toQuaternion(sweep.start.rotation);
      const from = toVector3(sweep.start.position);
      const to = toVector3(sweep.end);
      const shouldHitTriggers = options?.includeTriggers !== false;
      return this.withQueryFilter(options, () => {
        // A cast alone misses shapes the swept shape already penetrates at its start.
        const proximityInput = this.proximityInput;
        const proximity = this.proximityHit;
        this.plugin.shapeProximity(
          { shape: queryShape, position: from, rotation, maxDistance: 0, shouldHitTriggers },
          proximityInput,
          proximity,
        );
        if (proximity.hasHit && proximity.hitDistance < -1e-6)
          return this.hitFromCast(proximity, 0);
        const input = this.castInput;
        const hit = this.castHit;
        this.plugin.shapeCast(
          { shape: queryShape, rotation, startPosition: from, endPosition: to, shouldHitTriggers },
          input,
          hit,
        );
        if (!hit.hasHit) return miss();
        return this.hitFromCast(hit, Vector3.Distance(from, to) * hit.hitFraction);
      });
    } finally {
      if (!reused) queryShape.dispose();
    }
  }

  /**
   * The cached native shape for a primitive query shape of these dimensions, created on first use; null for hulls
   * and meshes, whose callers own a fresh shape. A cast only reads the native shape, so repeated sweeps share it.
   * These shapes belong to no collider, so the query filter's masking never reaches them. The set is bounded:
   * the least recently used shape is released when a new size arrives, and `dispose` releases the rest.
   */
  private reusableQueryShape(shape: ColliderShape): PhysicsShape | null {
    let key: string;
    switch (shape.kind) {
      case "box":
        key = `box:${shape.halfExtents.x}:${shape.halfExtents.y}:${shape.halfExtents.z}`;
        break;
      case "sphere":
        key = `sphere:${shape.radius}`;
        break;
      case "capsule":
        key = `capsule:${shape.radius}:${shape.halfHeight}`;
        break;
      case "cylinder":
        key = `cylinder:${shape.radius}:${shape.height}`;
        break;
      default:
        return null;
    }
    // After disposal nothing is kept: the caller builds and releases its own, as for any other shape.
    if (this.disposed) return null;
    validateColliderShape(shape);
    const cached = this.queryShapes.get(key);
    if (cached) {
      // Reinserted last: iteration order is recency.
      this.queryShapes.delete(key);
      this.queryShapes.set(key, cached);
      return cached;
    }
    const created = this.createQueryShape(shape);
    if (this.queryShapes.size >= QUERY_SHAPE_LIMIT) {
      const [oldest, evicted] = this.queryShapes.entries().next().value!;
      this.queryShapes.delete(oldest);
      evicted.dispose();
    }
    this.queryShapes.set(key, created);
    return created;
  }

  createSphereSweep(radius: number): SphereSweepQuery {
    this.flushMutations();
    if (this.disposed) throw new Error("Cannot create a sphere sweep on a disposed physics backend");
    if (!Number.isFinite(radius) || radius <= 0) throw new Error("Sphere sweep radius must be finite and positive");
    const shape = new PhysicsShapeSphere(Vector3.Zero(), radius, this.scene);
    const start = new Vector3();
    const end = new Vector3();
    const rotation = Quaternion.Identity();
    const cast = { shape, rotation, startPosition: start, endPosition: end, shouldHitTriggers: false };
    const proximity = { shape, rotation, position: start, maxDistance: 0, shouldHitTriggers: false };
    const input = new ShapeCastResult();
    const hit = new ShapeCastResult();
    const proximityInput = new ProximityCastResult();
    const proximityHit = new ProximityCastResult();
    const result = miss();
    const location = { x: 0, y: 0, z: 0 };
    const normal = { x: 0, y: 0, z: 0 };
    let disposed = false;
    const clear = (): HitResult => {
      result.hit = false;
      result.location = null;
      result.normal = null;
      result.distance = 0;
      result.actorId = null;
      result.bodyId = null;
      return result;
    };
    const copyHit = (native: ShapeCastResult | ProximityCastResult, distance: number): HitResult => {
      location.x = native.hitPoint.x; location.y = native.hitPoint.y; location.z = native.hitPoint.z;
      normal.x = native.hitNormal.x; normal.y = native.hitNormal.y; normal.z = native.hitNormal.z;
      result.hit = true;
      result.location = location;
      result.normal = normal;
      result.distance = distance;
      const owner = this.castHitOwner(native);
      result.bodyId = owner.bodyId;
      result.actorId = owner.actorId;
      return result;
    };
    const query: SphereSweepQuery = {
      sweep: (sx, sy, sz, ex, ey, ez) => {
        if (disposed || this.disposed) return clear();
        this.flushMutations();
        if (disposed || this.disposed || !Number.isFinite(sx) || !Number.isFinite(sy) || !Number.isFinite(sz) ||
          !Number.isFinite(ex) || !Number.isFinite(ey) || !Number.isFinite(ez)) return clear();
        start.set(sx, sy, sz);
        end.set(ex, ey, ez);
        // Casts alone can miss shapes already penetrating at the start, including
        // a stationary particle overlapped by a moving collider.
        this.plugin.shapeProximity(proximity, proximityInput, proximityHit);
        if (proximityHit.hasHit && proximityHit.hitDistance < -1e-6) return copyHit(proximityHit, 0);
        this.plugin.shapeCast(cast, input, hit);
        if (!hit.hasHit) return clear();
        return copyHit(hit, Math.hypot(ex - sx, ey - sy, ez - sz) * hit.hitFraction);
      },
      dispose: () => {
        if (disposed) return;
        disposed = true;
        shape.dispose();
        this.sphereSweeps.delete(query);
        clear();
      },
    };
    this.sphereSweeps.add(query);
    return query;
  }

  createCharacterController(desc: CharacterControllerDesc): void {
    const record = this.bodies.get(desc.bodyId);
    if (!record) return;
    if (this.characters.has(desc.id)) this.destroyCharacterController(desc.id);
    const radius = desc.radius ?? 0.4;
    const height = Math.max(desc.height ?? 1.8, radius * 2);
    const halfSegment = height / 2 - radius;
    const shape = new PhysicsShapeCapsule(
      new Vector3(0, halfSegment, 0),
      new Vector3(0, -halfSegment, 0),
      radius,
      this.scene,
    );
    let controller: PhysicsCharacterController | undefined;
    try {
      controller = new PhysicsCharacterController(
        record.node.position.clone(),
        { shape, capsuleHeight: height, capsuleRadius: radius },
        this.scene,
      );
      controller.keepDistance = desc.offset;
      // A broad proximity tolerance makes checkSupport project gravity away
      // before the capsule reaches the floor. Ground snapping is a separate cast.
      controller.keepContactTolerance = Math.min(desc.offset, 0.001);
      controller.maxSlopeCosine = Math.cos((desc.maxSlopeAngle ?? 50) * Math.PI / 180);
      // The actor's native body already supplies physical contacts and actor IDs.
      detachHavokCharacterBodyShape(this.plugin, controller);
      this.characters.set(desc.id, { desc: { ...desc }, controller, shape, grounded: false });
    } catch (error) {
      controller?.dispose();
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
    startPose?: PhysicsTransform,
  ): CharacterMovementResult | null {
    this.flushMutations();
    const character = this.characters.get(id);
    if (!character) return null;
    const body = this.bodies.get(character.desc.bodyId);
    if (!body || !Number.isFinite(dt) || dt < 0) return null;
    const start = startPose ? normalizedPhysicsPose(startPose) : undefined;
    if (start) {
      const position = toVector3(start.position);
      if (!body.node.position.equals(position)) {
        // Inherited repositioning is not velocity: large parent changes must
        // not be clipped by Havok's world speed limit. Keep contact membership;
        // only the motor's displacement becomes a native kinematic target.
        const previousPosition = body.node.position.clone();
        body.node.position.copyFrom(position);
        try {
          setHavokBodyPoseBeforeStep(this.plugin, body.body);
        } catch (error) {
          body.node.position.copyFrom(previousPosition);
          try {
            setHavokBodyPoseBeforeStep(this.plugin, body.body);
          } catch (rollbackError) {
            throw this.failMutation(body, new AggregateError(
              [error, rollbackError],
              `Havok Movement pose rollback failed for ${character.desc.bodyId}`,
            ));
          }
          throw error;
        }
      }
      character.controller.setPosition(position);
    }
    // A displacement requested outside a tick (dt = 0, discrete graph events)
    // still moves: the controller integrates it over a nominal step, and the
    // reported velocity is the displacement over the real dt (zero for dt = 0).
    const solveDt = dt >= MIN_CHARACTER_SOLVE_DT ? dt : NOMINAL_CHARACTER_SOLVE_DT;
    character.controller.setVelocity(
      new Vector3(
        translation.x / solveDt,
        translation.y / solveDt,
        translation.z / solveDt,
      ),
    );
    // The controller's casts use its capsule's filter: the actor's own solid
    // collider's layer and mask, as the other backends' solves do.
    const self = [...body.colliders.values()].find((c) => !c.desc.isTrigger &&
      (c.desc.actorId ?? body.desc.actorId) === body.desc.actorId);
    character.shape.filterMembershipMask = self?.desc.layer ?? 0xffffffff;
    character.shape.filterCollideMask = self?.desc.mask ?? 0xffffffff;
    const memberships = new Map<PhysicsShape, number>();
    let grounded: boolean;
    try {
      // CCT casts exclude their private body, not the actor's physical body.
      // Filter the owner's complete compound before collecting any contacts.
      for (const shape of [body.body.shape, ...[...body.colliders.values()].map((c) => c.shape)]) {
        if (!shape || memberships.has(shape)) continue;
        memberships.set(shape, shape.filterMembershipMask);
        shape.filterMembershipMask = 0;
      }
      const support = character.controller.checkSupport(solveDt, this.down);
      character.controller.integrate(solveDt, support, this.zeroGravity);
      grounded = translation.y <= 0 && character.controller.checkSupport(solveDt, this.down).supportedState === CharacterSupportedState.SUPPORTED;
      const snap = character.desc.groundSnapDistance ?? 0.1;
      if (character.grounded && translation.y <= 0 && snap > 0) {
        const position = character.controller.getPosition();
        const hit = this.castHit;
        this.plugin.shapeCast({
          shape: character.shape, rotation: Quaternion.Identity(),
          startPosition: position,
          endPosition: position.add(new Vector3(0, -snap - character.desc.offset, 0)),
          shouldHitTriggers: false,
        }, this.castInput, hit);
        if (hit.hasHit && hit.hitNormal.y >= character.controller.maxSlopeCosine) {
          const drop = Math.max(0, hit.hitFraction * (snap + character.desc.offset) - character.desc.offset);
          if (drop <= snap) {
            character.controller.setPosition(position.add(new Vector3(0, -drop, 0)));
            grounded = true;
          }
        }
      }
    } finally {
      for (const [shape, membership] of memberships) shape.filterMembershipMask = membership;
    }
    const pos = character.controller.getPosition();
    const velocity = dt > 0
      ? character.controller.getVelocity().scale(solveDt / dt)
      : { x: 0, y: 0, z: 0 };
    // The solve keeps the start rotation; without one, the body's current rotation.
    const pose = {
      position: { x: pos.x, y: pos.y, z: pos.z },
      rotation: start?.rotation ?? this.getBodyTransform(character.desc.bodyId)!.rotation,
    };
    // Kinematic movement uses a native target, which keeps contact membership
    // without the world-membership refresh an explicit teleport performs. It
    // replaces any target set earlier in the frame.
    if (body.desc.motionType === "kinematic") this.setBodyTargetTransform(character.desc.bodyId, pose);
    else this.teleportBody(character.desc.bodyId, pose);
    // After the teleport, which resets the controller's support state.
    character.grounded = grounded;
    return {
      ...pose,
      velocity: { x: velocity.x, y: velocity.y, z: velocity.z },
      grounded,
    };
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
      /** Separation from `point` (on the collider) to the other body's contact, along `normal`. */
      distance?: number;
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
      // A hosted actor's trigger body would overlap its own shapes on the
      // host, and per-body events cannot tell those from the host's shapes.
      if (
        this.hostsShapesOf(event.collidedAgainst, actorAId) ||
        this.hostsShapesOf(event.collider, actorBId)
      )
        return;
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
    let colliderAId: string | undefined;
    let colliderBId: string | undefined;
    if (kind === "hit" && event.point) {
      // Havok reports bodies rather than child shapes. On a compound hosting
      // other actors' shapes, each side's contact point picks the shape it touched.
      const { point, normal } = event;
      const separation = event.distance ?? 0;
      const touchedA = this.touchedCollider(event.collider, point.x, point.y, point.z);
      const touchedB = this.touchedCollider(
        event.collidedAgainst,
        point.x + (normal?.x ?? 0) * separation,
        point.y + (normal?.y ?? 0) * separation,
        point.z + (normal?.z ?? 0) * separation,
      );
      if (touchedA) {
        a = touchedA.actorId ?? actorAId;
        colliderAId = touchedA.id;
      }
      if (touchedB) {
        b = touchedB.actorId ?? actorBId;
        colliderBId = touchedB.id;
      }
      if (a === b) return;
    }
    // Other bodies name their actor's first collider. On a trigger actor route
    // overlap events to its trigger component, even after a blocking collider.
    const swapped = a > b;
    // A hit is not paired, so a repeat of one already pending ends here, before the collider lookups.
    let key: string | undefined;
    if (kind === "hit") {
      key = swapped ? contactKey(kind, b, a) : contactKey(kind, a, b);
      if (this.pendingContactKeySet.has(key)) return;
    }
    colliderAId ??= this.firstColliderIdForActor(a, isTriggerEvent);
    colliderBId ??= this.firstColliderIdForActor(b, isTriggerEvent);
    if (swapped) {
      const swap = a;
      a = b;
      b = swap;
      const swapCollider = colliderAId;
      colliderAId = colliderBId;
      colliderBId = swapCollider;
    }
    if (kind === "overlapBegin" || kind === "overlapEnd") {
      // Havok reports each overlapping child-shape pair. Keep the actor overlap
      // alive until its final shape leaves, including events on later ticks.
      // Length-prefixed, so no pair of IDs can produce another pair's key.
      const pairKey = `${a.length}:${a}${b}`;
      const pair = this.activeTriggerPairs.get(pairKey);
      if (kind === "overlapBegin") {
        if (pair) {
          // Includes a teleported pair re-entering: its overlap never ended.
          pair.contacts += 1;
          pair.refreshing = false;
          return;
        }
        this.activeTriggerPairs.set(pairKey, {
          actorAId: a,
          actorBId: b,
          ...(colliderAId ? { colliderAId } : {}),
          ...(colliderBId ? { colliderBId } : {}),
          contacts: 1,
          refreshing: false,
        });
      } else {
        if (this.resetTriggerActors.has(a) || this.resetTriggerActors.has(b))
          return;
        if (!pair) return;
        pair.contacts -= 1;
        if (pair.contacts > 0) return;
        this.activeTriggerPairs.delete(pairKey);
        // End on the colliders the begin event named.
        colliderAId = pair.colliderAId;
        colliderBId = pair.colliderBId;
      }
    }
    key ??= contactKey(kind, a, b);
    if (this.pendingContactKeySet.has(key)) return;
    const pair = {
      actorAId: a,
      actorBId: b,
      ...(colliderAId ? { colliderAId } : {}),
      ...(colliderBId ? { colliderBId } : {}),
    };
    if (kind !== "hit") {
      this.enqueueContact({ kind, ...pair }, key);
      return;
    }
    const sign = swapped ? -1 : 1;
    const hit: PhysicsContactEvent = {
      kind,
      ...pair,
      location: {
        x: event.point?.x ?? 0,
        y: event.point?.y ?? 0,
        z: event.point?.z ?? 0,
      },
      normal: {
        x: sign * (event.normal?.x ?? 0),
        y: sign * (event.normal?.y ?? 1),
        z: sign * (event.normal?.z ?? 0),
      },
    };
    this.enqueueContact(hit, key);
    if (event.collider && event.collidedAgainst) this.hitBodies.set(hit, [event.collider, event.collidedAgainst]);
  }

  /** Ends an actor overlap with the colliders its begin event named. */
  private pushOverlapEnd(pair: { actorAId: string; actorBId: string; colliderAId?: string; colliderBId?: string }): void {
    // Not deduplicated against pending events, but later events dedup against it.
    this.enqueueContact(
      {
        kind: "overlapEnd",
        actorAId: pair.actorAId,
        actorBId: pair.actorBId,
        ...(pair.colliderAId ? { colliderAId: pair.colliderAId } : {}),
        ...(pair.colliderBId ? { colliderBId: pair.colliderBId } : {}),
      },
      contactKey("overlapEnd", pair.actorAId, pair.actorBId),
    );
  }

  private enqueueContact(event: PhysicsContactEvent, key: string): void {
    this.pendingContacts.push(event);
    this.pendingContactKeys.push(key);
    this.pendingContactKeySet.add(key);
  }

  private clearPendingContacts(): void {
    this.pendingContacts = [];
    this.pendingContactKeys = [];
    this.pendingContactKeySet.clear();
  }

  /** Keeps the pending events `keep` accepts, in order, with the dedup keys of exactly those events. */
  private retainPendingContacts(keep: (event: PhysicsContactEvent) => boolean): void {
    const events: PhysicsContactEvent[] = [];
    const keys: string[] = [];
    this.pendingContactKeySet.clear();
    for (let i = 0; i < this.pendingContacts.length; i++) {
      const event = this.pendingContacts[i]!;
      if (!keep(event)) continue;
      const key = this.pendingContactKeys[i]!;
      events.push(event);
      keys.push(key);
      this.pendingContactKeySet.add(key);
    }
    this.pendingContacts = events;
    this.pendingContactKeys = keys;
  }

  /**
   * The solid collider of a compound hosting other actors' shapes that a
   * contact at world point (x, y, z) touched: the nearest or most deeply
   * containing shape, with ties within `CONTACT_SHAPE_TIE_TOLERANCE` going to
   * the lowest collider ID. Undefined for bodies without hosted shapes, which
   * keep the per-body attribution.
   */
  private touchedCollider(body: PhysicsBody | undefined, x: number, y: number, z: number): ColliderDesc | undefined {
    const bodyId = body ? this.bodyIdByPhysicsBody.get(body) : undefined;
    const record = bodyId ? this.bodies.get(bodyId) : undefined;
    if (!record?.hostsShapes) return undefined;
    // Hosts are never static, so the node holds the post-step pose synced before callbacks.
    const local = inverseTransformPoint(this.tmpContactPoint, x, y, z, record.node.position, record.node.rotationQuaternion);
    let nearest = Infinity;
    for (const collider of record.colliders.values())
      if (!collider.desc.isTrigger) nearest = Math.min(nearest, this.contactDistance(collider, local.x, local.y, local.z));
    if (nearest === Infinity) return undefined;
    let touched: ColliderDesc | undefined;
    for (const collider of record.colliders.values()) {
      if (collider.desc.isTrigger || (touched && collider.desc.id > touched.id)) continue;
      if (this.contactDistance(collider, local.x, local.y, local.z) <= nearest + CONTACT_SHAPE_TIE_TOLERANCE)
        touched = collider.desc;
    }
    return touched;
  }

  private contactDistance(collider: ColliderRecord, x: number, y: number, z: number): number {
    if (collider.bounds === undefined && (collider.desc.shape.kind === "convex" || collider.desc.shape.kind === "mesh"))
      collider.bounds = localShapeBounds(collider.desc.shape);
    return colliderSignedDistance(collider.desc, collider.bounds ?? null, x, y, z);
  }

  private firstColliderIdForActor(
    actorId: string,
    preferTrigger = false,
  ): string | undefined {
    // The owner's colliders in `colliders` map order, which `seq` mirrors: the first one, or with `preferTrigger`
    // the first trigger when it owns any.
    const owned = this.collidersByOwner.get(actorId);
    if (!owned) return undefined;
    let first: ColliderRecord | undefined;
    let firstTrigger: ColliderRecord | undefined;
    for (const collider of owned) {
      if (!first || collider.seq < first.seq) first = collider;
      if (preferTrigger && collider.desc.isTrigger && (!firstTrigger || collider.seq < firstTrigger.seq))
        firstTrigger = collider;
    }
    return (firstTrigger ?? first)?.desc.id;
  }

  /** Whether `body`'s compound includes a child shape hosted for `actorId`. */
  private hostsShapesOf(body: PhysicsBody | undefined, actorId: string): boolean {
    const bodyId = body ? this.bodyIdByPhysicsBody.get(body) : undefined;
    const record = bodyId ? this.bodies.get(bodyId) : undefined;
    if (!record) return false;
    for (const collider of record.colliders.values())
      if (collider.desc.actorId === actorId) return true;
    return false;
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
          // Packed mesh geometry passes through; Havok copies it into native memory.
          data.positions =
            shape.kind === "convex"
              ? shape.points.flatMap((p) => [p.x, p.y, p.z])
              : shape.positions;
          data.indices = shape.kind === "mesh" ? shape.indices : [];
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

  private hitFromCast(native: CastingResult, distance: number): HitResult {
    if (!native.hasHit) return miss();
    const { bodyId, actorId } = this.castHitOwner(native);
    return {
      hit: true,
      location: { x: native.hitPoint.x, y: native.hitPoint.y, z: native.hitPoint.z },
      normal: { x: native.hitNormal.x, y: native.hitNormal.y, z: native.hitNormal.z },
      distance,
      actorId,
      bodyId,
    };
  }

  /**
   * Query hits name the leaf shape inside a compound, so a shape hosted for
   * another actor names that actor, as on software and Rapier.
   */
  private castHitOwner(native: CastingResult): { bodyId: string | null; actorId: string | null } {
    const bodyId = native.body ? (this.bodyIdByPhysicsBody.get(native.body) ?? null) : null;
    const record = bodyId ? this.bodies.get(bodyId) : undefined;
    if (!bodyId || !record) return { bodyId, actorId: null };
    return { bodyId, actorId: this.shapeOwner(record, native.shape) };
  }

  private shapeOwner(record: BodyRecord, shape: PhysicsShape | undefined): string {
    if (shape)
      for (const collider of record.colliders.values())
        if (collider.shape === shape) return collider.desc.actorId ?? record.desc.actorId;
    // Havok reports no child shape for a body with a single collider.
    const only = record.colliders.size === 1 ? record.colliders.values().next().value : undefined;
    return only?.desc.actorId ?? record.desc.actorId;
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

  /**
   * A successful teleport refreshes native world membership, which drops the
   * actor's native pairs without exit callbacks. Its actor-pair overlaps stay
   * open until the next native step: a pair still overlapping re-enters there
   * without a repeated Begin Overlap, and any other pair ends after that step.
   */
  private refreshTriggerPairs(record: BodyRecord): void {
    const actorId = record.desc.actorId;
    this.retainPendingContacts(
      (event) => event.kind !== "hit" || !this.pendingHitInvolves(event, record),
    );
    for (const pair of this.activeTriggerPairs.values()) {
      if (pair.actorAId !== actorId && pair.actorBId !== actorId) continue;
      pair.contacts = 0;
      pair.refreshing = true;
    }
    this.resetTriggerActors.add(actorId);
  }

  /** Whether a pending hit came from `record`'s body, including hits naming actors it hosts. */
  private pendingHitInvolves(event: PhysicsContactEvent, record: BodyRecord): boolean {
    const bodies = this.hitBodies.get(event);
    if (bodies) return bodies[0] === record.body || bodies[1] === record.body;
    return event.actorAId === record.desc.actorId || event.actorBId === record.desc.actorId;
  }

  private endUnconfirmedTriggerPairs(): void {
    for (const [key, pair] of this.activeTriggerPairs) {
      if (!pair.refreshing) continue;
      this.activeTriggerPairs.delete(key);
      this.pushOverlapEnd(pair);
    }
  }

  private retireTriggerPairs(record: BodyRecord): void {
    const actorId = record.desc.actorId;
    this.retainPendingContacts(
      (event) =>
        event.kind === "overlapEnd" ||
        (event.kind === "hit"
          ? !this.pendingHitInvolves(event, record)
          : event.actorAId !== actorId && event.actorBId !== actorId),
    );
    for (const [key, pair] of this.activeTriggerPairs) {
      if (pair.actorAId !== actorId && pair.actorBId !== actorId) continue;
      this.activeTriggerPairs.delete(key);
      this.pushOverlapEnd(pair);
    }
    this.resetTriggerActors.add(actorId);
  }

  private assertLive(): void {
    if (this.disposed) throw new Error("HavokPhysicsBackend is disposed");
  }
}
