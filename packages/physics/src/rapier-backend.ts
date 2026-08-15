import type { PhysicsBackend } from "./backend";
import type {
  CharacterControllerDesc,
  ColliderDesc,
  HitResult,
  OverlapResult,
  PhysicsBackendOptions,
  PhysicsTransform,
  RigidBodyDesc,
  Vec3,
} from "./types";

type RapierApi = {
  init(): Promise<void>;
  World: new (gravity: { x: number; y: number }) => {
    gravity: { x: number; y: number };
    timestep: number;
    step(): void;
    free(): void;
    createRigidBody(desc: unknown): RapierRigidBody;
    removeRigidBody(body: RapierRigidBody): void;
    createCollider(desc: unknown, body: RapierRigidBody): RapierCollider;
    removeCollider(collider: RapierCollider, wakeUp: boolean): void;
    createCharacterController(offset: number): RapierCharacterController;
    removeCharacterController(controller: RapierCharacterController): void;
    castRay(
      ray: unknown,
      maxToi: number,
      solid: boolean,
    ): { timeOfImpact: number; collider: RapierCollider } | null;
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
  setLinearDamping(v: number): RapierBodyDesc;
  setAngularDamping(v: number): RapierBodyDesc;
  setGravityScale(v: number): RapierBodyDesc;
  setAdditionalMass(v: number): RapierBodyDesc;
};

type RapierColliderDesc = {
  setFriction(v: number): RapierColliderDesc;
  setRestitution(v: number): RapierColliderDesc;
  setSensor(v: boolean): RapierColliderDesc;
};

type RapierRigidBody = {
  handle: number;
  translation(): { x: number; y: number };
  setTranslation(t: { x: number; y: number }, wakeUp: boolean): void;
  setBodyType(type: number, wakeUp: boolean): void;
  applyImpulse(impulse: { x: number; y: number }, wakeUp: boolean): void;
  setNextKinematicTranslation(t: { x: number; y: number }): void;
};

type RapierCollider = {
  parent(): RapierRigidBody | null;
};

type RapierCharacterController = {
  computeColliderMovement(
    collider: RapierCollider,
    desired: { x: number; y: number },
  ): void;
  computedMovement(): { x: number; y: number };
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
  private readonly RAPIER: RapierApi;
  private readonly world: InstanceType<RapierApi["World"]>;
  private readonly bodies = new Map<string, BodyRecord>();
  private readonly colliders = new Map<string, ColliderRecord>();
  private readonly characters = new Map<string, CharacterRecord>();
  private readonly bodyIdByHandle = new Map<number, string>();
  private disposed = false;

  private constructor(RAPIER: RapierApi, gravity: Vec3) {
    this.RAPIER = RAPIER;
    this.world = new RAPIER.World({ x: gravity.x, y: gravity.y });
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
    this.colliders.clear();
    this.bodies.clear();
    this.world.free();
  }

  setGravity(gravity: Vec3): void {
    this.world.gravity = { x: gravity.x, y: gravity.y };
  }

  createBody(desc: RigidBodyDesc): void {
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
        bodyDesc = R.RigidBodyDesc.dynamic().setAdditionalMass(desc.mass);
        break;
    }
    bodyDesc
      .setTranslation(desc.transform.position.x, desc.transform.position.y)
      .setLinearDamping(desc.linearDamping)
      .setAngularDamping(desc.angularDamping)
      .setGravityScale(desc.gravityScale);
    const body = this.world.createRigidBody(bodyDesc);
    this.bodies.set(desc.id, { desc: { ...desc }, body });
    this.bodyIdByHandle.set(body.handle, desc.id);
  }

  destroyBody(bodyId: string): void {
    const record = this.bodies.get(bodyId);
    if (!record) return;
    for (const [id, collider] of [...this.colliders]) {
      if (collider.desc.bodyId === bodyId) this.destroyCollider(id);
    }
    for (const [id, character] of [...this.characters]) {
      if (character.desc.bodyId === bodyId) this.destroyCharacterController(id);
    }
    this.bodyIdByHandle.delete(record.body.handle);
    this.world.removeRigidBody(record.body);
    this.bodies.delete(bodyId);
  }

  setBodyTransform(bodyId: string, transform: PhysicsTransform): void {
    const record = this.bodies.get(bodyId);
    if (!record) return;
    record.body.setTranslation(
      { x: transform.position.x, y: transform.position.y },
      true,
    );
    record.desc.transform = {
      position: { ...transform.position, z: 0 },
      rotation: { ...transform.rotation },
    };
  }

  getBodyTransform(bodyId: string): PhysicsTransform | null {
    const record = this.bodies.get(bodyId);
    if (!record) return null;
    const t = record.body.translation();
    return {
      position: { x: t.x, y: t.y, z: 0 },
      rotation: identityRotation(),
    };
  }

  setBodyMotionType(
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

  addImpulse(bodyId: string, impulse: Vec3, strength = 1): void {
    const record = this.bodies.get(bodyId);
    if (!record || record.desc.motionType !== "dynamic") return;
    record.body.applyImpulse(
      { x: impulse.x * strength, y: impulse.y * strength },
      true,
    );
  }

  createCollider(desc: ColliderDesc): void {
    const body = this.bodies.get(desc.bodyId);
    if (!body) return;
    const colliderDesc = this.toColliderDesc(desc);
    if (!colliderDesc) return;
    colliderDesc
      .setFriction(desc.friction)
      .setRestitution(desc.restitution)
      .setSensor(desc.isTrigger);
    const collider = this.world.createCollider(colliderDesc, body.body);
    const extra = this.createLoopCloseSegment(desc, body.body);
    this.colliders.set(desc.id, { desc: { ...desc }, collider, extra });
    if (extra) {
      const prev = this.world.timestep;
      this.world.timestep = 0;
      this.world.step();
      this.world.timestep = prev;
    }
  }

  destroyCollider(colliderId: string): void {
    const record = this.colliders.get(colliderId);
    if (!record) return;
    this.world.removeCollider(record.collider, true);
    if (record.extra) this.world.removeCollider(record.extra, true);
    this.colliders.delete(colliderId);
  }

  step(dt: number): void {
    this.world.timestep = dt;
    this.world.step();
  }

  readTransforms(): ReadonlyMap<string, PhysicsTransform> {
    const out = new Map<string, PhysicsTransform>();
    for (const [id, record] of this.bodies) {
      const t = record.body.translation();
      out.set(id, {
        position: { x: t.x, y: t.y, z: 0 },
        rotation: identityRotation(),
      });
    }
    return out;
  }

  lineTrace(start: Vec3, end: Vec3): HitResult {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-8) return miss();
    const ray = new this.RAPIER.Ray(
      { x: start.x, y: start.y },
      { x: dx / len, y: dy / len },
    );
    const hit = this.world.castRay(ray, len, true);
    if (!hit) return miss();
    const point = ray.pointAt(hit.timeOfImpact);
    const bodyId = this.bodyIdByHandle.get(hit.collider.parent()?.handle ?? -1);
    const actorId = bodyId ? (this.bodies.get(bodyId)?.desc.actorId ?? null) : null;
    return {
      hit: true,
      location: { x: point.x, y: point.y, z: 0 },
      normal: { x: 0, y: 1, z: 0 },
      distance: hit.timeOfImpact,
      actorId,
      bodyId: bodyId ?? null,
    };
  }

  sphereOverlap(center: Vec3, radius: number): OverlapResult {
    const actorIds: string[] = [];
    const bodyIds: string[] = [];
    this.world.intersectionsWithPoint(
      { x: center.x, y: center.y },
      (collider) => {
        const bodyId = this.bodyIdByHandle.get(collider.parent()?.handle ?? -1);
        if (!bodyId) return true;
        const body = this.bodies.get(bodyId);
        if (!body) return true;
        // Point query; approximate radius by also testing nearby with shape.
        bodyIds.push(bodyId);
        actorIds.push(body.desc.actorId);
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
          const bodyId = this.bodyIdByHandle.get(
            collider.parent()?.handle ?? -1,
          );
          if (!bodyId) return true;
          if (!bodyIds.includes(bodyId)) {
            bodyIds.push(bodyId);
            const body = this.bodies.get(bodyId);
            if (body) actorIds.push(body.desc.actorId);
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
  ): HitResult {
    return this.lineTrace(start.position, end.position);
  }

  createCharacterController(desc: CharacterControllerDesc): void {
    const controller = this.world.createCharacterController(desc.offset);
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
  ): PhysicsTransform | null {
    void dt;
    const character = this.characters.get(id);
    if (!character) return null;
    const bodyRecord = this.bodies.get(character.desc.bodyId);
    if (!bodyRecord) return null;
    const collider = [...this.colliders.values()].find(
      (c) => c.desc.bodyId === bodyRecord.desc.id,
    );
    if (!collider) return null;
    character.controller.computeColliderMovement(
      collider.collider,
      { x: translation.x, y: translation.y },
    );
    const movement = character.controller.computedMovement();
    const current = bodyRecord.body.translation();
    bodyRecord.body.setNextKinematicTranslation({
      x: current.x + movement.x,
      y: current.y + movement.y,
    });
    return {
      position: {
        x: current.x + movement.x,
        y: current.y + movement.y,
        z: 0,
      },
      rotation: identityRotation(),
    };
  }

  private toColliderDesc(desc: ColliderDesc) {
    const R = this.RAPIER;
    const shape = desc.shape;
    switch (shape.kind) {
      case "box2d":
        return R.ColliderDesc.cuboid(
          shape.halfExtents.x,
          shape.halfExtents.y,
        );
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
    if (shape.kind !== "chain" || shape.loop !== true || shape.points.length < 2) {
      return undefined;
    }
    const first = shape.points[0]!;
    const last = shape.points[shape.points.length - 1]!;
    if (first.x === last.x && first.y === last.y) return undefined;
    const flat = new Float32Array([last.x, last.y, first.x, first.y]);
    const segment = this.RAPIER.ColliderDesc.polyline(flat)
      .setFriction(desc.friction)
      .setRestitution(desc.restitution)
      .setSensor(desc.isTrigger);
    return this.world.createCollider(segment, body);
  }
}
