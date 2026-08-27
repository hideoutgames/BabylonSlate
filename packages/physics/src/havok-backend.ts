import "@babylonjs/core/Physics/physicsEngineComponent";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { HavokPlugin } from "@babylonjs/core/Physics/v2/Plugins/havokPlugin";
import { PhysicsAggregate } from "@babylonjs/core/Physics/v2/physicsAggregate";
import { PhysicsBody } from "@babylonjs/core/Physics/v2/physicsBody";
import { PhysicsCharacterController } from "@babylonjs/core/Physics/v2/characterController";
import {
  PhysicsEventType,
  PhysicsMotionType,
  PhysicsPrestepType,
  PhysicsShapeType,
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
  ColliderShape,
  ColliderTuning,
  HitResult,
  MotionType,
  OverlapResult,
  PhysicsBackendOptions,
  PhysicsTransform,
  Quat,
  RigidBodyDesc,
  RigidBodyTuning,
  Vec3,
  PhysicsContactEvent,
} from "./types";
import { identityQuat } from "./collider-bake";
import { listDebugCollidersFromRecords } from "./debug-colliders";
import { loadHavokModule } from "./havok-loader";

type BodyRecord = {
  desc: RigidBodyDesc;
  node: TransformNode;
  aggregate: PhysicsAggregate | null;
  extraShapes: PhysicsShape[];
  helperMeshes: Mesh[];
};

type ColliderRecord = {
  desc: ColliderDesc;
  shape: PhysicsShape | null;
};

type CharacterRecord = {
  desc: CharacterControllerDesc;
  controller: PhysicsCharacterController;
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
 * 3D backend: Babylon Physics V2 (`HavokPlugin` + `PhysicsAggregate`) on a
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
  private pendingContacts: PhysicsContactEvent[] = [];

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
    this.disposed = true;
    for (const character of this.characters.values()) {
      character.controller.dispose();
    }
    this.characters.clear();
    for (const collider of this.colliders.values()) {
      // Shapes owned by aggregates are disposed with the aggregate.
      void collider;
    }
    this.colliders.clear();
    for (const record of this.bodies.values()) {
      this.disposeBodyRecord(record);
    }
    this.bodies.clear();
    this.bodyIdByPhysicsBody.clear();
    this.scene.disablePhysicsEngine();
    this.scene.dispose();
    this.engine.dispose();
  }

  setGravity(gravity: Vec3): void {
    this.scene.getPhysicsEngine()?.setGravity(toVector3(gravity));
  }

  createBody(desc: RigidBodyDesc): void {
    this.assertLive();
    const node = new TransformNode(desc.id, this.scene);
    node.position.copyFrom(toVector3(desc.transform.position));
    node.rotationQuaternion = toQuaternion(desc.transform.rotation);
    this.bodies.set(desc.id, {
      desc: { ...desc },
      node,
      aggregate: null,
      extraShapes: [],
      helperMeshes: [],
    });
  }

  destroyBody(bodyId: string): void {
    const record = this.bodies.get(bodyId);
    if (!record) return;
    for (const [id, collider] of [...this.colliders]) {
      if (collider.desc.bodyId === bodyId) this.colliders.delete(id);
    }
    for (const [id, character] of [...this.characters]) {
      if (character.desc.bodyId === bodyId) {
        character.controller.dispose();
        this.characters.delete(id);
      }
    }
    this.disposeBodyRecord(record);
    this.bodies.delete(bodyId);
  }

  setBodyTransform(bodyId: string, transform: PhysicsTransform): void {
    const record = this.bodies.get(bodyId);
    if (!record) return;
    record.desc.transform = {
      position: { ...transform.position },
      rotation: { ...transform.rotation },
    };
    record.node.position.copyFrom(toVector3(transform.position));
    record.node.rotationQuaternion = toQuaternion(transform.rotation);
    const body = record.aggregate?.body;
    if (!body) return;
    if (record.desc.motionType !== "dynamic") {
      body.setTargetTransform(
        record.node.position,
        record.node.rotationQuaternion,
      );
    }
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
    const body = record.aggregate?.body;
    if (!body) return;
    this.applyMotionType(record);
  }

  addImpulse(bodyId: string, impulse: Vec3, strength = 1): void {
    const record = this.bodies.get(bodyId);
    const body = record?.aggregate?.body;
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
    this.assertLive();
    if (!isShape3D(desc.shape)) return;
    const record = this.bodies.get(desc.bodyId);
    if (!record) return;
    const shape = this.createShape(desc, record);
    if (!shape) return;
    this.colliders.set(desc.id, { desc: { ...desc }, shape });
    if (!record.aggregate) {
      const mass =
        record.desc.motionType === "static" ? 0 : Math.max(record.desc.mass, 0);
      const aggregate = new PhysicsAggregate(
        record.node,
        shape,
        {
          mass,
          friction: desc.friction,
          restitution: desc.restitution,
          isTriggerShape: desc.isTrigger,
        },
        this.scene,
      );
      record.aggregate = aggregate;
      this.bodyIdByPhysicsBody.set(aggregate.body, record.desc.id);
      this.enableCollisionCallbacks(aggregate.body);
      this.applyMotionType(record);
      this.applyBodyTuning(record);
      return;
    }
    record.extraShapes.push(shape);
    const current = record.aggregate.body.shape;
    if (current && current.type !== PhysicsShapeType.CONTAINER) {
      const container = new PhysicsShapeContainer(this.scene);
      container.addChild(current);
      record.aggregate.body.shape = container;
    }
    record.aggregate.body.shape?.addChild(shape);
  }

  destroyCollider(colliderId: string): void {
    this.colliders.delete(colliderId);
  }

  updateCollider(colliderId: string, tuning: ColliderTuning): void {
    const record = this.colliders.get(colliderId);
    if (!record) return;
    if (typeof tuning.isTrigger === "boolean") {
      record.desc.isTrigger = tuning.isTrigger;
    }
    if (typeof tuning.friction === "number" && Number.isFinite(tuning.friction)) {
      record.desc.friction = tuning.friction;
    }
    if (
      typeof tuning.restitution === "number" &&
      Number.isFinite(tuning.restitution)
    ) {
      record.desc.restitution = tuning.restitution;
    }
    if (typeof tuning.layer === "number" && Number.isFinite(tuning.layer)) {
      record.desc.layer = tuning.layer;
    }
    if (typeof tuning.mask === "number" && Number.isFinite(tuning.mask)) {
      record.desc.mask = tuning.mask;
    }
    const shape = record.shape;
    if (!shape) return;
    shape.isTrigger = record.desc.isTrigger;
    shape.material = {
      friction: record.desc.friction,
      restitution: record.desc.restitution,
    };
    shape.filterMembershipMask = record.desc.layer;
    shape.filterCollideMask = record.desc.mask;
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
    this.assertLive();
    if (dt <= 0) return;
    this.scene.getPhysicsEngine()?._step(dt);
  }

  readTransforms(): ReadonlyMap<string, PhysicsTransform> {
    const out = new Map<string, PhysicsTransform>();
    for (const id of this.bodies.keys()) {
      const transform = this.getBodyTransform(id);
      if (transform) out.set(id, transform);
    }
    return out;
  }

  lineTrace(start: Vec3, end: Vec3): HitResult {
    const engine = this.scene.getPhysicsEngine();
    if (!engine) return miss();
    this.tmpFrom.copyFrom(toVector3(start));
    this.tmpTo.copyFrom(toVector3(end));
    const hit = engine.raycast(this.tmpFrom, this.tmpTo);
    if (!hit.hasHit) return miss();
    return this.hitFromCast(
      hit.hasHit,
      hit.hitPointWorld,
      hit.hitNormalWorld,
      hit.hitDistance,
      hit.body,
    );
  }

  sphereOverlap(center: Vec3, radius: number): OverlapResult {
    const actorIds: string[] = [];
    const bodyIds: string[] = [];
    const c = toVector3(center);
    const r2 = radius * radius;
    for (const record of this.bodies.values()) {
      const body = record.aggregate?.body;
      if (!body) continue;
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
    if (!isShape3D(shape)) return miss();
    const queryShape = this.createQueryShape(shape);
    if (!queryShape) return miss();
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
    queryShape.dispose();
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
  }

  createCharacterController(desc: CharacterControllerDesc): void {
    const record = this.bodies.get(desc.bodyId);
    if (!record) return;
    const controller = new PhysicsCharacterController(
      record.node.position.clone(),
      { capsuleHeight: 1.8, capsuleRadius: 0.4 },
      this.scene,
    );
    controller.keepDistance = desc.offset;
    this.characters.set(desc.id, { desc: { ...desc }, controller });
  }

  destroyCharacterController(id: string): void {
    const character = this.characters.get(id);
    if (!character) return;
    character.controller.dispose();
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
    this.setBodyTransform(character.desc.bodyId, {
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
    const plugin = this.plugin as HavokPlugin & {
      onCollisionObservable?: { add: (cb: (event: unknown) => void) => void };
      onTriggerCollisionObservable?: { add: (cb: (event: unknown) => void) => void };
    };
    plugin.onCollisionObservable?.add((event) => {
      this.recordPluginContact(event, false);
    });
    plugin.onTriggerCollisionObservable?.add((event) => {
      this.recordPluginContact(event, true);
    });
  }

  private recordPluginContact(raw: unknown, fromTriggerObservable: boolean): void {
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
      kind = type === PhysicsEventType.TRIGGER_EXITED ? "overlapEnd" : "overlapBegin";
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
    // Havok collision events name PhysicsBody pairs, not child shapes, so
    // collider ids fall back to the first collider on each actor.
    let colliderAId = this.firstColliderIdForActor(actorAId);
    let colliderBId = this.firstColliderIdForActor(actorBId);
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
    const key = `${kind}|${a}|${b}`;
    if (
      this.pendingContacts.some(
        (existing) => `${existing.kind}|${existing.actorAId}|${existing.actorBId}` === key,
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

  private firstColliderIdForActor(actorId: string): string | undefined {
    for (const [id, collider] of this.colliders) {
      const body = this.bodies.get(collider.desc.bodyId);
      if (body?.desc.actorId === actorId) return id;
    }
    return undefined;
  }

  private actorIdForPhysicsBody(body: PhysicsBody | undefined): string | null {
    if (!body) return null;
    const bodyId = this.bodyIdByPhysicsBody.get(body);
    if (!bodyId) return null;
    return this.bodies.get(bodyId)?.desc.actorId ?? null;
  }

  private applyMotionType(record: BodyRecord): void {
    const body = record.aggregate?.body;
    if (!body) return;
    const motion = motionTypeOf(record.desc.motionType);
    body.setMotionType(motion);
    if (motion === PhysicsMotionType.DYNAMIC) {
      body.disablePreStep = true;
      body.disableSync = false;
    } else {
      body.disablePreStep = false;
      body.setPrestepType(PhysicsPrestepType.TELEPORT);
      body.disableSync = true;
    }
  }

  private applyBodyTuning(record: BodyRecord): void {
    const body = record.aggregate?.body;
    if (!body) return;
    body.setLinearDamping(record.desc.linearDamping);
    body.setAngularDamping(record.desc.angularDamping);
    body.setGravityFactor(record.desc.gravityScale);
    if (record.desc.motionType === "dynamic") {
      body.setMassProperties({ mass: Math.max(record.desc.mass, 1e-6) });
    }
  }

  private createShape(
    desc: ColliderDesc,
    record: BodyRecord,
  ): PhysicsShape | null {
    const shape = this.createQueryShape(
      desc.shape,
      record,
      desc.translation,
      desc.rotation,
    );
    if (!shape) return null;
    shape.material = {
      friction: desc.friction,
      restitution: desc.restitution,
    };
    shape.isTrigger = desc.isTrigger;
    shape.filterMembershipMask = desc.layer;
    shape.filterCollideMask = desc.mask;
    return shape;
  }

  private createQueryShape(
    shape: ColliderShape,
    record?: BodyRecord,
    translation?: { x: number; y: number; z: number },
    rotation?: Quat,
  ): PhysicsShape | null {
    const origin = translation
      ? new Vector3(translation.x, translation.y, translation.z)
      : Vector3.Zero();
    const localRotation = toQuaternion(rotation ?? identityQuat());
    switch (shape.kind) {
      case "box":
        return new PhysicsShapeBox(
          origin,
          localRotation,
          new Vector3(
            shape.halfExtents.x * 2,
            shape.halfExtents.y * 2,
            shape.halfExtents.z * 2,
          ),
          this.scene,
        );
      case "sphere":
        return new PhysicsShapeSphere(origin, shape.radius, this.scene);
      case "capsule": {
        const start = new Vector3(0, -shape.halfHeight, 0).applyRotationQuaternion(
          localRotation,
        );
        const end = new Vector3(0, shape.halfHeight, 0).applyRotationQuaternion(
          localRotation,
        );
        return new PhysicsShapeCapsule(
          origin.add(start),
          origin.add(end),
          shape.radius,
          this.scene,
        );
      }
      case "cylinder": {
        const start = new Vector3(0, -shape.height / 2, 0).applyRotationQuaternion(
          localRotation,
        );
        const end = new Vector3(0, shape.height / 2, 0).applyRotationQuaternion(
          localRotation,
        );
        return new PhysicsShapeCylinder(
          origin.add(start),
          origin.add(end),
          shape.radius,
          this.scene,
        );
      }
      case "convex": {
        const mesh = this.meshFromPoints(
          "convex",
          shape.points,
          undefined,
          record,
        );
        return mesh ? new PhysicsShapeConvexHull(mesh, this.scene) : null;
      }
      case "mesh": {
        const mesh = this.meshFromPoints(
          "mesh",
          shape.vertices,
          shape.indices,
          record,
        );
        return mesh ? new PhysicsShapeMesh(mesh, this.scene) : null;
      }
      default:
        return null;
    }
  }

  private meshFromPoints(
    name: string,
    points: readonly Vec3[],
    indices: readonly number[] | undefined,
    record?: BodyRecord,
  ): Mesh | null {
    if (points.length < 3) return null;
    const mesh = new Mesh(name, this.scene);
    mesh.isVisible = false;
    const vertexData = new VertexData();
    const positions: number[] = [];
    for (const p of points) {
      positions.push(p.x, p.y, p.z);
    }
    vertexData.positions = positions;
    if (indices && indices.length >= 3) {
      vertexData.indices = Array.from(indices);
    } else {
      const fan: number[] = [];
      for (let i = 1; i + 1 < points.length; i++) {
        fan.push(0, i, i + 1);
      }
      vertexData.indices = fan;
    }
    vertexData.applyToMesh(mesh);
    record?.helperMeshes.push(mesh);
    return mesh;
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
    if (record.aggregate?.body) {
      this.bodyIdByPhysicsBody.delete(record.aggregate.body);
    }
    for (const extra of record.extraShapes) extra.dispose();
    record.extraShapes = [];
    record.aggregate?.dispose();
    record.aggregate = null;
    for (const mesh of record.helperMeshes) mesh.dispose();
    record.helperMeshes = [];
    record.node.dispose();
  }

  private assertLive(): void {
    if (this.disposed) throw new Error("HavokPhysicsBackend is disposed");
  }
}
