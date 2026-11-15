import { describe, expect, it } from "vitest";
import type { CommandMessage } from "@haptic/bridge";
import { animRuleScriptClassId, createDefaultAnimGraph } from "@haptic/anim-graph";
import {
  createActor,
  createDefaultSceneSettings,
  createDefaultSceneLayer,
  type SerializedScene,
} from "@haptic/core";
import {
  createDefaultSpriteAnimationPayload,
  createDefaultSpritePayload,
} from "@haptic/assets";
import {
  compileTransitionRuleGraph,
  type GraphNode,
  type NodeRegistry,
} from "@haptic/scripting";
import { createDefaultNodeRegistry } from "@haptic/scripting-nodes";
import { addClipState, addTransition, setStateClip } from "./anim-graph-test-fixtures";
import { createInProcessRuntime } from "./driver";
import type { CompiledScript } from "./script-host";

function ruleNode(
  registry: NodeRegistry,
  id: string,
  typeId: string,
  properties: Record<string, unknown> = {},
): GraphNode {
  const def = registry.get(typeId);
  if (!def) throw new Error(`missing node ${typeId}`);
  return { id, typeId, position: { x: 0, y: 0 }, pins: def.pins(properties), properties };
}

/** Compiled rule for `graph-1` that holds the transition until the bool variable `moving` is true. */
function movingRuleScript(transitionId: string): CompiledScript {
  const registry = createDefaultNodeRegistry();
  const assetGuid = `assets/Hero.anim3d.hasset#${transitionId}`;
  const compiled = compileTransitionRuleGraph(
    {
      id: transitionId,
      kind: "event",
      nodes: [
        ruleNode(registry, "enter-state", "anim.rule.enterState"),
        ruleNode(registry, "exit-state", "anim.rule.exitState"),
        ruleNode(registry, "get-moving", "variables.get", {
          variableName: "moving",
          typeId: "bool",
          implicitSelf: true,
        }),
      ],
      edges: [
        {
          id: "e-exit",
          sourceNodeId: "get-moving",
          sourcePinId: "value",
          targetNodeId: "exit-state",
          targetPinId: "value",
        },
      ],
    },
    { assetGuid, registry },
  );
  return {
    assetGuid,
    classId: animRuleScriptClassId("graph-1", transitionId),
    source: compiled.source,
    anchors: compiled.anchors,
    entryPoints: compiled.entryPoints,
    parentClassId: "Object",
  };
}

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
    setStateClip(graph, "idle", { assetGuid: "hero-idle", clipName: "Idle" });
    const runtime = createInProcessRuntime({
      seed: 1,
      maxActors: 4,
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

  it.each(["world", "SceneLayer"])(
    "clears the %s Sprite Animation collider when the graph leaves a sprite clip",
    async (owner) => {
      const graph = createDefaultAnimGraph();
      setStateClip(graph, "idle", { assetGuid: "walk-anim", durationMs: 100 }, "2d");
      addClipState(graph, "run", "Run", { assetGuid: "hero-model", clipName: "Run", durationMs: 400 });
      graph.variables = [
        { id: "var-moving", name: "moving", typeId: "bool", defaultValue: false },
      ];
      addTransition(graph, "idle-to-run", "idle", "run");

      const sprite = createDefaultSpritePayload();
      sprite.pixelsPerUnit = 100;
      sprite.width = 100;
      sprite.height = 100;
      sprite.collision = { x: 0, y: 0, width: 1, height: 1 };
      const animation = createDefaultSpriteAnimationPayload();
      animation.frames[0] = {
        textureGuid: "tex-walk",
        durationMs: 100,
        pivot: { x: 0.5, y: 0.5 },
        collision: { x: 0.5, y: 0, width: 0.5, height: 1 },
        width: 100,
        height: 100,
      };

      const scene: SerializedScene = {
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
      };
      const runtime = createInProcessRuntime({
        seed: 1,
        maxActors: 4,
        preferSoftwarePhysics: true,
        physicsWorld: "2d",
        playScene: owner === "world" ? scene : { ...scene, actors: [] },
        sceneLayerLibrary:
          owner === "SceneLayer"
            ? {
                overlay: {
                  ...createDefaultSceneLayer(),
                  settings: { ...createDefaultSceneLayer().settings, physicsEnabled: true },
                  actors: scene.actors,
                },
              }
            : {},
        animGraphs: { "graph-1": graph },
        sprites: { "hero-sprite": sprite },
        spriteAnimations: { "walk-anim": animation },
        pixelsPerUnit: 100,
      });
      await runtime.loadScripts([movingRuleScript("idle-to-run")]);
      runtime.start();
      runtime.realizePlayWorld();
      const layer = owner === "SceneLayer" ? runtime.createSceneLayer("overlay") : null;
      // Scene Layer actor guids are scoped to their layer instance.
      const hero = layer ? layer.guid + ":hero" : "hero";
      runtime.tick();
      runtime.tick();

      const backend = (
        owner === "SceneLayer"
          ? runtime.getSceneLayerPhysicsSync(layer!.guid)
          : runtime.getPhysicsSync()
      )?.getBackend();
      expect(backend).toBeTruthy();
      expect(
        backend!.sphereOverlap({ x: 0.25, y: 0, z: 0 }, 0.05).actorIds,
      ).toContain(hero);
      expect(
        backend!.sphereOverlap({ x: -0.4, y: 0, z: 0 }, 0.05).actorIds,
      ).toEqual([]);

      const component = runtime
        .getWorld()
        .getActors()
        .find((actor) => actor.guid === hero)
        ?.components.find(
          (entry) => entry.classId === "AnimationGraphComponent",
        );
      expect(component).toBeDefined();
      component!.setVariable("moving", true);
      runtime.tick();
      runtime.tick();

      expect(
        backend!.sphereOverlap({ x: -0.4, y: 0, z: 0 }, 0.05).actorIds,
      ).toContain(hero);
      runtime.stop();
    },
  );
});
