import { describe, expect, it } from "vitest";
import type { CommandMessage } from "@babylonslate/bridge";
import { createDefaultBehaviourTree } from "@babylonslate/behaviour-tree";
import {
  createActor,
  createDefaultSceneSettings,
  type SerializedScene,
} from "@babylonslate/core";
import { createInProcessRuntime } from "./driver";

function aiScene(properties: Record<string, unknown>): SerializedScene {
  return {
    name: "AI",
    viewportMode: "3d",
    settings: createDefaultSceneSettings(),
    folders: [],
    actors: [
      createActor("guard", "Guard", {
        components: [
          {
            id: "bt-1",
            classId: "BehaviourTreeComponent",
            properties,
          },
        ],
      }),
    ],
  };
}

describe("runtime behaviour tree evaluation", () => {
  it("safely inspects cyclic and bigint custom blackboard values without changing runtime values", async () => {
    const commands: CommandMessage[] = [];
    const tree = createDefaultBehaviourTree("Custom Logic");
    tree.nodes.find((node) => node.kind === "task")!.classId = "CustomTask";
    const runtime = createInProcessRuntime({
      seed: 1, seedDemoActors: false,
      playScene: aiScene({ treeGuid: "tree-1" }),
      behaviourTrees: { "tree-1": tree },
      onCommand: (command) => commands.push(command),
    });
    await runtime.loadScripts([{
      assetGuid: "custom-task", classId: "CustomTask", parentClassId: "BTTask",
      source: `export function onBtTick(ctx) {
        const prior = ctx.getBlackboard("cycle");
        if (prior) ctx.setBlackboard("preserved", prior.self === prior && typeof ctx.getBlackboard("large") === "bigint");
        else { const cycle = {}; cycle.self = cycle; ctx.setBlackboard("cycle", cycle); ctx.setBlackboard("large", 5n); }
      }`,
      anchors: [], entryPoints: [{ name: "onBtTick", event: "onBtTick", isAsync: false }],
    }]);
    runtime.start();
    runtime.realizePlayWorld();
    runtime.executeConsoleCommand("behaviourtreedebug on");
    expect(() => runtime.tick()).not.toThrow();
    runtime.tick();
    runtime.executeConsoleCommand("behaviourtreedebug on");
    const snapshot = commands.filter((command) => command.type === "behaviourTreeSnapshot").at(-1);
    expect(snapshot).toMatchObject({ trees: [{ blackboard: { cycle: expect.stringContaining("self"), large: "5n", preserved: true } }] });
    expect(() => JSON.stringify(snapshot)).not.toThrow();
    const graphState = commands.filter((command) => command.type === "btState").at(-1);
    expect(() => JSON.stringify(graphState)).not.toThrow();
    runtime.stop();
  });

  it("does not give a newly spawned tree the completed state of a despawned actor", async () => {
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({
      seed: 1, seedDemoActors: false,
      playScene: aiScene({ treeGuid: "tree-1" }),
      behaviourTrees: { "tree-1": createDefaultBehaviourTree("Guard Logic") },
      onCommand: (command) => commands.push(command),
    });
    await runtime.loadScripts([{
      assetGuid: "replacement-script", classId: "Replacement", parentClassId: "Actor",
      source: "export function onTick() {}", anchors: [],
      entryPoints: [{ name: "onTick", event: "onTick", isAsync: false }],
    }]);
    runtime.start();
    runtime.realizePlayWorld();
    runtime.tick();
    runtime.getWorld().destroyActor("guard");
    runtime.tick();
    const replacement = runtime.spawnScriptedActor({ classId: "Replacement", variables: { name: "Replacement" } });
    expect(replacement).not.toBeNull();
    replacement!.attachComponent(runtime.getWorld().createComponent({
      classId: "BehaviourTreeComponent", variables: { treeGuid: "tree-1" },
    }));
    runtime.pause();
    runtime.executeConsoleCommand("behaviourtreedebug on");
    expect(commands.filter((command) => command.type === "behaviourTreeSnapshot").at(-1)).toMatchObject({
      trees: [{ actorName: "Replacement", status: "idle", lastResults: {}, stack: [] }],
    });
    runtime.stop();
  });

  it("opens with the current paused tree, names its actor and nodes, and clears removals", () => {
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({
      seed: 1, seedDemoActors: false,
      playScene: aiScene({ treeGuid: "tree-1" }),
      behaviourTrees: { "tree-1": createDefaultBehaviourTree("Guard Logic") },
      onCommand: (command) => commands.push(command),
    });
    runtime.start();
    runtime.realizePlayWorld();
    runtime.tick();
    runtime.pause();
    expect(runtime.executeConsoleCommand("behaviourtreedebug on").success).toBe(true);
    expect(commands).toContainEqual({ type: "setBehaviourTreeDebug", enabled: true });
    const snapshot = commands.find((command) => command.type === "behaviourTreeSnapshot");
    expect(snapshot).toMatchObject({ trees: [{ actorGuid: "guard", actorName: "Guard", treeGuid: "tree-1", treeName: "Guard Logic", status: "success" }] });
    expect(snapshot?.type === "behaviourTreeSnapshot" && snapshot.trees[0]?.nodes.length).toBeGreaterThan(0);
    runtime.getWorld().destroyActor("guard");
    runtime.getWorld().flushPending();
    runtime.executeConsoleCommand("behaviourtreedebug on");
    expect(commands.filter((command) => command.type === "behaviourTreeSnapshot").at(-1)).toEqual({ type: "behaviourTreeSnapshot", trees: [] });
    runtime.executeConsoleCommand("behaviourtreedebug off");
    const count = commands.filter((command) => command.type === "behaviourTreeSnapshot").length;
    runtime.resume();
    runtime.tick();
    expect(commands.filter((command) => command.type === "behaviourTreeSnapshot")).toHaveLength(count);
    runtime.stop();
  });

  it("emits btState from BehaviourTreeComponent and skips identical repeats", () => {
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({
      seed: 1,
      maxActors: 4,
      seedDemoActors: false,
      playScene: aiScene({ treeGuid: "tree-1" }),
      behaviourTrees: { "tree-1": createDefaultBehaviourTree("Guard") },
      onCommand: (command) => commands.push(command),
    });
    runtime.start();
    runtime.realizePlayWorld();
    runtime.tick();
    const states = commands.filter((command) => command.type === "btState");
    expect(states).toHaveLength(1);
    expect(states[0]).toMatchObject({
      type: "btState",
      status: "success",
      btNodeId: null,
    });
    runtime.tick();
    runtime.tick();
    expect(commands.filter((command) => command.type === "btState")).toHaveLength(
      1,
    );
    runtime.stop();
  });

  it("registerBehaviourTree is enough when the tree was not in options", () => {
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({
      seed: 1,
      maxActors: 4,
      seedDemoActors: false,
      playScene: aiScene({ treeGuid: "tree-1" }),
      onCommand: (command) => commands.push(command),
    });
    runtime.registerBehaviourTree("tree-1", createDefaultBehaviourTree());
    runtime.start();
    runtime.realizePlayWorld();
    runtime.tick();
    expect(commands.some((command) => command.type === "btState")).toBe(true);
    runtime.stop();
  });

  it("emits a diagnostic when the tree guid is missing", () => {
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({
      seed: 1,
      maxActors: 4,
      seedDemoActors: false,
      playScene: aiScene({}),
      onCommand: (command) => commands.push(command),
    });
    runtime.start();
    runtime.realizePlayWorld();
    runtime.tick();
    const diags = commands.filter((command) => command.type === "diagnostic");
    expect(diags.some((command) => command.type === "diagnostic" && command.code === "bt.missing_tree")).toBe(
      true,
    );
    runtime.stop();
  });

  it("records BT stack/blackboard and restores them from the trace", () => {
    const waitTree = {
      name: "Wait",
      rootId: "wait",
      blackboardGuid: null,
      nodes: [
        {
          id: "wait",
          kind: "task" as const,
          classId: "bt.task.wait",
          children: [],
          decorators: [],
          services: [],
          properties: { durationMs: 1000 },
        },
      ],
    };
    const options = {
      seed: 1,
      maxActors: 4,
      seedDemoActors: false as const,
      playScene: aiScene({ treeGuid: "tree-1" }),
      behaviourTrees: { "tree-1": waitTree },
      dt: 0.1,
    };
    const recorded = createInProcessRuntime(options);
    recorded.start();
    recorded.realizePlayWorld();
    recorded.executeConsoleCommand("snapshot start");
    recorded.tick();
    recorded.tick();
    recorded.executeConsoleCommand("snapshot stop");
    const payload = recorded.stopTrace();
    const last = payload?.frames.at(-1)?.bt?.[0];
    expect(last?.btNodeId).toBe("wait");
    expect(last?.stack.some((frame) => frame.nodeId === "wait")).toBe(true);
    const elapsed = Number(last?.nodeMemory?.wait?.elapsedMs ?? 0);
    expect(elapsed).toBeGreaterThan(100);
    recorded.stop();

    const replay = createInProcessRuntime(options);
    replay.start();
    replay.realizePlayWorld();
    replay.restoreBtFromTrace(payload!.frames.at(-1)!.bt!);
    replay.executeConsoleCommand("snapshot start");
    replay.tick();
    replay.executeConsoleCommand("snapshot stop");
    const restored = replay.stopTrace()?.frames[0]?.bt?.[0];
    expect(Number(restored?.nodeMemory?.wait?.elapsedMs ?? 0)).toBeGreaterThan(
      elapsed,
    );
    replay.stop();
  });

  it("Play Sound succeeds when the Audio guid is in the Play library", () => {
    const tree = {
      name: "Sound",
      rootId: "sound",
      blackboardGuid: null,
      nodes: [
        {
          id: "sound",
          kind: "task" as const,
          classId: "bt.task.playSound",
          children: [],
          decorators: [],
          services: [],
          properties: { audioAssetGuid: "audio-1", volume: 0.4 },
        },
      ],
    };
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({
      seed: 1,
      maxActors: 4,
      seedDemoActors: false,
      playScene: aiScene({ treeGuid: "tree-1" }),
      behaviourTrees: { "tree-1": tree },
      audioAssetGuids: ["audio-1"],
      onCommand: (command) => commands.push(command),
    });
    runtime.start();
    runtime.realizePlayWorld();
    runtime.tick();
    expect(commands.filter((command) => command.type === "playSound")).toEqual([
      expect.objectContaining({
        type: "playSound",
        assetGuid: "audio-1",
        volume: 0.4,
        emitterActorGuid: "guard",
      }),
    ]);
    const states = commands.filter((command) => command.type === "btState");
    expect(states.at(-1)).toMatchObject({ status: "success" });
    runtime.stop();
  });

  it("Play Sound fails when the Audio guid is missing from the Play library", () => {
    const tree = {
      name: "Sound",
      rootId: "sound",
      blackboardGuid: null,
      nodes: [
        {
          id: "sound",
          kind: "task" as const,
          classId: "bt.task.playSound",
          children: [],
          decorators: [],
          services: [],
          properties: { audioAssetGuid: "missing" },
        },
      ],
    };
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({
      seed: 1,
      maxActors: 4,
      seedDemoActors: false,
      playScene: aiScene({ treeGuid: "tree-1" }),
      behaviourTrees: { "tree-1": tree },
      audioAssetGuids: ["audio-1"],
      onCommand: (command) => commands.push(command),
    });
    runtime.start();
    runtime.realizePlayWorld();
    runtime.tick();
    expect(commands.filter((command) => command.type === "playSound")).toEqual([]);
    expect(commands.filter((command) => command.type === "btState").at(-1)).toMatchObject({
      status: "failure",
    });
    runtime.stop();
  });
});
