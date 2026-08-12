import { describe, expect, it } from "vitest";
import { createMeshComponent } from "@babylonslate/core";
import {
  PREFAB_ROOT_ID,
  previewSceneFor,
  reorderPrefabComponents,
} from "./prefab-preview";

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

describe("reorderPrefabComponents", () => {
  const a = createMeshComponent("a", "box");
  const b = createMeshComponent("b", "sphere");
  const c = createMeshComponent("c", "cylinder");

  it("moves a component after the drop target", () => {
    expect(reorderPrefabComponents([a, b, c], "a", "c").map((row) => row.id)).toEqual(
      ["b", "c", "a"],
    );
  });

  it("moves a component to the start when dropped on the prefab root", () => {
    expect(
      reorderPrefabComponents([a, b, c], "c", PREFAB_ROOT_ID).map((row) => row.id),
    ).toEqual(["c", "a", "b"]);
  });
});

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
