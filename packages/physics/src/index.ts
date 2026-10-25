export type {
  PhysicsBackend,
  SphereSweepQuery,
} from "./backend";
export type {
  PhysicsWorldKind,
  MotionType,
  Vec3,
  Quat,
  PhysicsTransform,
  BodyVelocity,
  TeleportOptions,
  ConstraintBase,
  ConstraintDesc,
  ColliderShape,
  ColliderShape3D,
  ColliderShape2D,
  RigidBodyDesc,
  ColliderDesc,
  ColliderChanges,
  HitResult,
  LineTraceOptions,
  OverlapResult,
  CharacterControllerDesc,
  CharacterMovementResult,
  PhysicsContactEvent,
  PhysicsBackendOptions,
  RigidBodyTuning,
} from "./types";
export type {
  DebugColliderPrimitive,
  DebugColliderShape,
} from "./debug-colliders";
export {
  listDebugCollidersFromRecords,
} from "./debug-colliders";
export { SoftwarePhysicsBackend } from "./software-backend";
export { colliderPairResponse } from "./collision-response";
export {
  createPhysicsBackend,
  createSoftwarePhysicsBackend,
  loadedBackendModules,
  loadRapier2DBackendFactory,
  resetLoadedBackendModules,
  type CreatePhysicsBackendOptions,
} from "./create-backend";
// Types only, so the engines stay in the chunks `createPhysicsBackend` loads lazily; tests that need the classes
// import the `./havok-backend` and `./rapier-backend` subpaths.
export type { HavokPhysicsBackend } from "./havok-backend";
export type { Rapier2DPhysicsBackend } from "./rapier-backend";
export { resetHavokModuleCache } from "./havok-loader";
export {
  parseRigidBodyProperties,
  parseColliderProperties,
  parseConstraintProperties,
  type ConstraintProperties,
  type RigidBodyProperties,
  type ColliderProperties,
} from "./component-props";
export {
  bakeColliderLocal,
  assertColliderLocalPose,
  colliderLocalPose,
  scaleColliderShape,
  rotateQuatVec,
  multiplyQuat,
  quatToPlanarAngle,
  isIdentityQuat,
  type ColliderLocalTransform,
} from "./collider-bake";
export {
  physicsActorDiagnostics,
  physicsActorsDiagnostics,
  type PhysicsActorLike,
  type PhysicsDiagnosticsContext,
  type PhysicsPairingWarning,
} from "./pairing";

export { prepareColliderShape } from "./collider-validation";
export { RagdollPhysics } from "./ragdoll";
