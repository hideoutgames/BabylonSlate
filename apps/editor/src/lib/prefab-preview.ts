import {
  createActor,
  createDefaultScene,
  createMeshComponent,
  type SerializedComponent,
  type SerializedScene,
} from "@babylonslate/core";

export const PREFAB_ROOT_ID = "prefab-root";

export function defaultPrefabComponents(): SerializedComponent[] {
  return [createMeshComponent("prefab-mesh", "box")];
}

/** Preview scene holding the prefab's components on a single actor. */
export function previewSceneFor(
  components: SerializedComponent[],
): SerializedScene {
  return {
    ...createDefaultScene(),
    name: "Prefab preview",
    actors: [createActor(PREFAB_ROOT_ID, "Prefab", { components })],
  };
}
