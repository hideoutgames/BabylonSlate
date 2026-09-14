import { describe, expect, it, vi } from "vitest";
import { createActor, createDefaultScene, createDefaultSceneLayer, createMeshComponent } from "@babylonslate/core";
import { readActorSlot, readSnapshotHeader, snapshotFloatCount, type CommandMessage } from "@babylonslate/bridge";
import { createInProcessRuntime } from "./driver";
import type { CompiledScript } from "./script-host";
import { BObject, dispatchInterface } from "@babylonslate/object-model";

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
      { id: "logic", classId: "OwnedComponent", properties: {} }] })];
  scene.settings.sceneLayers = [{ assetGuid: "overlay", enabled: true, zOrder: 1 }];
  const layer = createDefaultSceneLayer();
  layer.settings.gravity = [0, 0, 0];
  layer.actors = [createActor("layer-actor", "Overlay", { classId: "LayerActor",
    components: [createMeshComponent("layer-mesh", "box"),
      { id: "layer-component", classId: "OwnedComponent", properties: {} },
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
      await runtime.loadScripts([script("WorldActor", "Actor"), script("LayerActor", "SceneLayerActor"), script("OwnedComponent", "ActorComponent")]);
      const finished: string[] = [];
      const world = runtime.getWorld();
      world.setGameInstance(world.createGameInstance({ classId: "GameInstance", variables: { ticks: 0 }, hooks: {
        onTick: (self) => { self.setVariable("ticks", Number(self.getVariable("ticks")) + 1); },
        onSceneFinishLoading: (_self, name) => { finished.push(name); },
      } }));
      runtime.beginPlayLoading();
      await runtime.realizePlayWorld();
      const actor = world.findActor("world-actor")!;
      const logic = actor.components.find((component) => component.guid === "logic")!;
      const ownedLayer = world.getSceneLayers()[0]!;
      const globalLayer = runtime.createSceneLayer("overlay")!;
      await vi.waitFor(() => expect(commands.some((command) => command.type === "sceneLayerRealized" && command.layerId === globalLayer.guid)).toBe(true));
      const globalActor = world.getActors().find((candidate) => candidate.sceneLayerId === globalLayer.guid)!;
      expect(commands.filter((command) => command.type === "assignMesh")).toHaveLength(3);
      expect(actor.getVariable("began")).toBeUndefined();
      expect(logic.getVariable("began")).toBeUndefined();
      runtime.notifySceneLayerReady(globalLayer.guid, 2);
      expect(globalActor.getVariable("began")).toBeUndefined();
      runtime.finishPlayLoading();
      expect(globalActor.getVariable("began")).toBe(true);
      const globalComponent = globalActor.components.find((component) => component.classId === "OwnedComponent")!;
      expect(globalComponent.getVariable("began")).toBe(true);
      runtime.notifySceneModelsReady("world", 1);
      expect(actor.getVariable("began")).toBeUndefined();
      expect(finished).toEqual([]);
      runtime.getOverlayPhysicsSync()!.setActorLinearVelocity(globalActor.guid, { x: 6 });
      const before = globalActor.transform.position.x;
      runtime.tick();
      runtime.tick();
      expect(globalActor.getVariable("ticks")).toBe(2);
      expect(globalComponent.getVariable("ticks")).toBe(2);
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

  it("blocks authored cross-owner calls until ready and confines final lifecycle helpers to their own synchronous owner", async () => {
    const { scene, layer } = documents();
    scene.actors[0]!.components!.push({ id: "text", classId: "Text3DComponent", properties: { text: "Before" } });
    const callable = (classId: string, parentClassId: string): CompiledScript => ({
      ...script(classId, parentClassId),
      implementedInterfaces: ["touch"],
      interfaceImplementations: [{ interfaceGuid: "touch", method: "Touch", exportName: "touch" }],
      source: `export function begin(ctx) { ctx.self.setVariable("began", true); }
        export function touch(ctx) {
          ctx.self.setVariable("calls", Number(ctx.self.getVariable("calls") ?? 0) + 1);
          return { value: 7 };
        }
        export function constant() { return { value: 11 }; }
        export function textChanged(ctx) { ctx.self.setVariable("textEvents", Number(ctx.self.getVariable("textEvents") ?? 0) + 1); }
        export async function end(ctx) {
          ctx.self.setVariable("finalFunction", ctx.invokeFunction(ctx.self, "touch", {}));
          ctx.self.setVariable("finalInterface", ctx.callInterface(ctx.self, "touch", "Touch", {}));
          ctx.invokeCustomEvent(ctx.self, "probe", {});
          ctx.self.setVariable("relayResult", ctx.invokeFunction(ctx.self.getVariable("relay"), "relay", {
            dying: ctx.self, pending: ctx.self.getVariable("pending")
          }));
          await Promise.resolve();
          ctx.self.setVariable("lateFinalFunction", ctx.invokeFunction(ctx.self, "touch", {}));
        }`,
      entryPoints: [{ name: "begin", event: "onBeginPlay", isAsync: false },
        { name: "touch", event: "probe", isAsync: false },
        { name: "textChanged", event: "onTextChanged", componentId: "text", isAsync: false },
        { name: "end", event: "onDestroyed", isAsync: true }],
    });
    const giScript: CompiledScript = {
      assetGuid: "caller-script", classId: "Caller", parentClassId: "GameInstance", anchors: [],
      source: `export function touch() { return { value: 13 }; }
        export function relay(ctx) {
          ctx.self.setVariable("relayed", true);
          return { back: ctx.invokeFunction(ctx.commandArgs.dying, "touch", {}),
            pending: ctx.callInterface(ctx.commandArgs.pending, "touch", "Touch", {}) };
        }
        export function probe(ctx) {
          ctx.self.setVariable("results", ctx.self.getVariable("targets").map(target => {
            const iface = ctx.callInterface(target, "touch", "Touch", {});
            ctx.invokeCustomEvent(target, "probe", {});
            return { iface, fn: ctx.invokeFunction(target, "touch", {}) };
          }));
          ctx.self.setVariable("ownResult", ctx.invokeFunction(ctx.self, "touch", {}));
          ctx.self.setVariable("staticResult", ctx.invokeFunction("WorldActor", "constant", {}));
          ctx.self.setVariable("genericResult", ctx.invokeFunction(ctx.self.getVariable("generic"), "touch", {}));
          ctx.setVariableOn(ctx.self.getVariable("text"), "text", "Prepared");
          ctx.callComponentFunction(ctx.self.getVariable("text"), "setText", { text: "Prepared Again" });
        }
        export function exit(ctx) {
          ctx.self.setVariable("exitResult", ctx.invokeFunction(ctx.self, "touch", {}));
          ctx.self.setVariable("exitScene", ctx.args.sceneName);
        }
        export function end(ctx) {
          ctx.self.setVariable("endResult", ctx.invokeFunction(ctx.self, "touch", {}));
          ctx.self.setVariable("endTarget", ctx.invokeFunction(ctx.self.getVariable("targets")[0], "touch", {}));
        }`,
      entryPoints: [{ name: "probe", event: "onTick", isAsync: false },
        { name: "probe", event: "probe", isAsync: false }, { name: "exit", event: "onSceneExit", isAsync: false },
        { name: "end", event: "onEnd", isAsync: false }],
    };
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({ seed: 1, seedDemoActors: false, preferSoftwarePhysics: true,
      gameInstanceClass: "Caller", playScene: scene, playSceneGuid: "world", sceneLayerLibrary: { overlay: layer },
      cooperativeSceneLoading: true, deferSceneModelsReady: true, onCommand: (command) => commands.push(command) });
    try {
      await runtime.loadScripts([callable("WorldActor", "Actor"), callable("LayerActor", "SceneLayerActor"),
        callable("OwnedComponent", "ActorComponent"), callable("Utility", "BObject"), giScript]);
      runtime.beginPlayLoading();
      await runtime.realizePlayWorld();
      const world = runtime.getWorld();
      const actor = world.findActor("world-actor")!;
      const logic = actor.components.find((component) => component.guid === "logic")!;
      const text = actor.components.find((component) => component.guid === "text")!;
      const ownedLayer = world.getSceneLayers()[0]!;
      const ownedActor = world.getActors().find((candidate) => candidate.sceneLayerId === ownedLayer.guid)!;
      const globalLayer = runtime.createSceneLayer("overlay")!;
      await vi.waitFor(() => expect(commands.some((command) => command.type === "sceneLayerRealized" && command.layerId === globalLayer.guid)).toBe(true));
      const globalActor = world.getActors().find((candidate) => candidate.sceneLayerId === globalLayer.guid)!;
      runtime.notifySceneLayerReady(globalLayer.guid, 2);
      runtime.finishPlayLoading();
      world.interfaceRegistry.register({ guid: "touch", name: "Touch", methods: [{ name: "Touch", outputs: { value: -1, available: false } }] });
      const gi = world.gameInstance!;
      gi.setVariable("targets", [actor, logic, ownedActor, globalActor]);
      gi.setVariable("text", text);
      gi.setVariable("generic", new BObject({ classId: "Utility" }));
      runtime.tick();
      const unavailable = { iface: { value: -1, available: false }, fn: {} };
      const available = { iface: { value: 7, available: false }, fn: { value: 7 } };
      expect(gi.getVariable("results")).toEqual([unavailable, unavailable, unavailable, available]);
      expect(gi.getVariable("ownResult")).toEqual({ value: 13 });
      expect(gi.getVariable("staticResult")).toEqual({ value: 11 });
      expect(gi.getVariable("genericResult")).toEqual({ value: 7 });
      expect(actor.getVariable("calls")).toBeUndefined();
      expect(logic.getVariable("calls")).toBeUndefined();
      expect(ownedActor.getVariable("calls")).toBeUndefined();
      expect(actor.getVariable("textEvents")).toBeUndefined();
      expect(text.getVariable("text")).toBe("Prepared Again");
      expect(globalActor.getVariable("calls")).toBe(3);
      // The bound handler must also protect callers outside ScriptContext.
      expect(dispatchInterface(world.interfaceRegistry, actor, "touch", "Touch")).toEqual({ value: -1, available: false });
      globalActor.setVariable("relay", gi);
      globalActor.setVariable("pending", actor);
      runtime.removeSceneLayer(globalLayer.guid);
      expect(globalActor.getVariable("finalFunction")).toEqual({ value: 7 });
      expect(globalActor.getVariable("finalInterface")).toEqual({ value: 7, available: false });
      expect(globalActor.getVariable("calls")).toBe(6);
      expect(gi.getVariable("relayed")).toBe(true);
      expect(globalActor.getVariable("relayResult")).toEqual({ back: {}, pending: { value: -1, available: false } });
      await vi.waitFor(() => expect(globalActor.getVariable("lateFinalFunction")).toEqual({}));
      runtime.notifySceneModelsReady("world", 1);
      runtime.notifySceneLayerReady(ownedLayer.guid, 1);
      runtime.tick();
      expect(gi.getVariable("results")).toEqual([available, available, available, unavailable]);
      expect(actor.getVariable("calls")).toBe(3);
      expect(logic.getVariable("calls")).toBe(3);
      expect(ownedActor.getVariable("calls")).toBe(3);
      expect(actor.getVariable("textEvents")).toBe(2);
      runtime.stop();
      expect(gi.getVariable("exitResult")).toEqual({ value: 13 });
      expect(gi.getVariable("exitScene")).toBe("World");
      expect(gi.getVariable("endResult")).toEqual({ value: 13 });
      expect(gi.getVariable("endTarget")).toEqual({});
      const resultsAtStop = gi.getVariable("results");
      runtime.invokeScriptEvent("Caller", "probe", gi);
      expect(gi.getVariable("results")).toBe(resultsAtStop);
      expect(commands.filter((command) => command.type === "log" && command.severity === "error")).toEqual([]);
    } finally { runtime.stop(); }
  });

  it("rejects stale layer acknowledgments and never runs cancelled creation or destruction callbacks", async () => {
    const { scene, layer } = documents();
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({ seed: 1, seedDemoActors: false, preferSoftwarePhysics: true,
      playScene: scene, playSceneGuid: "world", sceneLayerLibrary: { overlay: layer },
      deferSceneModelsReady: true, onCommand: (command) => commands.push(command) });
    try {
      await runtime.loadScripts([script("WorldActor", "Actor"), script("LayerActor", "SceneLayerActor"), script("OwnedComponent", "ActorComponent")]);
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
