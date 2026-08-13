import { describe, expect, it } from "vitest";
import type { CommandMessage } from "@babylonslate/bridge";
import { createDefaultAnimGraph } from "@babylonslate/anim-graph";
import {
  createActor,
  createDefaultSceneSettings,
  type SerializedScene,
} from "@babylonslate/core";
import { createInProcessRuntime } from "./driver";

function animScene(): SerializedScene {
  return {
    name: "Anim",
    viewportMode: "3d",
    settings: createDefaultSceneSettings(),
    actors: [
      createActor("hero", "Hero", {
        components: [
          {
            id: "anim-1",
            classId: "AnimationGraphComponent",
            properties: { graphGuid: "graph-1" },
          },
        ],
      }),
    ],
  };
}

describe("runtime AnimationGraph evaluation", () => {
  it("emits animState from AnimationGraphComponent each tick", () => {
    const commands: CommandMessage[] = [];
    const graph = createDefaultAnimGraph("Hero");
    const runtime = createInProcessRuntime({
      seed: 1,
      maxActors: 4,
      seedDemoActors: false,
      playScene: animScene(),
      animGraphs: { "graph-1": graph },
      onCommand: (command) => commands.push(command),
    });
    runtime.start();
    runtime.realizePlayWorld();
    runtime.tick();
    const anim = commands.filter((command) => command.type === "animState");
    expect(anim).toHaveLength(1);
    expect(anim[0]).toMatchObject({
      type: "animState",
      stateId: "idle",
      clipName: "Idle",
      clipKind: "animation",
    });
    if (anim[0]?.type === "animState") {
      expect(anim[0].normalisedTime).toBeGreaterThan(0);
      expect(anim[0].blendWeights.idle).toBe(1);
    }
    runtime.stop();
  });

  it("registerAnimGraph is enough when the graph was not in options", () => {
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({
      seed: 1,
      maxActors: 4,
      seedDemoActors: false,
      playScene: animScene(),
      onCommand: (command) => commands.push(command),
    });
    runtime.registerAnimGraph("graph-1", createDefaultAnimGraph());
    runtime.start();
    runtime.realizePlayWorld();
    runtime.tick();
    expect(commands.some((command) => command.type === "animState")).toBe(true);
    runtime.stop();
  });
});
