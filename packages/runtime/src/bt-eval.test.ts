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
  it("emits btState from BehaviourTreeComponent each tick", () => {
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
});
