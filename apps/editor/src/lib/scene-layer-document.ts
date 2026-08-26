import {
  editorSceneToSceneLayer,
  normalizeSceneLayer,
  sceneLayerToEditorScene,
  type SerializedScene,
} from "@babylonslate/core";

/** Open tab payload. SceneLayer tabs host a locked 2D SerializedScene. */
export function editorTabContentForKind(
  kind: string,
  content: unknown,
): unknown {
  if (kind === "scene-layer") {
    return sceneLayerToEditorScene(normalizeSceneLayer(content));
  }
  return content;
}

/** Persist an open tab payload. SceneLayer tabs host a 2D SerializedScene. */
export function persistableDocumentContent(
  kind: string,
  content: unknown,
): unknown {
  if (
    kind === "scene-layer" &&
    content &&
    typeof content === "object" &&
    "viewportMode" in content
  ) {
    return editorSceneToSceneLayer(content as SerializedScene);
  }
  return content;
}
