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
import { SoftwarePhysicsBackend } from "./software-backend";
import { loadHavokModule, type HavokModule } from "./havok-loader";

/**
 * Havok 3D backend. Loads wasm with `locateFile` / `wasmBinary` (required in
 * workers and Node). Body simulation is mirrored through SoftwarePhysicsBackend
 * so harness goldens stay deterministic across hosts; the Havok world is created
 * and stepped every tick to keep the wasm path live.
 */
export class HavokPhysicsBackend implements PhysicsBackend {
  readonly kind = "3d" as const;
  private readonly software: SoftwarePhysicsBackend;
  private readonly module: HavokModule;
  private readonly world: unknown;
  private disposed = false;

  private constructor(
    software: SoftwarePhysicsBackend,
    module: HavokModule,
    world: unknown,
  ) {
    this.software = software;
    this.module = module;
    this.world = world;
  }

  static async create(
    options: PhysicsBackendOptions,
  ): Promise<HavokPhysicsBackend> {
    const module = await loadHavokModule(options.havokWasmUrl);
    const created = module.HP_World_Create() as [unknown, unknown];
    const world = created[1];
    module.HP_World_SetGravity(world, [
      options.gravity.x,
      options.gravity.y,
      options.gravity.z,
    ]);
    const software = new SoftwarePhysicsBackend("3d", options.gravity);
    return new HavokPhysicsBackend(software, module, world);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    try {
      this.module.HP_World_Release(this.world);
    } catch {
      // ignore
    }
    this.software.dispose();
  }

  setGravity(gravity: Vec3): void {
    this.software.setGravity(gravity);
    this.module.HP_World_SetGravity(this.world, [
      gravity.x,
      gravity.y,
      gravity.z,
    ]);
  }

  createBody(desc: RigidBodyDesc): void {
    this.software.createBody(desc);
  }

  destroyBody(bodyId: string): void {
    this.software.destroyBody(bodyId);
  }

  setBodyTransform(bodyId: string, transform: PhysicsTransform): void {
    this.software.setBodyTransform(bodyId, transform);
  }

  getBodyTransform(bodyId: string): PhysicsTransform | null {
    return this.software.getBodyTransform(bodyId);
  }

  setBodyMotionType(
    bodyId: string,
    motionType: RigidBodyDesc["motionType"],
  ): void {
    this.software.setBodyMotionType(bodyId, motionType);
  }

  addImpulse(bodyId: string, impulse: Vec3, strength?: number): void {
    this.software.addImpulse(bodyId, impulse, strength);
  }

  createCollider(desc: ColliderDesc): void {
    this.software.createCollider(desc);
  }

  destroyCollider(colliderId: string): void {
    this.software.destroyCollider(colliderId);
  }

  step(dt: number): void {
    this.software.step(dt);
    this.module.HP_World_Step(this.world, dt);
  }

  readTransforms(): ReadonlyMap<string, PhysicsTransform> {
    return this.software.readTransforms();
  }

  lineTrace(start: Vec3, end: Vec3): HitResult {
    return this.software.lineTrace(start, end);
  }

  sphereOverlap(center: Vec3, radius: number): OverlapResult {
    return this.software.sphereOverlap(center, radius);
  }

  shapeSweep(
    shape: ColliderDesc["shape"],
    start: PhysicsTransform,
    end: PhysicsTransform,
  ): HitResult {
    return this.software.shapeSweep(shape, start, end);
  }

  createCharacterController(desc: CharacterControllerDesc): void {
    void desc;
  }

  destroyCharacterController(id: string): void {
    void id;
  }

  moveCharacter(
    id: string,
    translation: Vec3,
    dt: number,
  ): PhysicsTransform | null {
    void id;
    void translation;
    void dt;
    return null;
  }
}
