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
  PhysicsContactEvent,
  PhysicsTransform,
  TeleportOptions,
  PhysicsWorldKind,
  RigidBodyDesc,
  RigidBodyTuning,
  Vec3,
} from "./types";
import type { DebugColliderPrimitive } from "./debug-colliders";

/** Reusable radius-specific query. Results/vectors are borrowed until the next sweep. */
export interface SphereSweepQuery {
  /** Distance is sphere-center travel; location is the hit collider's surface. Initial overlaps have distance zero. */
  sweep(sx: number, sy: number, sz: number, ex: number, ey: number, ez: number): HitResult;
  /** Idempotent. Queries return a miss after disposal, including backend shutdown. */
  dispose(): void;
}

/**
 * Transport-agnostic physics port hosted inside the game worker.
 * Sync queries must return on the calling execution pin (same tick).
 */
export interface PhysicsBackend {
  readonly kind: PhysicsWorldKind;
  readonly supportsConstraints: boolean;

  dispose(): void;

  setGravity(gravity: Vec3): void;

  createBody(desc: RigidBodyDesc): void;
  destroyBody(bodyId: string): void;
  teleportBody(bodyId: string, transform: PhysicsTransform, options?: TeleportOptions): void;
  setBodyTargetTransform(bodyId: string, transform: PhysicsTransform): void;
  getBodyTransform(bodyId: string): PhysicsTransform | null;
  getBodyVelocity(bodyId: string): BodyVelocity | null;
  /** Set only the supplied world velocity axes of a dynamic body. */
  setBodyLinearVelocity(bodyId: string, velocity: Partial<Vec3>): void;
  /** Set a dynamic body's world angular velocity in radians/second. 2D uses only Z. */
  setBodyAngularVelocity(bodyId: string, velocity: Vec3): void;
  addImpulse(bodyId: string, impulse: Vec3, strength?: number): void;
  /** World-space impulse at a point, preserving collision-driven linear and angular motion. */
  addImpulseAtPoint(bodyId: string, impulse: Vec3, point: Vec3): void;
  /** Read-only velocity change from a world impulse, including collider inertia. */
  getBodyImpulseResponse?(bodyId: string, impulse: Vec3, point: Vec3): {
    linear: Vec3; angular: Vec3; centerOfMass: Vec3;
  } | null;
  updateBody(bodyId: string, tuning: RigidBodyTuning): void;

  /** Atomically creates/replaces one constraint, retaining the old one on failure. */
  createConstraint(desc: ConstraintDesc): void;
  destroyConstraint(id: string): void;

  createCollider(desc: ColliderDesc): void;
  applyColliderChanges(bodyId: string, changes: ColliderChanges): void;
  destroyCollider(colliderId: string): void;

  /** Debug draw primitives for `showcollision` (boxes/spheres/circles/polylines). */
  listDebugColliders(): readonly DebugColliderPrimitive[];

  /** Fixed-step simulation. */
  step(dt: number): void;

  /**
   * Contacts detected since the previous poll (software: current overlap
   * vs the previous poll). Blocking pairs emit `hit` every poll while
   * overlapping; a trigger on either collider emits begin/end overlap only.
   */
  pollContacts(): PhysicsContactEvent[];

  lineTrace(start: Vec3, end: Vec3, options?: LineTraceOptions): HitResult;
  sphereOverlap(center: Vec3, radius: number, options?: LineTraceOptions): OverlapResult;
  shapeSweep(
    shape: ColliderDesc["shape"],
    start: PhysicsTransform,
    end: PhysicsTransform,
    options?: LineTraceOptions,
  ): HitResult;
  /** Optional optimized query for repeated sphere casts, excluding triggers. Own until disposed. */
  createSphereSweep?(radius: number): SphereSweepQuery;

  /** 2D Rapier kinematic character controller; 3D uses Babylon `PhysicsCharacterController`. */
  createCharacterController(desc: CharacterControllerDesc): void;
  destroyCharacterController(id: string): void;
  /** Optional authored start pose repositions the solve without adding motor velocity. */
  moveCharacter(
    id: string,
    translation: Vec3,
    dt: number,
    startPose?: PhysicsTransform,
  ): CharacterMovementResult | null;
}
