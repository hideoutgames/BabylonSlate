import { describe, expect, it } from "vitest";
import type { CommandMessage } from "@babylonslate/bridge";
import {
  readActorSlot,
  readSnapshotHeader,
  snapshotFloatCount,
} from "@babylonslate/bridge";
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
    folders: [],
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

function cameraPossessScene(attemptPossessViewTarget: boolean): SerializedScene {
  return {
    name: "Possess",
    viewportMode: "3d",
    settings: createDefaultSceneSettings(),
    folders: [],
    actors: [
      createActor("cam", "Camera", {
        components: [
          {
            id: "cam-comp",
            classId: "CameraComponent",
            properties: { projectionMode: "perspective", attemptPossessViewTarget },
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
          folders: [],
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

  it("gives every mesh actor its own slot and snapshot row", () => {
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({
      seed: 1,
      maxActors: 8,
      seedDemoActors: false,
      preferSoftwarePhysics: true,
      playScene: {
        name: "TwoMeshes",
        viewportMode: "3d",
        settings: createDefaultSceneSettings(),
        folders: [],
        actors: [
          createActor("box-actor", "Box", {
            transform: {
              position: [-3, 0, 0],
              rotation: [0, 0, 0, 1],
              scale: [1, 1, 1],
            },
            components: [createMeshComponent("box-mesh", "box")],
          }),
          createActor("sphere-actor", "Sphere", {
            transform: {
              position: [3, 0, 0],
              rotation: [0, 0, 0, 1],
              scale: [1, 1, 1],
            },
            components: [createMeshComponent("sphere-mesh", "sphere")],
          }),
        ],
      },
      onCommand: (command) => commands.push(command),
    });
    runtime.realizePlayWorld();

    const assigned = commands.filter((c) => c.type === "assignMesh");
    expect(assigned.map((c) => (c as { meshKind: string }).meshKind)).toEqual([
      "box",
      "sphere",
    ]);
    const slotIds = assigned.map((c) => (c as { slotId: number }).slotId);
    expect(new Set(slotIds).size).toBe(2);

    runtime.start();
    runtime.tick();
    const buf = new Float32Array(snapshotFloatCount(8));
    expect(runtime.copySnapshot(buf)).toBe(true);
    expect(readSnapshotHeader(buf).actorCount).toBe(2);
    const first = readActorSlot(buf, 0);
    const second = readActorSlot(buf, 1);
    expect(new Set([first.slotId, second.slotId]).size).toBe(2);
    expect([first.position.x, second.position.x].sort((a, b) => a - b)).toEqual([
      -3, 3,
    ]);
    runtime.stop();
  });

  it("possesses a camera that opts into Attempt Possess View Target", () => {
    const commands: CommandMessage[] = [];
    const runtime = createRuntimeFromLoad(
      {
        type: "load",
        sceneAssetGuid: "assets/possess.scene.babasset",
        scene: cameraPossessScene(true),
      },
      (command) => commands.push(command),
    );
    runtime.realizePlayWorld();

    const possess = commands.filter((c) => c.type === "possessCamera");
    expect(possess).toHaveLength(1);
    const cameraSlot = commands.find(
      (c) => c.type === "assignMesh" && (c as { meshKind: string }).meshKind === "camera",
    ) as { slotId: number } | undefined;
    expect((possess[0] as { slotId: number }).slotId).toBe(cameraSlot?.slotId);
    runtime.stop();
  });

  it("leaves the camera alone when the option is off", () => {
    const commands: CommandMessage[] = [];
    const runtime = createRuntimeFromLoad(
      {
        type: "load",
        sceneAssetGuid: "assets/possess.scene.babasset",
        scene: cameraPossessScene(false),
      },
      (command) => commands.push(command),
    );
    runtime.realizePlayWorld();
    expect(commands.some((c) => c.type === "possessCamera")).toBe(false);
    runtime.stop();
  });

  it("does not possess a camera whose actor never reached the world", () => {
    const commands: CommandMessage[] = [];
    const scene = cameraPossessScene(true);
    scene.actors = [];
    const runtime = createRuntimeFromLoad(
      {
        type: "load",
        sceneAssetGuid: "assets/possess.scene.babasset",
        scene,
      },
      (command) => commands.push(command),
    );
    runtime.realizePlayWorld();
    expect(commands.some((c) => c.type === "possessCamera")).toBe(false);
    runtime.stop();
  });

  it("lets a Begin Play script possession win over the scene option", async () => {
    const registry = createDefaultNodeRegistry();
    const graph: LogicGraph = {
      id: "possess-graph",
      kind: "event",
      nodes: [
        node(registry, "begin", "flow.event.beginPlay"),
        node(registry, "self", "actor.getSelf"),
        node(registry, "possess", "camera.possess"),
      ],
      edges: [
        {
          id: "e1",
          sourceNodeId: "begin",
          sourcePinId: "execOut",
          targetNodeId: "possess",
          targetPinId: "execIn",
        },
        {
          id: "e2",
          sourceNodeId: "self",
          sourcePinId: "out",
          targetNodeId: "possess",
          targetPinId: "target",
        },
      ],
    };
    const compiled = compileGraph(graph, {
      assetGuid: "hero-asset",
      registry,
    });

    const commands: CommandMessage[] = [];
    const scene = cameraPossessScene(true);
    scene.actors.push(
      createActor("hero", "Hero", {
        classId: "Hero",
        components: [
          {
            id: "hero-camera",
            classId: "CameraComponent",
            properties: { projectionMode: "perspective" },
          },
        ],
      }),
    );
    const runtime = createRuntimeFromLoad(
      {
        type: "load",
        sceneAssetGuid: "assets/possess.scene.babasset",
        scene,
      },
      (command) => commands.push(command),
    );
    await runtime.loadScripts([
      {
        assetGuid: "hero-asset",
        classId: "Hero",
        source: compiled.source,
        anchors: compiled.anchors,
        entryPoints: compiled.entryPoints,
      },
    ]);
    runtime.realizePlayWorld();

    const possess = commands.filter((c) => c.type === "possessCamera");
    expect(possess).toHaveLength(1);
    const heroSlot = commands.find(
      (c) => c.type === "spawn" && (c as { actorGuid: string }).actorGuid === "hero",
    ) as { slotId: number } | undefined;
    expect((possess[0] as { slotId: number }).slotId).toBe(heroSlot?.slotId);
    runtime.stop();
  });

  it("emits assignMesh.parts for a two-mesh actor", () => {
    const commands: CommandMessage[] = [];
    const runtime = createRuntimeFromLoad(
      {
        type: "load",
        sceneAssetGuid: "assets/parts.scene.babasset",
        scene: {
          name: "Parts",
          viewportMode: "3d",
          settings: createDefaultSceneSettings(),
          folders: [],
          actors: [
            createActor("hero", "Hero", {
              components: [
                createMeshComponent("box", "box"),
                {
                  ...createMeshComponent("sphere", "sphere"),
                  transform: {
                    position: [2, 0, 0],
                    rotation: [0, 0, 0, 1],
                    scale: [1, 1, 1],
                  },
                },
              ],
            }),
          ],
        },
      },
      (command) => commands.push(command),
    );
    runtime.realizePlayWorld();
    const meshAssign = commands.filter((c) => c.type === "assignMesh");
    expect(meshAssign).toHaveLength(1);
    expect(meshAssign[0]).toMatchObject({
      type: "assignMesh",
      slotId: 0,
      meshKind: "box",
    });
    expect(meshAssign[0]).toEqual(
      expect.objectContaining({
        parts: [
          expect.objectContaining({
            componentId: "box",
            meshKind: "box",
            position: [0, 0, 0],
          }),
          expect.objectContaining({
            componentId: "sphere",
            meshKind: "sphere",
            position: [2, 0, 0],
          }),
        ],
      }),
    );
    runtime.stop();
  });

  it("emits light and Default Camera properties on assignMesh", () => {
    const commands: CommandMessage[] = [];
    const settings = createDefaultSceneSettings();
    settings.mainCameraActorId = "cam";
    settings.mainCameraComponentId = "cam-comp";
    const runtime = createRuntimeFromLoad(
      {
        type: "load",
        sceneAssetGuid: "assets/lit.scene.babasset",
        scene: {
          name: "Lit",
          viewportMode: "3d",
          settings,
          folders: [],
          actors: [
            createActor("lamp", "Lamp", {
              components: [
                {
                  id: "light-comp",
                  classId: "LightComponent",
                  properties: {
                    lightKind: "spot",
                    color: [0.2, 0.4, 0.8],
                    intensity: 3.5,
                    enabled: true,
                    range: 12,
                    innerAngle: 20,
                    outerAngle: 40,
                    castShadows: true,
                  },
                },
              ],
            }),
            createActor("cam", "Camera", {
              components: [
                {
                  id: "cam-comp",
                  classId: "CameraComponent",
                  properties: {
                    projectionMode: "perspective",
                    fieldOfView: 50,
                    nearClip: 0.2,
                    farClip: 800,
                  },
                },
              ],
            }),
          ],
        },
      },
      (command) => commands.push(command),
    );
    runtime.realizePlayWorld();
    const assigns = commands.filter((c) => c.type === "assignMesh");
    expect(assigns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          meshKind: "light:spot",
          light: expect.objectContaining({
            color: [0.2, 0.4, 0.8],
            intensity: 3.5,
            range: 12,
            innerAngle: 20,
            outerAngle: 40,
            castShadows: true,
          }),
        }),
        expect.objectContaining({
          meshKind: "camera",
          camera: expect.objectContaining({
            isDefault: true,
            fieldOfView: 50,
            nearClip: 0.2,
            farClip: 800,
          }),
        }),
      ]),
    );
    runtime.stop();
  });

  it("emits assignMaterial when a MeshComponent stores a materialGuid", () => {
    const commands: CommandMessage[] = [];
    const mesh = createMeshComponent("component-1", "sphere");
    mesh.properties.materialGuid = "mat-rock";
    const runtime = createRuntimeFromLoad(
      {
        type: "load",
        sceneAssetGuid: "assets/mat.scene.babasset",
        scene: {
          name: "Shaded",
          viewportMode: "3d",
          settings: createDefaultSceneSettings(),
          folders: [],
          actors: [
            createActor("actor-1", "Cube", {
              components: [mesh],
            }),
          ],
        },
      },
      (command) => commands.push(command),
    );
    runtime.realizePlayWorld();
    expect(commands.filter((c) => c.type === "assignMaterial")).toEqual([
      {
        type: "assignMaterial",
        slotId: 0,
        materialAssetGuid: "mat-rock",
      },
    ]);
    runtime.stop();
  });

  it("emits per-component assignMaterial for a two-mesh actor", () => {
    const commands: CommandMessage[] = [];
    const box = createMeshComponent("box", "box");
    box.properties.materialGuid = "mat-box";
    const sphere = createMeshComponent("sphere", "sphere");
    sphere.properties.materialGuid = "mat-sphere";
    sphere.transform = {
      position: [2, 0, 0],
      rotation: [0, 0, 0, 1],
      scale: [1, 1, 1],
    };
    const runtime = createRuntimeFromLoad(
      {
        type: "load",
        sceneAssetGuid: "assets/parts-mat.scene.babasset",
        scene: {
          name: "Parts",
          viewportMode: "3d",
          settings: createDefaultSceneSettings(),
          folders: [],
          actors: [
            createActor("hero", "Hero", {
              components: [box, sphere],
            }),
          ],
        },
      },
      (command) => commands.push(command),
    );
    runtime.realizePlayWorld();
    expect(commands.filter((c) => c.type === "assignMaterial")).toEqual([
      {
        type: "assignMaterial",
        slotId: 0,
        materialAssetGuid: "mat-box",
        componentId: "box",
      },
      {
        type: "assignMaterial",
        slotId: 0,
        materialAssetGuid: "mat-sphere",
        componentId: "sphere",
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
        folders: [],
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
      folders: [],
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
        folders: [],
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

  it("changeScene emits activeScene with the canonical guid when addressed by name", () => {
    const level2: SerializedScene = {
      name: "Level 2",
      viewportMode: "3d",
      settings: {
        ...createDefaultSceneSettings(),
        postProcessStack: [{ materialGuid: "pp-b", enabled: true }],
      },
      folders: [],
      actors: [createActor("other", "Other")],
    };
    const commands: CommandMessage[] = [];
    const runtime = createRuntimeFromLoad(
      {
        type: "load",
        sceneAssetGuid: "scene-1",
        scene: {
          name: "Level 1",
          viewportMode: "3d",
          settings: {
            ...createDefaultSceneSettings(),
            postProcessStack: [{ materialGuid: "pp-a", enabled: true }],
          },
          folders: [],
          actors: [createActor("hero", "Hero")],
        },
        scenes: [{ guid: "scene-2", scene: level2 }],
      },
      (command) => commands.push(command),
    );
    runtime.realizePlayWorld();
    runtime.start();
    runtime.executeConsoleCommand('changescene scene="Level 2"');
    expect(
      commands.filter((command) => command.type === "activeScene"),
    ).toEqual([{ type: "activeScene", sceneAssetGuid: "scene-2" }]);
    runtime.stop();
  });

  it("changeScene emits activeScene when addressed by guid", () => {
    const level2: SerializedScene = {
      name: "Level 2",
      viewportMode: "3d",
      settings: createDefaultSceneSettings(),
      folders: [],
      actors: [createActor("other", "Other")],
    };
    const commands: CommandMessage[] = [];
    const runtime = createRuntimeFromLoad(
      {
        type: "load",
        sceneAssetGuid: "scene-1",
        scene: {
          name: "Level 1",
          viewportMode: "3d",
          settings: createDefaultSceneSettings(),
          folders: [],
          actors: [createActor("hero", "Hero")],
        },
        scenes: [{ guid: "scene-2", scene: level2 }],
      },
      (command) => commands.push(command),
    );
    runtime.realizePlayWorld();
    runtime.start();
    runtime.executeConsoleCommand("changescene scene-2");
    expect(
      commands.some(
        (command) =>
          command.type === "activeScene" && command.sceneAssetGuid === "scene-2",
      ),
    ).toBe(true);
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

  it("scene-spawned actors inherit ScriptInterface guids registered from loadScripts", async () => {
    const registry = createDefaultNodeRegistry();
    const implGraph: LogicGraph = {
      id: "event-graph",
      kind: "event",
      nodes: [
        node(registry, "hit", "flow.event.custom", { name: "ApplyDamage" }),
        node(registry, "log", "debug.log", { message: "damaged" }),
      ],
      edges: [
        {
          id: "e1",
          sourceNodeId: "hit",
          sourcePinId: "execOut",
          targetNodeId: "log",
          targetPinId: "execIn",
        },
      ],
    };
    const compiled = compileGraph(implGraph, {
      assetGuid: "bruiser-asset",
      registry,
    });
    const runtime = createInProcessRuntime({
      seed: 1,
      seedDemoActors: false,
      preferSoftwarePhysics: true,
      playScene: {
        name: "Arena",
        viewportMode: "3d",
        settings: createDefaultSceneSettings(),
        folders: [],
        actors: [createActor("guard", "Guard", { classId: "Bruiser" })],
      },
    });
    await runtime.loadScripts([
      {
        assetGuid: "bruiser-asset",
        classId: "Bruiser",
        source: compiled.source,
        anchors: compiled.anchors,
        entryPoints: compiled.entryPoints,
        implementedInterfaces: ["iface-damageable"],
      },
    ]);
    runtime.realizePlayWorld();
    const guard = runtime.getWorld().findActor("guard");
    expect(guard?.implementedInterfaces).toEqual(["iface-damageable"]);
    expect(
      guard?.interfaceHandlers.has(
        "iface-damageable:ApplyDamage",
      ),
    ).toBe(true);
    runtime.stop();
  });
});
