import { describe, expect, it, vi } from "vitest";
import { createActor, createDefaultScene, createDefaultSceneLayer, createMeshComponent } from "@babylonslate/core";
import type { CommandMessage } from "@babylonslate/bridge";
import { createInProcessRuntime, type RuntimeDriver } from "./driver";

function scene(count = 80) {
  return { ...createDefaultScene(), name: "World", actors: Array.from({ length: count }, (_, i) =>
    createActor(`actor-${i}`, `Actor ${i}`, { components: [createMeshComponent(`mesh-${i}`, "box")] })) };
}

function chunkGate() {
  let held = false;
  let release: (() => void) | null = null;
  return {
    yieldControl: () => held ? new Promise<void>((resolve) => { release = resolve; }) : Promise.resolve(),
    hold() { held = true; },
    async suspended() { await vi.waitFor(() => expect(release).not.toBeNull()); },
    open() { held = false; release?.(); release = null; },
  };
}

describe("runtime departing Scene loading", () => {
  it("paints before exit/removal, yields departing objects, and keeps Game Instance ticking with global layers retained", async () => {
    const chunks = chunkGate();
    const document = scene();
    const layerDocument = createDefaultSceneLayer();
    layerDocument.actors = [createActor("global", "Global", { classId: "SceneLayerActor" })];
    const commands: CommandMessage[] = [];
    const runtime: RuntimeDriver = createInProcessRuntime({ seed: 1, seedDemoActors: false, preferSoftwarePhysics: true,
      playScene: document, playSceneGuid: "world", sceneLayerLibrary: { global: layerDocument },
      cooperativeSceneLoading: chunks, deferSceneLoadingPaint: true,
      onCommand(command) { commands.push(command); if (command.type === "sceneLoading" && command.sceneLoadId === 1) runtime.notifySceneLoadingPainted("world", 1); },
    });
    try {
      await runtime.realizePlayWorld();
      runtime.start();
      const world = runtime.getWorld();
      const globalLayer = runtime.createSceneLayer("global")!;
      const globalActor = world.findActor("global")!;
      const previous = [...world.getActors()].filter((actor) => !actor.sceneLayerId);
      const exit = vi.spyOn(world, "exitActiveScene");
      const actorTick = vi.spyOn(previous[0]!, "callOnTick");
      const gameTick = vi.fn();
      world.setGameInstance(world.createGameInstance({ classId: "GameInstance", hooks: { onTick: gameTick } }));
      commands.length = 0;
      chunks.hold();
      runtime.executeConsoleCommand("changescene world");
      const loading = runtime.realizePlayWorld();
      await vi.waitFor(() => expect(commands[0]?.type).toBe("sceneLoading"));
      expect(exit).not.toHaveBeenCalled();
      expect(previous.every((actor) => !actor.destroyed)).toBe(true);
      runtime.tick();
      expect(gameTick).toHaveBeenCalledOnce();
      expect(actorTick).not.toHaveBeenCalled();
      runtime.notifySceneLoadingPainted("world", 2);
      await chunks.suspended();
      const removed = previous.filter((actor) => actor.destroyed).length;
      expect(removed).toBeGreaterThan(0);
      expect(removed).toBeLessThan(previous.length);
      expect(commands.some((command) => command.type === "activeScene")).toBe(false);
      runtime.tick();
      expect(gameTick).toHaveBeenCalledTimes(2);
      chunks.open();
      await loading;
      const activation = commands.findIndex((command) => command.type === "activeScene");
      expect(commands.filter((command) => command.type === "despawn")).toHaveLength(80);
      expect(commands.slice(activation).some((command) => command.type === "despawn")).toBe(false);
      expect(world.findActor("global")).toBe(globalActor);
      expect(world.findSceneLayer(globalLayer.guid)).toBe(globalLayer);
    } finally { chunks.open(); runtime.stop(); }
  });

  it("ignores a cancelled same-guid paint acknowledgment and follows the replacement without leaking departing actors", async () => {
    const commands: CommandMessage[] = [];
    const runtime: RuntimeDriver = createInProcessRuntime({ seed: 1, seedDemoActors: false, playScene: scene(2), playSceneGuid: "world", cooperativeSceneLoading: true, deferSceneLoadingPaint: true,
      onCommand(command) { commands.push(command); if (command.type === "sceneLoading" && command.sceneLoadId === 1) runtime.notifySceneLoadingPainted("world", 1); },
    });
    try {
      await runtime.realizePlayWorld();
      const old = runtime.getWorld().getActors()[0]!;
      runtime.executeConsoleCommand("changescene world");
      const loading = runtime.realizePlayWorld();
      await vi.waitFor(() => expect(commands.some((command) => command.type === "sceneLoading" && command.sceneLoadId === 2)).toBe(true));
      runtime.executeConsoleCommand("changescene world");
      await vi.waitFor(() => expect(commands.some((command) => command.type === "sceneLoading" && command.sceneLoadId === 3)).toBe(true));
      runtime.notifySceneLoadingPainted("world", 2);
      await Promise.resolve();
      expect(old.destroyed).toBe(false);
      runtime.notifySceneLoadingPainted("world", 3);
      await loading;
      expect(old.destroyed).toBe(true);
      expect(runtime.getWorld().getActors()).toHaveLength(2);
      expect(commands.filter((command) => command.type === "sceneRealized").map((command) => command.sceneLoadId)).toEqual([1, 3]);
    } finally { runtime.stop(); }
  });

  it("Stop cancels a held paint without allowing a late host acknowledgment to restart realization", async () => {
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({ seed: 1, seedDemoActors: false, playScene: scene(2), playSceneGuid: "world", cooperativeSceneLoading: true, deferSceneLoadingPaint: true, onCommand: (command) => commands.push(command) });
    const loading = Promise.resolve(runtime.realizePlayWorld());
    const rejected = expect(loading).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(commands.some((command) => command.type === "sceneLoading")).toBe(true));
    runtime.stop();
    await rejected;
    runtime.notifySceneLoadingPainted("world", 1);
    await Promise.resolve();
    expect(commands.some((command) => command.type === "activeScene" || command.type === "sceneRealized")).toBe(false);
    expect(runtime.getWorld().getActors()).toHaveLength(0);
  });

  it("Stop retires the remaining owned objects while outgoing teardown is suspended", async () => {
    const chunks = chunkGate();
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({ seed: 1, seedDemoActors: false, playScene: scene(), playSceneGuid: "world", cooperativeSceneLoading: chunks, onCommand: (command) => commands.push(command) });
    try {
      await runtime.realizePlayWorld();
      const departing = [...runtime.getWorld().getActors()];
      chunks.hold();
      runtime.executeConsoleCommand("changescene world");
      const rejected = expect(runtime.realizePlayWorld()).rejects.toMatchObject({ name: "AbortError" });
      await chunks.suspended();
      expect(departing.some((actor) => actor.destroyed)).toBe(true);
      expect(departing.some((actor) => !actor.destroyed)).toBe(true);
      runtime.stop();
      await rejected;
      chunks.open();
      await Promise.resolve();
      expect(departing.every((actor) => actor.destroyed)).toBe(true);
      expect(runtime.getWorld().getActors()).toHaveLength(0);
      expect(commands.some((command) => (command.type === "activeScene" || command.type === "sceneRealized") && command.sceneLoadId === 2)).toBe(false);
    } finally { chunks.open(); runtime.stop(); }
  });

  it("fails a missing host paint at the deadline without reporting the Scene ready", async () => {
    vi.useFakeTimers();
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({ seed: 1, seedDemoActors: false, playScene: scene(2), playSceneGuid: "world", cooperativeSceneLoading: true, deferSceneLoadingPaint: true, onCommand: (command) => commands.push(command) });
    try {
      const loading = Promise.resolve(runtime.realizePlayWorld());
      const rejected = expect(loading).rejects.toThrow("loading deadline");
      await vi.advanceTimersByTimeAsync(30_000);
      await rejected;
      expect(commands.some((command) => command.type === "sceneLoadFailed" && command.sceneLoadId === 1)).toBe(true);
      expect(commands.some((command) => command.type === "activeScene" || command.type === "sceneRealized")).toBe(false);
      runtime.notifySceneLoadingPainted("world", 1);
      await expect(runtime.realizePlayWorld()).rejects.toThrow("loading deadline");
    } finally { runtime.stop(); vi.useRealTimers(); }
  });
});
