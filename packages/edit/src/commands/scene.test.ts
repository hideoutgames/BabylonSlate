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
  RemoveActorCommand,
  RemoveComponentCommand,
  RenameActorCommand,
  ReorderActorCommand,
  ReorderComponentCommand,
  ReparentActorCommand,
  SetActorFlagsCommand,
  SetActorTransformCommand,
  SetComponentPropertyCommand,
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
    actors: [
      createActor("a", "A", {
        components: [createMeshComponent("c1", "box")],
      }),
      createActor("b", "B", { parentId: "a" }),
    ],
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

  it("replaying derived commands reproduces the after document", () => {
    const before = baseScene();
    const after = structuredClone(before);
    after.actors[0]!.name = "Renamed";
    after.actors[0]!.transform.position = [3, 4, 5];
    after.actors.push(createActor("c", "C"));

    let doc = before;
    for (const command of diffSceneCommands(before, after)) {
      doc = command.apply(doc);
    }
    expect(doc).toEqual(after);
  });
});
