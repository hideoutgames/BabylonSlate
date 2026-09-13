import { describe, expect, it, vi } from "vitest";
import { createActor, createDefaultScene, createDefaultSceneLayer, createMeshComponent } from "@babylonslate/core";
import { readActorSlot, readSnapshotHeader, snapshotFloatCount, type CommandMessage } from "@babylonslate/bridge";
import { createInProcessRuntime } from "./driver";

function controlledYields() {
  let automatic = false;
  const pending: Array<() => void> = [];
  return {
    yieldControl: (signal: AbortSignal) => automatic ? Promise.resolve() : new Promise<void>((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      pending.push(() => { signal.removeEventListener("abort", abort); resolve(); });
    }),
    async next() {
      await vi.waitFor(() => expect(pending.length).toBeGreaterThan(0));
      pending.shift()!();
      await Promise.resolve();
    },
    release() {
      automatic = true;
      for (const resolve of pending.splice(0)) resolve();
    },
  };
}

function largeScene(count = 80) {
  return {
    ...createDefaultScene(),
    name: "Large",
    actors: Array.from({ length: count }, (_, index) => createActor(`actor-${index}`, `Actor ${index}`, {
      parentId: index === 0 ? "actor-79" : null,
      transform: { position: [index === 0 ? 2 : 10, 3, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
      components: [createMeshComponent(`mesh-${index}`, "box")],
    })),
  };
}

function makeRuntime(options: Parameters<typeof createInProcessRuntime>[0]) {
  return createInProcessRuntime({ seedDemoActors: false, preferSoftwarePhysics: true, ...options });
}

describe("cooperative runtime scene realization", () => {
  it("ticks Game Instance while partial actor work is suspended, then publishes parented poses before ready", async () => {
    const chunks = controlledYields();
    const commands: CommandMessage[] = [];
    const runtime = makeRuntime({ seed: 1, playScene: largeScene(), playSceneGuid: "large", cooperativeSceneLoading: chunks, deferSceneModelsReady: true, onCommand: (command) => commands.push(command) });
    runtime.beginPlayLoading();
    const loading = runtime.realizePlayWorld();
    try {
      while (runtime.getWorld().getActors().length === 0) await chunks.next();
      const actor = runtime.getWorld().getActors()[0]!;
      const actorTick = vi.spyOn(actor, "callOnTick");
      const physicsStep = vi.spyOn(runtime.getPhysicsSync()!, "step");
      const before = runtime.getWorld().gameInstance!.getVariable("ticks");
      runtime.tick();
      runtime.tick();
      expect(runtime.getWorld().gameInstance!.getVariable("ticks")).toBe(Number(before) + 2);
      expect(actorTick).not.toHaveBeenCalled();
      expect(physicsStep).not.toHaveBeenCalled();
      expect(commands.some((command) => command.type === "sceneRealized")).toBe(false);
      const snapshot = new Float32Array(snapshotFloatCount(runtime.snapshotCapacity));
      expect(runtime.copySnapshot(snapshot)).toBe(false);
      chunks.release();
      await loading;
      expect(runtime.getWorld().getActors()).toHaveLength(80);
      expect(commands.filter((command) => command.type === "assignMesh")).toHaveLength(80);
      expect(runtime.copySnapshot(snapshot)).toBe(true);
      expect(readSnapshotHeader(snapshot).actorCount).toBe(80);
      expect(readActorSlot(snapshot, 0).position).toEqual({ x: 12, y: 6, z: 0 });
      runtime.finishPlayLoading();
      runtime.tick();
      expect(actorTick).not.toHaveBeenCalled();
      runtime.notifySceneModelsReady("large", 1);
      runtime.tick();
      expect(actorTick).toHaveBeenCalledOnce();
      expect(physicsStep).toHaveBeenCalledOnce();
    } finally { chunks.release(); runtime.stop(); }
  });

  it("finishes all owned SceneLayer passes before announcing the batch and preserves the immediate layer API", async () => {
    const chunks = controlledYields();
    const scene = largeScene(1);
    scene.settings.sceneLayers = [{ assetGuid: "layer", enabled: true, zOrder: 2 }];
    const layer = createDefaultSceneLayer();
    layer.actors = largeScene(40).actors.map((actor, index) => ({ ...actor, classId: "SceneLayerActor", parentId: index === 0 ? "actor-39" : null }));
    const commands: CommandMessage[] = [];
    const runtime = makeRuntime({ seed: 1, playScene: scene, playSceneGuid: "large", sceneLayerLibrary: { layer }, cooperativeSceneLoading: chunks, onCommand: (command) => commands.push(command) });
    const loading = runtime.realizePlayWorld();
    try {
      await chunks.next();
      expect(commands.some((command) => command.type === "sceneLayerCreate")).toBe(true);
      expect(commands.some((command) => command.type === "sceneRealized")).toBe(false);
      chunks.release();
      await loading;
      const assigned = commands.filter((command) => command.type === "assignMesh");
      expect(assigned).toHaveLength(41);
      expect(commands.at(-1)?.type).toBe("sceneRealized");
      const owned = runtime.getWorld().getSceneLayers()[0]!;
      const child = runtime.getWorld().getActors().find((actor) => actor.guid === `${owned.guid}:actor-0`)!;
      expect(child.getVariable("parentId")).toBe("actor-39");
      const second = runtime.createSceneLayer("layer");
      expect(second).not.toBeNull();
      expect(runtime.getWorld().getActors().filter((actor) => actor.sceneLayerId === second!.guid)).toHaveLength(40);
    } finally { chunks.release(); runtime.stop(); }
  });

  it("follows a same-guid replacement and rejects the stale batch acknowledgement", async () => {
    const chunks = controlledYields();
    const scene = largeScene();
    const commands: CommandMessage[] = [];
    const runtime = makeRuntime({ seed: 1, playScene: scene, playSceneGuid: "large", sceneLibrary: { large: scene }, cooperativeSceneLoading: chunks, deferSceneModelsReady: true, onCommand: (command) => commands.push(command) });
    const loading = runtime.realizePlayWorld();
    try {
      while (runtime.getWorld().getActors().length === 0) await chunks.next();
      const oldActor = runtime.getWorld().getActors()[0]!;
      expect(runtime.executeConsoleCommand("changescene large").success).toBe(true);
      chunks.release();
      await loading;
      const replacement = runtime.getWorld().findActor(oldActor.guid)!;
      expect(replacement).toBeDefined();
      expect(replacement).not.toBe(oldActor);
      expect(oldActor.destroyed).toBe(true);
      expect(runtime.getWorld().getActors()).toHaveLength(80);
      expect(commands.filter((command) => command.type === "sceneRealized")).toEqual([{ type: "sceneRealized", sceneAssetGuid: "large", sceneLoadId: 2 }]);
      runtime.start();
      const actorTick = vi.spyOn(replacement, "callOnTick");
      runtime.notifySceneModelsReady("large", 1);
      runtime.tick();
      expect(actorTick).not.toHaveBeenCalled();
      runtime.notifySceneModelsReady("large", 2);
      runtime.tick();
      expect(actorTick).toHaveBeenCalledOnce();
    } finally { chunks.release(); runtime.stop(); }
  });

  it("Stop cancels prepared and spawned objects without a late batch or successful retry latch", async () => {
    const chunks = controlledYields();
    const commands: CommandMessage[] = [];
    const runtime = makeRuntime({ seed: 1, playScene: largeScene(), playSceneGuid: "large", cooperativeSceneLoading: chunks, onCommand: (command) => commands.push(command) });
    runtime.beginPlayLoading();
    const loading = Promise.resolve(runtime.realizePlayWorld());
    const rejected = expect(loading).rejects.toMatchObject({ name: "AbortError" });
    while (runtime.getWorld().getActors().length === 0) await chunks.next();
    const old = [...runtime.getWorld().getActors()];
    runtime.stop();
    await rejected;
    chunks.release();
    await Promise.resolve();
    expect(runtime.getWorld().getActors()).toHaveLength(0);
    expect(old.every((actor) => actor.destroyed)).toBe(true);
    expect(commands.some((command) => command.type === "sceneRealized")).toBe(false);
    await expect(runtime.realizePlayWorld()).rejects.toMatchObject({ name: "AbortError" });
  });

  it("Game Instance scene changes stop the rest of the same tick, including physics and Actor ticks", async () => {
    const chunks = controlledYields();
    chunks.release();
    const next = largeScene();
    const runtime = makeRuntime({ seed: 1, playScene: largeScene(1), playSceneGuid: "first", sceneLibrary: { next }, cooperativeSceneLoading: chunks });
    try {
      await runtime.realizePlayWorld();
      runtime.start();
      const world = runtime.getWorld();
      let changed = false;
      world.setGameInstance(world.createGameInstance({ classId: "GameInstance", hooks: { onTick: () => {
        if (!changed) { changed = true; runtime.executeConsoleCommand("changescene next"); }
      } } }));
      const actorTick = vi.spyOn(world.getActors()[0]!, "callOnTick");
      const physicsStep = vi.spyOn(runtime.getPhysicsSync()!, "step");
      runtime.tick();
      expect(actorTick).not.toHaveBeenCalled();
      expect(physicsStep).not.toHaveBeenCalled();
      await runtime.realizePlayWorld();
      runtime.tick();
      expect(physicsStep).toHaveBeenCalledOnce();
    } finally { runtime.stop(); }
  });

  it("Stop from Game Instance ends the current driver tick without later frame commands", async () => {
    const commands: CommandMessage[] = [];
    let stoppedAt = 0;
    const runtime = makeRuntime({ seed: 1, playScene: largeScene(1), cooperativeSceneLoading: true, onCommand: (command) => commands.push(command) });
    await runtime.realizePlayWorld();
    const world = runtime.getWorld();
    world.setGameInstance(world.createGameInstance({ classId: "GameInstance", hooks: { onTick: () => {
      runtime.stop();
      stoppedAt = commands.length;
    } } }));
    runtime.start();
    runtime.tick();
    expect(stoppedAt).toBeGreaterThan(0);
    expect(commands).toHaveLength(stoppedAt);
    runtime.tick();
    expect(world.clock.tickIndex).toBe(1);
  });

  it("rolls back a renderer assignment failure and keeps the load failed", async () => {
    const commands: CommandMessage[] = [];
    let failed = false;
    const runtime = makeRuntime({ seed: 1, playScene: largeScene(4), playSceneGuid: "large", cooperativeSceneLoading: true, onCommand: (command) => {
      commands.push(command);
      if (command.type === "assignMesh" && !failed) { failed = true; throw new Error("Renderer assignment failed"); }
    } });
    try {
      await expect(runtime.realizePlayWorld()).rejects.toThrow("Renderer assignment failed");
      expect(runtime.getWorld().getActors()).toHaveLength(0);
      expect(runtime.getWorld().currentScene).toBeNull();
      expect(commands.some((command) => command.type === "sceneRealized")).toBe(false);
      runtime.notifySceneModelsReady("large", 1);
      await expect(runtime.realizePlayWorld()).rejects.toThrow("Renderer assignment failed");
    } finally { runtime.stop(); }
  });
});
