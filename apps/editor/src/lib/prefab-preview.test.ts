import { describe, expect, it } from "vitest";
import {
  createDefaultScene,
  createDefaultSceneSettings,
  createMeshComponent,
  createSkyboxComponent,
} from "@babylonslate/core";
import {
  PREFAB_ROOT_ID,
  defaultPrefabComponents,
  instantiatePrefabComponents,
  mergePrefabComponents,
  prefabComponentsFromGraph,
  prefabPreviewLoadKey,
  prefabSelectedActorIds,
  prefabSelectedIdFromPick,
  previewSceneFor,
  reparentPrefabComponents,
  componentSubtreeIds,
  applyPrefabComponentTransform,
  applyPrefabPivotDelta,
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

  it("merges parent components under local overrides without removing inherited", () => {
    const parentMesh = createMeshComponent("prefab-mesh", "box");
    const merged = mergePrefabComponents(
      [{ classId: "HeroBase", components: [parentMesh] }],
      [
        {
          ...parentMesh,
          properties: { ...parentMesh.properties, meshKind: "sphere" },
        },
        createMeshComponent("child-only", "cylinder"),
      ],
    );
    expect(merged).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "prefab-mesh",
          inheritedFrom: "HeroBase",
          properties: expect.objectContaining({ meshKind: "sphere" }),
        }),
        expect.objectContaining({
          id: "child-only",
        }),
      ]),
    );
    expect(merged.find((row) => row.id === "child-only")?.inheritedFrom).toBe(
      undefined,
    );
  });

  it("remaps prefab component ids onto a spawned actor", () => {
    const mesh = createMeshComponent("prefab-mesh", "sphere");
    expect(instantiatePrefabComponents([mesh], "actor-4")).toEqual([
      {
        id: "actor-4-MeshComponent-1",
        classId: "MeshComponent",
        properties: { ...mesh.properties },
        parentId: null,
        transform: mesh.transform,
      },
    ]);
  });

  it("copies authored local transforms onto spawned components", () => {
    const mesh = {
      ...createMeshComponent("prefab-mesh", "box"),
      transform: {
        position: [3, 0, 1] as [number, number, number],
        rotation: [0, 0, 0, 1] as [number, number, number, number],
        scale: [1, 1, 1] as [number, number, number],
      },
    };
    expect(instantiatePrefabComponents([mesh], "hero")[0]?.transform).toEqual(
      mesh.transform,
    );
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

  it("reparents collapsed selection roots when the drag id is selected", () => {
    const child = { ...createMeshComponent("d", "box"), parentId: "a" };
    expect(
      reparentPrefabComponents([a, b, c, child], "a", "c", ["a", "b", "d"]),
    ).toEqual([
      { ...a, parentId: "c" },
      { ...b, parentId: "c" },
      c,
      child,
    ]);
  });

  it("moves only the dragged component when it is not selected", () => {
    expect(reparentPrefabComponents([a, b, c], "a", "c", ["b"])).toEqual([
      { ...a, parentId: "c" },
      b,
      c,
    ]);
  });

  it("rejects the whole selection when any root would cycle", () => {
    const nested = { ...b, parentId: "a" };
    expect(
      reparentPrefabComponents([a, nested, c], "c", "b", ["a", "c"]),
    ).toEqual([a, nested, c]);
  });

  it("inserts before a sibling without changing parent", () => {
    expect(
      reparentPrefabComponents([a, b, c], "c", "a", [], "before"),
    ).toEqual([c, a, b]);
    const nested = { ...c, parentId: "b" };
    expect(
      reparentPrefabComponents([a, b, nested], "c", "a", [], "before"),
    ).toEqual([
      { ...nested, parentId: null },
      a,
      b,
    ]);
  });

  it("inserts after a sibling and treats Prefab Root as unparent", () => {
    expect(
      reparentPrefabComponents([a, b, c], "a", "b", [], "after"),
    ).toEqual([b, a, c]);
    const nested = { ...c, parentId: "a" };
    expect(
      reparentPrefabComponents([a, b, nested], "c", PREFAB_ROOT_ID, [], "before"),
    ).toEqual([a, b, { ...nested, parentId: null }]);
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
  it("builds a preview actor per component plus Prefab Root at the origin", () => {
    const mesh = {
      ...createMeshComponent("prefab-mesh", "box"),
      transform: {
        position: [2, 0, 0] as [number, number, number],
        rotation: [0, 0, 0, 1] as [number, number, number, number],
        scale: [1, 1, 1] as [number, number, number],
      },
    };
    const child = {
      ...createMeshComponent("child-mesh", "sphere"),
      parentId: "prefab-mesh",
    };
    const scene = previewSceneFor([mesh, child]);
    expect(scene.name).toBe("Prefab preview");
    expect(scene.actors.map((actor) => actor.id)).toEqual([
      PREFAB_ROOT_ID,
      "prefab-mesh",
      "child-mesh",
    ]);
    expect(scene.actors[0]?.transform.position).toEqual([0, 0, 0]);
    expect(scene.actors[0]?.parentId).toBeNull();
    expect(scene.actors[0]?.components[0]?.properties.meshKind).toBe("pivot");
    expect(scene.actors[1]?.transform).toEqual(mesh.transform);
    expect(scene.actors[1]?.parentId).toBeNull();
    expect(scene.actors[1]?.components).toHaveLength(1);
    expect(scene.actors[1]?.components[0]).toMatchObject({
      id: "prefab-mesh",
      classId: "MeshComponent",
      parentId: null,
      properties: { meshKind: "box" },
    });
    expect(scene.actors[1]?.components[0]?.transform).toEqual({
      position: [0, 0, 0],
      rotation: [0, 0, 0, 1],
      scale: [1, 1, 1],
    });
    expect(scene.actors[2]?.parentId).toBe("prefab-mesh");
    expect(scene.actors[2]?.transform).toEqual(child.transform);
  });

  it("keeps the near-black studio clear and omits the default 3D skybox", () => {
    const scene = previewSceneFor([createMeshComponent("prefab-mesh", "box")]);
    expect(scene.settings.environmentColor).toEqual(
      createDefaultSceneSettings().environmentColor,
    );
    expect(scene.settings.environmentColor).not.toEqual(
      createDefaultScene().settings.environmentColor,
    );
    const ids = scene.actors.map((actor) => actor.id);
    expect(ids).not.toContain("actor-skybox");
    expect(ids).not.toContain("actor-sun");
  });

  it("still previews an authored SkyboxComponent", () => {
    const sky = createSkyboxComponent("hero-sky");
    const scene = previewSceneFor([sky]);
    expect(scene.actors.map((actor) => actor.id)).toEqual([
      PREFAB_ROOT_ID,
      "hero-sky",
    ]);
    expect(scene.actors[1]?.components[0]?.classId).toBe("SkyboxComponent");
  });
});

describe("prefab viewport pick", () => {
  const componentIds = new Set(["prefab-mesh", "child-mesh"]);

  it("selects Prefab Root or a component on a hit and clears on a miss", () => {
    expect(prefabSelectedIdFromPick(PREFAB_ROOT_ID, componentIds)).toBe(
      PREFAB_ROOT_ID,
    );
    expect(prefabSelectedIdFromPick("prefab-mesh", componentIds)).toBe(
      "prefab-mesh",
    );
    expect(prefabSelectedIdFromPick("unknown", componentIds)).toBeNull();
    expect(prefabSelectedIdFromPick(null, componentIds)).toBeNull();
  });

  it("attaches the gizmo to the selected preview actor", () => {
    expect(prefabSelectedActorIds(null)).toEqual([]);
    expect(prefabSelectedActorIds(PREFAB_ROOT_ID)).toEqual([PREFAB_ROOT_ID]);
    expect(prefabSelectedActorIds("prefab-mesh")).toEqual(["prefab-mesh"]);
  });
});

describe("applyPrefabComponentTransform", () => {
  it("writes a local transform onto the matching component", () => {
    const mesh = createMeshComponent("prefab-mesh", "box");
    const next = applyPrefabComponentTransform(mesh ? [mesh] : [], "prefab-mesh", {
      position: [1, 2, 3],
      rotation: [0, 0, 0, 1],
      scale: [2, 2, 2],
    });
    expect(next[0]?.transform).toEqual({
      position: [1, 2, 3],
      rotation: [0, 0, 0, 1],
      scale: [2, 2, 2],
    });
  });
});

describe("applyPrefabPivotDelta", () => {
  it("offsets root-level locals by the inverse helper translation and leaves nested locals", () => {
    const root = {
      ...createMeshComponent("root", "box"),
      transform: {
        position: [2, 0, 0] as [number, number, number],
        rotation: [0, 0, 0, 1] as [number, number, number, number],
        scale: [1, 1, 1] as [number, number, number],
      },
    };
    const nested = {
      ...createMeshComponent("child", "sphere"),
      parentId: "root",
      transform: {
        position: [4, 1, 0] as [number, number, number],
        rotation: [0, 0, 0, 1] as [number, number, number, number],
        scale: [1, 1, 1] as [number, number, number],
      },
    };
    const next = applyPrefabPivotDelta([root, nested], {
      position: [1, 0, 0],
      rotation: [0, 0, 0, 1],
      scale: [1, 1, 1],
    });
    expect(next[0]?.transform?.position).toEqual([1, 0, 0]);
    expect(next[1]?.transform?.position).toEqual([4, 1, 0]);
  });

  it("returns the same list when the helper is identity", () => {
    const mesh = createMeshComponent("prefab-mesh", "box");
    expect(
      applyPrefabPivotDelta([mesh], {
        position: [0, 0, 0],
        rotation: [0, 0, 0, 1],
        scale: [1, 1, 1],
      }),
    ).toEqual([mesh]);
  });
});

describe("prefabPreviewLoadKey", () => {
  it("stays stable when the component list is cloned with the same payload", () => {
    const mesh = createMeshComponent("prefab-material", "box");
    mesh.properties.materialGuid = "mat-rock";
    const clone = {
      ...mesh,
      properties: { ...mesh.properties },
      transform: mesh.transform
        ? {
            position: [...mesh.transform.position] as [number, number, number],
            rotation: [...mesh.transform.rotation] as [
              number,
              number,
              number,
              number,
            ],
            scale: [...mesh.transform.scale] as [number, number, number],
          }
        : undefined,
    };
    expect(prefabPreviewLoadKey([clone])).toBe(prefabPreviewLoadKey([mesh]));
  });

  it("changes when a MeshComponent materialGuid changes", () => {
    const mesh = createMeshComponent("prefab-material", "box");
    const before = prefabPreviewLoadKey([mesh]);
    mesh.properties.materialGuid = "mat-rock";
    expect(prefabPreviewLoadKey([mesh])).not.toBe(before);
  });
});
