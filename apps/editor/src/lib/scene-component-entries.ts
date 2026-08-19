import type { SerializedScene } from "@babylonslate/core";
import type { SceneComponentPickerEntry } from "@babylonslate/editor-kit";

export function sceneComponentTitle(classId: string): string {
  return classId.replace(/Component$/, "");
}

export function sceneComponentEntries(
  scene: SerializedScene,
  allowedClassIds?: readonly string[],
): SceneComponentPickerEntry[] {
  const allowed =
    allowedClassIds && allowedClassIds.length > 0
      ? new Set(allowedClassIds)
      : null;
  const entries: SceneComponentPickerEntry[] = [];
  for (const actor of scene.actors) {
    for (const component of actor.components) {
      if (allowed && !allowed.has(component.classId)) continue;
      entries.push({
        actorId: actor.id,
        componentId: component.id,
        actorName: actor.name,
        componentTitle: sceneComponentTitle(component.classId),
        classId: component.classId,
      });
    }
  }
  return entries;
}

export function sceneComponentDisplayLabel(
  scene: SerializedScene,
  actorId: string | null,
  componentId: string | null,
): string | undefined {
  if (!actorId || !componentId) return undefined;
  const actor = scene.actors.find((entry) => entry.id === actorId);
  const component = actor?.components.find((entry) => entry.id === componentId);
  if (!actor || !component) return undefined;
  const title = sceneComponentTitle(component.classId);
  // Avoid "Camera Camera" when the actor is named after the component kind.
  if (actor.name === title) return actor.name;
  return `${actor.name} ${title}`;
}
