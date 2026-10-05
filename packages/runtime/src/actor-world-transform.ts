import type { Transform } from "@babylonslate/core";
import type { Actor } from "@babylonslate/object-model";

export type ActorTransformMap = ReadonlyMap<string, Transform>;

/** Resolve one current pose without caching transforms changed by this tick's scripts. */
export function actorWorldTransform(
  actor: Actor,
  actorsByGuid: ReadonlyMap<string, Actor>,
): Transform | null {
  const chain = [actor.transform];
  let parentId = actorParentGuid(actor);
  const visited = new Set([actor.guid]);
  while (parentId) {
    if (visited.has(parentId)) return null;
    visited.add(parentId);
    const parent = actorsByGuid.get(parentId);
    if (!parent) break;
    if (parent.destroyed) return null;
    chain.push(parent.transform);
    parentId = actorParentGuid(parent);
  }
  let transform = chain[chain.length - 1]!;
  for (let index = chain.length - 2; index >= 0; index -= 1) {
    transform = composeParentChildTransform(transform, chain[index]!);
  }
  return transform;
}

/**
 * One actor's current pose through a live guid lookup such as `World.findActor`,
 * visiting only its own ancestors. Null on a parent cycle, as `actorWorldTransform`.
 */
export function actorChainWorldTransform(
  actor: Actor,
  findActor: (guid: string) => Actor | undefined,
): Transform | null {
  const chain = new Map<string, Actor>();
  for (let current: Actor | undefined = actor; current && !chain.has(current.guid);) {
    chain.set(current.guid, current);
    const parent = actorParentGuid(current);
    current = parent ? findActor(parent) : undefined;
  }
  return actorWorldTransform(actor, chain);
}

/**
 * Guid index over `actors` in spawn order where each guid answers its
 * first-spawned live actor, as `World.findActor` and physics do. Later actors
 * that share a guid (legacy saves, replacements) are never answered.
 */
export function firstSpawnedActorIndex(actors: Iterable<Actor>): Map<string, Actor> {
  const index = new Map<string, Actor>();
  for (const actor of actors) {
    if (!actor.destroyed && !index.has(actor.guid)) index.set(actor.guid, actor);
  }
  return index;
}

/**
 * Compose selected actors and their ancestors with first-spawned parents;
 * default to the whole world. Poses are keyed by guid, and each entry is the
 * guid's first-spawned actor (see `composeActorWorldTransforms`).
 */
export function firstSpawnedWorldTransforms(
  actors: readonly Actor[],
  selected: Iterable<Actor> = actors,
): Map<string, Transform> {
  const index = firstSpawnedActorIndex(actors);
  return composeActorWorldTransforms((guid) => index.get(guid), selected);
}

/**
 * Legacy composition through a last-wins guid index (a later actor replaces an
 * earlier one with the same guid). Only the water pass still uses it; its
 * owner keeps that contract. Every other runtime pass resolves first-spawned
 * parents through `firstSpawnedWorldTransforms` or `composeActorWorldTransforms`.
 */
export function actorWorldTransforms(
  actors: readonly Actor[],
  selected: Iterable<Actor> = actors,
): Map<string, Transform> {
  const byGuid = new Map<string, Actor>();
  for (const actor of actors) byGuid.set(actor.guid, actor);
  const resolved = new Map<string, Transform>();
  composeInto((guid) => byGuid.get(guid), selected, resolved, false);
  return resolved;
}

/**
 * Compose selected actors and their ancestors through a caller-owned lookup
 * that answers a guid with its first-spawned live actor (`World.findActor`, or
 * a frame's `firstSpawnedActorIndex`), so a frame that already indexes actors
 * need not rebuild one. Poses are keyed by guid and describe the actor the
 * lookup answers: a selected later duplicate resolves as its guid's
 * first-spawned actor, so the result never depends on selection order.
 */
export function composeActorWorldTransforms(
  lookup: (guid: string) => Actor | undefined,
  selected: Iterable<Actor>,
): Map<string, Transform> {
  const resolved = new Map<string, Transform>();
  composeInto(lookup, selected, resolved, true);
  return resolved;
}

/**
 * Compose `selected` and their ancestors into `resolved` through a caller-owned
 * parent lookup. Returns true when a parent cycle was reached: poses on a cycle
 * depend on resolution order, so callers that must match a whole-world pass
 * recompose in world order instead.
 */
export function composeActorWorldTransformsInto(
  lookup: (guid: string) => Actor | undefined,
  selected: Iterable<Actor>,
  resolved: Map<string, Transform>,
): boolean {
  return composeInto(lookup, selected, resolved, false);
}

function composeInto(
  lookup: (guid: string) => Actor | undefined,
  selected: Iterable<Actor>,
  resolved: Map<string, Transform>,
  canonical: boolean,
): boolean {
  const resolving = new Set<string>();
  let cyclic = false;

  const resolve = (actor: Actor): Transform => {
    const cached = resolved.get(actor.guid);
    if (cached) return cached;
    const local = copyTransform(actor.transform);
    if (resolving.has(actor.guid)) {
      cyclic = true;
      return local;
    }

    resolving.add(actor.guid);
    const parentId = actorParentGuid(actor);
    const parent = parentId ? lookup(parentId) : undefined;
    if (parent && resolving.has(parent.guid)) cyclic = true;
    const world =
      parent && !resolving.has(parent.guid)
        ? composeParentChildTransform(resolve(parent), local)
        : local;
    resolving.delete(actor.guid);
    resolved.set(actor.guid, world);
    return world;
  };

  for (const actor of selected) resolve(canonical ? (lookup(actor.guid) ?? actor) : actor);
  return cyclic;
}

/** Name (or class) plus guid, as hierarchy warnings identify actors. */
export function actorLabel(actor: Actor): string {
  const name = actor.getVariable("name");
  return `${typeof name === "string" && name.trim() ? name : actor.classId} (${actor.guid})`;
}

/** A parent link that load-time cycle breaking cleared. */
export interface BrokenParentLink {
  child: Actor;
  parent: Actor;
}

/**
 * Break parent cycles that a spawned batch closed among live actors. Parents
 * resolve through `findActor` (the first-spawned live actor). Applying parent
 * links in spawn order, the link that closes a cycle is the one of the cycle's
 * last-spawned member, so that actor's `parentId` is cleared, as a script
 * write closing the cycle would be refused. `detach` re-roots it (default: no
 * parent). Every cycle a batch closes passes through one of its actors, so only
 * their chains are walked. Returns the cleared links in discovery order.
 */
export function breakParentCycles(
  batch: Iterable<Actor>,
  findActor: (guid: string) => Actor | undefined,
  detach: (child: Actor) => void = (child) => child.setVariable("parentId", null),
): BrokenParentLink[] {
  const broken: BrokenParentLink[] = [];
  const settled = new Set<Actor>();
  const path: Actor[] = [];
  const onPath = new Map<Actor, number>();
  for (const start of batch) {
    if (start.destroyed || settled.has(start)) continue;
    let current: Actor | undefined = start;
    while (current && !settled.has(current) && !onPath.has(current)) {
      onPath.set(current, path.length);
      path.push(current);
      const parentId = actorParentGuid(current);
      current = parentId ? findActor(parentId) : undefined;
    }
    const loopStart = current ? onPath.get(current) : undefined;
    if (loopStart !== undefined) {
      let closing = path[loopStart]!;
      for (let index = loopStart + 1; index < path.length; index += 1) {
        if (path[index]!.spawnIndex > closing.spawnIndex) closing = path[index]!;
      }
      const parent = findActor(actorParentGuid(closing)!)!;
      detach(closing);
      broken.push({ child: closing, parent });
    }
    for (const actor of path) settled.add(actor);
    path.length = 0;
    onPath.clear();
  }
  return broken;
}

export function actorParentGuid(actor: Actor): string | null {
  const parentId = actor.getVariable("parentId");
  return typeof parentId === "string" && parentId.length > 0 ? parentId : null;
}

export function copyTransform(value: Transform): Transform {
  return {
    position: { ...value.position },
    rotation: { ...value.rotation },
    scale: { ...value.scale },
  };
}

export function composeParentChildTransform(
  parent: Transform,
  local: Transform,
): Transform {
  const scaled = {
    x: local.position.x * parent.scale.x,
    y: local.position.y * parent.scale.y,
    z: local.position.z * parent.scale.z,
  };
  const rotated = rotateVector(parent.rotation, scaled);
  return {
    position: {
      x: parent.position.x + rotated.x,
      y: parent.position.y + rotated.y,
      z: parent.position.z + rotated.z,
    },
    rotation: multiplyQuaternion(parent.rotation, local.rotation),
    scale: {
      x: parent.scale.x * local.scale.x,
      y: parent.scale.y * local.scale.y,
      z: parent.scale.z * local.scale.z,
    },
  };
}

export function multiplyQuaternion(
  a: Transform["rotation"],
  b: Transform["rotation"],
): Transform["rotation"] {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}

export function inverseQuaternion(
  value: Transform["rotation"],
): Transform["rotation"] {
  const lengthSquared =
    value.x * value.x +
    value.y * value.y +
    value.z * value.z +
    value.w * value.w;
  if (lengthSquared === 0) return { x: 0, y: 0, z: 0, w: 1 };
  return {
    x: -value.x / lengthSquared,
    y: -value.y / lengthSquared,
    z: -value.z / lengthSquared,
    w: value.w / lengthSquared,
  };
}

export function rotateVector(
  quaternion: Transform["rotation"],
  value: Transform["position"],
): Transform["position"] {
  const { x, y, z, w } = quaternion;
  const ix = w * value.x + y * value.z - z * value.y;
  const iy = w * value.y + z * value.x - x * value.z;
  const iz = w * value.z + x * value.y - y * value.x;
  const iw = -x * value.x - y * value.y - z * value.z;
  return {
    x: ix * w + iw * -x + iy * -z - iz * -y,
    y: iy * w + iw * -y + iz * -x - ix * -z,
    z: iz * w + iw * -z + ix * -y - iy * -x,
  };
}
