import { describe, expect, it } from "vitest";
import {
  createDefaultScene,
  createDefaultSceneLayer,
  editorSceneToSceneLayer,
  sceneLayerToEditorScene,
} from "@babylonslate/core";
import {
  editorTabContentForKind,
  persistableDocumentContent,
} from "./scene-layer-document";

describe("persistableDocumentContent", () => {
  it("converts an open SceneLayer editor scene back to a SceneLayer payload", () => {
    const layer = createDefaultSceneLayer();
    layer.name = "HUD";
    const editor = sceneLayerToEditorScene(layer);
    editor.actors = createDefaultScene().actors;
    const saved = persistableDocumentContent("scene-layer", editor);
    expect(saved).toEqual(editorSceneToSceneLayer(editor));
    expect("viewportMode" in (saved as object)).toBe(false);
  });

  it("leaves world scenes unchanged", () => {
    const scene = createDefaultScene();
    expect(persistableDocumentContent("scene", scene)).toBe(scene);
  });

  it("leaves an already-normalized SceneLayer payload unchanged", () => {
    const layer = createDefaultSceneLayer();
    expect(persistableDocumentContent("scene-layer", layer)).toBe(layer);
  });

  it("converts a disk SceneLayer payload into a locked 2D editor scene", () => {
    const layer = createDefaultSceneLayer();
    layer.name = "HUD";
    const opened = editorTabContentForKind("scene-layer", layer);
    expect(opened).toEqual(sceneLayerToEditorScene(layer));
    expect((opened as { viewportMode: string }).viewportMode).toBe("2d");
    expect(editorTabContentForKind("scene", createDefaultScene())).toEqual(
      createDefaultScene(),
    );
  });
});
