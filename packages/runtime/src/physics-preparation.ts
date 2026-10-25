import type { Actor, ActorComponent, World } from "@haptic/object-model";
import type { Transform } from "@haptic/core";
import {
  actorParentGuid,
  composeParentChildTransform,
  composeParentChildTransformInto,
  copyTransform,
  copyTransformInto,
} from "./actor-world-transform";
import {
  assertColliderLocalPose,
  colliderLocalPose,
  multiplyQuat,
  rotateQuatVec,
  scaleColliderShape,
  prepareColliderShape,
  type ColliderLocalTransform,
  type ColliderShape,
  type Quat,
  type PhysicsTransform,
  type Vec3,
} from "@haptic/physics";

export function sameDescriptor(
  a: readonly unknown[] | undefined,
  b: readonly unknown[],
): boolean {
  if (!a || a.length !== b.length) return false;
  for (let index = 0; index < a.length; index++)
    if (!Object.is(a[index], b[index])) return false;
  return true;
}

export function transformDescriptor(
  local: ColliderLocalTransform,
): readonly number[] {
  return [
    local.position.x,
    local.position.y,
    local.position.z,
    local.rotation.x,
    local.rotation.y,
    local.rotation.z,
    local.rotation.w,
    local.scale.x,
    local.scale.y,
    local.scale.z,
  ];
}

/**
 * Variable-length descriptor written in place each tick. Its backing array is
 * never stored: callers keep `copy()` only when `matches()` reports a change.
 */
export class DescriptorScratch {
  private readonly values: unknown[] = [];
  private written = 0;
  private length = 0;

  begin(): void {
    this.length = 0;
  }

  push(value: unknown): void {
    this.values[this.length++] = value;
  }

  pushTransform(local: ColliderLocalTransform): void {
    this.push(local.position.x);
    this.push(local.position.y);
    this.push(local.position.z);
    this.push(local.rotation.x);
    this.push(local.rotation.y);
    this.push(local.rotation.z);
    this.push(local.rotation.w);
    this.push(local.scale.x);
    this.push(local.scale.y);
    this.push(local.scale.z);
  }

  matches(stored: readonly unknown[] | undefined): boolean {
    // Release references left by a longer previous descriptor.
    if (this.written > this.length) this.values.fill(undefined, this.length, this.written);
    this.written = this.length;
    if (!stored || stored.length !== this.length) return false;
    for (let index = 0; index < this.length; index++)
      if (!Object.is(stored[index], this.values[index])) return false;
    return true;
  }

  copy(): unknown[] {
    return this.values.slice(0, this.length);
  }
}

export function componentAssetGuid(component: ActorComponent): string | null {
  const value = component.assetGuid ?? component.getVariable("assetGuid");
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function toMap<T>(
  value: ReadonlyMap<string, T> | Readonly<Record<string, T>>,
): Map<string, T> {
  if (value instanceof Map) return new Map(value);
  return new Map(Object.entries(value));
}

/** Each prepared component owns these stages; pose/tuning edits borrow its geometry. */
export class PreparedColliderGeometry {
  private stages: Array<{
    source: ColliderShape;
    scale: Vec3;
    shape: ColliderShape;
  }> = [];

  private scaled(
    stage: number,
    source: ColliderShape,
    scale: Vec3,
  ): ColliderShape {
    const previous = this.stages[stage];
    if (
      previous?.source === source &&
      previous.scale.x === scale.x &&
      previous.scale.y === scale.y &&
      previous.scale.z === scale.z
    )
      return previous.shape;
    const shape = prepareColliderShape(scaleColliderShape(source, scale));
    this.stages[stage] = { source, scale: { ...scale }, shape };
    return shape;
  }

  prepare(
    source: ColliderShape,
    local: ColliderLocalTransform,
    actorScale: Vec3,
  ): { shape: ColliderShape; translation: Vec3; rotation: Quat } {
    const pose = colliderLocalPose(source.kind, local, actorScale);
    return {
      shape: this.scaled(0, source, pose.scale),
      translation: pose.translation,
      rotation: pose.rotation,
    };
  }

  prepareImported(
    source: ColliderShape,
    imported: ColliderLocalTransform,
    component: ColliderLocalTransform,
    actorScale: Vec3,
  ): { shape: ColliderShape; translation: Vec3; rotation: Quat } {
    const first = colliderLocalPose(source.kind, imported, component.scale);
    const shape = this.scaled(0, source, first.scale);
    const offset = rotateQuatVec(component.rotation, first.translation);
    const second = colliderLocalPose(
      shape.kind,
      {
        position: {
          x: component.position.x + offset.x,
          y: component.position.y + offset.y,
          z: component.position.z + offset.z,
        },
        rotation: multiplyQuat(component.rotation, first.rotation),
        scale: { x: 1, y: 1, z: 1 },
      },
      actorScale,
    );
    return {
      shape: this.scaled(1, shape, second.scale),
      translation: second.translation,
      rotation: second.rotation,
    };
  }
}

const PARTICIPANT_CLASSES = new Set([
  "RigidBodyComponent",
  "WaterBuoyancyComponent",
  "MovementComponent",
  "ColliderComponent",
  "MeshComponent",
  "DynamicRuntimeMeshComponent",
  "LandscapeComponent",
  "BlockingVolumeComponent",
  "TilemapComponent",
]);

const participants = new WeakMap<World, { revision: number; actors: readonly Actor[] }>();

/**
 * The World's actors that own a component of a physics participant class, in World order: the only actors a
 * physics pass can find a body or a transform source on. Ownership changes only with the world structure (spawn,
 * destroy, attach), so one filter of the actor list serves every pass until the next structural change. The list
 * is a superset of the live participants (a destroyed or disabled component keeps its owner listed); eligibility
 * and `hasParticipantComponent` still decide each actor on every pass. A list is never mutated once built.
 */
export function physicsParticipantActors(world: World): readonly Actor[] {
  const revision = world.structuralRevision;
  let entry = participants.get(world);
  if (entry?.revision !== revision) {
    const actors: Actor[] = [];
    for (const actor of world.getActors()) {
      for (const component of actor.components) {
        if (PARTICIPANT_CLASSES.has(component.classId)) {
          actors.push(actor);
          break;
        }
      }
    }
    entry = { revision, actors };
    participants.set(world, entry);
  }
  return entry.actors;
}

/**
 * Containers and unparented poses one world's per-tick composition reuses, so a
 * steady world allocates no map, set or flat pose per tick. A pass rewrites
 * them: its result, and any pose in it, is valid only until the next pass, so
 * nothing may keep them longer.
 */
export class PhysicsCompositionScratch {
  readonly resolved = new Map<string, Transform>();
  readonly resolving = new Set<Actor>();
  private readonly poses = new Map<string, Transform>();

  begin(): void {
    this.resolved.clear();
    this.resolving.clear();
  }

  /** The pose object for `guid`; the caller overwrites all of it. */
  pose(guid: string): Transform {
    let pose = this.poses.get(guid);
    if (!pose) {
      pose = {
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        scale: { x: 1, y: 1, z: 1 },
      };
      this.poses.set(guid, pose);
    }
    return pose;
  }

  /** Releases the poses of guids this pass did not resolve. */
  end(): void {
    for (const guid of this.poses.keys()) if (!this.resolved.has(guid)) this.poses.delete(guid);
  }
}

/**
 * Physics hierarchy semantics shared by the per-tick pass and call-time chains:
 * `lookup` answers a parent guid with its live actor (as both
 * `World.findActor` and the per-tick index do), a destroyed parent ends the
 * chain, a parent cycle throws, and every parented link is checked against the
 * shear-free, nonzero-scale TRS boundary.
 */
function physicsTransformResolver(
  lookup: (guid: string) => Actor | undefined,
  kind: "2d" | "3d",
  resolved: Map<string, Transform>,
  bodyPoses?: ReadonlyMap<string, PhysicsTransform>,
  scratch?: PhysicsCompositionScratch,
): (actor: Actor) => Transform {
  const resolving = scratch?.resolving ?? new Set<Actor>();
  const resolve = (actor: Actor): Transform => {
    const old = resolved.get(actor.guid);
    if (old) return old;
    if (resolving.has(actor))
      throw new Error("Physics hierarchy contains a parent cycle");
    resolving.add(actor);
    const parentId = actorParentGuid(actor);
    const parent = parentId ? lookup(parentId) : undefined;
    let transform: Transform;
    if (parent && !parent.destroyed) {
      const ancestor = resolve(parent);
      // Validate the supported shear-free TRS boundary, but retain the shared
      // authored actor composition used by snapshots and rendering.
      assertColliderLocalPose(
        kind === "2d" ? "box2d" : "box",
        actor.transform,
        ancestor.scale,
      );
      // A cycle threw above, so the pose is distinct from the ancestor's.
      transform = scratch
        ? composeParentChildTransformInto(ancestor, actor.transform, scratch.pose(actor.guid))
        : composeParentChildTransform(ancestor, actor.transform);
    } else {
      transform = scratch
        ? copyTransformInto(actor.transform, scratch.pose(actor.guid))
        : copyTransform(actor.transform);
    }
    const bodyPose = bodyPoses?.get(actor.guid);
    // `transform` belongs to this pass alone, so the body pose overwrites it.
    if (bodyPose) {
      transform.position.x = bodyPose.position.x;
      transform.position.y = bodyPose.position.y;
      transform.position.z = bodyPose.position.z;
      transform.rotation.x = bodyPose.rotation.x;
      transform.rotation.y = bodyPose.rotation.y;
      transform.rotation.z = bodyPose.rotation.z;
      transform.rotation.w = bodyPose.rotation.w;
    }
    resolving.delete(actor);
    resolved.set(actor.guid, transform);
    return transform;
  };
  return resolve;
}

/**
 * Resolve the current world poses of `actors` and only their own ancestor
 * chains, with the per-tick pass's semantics. Call-time pose writes and
 * queries use this, so their cost and validation follow the actors they touch
 * rather than every physics participant in the world.
 */
export function physicsChainTransforms(
  actors: Iterable<Actor>,
  lookup: (guid: string) => Actor | undefined,
  kind: "2d" | "3d",
): Map<string, Transform> {
  const resolved = new Map<string, Transform>();
  const resolve = physicsTransformResolver(lookup, kind, resolved);
  for (const actor of actors) resolve(actor);
  return resolved;
}

/** Resolve only physics participants and their ancestors, retaining the ordered
 * World list for iteration. A parent without physics still contributes scale.
 * This is the tick's validation boundary: parent cycles and unsupported shear
 * throw here, before any native body or collider is touched. `bodyPoses`
 * substitutes post-step body positions and rotations for a whole-world
 * readback after step hooks may have changed authored actors. */
export function physicsWorldTransforms(
  actors: readonly Actor[],
  lookup: (guid: string) => Actor | undefined,
  kind: "2d" | "3d",
  eligible: (actor: Actor) => boolean,
  bodyPoses?: ReadonlyMap<string, PhysicsTransform>,
  scratch?: PhysicsCompositionScratch,
): Map<string, Transform> {
  scratch?.begin();
  const resolved = scratch?.resolved ?? new Map<string, Transform>();
  const resolve = physicsTransformResolver(
    lookup,
    kind,
    resolved,
    bodyPoses,
    scratch,
  );
  for (const actor of actors) {
    if (!actor.destroyed && eligible(actor) && hasParticipantComponent(actor, kind)) resolve(actor);
  }
  scratch?.end();
  return resolved;
}

/** Whether `actor` owns a live component that makes it a physics participant in a `kind` world. */
function hasParticipantComponent(actor: Actor, kind: "2d" | "3d"): boolean {
  const components = actor.components;
  for (let index = 0; index < components.length; index++) {
    const component = components[index]!;
    if (
      !component.destroyed &&
      component.owner === actor &&
      (component.classId !== "LandscapeComponent" ||
        (kind === "3d" && component.getVariable("collisionsEnabled") === true)) &&
      (component.classId !== "DynamicRuntimeMeshComponent" ||
        (kind === "3d" && component.getVariable("enableCollision") === true)) &&
      PARTICIPANT_CLASSES.has(component.classId)
    )
      return true;
  }
  return false;
}
