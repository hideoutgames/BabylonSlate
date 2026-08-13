import { describe, expect, it } from "vitest";
import type { CommandMessage } from "@babylonslate/bridge";
import {
  createActor,
  createDefaultSceneSettings,
  createMeshComponent,
  type SerializedScene,
} from "@babylonslate/core";
import {
  compileGraph,
  type GraphNode,
  type LogicGraph,
  type NodeRegistry,
} from "@babylonslate/scripting";
import { createDefaultNodeRegistry } from "@babylonslate/scripting-nodes";
import { createInProcessRuntime } from "./driver";
import { createRuntimeFromLoad } from "./play-load";
import type { CompiledScript } from "./script-host";

function fallingBoxScene(): SerializedScene {
  return {
    name: "Fall",
    viewportMode: "3d",
    settings: createDefaultSceneSettings("3d"),
    actors: [
      createActor("dynamic-box", "Box", {
        transform: {
          position: [0, 5, 0],
          rotation: [0, 0, 0, 1],
          scale: [1, 1, 1],
        },
        components: [
          createMeshComponent("mesh-dynamic", "box"),
          {
            id: "rb-dynamic",
            classId: "RigidBodyComponent",
            properties: { motionType: "dynamic", mass: 1, gravityScale: 1 },
          },
          {
            id: "col-dynamic",
            classId: "ColliderComponent",
            properties: {
              shape: { kind: "box", halfExtents: { x: 0.5, y: 0.5, z: 0.5 } },
            },
          },
        ],
      }),
      createActor("ground", "Ground", {
        transform: {
          position: [0, 0, 0],
          rotation: [0, 0, 0, 1],
          scale: [1, 1, 1],
        },
        components: [
          createMeshComponent("mesh-ground", "ground"),
          {
            id: "rb-ground",
            classId: "RigidBodyComponent",
            properties: { motionType: "static", mass: 0, gravityScale: 0 },
          },
          {
            id: "col-ground",
            classId: "ColliderComponent",
            properties: {
              shape: { kind: "box", halfExtents: { x: 5, y: 0.5, z: 5 } },
            },
          },
        ],
      }),
    ],
  };
}

function node(
  registry: NodeRegistry,
  id: string,
  typeId: string,
  properties: Record<string, unknown> = {},
): GraphNode {
  const def = registry.get(typeId);
  if (!def) throw new Error(`missing node definition ${typeId}`);
  return {
    id,
    typeId,
    position: { x: 0, y: 0 },
    pins: def.pins(properties),
    properties,
  };
}

describe("p7-play-scene-load", () => {
  it("realizes the authored scene instead of demo actors", () => {
    const commands: CommandMessage[] = [];
    const runtime = createRuntimeFromLoad(
      {
        type: "load",
        sceneAssetGuid: "assets/main.scene.babasset",
        scene: {
          name: "Main",
          viewportMode: "3d",
          settings: createDefaultSceneSettings(),
          actors: [
            createActor("actor-1", "Cube", {
              components: [createMeshComponent("component-1", "sphere")],
            }),
          ],
        },
        physicsWorld: "3d",
      },
      (command) => commands.push(command),
    );

    expect(runtime.getWorld().getActors()).toHaveLength(0);
    runtime.realizePlayWorld();
    const actors = runtime.getWorld().getActors();
    expect(actors.map((actor) => actor.guid)).toEqual(["actor-1"]);
    expect(actors[0]!.getVariable("name")).toBe("Cube");
    const meshAssign = commands.filter((c) => c.type === "assignMesh");
    expect(meshAssign).toEqual([
      {
        type: "assignMesh",
        slotId: 0,
        meshAssetGuid: null,
        meshKind: "sphere",
      },
    ]);
    runtime.stop();
  });

  it("steps authored rigid bodies after realizePlayWorld", () => {
    const runtime = createInProcessRuntime({
      seed: 3,
      maxActors: 8,
      preferSoftwarePhysics: true,
      physicsWorld: "3d",
      seedDemoActors: false,
      playScene: fallingBoxScene(),
      playSceneGuid: "fall-scene",
    });
    runtime.realizePlayWorld();
    const box = runtime.getWorld().findActor("dynamic-box");
    expect(box).toBeDefined();
    runtime.start();
    for (let i = 0; i < 90; i++) runtime.tick();
    expect(box!.transform.position.y).toBeLessThan(5);
    runtime.stop();
  });

  it("binds compiled graphs onto matching scene classIds instead of extra spawns", async () => {
    const registry = createDefaultNodeRegistry();
    const graph: LogicGraph = {
      id: "event-graph",
      kind: "event",
      nodes: [
        node(registry, "tick", "flow.event.tick"),
        node(registry, "js", "debug.executeJavaScript", {
          inputs: [{ name: "dt", type: { kind: "float" } }],
          outputs: [{ name: "location", type: { kind: "vec3" } }],
          body: "location = { x: dt * 10, y: 1, z: 0 };",
        }),
        node(registry, "move", "transform.setLocation"),
        node(registry, "self", "actor.getSelf"),
      ],
      edges: [
        {
          id: "e1",
          sourceNodeId: "tick",
          sourcePinId: "execOut",
          targetNodeId: "js",
          targetPinId: "execIn",
        },
        {
          id: "e2",
          sourceNodeId: "tick",
          sourcePinId: "deltaSeconds",
          targetNodeId: "js",
          targetPinId: "in_dt",
        },
        {
          id: "e3",
          sourceNodeId: "js",
          sourcePinId: "execOut",
          targetNodeId: "move",
          targetPinId: "execIn",
        },
        {
          id: "e4",
          sourceNodeId: "js",
          sourcePinId: "out_location",
          targetNodeId: "move",
          targetPinId: "location",
        },
        {
          id: "e5",
          sourceNodeId: "self",
          sourcePinId: "out",
          targetNodeId: "move",
          targetPinId: "target",
        },
      ],
    };
    const compiled = compileGraph(graph, {
      assetGuid: "mover-asset",
      registry,
    });
    const script: CompiledScript = {
      assetGuid: "mover-asset",
      classId: "Mover",
      source: compiled.source,
      anchors: compiled.anchors,
      entryPoints: compiled.entryPoints,
    };

    const runtime = createInProcessRuntime({
      seed: 1,
      dt: 0.1,
      seedDemoActors: false,
      preferSoftwarePhysics: true,
      playScene: {
        name: "Scripted",
        viewportMode: "3d",
        settings: createDefaultSceneSettings(),
        actors: [createActor("hero", "Hero", { classId: "Mover" })],
      },
    });
    await runtime.loadScripts([script]);
    runtime.realizePlayWorld();
    expect(runtime.getWorld().getActors().map((a) => a.guid)).toEqual(["hero"]);
    runtime.start();
    runtime.tick();
    expect(runtime.getWorld().findActor("hero")!.transform.position.x).toBeCloseTo(
      1,
      5,
    );
    runtime.stop();
  });

  it("changeScene instantiates a registered scene and drops the previous actors", async () => {
    const level2: SerializedScene = {
      name: "Level2",
      viewportMode: "3d",
      settings: createDefaultSceneSettings(),
      actors: [createActor("other", "Other")],
    };
    const runtime = createInProcessRuntime({
      seed: 1,
      seedDemoActors: false,
      preferSoftwarePhysics: true,
      playScene: {
        name: "Level1",
        viewportMode: "3d",
        settings: createDefaultSceneSettings(),
        actors: [createActor("hero", "Hero")],
      },
      sceneLibrary: { Level2: level2 },
    });
    runtime.realizePlayWorld();
    runtime.start();
    expect(runtime.getWorld().getActors().map((a) => a.guid)).toEqual(["hero"]);
    runtime.executeConsoleCommand("changescene Level2");
    expect(runtime.getWorld().getActors().map((a) => a.guid)).toEqual(["other"]);
    runtime.stop();
  });

  it("changeScene logs when the scene asset is not in the Play library", () => {
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({
      seed: 1,
      seedDemoActors: false,
      preferSoftwarePhysics: true,
      onCommand: (command) => commands.push(command),
    });
    runtime.executeConsoleCommand("changescene missing-level");
    expect(
      commands.some(
        (c) =>
          c.type === "log" &&
          String((c as { message: string }).message).includes("missing-level"),
      ),
    ).toBe(true);
    runtime.stop();
  });
});
