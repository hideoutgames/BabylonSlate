export type {
  PhysicsBackend,
  CreatePhysicsBackend,
} from "./backend";
export type {
  PhysicsWorldKind,
  MotionType,
  Vec3,
  Quat,
  PhysicsTransform,
  ColliderShape,
  ColliderShape3D,
  ColliderShape2D,
  RigidBodyDesc,
  ColliderDesc,
  HitResult,
  OverlapResult,
  CharacterControllerDesc,
  PhysicsContactEvent,
  PhysicsBackendOptions,
  RigidBodyTuning,
  ColliderTuning,
} from "./types";
export type {
  DebugColliderPrimitive,
  DebugColliderShape,
} from "./debug-colliders";
export {
  debugColliderFromDesc,
  listDebugCollidersFromRecords,
} from "./debug-colliders";
export { SoftwarePhysicsBackend, createNullPhysicsBackend } from "./software-backend";
export {
  createPhysicsBackend,
  createSoftwarePhysicsBackend,
  loadedBackendModules,
  resetLoadedBackendModules,
  type CreatePhysicsBackendOptions,
} from "./create-backend";
export { HavokPhysicsBackend } from "./havok-backend";
export { resetHavokModuleCache } from "./havok-loader";
export { Rapier2DPhysicsBackend } from "./rapier-backend";
export {
  parseRigidBodyProperties,
  parseColliderProperties,
  type RigidBodyProperties,
  type ColliderProperties,
} from "./component-props";
export {
  bakeColliderLocal,
  scaleColliderShape,
  rotateQuatVec,
  multiplyQuat,
  quatToPlanarAngle,
  identityQuat,
  isIdentityQuat,
  type ColliderLocalTransform,
} from "./collider-bake";
export {
  physicsActorDiagnostics,
  physicsActorsDiagnostics,
  type PhysicsActorLike,
  type PhysicsPairingWarning,
} from "./pairing";
