import {
  editorSceneToSceneLayer,
  type SerializedScene,
} from "@babylonslate/core";

/** Persist an open tab payload. SceneLayer tabs host a 2D SerializedScene. */
export function persistableDocumentContent(
  kind: string,
  content: unknown,
): unknown {
  if (kind === "scene-layer" && content && typeof content === "object") {
    return editorSceneToSceneLayer(content as SerializedScene);
  }
  return content;
}
