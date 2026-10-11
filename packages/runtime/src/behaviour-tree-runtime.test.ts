import { describe, expect, it } from "vitest";
import type { CommandMessage } from "@babylonslate/bridge";
import { createActor, createDefaultSceneSettings, type SerializedScene } from "@babylonslate/core";
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
});
