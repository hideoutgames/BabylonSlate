import { actorSubtree, isFocusTargetClass, type SerializedActor, type SerializedScene } from "@babylonslate/core";
import { duplicateSceneActors } from "./place-actors";

/** Snapshot actor subtrees without references to objects outside the copy. */
export function copySceneActors(scene: SerializedScene, selectedIds: readonly string[]): SerializedActor[] {
  const ids = new Set(selectedIds.flatMap((id) => actorSubtree(scene, id).map((actor) => actor.id)));
  const actors = structuredClone(scene.actors.filter((actor) => ids.has(actor.id)));
  const references = new Set([...ids, ...actors.flatMap((actor) => actor.components.map((component) => component.id))]);
  for (const actor of actors) {
    if (actor.parentId && !ids.has(actor.parentId)) actor.parentId = null;
    actor.folderId = null;
    for (const component of actor.components) {
      const properties = component.properties;
      const keys = isFocusTargetClass(component.classId)
        ? ["focusUp", "focusDown", "focusLeft", "focusRight"]
        : component.classId === "CableComponent" ? ["targetActorId", "targetComponentId"]
        : component.classId === "PhysicsConstraintComponent" ? ["targetActorId"] : [];
      for (const key of keys) {
        const value = properties[key];
        if (typeof value === "string" && !references.has(value)) properties[key] = null;
      }
      if (component.classId === "RenderTargetCaptureComponent" && Array.isArray(properties.actorIds)) {
        properties.actorIds = properties.actorIds.filter((id) => typeof id === "string" && ids.has(id));
      }
    }
  }
  return actors;
}

/** Allocate identities against the destination while retaining copied connections. */
export function pasteSceneActors(scene: SerializedScene, actors: readonly SerializedActor[]): SerializedActor[] {
  return duplicateSceneActors(scene, actors.map((actor) => actor.id), actors);
}
