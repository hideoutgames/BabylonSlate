import { describe, expect, it } from "vitest";
import type { CommandMessage } from "@haptic/bridge";
import { createActor, createDefaultScene, createDefaultSceneLayer, type SaveGameDefinition, type SaveGameStorage } from "@haptic/core";
import { sceneAssetClassId, sceneLayerAssetClassId } from "@haptic/object-model";
import { createInProcessRuntime } from "./driver";
import type { CompiledScript } from "./script-host";

class MemoryStorage implements SaveGameStorage {
  readonly files = new Map<string, string>();
  async read(key: string) { return this.files.get(key) ?? null; }
  async write(key: string, text: string) { this.files.set(key, text); }
  async remove(key: string) { this.files.delete(key); }
  async list(prefix: string) { return [...this.files.keys()].filter((key) => key.startsWith(prefix)); }
  async withLock<T>(_key: string, operation: () => Promise<T>) { return operation(); }
}

const definition: SaveGameDefinition = {
  id: "progress", schemaVersion: 1, fields: [{ id: "coins", name: "coins", type: "int", defaultValue: 0 }],
};

/** Handles On Game Loaded and Scalability Changed by logging `<tag>:loaded` / `<tag>:scalability`. */
function hostScript(classId: string, parentClassId: string, tag: string, assetGuid = `${tag}-asset`): CompiledScript {
  return {
    assetGuid, classId, parentClassId, anchors: [],
    source: `export function loaded(ctx) { ctx.log("log", "Script", "${tag}:loaded"); }
      export function scalability(ctx) { ctx.log("log", "Script", "${tag}:scalability"); }`,
    entryPoints: [
      { name: "loaded", event: "onGameLoaded", isAsync: false },
      { name: "scalability", event: "onScalabilityChanged", isAsync: false },
    ],
  };
}

/**
 * A session with every kind of host handling both events: the Game Instance, a Game Subsystem,
 * a Scene Subsystem, the Scene's script, a Scene Layer's script, a Scene Layer Actor subclass with
 * a component, and a plain actor with a component.
 */
async function boot() {
  const scene = { ...createDefaultScene(), name: "Level", actors: [
    createActor("mover", "Mover", { classId: "Mover", components: [{ id: "part", classId: "Part", properties: {} }] }),
  ] };
  scene.settings.sceneLayers = [{ assetGuid: "hud", zOrder: 0, enabled: true }];
  const hud = { ...createDefaultSceneLayer(), actors: [
    createActor("button", "Button", { classId: "HudButton", components: [{ id: "button-part", classId: "HudPart", properties: {} }] }),
  ] };
  const commands: CommandMessage[] = [];
  const runtime = createInProcessRuntime({ seed: 1, seedDemoActors: false, preferSoftwarePhysics: true,
    playScene: scene, playSceneGuid: "level", sceneLayerLibrary: { hud }, onCommand: (command) => commands.push(command) });
  const service = runtime.configureSaveGame({ projectId: "project", definition, storage: new MemoryStorage() });
  await runtime.loadScripts([
    hostScript("GameInstance", "GameInstance", "game-instance"),
    hostScript("Audio", "GameSubsystem", "game-subsystem"),
    hostScript("Weather", "SceneSubsystem", "scene-subsystem"),
    hostScript(sceneAssetClassId("level"), "Scene", "scene", "level"),
    hostScript(sceneLayerAssetClassId("hud"), "SceneLayer", "scene-layer", "hud"),
    hostScript("HudButton", "SceneLayerActor", "scene-layer-actor"),
    hostScript("HudPart", "ActorComponent", "scene-layer-actor-component"),
    hostScript("Mover", "Actor", "actor"),
    hostScript("Part", "ActorComponent", "component"),
  ]);
  await runtime.realizePlayWorld();
  runtime.start();
  // Every host is live, so a host that hears nothing was left out, not missing.
  const world = runtime.getWorld();
  expect([world.gameInstance?.classId, world.currentScene?.classId, ...world.getGameSubsystems().map((entry) => entry.classId),
    ...world.getSceneSubsystems().map((entry) => entry.classId), ...world.getSceneLayers().map((layer) => layer.classId),
    ...world.getActors().flatMap((actor) => [actor.classId, ...actor.components.map((component) => component.classId)])].sort())
    .toEqual(["Audio", "GameInstance", "HudButton", "HudPart", "Mover", "Part", sceneAssetClassId("level"),
      sceneLayerAssetClassId("hud"), "Weather"].sort());
  let read = 0;
  const take = () => {
    const lines = commands.slice(read).flatMap((command) =>
      command.type === "log" && command.category === "Script" ? [command.message] : []);
    read = commands.length;
    return lines;
  };
  take();
  return { runtime, service, take };
}

describe("On Game Loaded and Scalability Changed hosts", () => {
  it("runs On Game Loaded on the Game Instance and Game Subsystems only", async () => {
    const { runtime, service, take } = await boot();
    try {
      expect((await service.saveGame()).ok).toBe(true);
      take();
      expect((await service.loadGame()).ok).toBe(true);
      expect(take().sort()).toEqual(["game-instance:loaded", "game-subsystem:loaded"]);
    } finally { runtime.stop(); }
  });

  it("runs Scalability Changed on the Game Instance, Game Subsystems, Scene Layers and Scene Layer Actors only", async () => {
    const { runtime, take } = await boot();
    try {
      const snapshot = runtime.getScalability();
      runtime.applyScalabilityStatus({ revision: snapshot.result.revision, status: "applied", message: "Ready", effective: snapshot.requested });
      expect(take().sort()).toEqual([
        "game-instance:scalability", "game-subsystem:scalability", "scene-layer-actor:scalability", "scene-layer:scalability",
      ]);
    } finally { runtime.stop(); }
  });
});
