import { FOG_VOLUME_CLASS_ID, type SerializedScene } from "@haptic/core";
import { isComponentPropertyOnlySceneEdit } from "./scene-transform-edit";

/** Fog properties bind live; EditorSceneSync still reconciles shape/size guides. */
export function isFogVolumeOnlySceneEdit(previous: SerializedScene | null, next: SerializedScene): boolean {
  return isComponentPropertyOnlySceneEdit(previous, next, FOG_VOLUME_CLASS_ID);
}
