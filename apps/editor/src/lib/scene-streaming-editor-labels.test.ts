import { describe, expect, it } from "vitest";
import { createActor, createDefaultScene, createSceneStreamingActor, createText3DComponent } from "@babylonslate/core";
import { sceneStreamingEditorComponents, sceneStreamingEditorScene } from "./scene-streaming-editor-labels";

describe("streaming editor scene names", () => {
  it("shows renamed asset headers in scene and prefab markers without persisting edits or altering hierarchy", () => {
    const actor = createSceneStreamingActor("stream", "target", "Before");
    actor.components.push(createText3DComponent("unrelated"));
    const scene = createDefaultScene();
    scene.actors = [actor, createActor("other", "Other")];
    const original = structuredClone(scene);
    const renamed = sceneStreamingEditorScene(scene, () => "After");
    expect(renamed.actors[0]?.components[0]?.properties.sceneName).toBe("After");
    expect(renamed.actors[0]?.components[1]?.properties.text).toBe("After");
    expect(renamed.actors[0]?.components[1]?.parentId).toBe("stream-scene-streaming");
    expect(renamed.actors[0]?.components[1]?.transform).toBe(actor.components[1]?.transform);
    expect(renamed.actors[0]?.components[2]).toBe(actor.components[2]);
    expect(renamed.actors[1]).toBe(scene.actors[1]);
    expect(sceneStreamingEditorComponents(actor.components, () => "After")).toBe(renamed.actors[0]?.components);
    expect(scene).toEqual(original);
    expect(sceneStreamingEditorScene(scene, () => "After")).toBe(renamed);
    expect(sceneStreamingEditorScene(scene, () => undefined)).toBe(scene);
    expect(sceneStreamingEditorScene(scene, () => "After Again").actors[0]?.components[1]?.properties.text).toBe("After Again");
  });
});
