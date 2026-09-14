import { describe, expect, it } from "vitest";
import { createActor, createDefaultScene, createDefaultSceneLayer, createMeshComponent } from "@babylonslate/core";
import { readActorSlot, readSnapshotHeader, snapshotFloatCount, type CommandMessage } from "@babylonslate/bridge";
import { createInProcessRuntime } from "./driver";
import type { CompiledScript } from "./script-host";

function script(classId: string, parentClassId: string): CompiledScript {
  return { assetGuid: `${classId}-script`, classId, parentClassId, anchors: [],
    source: `export function begin(ctx) { ctx.self.setVariable("began", true); }
      export function tick(ctx) { ctx.self.setVariable("ticks", Number(ctx.self.getVariable("ticks") ?? 0) + 1); }
      export function end(ctx) { ctx.log("log", "lifecycle", "destroyed:" + ctx.self.guid); }`,
    entryPoints: [{ name: "begin", event: "onBeginPlay", isAsync: false },
      { name: "tick", event: "onTick", isAsync: false }, { name: "end", event: "onDestroyed", isAsync: false }] };
}

function documents() {
  const scene = createDefaultScene();
  scene.name = "World";
  scene.actors = [createActor("world-actor", "World", { classId: "WorldActor",
    components: [createMeshComponent("world-mesh", "box"),
      { id: "logic", classId: "LogicComponent", properties: { logicClass: "OwnedLogic" } }] })];
  scene.settings.sceneLayers = [{ assetGuid: "overlay", enabled: true, zOrder: 1 }];
  const layer = createDefaultSceneLayer();
  layer.settings.gravity = [0, 0, 0];
  layer.actors = [createActor("layer-actor", "Overlay", { classId: "LayerActor",
    components: [createMeshComponent("layer-mesh", "box"),
      { id: "body", classId: "RigidBodyComponent", properties: { motionType: "dynamic", mass: 1, gravityScale: 0 } }] })];
  return { scene, layer };
}

describe("scene owner readiness", () => {
  it("cleans a partial layer when structural assignment fails before its ready marker", () => {
    const { layer } = documents();
    const runtime = createInProcessRuntime({ seed: 1, seedDemoActors: false, preferSoftwarePhysics: true,
      playScene: { ...createDefaultScene(), actors: [] }, sceneLayerLibrary: { overlay: layer }, deferSceneModelsReady: true,
      onCommand: (command) => { if (command.type === "assignMesh") throw new Error("Layer assignment failed"); } });
    try {
      runtime.realizePlayWorld();
      expect(() => runtime.createSceneLayer("overlay")).toThrow("Layer assignment failed");
      expect(runtime.getWorld().getSceneLayers()).toEqual([]);
      expect(runtime.getWorld().getActors()).toEqual([]);
    } finally { runtime.stop(); }
  });

  it("realizes scripted assets before activation while a ready global layer keeps ticking and publishing motion", async () => {
    const { scene, layer } = documents();
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({ seed: 1, seedDemoActors: false, preferSoftwarePhysics: true,
      playScene: scene, playSceneGuid: "world", sceneLayerLibrary: { overlay: layer },
      cooperativeSceneLoading: true, deferSceneModelsReady: true, onCommand: (command) => commands.push(command) });
    try {
      await runtime.loadScripts([script("WorldActor", "Actor"), script("LayerActor", "SceneLayerActor"), script("OwnedLogic", "ComponentLogic")]);
      const finished: string[] = [];
      const world = runtime.getWorld();
      world.setGameInstance(world.createGameInstance({ classId: "GameInstance", variables: { ticks: 0 }, hooks: {
        onTick: (self) => { self.setVariable("ticks", Number(self.getVariable("ticks")) + 1); },
        onSceneFinishLoading: (_self, name) => { finished.push(name); },
      } }));
      runtime.beginPlayLoading();
      await runtime.realizePlayWorld();
      const actor = world.findActor("world-actor")!;
      const logic = actor.components.find((component) => component.guid === "logic")!.logic!;
      const ownedLayer = world.getSceneLayers()[0]!;
      const globalLayer = runtime.createSceneLayer("overlay")!;
      const globalActor = world.getActors().find((candidate) => candidate.sceneLayerId === globalLayer.guid)!;
      expect(commands.filter((command) => command.type === "assignMesh")).toHaveLength(3);
      expect(actor.getVariable("began")).toBeUndefined();
      expect(logic.getVariable("began")).toBeUndefined();
      runtime.notifySceneLayerReady(globalLayer.guid, 2);
      expect(globalActor.getVariable("began")).toBeUndefined();
      runtime.finishPlayLoading();
      expect(globalActor.getVariable("began")).toBe(true);
      runtime.notifySceneModelsReady("world", 1);
      expect(actor.getVariable("began")).toBeUndefined();
      expect(finished).toEqual([]);
      runtime.getOverlayPhysicsSync()!.setActorLinearVelocity(globalActor.guid, { x: 6 });
      const before = globalActor.transform.position.x;
      runtime.tick();
      runtime.tick();
      expect(globalActor.getVariable("ticks")).toBe(2);
      expect(world.gameInstance!.getVariable("ticks")).toBe(2);
      expect(actor.getVariable("ticks")).toBeUndefined();
      expect(logic.getVariable("ticks")).toBeUndefined();
      expect(globalActor.transform.position.x).toBeCloseTo(before + 0.2);
      const snapshot = new Float32Array(snapshotFloatCount(runtime.snapshotCapacity));
      expect(runtime.copySnapshot(snapshot)).toBe(true);
      const positions = Array.from({ length: readSnapshotHeader(snapshot).actorCount }, (_, index) => readActorSlot(snapshot, index).position.x);
      expect(positions.some((position) => Math.abs(position - (before + 0.2)) < 0.00001)).toBe(true);
      runtime.notifySceneLayerReady(ownedLayer.guid, 1);
      expect(actor.getVariable("began")).toBe(true);
      expect(logic.getVariable("began")).toBe(true);
      expect(finished).toEqual(["World"]);
      runtime.tick();
      expect(actor.getVariable("ticks")).toBe(1);
      expect(logic.getVariable("ticks")).toBe(1);
    } finally { runtime.stop(); }
  });

  it("rejects stale layer acknowledgments and never runs cancelled creation or destruction callbacks", async () => {
    const { scene, layer } = documents();
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({ seed: 1, seedDemoActors: false, preferSoftwarePhysics: true,
      playScene: scene, playSceneGuid: "world", sceneLayerLibrary: { overlay: layer },
      deferSceneModelsReady: true, onCommand: (command) => commands.push(command) });
    try {
      await runtime.loadScripts([script("WorldActor", "Actor"), script("LayerActor", "SceneLayerActor"), script("OwnedLogic", "ComponentLogic")]);
      runtime.realizePlayWorld();
      const oldLayer = runtime.getWorld().getSceneLayers()[0]!;
      const oldActor = runtime.getWorld().getActors().find((actor) => actor.sceneLayerId === oldLayer.guid)!;
      runtime.removeSceneLayer(oldLayer.guid);
      const replacement = runtime.createSceneLayer("overlay")!;
      const replacementActor = runtime.getWorld().getActors().find((actor) => actor.sceneLayerId === replacement.guid)!;
      runtime.notifySceneLayerReady(oldLayer.guid, 1);
      runtime.notifySceneLayerReady(replacement.guid, 1);
      expect(oldActor.getVariable("began")).toBeUndefined();
      expect(replacementActor.getVariable("began")).toBeUndefined();
      runtime.stop();
      runtime.notifySceneLayerReady(replacement.guid, 2);
      runtime.notifySceneModelsReady("world", 1);
      expect(replacementActor.getVariable("began")).toBeUndefined();
      expect(commands.filter((command) => command.type === "log" && command.category === "lifecycle")).toEqual([]);
    } finally { runtime.stop(); }
  });
});
