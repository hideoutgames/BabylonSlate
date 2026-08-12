import { describe, expect, it } from "vitest";
import { createMeshComponent } from "@babylonslate/core";
import { previewSceneFor } from "./prefab-preview";

describe("previewSceneFor", () => {
  it("builds a one-actor preview scene from prefab components", () => {
    const mesh = createMeshComponent("prefab-mesh", "box");
    const scene = previewSceneFor([mesh]);
    expect(scene.name).toBe("Prefab preview");
    expect(scene.actors).toHaveLength(1);
    expect(scene.actors[0]?.id).toBe("prefab-root");
    expect(scene.actors[0]?.components).toEqual([mesh]);
  });
});
