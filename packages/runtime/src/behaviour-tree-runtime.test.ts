import { describe, expect, it } from "vitest";
import type { CommandMessage } from "@babylonslate/bridge";
import { createActor, createDefaultSceneSettings, quaternionToEulerDegrees, type SerializedScene } from "@babylonslate/core";
import type { BehaviourTreeDocument, BlackboardDocument } from "@babylonslate/behaviour-tree";
import { createInProcessRuntime } from "./driver";

type BtNode = BehaviourTreeDocument["nodes"][number];

const task = (id: string, classId: string, properties: Record<string, unknown> = {}): BtNode =>
  ({ id, kind: "task", classId, children: [], decorators: [], services: [], properties });
const sequence = (children: string[]): BtNode =>
  ({ id: "root", kind: "sequence", classId: "bt.composite.sequence", children, decorators: [], services: [], properties: {} });
const board = (name: string, defaultValue: string[]): BlackboardDocument =>
  ({ name, keys: [{ name: "items", type: { kind: "array", element: { kind: "string" } }, defaultValue }] });

function guardScene(): SerializedScene {
  return {
    name: "AI", viewportMode: "3d", settings: createDefaultSceneSettings(), folders: [],
    actors: [createActor("guard", "Guard", {
      components: [{ id: "bt-1", classId: "BehaviourTreeComponent", properties: { treeGuid: "tree-1" } }],
    })],
  };
}

const btStates = (commands: readonly CommandMessage[]) =>
  commands.flatMap((command) => command.type === "btState" ? [command] : []);

describe("BehaviourTreeRuntime", () => {
  it("stops every Play Sound voice the tree started when the actor's slot is released", () => {
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({
      seed: 1, maxActors: 4, seedDemoActors: false, playScene: guardScene(),
      behaviourTrees: { "tree-1": { name: "Host", rootId: "root", blackboardGuid: null, nodes: [
        sequence(["first", "second", "wait"]),
        task("first", "bt.task.playSound", { audioAssetGuid: "audio-1" }),
        task("second", "bt.task.playSound", { audioAssetGuid: "audio-1" }),
        task("wait", "bt.task.wait", { durationMs: 2000 }),
      ] } },
      audioAssetGuids: ["audio-1"],
      onCommand: (command) => commands.push(command),
    });
    try {
      runtime.start();
      runtime.realizePlayWorld();
      runtime.tick();
      expect(commands.flatMap((command) => command.type === "playSound" ? [command.voiceId] : []))
        .toEqual(["bt:guard:first", "bt:guard:second"]);

      commands.length = 0;
      runtime.getWorld().destroyActor("guard");
      runtime.tick();
      expect(commands.filter((command) => command.type === "stopSound")).toEqual([
        { type: "stopSound", voiceId: "bt:guard:first" },
        { type: "stopSound", voiceId: "bt:guard:second" },
      ]);
    } finally { runtime.stop(); }
  });

  it("aborts the old tree and starts a replacement tree at its root with its own Blackboard defaults", async () => {
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({
      seed: 1, maxActors: 4, seedDemoActors: false, dt: 0.1, playScene: guardScene(),
      behaviourTrees: {
        "tree-1": { name: "Old", rootId: "root", blackboardGuid: "board-1", nodes: [
          sequence(["push", "sound", "wait"]),
          task("push", "BTTask_Push"),
          task("sound", "bt.task.playSound", { audioAssetGuid: "audio-1" }),
          task("wait", "bt.task.wait", { durationMs: 2000 }),
        ] },
        "tree-2": { name: "New", rootId: "idle", blackboardGuid: "board-2", nodes: [task("idle", "bt.task.wait", { durationMs: 2000 })] },
      },
      blackboards: { "board-1": board("One", []), "board-2": board("Two", ["fresh"]) },
      audioAssetGuids: ["audio-1"],
      onCommand: (command) => commands.push(command),
    });
    try {
      await runtime.loadScripts([{ assetGuid: "push", classId: "BTTask_Push", anchors: [],
        source: 'export function activate(ctx) { ctx.getBlackboard("items").push("pushed"); ctx.btFinish("success"); }',
        entryPoints: [{ name: "activate", event: "onActivate", isAsync: false }] }]);
      runtime.start();
      runtime.realizePlayWorld();
      runtime.tick();
      expect(btStates(commands).at(-1)).toMatchObject({ btNodeId: "wait", blackboard: { items: ["pushed"] } });

      const tree = runtime.getWorld().findActor("guard")!.components
        .find((component) => component.classId === "BehaviourTreeComponent")!;
      commands.length = 0;
      tree.setVariable("treeGuid", "tree-2");
      runtime.tick();
      expect(commands.filter((command) => command.type === "stopSound")).toEqual([
        { type: "stopSound", voiceId: "bt:guard:sound" },
      ]);
      expect(btStates(commands).at(-1)).toMatchObject({ btNodeId: "idle", blackboard: { items: ["fresh"] } });

      // Running the first tree again starts from its authored default, which the earlier push left untouched.
      commands.length = 0;
      tree.setVariable("treeGuid", "tree-1");
      runtime.tick();
      expect(btStates(commands).at(-1)).toMatchObject({ btNodeId: "wait", blackboard: { items: ["pushed"] } });
    } finally { runtime.stop(); }
  });

  it("publishes a Blackboard when a task replaces or edits a value in place, and nothing while it is unchanged", async () => {
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({
      seed: 1, maxActors: 4, seedDemoActors: false, dt: 0.1, playScene: guardScene(),
      behaviourTrees: { "tree-1": { name: "Edit", rootId: "edit", blackboardGuid: "board-1", nodes: [task("edit", "BTTask_Edit")] } },
      blackboards: { "board-1": { name: "Edits", keys: [
        { name: "list", type: { kind: "array", element: { kind: "string" } }, defaultValue: ["a"] },
        { name: "nested", type: { kind: "objectRef", classId: "BObject" }, defaultValue: { hits: 0, tags: ["a"] } },
        { name: "lookup", type: { kind: "map", key: { kind: "string" }, value: { kind: "string" } }, defaultValue: new Map([["a", 1]]) },
      ] } },
      onCommand: (command) => commands.push(command),
    });
    try {
      await runtime.loadScripts([{ assetGuid: "edit", classId: "BTTask_Edit", anchors: [],
        source: `export function onBtTick(ctx) {
          const step = ctx.self.getVariable("step");
          if (step === "push") ctx.getBlackboard("list").push("b");
          if (step === "deep") ctx.getBlackboard("nested").tags[0] = "changed";
          if (step === "reference") ctx.setBlackboard("target", ctx.self);
          if (step === "loop") { const loop = {}; loop.self = loop; ctx.setBlackboard("loop", loop); }
          if (step === "map-edit") ctx.getBlackboard("lookup").set("a", 2);
        }`,
        entryPoints: [{ name: "onBtTick", event: "onBtTick", isAsync: false }] }]);
      runtime.start();
      runtime.realizePlayWorld();
      const guard = runtime.getWorld().findActor("guard")!;
      const published = () => btStates(commands).length;
      /** Runs one tick doing `step` and returns the Blackboard published by it, if any. */
      const tickWith = (step: string) => {
        const before = published();
        guard.setVariable("step", step);
        runtime.tick();
        return published() > before ? btStates(commands).at(-1)!.blackboard : undefined;
      };
      expect(tickWith("none")).toEqual({ list: ["a"], nested: { hits: 0, tags: ["a"] }, lookup: { a: 1 } });
      expect(tickWith("none")).toBeUndefined();
      expect(tickWith("push")).toMatchObject({ list: ["a", "b"] });
      expect(tickWith("none")).toBeUndefined();
      expect(tickWith("deep")).toMatchObject({ nested: { tags: ["changed"] } });
      expect(tickWith("none")).toBeUndefined();
      expect(tickWith("reference")).toMatchObject({ target: { guid: "guard" } });
      expect(tickWith("none")).toBeUndefined();
      expect(tickWith("loop")).toMatchObject({ loop: expect.stringContaining("self") });
      expect(tickWith("none")).toBeUndefined();
      expect(tickWith("map-edit")).toMatchObject({ lookup: { a: 2 } });
      expect(tickWith("none")).toBeUndefined();
    } finally { runtime.stop(); }
  });

  it("Rotate To Face turns a dynamic physics body so the next step keeps the new heading", async () => {
    const scene = guardScene();
    scene.actors[0]!.components.push(
      { id: "body", classId: "RigidBodyComponent", properties: { motionType: "dynamic", mass: 1, gravityScale: 0 } },
      { id: "col", classId: "ColliderComponent", properties: { shape: { kind: "box", halfExtents: { x: 0.5, y: 0.5, z: 0.5 } } } },
    );
    const runtime = createInProcessRuntime({
      seed: 1, maxActors: 4, seedDemoActors: false, preferSoftwarePhysics: true, playScene: scene,
      behaviourTrees: { "tree-1": { name: "Face", rootId: "root", blackboardGuid: null, nodes: [
        sequence(["face", "wait"]),
        task("face", "bt.task.rotateToFace", { target: { x: 1, y: 0, z: 0 } }),
        task("wait", "bt.task.wait", { durationMs: 2000 }),
      ] } },
    });
    try {
      await runtime.realizePlayWorld();
      runtime.start();
      runtime.tick();
      runtime.tick();
      const { rotation } = runtime.getWorld().findActor("guard")!.transform;
      expect(quaternionToEulerDegrees([rotation.x, rotation.y, rotation.z, rotation.w])[1]).toBeCloseTo(90, 3);
    } finally { runtime.stop(); }
  });
});
