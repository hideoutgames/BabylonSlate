import { describe, expect, it } from "vitest";
import {
  createActor,
  createDefaultScene,
  createMeshComponent,
  identitySerializedTransform,
  normalizeScene,
} from "@babylonslate/core";
import {
  PREFAB_PARENT_OVERRIDE,
  PREFAB_TRANSFORM_OVERRIDE,
  descendantClassIds,
  mergedPrefabComponentsForClass,
  prefabAssetTemplates,
  stampUserComponentOverrides,
  syncActorComponentsFromPrefab,
  syncSceneActorsFromPrefabs,
} from "./prefab-instance-sync";
import { EditSession, commandToJournalPayload, diffSceneCommands, replayJournalLines, serializeJournalLine } from "@babylonslate/edit";
import { instantiatePrefabComponents } from "./prefab-preview";
import { MODEL_MATERIALS_PICKER_VALUE, patchInspectorComponentProperty } from "./mesh-material-properties";
import { duplicateSceneActor, spawnPlacedActor } from "./place-actors";

const identity = identitySerializedTransform();

describe("syncActorComponentsFromPrefab", () => {
  it("persists a sourced deletion through history, recovery, duplicate and future prefab sync", () => {
    const prefab = [createMeshComponent("removed"), createMeshComponent("survivor")];
    const before = { ...createDefaultScene(), actors: [createActor("actor", "Actor", {
      classId: "Hero", components: instantiatePrefabComponents(prefab, "actor"),
    })] };
    const edited = structuredClone(before);
    edited.actors[0]!.components.splice(0, 1);
    const stamped = stampUserComponentOverrides(before, edited, { Hero: prefab });
    expect(stamped.actors[0]!.suppressedComponentSourceIds).toEqual(["removed"]);
    const session = new EditSession();
    const applied = session.applyBatch("scene", before, diffSceneCommands(before, stamped))!;
    expect(applied.doc).toStrictEqual(stamped);
    const undo = session.undo("scene", applied.doc)!;
    expect(undo.doc).toStrictEqual(before);
    const redo = session.redo("scene", undo.doc)!;
    expect(redo.doc).toStrictEqual(stamped);
    const restored = normalizeScene(JSON.parse(JSON.stringify(redo.doc)));
    const duplicate = duplicateSceneActor(restored, restored.actors[0]!);
    const synced = syncSceneActorsFromPrefabs({ ...restored, actors: [...restored.actors, duplicate] }, { Hero: prefab });
    expect(synced.actors.map((actor) => actor.components.map((component) => component.sourceId))).toEqual([["survivor"], ["survivor"]]);
    const line = serializeJournalLine({ v: 1, docId: "scene", at: "2026-10-07", command: commandToJournalPayload(applied.command) });
    expect(replayJournalLines([line], new Map([["scene", before]])).documents.get("scene")).toStrictEqual(stamped);
  });

  it("does not migrate instance-only components onto a suppressed template", () => {
    const extra = createMeshComponent("extra", "sphere");
    const actor = createActor("actor", "Actor", { components: [extra], suppressedComponentSourceIds: ["removed"] });
    expect(syncActorComponentsFromPrefab(actor, [createMeshComponent("removed")])).toStrictEqual([extra]);
  });

  it("keeps private material state through prefab changes, undo and reset", () => {
    const prefab = createMeshComponent("mesh");
    prefab.properties.materialGuid = "surface";
    const before = { ...createDefaultScene(), actors: [createActor("actor", "Actor", { classId: "Hero", components: instantiatePrefabComponents([prefab], "actor") })] };
    const edited = structuredClone(before);
    edited.actors[0]!.components[0]!.materialInstance = { materialGuid: "surface", parameters: { Gain: { kind: "float", value: 0.4 } } };
    const stamped = stampUserComponentOverrides(before, edited, { Hero: [prefab] });
    const session = new EditSession();
    const applied = session.applyBatch("scene", before, diffSceneCommands(before, stamped))!;
    expect(applied.doc).toStrictEqual(stamped);
    const updated = { ...prefab, properties: { ...prefab.properties, meshKind: "sphere" } };
    expect(syncSceneActorsFromPrefabs(applied.doc, { Hero: [updated] }).actors[0]!.components[0]!.materialInstance)
      .toEqual(edited.actors[0]!.components[0]!.materialInstance);
    expect(session.undo("scene", applied.doc)?.doc).toStrictEqual(before);
    const reset = structuredClone(stamped);
    delete reset.actors[0]!.components[0]!.materialInstance;
    const resetStamped = stampUserComponentOverrides(stamped, reset, { Hero: [prefab] });
    const resetCommands = diffSceneCommands(stamped, resetStamped);
    const resetApplied = session.applyBatch("scene", stamped, resetCommands)!;
    expect(resetApplied.doc).toStrictEqual(before);
    const line = serializeJournalLine({ v: 1, docId: "scene", at: "2026-10-07", command: commandToJournalPayload(resetApplied.command) });
    expect(replayJournalLines([line], new Map([["scene", stamped]])).documents.get("scene")).toStrictEqual(before);
  });
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

  it("follows prefab component renames until the instance renames its own row", () => {
    const prefab = { ...createMeshComponent("prefab-mesh", "box"), name: "Body" };
    const previous = createDefaultScene();
    previous.actors = [createActor("hero", "Hero", {
      classId: "Hero", components: instantiatePrefabComponents([prefab], "hero"),
    })];
    expect(previous.actors[0]!.components[0]!.name).toBe("Body");
    const renamedPrefab = { ...prefab, name: "Torso" };
    expect(syncActorComponentsFromPrefab(previous.actors[0]!, [renamedPrefab])[0]!.name).toBe("Torso");

    const renamed = structuredClone(previous);
    renamed.actors[0]!.components[0]!.name = "Hero Body";
    const stamped = stampUserComponentOverrides(previous, renamed, { Hero: [prefab] });
    expect(stamped.actors[0]!.components[0]!.overrideKeys).toContain("name");
    expect(syncActorComponentsFromPrefab(stamped.actors[0]!, [renamedPrefab])[0]!.name).toBe("Hero Body");

    const reset = structuredClone(stamped);
    reset.actors[0]!.components[0]!.name = "Body";
    const cleared = stampUserComponentOverrides(stamped, reset, { Hero: [prefab] });
    expect(cleared.actors[0]!.components[0]!.overrideKeys ?? []).not.toContain("name");
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

  it("syncs actors placed from a Prefab asset by GUID, with open tabs winning over saved headers", () => {
    const placed = spawnPlacedActor(createDefaultScene(), {
      id: "asset-rock",
      title: "Rock",
      category: "Project",
      kind: {
        type: "asset",
        name: "Rock",
        guid: "rock-guid",
        assetType: "Prefab",
        components: [createMeshComponent("prefab-mesh", "box")],
      },
    }, "rock", [0, 0, 0]);
    expect(placed.classId).toBe("Actor");
    const plain = createActor("plain", "Plain", {
      components: instantiatePrefabComponents([createMeshComponent("prefab-mesh", "box")], "plain"),
    });
    // The Prefab link survives a save and reload of the scene.
    const scene = normalizeScene({ ...createDefaultScene(), actors: [placed, plain] });
    expect(scene.actors[0]?.prefabGuid).toBe("rock-guid");

    const assets = [{
      path: "assets/Rock.prefab.babasset",
      header: { type: "Prefab", guid: "rock-guid", payload: { components: [createMeshComponent("prefab-mesh", "cylinder")] } },
    }];
    const saved = syncSceneActorsFromPrefabs(scene, prefabAssetTemplates({ assets, openDocuments: [] }));
    expect(saved.actors.map((actor) => actor.components[0]?.properties.meshKind)).toEqual(["cylinder", "box"]);

    const edited = syncSceneActorsFromPrefabs(scene, prefabAssetTemplates({
      assets,
      openDocuments: [{
        ref: { kind: "prefab", path: "assets/Rock.prefab.babasset" },
        content: { components: [createMeshComponent("prefab-mesh", "sphere")] },
      }],
    }));
    expect(edited.actors.map((actor) => actor.components[0]?.properties.meshKind)).toEqual(["sphere", "box"]);
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
  it("keeps actor and component references when nothing changed", () => {
    const prefab = createMeshComponent("prefab-mesh", "box");
    const scene = createDefaultScene();
    scene.actors = [
      createActor("hero", "Hero", {
        classId: "Hero",
        components: instantiatePrefabComponents([prefab], "hero"),
      }),
      createActor("other", "Other"),
    ];

    const stamped = stampUserComponentOverrides(scene, scene, {
      Hero: [prefab],
    });

    expect(stamped.actors[0]).toBe(scene.actors[0]);
    expect(stamped.actors[0]!.components[0]).toBe(
      scene.actors[0]!.components[0],
    );
    expect(stamped.actors[1]).toBe(scene.actors[1]);
  });

  it("replaces only the actor whose component changed", () => {
    const prefab = createMeshComponent("prefab-mesh", "box");
    const previous = createDefaultScene();
    previous.actors = [
      createActor("hero", "Hero", {
        classId: "Hero",
        components: instantiatePrefabComponents([prefab], "hero"),
      }),
      createActor("other", "Other"),
    ];
    const component = previous.actors[0]!.components[0]!;
    const next = {
      ...previous,
      actors: previous.actors.map((actor, index) =>
        index === 0
          ? {
              ...actor,
              components: [
                {
                  ...component,
                  properties: { ...component.properties, meshKind: "sphere" },
                },
              ],
            }
          : actor,
      ),
    };

    const stamped = stampUserComponentOverrides(previous, next, {
      Hero: [prefab],
    });

    expect(stamped.actors[0]).not.toBe(next.actors[0]);
    expect(stamped.actors[0]!.components[0]!.overrideKeys).toContain("meshKind");
    expect(stamped.actors[1]).toBe(previous.actors[1]);
  });

  it("keeps explicit model None across prefab material edits and resumes inheritance after reset", () => {
    const prefab = createMeshComponent("prefab-mesh", "box");
    prefab.properties.assetGuid = "model";
    const previous = createDefaultScene();
    previous.actors = [createActor("hero", "Hero", {
      classId: "Hero", components: instantiatePrefabComponents([prefab], "hero"),
    })];
    const selectedNone = structuredClone(previous);
    const mesh = selectedNone.actors[0]!.components[0]!;
    mesh.properties = patchInspectorComponentProperty(mesh, "materialGuid", null);
    const stamped = stampUserComponentOverrides(previous, selectedNone, { Hero: [prefab] });
    const changedPrefab = structuredClone(prefab);
    changedPrefab.properties.materialGuid = "new-default";
    const afterPrefabEdit = syncSceneActorsFromPrefabs(stamped, { Hero: [changedPrefab] });
    expect(afterPrefabEdit.actors[0]!.components[0]!.properties).toMatchObject({ materialGuid: null, materialSource: "override" });

    // Restore the Model default, then verify both override keys disappear so
    // a later prefab None (and then a named material) propagates again.
    const reset = structuredClone(stamped);
    const resetMesh = reset.actors[0]!.components[0]!;
    resetMesh.properties = patchInspectorComponentProperty(resetMesh, "materialGuid", MODEL_MATERIALS_PICKER_VALUE);
    const inherited = stampUserComponentOverrides(stamped, reset, { Hero: [prefab] });
    expect(inherited.actors[0]!.components[0]!.overrideKeys).toBeUndefined();
    const nonePrefab = { ...prefab, properties: patchInspectorComponentProperty(prefab, "materialGuid", null) };
    expect(syncSceneActorsFromPrefabs(inherited, { Hero: [nonePrefab] }).actors[0]!.components[0]!.properties).toMatchObject({ materialGuid: null, materialSource: "override" });
    expect(syncSceneActorsFromPrefabs(inherited, { Hero: [changedPrefab] }).actors[0]!.components[0]!.properties.materialGuid).toBe("new-default");
  });

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

describe("prefab overrides through edit history", () => {
  it.each(["property", "transform"] as const)("preserves %s inheritance through a scrub, Undo, Redo and recovery", (kind) => {
    const prefab = createMeshComponent("prefab-mesh", "box");
    const initial = { ...createDefaultScene(), actors: [createActor("hero", "Hero", {
      classId: "Hero", components: instantiatePrefabComponents([prefab], "hero"),
    })] };
    const session = new EditSession();
    const id = "scene:Main";
    const lines: string[] = [];
    let live = initial;
    for (const value of [1, 2]) {
      const next = structuredClone(live);
      if (kind === "property") next.actors[0]!.components[0]!.properties.meshKind = value === 1 ? "sphere" : "cylinder";
      else next.actors[0]!.components[0]!.transform = { ...identity, position: [value * 5, 0, 0] };
      const intended = stampUserComponentOverrides(live, next, { Hero: [prefab] });
      const applied = session.applyBatch(id, live, diffSceneCommands(live, intended))!;
      live = applied.doc;
      lines.push(serializeJournalLine({ v: 1, docId: id, at: "2026-10-02T00:00:00Z", command: commandToJournalPayload(applied.command) }));
    }
    const updatedPrefab = { ...prefab, properties: { ...prefab.properties, meshKind: "sphere" }, transform: { ...identity, position: [20, 0, 0] as [number, number, number] } };
    const undone = session.undo(id, live)!;
    expect(undone.doc).toEqual(initial);
    expect(session.canUndo(id)).toBe(false);
    const inherited = syncActorComponentsFromPrefab(undone.doc.actors[0]!, [updatedPrefab])[0]!;
    expect(inherited.properties.meshKind).toBe("sphere");
    expect(inherited.transform?.position).toEqual([20, 0, 0]);
    const redone = session.redo(id, undone.doc)!;
    const recovered = replayJournalLines(lines, new Map([[id, initial]])).documents.get(id)!;
    for (const scene of [redone.doc, recovered]) {
      const synced = syncActorComponentsFromPrefab(scene.actors[0]!, [updatedPrefab])[0]!;
      expect(synced.sourceId).toBe(prefab.id);
      expect(synced.overrideKeys).toEqual([kind === "property" ? "meshKind" : PREFAB_TRANSFORM_OVERRIDE]);
      if (kind === "property") expect(synced.properties.meshKind).toBe("cylinder");
      else expect(synced.transform?.position).toEqual([10, 0, 0]);
    }
  });

  it("records metadata-only adoption and clearing overrides as reversible journalled state", () => {
    const initial = { ...createDefaultScene(), actors: [createActor("hero", "Hero", {
      classId: "Hero", components: [createMeshComponent("mesh", "box")],
    })] };
    const linked = structuredClone(initial);
    linked.actors[0]!.components[0]!.sourceId = "prefab-mesh";
    linked.actors[0]!.components[0]!.overrideKeys = ["meshKind"];
    const session = new EditSession();
    const added = session.applyBatch("scene:Main", initial, diffSceneCommands(initial, linked))!;
    expect(added.doc).toEqual(linked);
    const cleared = structuredClone(linked);
    delete cleared.actors[0]!.components[0]!.overrideKeys;
    const removed = session.applyBatch("scene:Main", added.doc, diffSceneCommands(added.doc, cleared))!;
    expect(removed.doc).toEqual(cleared);
    expect(session.undo("scene:Main", removed.doc)?.doc).toEqual(linked);
    const lines = [added, removed].map(({ command }) => serializeJournalLine({ v: 1, docId: "scene:Main", at: "2026-10-02T00:00:00Z", command: commandToJournalPayload(command) }));
    expect(replayJournalLines(lines, new Map([["scene:Main", initial]])).documents.get("scene:Main")).toEqual(cleared);
  });
});
