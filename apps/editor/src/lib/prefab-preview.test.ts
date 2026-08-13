import { describe, expect, it } from "vitest";
import { createMeshComponent } from "@babylonslate/core";
import {
  PREFAB_ROOT_ID,
  defaultPrefabComponents,
  instantiatePrefabComponents,
  prefabComponentsFromGraph,
  previewSceneFor,
  reorderPrefabComponents,
} from "./prefab-preview";

describe("prefabComponentsFromGraph", () => {
  it("uses authored components including an empty list", () => {
    expect(prefabComponentsFromGraph({ components: [] })).toEqual([]);
    const mesh = createMeshComponent("hero-mesh", "box");
    expect(prefabComponentsFromGraph({ components: [mesh] })).toEqual([mesh]);
  });

  it("falls back to the default mesh when the class has no prefab field", () => {
    expect(prefabComponentsFromGraph({ nodes: [], edges: [] })).toEqual(
      defaultPrefabComponents(),
    );
    expect(prefabComponentsFromGraph(null)).toEqual(defaultPrefabComponents());
  });

  it("remaps prefab component ids onto a spawned actor", () => {
    const mesh = createMeshComponent("prefab-mesh", "sphere");
    expect(instantiatePrefabComponents([mesh], "actor-4")).toEqual([
      {
        id: "actor-4-MeshComponent-1",
        classId: "MeshComponent",
        properties: { ...mesh.properties },
      },
    ]);
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
