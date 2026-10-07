import {
  composeAffineTransform,
  createAffineTransform,
  decomposeAffineTransform,
  invertAffineTransform,
  multiplyAffineTransforms,
  type AffineTransform,
  type Transform,
} from "@babylonslate/core";
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
  // A sheared ancestor continues through its exact matrix, not its TRS.
  let shear: AffineTransform | undefined;
  for (let index = chain.length - 2; index >= 0; index -= 1) {
    const world = identityTransform();
    const sheared = composeWorldPoseInto(transform, shear, chain[index]!, world);
    transform = world;
    shear = sheared && Float64Array.from(sheared);
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
  composeInto((guid) => byGuid.get(guid), selected, new MapPoseStore(resolved), new Set(), false);
  return resolved;
}

/**
 * Compose selected actors and their ancestors through a caller-owned lookup
 * that answers a guid with its first-spawned live actor (`World.findActor`, or
 * a frame's `firstSpawnedActorIndex`), so a frame that already indexes actors
 * need not rebuild one. Poses are keyed by guid and describe the actor the
 * lookup answers: a selected later duplicate resolves as its guid's
 * first-spawned actor, so the result never depends on selection order.
 * `onShear` hears each resolved actor whose world matrix is sheared, so its
 * pose only approximates that matrix (see `composeParentChildTransform`).
 * Returns fresh poses; a caller that composes every frame reuses a
 * `WorldTransformComposer` instead.
 */
export function composeActorWorldTransforms(
  lookup: (guid: string) => Actor | undefined,
  selected: Iterable<Actor>,
  onShear?: (actor: Actor) => void,
): Map<string, Transform> {
  const resolved = new Map<string, Transform>();
  composeInto(lookup, selected, new MapPoseStore(resolved), new Set(), true, onShear);
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
  return composeInto(lookup, selected, new MapPoseStore(resolved), new Set(), false);
}

/**
 * `composeActorWorldTransforms` over storage that persists between passes, for
 * a caller that composes every frame (the snapshot publish). Each guid keeps
 * its pose object (and sheared-matrix buffer) across passes and is rewritten
 * in place, so a steady world allocates nothing per actor; poses equal a fresh
 * `composeActorWorldTransforms` exactly. The returned map and its poses belong
 * to the composer: they hold only the latest pass's guids (earlier ones are
 * released) and change on the next `compose`, so copy any pose kept longer.
 */
export class WorldTransformComposer {
  private readonly store = new ReusablePoseStore();
  private readonly resolving = new Set<string>();

  compose(
    lookup: (guid: string) => Actor | undefined,
    selected: Iterable<Actor>,
    onShear?: (actor: Actor) => void,
  ): ActorTransformMap {
    this.store.begin();
    this.resolving.clear();
    composeInto(lookup, selected, this.store, this.resolving, true, onShear);
    return this.store.end();
  }
}

/** Guid-keyed pose storage that one composition pass reads and writes. */
interface PoseStore {
  /** The pose this pass already resolved for `guid`. */
  resolved(guid: string): Transform | undefined;
  /** Exact world matrix of a sheared pose this pass resolved. */
  shear(guid: string): AffineTransform | undefined;
  /** The pose object `guid`'s composition writes before `commit`. */
  target(guid: string): Transform;
  /** Keep a copy of `matrix` (a scratch buffer) as `guid`'s exact world matrix. */
  keepShear(guid: string, matrix: AffineTransform): void;
  commit(guid: string, pose: Transform): void;
}

/** Fresh poses into a caller's map; sheared matrices last one pass. */
class MapPoseStore implements PoseStore {
  private shears: Map<string, AffineTransform> | undefined;

  constructor(private readonly poses: Map<string, Transform>) {}

  resolved(guid: string): Transform | undefined {
    return this.poses.get(guid);
  }

  shear(guid: string): AffineTransform | undefined {
    return this.shears?.get(guid);
  }

  target(): Transform {
    return identityTransform();
  }

  keepShear(guid: string, matrix: AffineTransform): void {
    (this.shears ??= new Map()).set(guid, Float64Array.from(matrix));
  }

  commit(guid: string, pose: Transform): void {
    this.poses.set(guid, pose);
  }
}

interface PoseEntry {
  pose: Transform;
  /** Pass that last committed `pose`; an entry from an earlier pass is stale. */
  pass: number;
  /** Buffer kept across passes; holds the exact world matrix while `sheared`. */
  matrix: AffineTransform | null;
  sheared: boolean;
}

/** Pose objects reused per guid across passes; `end` releases guids a pass skipped. */
class ReusablePoseStore implements PoseStore {
  private readonly poses = new Map<string, Transform>();
  private readonly entries = new Map<string, PoseEntry>();
  private pass = 0;

  begin(): void {
    this.pass += 1;
  }

  end(): ActorTransformMap {
    for (const [guid, entry] of this.entries) {
      if (entry.pass === this.pass) continue;
      this.entries.delete(guid);
      this.poses.delete(guid);
    }
    return this.poses;
  }

  resolved(guid: string): Transform | undefined {
    const entry = this.entries.get(guid);
    return entry?.pass === this.pass ? entry.pose : undefined;
  }

  shear(guid: string): AffineTransform | undefined {
    const entry = this.entries.get(guid);
    return entry?.pass === this.pass && entry.sheared ? entry.matrix! : undefined;
  }

  target(guid: string): Transform {
    let entry = this.entries.get(guid);
    if (!entry) {
      entry = { pose: identityTransform(), pass: 0, matrix: null, sheared: false };
      this.entries.set(guid, entry);
      this.poses.set(guid, entry.pose);
    }
    entry.sheared = false;
    return entry.pose;
  }

  keepShear(guid: string, matrix: AffineTransform): void {
    const entry = this.entries.get(guid)!;
    (entry.matrix ??= createAffineTransform()).set(matrix);
    entry.sheared = true;
  }

  commit(guid: string): void {
    this.entries.get(guid)!.pass = this.pass;
  }
}

function composeInto(
  lookup: (guid: string) => Actor | undefined,
  selected: Iterable<Actor>,
  store: PoseStore,
  resolving: Set<string>,
  canonical: boolean,
  onShear?: (actor: Actor) => void,
): boolean {
  let cyclic = false;

  const resolve = (actor: Actor): Transform => {
    const cached = store.resolved(actor.guid);
    if (cached) return cached;
    if (resolving.has(actor.guid)) {
      cyclic = true;
      return copyTransform(actor.transform);
    }

    resolving.add(actor.guid);
    const parentId = actorParentGuid(actor);
    const parent = parentId ? lookup(parentId) : undefined;
    if (parent && resolving.has(parent.guid)) cyclic = true;
    let world: Transform;
    if (parent && !resolving.has(parent.guid)) {
      const parentWorld = resolve(parent);
      // A parent sharing this guid is a cycle, so its pose is never this target.
      world = store.target(actor.guid);
      // Sheared actors' descendants compose through their exact world matrices.
      const shear = composeWorldPoseInto(parentWorld, store.shear(parent.guid), actor.transform, world);
      if (shear) {
        store.keepShear(actor.guid, shear);
        onShear?.(actor);
      }
    } else {
      world = copyTransformInto(actor.transform, store.target(actor.guid));
    }
    resolving.delete(actor.guid);
    store.commit(actor.guid, world);
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
 * resolve through `findActor` (the first-spawned live actor), then through
 * batch actors still queued for spawn: a load inside a World tick only queues
 * its actors, which commit after every live actor, in batch order. Applying
 * parent links in spawn order, the link that closes a cycle is the one of the
 * cycle's last-spawned member, so that actor's `parentId` is cleared, as a
 * script write closing the cycle would be refused. `detach` re-roots it
 * (default: no parent). Every cycle a batch closes passes through one of its
 * actors, so only their chains are walked. Returns the cleared links in
 * discovery order.
 */
export function breakParentCycles(
  batch: Iterable<Actor>,
  findActor: (guid: string) => Actor | undefined,
  detach: (child: Actor) => void = (child) => child.setVariable("parentId", null),
): BrokenParentLink[] {
  const actors = Array.from(batch);
  const queuedByGuid = new Map<string, Actor>();
  const queuedOrder = new Map<Actor, number>();
  for (const actor of actors) {
    if (actor.destroyed || actor.world) continue;
    queuedOrder.set(actor, queuedOrder.size);
    if (!queuedByGuid.has(actor.guid)) queuedByGuid.set(actor.guid, actor);
  }
  const resolve = (guid: string) => findActor(guid) ?? queuedByGuid.get(guid);
  const spawnsAfter = (actor: Actor, other: Actor) => {
    const queued = queuedOrder.get(actor);
    const otherQueued = queuedOrder.get(other);
    if (queued === undefined && otherQueued === undefined) return actor.spawnIndex > other.spawnIndex;
    return (queued ?? -1) > (otherQueued ?? -1);
  };
  const broken: BrokenParentLink[] = [];
  const settled = new Set<Actor>();
  const path: Actor[] = [];
  const onPath = new Map<Actor, number>();
  for (const start of actors) {
    if (start.destroyed || settled.has(start)) continue;
    let current: Actor | undefined = start;
    while (current && !settled.has(current) && !onPath.has(current)) {
      onPath.set(current, path.length);
      path.push(current);
      const parentId = actorParentGuid(current);
      current = parentId ? resolve(parentId) : undefined;
    }
    const loopStart = current ? onPath.get(current) : undefined;
    if (loopStart !== undefined) {
      let closing = path[loopStart]!;
      for (let index = loopStart + 1; index < path.length; index += 1) {
        if (spawnsAfter(path[index]!, closing)) closing = path[index]!;
      }
      const parent = resolve(actorParentGuid(closing)!)!;
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

function copyTransformInto(value: Transform, out: Transform): Transform {
  out.position.x = value.position.x;
  out.position.y = value.position.y;
  out.position.z = value.position.z;
  out.rotation.x = value.rotation.x;
  out.rotation.y = value.rotation.y;
  out.rotation.z = value.rotation.z;
  out.rotation.w = value.rotation.w;
  out.scale.x = value.scale.x;
  out.scale.y = value.scale.y;
  out.scale.z = value.scale.z;
  return out;
}

function identityTransform(): Transform {
  return {
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    scale: { x: 1, y: 1, z: 1 },
  };
}

const parentScratch = createAffineTransform();
const localScratch = createAffineTransform();
const worldScratch = createAffineTransform();
const referenceScratch: Transform["rotation"] = { x: 0, y: 0, z: 0, w: 1 };
const signScratch: Transform["scale"] = { x: 1, y: 1, z: 1 };

/**
 * World pose of `local` under the world pose `parent`, matching the editor's
 * authored matrices and Babylon parenting: the world matrix is
 * `local × parentWorld`, so parent scale applies in the parent's frame and a
 * quarter-turned child permutes nonuniform parent scale onto its own axes.
 * Shear-free results (uniform parent scale, axis-aligned or mirrored turns)
 * are exact. Nonuniform parent scale with an oblique child rotation shears the
 * basis, which no pose represents: translation stays exact and the pose is the
 * nearest one (see `decomposeAffineTransform`).
 */
export function composeParentChildTransform(
  parent: Transform,
  local: Transform,
): Transform {
  const world = identityTransform();
  composeWorldPoseInto(parent, undefined, local, world);
  return world;
}

/**
 * `composeParentChildTransform` into `out` (distinct from both inputs),
 * continuing through `parentShear` (the parent's exact world matrix when its
 * pose only approximates shear). When `out` is itself such an approximation,
 * returns the exact world matrix: a scratch buffer valid until the next call.
 */
function composeWorldPoseInto(
  parent: Transform,
  parentShear: AffineTransform | undefined,
  local: Transform,
  out: Transform,
): AffineTransform | undefined {
  const { x: sx, y: sy, z: sz } = parent.scale;
  const rotation = local.rotation;
  if (!parentShear && ((sx === sy && sy === sz) ||
    (rotation.x === 0 && rotation.y === 0 && rotation.z === 0))) {
    // Uniform parent scale, or an unrotated child, commutes with the child's
    // rotation: the per-axis composition is the exact matrix product.
    composeCommutingTransformInto(parent, local, out);
    return undefined;
  }
  const world = multiplyAffineTransforms(
    composeAffineTransform(local, localScratch),
    parentShear ?? composeAffineTransform(parent, parentScratch),
    worldScratch,
  );
  // Signed scales keep the per-axis sign pattern of the composition (stable
  // while a child turns under a mirrored parent); rotation prefers parent × local.
  signScratch.x = sx * local.scale.x;
  signScratch.y = sy * local.scale.y;
  signScratch.z = sz * local.scale.z;
  const reference = multiplyQuaternionInto(parent.rotation, rotation, referenceScratch);
  return decomposeAffineTransform(world, reference, out, signScratch) ? world : undefined;
}

/**
 * The local pose that composes under `parent` to `world`: the inverse of
 * `composeParentChildTransform`, exact whenever such a shear-free pose exists.
 * `current` (the target's present local pose) chooses among equivalent signed
 * scales. Returns null when the parent's scale is not invertible.
 */
export function relativeTransform(
  parent: Transform,
  world: Transform,
  current?: Transform,
): Transform | null {
  const { x: sx, y: sy, z: sz } = parent.scale;
  if (![sx, sy, sz].every((axis) => Number.isFinite(axis) && axis !== 0)) return null;
  const inverseRotation = inverseQuaternion(parent.rotation);
  if (sx === sy && sy === sz) {
    const offset = rotateVector(inverseRotation, {
      x: world.position.x - parent.position.x,
      y: world.position.y - parent.position.y,
      z: world.position.z - parent.position.z,
    });
    return {
      position: { x: offset.x / sx, y: offset.y / sx, z: offset.z / sx },
      rotation: multiplyQuaternion(inverseRotation, world.rotation),
      scale: { x: world.scale.x / sx, y: world.scale.y / sx, z: world.scale.z / sx },
    };
  }
  if (!invertAffineTransform(composeAffineTransform(parent, parentScratch), parentScratch)) return null;
  const local = multiplyAffineTransforms(composeAffineTransform(world, localScratch), parentScratch, worldScratch);
  const transform: Transform = {
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    scale: { x: 1, y: 1, z: 1 },
  };
  decomposeAffineTransform(
    local,
    current?.rotation ?? multiplyQuaternion(inverseRotation, world.rotation),
    transform,
    current?.scale ?? { x: world.scale.x * sx, y: world.scale.y * sy, z: world.scale.z * sz },
  );
  return transform;
}

/** Per-axis composition, exact when parent scale commutes with the child's rotation. */
function composeCommutingTransformInto(
  parent: Transform,
  local: Transform,
  out: Transform,
): void {
  const position = rotateInto(
    parent.rotation,
    local.position.x * parent.scale.x,
    local.position.y * parent.scale.y,
    local.position.z * parent.scale.z,
    out.position,
  );
  position.x = parent.position.x + position.x;
  position.y = parent.position.y + position.y;
  position.z = parent.position.z + position.z;
  multiplyQuaternionInto(parent.rotation, local.rotation, out.rotation);
  out.scale.x = parent.scale.x * local.scale.x;
  out.scale.y = parent.scale.y * local.scale.y;
  out.scale.z = parent.scale.z * local.scale.z;
}

export function multiplyQuaternion(
  a: Transform["rotation"],
  b: Transform["rotation"],
): Transform["rotation"] {
  return multiplyQuaternionInto(a, b, { x: 0, y: 0, z: 0, w: 1 });
}

/** `a × b` into `out`, which may alias either input. */
function multiplyQuaternionInto(
  a: Transform["rotation"],
  b: Transform["rotation"],
  out: Transform["rotation"],
): Transform["rotation"] {
  const x = a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y;
  const y = a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x;
  const z = a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w;
  const w = a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z;
  out.x = x;
  out.y = y;
  out.z = z;
  out.w = w;
  return out;
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
  return rotateInto(quaternion, value.x, value.y, value.z, { x: 0, y: 0, z: 0 });
}

/** `quaternion` applied to (vx, vy, vz), into `out`. */
function rotateInto(
  quaternion: Transform["rotation"],
  vx: number,
  vy: number,
  vz: number,
  out: Transform["position"],
): Transform["position"] {
  const { x, y, z, w } = quaternion;
  const ix = w * vx + y * vz - z * vy;
  const iy = w * vy + z * vx - x * vz;
  const iz = w * vz + x * vy - y * vx;
  const iw = -x * vx - y * vy - z * vz;
  out.x = ix * w + iw * -x + iy * -z - iz * -y;
  out.y = iy * w + iw * -y + iz * -x - ix * -z;
  out.z = iz * w + iw * -z + ix * -y - iy * -x;
  return out;
}
