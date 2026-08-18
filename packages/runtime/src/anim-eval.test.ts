import { describe, expect, it } from "vitest";
import type { CommandMessage } from "@babylonslate/bridge";
import {
  createDefaultAnimGraph,
  createDefaultTransitionRuleGraph,
} from "@babylonslate/anim-graph";
import {
  createActor,
  createDefaultSceneSettings,
  type SerializedScene,
} from "@babylonslate/core";
import {
  createDefaultSpriteAnimationPayload,
  createDefaultSpritePayload,
} from "@babylonslate/assets";
import { createInProcessRuntime } from "./driver";

function animScene(): SerializedScene {
  return {
    name: "Anim",
    viewportMode: "3d",
    settings: createDefaultSceneSettings(),
    folders: [],
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

  it("clears the Sprite Animation collider when the graph leaves a sprite clip", () => {
    const graph = createDefaultAnimGraph();
    graph.clips[0] = {
      id: "idle-clip",
      kind: "sprite",
      assetGuid: "walk-anim",
      clipName: "",
      durationMs: 100,
    };
    graph.states.push({
      id: "run",
      name: "Run",
      clipId: "run-clip",
      speed: 1,
      loop: true,
      position: { x: 300, y: 80 },
    });
    graph.clips.push({
      id: "run-clip",
      kind: "animation",
      assetGuid: "hero-model",
      clipName: "Run",
      durationMs: 400,
    });
    graph.parameters = ["moving"];
    graph.transitions.push({
      id: "idle-to-run",
      fromStateId: "idle",
      toStateId: "run",
      condition: "moving",
      blendSeconds: 0,
      hasExitTime: false,
      exitTime: 0,
      priority: 0,
      ruleGraph: createDefaultTransitionRuleGraph(),
    });

    const sprite = createDefaultSpritePayload();
    sprite.pixelsPerUnit = 100;
    sprite.frames[0]!.width = 100;
    sprite.frames[0]!.height = 100;
    sprite.frames[0]!.collision = { x: 0, y: 0, width: 1, height: 1 };
    const animation = createDefaultSpriteAnimationPayload();
    animation.frames[0] = {
      textureGuid: "tex-walk",
      durationMs: 100,
      pivot: { x: 0.5, y: 0.5 },
      collision: { x: 0.5, y: 0, width: 0.5, height: 1 },
      width: 100,
      height: 100,
    };

    const runtime = createInProcessRuntime({
      seed: 1,
      maxActors: 4,
      seedDemoActors: false,
      preferSoftwarePhysics: true,
      physicsWorld: "2d",
      playScene: {
        name: "Anim",
        viewportMode: "2d",
        settings: createDefaultSceneSettings("2d"),
        folders: [],
        actors: [
          createActor("hero", "Hero", {
            components: [
              {
                id: "rb",
                classId: "RigidBodyComponent",
                properties: { motionType: "static", mass: 0, gravityScale: 0 },
              },
              {
                id: "col",
                classId: "ColliderComponent",
                properties: {
                  shape: { kind: "box2d", halfExtents: { x: 0.5, y: 0.5 } },
                },
              },
              {
                id: "spr",
                classId: "SpriteComponent",
                properties: { assetGuid: "hero-sprite" },
              },
              {
                id: "anim-1",
                classId: "AnimationGraphComponent",
                properties: { graphGuid: "graph-1" },
              },
            ],
          }),
        ],
      },
      animGraphs: { "graph-1": graph },
      sprites: { "hero-sprite": sprite },
      spriteAnimations: { "walk-anim": animation },
      pixelsPerUnit: 100,
    });
    runtime.start();
    runtime.realizePlayWorld();
    runtime.tick();
    runtime.tick();

    const backend = runtime.getPhysicsSync()?.getBackend();
    expect(backend).toBeTruthy();
    expect(
      backend!.sphereOverlap({ x: 0.25, y: 0, z: 0 }, 0.05).actorIds,
    ).toContain("hero");
    expect(
      backend!.sphereOverlap({ x: -0.4, y: 0, z: 0 }, 0.05).actorIds,
    ).toEqual([]);

    const component = runtime
      .getWorld()
      .getActors()
      .find((actor) => actor.guid === "hero")
      ?.components.find((entry) => entry.classId === "AnimationGraphComponent");
    component?.setVariable("conditions", { moving: true });
    runtime.tick();
    runtime.tick();

    expect(
      backend!.sphereOverlap({ x: -0.4, y: 0, z: 0 }, 0.05).actorIds,
    ).toContain("hero");
    runtime.stop();
  });
});
