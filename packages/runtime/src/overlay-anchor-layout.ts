import { isSceneLayerAnchorActor } from "@babylonslate/core";
import type { Actor, ActorComponent } from "@babylonslate/object-model";
import { actorParentGuid } from "./actor-world-transform";

/** Resolve the uppermost layout owner; descendants inherit its spatial movement. */
export function overlayAnchorBindings(actors: readonly Actor[]): Map<Actor, ActorComponent> {
  const live = actors.filter((actor) => actor.sceneLayerId && !actor.destroyed);
  const byId = new Map(live.map((actor) => [actor.guid, actor]));
  const direct = new Map<Actor, ActorComponent>();
  const anchorOf = (actor: Actor) => actor.components.find(
    (component) => component.classId === "2DAnchorComponent" && !component.destroyed,
  );
  const parentOf = (actor: Actor): Actor | undefined => {
    const id = actorParentGuid(actor);
    const parent = id ? byId.get(id) : undefined;
    return parent?.sceneLayerId === actor.sceneLayerId ? parent : undefined;
  };

  // An attached component belongs to its Actor; an Outliner anchor belongs to
  // its spatial parent. An owner's own component wins over helper children.
  for (const actor of live) {
    const anchor = anchorOf(actor);
    if (anchor && !isSceneLayerAnchorActor(actor)) direct.set(actor, anchor);
  }
  for (const actor of live) {
    if (!isSceneLayerAnchorActor(actor)) continue;
    const anchor = anchorOf(actor);
    const parent = parentOf(actor);
    // A helper beneath another helper inherits it; the upper helper registers
    // its own spatial parent, regardless of the serialized actor order.
    if (anchor && parent && !isSceneLayerAnchorActor(parent) && !direct.has(parent)) direct.set(parent, anchor);
  }

  const controlling = new Map<Actor, Actor | null>();
  const bindings = new Map<Actor, ActorComponent>();
  for (const actor of direct.keys()) {
    const path: Actor[] = [];
    const visited = new Set<Actor>();
    let cursor: Actor | undefined = actor;
    while (cursor && !controlling.has(cursor) && !visited.has(cursor)) {
      visited.add(cursor);
      path.push(cursor);
      cursor = parentOf(cursor);
    }
    if (cursor && visited.has(cursor)) {
      for (const entry of path) controlling.set(entry, null);
      continue;
    }
    let owner = cursor ? controlling.get(cursor) ?? null : null;
    for (const entry of path.reverse()) {
      owner ??= direct.has(entry) ? entry : null;
      controlling.set(entry, owner);
    }
    if (controlling.get(actor) === actor) bindings.set(actor, direct.get(actor)!);
  }
  return bindings;
}
