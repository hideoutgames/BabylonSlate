/** Shared physics descriptors. Interface is shaped primarily around Havok. */

export type PhysicsWorldKind = "3d" | "2d";

export type MotionType = "static" | "kinematic" | "dynamic";

export type Vec3 = { x: number; y: number; z: number };

export type Quat = { x: number; y: number; z: number; w: number };

export type PhysicsTransform = {
  position: Vec3;
  rotation: Quat;
};

export type ColliderShape3D =
  | { kind: "box"; halfExtents: Vec3 }
  | { kind: "sphere"; radius: number }
  | { kind: "capsule"; radius: number; halfHeight: number }
  | { kind: "cylinder"; radius: number; height: number }
  | { kind: "convex"; points: readonly Vec3[] }
  | { kind: "mesh"; vertices: readonly Vec3[]; indices: readonly number[] };

export type ColliderShape2D =
  | { kind: "box2d"; halfExtents: { x: number; y: number } }
  | { kind: "circle"; radius: number }
  | { kind: "capsule2d"; radius: number; halfHeight: number }
  | { kind: "polygon"; points: readonly { x: number; y: number }[] }
  | { kind: "chain"; points: readonly { x: number; y: number }[]; loop?: boolean };

export type ColliderShape = ColliderShape3D | ColliderShape2D;

export type RigidBodyDesc = {
  id: string;
  actorId: string;
  motionType: MotionType;
  mass: number;
  linearDamping: number;
  angularDamping: number;
  gravityScale: number;
  transform: PhysicsTransform;
};

/** Mid-Play rigid-body knobs (mass, damping, gravity, motion type). */
export type RigidBodyTuning = {
  motionType?: MotionType;
  mass?: number;
  linearDamping?: number;
  angularDamping?: number;
  gravityScale?: number;
};

export type ColliderDesc = {
  id: string;
  bodyId: string;
  shape: ColliderShape;
  friction: number;
  restitution: number;
  isTrigger: boolean;
  layer: number;
  mask: number;
  /** Local offset from the rigid body origin (component transform position). */
  translation?: Vec3;
  /** Local rotation relative to the rigid body (component transform rotation). */
  rotation?: Quat;
};

/** Mid-Play collider knobs (trigger, material, filters). */
export type ColliderTuning = {
  isTrigger?: boolean;
  friction?: number;
  restitution?: number;
  layer?: number;
  mask?: number;
};

export type HitResult = {
  hit: boolean;
  location: Vec3 | null;
  normal: Vec3 | null;
  distance: number;
  actorId: string | null;
  bodyId: string | null;
};

export type OverlapResult = {
  actorIds: string[];
  bodyIds: string[];
};

export type CharacterControllerDesc = {
  id: string;
  bodyId: string;
  offset: number;
};

export type PhysicsContactEvent = {
  kind: "hit" | "overlapBegin" | "overlapEnd";
  actorAId: string;
  actorBId: string;
  colliderAId?: string;
  colliderBId?: string;
  location: Vec3;
  normal: Vec3;
};

export type PhysicsBackendOptions = {
  kind: PhysicsWorldKind;
  gravity: Vec3;
  /** Absolute or worker-resolvable URL for Havok wasm (3d only). */
  havokWasmUrl?: string;
};
