import { describe, expect, it } from "vitest";
import {
  createActor,
  createDefaultScene,
  createMeshComponent,
  identitySerializedTransform,
} from "@babylonslate/core";
import {
  PREFAB_PARENT_OVERRIDE,
  PREFAB_TRANSFORM_OVERRIDE,
  copyInstanceLinkage,
  descendantClassIds,
  mergedPrefabComponentsForClass,
  stampUserComponentOverrides,
  syncActorComponentsFromPrefab,
  syncSceneActorsFromPrefabs,
} from "./prefab-instance-sync";
import { instantiatePrefabComponents } from "./prefab-preview";

const identity = identitySerializedTransform();

describe("syncActorComponentsFromPrefab", () => {
  it("pushes prefab property changes unless the instance overrode them", () => {
    const prefab = [
      {
        ...createMeshComponent("prefab-mesh", "box"),
        properties: {
          ...createMeshComponent("prefab-mesh", "box").properties,
          meshKind: "sphere",
          materialGuid: "mat-2",
        },
      },
    ];
    const actor = createActor("hero", "Hero", {
      classId: "Hero",
      components: [
        {
          id: "hero-MeshComponent-1",
          classId: "MeshComponent",
          properties: {
            meshKind: "cylinder",
            assetGuid: null,
            materialGuid: "mat-1",
          },
          parentId: null,
          sourceId: "prefab-mesh",
          overrideKeys: ["meshKind"],
          transform: identity,
        },
      ],
    });
    const synced = syncActorComponentsFromPrefab(actor, prefab);
    expect(synced[0]?.properties.meshKind).toBe("cylinder");
    expect(synced[0]?.properties.materialGuid).toBe("mat-2");
  });

  it("adds new prefab components and keeps instance-only extras", () => {
    const prefab = [
      createMeshComponent("prefab-mesh", "box"),
      createMeshComponent("prefab-light", "sphere"),
    ];
    prefab[1]!.classId = "LightComponent";
    const extra = {
      id: "hero-extra",
      classId: "CameraComponent",
      properties: {},
      parentId: null,
      transform: identity,
    };
    const actor = createActor("hero", "Hero", {
      components: [
        {
          ...instantiatePrefabComponents([prefab[0]!], "hero")[0]!,
        },
        extra,
      ],
    });
    const synced = syncActorComponentsFromPrefab(actor, prefab);
    expect(synced.map((row) => row.sourceId)).toEqual([
      "prefab-mesh",
      "prefab-light",
      undefined,
    ]);
    expect(synced.some((row) => row.id === "hero-extra")).toBe(true);
  });

  it("removes instance rows whose prefab source was deleted", () => {
    const actor = createActor("hero", "Hero", {
      components: [
        {
          id: "gone",
          classId: "MeshComponent",
          properties: { meshKind: "box" },
          parentId: null,
          sourceId: "prefab-mesh",
          overrideKeys: ["meshKind"],
          transform: identity,
        },
        {
          id: "keep",
          classId: "CameraComponent",
          properties: {},
          parentId: null,
          transform: identity,
        },
      ],
    });
    const synced = syncActorComponentsFromPrefab(actor, []);
    expect(synced).toEqual([
      expect.objectContaining({ id: "keep", classId: "CameraComponent" }),
    ]);
  });

  it("remaps nested parentIds onto instance ids", () => {
    const root = createMeshComponent("root", "box");
    const child = {
      ...createMeshComponent("child", "sphere"),
      parentId: "root",
    };
    const actor = createActor("hero", "Hero", { components: [] });
    const synced = syncActorComponentsFromPrefab(actor, [root, child]);
    expect(synced[1]?.parentId).toBe(synced[0]?.id);
    expect(synced[0]?.sourceId).toBe("root");
  });

  it("keeps an instance parentId override", () => {
    const root = createMeshComponent("root", "box");
    const child = {
      ...createMeshComponent("child", "sphere"),
      parentId: "root",
    };
    const actor = createActor("hero", "Hero", {
      components: [
        {
          id: "hero-MeshComponent-1",
          classId: "MeshComponent",
          properties: root.properties,
          parentId: null,
          sourceId: "root",
          transform: identity,
        },
        {
          id: "hero-MeshComponent-2",
          classId: "MeshComponent",
          properties: child.properties,
          parentId: null,
          sourceId: "child",
          overrideKeys: [PREFAB_PARENT_OVERRIDE],
          transform: identity,
        },
      ],
    });
    const synced = syncActorComponentsFromPrefab(actor, [root, child]);
    expect(synced[1]?.parentId).toBeNull();
  });

  it("migrates copy-once rows by classId order and treats differing keys as overrides", () => {
    const prefab = [createMeshComponent("prefab-mesh", "sphere")];
    const actor = createActor("hero", "Hero", {
      components: [
        {
          id: "hero-MeshComponent-1",
          classId: "MeshComponent",
          properties: {
            ...createMeshComponent("x", "box").properties,
            meshKind: "box",
          },
          parentId: null,
          transform: identity,
        },
      ],
    });
    const synced = syncActorComponentsFromPrefab(actor, prefab);
    expect(synced[0]?.sourceId).toBe("prefab-mesh");
    expect(synced[0]?.overrideKeys).toContain("meshKind");
    expect(synced[0]?.properties.meshKind).toBe("box");
  });
});

describe("syncSceneActorsFromPrefabs", () => {
  it("updates matching classId actors and leaves others alone", () => {
    const scene = createDefaultScene();
    scene.actors = [
      createActor("hero", "Hero", {
        classId: "Hero",
        components: instantiatePrefabComponents(
          [createMeshComponent("prefab-mesh", "box")],
          "hero",
        ),
      }),
      createActor("pawn", "Pawn", {
        classId: "Pawn",
        components: instantiatePrefabComponents(
          [createMeshComponent("prefab-mesh", "box")],
          "pawn",
        ),
      }),
    ];
    const next = syncSceneActorsFromPrefabs(scene, {
      Hero: [createMeshComponent("prefab-mesh", "sphere")],
    });
    expect(next.actors[0]?.components[0]?.properties.meshKind).toBe("sphere");
    expect(next.actors[1]?.components[0]?.properties.meshKind).toBe("box");
  });
});

describe("mergedPrefabComponentsForClass", () => {
  it("merges parent prefab components under local rows", () => {
    const merged = mergedPrefabComponentsForClass({
      classId: "Hero",
      parentOf: (id) => (id === "Hero" ? "Pawn" : null),
      graphs: {
        Pawn: { components: [createMeshComponent("prefab-mesh", "box")] },
        Hero: {
          components: [
            {
              ...createMeshComponent("prefab-mesh", "box"),
              properties: {
                ...createMeshComponent("prefab-mesh", "box").properties,
                meshKind: "sphere",
              },
            },
          ],
        },
      },
    });
    expect(merged?.[0]).toMatchObject({
      id: "prefab-mesh",
      properties: expect.objectContaining({ meshKind: "sphere" }),
    });
  });

  it("returns null when the class has no authored prefab", () => {
    expect(
      mergedPrefabComponentsForClass({
        classId: "Actor",
        parentOf: () => null,
        graphs: {},
      }),
    ).toBeNull();
  });
});

describe("descendantClassIds", () => {
  it("includes the ancestor and children", () => {
    expect(
      descendantClassIds("Pawn", ["Actor", "Pawn", "Hero"], (id) =>
        id === "Hero" ? "Pawn" : id === "Pawn" ? "Actor" : null,
      ),
    ).toEqual(["Pawn", "Hero"]);
  });
});

describe("stampUserComponentOverrides", () => {
  it("records property, transform, and parent overrides on sourced components", () => {
    const previous = createDefaultScene();
    previous.actors = [
      createActor("hero", "Hero", {
        components: [
          {
            id: "c1",
            classId: "MeshComponent",
            properties: { meshKind: "box" },
            parentId: null,
            sourceId: "prefab-mesh",
            transform: identity,
          },
        ],
      }),
    ];
    const next = structuredClone(previous);
    next.actors[0]!.components[0]!.properties.meshKind = "sphere";
    next.actors[0]!.components[0]!.transform = {
      ...identity,
      position: [1, 0, 0],
    };
    next.actors[0]!.components[0]!.parentId = "other";
    const stamped = stampUserComponentOverrides(previous, next);
    expect(stamped.actors[0]?.components[0]?.overrideKeys).toEqual(
      expect.arrayContaining([
        "meshKind",
        PREFAB_TRANSFORM_OVERRIDE,
        PREFAB_PARENT_OVERRIDE,
      ]),
    );
  });

  it("drops override keys that now match the prefab template", () => {
    const previous = createDefaultScene();
    previous.actors = [
      createActor("hero", "Hero", {
        classId: "Hero",
        components: [
          {
            id: "c1",
            classId: "MeshComponent",
            properties: { meshKind: "sphere" },
            parentId: null,
            sourceId: "prefab-mesh",
            overrideKeys: ["meshKind"],
            transform: identity,
          },
        ],
      }),
    ];
    const next = structuredClone(previous);
    next.actors[0]!.components[0]!.properties.meshKind = "box";
    const stamped = stampUserComponentOverrides(previous, next, {
      Hero: [createMeshComponent("prefab-mesh", "box")],
    });
    expect(stamped.actors[0]?.components[0]?.overrideKeys).toBeUndefined();
  });
});

describe("copyInstanceLinkage", () => {
  it("copies sourceId and overrideKeys onto the applied scene", () => {
    const from = createDefaultScene();
    from.actors = [
      createActor("hero", "Hero", {
        components: [
          {
            id: "c1",
            classId: "MeshComponent",
            properties: { meshKind: "sphere" },
            parentId: null,
            sourceId: "prefab-mesh",
            overrideKeys: ["meshKind"],
            transform: identity,
          },
        ],
      }),
    ];
    const onto = structuredClone(from);
    delete onto.actors[0]!.components[0]!.sourceId;
    delete onto.actors[0]!.components[0]!.overrideKeys;
    const copied = copyInstanceLinkage(from, onto);
    expect(copied.actors[0]?.components[0]?.sourceId).toBe("prefab-mesh");
    expect(copied.actors[0]?.components[0]?.overrideKeys).toEqual(["meshKind"]);
  });

  it("clears overrideKeys when the intended scene has none", () => {
    const from = createDefaultScene();
    from.actors = [
      createActor("hero", "Hero", {
        components: [
          {
            id: "c1",
            classId: "MeshComponent",
            properties: { meshKind: "box" },
            parentId: null,
            sourceId: "prefab-mesh",
            transform: identity,
          },
        ],
      }),
    ];
    const onto = structuredClone(from);
    onto.actors[0]!.components[0]!.overrideKeys = ["meshKind"];
    const copied = copyInstanceLinkage(from, onto);
    expect(copied.actors[0]?.components[0]?.overrideKeys).toBeUndefined();
  });
});
