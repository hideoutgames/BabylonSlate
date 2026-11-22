import type { Actor, ActorComponent, World } from "@haptic/object-model";

/**
 * Actors owning at least one component of each class, and actors of each class themselves, in world order, for one
 * structure revision.
 */
export class WorldComponentIndex {
  private readonly byClass = new Map<string, Actor[]>();
  private readonly byActorClass = new Map<string, Actor[]>();
  private byComponentId: Map<string, ActorComponent> | null = null;
  private readonly actorList: readonly Actor[];

  constructor(actors: readonly Actor[]) {
    this.actorList = actors;
    for (const actor of actors) {
      if (actor.classId) {
        const sameClass = this.byActorClass.get(actor.classId);
        if (sameClass) sameClass.push(actor);
        else this.byActorClass.set(actor.classId, [actor]);
      }
      for (const component of actor.components) {
        let owners = this.byClass.get(component.classId);
        if (!owners) this.byClass.set(component.classId, owners = []);
        // An actor's components are visited together, so a repeat is always the last entry.
        if (owners[owners.length - 1] !== actor) owners.push(actor);
      }
    }
  }

  /** Never mutated once built: a walk over it is unaffected by later spawns or destroys. */
  owners(classId: string): readonly Actor[] {
    return this.byClass.get(classId) ?? NO_OWNERS;
  }

  classIds(): IterableIterator<string> {
    return this.byClass.keys();
  }

  /** Actors whose own class is exactly `classId` (an actor without a class is in no list). Never mutated once built. */
  actors(classId: string): readonly Actor[] {
    return this.byActorClass.get(classId) ?? NO_OWNERS;
  }

  actorClassIds(): IterableIterator<string> {
    return this.byActorClass.keys();
  }

  /**
   * The component a world-wide search by id reaches first: the first live actor in world order with a live
   * component whose guid or prefab `sourceId` is `componentId`, and that actor's first such component. Built on
   * first use; ids are only unique per actor (instances of one prefab share a `sourceId`), so the earliest wins.
   */
  componentById(componentId: string): ActorComponent | undefined {
    let byId = this.byComponentId;
    if (!byId) {
      byId = this.byComponentId = new Map();
      for (const actor of this.actorList) {
        if (actor.destroyed) continue;
        for (const component of actor.components) {
          if (component.destroyed) continue;
          if (!byId.has(component.guid)) byId.set(component.guid, component);
          if (component.sourceId && !byId.has(component.sourceId)) byId.set(component.sourceId, component);
        }
      }
    }
    return byId.get(componentId);
  }
}

const NO_OWNERS: readonly Actor[] = [];
const indexes = new WeakMap<World, { revision: number; index: WorldComponentIndex }>();

/**
 * Which actors own which component classes, and which actors are of which
 * class, changes only with the world
 * structure (spawn, destroy, attach), so one pass over the actors serves every
 * per-tick system until the next structural change. Membership only: enabled
 * flags, `destroyed` and properties are read live by each consumer, and a
 * destroyed component keeps its owner listed. Code that edits
 * `actor.components` in place must call `world.markStructureChanged()`.
 */
export function worldComponentIndex(world: World): WorldComponentIndex {
  const revision = world.structuralRevision;
  let entry = indexes.get(world);
  if (entry?.revision !== revision) {
    entry = { revision, index: new WorldComponentIndex(world.getActors()) };
    indexes.set(world, entry);
  }
  return entry.index;
}

/** Actors owning a `classId` component, in `world.getActors()` order. */
export function componentOwners(world: World, classId: string): readonly Actor[] {
  return worldComponentIndex(world).owners(classId);
}

/** `componentOwners` while the cached index matches the world structure; undefined, without a rebuild, once it is stale. */
export function currentComponentOwners(world: World, classId: string): readonly Actor[] | undefined {
  const entry = indexes.get(world);
  return entry?.revision === world.structuralRevision ? entry.index.owners(classId) : undefined;
}

/**
 * `visit` for each actor owning a `classId` component, in world order, as
 * `for (const actor of world.getActors())` would reach them. For a visit that
 * can change the world (scripts spawn, destroy or attach), the first change
 * hands the rest of the walk to the live actor list from the next position, so
 * what that loop reaches is still reached: actors spawned meanwhile, and
 * actors that gain the component. `visit` then also receives actors without
 * the class and must do nothing for them. Returns false when `stopped` ended
 * the walk early, true when it ran to the end.
 */
export function walkComponentOwners(
  world: World,
  classId: string,
  stopped: () => boolean,
  visit: (actor: Actor) => void,
): boolean {
  const revision = world.structuralRevision;
  for (const actor of componentOwners(world, classId)) {
    if (stopped()) return false;
    visit(actor);
    if (world.structuralRevision === revision && !stopped()) continue;
    return walkLiveActorsAfter(world, actor, stopped, visit);
  }
  return true;
}

/**
 * Visits each live actor after `last` in world order, including ones spawned
 * meanwhile. A synchronous removal can shift the live list left, so the walk
 * resumes after the last visited actor by spawn order, not by position.
 */
function walkLiveActorsAfter(
  world: World,
  last: Actor,
  stopped: () => boolean,
  visit: (actor: Actor) => void,
): boolean {
  let destroys = Number.NaN;
  let index = 0;
  for (;;) {
    const actors = world.getActors();
    if (world.destroyCount !== destroys) {
      destroys = world.destroyCount;
      index = firstAfterSpawnOrder(actors, last.spawnOrder);
    }
    if (index >= actors.length) return true;
    if (stopped()) return false;
    last = actors[index++]!;
    visit(last);
  }
}

/** The first position whose actor spawned after `spawnOrder`; the list is ascending in spawn order. */
function firstAfterSpawnOrder(actors: readonly Actor[], spawnOrder: number): number {
  let low = 0;
  let high = actors.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (actors[middle]!.spawnOrder <= spawnOrder) low = middle + 1;
    else high = middle;
  }
  return low;
}
