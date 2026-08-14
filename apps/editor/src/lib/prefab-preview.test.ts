import { describe, expect, it } from "vitest";
import { createMeshComponent } from "@babylonslate/core";
import {
  PREFAB_ROOT_ID,
  defaultPrefabComponents,
  instantiatePrefabComponents,
  prefabComponentsFromGraph,
  prefabSelectedActorIds,
  prefabSelectedIdFromPick,
  previewSceneFor,
  reparentPrefabComponents,
  componentSubtreeIds,
} from "./prefab-preview";

describe("prefabComponentsFromGraph", () => {
  it("uses authored components including an empty list", () => {
    expect(prefabComponentsFromGraph({ components: [] })).toEqual([]);
    const mesh = createMeshComponent("hero-mesh", "box");
    expect(prefabComponentsFromGraph({ components: [mesh] })).toEqual([mesh]);
  });

  it("falls back to the default mesh when the class has no prefab field", () => {
    expect(prefabComponentsFromGraph({})).toEqual(defaultPrefabComponents());
    expect(prefabComponentsFromGraph(null)).toEqual(defaultPrefabComponents());
  });

  it("remaps prefab component ids onto a spawned actor", () => {
    const mesh = createMeshComponent("prefab-mesh", "sphere");
    expect(instantiatePrefabComponents([mesh], "actor-4")).toEqual([
      {
        id: "actor-4-MeshComponent-1",
        classId: "MeshComponent",
        properties: { ...mesh.properties },
        parentId: null,
      },
    ]);
  });

  it("remaps nested parentIds onto the spawned actor", () => {
    const root = createMeshComponent("root", "box");
    const child = {
      ...createMeshComponent("child", "sphere"),
      parentId: "root",
    };
    const spawned = instantiatePrefabComponents([root, child], "hero");
    expect(spawned[1]?.parentId).toBe(spawned[0]?.id);
  });
});

describe("reparentPrefabComponents", () => {
  const a = createMeshComponent("a", "box");
  const b = createMeshComponent("b", "sphere");
  const c = createMeshComponent("c", "cylinder");

  it("nests a component under the drop target", () => {
    expect(reparentPrefabComponents([a, b, c], "a", "c")).toEqual([
      { ...a, parentId: "c" },
      b,
      c,
    ]);
  });

  it("unparents when dropped on the prefab root", () => {
    const nested = { ...c, parentId: "a" };
    expect(
      reparentPrefabComponents([a, b, nested], "c", PREFAB_ROOT_ID),
    ).toEqual([a, b, { ...nested, parentId: null }]);
  });

  it("rejects a cycle", () => {
    const child = { ...b, parentId: "a" };
    expect(reparentPrefabComponents([a, child], "a", "b")).toEqual([a, child]);
  });
});

describe("componentSubtreeIds", () => {
  it("includes nested children", () => {
    const root = createMeshComponent("root", "box");
    const child = {
      ...createMeshComponent("child", "sphere"),
      parentId: "root",
    };
    expect([...componentSubtreeIds([root, child], "root")].sort()).toEqual([
      "child",
      "root",
    ]);
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

describe("prefab viewport pick", () => {
  it("selects Prefab Root on a hit and clears on a miss", () => {
    expect(prefabSelectedIdFromPick(PREFAB_ROOT_ID)).toBe(PREFAB_ROOT_ID);
    expect(prefabSelectedIdFromPick(null)).toBeNull();
  });

  it("attaches the gizmo only while something is selected", () => {
    expect(prefabSelectedActorIds(null)).toEqual([]);
    expect(prefabSelectedActorIds(PREFAB_ROOT_ID)).toEqual([PREFAB_ROOT_ID]);
    expect(prefabSelectedActorIds("prefab-mesh")).toEqual([PREFAB_ROOT_ID]);
  });
});
