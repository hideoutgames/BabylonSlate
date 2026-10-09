import { describe, expect, it, vi } from "vitest";
import { createActor, createDefaultScene } from "@babylonslate/core";
import type { CommandMessage } from "@babylonslate/bridge";
import { Actor } from "@babylonslate/object-model";
import { createInProcessRuntime } from "./driver";
import { ScriptHost, type CompiledScript, type ScriptHostServices } from "./script-host";

const flush = async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); };

function loader(source: string): CompiledScript {
  return { classId: "Loader", parentClassId: "Actor", assetGuid: "loader-script", anchors: [], source,
    entryPoints: [{ name: "begin", event: "onBeginPlay", isAsync: true }] };
}

/** One Loader actor whose Begin Play runs `source`; the Class catalog makes the host demand-driven. */
async function start(source: string, classAssetGuids: Record<string, string> = {}) {
  const commands: CommandMessage[] = [];
  const runtime = createInProcessRuntime({ seed: 1, seedDemoActors: false, preferSoftwarePhysics: true, sessionGeneration: 1,
    playScene: { ...createDefaultScene(), actors: [createActor("actor", "Actor", { classId: "Loader" })] }, playSceneGuid: "root",
    classAssetGuids: { Loader: "loader-script", ...classAssetGuids }, onCommand: command => commands.push(command) });
  await runtime.loadScripts([loader(source)]);
  await runtime.realizePlayWorld();
  runtime.start();
  return { runtime, commands, world: runtime.getWorld(), actor: runtime.getWorld().findActor("actor")! };
}

const requests = (commands: CommandMessage[]) => commands.flatMap(command => command.type === "assetPreload" ? [command] : []);
const releases = (commands: CommandMessage[]) => commands.flatMap(command => command.type === "assetPreloadRelease" ? [command.preloadId] : []);
const blocking = (commands: CommandMessage[]) => commands.flatMap(command => command.type === "simulationBlocking" ? [command.blocking] : []);

describe("script load handles in a running session", () => {
  it.each([true, false])("a blocking load holds gameplay ticks until its handle settles (success=%s), then continues with the result", async success => {
    const { runtime, commands, world, actor } = await start(`export async function begin(ctx) {
      const handle = ctx.requestAssetLoad(["cold"], { priority: "High" });
      const result = await ctx.waitForAssetLoad(handle, { blocking: true });
      ctx.setVariable("settled", result.success ? "loaded" : result.errorMessage);
    }`);
    try {
      const [request] = requests(commands);
      expect(request).toMatchObject({ assetGuids: ["cold"], ownerId: "actor", priority: "gameplay" });
      expect(blocking(commands)).toEqual([true]);
      runtime.tick();
      expect(world.clock.tickIndex).toBe(0);
      runtime.notifyAssetPreloadResult({ preloadId: request!.preloadId, success, error: success ? undefined : "Missing cold" });
      await flush();
      expect(actor.getVariable("settled")).toBe(success ? "loaded" : "Missing cold");
      expect(blocking(commands)).toEqual([true, false]);
      runtime.tick();
      expect(world.clock.tickIndex).toBe(1);
    } finally { runtime.stop(); }
  });

  it("a blocking wait on a handle that has already settled never pauses the simulation", async () => {
    const { runtime, commands, actor } = await start(`export async function begin(ctx) {
      const empty = await ctx.waitForAssetLoad(ctx.requestAssetLoad([]), { blocking: true });
      const unknown = await ctx.waitForAssetLoad("never-requested", { blocking: true });
      ctx.setVariable("settled", [empty.success, unknown.success]);
    }`);
    try {
      await vi.waitFor(() => expect(actor.getVariable("settled")).toEqual([true, false]));
      expect(blocking(commands)).toEqual([]);
      expect(requests(commands)).toEqual([]);
    } finally { runtime.stop(); }
  });

  it("an asynchronous wait leaves gameplay running and never holds the simulation", async () => {
    const { runtime, commands, world, actor } = await start(`export async function begin(ctx) {
      const result = await ctx.waitForAssetLoad(ctx.requestAssetLoad(["cold"]));
      ctx.setVariable("settled", result.success);
    }`);
    try {
      const [request] = requests(commands);
      expect(request).toMatchObject({ priority: "preload" });
      runtime.tick();
      expect(world.clock.tickIndex).toBe(1);
      runtime.notifyAssetPreloadResult({ preloadId: request!.preloadId, success: true });
      await flush();
      expect(actor.getVariable("settled")).toBe(true);
      expect(blocking(commands)).toEqual([]);
    } finally { runtime.stop(); }
  });

  it("releases a destroyed owner's handles and abandons its wait, while session-wide handles last until Stop", async () => {
    const { runtime, commands, actor } = await start(`export async function begin(ctx) {
      ctx.setVariable("owned", ctx.requestAssetLoad(["tree"]));
      ctx.setVariable("session", ctx.requestAssetLoad(["font"], { sessionWide: true }));
      await ctx.waitForAssetLoad(ctx.getVariable("owned"));
      ctx.setVariable("continued", true);
    }`);
    try {
      const [tree, font] = requests(commands);
      expect(font).toMatchObject({ assetGuids: ["font"], ownerId: "session" });
      expect(runtime.executeConsoleCommand('destroyactor "actor"').success).toBe(true);
      await flush();
      expect(releases(commands)).toEqual([tree!.preloadId]);
      expect(actor.getVariable("continued")).toBeUndefined();
      runtime.stop();
      expect(releases(commands)).toEqual([tree!.preloadId, font!.preloadId]);
    } finally { runtime.stop(); }
  });

  it("Unload Asset releases the caller's handle that includes the asset and Release drops one handle", async () => {
    const { runtime, commands, actor } = await start(`export async function begin(ctx) {
      const both = ctx.requestAssetLoad(["tree", "rock"]);
      const rock = ctx.requestAssetLoad(["rock"]);
      const extra = ctx.requestAssetLoad(["bush"]);
      ctx.unloadAsset("tree");
      ctx.releaseAssetLoad(extra);
      ctx.setVariable("states", [both, rock, extra].map(handle => ctx.getAssetLoadHandleState(handle)));
    }`);
    try {
      const [both, , extra] = requests(commands);
      expect(releases(commands)).toEqual([both!.preloadId, extra!.preloadId]);
      expect(actor.getVariable("states")).toEqual(["Released", "Loading", "Released"]);
    } finally { runtime.stop(); }
  });

  it("loads a Class through its asset so the synchronous spawn accepts it, and fails an unknown Class at once", async () => {
    const { runtime, commands, world, actor } = await start(`export async function begin(ctx) {
      const handle = ctx.requestClassLoad("Boss");
      try { ctx.spawnActor("Boss"); } catch (error) { ctx.setVariable("early", error.message); }
      ctx.setVariable("result", (await ctx.waitForAssetLoad(handle)).success);
      ctx.setVariable("late", ctx.spawnActor("Boss") ? "spawned" : "none");
      const missing = ctx.requestClassLoad("Nowhere");
      ctx.setVariable("missing", [ctx.getAssetLoadHandleState(missing), (await ctx.waitForAssetLoad(missing)).errorMessage]);
      ctx.setVariable("engine", ctx.getAssetLoadHandleState(ctx.requestClassLoad("Actor")));
    }`, { Boss: "boss-class" });
    try {
      const [request] = requests(commands);
      expect(request).toMatchObject({ assetGuids: ["boss-class"], ownerId: "actor" });
      expect(String(actor.getVariable("early"))).toContain("Async Load Class");
      await runtime.loadScripts([{ classId: "Boss", parentClassId: "Actor", assetGuid: "boss-class", anchors: [], source: "", entryPoints: [] }]);
      runtime.setAssetLoadStates([{ guid: "boss-class", state: "ready" }]);
      runtime.notifyAssetPreloadResult({ preloadId: request!.preloadId, success: true });
      await vi.waitFor(() => expect(actor.getVariable("engine")).toBe("Loaded"));
      expect(actor.getVariable("result")).toBe(true);
      expect(actor.getVariable("late")).toBe("spawned");
      expect(world.getActors().map(entry => entry.classId)).toEqual(["Loader", "Boss"]);
      expect(actor.getVariable("missing")).toEqual(["Failed", "Class Nowhere is missing from the asset catalog; choose a Class from this project"]);
      expect(actor.getVariable("engine")).toBe("Loaded");
      expect(requests(commands)).toHaveLength(1);
    } finally { runtime.stop(); }
  });
});

describe("script load handles without a host loader", () => {
  const services = (extra: Partial<ScriptHostServices> = {}): ScriptHostServices => ({
    log() {}, print() {}, destroyActor() {}, executeConsoleCommand: () => ({ success: true, output: "" }),
    delay: async () => {}, reportError() {}, ...extra });

  it("fails every load with an unavailable-host error instead of throwing", async () => {
    const ctx = new ScriptHost(services()).createContext(new Actor({ classId: "Hero", guid: "hero" }), 0, 0);
    const handle = ctx.requestAssetLoad(["texture"]);
    expect(ctx.getAssetLoadHandleState(handle)).toBe("Failed");
    expect(ctx.getAssetLoadHandleProgress(handle)).toBe(0);
    expect(await ctx.waitForAssetLoad(handle, { blocking: true })).toEqual({ success: false, errorMessage: "Asset loading is unavailable in this host" });
    expect(await ctx.waitForAssetLoad(ctx.requestClassLoad("Boss"))).toMatchObject({ success: false });
  });

  it.each([
    ["ready", "Loaded"], ["loading", "Loading"], ["failed", "Failed"], ["unloaded", "Unloaded"], [undefined, "Unloaded"],
  ] as const)("reads a host-published %s asset as %s", (published, expected) => {
    const ctx = new ScriptHost(services({ getAssetLoadState: () => published as never })).createContext(new Actor({ classId: "Hero", guid: "hero" }), 0, 0);
    expect(ctx.getAssetLoadState("asset")).toBe(expected);
  });
});
