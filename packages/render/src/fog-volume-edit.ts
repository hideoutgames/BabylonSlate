import { FOG_VOLUME_CLASS_ID, type SerializedScene } from "@babylonslate/core";

/** Fog properties bind live; EditorSceneSync still reconciles shape/size guides. */
export function isFogVolumeOnlySceneEdit(previous: SerializedScene | null, next: SerializedScene): boolean {
  if (!previous || previous === next) return false;
  const otherState = (scene: SerializedScene) => ({
    ...scene,
    actors: scene.actors.map((actor) => ({
      ...actor,
      components: actor.components.map((component) => component.classId === FOG_VOLUME_CLASS_ID
        ? { ...component, properties: {} } : component),
    })),
  });
  return JSON.stringify(otherState(previous)) === JSON.stringify(otherState(next));
}
