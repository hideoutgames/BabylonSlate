import { describe, expect, it } from "vitest";
import { Mesh, Vector3, VertexBuffer } from "@babylonjs/core";
import {
  EditorSceneSync,
  applySceneToBabylonScene,
  createTestEngine,
  editorComponentMeshName,
  editorMeshName,
} from "@babylonslate/render";
import {
  createDefaultScene,
  createDefaultSceneSettings,
  createMeshComponent,
  createSceneStreamingActor,
  createSkyboxComponent,
  identitySerializedTransform,
  type SerializedComponent,
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
  authoredTransformFromPreview,
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
        sourceId: "prefab-mesh",
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
  it("renders one camera-facing streaming label attached to its preview origin", () => {
    const components = createSceneStreamingActor("stream", "target-scene", "A").components;
    const streaming = components[0]!;
    const text = components[1]!;
    streaming.transform!.position = [4, 0, 0];
    text.properties.text = "Stale authored label";
    const { scene, engine } = createTestEngine();
    try {
      applySceneToBabylonScene(scene, previewSceneFor(components));
      const label = scene.getMeshByName(editorMeshName(text.id))!;
      expect(label).not.toBeNull();
      expect(label.billboardMode).toBe(Mesh.BILLBOARDMODE_ALL);
      expect(label.parent).toBe(scene.getMeshByName(editorMeshName(streaming.id)));
      label.computeWorldMatrix(true);
      expect(label.absolutePosition.x).toBeCloseTo(4);
      expect(label.absolutePosition.y).toBeCloseTo(0.8);
      expect(scene.getMeshByName(editorComponentMeshName(streaming.id, `${streaming.id}:label`))).toBeNull();
      const width = label.getBoundingInfo().boundingBox.extendSize.x;

      streaming.properties.sceneName = "BBBBBBBB";
      applySceneToBabylonScene(scene, previewSceneFor(components));
      expect(scene.getMeshByName(editorMeshName(text.id))!.getBoundingInfo().boundingBox.extendSize.x).toBeGreaterThan(width);
      expect(text.properties.text).toBe("Stale authored label");
    } finally {
      scene.dispose();
      engine.dispose();
    }
  });

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

  it("places spring arm children at the socket and maps gizmo commits back to local space", () => {
    const arm = {
      id: "arm",
      classId: "SpringArmComponent",
      properties: { armLength: 5 },
      parentId: null,
    };
    const camera = {
      id: "cam",
      classId: "CameraComponent",
      properties: {},
      parentId: "arm",
      transform: {
        position: [0, 1, 0] as [number, number, number],
        rotation: [0, 0, 0, 1] as [number, number, number, number],
        scale: [1, 1, 1] as [number, number, number],
      },
    };
    const components = [arm, camera];
    const preview = previewSceneFor(components).actors.find((actor) => actor.id === "cam")!;
    expect(preview.transform.position).toEqual([0, 1, -5]);
    expect(authoredTransformFromPreview(components, "cam", preview.transform)).toEqual(camera.transform);
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

  it("attaches a Class cable's end at its Target Component in the editor preview", () => {
    const mount = {
      ...createMeshComponent("mount", "box"),
      transform: { ...identitySerializedTransform(), position: [1, 0, 0] as [number, number, number] },
    };
    const hook = {
      ...createMeshComponent("hook", "sphere"),
      parentId: "mount",
      transform: { ...identitySerializedTransform(), position: [2, -1, 0] as [number, number, number] },
    };
    // Picking a Target Component resets End Position to the target's origin.
    const cable: SerializedComponent = {
      id: "cable",
      classId: "CableComponent",
      parentId: null,
      transform: identitySerializedTransform(),
      properties: { targetComponentId: "hook", endPosition: [0, 0, 0], cableLength: 5, numSegments: 4, numSides: 4 },
    };
    const { scene, engine } = createTestEngine();
    const sync = new EditorSceneSync(scene);
    try {
      sync.apply(previewSceneFor([mount, hook, cable]));
      const mesh = scene.getMeshByName(editorComponentMeshName("cable", "cable"))!;
      const positions = mesh.getVerticesData(VertexBuffer.PositionKind)!;
      const world = mesh.computeWorldMatrix(true);
      // Mean of the last ring's four distinct vertices: the simulated end particle.
      const end = Vector3.Zero();
      for (let side = 0; side < 4; side++) end.addInPlace(Vector3.FromArray(positions, (4 * 5 + side) * 3));
      Vector3.TransformCoordinatesToRef(end.scaleInPlace(0.25), world, end);
      expect(end.x).toBeCloseTo(3, 4);
      expect(end.y).toBeCloseTo(-1, 4);
      expect(end.z).toBeCloseTo(0, 4);
      expect(cable.properties.targetComponentId).toBe("hook");
    } finally {
      sync.dispose();
      scene.dispose();
      engine.dispose();
    }
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
