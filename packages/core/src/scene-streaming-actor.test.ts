import { describe, expect, it } from "vitest";
import { createSceneStreamingActor, setSceneStreamingTarget } from "./scene-streaming-actor";
import { createText3DComponent } from "./text3d";

describe("scene streaming target authoring", () => {
  it("retargets and clears only the attached editor name while preserving unrelated text and origin", () => {
    const actor = createSceneStreamingActor("stream", "cave", "Cave");
    const origin = actor.components[0]!.transform;
    const unrelated = createText3DComponent("dialogue");
    const before = [...actor.components, unrelated];
    const after = setSceneStreamingTarget(before, "stream-scene-streaming", "forest", "Forest");
    expect(after[0]?.properties).toEqual({ sceneGuid: "forest", sceneName: "Forest" });
    expect(after[0]?.transform).toBe(origin);
    expect(after[1]?.properties.text).toBe("Forest");
    expect(after[2]).toBe(unrelated);
    expect(before[0]?.properties.sceneGuid).toBe("cave");
    const cleared = setSceneStreamingTarget(after, "stream-scene-streaming", null, "Forest");
    expect(cleared[0]?.properties).toEqual({ sceneGuid: "", sceneName: "" });
    expect(cleared[1]?.properties.text).toBe("No Scene");
  });
});
