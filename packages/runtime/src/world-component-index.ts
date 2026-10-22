import type { Actor, World } from "@haptic/object-model";

/** Actors owning at least one component of each class, in world order, for one structure revision. */
export class WorldComponentIndex {
  private readonly byClass = new Map<string, Actor[]>();

  constructor(actors: readonly Actor[]) {
    for (const actor of actors) {
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
}

const NO_OWNERS: readonly Actor[] = [];
const indexes = new WeakMap<World, { revision: number; index: WorldComponentIndex }>();

/**
 * Which actors own which component classes changes only with the world
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
  const actors = world.getActors();
  const revision = world.structuralRevision;
  for (const actor of componentOwners(world, classId)) {
    if (stopped()) return false;
    // Positions are dense while the structure is unchanged, so `indexOf` is a safeguard.
    const position = actors[actor.spawnIndex] === actor ? actor.spawnIndex : actors.indexOf(actor);
    visit(actor);
    if (world.structuralRevision === revision && !stopped()) continue;
    for (let index = position + 1; index < actors.length; index++) {
      if (stopped()) return false;
      visit(actors[index]!);
    }
    return true;
  }
  return true;
}
