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
import { actorWorldTransforms, composeParentChildTransform } from "./actor-world-transform";

/** Keep live objects inside the evaluator; only transport/trace copies use references. */
export function snapshotBlackboard(values: BlackboardValues): BlackboardValues {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key, sanitizeInspectValue(value)]),
  );
}

export function blackboardTargetPosition(value: unknown, world: World): NavPoint | null {
  if (!value || typeof value !== "object") return null;
  if (value instanceof BObject && value.destroyed) return null;
  const row = value as { guid?: unknown; classId?: unknown; x?: unknown; y?: unknown; z?: unknown };
  if (typeof row.guid !== "string") return finitePosition(value);

  const actors = world.getActors().filter((actor) => !actor.destroyed);
  const target = actors.find((actor) => actor.guid === row.guid)
    ?? actors.flatMap((actor) => actor.components).find((component) => component.guid === row.guid);
  if (!target || target.destroyed) return null;
  if (value instanceof BObject && value !== target) return null;
  const actorTransforms = actorWorldTransforms(actors);
  if (target instanceof Actor) return finitePosition(actorTransforms.get(target.guid)?.position);
  if (!(target instanceof ActorComponent) || !target.owner) return null;

  const ownerTransform = actorTransforms.get(target.owner.guid);
  if (!ownerTransform) return null;
  let local: Transform = target.transform;
  let parentId = target.parentId;
  const visited = new Set([target.guid]);
  while (parentId) {
    if (visited.has(parentId)) return null;
    visited.add(parentId);
    const parent = target.owner.components.find((component) => component.guid === parentId);
    if (!parent || parent.destroyed) return null;
    local = composeParentChildTransform(parent.transform, local);
    parentId = parent.parentId;
  }
  return finitePosition(composeParentChildTransform(ownerTransform, local).position);
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
