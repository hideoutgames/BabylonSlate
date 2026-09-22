import type { Actor } from "@babylonslate/object-model";
import type { Transform } from "@babylonslate/core";
import { actorParentGuid } from "./actor-world-transform";
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
  return (
    !!a &&
    a.length === b.length &&
    a.every((value, index) => Object.is(value, b[index]))
  );
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

/** Resolve only physics participants and their ancestors, retaining the ordered
 * World list for iteration. A parent without physics still contributes scale. */
export function physicsWorldTransforms(
  actors: readonly Actor[],
  byGuid: ReadonlyMap<string, Actor>,
  kind: "2d" | "3d",
  eligible: (actor: Actor) => boolean,
  bodyPoses?: ReadonlyMap<string, PhysicsTransform>,
): Map<string, Transform> {
  const resolved = new Map<string, Transform>();
  const resolving = new Set<Actor>();
  const resolve = (actor: Actor): Transform => {
    const old = resolved.get(actor.guid);
    if (old) return old;
    if (resolving.has(actor))
      throw new Error("Physics hierarchy contains a parent cycle");
    resolving.add(actor);
    const parentId = actorParentGuid(actor);
    const parent = parentId ? byGuid.get(parentId) : undefined;
    let transform = {
      position: { ...actor.transform.position },
      rotation: { ...actor.transform.rotation },
      scale: { ...actor.transform.scale },
    };
    if (parent && !parent.destroyed) {
      const ancestor = resolve(parent);
      const local = colliderLocalPose(
        kind === "2d" ? "box2d" : "box",
        actor.transform,
        ancestor.scale,
      );
      const translation = rotateQuatVec(ancestor.rotation, local.translation);
      transform = {
        position: {
          x: ancestor.position.x + translation.x,
          y: ancestor.position.y + translation.y,
          z: ancestor.position.z + translation.z,
        },
        rotation: multiplyQuat(ancestor.rotation, local.rotation),
        scale: local.scale,
      };
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
  for (const actor of actors) {
    if (
      !actor.destroyed &&
      byGuid.get(actor.guid) === actor &&
      eligible(actor) &&
      actor.components.some(
        (component) =>
          !component.destroyed &&
          component.owner === actor &&
          [
            "RigidBodyComponent",
            "ColliderComponent",
            "MeshComponent",
            "BlockingVolumeComponent",
            "TilemapComponent",
          ].includes(component.classId),
      )
    )
      resolve(actor);
  }
  return resolved;
}
