import type { Mesh } from "@babylonjs/core";
import type { SerializedScene, SerializedTransform } from "@babylonslate/core";
import type { MeshAssetContext } from "./mesh-assets";

export type EditorDropTransform = SerializedTransform & { actorId: string };

export function calculateEditorDropTransforms(_options: {
  sceneData: SerializedScene;
  selectedActorIds: readonly string[];
  meshForActor: (id: string) => Mesh | null;
  assets?: MeshAssetContext;
}): EditorDropTransform[] {
  void _options;
  return [];
}
