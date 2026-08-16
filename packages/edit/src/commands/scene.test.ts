import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  createActor,
  createDefaultScene,
  createMeshComponent,
  type SerializedScene,
  type SerializedTransform,
} from "@babylonslate/core";
import {
  AddActorCommand,
  AddComponentCommand,
  AddFolderCommand,
  RemoveFolderCommand,
  RenameFolderCommand,
  ReparentFolderCommand,
  SetActorFolderCommand,
  RemoveActorCommand,
  RemoveComponentCommand,
  RenameActorCommand,
  ReorderActorCommand,
  ReorderComponentCommand,
  ReparentActorCommand,
  ReparentComponentCommand,
  SetActorFlagsCommand,
  SetActorTransformCommand,
  SetActorsTransformsCommand,
  SetComponentPropertyCommand,
  SetSceneNameCommand,
  SetSceneSettingCommand,
  SetViewportModeCommand,
  type SceneEditCommand,
} from "./scene";
import { diffSceneCommands } from "./scene-diff";

const transformArb: fc.Arbitrary<SerializedTransform> = fc.record({
  position: fc.tuple(
    fc.integer({ min: -100, max: 100 }),
    fc.integer({ min: -100, max: 100 }),
    fc.integer({ min: -100, max: 100 }),
  ),
  rotation: fc.tuple(
    fc.integer({ min: -1, max: 1 }),
    fc.integer({ min: -1, max: 1 }),
    fc.integer({ min: -1, max: 1 }),
    fc.integer({ min: -1, max: 1 }),
  ),
  scale: fc.tuple(
    fc.integer({ min: 1, max: 10 }),
    fc.integer({ min: 1, max: 10 }),
    fc.integer({ min: 1, max: 10 }),
  ),
});

function baseScene(): SerializedScene {
  return {
    name: "Test",
    viewportMode: "3d",
    settings: createDefaultScene().settings,
    folders: [],
    actors: [
      createActor("a", "A", {
        components: [createMeshComponent("c1", "box")],
      }),
      createActor("b", "B", { parentId: "a" }),
    ],
  };
}

function folderScene(): SerializedScene {
  return {
    ...baseScene(),
    folders: [{ id: "f1", name: "One", parentFolderId: null }],
  };
}

function expectRoundTrip(
  scene: SerializedScene,
  command: SceneEditCommand,
): void {
  const applied = command.apply(scene);
  const restored = command.invert().apply(applied);
  expect(restored).toEqual(scene);
}

describe("scene commands", () => {
  it("AddActorCommand apply-then-invert restores the document", () => {
    const scene = baseScene();
    expectRoundTrip(scene, new AddActorCommand(createActor("c", "C"), 1));
  });

  it("AddActorCommand ignores a duplicate id", () => {
    const scene = baseScene();
    const applied = new AddActorCommand(createActor("a", "Dup")).apply(scene);
    expect(applied.actors).toHaveLength(2);
  });

  it("RemoveActorCommand apply-then-invert restores the document", () => {
    const scene = baseScene();
    expectRoundTrip(scene, new RemoveActorCommand(scene.actors[0]!, 0));
  });

  it("RemoveActorCommand records captured bytes for the budget", () => {
    const scene = baseScene();
    const command = new RemoveActorCommand(scene.actors[0]!, 0);
    expect(command.byteSize).toBeGreaterThan(0);
  });

  it("SetActorTransformCommand apply-then-invert restores the document", () => {
    fc.assert(
      fc.property(transformArb, transformArb, (from, to) => {
        const scene = baseScene();
        scene.actors[0]!.transform = from;
        expectRoundTrip(scene, new SetActorTransformCommand("a", from, to));
      }),
    );
  });

  it("SetActorTransformCommand coalesces gesture drags by merge key", () => {
    const first = new SetActorTransformCommand(
      "a",
      createActor("a", "A").transform,
      createActor("a", "A").transform,
    );
    const second = new SetActorTransformCommand(
      "a",
      createActor("a", "A").transform,
      createActor("a", "A").transform,
    );
    expect(first.mergeKey).toBe(second.mergeKey);
  });

  it("SetActorsTransformsCommand apply-then-invert restores every actor", () => {
    const scene = baseScene();
    const fromA = scene.actors[0]!.transform;
    const fromB = scene.actors[1]!.transform;
    const toA = { ...fromA, position: [4, 0, 0] as [number, number, number] };
    const toB = { ...fromB, position: [5, 1, 0] as [number, number, number] };
    const command = new SetActorsTransformsCommand([
      { actorId: "a", from: fromA, to: toA },
      { actorId: "b", from: fromB, to: toB },
    ]);
    expectRoundTrip(scene, command);
    const applied = command.apply(scene);
    expect(applied.actors[0]!.transform.position).toEqual([4, 0, 0]);
    expect(applied.actors[1]!.transform.position).toEqual([5, 1, 0]);
  });

  it("SetActorsTransformsCommand uses a stable merge key for the group", () => {
    const from = createActor("a", "A").transform;
    const to = { ...from, position: [1, 0, 0] as [number, number, number] };
    const first = new SetActorsTransformsCommand([
      { actorId: "b", from, to },
      { actorId: "a", from, to },
    ]);
    const second = new SetActorsTransformsCommand([
      { actorId: "a", from, to },
      { actorId: "b", from, to },
    ]);
    expect(first.mergeKey).toBe("transforms:a,b");
    expect(first.mergeKey).toBe(second.mergeKey);
  });

  it("RenameActorCommand apply-then-invert restores the document", () => {
    const scene = baseScene();
    expectRoundTrip(scene, new RenameActorCommand("a", "A", "Renamed"));
  });

  it("ReparentActorCommand apply-then-invert restores the document", () => {
    const scene = baseScene();
    expectRoundTrip(scene, new ReparentActorCommand("b", "a", null));
  });

  it("ReorderActorCommand apply-then-invert restores the document", () => {
    const scene = baseScene();
    expectRoundTrip(scene, new ReorderActorCommand("a", 0, 1));
  });

  it("SetActorFlagsCommand apply-then-invert restores the document", () => {
    const scene = baseScene();
    expectRoundTrip(
      scene,
      new SetActorFlagsCommand(
        "a",
        { visible: true, locked: false },
        { visible: false, locked: true },
      ),
    );
  });

  it("AddComponentCommand apply-then-invert restores the document", () => {
    const scene = baseScene();
    expectRoundTrip(
      scene,
      new AddComponentCommand("a", createMeshComponent("c2", "sphere"), 1),
    );
  });

  it("RemoveComponentCommand apply-then-invert restores the document", () => {
    const scene = baseScene();
    expectRoundTrip(
      scene,
      new RemoveComponentCommand("a", scene.actors[0]!.components[0]!, 0),
    );
  });

  it("ReorderComponentCommand apply-then-invert restores the document", () => {
    const scene = baseScene();
    scene.actors[0]!.components.push(createMeshComponent("c2", "sphere"));
    expectRoundTrip(scene, new ReorderComponentCommand("a", "c1", 0, 1));
  });

  it("ReparentComponentCommand apply-then-invert restores the document", () => {
    const scene = baseScene();
    scene.actors[0]!.components.push({
      ...createMeshComponent("c2", "sphere"),
      parentId: "c1",
    });
    expectRoundTrip(
      scene,
      new ReparentComponentCommand("a", "c2", "c1", null),
    );
  });

  it("SetComponentPropertyCommand apply-then-invert restores the document", () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (from, to) => {
        const scene = baseScene();
        scene.actors[0]!.components[0]!.properties.meshKind = from;
        expectRoundTrip(
          scene,
          new SetComponentPropertyCommand("a", "c1", "meshKind", from, to),
        );
      }),
    );
  });

  it("SetSceneSettingCommand apply-then-invert restores the document", () => {
    const scene = baseScene();
    expectRoundTrip(
      scene,
      new SetSceneSettingCommand(
        "fogEnabled",
        scene.settings.fogEnabled,
        !scene.settings.fogEnabled,
      ),
    );
  });

  it("SetViewportModeCommand apply-then-invert restores the document", () => {
    const scene = baseScene();
    expectRoundTrip(scene, new SetViewportModeCommand("3d", "2d"));
  });

  it("SetSceneNameCommand apply-then-invert restores the document", () => {
    const scene = baseScene();
    expectRoundTrip(scene, new SetSceneNameCommand("Test", "Level 1"));
  });

  it("AddFolderCommand apply-then-invert restores the document", () => {
    expectRoundTrip(
      folderScene(),
      new AddFolderCommand({ id: "f2", name: "Two", parentFolderId: null }, 1),
    );
  });

  it("AddFolderCommand ignores a duplicate id", () => {
    const applied = new AddFolderCommand({
      id: "f1",
      name: "Dup",
      parentFolderId: null,
    }).apply(folderScene());
    expect(applied.folders).toHaveLength(1);
  });

  it("RemoveFolderCommand apply-then-invert restores the document", () => {
    const scene = folderScene();
    expectRoundTrip(scene, new RemoveFolderCommand(scene.folders[0]!, 0));
  });

  it("RenameFolderCommand apply-then-invert restores the document", () => {
    expectRoundTrip(folderScene(), new RenameFolderCommand("f1", "One", "Renamed"));
  });

  it("ReparentFolderCommand apply-then-invert restores the document", () => {
    const scene = {
      ...folderScene(),
      folders: [
        { id: "f1", name: "One", parentFolderId: null },
        { id: "f2", name: "Two", parentFolderId: null },
      ],
    };
    expectRoundTrip(scene, new ReparentFolderCommand("f2", null, "f1"));
  });

  it("SetActorFolderCommand apply-then-invert restores the document", () => {
    expectRoundTrip(folderScene(), new SetActorFolderCommand("a", null, "f1"));
  });

  it("SetActorFolderCommand moves only the named actor", () => {
    const applied = new SetActorFolderCommand("a", null, "f1").apply(folderScene());
    expect(applied.actors.find((actor) => actor.id === "a")?.folderId).toBe("f1");
    expect(applied.actors.find((actor) => actor.id === "b")?.folderId).toBeNull();
  });
});

describe("diffSceneCommands", () => {
  it("derives no commands for an unchanged scene", () => {
    const scene = baseScene();
    expect(diffSceneCommands(scene, structuredClone(scene))).toEqual([]);
  });

  it("derives an add for a new actor", () => {
    const before = baseScene();
    const after = {
      ...before,
      actors: [...before.actors, createActor("c", "C")],
    };
    const commands = diffSceneCommands(before, after);
    expect(commands.map((command) => command.type)).toEqual(["scene.addActor"]);
  });

  it("derives a remove for a deleted actor", () => {
    const before = baseScene();
    const after = { ...before, actors: [before.actors[0]!] };
    const commands = diffSceneCommands(before, after);
    expect(commands.map((command) => command.type)).toEqual([
      "scene.removeActor",
    ]);
  });

  it("derives a single-actor transform as SetActorTransformCommand", () => {
    const before = baseScene();
    const after = structuredClone(before);
    after.actors[0]!.transform.position = [2, 0, 0];
    const commands = diffSceneCommands(before, after);
    expect(commands.map((command) => command.type)).toEqual([
      "scene.setActorTransform",
    ]);
  });

  it("batches multi-actor transform diffs into one SetActorsTransformsCommand", () => {
    const before = baseScene();
    const after = structuredClone(before);
    after.actors[0]!.transform.position = [2, 0, 0];
    after.actors[1]!.transform.position = [3, 0, 0];
    const commands = diffSceneCommands(before, after);
    expect(commands).toHaveLength(1);
    expect(commands[0]!.type).toBe("scene.setActorsTransforms");
    expect(commands[0]!.apply(before)).toEqual(after);
    expect(commands[0]!.invert().apply(after)).toEqual(before);
  });

  it("derives transform, rename, reparent and flag deltas", () => {
    const before = baseScene();
    const after = structuredClone(before);
    after.actors[1]!.name = "Renamed";
    after.actors[1]!.parentId = null;
    after.actors[1]!.transform.position = [5, 0, 0];
    after.actors[1]!.visible = false;
    const types = diffSceneCommands(before, after).map(
      (command) => command.type,
    );
    expect(types).toEqual([
      "scene.renameActor",
      "scene.reparentActor",
      "scene.setActorTransform",
      "scene.setActorFlags",
    ]);
  });

  it("derives component property deltas", () => {
    const before = baseScene();
    const after = structuredClone(before);
    after.actors[0]!.components[0]!.properties.meshKind = "sphere";
    const commands = diffSceneCommands(before, after);
    expect(commands).toHaveLength(1);
    expect(commands[0]!.type).toBe("scene.setComponentProperty");
  });

  it("derives viewport mode and scene setting changes", () => {
    const before = baseScene();
    const after = structuredClone(before);
    after.viewportMode = "2d";
    after.settings.fogEnabled = true;
    const types = diffSceneCommands(before, after).map(
      (command) => command.type,
    );
    expect(types).toEqual(["scene.setViewportMode", "scene.setSceneSetting"]);
  });

  it("derives a scene name change", () => {
    const before = baseScene();
    const after = { ...before, name: "Level 1" };
    const commands = diffSceneCommands(before, after);
    expect(commands.map((command) => command.type)).toEqual([
      "scene.setSceneName",
    ]);
    expect(commands[0]!.apply(before).name).toBe("Level 1");
  });

  it("derives component reorder when only order changes", () => {
    const before = baseScene();
    before.actors[0]!.components.push(createMeshComponent("c2", "sphere"));
    const after = structuredClone(before);
    after.actors[0]!.components = [
      after.actors[0]!.components[1]!,
      after.actors[0]!.components[0]!,
    ];
    const commands = diffSceneCommands(before, after);
    expect(commands.map((command) => command.type)).toEqual([
      "scene.reorderComponent",
    ]);
  });

  it("derives add, remove, and reparent component commands", () => {
    const before = baseScene();
    before.actors[0]!.components.push(createMeshComponent("c2", "sphere"));
    const after = structuredClone(before);
    after.actors[0]!.components = [
      {
        ...after.actors[0]!.components[0]!,
        parentId: "c2",
      },
      createMeshComponent("c3", "cylinder"),
    ];
    const types = diffSceneCommands(before, after).map(
      (command) => command.type,
    );
    expect(types).toContain("scene.addComponent");
    expect(types).toContain("scene.removeComponent");
    expect(types).toContain("scene.reparentComponent");
  });

  it("derives ReorderActorCommand when actor order changes", () => {
    const before = baseScene();
    const after = {
      ...before,
      actors: [before.actors[1]!, before.actors[0]!],
    };
    const commands = diffSceneCommands(before, after);
    expect(commands.map((command) => command.type)).toContain(
      "scene.reorderActor",
    );
  });

  it("replaying derived commands reproduces the after document", () => {
    const before = baseScene();
    const after = structuredClone(before);
    after.name = "Renamed Scene";
    after.actors[0]!.name = "Renamed";
    after.actors[0]!.transform.position = [3, 4, 5];
    after.actors[0]!.components.push(createMeshComponent("c2", "sphere"));
    after.actors[0]!.components = [
      after.actors[0]!.components[1]!,
      after.actors[0]!.components[0]!,
    ];
    after.actors.push(createActor("c", "C"));

    let doc = before;
    for (const command of diffSceneCommands(before, after)) {
      doc = command.apply(doc);
    }
    expect(doc).toEqual(after);
  });

  it("derives folder add, rename, reparent, and remove commands", () => {
    const before = folderScene();
    const after = {
      ...before,
      folders: [
        { id: "f1", name: "Renamed", parentFolderId: null },
        { id: "f2", name: "Two", parentFolderId: "f1" },
      ],
    };
    const types = diffSceneCommands(before, after).map((command) => command.type);
    expect(types).toContain("scene.addFolder");
    expect(types).toContain("scene.renameFolder");

    const removed = diffSceneCommands(after, before).map(
      (command) => command.type,
    );
    expect(removed).toContain("scene.removeFolder");
  });

  it("derives a folder move for an actor without touching its transform parent", () => {
    const before = folderScene();
    const after = structuredClone(before);
    after.actors[0]!.folderId = "f1";
    const commands = diffSceneCommands(before, after);
    expect(commands.map((command) => command.type)).toEqual([
      "scene.setActorFolder",
    ]);
  });

  it("replaying derived folder commands reproduces the after document", () => {
    const before = folderScene();
    const after = structuredClone(before);
    after.folders = [
      { id: "f1", name: "One", parentFolderId: null },
      { id: "f2", name: "Nested", parentFolderId: "f1" },
    ];
    after.actors[0]!.folderId = "f2";

    let doc: SerializedScene = before;
    for (const command of diffSceneCommands(before, after)) {
      doc = command.apply(doc);
    }
    expect(doc).toEqual(after);
  });
});
