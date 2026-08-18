import type {
  CharacterControllerDesc,
  ColliderDesc,
  HitResult,
  OverlapResult,
  PhysicsBackendOptions,
  PhysicsTransform,
  PhysicsWorldKind,
  RigidBodyDesc,
  Vec3,
} from "./types";
import type { DebugColliderPrimitive } from "./debug-colliders";

/**
 * Transport-agnostic physics port hosted inside the game worker.
 * Sync queries must return on the calling execution pin (same tick).
 */
export interface PhysicsBackend {
  readonly kind: PhysicsWorldKind;

  dispose(): void;

  setGravity(gravity: Vec3): void;

  createBody(desc: RigidBodyDesc): void;
  destroyBody(bodyId: string): void;
  setBodyTransform(bodyId: string, transform: PhysicsTransform): void;
  getBodyTransform(bodyId: string): PhysicsTransform | null;
  setBodyMotionType(
    bodyId: string,
    motionType: RigidBodyDesc["motionType"],
  ): void;
  addImpulse(bodyId: string, impulse: Vec3, strength?: number): void;

  createCollider(desc: ColliderDesc): void;
  destroyCollider(colliderId: string): void;

  /** Debug draw primitives for `showcollision` (boxes/spheres/circles/polylines). */
  listDebugColliders(): readonly DebugColliderPrimitive[];

  /** Fixed-step simulation. */
  step(dt: number): void;

  /** Snapshot all dynamic/kinematic body transforms after step. */
  readTransforms(): ReadonlyMap<string, PhysicsTransform>;

  lineTrace(start: Vec3, end: Vec3): HitResult;
  sphereOverlap(center: Vec3, radius: number): OverlapResult;
  shapeSweep(
    shape: ColliderDesc["shape"],
    start: PhysicsTransform,
    end: PhysicsTransform,
  ): HitResult;

  /** 2D Rapier kinematic character controller; 3D uses Babylon `PhysicsCharacterController`. */
  createCharacterController(desc: CharacterControllerDesc): void;
  destroyCharacterController(id: string): void;
  moveCharacter(
    id: string,
    translation: Vec3,
    dt: number,
  ): PhysicsTransform | null;
}

export type CreatePhysicsBackend = (
  options: PhysicsBackendOptions,
) => Promise<PhysicsBackend>;
