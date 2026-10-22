import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  createActor,
  createDefaultScene,
  createMeshComponent,
  type MaterialInstanceOverrides,
  type SerializedActor,
  type SerializedComponent,
  type SerializedOutlinerFolder,
  type SerializedScene,
  type SerializedTransform,
} from "@haptic/core";
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
  SetComponentTransformCommand,
  SetSceneNameCommand,
  SetSceneSettingCommand,
  SetViewportModeCommand,
  type SceneEditCommand,
} from "./scene";
import { ReorderFolderCommand } from "./scene-fields";
import { diffSceneCommands, planSceneChange } from "./scene-diff";
import { EditSession } from "../session";
import { commandToJournalPayload, reviveCommand } from "../journal";

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

  it("counts component property and scene setting payloads toward the Undo byte budget", () => {
    const heights = Array.from({ length: 500 }, (_, index) => index);
    const session = new EditSession({ maxBytes: 1000 });
    const property = session.apply("scene", baseScene(), new SetComponentPropertyCommand("a", "c1", "heights", undefined, heights));
    expect(property.history).toBe("cleared");
    const stack = Array.from({ length: 100 }, (_, index) => ({ materialGuid: `material-${index}`, enabled: true }));
    const setting = session.apply("scene", baseScene(), new SetSceneSettingCommand("postProcessStack", [], stack));
    expect(setting.history).toBe("cleared");
  });

  it("records no Undo step for an add whose component id already exists", () => {
    const session = new EditSession();
    const scene = baseScene();
    const duplicate = new AddComponentCommand("a", createMeshComponent("c1", "sphere"));
    expect(session.apply("scene", scene, duplicate)).toMatchObject({ doc: scene, history: "unchanged" });
    expect(session.canUndo("scene")).toBe(false);
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

  it("ignores actor, group, and component transform edits on an Outliner anchor", () => {
    const scene = baseScene();
    const anchor = createActor("pin", "2D Anchor", { components: [
      { id: "anchor", classId: "2DAnchorComponent", properties: {} },
    ] });
    scene.actors.push(anchor);
    const from = anchor.transform;
    const to = { ...from, position: [4, 5, 6] as [number, number, number] };
    for (const command of [
      new SetActorTransformCommand("pin", from, to),
      new SetActorsTransformsCommand([{ actorId: "pin", from, to }]),
      new SetComponentTransformCommand("pin", "anchor", from, to),
    ]) {
      expect(command.apply(scene).actors.find((actor) => actor.id === "pin")).toEqual(anchor);
    }
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

  it("reorders a row only while it is still at the recorded from index", () => {
    const scene = baseScene();
    scene.folders = [
      { id: "f1", name: "One", parentFolderId: null },
      { id: "f2", name: "Two", parentFolderId: null },
    ];
    scene.actors[0]!.components.push(createMeshComponent("c2", "sphere"));
    const reorders = [
      new ReorderActorCommand("a", 0, 1),
      new ReorderFolderCommand("f1", 0, 1),
      new ReorderComponentCommand("a", "c1", 0, 1),
    ];
    const moved = reorders.reduce((doc, command) => command.apply(doc), scene);
    expect(moved.actors.map((actor) => actor.id)).toEqual(["b", "a"]);
    expect(moved.folders.map((folder) => folder.id)).toEqual(["f2", "f1"]);
    expect(moved.actors[1]!.components.map((component) => component.id)).toEqual(["c2", "c1"]);
    // Replayed again (a journal over content that already holds it), each
    // reorder leaves its row where the later edits put it.
    for (const command of reorders) expect(command.apply(moved)).toBe(moved);
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

  it("SetComponentTransformCommand apply-then-invert restores the document", () => {
    const scene = baseScene();
    const from = scene.actors[0]!.components[0]!.transform!;
    const to = { ...from, position: [2, 0, 0] as [number, number, number] };
    expectRoundTrip(
      scene,
      new SetComponentTransformCommand("a", "c1", from, to),
    );
  });

  it("keeps command snapshots apart from the edited document", () => {
    const scene = baseScene();
    const from = scene.actors[0]!.components[0]!.transform!;
    const to: SerializedTransform = { ...from, position: [2, 0, 0] };
    const property = new SetComponentPropertyCommand("a", "c1", "heights", undefined, [1, 2]);
    const applied = property.apply(new SetComponentTransformCommand("a", "c1", from, to).apply(scene));
    const component = applied.actors[0]!.components[0]!;
    component.transform!.position[0] = 9;
    (component.properties.heights as number[])[0] = 9;
    expect(to.position).toEqual([2, 0, 0]);
    expect(property.to).toEqual([1, 2]);

    // Undo of a delete re-adds the removed rows from the Redo entry's snapshots.
    const actor = createActor("c", "C", { components: [createMeshComponent("c3", "box")] });
    const added = createMeshComponent("c2", "sphere");
    const snapshots = structuredClone({ actor, added });
    const restored = new RemoveComponentCommand("a", added).invert().apply(
      new RemoveActorCommand(actor).invert().apply(scene),
    );
    const restoredActor = restored.actors.find((entry) => entry.id === "c")!;
    restoredActor.transform.position[0] = 9;
    restoredActor.components[0]!.properties.meshKind = "sphere";
    restored.actors[0]!.components.find((entry) => entry.id === "c2")!.properties.meshKind = "box";
    expect({ actor, added }).toEqual(snapshots);
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
  it("resets an optional setting without losing undo, redo, or unrelated settings", () => {
    const before = baseScene();
    before.settings.celShading = { shadowBands: 3 };
    const after = structuredClone(before);
    delete after.settings.celShading;

    const commands = diffSceneCommands(before, after);
    expect(commands).toHaveLength(1);
    const reset = commands[0]!;
    const applied = reset.apply(before);
    expect(applied).toStrictEqual(after);
    expect(Object.hasOwn(applied.settings, "celShading")).toBe(false);
    const restored = reset.invert().apply(applied);
    expect(restored).toStrictEqual(before);
    expect(reset.apply(restored)).toStrictEqual(after);
    expect(before.settings.celShading).toEqual({ shadowBands: 3 });

    const add = diffSceneCommands(after, before);
    expect(add).toHaveLength(1);
    expect(add[0]!.apply(after)).toStrictEqual(before);
    expect(add[0]!.invert().apply(before)).toStrictEqual(after);
  });

  it("derives no commands for an unchanged scene", () => {
    const scene = baseScene();
    expect(diffSceneCommands(scene, structuredClone(scene))).toEqual([]);
  });

  it("derives no commands when actors keep reference identity", () => {
    const scene = baseScene();
    expect(diffSceneCommands(scene, { ...scene, actors: [...scene.actors] })).toEqual([]);
  });

  it("derives a reorder when actors keep reference identity but change index", () => {
    const before = baseScene();
    const after = {
      ...before,
      actors: [before.actors[1]!, before.actors[0]!],
    };
    const commands = diffSceneCommands(before, after);
    expect(commands.length).toBeGreaterThan(0);
    expect(commands.every((command) => command.type === "scene.reorderActor")).toBe(true);

    let applied = before;
    for (const command of commands) applied = command.apply(applied);
    expect(applied.actors).toEqual(after.actors);
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
      "scene.setActorFlags",
      "scene.setActorTransform",
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

  it("derives a component property delta when only that component is replaced", () => {
    const before = baseScene();
    const after = {
      ...before,
      actors: before.actors.map((actor, actorIndex) =>
        actorIndex === 0
          ? {
              ...actor,
              components: actor.components.map((component, componentIndex) =>
                componentIndex === 0
                  ? {
                      ...component,
                      properties: {
                        ...component.properties,
                        meshKind: "sphere",
                      },
                    }
                  : component,
              ),
            }
          : actor,
      ),
    };
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

  it("clears a component property without leaving an own undefined key", () => {
    const before = baseScene();
    before.actors[0]!.components[0]!.properties.speed = 3;
    const after = structuredClone(before);
    delete after.actors[0]!.components[0]!.properties.speed;
    const commands = diffSceneCommands(before, after);
    const applied = commands.reduce<SerializedScene>((doc, command) => command.apply(doc), before);
    expect(applied).toStrictEqual(after);
  });

  it("restores a component transform when Undo turns a 2D anchor back into its earlier class", () => {
    const before = baseScene();
    const after = structuredClone(before);
    const component = after.actors[0]!.components[0]!;
    component.classId = "2DAnchorComponent";
    delete component.transform;
    for (const [from, to] of [[before, after], [after, before]] as const) {
      const session = new EditSession();
      const applied = session.applyBatch("scene", from, diffSceneCommands(from, to))!.doc;
      expect(applied).toEqual(to);
      expect(session.undo("scene", applied)!.doc).toEqual(from);
    }
  });

  it("derives SetComponentTransformCommand when a component transform changes", () => {
    const before = baseScene();
    const after = structuredClone(before);
    after.actors[0]!.components[0]!.transform = {
      ...after.actors[0]!.components[0]!.transform!,
      position: [3, 0, 0],
    };
    expect(diffSceneCommands(before, after).map((command) => command.type)).toEqual(
      ["scene.setComponentTransform"],
    );
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

const ACTOR_IDS = ["a1", "a2", "a3", "a4"] as const;
const COMPONENT_IDS = ["c1", "c2", "c3"] as const;
const FOLDER_IDS = ["f1", "f2", "f3"] as const;

const jsonValueArb = fc.oneof(
  fc.integer({ min: -3, max: 3 }),
  fc.constantFrom("x", "y"),
  fc.boolean(),
  fc.constant(null),
  fc.array(fc.record({ classId: fc.constantFrom("HudLayer", "PauseLayer"), defaults: fc.constant({}) }), { maxLength: 2 }),
);
const propertiesArb = fc.dictionary(fc.constantFrom("speed", "layer", "sceneLayerActors"), jsonValueArb, { maxKeys: 3 });

const componentArb: fc.Arbitrary<SerializedComponent> = fc.record({
  id: fc.constantFrom(...COMPONENT_IDS),
  classId: fc.constantFrom("MeshComponent", "LightComponent"),
  properties: propertiesArb,
  parentId: fc.constantFrom(null, ...COMPONENT_IDS),
  transform: transformArb,
  sourceId: fc.constantFrom("p1", "p2"),
  overrideKeys: fc.subarray(["speed", "transform"], { minLength: 1 }),
  materialInstance: fc.record({
    materialGuid: fc.constantFrom("m1", "m2"),
    parameters: fc.dictionary(fc.constant("Amount"), fc.integer({ min: 0, max: 2 }).map((value) => ({ kind: "float" as const, value }))),
  }) as fc.Arbitrary<MaterialInstanceOverrides>,
}, { requiredKeys: ["id", "classId", "properties", "parentId"] });

const actorArb: fc.Arbitrary<SerializedActor> = fc.record({
  id: fc.constantFrom(...ACTOR_IDS),
  name: fc.constantFrom("A", "B"),
  classId: fc.constantFrom("Actor", "SceneLayerActorSwitcher"),
  parentId: fc.constantFrom(null, ...ACTOR_IDS),
  transform: transformArb,
  visible: fc.boolean(),
  locked: fc.boolean(),
  components: fc.uniqueArray(componentArb, { selector: (component) => component.id, maxLength: 3 }),
  properties: propertiesArb,
  suppressedComponentSourceIds: fc.subarray(["p1", "p2"]),
  folderId: fc.constantFrom(null, ...FOLDER_IDS),
}, { requiredKeys: ["id", "name", "classId", "parentId", "transform", "visible", "locked", "components", "folderId"] });

const folderArb: fc.Arbitrary<SerializedOutlinerFolder> = fc.record({
  id: fc.constantFrom(...FOLDER_IDS),
  name: fc.constantFrom("One", "Two"),
  parentFolderId: fc.constantFrom(null, ...FOLDER_IDS),
});

const sceneArb: fc.Arbitrary<SerializedScene> = fc.record({
  name: fc.constantFrom("Main", "Level"),
  viewportMode: fc.constantFrom("3d" as const, "2d" as const),
  fogEnabled: fc.boolean(),
  celShading: fc.option(fc.constantFrom({}, { shadowBands: 3 }), { nil: undefined }),
  folders: fc.uniqueArray(folderArb, { selector: (folder) => folder.id, maxLength: 3 }),
  actors: fc.uniqueArray(actorArb, { selector: (actor) => actor.id, maxLength: 4 }),
  overlayEditor: fc.boolean(),
}, { requiredKeys: ["name", "viewportMode", "fogEnabled", "folders", "actors"] }).map(({ fogEnabled, celShading, ...scene }) => {
  const settings = { ...createDefaultScene().settings, fogEnabled };
  if (celShading) settings.celShading = celShading;
  else delete settings.celShading;
  return { ...scene, settings };
});

describe("diffSceneCommands round trip", () => {
  it("reproduces every authored scene field, undoes exactly, and replays from the journal", () => {
    fc.assert(
      fc.property(sceneArb, sceneArb, (before, after) => {
        const commands = diffSceneCommands(before, after);
        const session = new EditSession();
        const applied = session.applyBatch("scene", before, commands)?.doc ?? before;
        expect(applied).toEqual(after);
        expect(session.undo("scene", applied)?.doc ?? applied).toEqual(before);

        let replayed = before;
        for (const command of commands) {
          const line = JSON.parse(JSON.stringify(commandToJournalPayload(command))) as { type: string };
          replayed = reviveCommand(line)!.apply(replayed) as SerializedScene;
        }
        expect(replayed).toEqual(after);
        // The deltas alone suffice; the whole-scene safety net stays unused.
        expect(planSceneChange(before, after).map((command) => command.type)).not.toContain("scene.replace");
      }),
      { numRuns: 300 },
    );
  });
});

describe("planSceneChange", () => {
  it("is empty for an equal scene, including one that differs only by undefined keys", () => {
    const before = baseScene();
    const after = structuredClone(before);
    after.actors[0]!.components[0]!.properties.unset = undefined;
    expect(planSceneChange(before, after)).toEqual([]);
  });

  it("keeps an unrepresented field undoable through one scene replacement", () => {
    const before = baseScene();
    const after = structuredClone(before);
    after.name = "Renamed";
    (after.actors[0] as SerializedActor & { tags?: string[] }).tags = ["enemy"];

    const commands = planSceneChange(before, after);
    expect(commands.map((command) => command.type)).toEqual(["scene.replace"]);
    const session = new EditSession();
    const applied = session.applyBatch("scene", before, commands)!.doc;
    expect(applied).toEqual(after);
    expect(session.undo("scene", applied)!.doc).toEqual(before);
    const line = JSON.parse(JSON.stringify(commandToJournalPayload(commands[0]!))) as { type: string };
    expect(reviveCommand(line)!.apply(before)).toEqual(after);
  });

  it("does not let the safety net move a 2D anchor the commands refuse to move", () => {
    const before = baseScene();
    before.actors.push(createActor("pin", "Pin", {
      components: [{ id: "anchor", classId: "2DAnchorComponent", properties: {} }],
    }));
    const after = structuredClone(before);
    after.actors[2]!.transform.position = [4, 5, 6];
    expect(planSceneChange(before, after)).toEqual([]);

    after.actors[2]!.name = "Renamed Pin";
    const commands = planSceneChange(before, after);
    expect(commands.map((command) => command.type)).not.toContain("scene.replace");
    const applied = commands.reduce<SerializedScene>((doc, command) => command.apply(doc), before);
    expect(applied.actors[2]!.name).toBe("Renamed Pin");
    expect(applied.actors[2]!.transform).toEqual(before.actors[2]!.transform);
  });
});
