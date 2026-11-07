import { actorCameraComponent, type SerializedScene } from "@haptic/core";
import type { SceneActorPickerEntry } from "@haptic/editor-kit";
import { sceneActorDisplayNames } from "./scene-actor-names";

/**
 * The Default Camera picker's rows: every placed actor, those with a Camera
 * component first under Camera Actors, then the rest under Other Actors (Play
 * stays on the Layer Camera for one of those).
 */
export function sceneDefaultCameraEntries(scene: SerializedScene): SceneActorPickerEntry[] {
  const names = sceneActorDisplayNames(scene);
  const entry = (actor: SerializedScene["actors"][number], group: string): SceneActorPickerEntry =>
    ({ actorId: actor.id, actorName: names.get(actor.id)!, classId: actor.classId, group });
  return [
    ...scene.actors.filter((actor) => actorCameraComponent(actor)).map((actor) => entry(actor, "Camera Actors")),
    ...scene.actors.filter((actor) => !actorCameraComponent(actor)).map((actor) => entry(actor, "Other Actors")),
  ];
}

/** A placed actor's name as pickers show it, told apart from actors that share it. */
export function sceneActorDisplayLabel(scene: SerializedScene, actorId: string | null): string | undefined {
  if (!actorId || !scene.actors.some((actor) => actor.id === actorId)) return undefined;
  return sceneActorDisplayNames(scene).get(actorId);
}
