import type { SerializedTransform, Transform } from "@babylonslate/core";
import { Actor, ActorComponent, runtimeTransformFromSerialized, type World } from "@babylonslate/object-model";
import { actorChainWorldTransform, actorParentGuid, composeParentChildTransform, inverseQuaternion, multiplyQuaternion, rotateVector } from "./actor-world-transform";

function runtimeEditParentTransform(world: World, target: Actor | ActorComponent): Transform | null {
  const actor = target instanceof Actor ? target : target.owner!;
  let parent: Transform | null = null;
  if (target instanceof Actor) {
    const parentId = actorParentGuid(actor);
    const parentActor = parentId ? world.findActor(parentId) : undefined;
    if (parentActor) {
      parent = actorChainWorldTransform(parentActor, id => world.findActor(id));
      if (!parent) throw new Error("The actor hierarchy contains a cycle.");
    }
  } else {
    parent = actorChainWorldTransform(actor, id => world.findActor(id));
    if (!parent) throw new Error("The actor hierarchy contains a cycle.");
    const chain: ActorComponent[] = []; const visited = new Set([target.guid]);
    let parentId = target.parentId;
    while (parentId) {
      if (visited.has(parentId)) throw new Error("The component hierarchy contains a cycle.");
      visited.add(parentId);
      const component = actor.components.find(candidate => !candidate.destroyed && candidate.guid === parentId);
      if (!component) throw new Error("A component parent is missing.");
      chain.push(component); parentId = component.parentId;
    }
    for (let index = chain.length - 1; index >= 0; index--) parent = composeParentChildTransform(parent, chain[index]!.transform);
  }
  return parent;
}

export function runtimeEditWorldTransform(world: World, target: Actor | ActorComponent): SerializedTransform {
  const parent = runtimeEditParentTransform(world, target);
  const pose = parent ? composeParentChildTransform(parent, target.transform) : target.transform;
  return { position: [pose.position.x, pose.position.y, pose.position.z], rotation: [pose.rotation.x, pose.rotation.y, pose.rotation.z, pose.rotation.w],
    scale: [pose.scale.x, pose.scale.y, pose.scale.z] };
}

/** Convert a gizmo's absolute world pose against current authoritative ancestor poses. */
export function runtimeEditLocalTransform(world: World, target: Actor | ActorComponent, transform: SerializedTransform, space: "local" | "world" = "local"): Transform {
  const requested = runtimeTransformFromSerialized(transform);
  if (space === "local") return requested;
  const parent = runtimeEditParentTransform(world, target);
  if (!parent) return requested;
  if (Object.values(parent.scale).some(value => !Number.isFinite(value) || Math.abs(value) < 1e-6)) throw new Error("The parent has a non-invertible scale.");
  const inverse = inverseQuaternion(parent.rotation);
  const offset = rotateVector(inverse, { x: requested.position.x - parent.position.x, y: requested.position.y - parent.position.y, z: requested.position.z - parent.position.z });
  return { position: { x: offset.x / parent.scale.x, y: offset.y / parent.scale.y, z: offset.z / parent.scale.z },
    rotation: multiplyQuaternion(inverse, requested.rotation),
    scale: { x: requested.scale.x / parent.scale.x, y: requested.scale.y / parent.scale.y, z: requested.scale.z / parent.scale.z } };
}
