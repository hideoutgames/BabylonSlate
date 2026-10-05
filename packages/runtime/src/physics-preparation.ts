import type { Actor } from "@babylonslate/object-model";
import type { Transform } from "@babylonslate/core";
import {
  actorParentGuid,
  composeParentChildTransform,
} from "./actor-world-transform";
import {
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
} from "@babylonslate/physics";

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

/**
 * Physics hierarchy semantics shared by the per-tick pass and call-time chains:
 * `lookup` answers a parent guid with its first live match (as both
 * `World.findActor` and the per-tick index do), a destroyed parent ends the
 * chain, a parent cycle throws, and every parented link is checked against the
 * shear-free, nonzero-scale TRS boundary.
 */
function physicsTransformResolver(
  lookup: (guid: string) => Actor | undefined,
  kind: "2d" | "3d",
  resolved: Map<string, Transform>,
  bodyPoses?: ReadonlyMap<string, PhysicsTransform>,
): (actor: Actor) => Transform {
  const resolving = new Set<Actor>();
  const resolve = (actor: Actor): Transform => {
    const old = resolved.get(actor.guid);
    if (old) return old;
    if (resolving.has(actor))
      throw new Error("Physics hierarchy contains a parent cycle");
    resolving.add(actor);
    const parentId = actorParentGuid(actor);
    const parent = parentId ? lookup(parentId) : undefined;
    let transform = {
      position: { ...actor.transform.position },
      rotation: { ...actor.transform.rotation },
      scale: { ...actor.transform.scale },
    };
    if (parent && !parent.destroyed) {
      const ancestor = resolve(parent);
      // Validate the supported shear-free TRS boundary, but retain the shared
      // authored actor composition used by snapshots and rendering.
      colliderLocalPose(
        kind === "2d" ? "box2d" : "box",
        actor.transform,
        ancestor.scale,
      );
      transform = composeParentChildTransform(ancestor, actor.transform);
    }
    const bodyPose = bodyPoses?.get(actor.guid);
    if (bodyPose)
      transform = {
        ...transform,
        position: { ...bodyPose.position },
        rotation: { ...bodyPose.rotation },
      };
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
  byGuid: ReadonlyMap<string, Actor>,
  kind: "2d" | "3d",
  eligible: (actor: Actor) => boolean,
  bodyPoses?: ReadonlyMap<string, PhysicsTransform>,
): Map<string, Transform> {
  const resolved = new Map<string, Transform>();
  const resolve = physicsTransformResolver(
    (guid) => byGuid.get(guid),
    kind,
    resolved,
    bodyPoses,
  );
  for (const actor of actors) {
    if (
      !actor.destroyed &&
      byGuid.get(actor.guid) === actor &&
      eligible(actor) &&
      actor.components.some(
        (component) =>
          !component.destroyed &&
          component.owner === actor &&
          (component.classId !== "LandscapeComponent" ||
            (kind === "3d" && component.getVariable("collisionsEnabled") === true)) &&
          (component.classId !== "DynamicRuntimeMeshComponent" ||
            (kind === "3d" && component.getVariable("enableCollision") === true)) &&
          PARTICIPANT_CLASSES.has(component.classId),
      )
    )
      resolve(actor);
  }
  return resolved;
}
