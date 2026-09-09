import type { BlackboardValues } from "@babylonslate/behaviour-tree";
import type { Transform } from "@babylonslate/core";
import {
  Actor,
  ActorComponent,
  BObject,
  sanitizeInspectValue,
  type World,
} from "@babylonslate/object-model";
import type { NavPoint } from "@babylonslate/navigation";
import { actorWorldTransform, composeParentChildTransform } from "./actor-world-transform";

/** Keep live objects inside the evaluator; only transport/trace copies use references. */
export function snapshotBlackboard(values: BlackboardValues): BlackboardValues {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key, sanitizeInspectValue(value)]),
  );
}

export function blackboardTargetPosition(
  value: unknown,
  world: World,
  actorsByGuid: ReadonlyMap<string, Actor> = new Map(world.getActors().map((actor) => [actor.guid, actor])),
): NavPoint | null {
  if (!value || typeof value !== "object") return null;
  if (value instanceof BObject && value.destroyed) return null;
  const row = value as { guid?: unknown };
  if (typeof row.guid !== "string") return finitePosition(value);

  let target = value instanceof BObject
    ? value
    : actorsByGuid.get(row.guid);
  if (!target) {
    for (const actor of actorsByGuid.values()) {
      target = actor.components.find((component) => component.guid === row.guid);
      if (target) break;
    }
  }
  if (!target || target.destroyed) return null;
  const owner = target instanceof Actor ? target : target instanceof ActorComponent ? target.owner : null;
  if (!owner || owner.destroyed || owner.world !== world || actorsByGuid.get(owner.guid) !== owner) return null;
  const ownerTransform = actorWorldTransform(owner, actorsByGuid);
  if (!ownerTransform) return null;
  if (target instanceof Actor) return finitePosition(ownerTransform.position);
  if (!(target instanceof ActorComponent) || !owner.components.includes(target)) return null;

  const chain: Transform[] = [target.transform];
  let parentId = target.parentId;
  const visited = new Set([target.guid]);
  while (parentId) {
    if (visited.has(parentId)) return null;
    visited.add(parentId);
    const parent = owner.components.find((component) => component.guid === parentId);
    if (!parent || parent.destroyed) return null;
    chain.push(parent.transform);
    parentId = parent.parentId;
  }
  let transform = ownerTransform;
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    transform = composeParentChildTransform(transform, chain[index]!);
  }
  return finitePosition(transform.position);
}

function finitePosition(value: unknown): NavPoint | null {
  if (!value || typeof value !== "object") return null;
  const row = Array.isArray(value)
    ? { x: value[0], y: value[1], z: value[2] }
    : value as { x?: unknown; y?: unknown; z?: unknown };
  const { x, y } = row;
  const z = row.z === undefined ? 0 : row.z;
  if (typeof x !== "number" || !Number.isFinite(x)) return null;
  if (typeof y !== "number" || !Number.isFinite(y)) return null;
  if (typeof z !== "number" || !Number.isFinite(z)) return null;
  return { x, y, z };
}
