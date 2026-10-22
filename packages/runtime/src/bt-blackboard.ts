import type { BlackboardDocument, BlackboardValues } from "@haptic/behaviour-tree";
import type { Transform } from "@haptic/core";
import {
  Actor,
  ActorComponent,
  BObject,
  sanitizeInspectValue,
  type World,
} from "@haptic/object-model";
import type { NavPoint } from "@haptic/navigation";
import { actorWorldTransform, composeParentChildTransform, actorGuidIndex } from "./actor-world-transform";

/** Keep live objects inside the evaluator; only transport/trace copies use references. */
export function snapshotBlackboard(values: BlackboardValues): BlackboardValues {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key, sanitizeInspectValue(value)]),
  );
}

/** What `copyBlackboard` leaves for a value it cannot copy exactly; it equals nothing. */
const UNCOMPARABLE = Symbol("uncomparable");
/** Deeper nesting than a blackboard value has is never compared. */
const MAX_COPY_DEPTH = 32;
/**
 * More values than this in one Blackboard are never compared: the copy would cost
 * as much as sanitizing, and a shared (acyclic) structure can expand exponentially.
 */
const MAX_COPY_NODES = 10_000;

const isPlainObject = (value: object): boolean => {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

/** One `copyBlackboard` call: values visited so far, and the containers on the path being copied. */
interface CopyState { nodes: number; ancestors: Set<object> }

function copyValue(value: unknown, depth: number, state: CopyState): unknown {
  if (++state.nodes > MAX_COPY_NODES) return UNCOMPARABLE;
  if (typeof value === "function") return UNCOMPARABLE;
  if (value === null || typeof value !== "object") return value;
  // A live object is compared by identity: its guid and class never change.
  if (value instanceof BObject) return value;
  // A container met again on its own path is a cycle; copying it again would not end.
  if (depth >= MAX_COPY_DEPTH || state.ancestors.has(value)) return UNCOMPARABLE;
  const array = Array.isArray(value);
  // Maps, Sets, Dates and class instances sanitize by their own rules; never claim them unchanged.
  if (!array && !isPlainObject(value)) return UNCOMPARABLE;
  state.ancestors.add(value);
  let copy: unknown;
  if (array) {
    const items: unknown[] = [];
    for (let index = 0; index < value.length; index++) items.push(copyValue(value[index], depth + 1, state));
    copy = items;
  } else {
    const fields: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(value)) fields[key] = copyValue((value as Record<string, unknown>)[key], depth + 1, state);
    copy = fields;
  }
  state.ancestors.delete(value);
  return copy;
}

/**
 * Walks the baseline copy, a finite tree, with the live value beside it, so it
 * visits at most the copy's nodes however the live value is shared or cyclic.
 */
function sameValue(baseline: unknown, live: unknown, depth: number): boolean {
  if (baseline === UNCOMPARABLE) return false;
  if (baseline === live) return true;
  if (typeof baseline === "number" && typeof live === "number") return baseline !== baseline && live !== live;
  if (baseline === null || live === null || typeof baseline !== "object" || typeof live !== "object") return false;
  // Equal live objects were identical above, so a different one has changed.
  if (baseline instanceof BObject || depth >= MAX_COPY_DEPTH) return false;
  if (Array.isArray(baseline)) {
    if (!Array.isArray(live) || live.length !== baseline.length) return false;
    for (let index = 0; index < baseline.length; index++) if (!sameValue(baseline[index], live[index], depth + 1)) return false;
    return true;
  }
  if (Array.isArray(live) || !isPlainObject(live)) return false;
  const keys = Object.keys(baseline);
  if (keys.length !== Object.keys(live).length) return false;
  for (const key of keys) {
    if (!Object.hasOwn(live, key) || !sameValue((baseline as Record<string, unknown>)[key], (live as Record<string, unknown>)[key], depth + 1)) return false;
  }
  return true;
}

/**
 * An independent copy of a Blackboard's arrays and plain objects, to compare the
 * live values with later without sanitizing them. Live objects stay by reference
 * and anything else that is not plain data becomes `UNCOMPARABLE`.
 */
export function copyBlackboard(values: BlackboardValues): BlackboardValues {
  const copy: BlackboardValues = Object.create(null);
  const state: CopyState = { nodes: 0, ancestors: new Set() };
  for (const key of Object.keys(values)) {
    try {
      copy[key] = copyValue(values[key], 0, state);
    } catch {
      // A throwing getter or proxy is for sanitizing to report, as it always has.
      state.ancestors.clear();
      copy[key] = UNCOMPARABLE;
    }
  }
  return copy;
}

/**
 * Whether the live Blackboard still equals a `copyBlackboard` copy, so that
 * sanitizing both gives equal results: plain data by content (NaN equals NaN),
 * live objects by identity. Maps, class instances, functions and cycles never
 * match, which sends the caller down its sanitizing path. Unlike `samePlainData`
 * it never descends into a live actor or component.
 */
export function sameBlackboard(baseline: BlackboardValues, live: BlackboardValues): boolean {
  try {
    const keys = Object.keys(baseline);
    if (keys.length !== Object.keys(live).length) return false;
    for (const key of keys) {
      if (!Object.hasOwn(live, key) || !sameValue(baseline[key], live[key], 0)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function inspectType(type: BlackboardDocument["keys"][number]["type"]): string {
  switch (type.kind) {
    case "array":
      return `array:${inspectType(type.element)}`;
    case "map":
      return `map:${inspectType(type.key)}=>${inspectType(type.value)}`;
    case "structRef":
      return `struct:${type.guid}`;
    case "objectRef":
    case "actorRef":
      return "object";
    case "classRef":
      return "class";
    default:
      return type.kind;
  }
}

/** Transport the schema alongside values so numeric Tags are never guessed. */
export function blackboardInspectTypes(document?: BlackboardDocument): Record<string, string> | undefined {
  if (!document?.keys.length) return undefined;
  return Object.fromEntries(document.keys.map((key) => [key.name, inspectType(key.type)]));
}

/**
 * World position of a blackboard Vector or spatial reference. `actorsByGuid`
 * answers each guid with its live actor (the frame index or `actorGuidIndex`).
 */
export function blackboardTargetPosition(
  value: unknown,
  world: World,
  actorsByGuid: ReadonlyMap<string, Actor> = actorGuidIndex(world.getActors()),
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
