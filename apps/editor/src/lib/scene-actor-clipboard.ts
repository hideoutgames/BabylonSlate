import { actorSubtree, isFocusTargetClass, remapSceneStreamingReferences, type SerializedActor, type SerializedScene } from "@babylonslate/core";
import { duplicateSceneActors } from "./place-actors";
import { authoredActorWorldTransform } from "@babylonslate/render";

/** Component ids can repeat across actors; local maps resolve those separately. */
function sceneReferenceMap(
  actors: ReadonlyMap<string, string | null>,
  components: Iterable<ReadonlyMap<string, string | null>>,
): Map<string, string | null> {
  const unique = new Map<string, string | null>();
  const repeated = new Set<string>();
  for (const ids of components) {
    for (const [id, target] of ids) {
      if (unique.has(id)) repeated.add(id);
      else unique.set(id, target);
    }
  }
  for (const id of repeated) unique.delete(id);
  return new Map([...unique, ...actors]);
}

/** Snapshot actor subtrees without references to objects outside the copy. */
export function copySceneActors(scene: SerializedScene, selectedIds: readonly string[]): SerializedActor[] {
  const ids = new Set(selectedIds.flatMap((id) => actorSubtree(scene, id).map((actor) => actor.id)));
  const actors = structuredClone(scene.actors.filter((actor) => ids.has(actor.id)));
  const references = new Set([...ids, ...actors.flatMap((actor) => actor.components.map((component) => component.id))]);
  const actorReferences = new Map<string, string | null>(scene.actors.map((actor) => [actor.id, ids.has(actor.id) ? actor.id : null]));
  const liveReferences = sceneReferenceMap(actorReferences, scene.actors.map((actor) =>
    new Map(actor.components.map((component) => [component.id, ids.has(actor.id) ? component.id : null])),
  ));
  for (const actor of actors) {
    if (actor.parentId && !ids.has(actor.parentId)) {
      actor.transform = authoredActorWorldTransform(scene.actors, actor);
      actor.parentId = null;
    }
    actor.folderId = null;
    const componentReferences = new Map(actor.components.map((component) => [component.id, component.id]));
    if (actor.properties) actor.properties = remapSceneStreamingReferences(actor.properties, liveReferences, componentReferences) as Record<string, unknown>;
    for (const component of actor.components) {
      const originalProperties = component.properties;
      const properties = remapSceneStreamingReferences(originalProperties, liveReferences, componentReferences) as Record<string, unknown>;
      component.properties = properties;
      if (component.classId === "CableComponent" && typeof originalProperties.targetActorId === "string" && !ids.has(originalProperties.targetActorId)) {
        properties.targetActorId = null;
        properties.targetComponentId = null;
      }
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
  const copies = duplicateSceneActors(scene, actors.map((actor) => actor.id), actors);
  const actorIds = new Map(actors.map((actor, index) => [actor.id, copies[index]!.id]));
  const componentIds = new Map(actors.map((actor, index) => [actor.id,
    new Map(actor.components.map((component, componentIndex) => [component.id, copies[index]!.components[componentIndex]!.id])),
  ]));
  const liveReferences = sceneReferenceMap(actorIds, componentIds.values());
  return copies.map((copy, index) => {
    const source = actors[index]!;
    const ownComponents = componentIds.get(source.id)!;
    return {
      ...copy,
      ...(source.properties ? { properties: remapSceneStreamingReferences(source.properties, liveReferences, ownComponents) as Record<string, unknown> } : {}),
      components: copy.components.map((component, componentIndex) => {
        const original = source.components[componentIndex]!;
        const target = original.properties.targetActorId;
        const references = component.classId === "CableComponent" && typeof target === "string"
          ? componentIds.get(target) ?? ownComponents : ownComponents;
        const properties = remapSceneStreamingReferences(original.properties, liveReferences, references) as Record<string, unknown>;
        // Focus neighbors use raw ids rather than typed reference objects.
        if (isFocusTargetClass(component.classId)) {
          for (const key of ["focusUp", "focusDown", "focusLeft", "focusRight"]) {
            if (key in component.properties) properties[key] = component.properties[key];
          }
        }
        return { ...component, properties };
      }),
    };
  });
}
