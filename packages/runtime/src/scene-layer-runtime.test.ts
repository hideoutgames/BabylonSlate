import { describe, expect, it } from "vitest";
import type { CommandMessage } from "@babylonslate/bridge";
import {
  createActor,
  createDefaultScene,
  createDefaultSceneLayer,
  type SerializedScene,
  type SerializedSceneLayer,
} from "@babylonslate/core";
import { createInProcessRuntime } from "./driver";

function overlayLayer(): SerializedSceneLayer {
  return {
    ...createDefaultSceneLayer(),
    name: "HUD",
    actors: [
      createActor("banner", "Banner", { classId: "SceneLayerActor" }),
    ],
  };
}

function worldScene(
  name: string,
  sceneLayers: SerializedScene["settings"]["sceneLayers"] = [],
): SerializedScene {
  const scene = createDefaultScene();
  return {
    ...scene,
    name,
    actors: [createActor(`${name}-hero`, "Hero")],
    settings: {
      ...scene.settings,
      sceneLayers,
    },
  };
}

describe("SceneLayer runtime compositor", () => {
  it("spawns scene-owned overlays on realize and tears them down on changeScene", () => {
    const commands: CommandMessage[] = [];
    const hud = overlayLayer();
    const levelA = worldScene("A", [
      { assetGuid: "hud", zOrder: 2, enabled: true },
    ]);
    const levelB = worldScene("B");
    const runtime = createInProcessRuntime({
      seed: 1,
      preferSoftwarePhysics: true,
      playScene: levelA,
      playSceneGuid: "a",
      sceneLibrary: { a: levelA, b: levelB },
      sceneLayerLibrary: { hud },
      onCommand: (command) => commands.push(command),
    });
    runtime.realizePlayWorld();
    const world = runtime.getWorld();
    expect(world.getSceneLayers()).toHaveLength(1);
    expect(world.getSceneLayers()[0]?.ownerSceneGuid).toBe("a");
    expect(world.getSceneLayers()[0]?.zOrder).toBe(2);
    expect(
      world.getActors().some((actor) => actor.guid === "banner"),
    ).toBe(true);
    expect(
      commands.some(
        (command) =>
          command.type === "sceneLayerCreate" && command.assetGuid === "hud",
      ),
    ).toBe(true);

    runtime.executeConsoleCommand("changescene b");
    expect(world.getSceneLayers()).toHaveLength(0);
    expect(world.getActors().some((actor) => actor.guid === "banner")).toBe(
      false,
    );
    expect(world.getActors().some((actor) => actor.guid === "B-hero")).toBe(
      true,
    );
  });

  it("keeps graph-created overlays across scene travel until remove or clear", () => {
    const hud = overlayLayer();
    const levelA = worldScene("A");
    const levelB = worldScene("B");
    const runtime = createInProcessRuntime({
      seed: 1,
      preferSoftwarePhysics: true,
      playScene: levelA,
      playSceneGuid: "a",
      sceneLibrary: { a: levelA, b: levelB },
      sceneLayerLibrary: { hud },
    });
    runtime.realizePlayWorld();
    const created = runtime.createSceneLayer("hud", 5);
    expect(created?.ownerSceneGuid).toBeNull();
    expect(created?.zOrder).toBe(5);
    runtime.executeConsoleCommand("changescene b");
    expect(runtime.getWorld().getSceneLayers()).toHaveLength(1);
    expect(
      runtime.getWorld().getActors().some((actor) => actor.guid === "banner"),
    ).toBe(true);

    runtime.removeSceneLayer(created!.guid);
    expect(runtime.getWorld().getSceneLayers()).toHaveLength(0);

    runtime.createSceneLayer("hud", 0);
    runtime.createSceneLayer("hud", 1);
    runtime.clearSceneLayers();
    expect(runtime.getWorld().getSceneLayers()).toHaveLength(0);
  });

  it("logs an error when unregistering a missing SceneLayer post-process without throwing", () => {
    const commands: CommandMessage[] = [];
    const hud = overlayLayer();
    const runtime = createInProcessRuntime({
      seed: 1,
      preferSoftwarePhysics: true,
      playScene: worldScene("A"),
      sceneLayerLibrary: { hud },
      onCommand: (command) => commands.push(command),
    });
    runtime.realizePlayWorld();
    const layer = runtime.createSceneLayer("hud", 0)!;
    expect(() =>
      runtime.unregisterSceneLayerPostProcess(layer.guid, "missing-pp"),
    ).not.toThrow();
    expect(
      commands.some(
        (command) =>
          command.type === "log" &&
          command.severity === "error" &&
          command.message.includes("post-process"),
      ),
    ).toBe(true);
  });

  it("tags overlay spawn commands and copies authored post-process onto the instance", () => {
    const commands: CommandMessage[] = [];
    const hud = {
      ...overlayLayer(),
      settings: {
        ...overlayLayer().settings,
        postProcessStack: [{ materialGuid: "bloom", enabled: true }],
      },
    };
    const runtime = createInProcessRuntime({
      seed: 1,
      preferSoftwarePhysics: true,
      playScene: worldScene("A"),
      sceneLayerLibrary: { hud },
      onCommand: (command) => commands.push(command),
    });
    runtime.realizePlayWorld();
    const layer = runtime.createSceneLayer("hud", 4)!;
    expect(layer.postProcessStack).toEqual([
      { materialGuid: "bloom", enabled: true },
    ]);
    expect(
      commands.some(
        (command) =>
          command.type === "spawn" &&
          command.actorGuid === "banner" &&
          command.sceneLayerId === layer.guid,
      ),
    ).toBe(true);
    runtime.registerSceneLayerPostProcess(layer.guid, "vignette");
    expect(layer.postProcessStack.map((entry) => entry.materialGuid)).toEqual([
      "bloom",
      "vignette",
    ]);
    runtime.unregisterSceneLayerPostProcess(layer.guid, "bloom");
    expect(layer.postProcessStack).toEqual([
      { materialGuid: "vignette", enabled: true },
    ]);
  });

  it("skips disabled scene-owned layers and remints actor guids for a second instance", () => {
    const hud = overlayLayer();
    const level = worldScene("A", [
      { assetGuid: "hud", zOrder: 0, enabled: false },
    ]);
    const runtime = createInProcessRuntime({
      seed: 1,
      preferSoftwarePhysics: true,
      playScene: level,
      playSceneGuid: "a",
      sceneLayerLibrary: { hud },
    });
    runtime.realizePlayWorld();
    expect(runtime.getWorld().getSceneLayers()).toHaveLength(0);
    const first = runtime.createSceneLayer("hud", 0)!;
    const second = runtime.createSceneLayer("hud", 1)!;
    expect(first.guid).not.toBe(second.guid);
    expect(runtime.getWorld().findActor("banner")?.sceneLayerId).toBe(first.guid);
    expect(
      runtime
        .getWorld()
        .getActors()
        .filter((actor) => actor.sceneLayerId === second.guid),
    ).toHaveLength(1);
  });

  it("simulates overlay rigid bodies in a dedicated 2D world that ignores world colliders", () => {
    const hud: SerializedSceneLayer = {
      ...createDefaultSceneLayer(),
      name: "HUD",
      actors: [
        createActor("chip", "Chip", {
          classId: "SceneLayerActor",
          transform: {
            position: [0, 5, 0],
            rotation: [0, 0, 0, 1],
            scale: [1, 1, 1],
          },
          components: [
            {
              id: "rb",
              classId: "RigidBodyComponent",
              properties: { motionType: "dynamic", mass: 1, gravityScale: 1 },
            },
            {
              id: "col",
              classId: "ColliderComponent",
              properties: {
                shape: { kind: "box", halfExtents: { x: 0.5, y: 0.5, z: 0.5 } },
              },
            },
          ],
        }),
      ],
    };
    const runtime = createInProcessRuntime({
      seed: 1,
      preferSoftwarePhysics: true,
      physicsWorld: "3d",
      seedDemoActors: false,
      playScene: worldScene("A"),
      sceneLayerLibrary: { hud },
    });
    runtime.realizePlayWorld();
    const world = runtime.getWorld();
    const shelf = world.createActor({
      classId: "Actor",
      transform: {
        position: { x: 0, y: 4, z: 0 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        scale: { x: 1, y: 1, z: 1 },
      },
    });
    shelf.attachComponent(
      world.createComponent({
        classId: "RigidBodyComponent",
        variables: { motionType: "static", mass: 0, gravityScale: 0 },
      }),
    );
    shelf.attachComponent(
      world.createComponent({
        classId: "ColliderComponent",
        variables: {
          shape: { kind: "box", halfExtents: { x: 5, y: 0.5, z: 5 } },
        },
      }),
    );
    world.spawnActorNow(shelf);
    runtime.createSceneLayer("hud", 0);
    runtime.start();
    for (let i = 0; i < 90; i++) runtime.tick();
    expect(world.findActor("chip")?.transform.position.y).toBeLessThan(3);
    runtime.stop();
  });

  it("applies 2DAnchor positions on spawn and again on resize", () => {
    const hud: SerializedSceneLayer = {
      ...createDefaultSceneLayer(),
      name: "HUD",
      actors: [
        createActor("badge", "Badge", {
          classId: "SceneLayerActor",
          components: [
            {
              id: "anchor",
              classId: "2DAnchorComponent",
              properties: { anchor: "topLeft", offsetX: 1, offsetY: -0.5 },
            },
          ],
        }),
      ],
    };
    const runtime = createInProcessRuntime({
      seed: 1,
      preferSoftwarePhysics: true,
      playScene: worldScene("A"),
      sceneLayerLibrary: { hud },
    });
    runtime.realizePlayWorld();
    runtime.createSceneLayer("hud", 0);
    const actor = runtime.getWorld().findActor("badge");
    expect(actor?.transform.position.x).toBe(-7);
    expect(actor?.transform.position.y).toBe(4);
    runtime.applySceneLayerResize(32, 18);
    expect(runtime.getWorld().findActor("badge")?.transform.position.x).toBe(-15);
    expect(runtime.getWorld().findActor("badge")?.transform.position.y).toBe(8.5);
  });

  it("invokes overlay button events on the actor class and ignores missing buttons", async () => {
    const commands: CommandMessage[] = [];
    const hud = overlayLayer();
    hud.actors[0] = createActor("banner", "Banner", {
      classId: "SceneLayerActor",
      components: [{ id: "btn", classId: "2DButtonComponent", properties: {} }],
    });
    const runtime = createInProcessRuntime({
      seed: 1,
      preferSoftwarePhysics: true,
      playScene: worldScene("A"),
      sceneLayerLibrary: { hud },
      onCommand: (command) => commands.push(command),
    });
    await runtime.loadScripts([
      {
        assetGuid: "hud-script",
        classId: "SceneLayerActor",
        parentClassId: "Actor",
        source:
          'export function onClick(ctx) { ctx.log("log", "Click", String(ctx.self?.guid ?? "")); }',
        anchors: [],
        entryPoints: [{ name: "onClick", event: "onClick", isAsync: false }],
      },
    ]);
    runtime.realizePlayWorld();
    runtime.createSceneLayer("hud", 0);
    runtime.applySceneLayerPointer({
      type: "sceneLayerPointer",
      layerId: "any",
      actorGuid: "banner",
      event: "onClick",
    });
    expect(
      commands.some(
        (command) =>
          command.type === "log" &&
          command.category === "Click" &&
          command.message === "banner",
      ),
    ).toBe(true);
    const before = commands.length;
    runtime.applySceneLayerPointer({
      type: "sceneLayerPointer",
      layerId: "gone",
      actorGuid: "missing",
      event: "onClick",
    });
    expect(commands).toHaveLength(before);
  });
});
