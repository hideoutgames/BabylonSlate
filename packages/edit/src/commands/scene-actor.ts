import type { SerializedActor, SerializedComponent, SerializedScene } from "@haptic/core";

/** Returns `doc` itself when `update` keeps the actor, so the stack sees a no-op. */
export function replaceActor(
  doc: SerializedScene,
  actorId: string,
  update: (actor: SerializedActor) => SerializedActor,
): SerializedScene {
  let changed = false;
  const actors = doc.actors.map((actor) => {
    if (actor.id !== actorId) return actor;
    const next = update(actor);
    changed ||= next !== actor;
    return next;
  });
  return changed ? { ...doc, actors } : doc;
}

/** A missing actor leaves `doc` unchanged; an existing one is always replaced. */
export function replaceComponent(
  doc: SerializedScene,
  actorId: string,
  componentId: string,
  update: (component: SerializedComponent) => SerializedComponent,
): SerializedScene {
  return replaceActor(doc, actorId, (actor) => ({
    ...actor,
    components: actor.components.map((component) => component.id === componentId ? update(component) : component),
  }));
}
