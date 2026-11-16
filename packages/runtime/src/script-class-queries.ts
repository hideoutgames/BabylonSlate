import type { Actor, ActorComponent, ClassRegistry, World } from "@haptic/object-model";
import { worldComponentIndex } from "./world-component-index";

/** The components a class query returns: the actors owning one, in world order, and the classes that match. */
interface ComponentMatches {
  owners: readonly Actor[];
  /** The one matching class, or null when `classIds` holds several. */
  only: string | null;
  classIds: ReadonlySet<string>;
}

/** One world's answers, for one world structure revision and one class registry revision. */
interface ClassQueries {
  structure: number;
  registry: ClassRegistry | undefined;
  classes: number;
  actors: Map<string, readonly Actor[]>;
  components: Map<string, ComponentMatches>;
}

const NO_ACTORS: readonly Actor[] = [];
const queries = new WeakMap<World, ClassQueries>();

/**
 * Which actors are of a Class or own a component of one changes only with the world structure (spawn, destroy,
 * attach) and which Classes descend from which only with the class registry, so each target Class is resolved once
 * per pair of revisions. Membership only: `destroyed` is read live by the callers below.
 */
function classQueries(world: World, registry: ClassRegistry | undefined): ClassQueries {
  const structure = world.structuralRevision;
  const classes = registry?.revision ?? 0;
  let entry = queries.get(world);
  if (!entry || entry.structure !== structure || entry.registry !== registry || entry.classes !== classes) {
    entry = { structure, registry, classes, actors: new Map(), components: new Map() };
    queries.set(world, entry);
  }
  return entry;
}

/** The ids among `classIds` that are `target` or descend from it. */
function matchingClassIds(classIds: Iterable<string>, target: string, registry: ClassRegistry | undefined): string[] {
  const matching: string[] = [];
  for (const id of classIds) {
    if (id === target || (registry?.isA(id, target) ?? false)) matching.push(id);
  }
  return matching;
}

/**
 * The world's actors of `target` or a subclass, in world order, destroyed ones included as the actor list holds
 * them. The returned list is shared: copy it before handing it to a script.
 */
export function actorsOfClass(world: World, registry: ClassRegistry | undefined, target: string): readonly Actor[] {
  const cache = classQueries(world, registry);
  let actors = cache.actors.get(target);
  if (!actors) {
    const index = worldComponentIndex(world);
    const matching = matchingClassIds(index.actorClassIds(), target, registry);
    if (matching.length === 0) actors = NO_ACTORS;
    else if (matching.length === 1) actors = index.actors(matching[0]!);
    else {
      // Several subclasses: one pass over the actor list keeps world order across them.
      const ids = new Set(matching);
      actors = world.getActors().filter((actor) => ids.has(actor.classId));
    }
    cache.actors.set(target, actors);
  }
  return actors;
}

function componentMatches(world: World, registry: ClassRegistry | undefined, target: string): ComponentMatches {
  const cache = classQueries(world, registry);
  let matches = cache.components.get(target);
  if (!matches) {
    const index = worldComponentIndex(world);
    const matching = matchingClassIds(index.classIds(), target, registry);
    let owners: readonly Actor[] = NO_ACTORS;
    if (matching.length === 1) owners = index.owners(matching[0]!);
    else if (matching.length > 1) {
      const owning = new Set<Actor>();
      for (const id of matching) for (const owner of index.owners(id)) owning.add(owner);
      owners = world.getActors().filter((actor) => owning.has(actor));
    }
    matches = { owners, only: matching.length === 1 ? matching[0]! : null, classIds: new Set(matching) };
    cache.components.set(target, matches);
  }
  return matches;
}

/**
 * The live components of `target` or a subclass on live actors, in world order then attachment order: appended to
 * `into`, or with no list the first one.
 */
export function componentsOfClass(
  world: World,
  registry: ClassRegistry | undefined,
  target: string,
  into: ActorComponent[] | null,
): ActorComponent | null {
  const { owners, only, classIds } = componentMatches(world, registry, target);
  for (const actor of owners) {
    if (actor.destroyed) continue;
    for (const component of actor.components) {
      if (component.destroyed) continue;
      if (only !== null ? component.classId !== only : !classIds.has(component.classId)) continue;
      if (!into) return component;
      into.push(component);
    }
  }
  return null;
}
