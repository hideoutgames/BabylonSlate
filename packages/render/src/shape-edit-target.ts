import { waterKindForClass, type SerializedScene } from "@babylonslate/core";

/** Explicit component selection wins over the actor's first editable shape. */
export function selectedShapeComponent(scene: SerializedScene | null, actorIds: readonly string[], componentIds: readonly string[]) {
  if (actorIds.length !== 1 || componentIds.length > 1) return null;
  const actor = scene?.actors.find((entry) => entry.id === actorIds[0]);
  if (!actor || actor.locked) return null;
  const component = actor.components.find((entry) =>
    (componentIds.length === 0 || componentIds.includes(entry.id)) &&
    (entry.classId === "SplineComponent" || waterKindForClass(entry.classId) !== null),
  );
  return component ? { actor, component } : null;
}
