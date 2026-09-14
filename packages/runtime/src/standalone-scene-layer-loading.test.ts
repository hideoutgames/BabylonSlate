import { describe, expect, it, vi } from "vitest";
import { createActor, createDefaultScene, createDefaultSceneLayer, createMeshComponent } from "@babylonslate/core";
import type { CommandMessage } from "@babylonslate/bridge";
import { createInProcessRuntime, type RuntimeDriver } from "./driver";
import type { CompiledScript } from "./script-host";

const actorScript: CompiledScript = {
  assetGuid: "layer-script", classId: "LoadingActor", parentClassId: "SceneLayerActor", anchors: [],
  source: `export function begin(ctx) { ctx.self.setVariable("began", true); }
    export function tick(ctx) { ctx.self.setVariable("ticks", Number(ctx.self.getVariable("ticks") ?? 0) + 1); }`,
  entryPoints: [{ name: "begin", event: "onBeginPlay", isAsync: false }, { name: "tick", event: "onTick", isAsync: false }],
};

function layerDocument(count: number) {
  return { ...createDefaultSceneLayer(), actors: Array.from({ length: count }, (_, index) =>
    createActor(`actor-${index}`, `Layer Actor ${index}`, { classId: "LoadingActor",
      components: [createMeshComponent(`mesh-${index}`, "box")] })) };
}

function chunkGate() {
  let held = false;
  let pending: (() => void) | undefined;
  return {
    yieldControl: () => held ? new Promise<void>((resolve) => { pending = resolve; }) : Promise.resolve(),
    hold() { held = true; },
    async next() {
      await vi.waitFor(() => expect(pending).toBeDefined());
      const resolve = pending!;
      pending = undefined;
      resolve();
    },
    open() { held = false; pending?.(); pending = undefined; },
  };
}

async function fixture(onCommand?: (command: CommandMessage) => void) {
  const commands: CommandMessage[] = [];
  const chunks = chunkGate();
  const runtime: RuntimeDriver = createInProcessRuntime({ seed: 1, seedDemoActors: false, preferSoftwarePhysics: true,
    playScene: { ...createDefaultScene(), actors: [] }, playSceneGuid: "world",
    sceneLayerLibrary: { small: layerDocument(1), large: layerDocument(80) }, cooperativeSceneLoading: chunks,
    deferSceneLoadingPaint: true, deferSceneModelsReady: true,
    onCommand(command) {
      commands.push(command);
      if (command.type === "sceneLoading") runtime.notifySceneLoadingPainted(command.sceneAssetGuid, command.sceneLoadId);
      onCommand?.(command);
    },
  });
  await runtime.loadScripts([actorScript]);
  await runtime.realizePlayWorld();
  runtime.start();
  runtime.notifySceneModelsReady("world", 1);
  const token = (layerId: string) => {
    const command = commands.find((entry) => entry.type === "sceneLayerLoading" && entry.layerId === layerId);
    if (command?.type !== "sceneLayerLoading") throw new Error("Missing loading owner");
    return command.layerLoadId;
  };
  const realized = (layerId: string) => commands.some((entry) => entry.type === "sceneLayerRealized" && entry.layerId === layerId);
  return { runtime, commands, chunks, token, realized };
}

describe("standalone SceneLayer loading", () => {
  it("paints before actor work and preserves Game Instance and ready-layer ticks through partial realization and presentation", async () => {
    const { runtime, commands, chunks, token, realized } = await fixture();
    try {
      const world = runtime.getWorld();
      const retained = runtime.createSceneLayer("small")!;
      runtime.notifySceneLayerLoadingPainted(retained.guid, token(retained.guid));
      await vi.waitFor(() => expect(realized(retained.guid)).toBe(true));
      runtime.notifySceneLayerReady(retained.guid, token(retained.guid));
      const retainedActor = world.getActors()[0]!;
      expect(retainedActor.getVariable("began")).toBe(true);
      const gameTick = vi.fn();
      world.setGameInstance(world.createGameInstance({ classId: "GameInstance", hooks: { onTick: gameTick } }));
      const assignedBefore = commands.filter((command) => command.type === "assignMesh").length;
      chunks.hold();
      const loading = runtime.createSceneLayer("large")!;
      runtime.notifySceneLayerLoadingPainted(loading.guid, token(loading.guid) - 1);
      await Promise.resolve();
      expect(world.getActors()).toEqual([retainedActor]);
      expect(commands.filter((command) => command.type === "assignMesh")).toHaveLength(assignedBefore);
      runtime.tick();
      expect(gameTick).toHaveBeenCalledOnce();
      expect(retainedActor.getVariable("ticks")).toBe(1);
      runtime.notifySceneLayerLoadingPainted(loading.guid, token(loading.guid));
      while (!world.getActors().some((actor) => actor.sceneLayerId === loading.guid)) await chunks.next();
      const partial = world.getActors().find((actor) => actor.sceneLayerId === loading.guid)!;
      runtime.notifySceneLayerReady(loading.guid, token(loading.guid));
      runtime.tick();
      expect(gameTick).toHaveBeenCalledTimes(2);
      expect(retainedActor.getVariable("ticks")).toBe(2);
      expect(partial.getVariable("began")).toBeUndefined();
      expect(partial.getVariable("ticks")).toBeUndefined();
      expect(realized(loading.guid)).toBe(false);
      chunks.open();
      await vi.waitFor(() => expect(realized(loading.guid)).toBe(true));
      expect(commands.filter((command) => command.type === "assignMesh")).toHaveLength(81);
      const marker = commands.findIndex((command) => command.type === "sceneLayerRealized" && command.layerId === loading.guid);
      expect(commands.slice(marker + 1).some((command) => command.type === "assignMesh")).toBe(false);
      runtime.tick();
      expect(partial.getVariable("began")).toBeUndefined();
      expect(partial.getVariable("ticks")).toBeUndefined();
      runtime.notifySceneLayerReady(loading.guid, token(loading.guid));
      runtime.tick();
      expect(partial.getVariable("began")).toBe(true);
      expect(partial.getVariable("ticks")).toBe(1);
    } finally { chunks.open(); runtime.stop(); }
  });

  it.each(["before paint", "during realization"] as const)("removal %s suppresses late work and acknowledgments without removing a replacement", async (phase) => {
    const { runtime, commands, chunks, token, realized } = await fixture();
    try {
      chunks.hold();
      const old = runtime.createSceneLayer("large")!;
      if (phase === "during realization") {
        runtime.notifySceneLayerLoadingPainted(old.guid, token(old.guid));
        while (!runtime.getWorld().getActors().length) await chunks.next();
      }
      const partial = [...runtime.getWorld().getActors()];
      runtime.removeSceneLayer(old.guid);
      const replacement = runtime.createSceneLayer("small")!;
      runtime.notifySceneLayerLoadingPainted(old.guid, token(old.guid));
      runtime.notifySceneLayerReady(replacement.guid, token(old.guid));
      chunks.open();
      await Promise.resolve();
      expect(runtime.getWorld().getActors()).toEqual([]);
      runtime.notifySceneLayerLoadingPainted(replacement.guid, token(replacement.guid));
      await vi.waitFor(() => expect(realized(replacement.guid)).toBe(true));
      expect(runtime.getWorld().getSceneLayers()).toEqual([replacement]);
      expect(partial.every((actor) => actor.destroyed)).toBe(true);
      expect(realized(old.guid)).toBe(false);
      expect(commands.some((command) => command.type === "sceneLayerLoadFailed")).toBe(false);
      const replacementActor = runtime.getWorld().getActors()[0]!;
      expect(replacementActor.getVariable("began")).toBeUndefined();
      runtime.notifySceneLayerReady(replacement.guid, token(replacement.guid));
      expect(replacementActor.getVariable("began")).toBe(true);
    } finally { chunks.open(); runtime.stop(); }
  });

  it.each(["before paint", "during realization"] as const)("Stop %s cancels queued work without a late ready marker or authored callback", async (phase) => {
    const { runtime, commands, chunks, token, realized } = await fixture();
    try {
      chunks.hold();
      const layer = runtime.createSceneLayer("large")!;
      if (phase === "during realization") {
        runtime.notifySceneLayerLoadingPainted(layer.guid, token(layer.guid));
        while (!runtime.getWorld().getActors().length) await chunks.next();
      }
      const partial = [...runtime.getWorld().getActors()];
      runtime.stop();
      const commandCount = commands.length;
      runtime.notifySceneLayerLoadingPainted(layer.guid, token(layer.guid));
      runtime.notifySceneLayerReady(layer.guid, token(layer.guid));
      chunks.open();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(commands).toHaveLength(commandCount);
      expect(realized(layer.guid)).toBe(false);
      expect(partial.every((actor) => actor.destroyed && actor.getVariable("began") === undefined)).toBe(true);
      expect(runtime.getWorld().getSceneLayers()).toEqual([]);
      expect(runtime.createSceneLayer("small")).toBeNull();
    } finally { chunks.open(); runtime.stop(); }
  });

  it("reports partial structural failure before removal and releases only the failed owner's actors", async () => {
    let assignments = 0;
    const { runtime, commands, token, realized } = await fixture((command) => {
      if (command.type === "assignMesh" && ++assignments === 3) throw new Error("GPU assignment unavailable");
    });
    try {
      const retained = runtime.createSceneLayer("small")!;
      runtime.notifySceneLayerLoadingPainted(retained.guid, token(retained.guid));
      await vi.waitFor(() => expect(realized(retained.guid)).toBe(true));
      const retainedActor = runtime.getWorld().getActors()[0]!;
      const failed = runtime.createSceneLayer("large")!;
      runtime.notifySceneLayerLoadingPainted(failed.guid, token(failed.guid));
      await vi.waitFor(() => expect(runtime.getWorld().findSceneLayer(failed.guid)).toBeNull());
      const failure = commands.findIndex((command) => command.type === "sceneLayerLoadFailed" && command.layerId === failed.guid);
      const removal = commands.findIndex((command) => command.type === "sceneLayerRemove" && command.layerId === failed.guid);
      expect(failure).toBeGreaterThan(-1);
      expect(failure).toBeLessThan(removal);
      expect(realized(failed.guid)).toBe(false);
      expect(runtime.getWorld().getActors()).toEqual([retainedActor]);
      runtime.notifySceneLayerReady(failed.guid, token(failed.guid));
      expect(retainedActor.destroyed).toBe(false);
    } finally { runtime.stop(); }
  });

  it("expires an unpainted host and ignores its late acknowledgment without leaking the layer", async () => {
    const { runtime, commands, token, realized } = await fixture();
    vi.useFakeTimers();
    try {
      const layer = runtime.createSceneLayer("large")!;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(commands).toContainEqual(expect.objectContaining({ type: "sceneLayerLoadFailed", layerId: layer.guid }));
      expect(runtime.getWorld().getSceneLayers()).toEqual([]);
      runtime.notifySceneLayerLoadingPainted(layer.guid, token(layer.guid));
      await vi.runAllTimersAsync();
      expect(realized(layer.guid)).toBe(false);
      expect(commands.some((command) => command.type === "assignMesh")).toBe(false);
    } finally { runtime.stop(); vi.useRealTimers(); }
  });
});
