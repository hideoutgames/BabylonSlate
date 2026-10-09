import { describe, expect, it } from "vitest";
import { createActor, createDefaultScene } from "@babylonslate/core";
import type { CommandMessage, SessionBoundaryResult } from "@babylonslate/bridge";
import { createInProcessRuntime, type RuntimeDriver } from "./driver";

const makeRuntime = (options: Partial<Parameters<typeof createInProcessRuntime>[0]> = {}) =>
  createInProcessRuntime({ seed: 1, seedDemoActors: false, preferSoftwarePhysics: true, sessionGeneration: 7,
    playScene: createDefaultScene(), playSceneGuid: "root", ...options });
const flush = async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); };

describe("runtime session boundaries", () => {
  it("acknowledges reentrant pause only after the completed tick and render commands", async () => {
    const commands: CommandMessage[] = [];
    let armed = false;
    let result: Promise<SessionBoundaryResult> | undefined;
    const runtime: RuntimeDriver = makeRuntime({ onCommand: command => {
      commands.push(command);
      if (armed && command.type === "stats") {
        armed = false;
        result = runtime.requestSessionBoundary({ sessionGeneration: 7, requestId: 1,
          action: { kind: "pause", reason: "user", paused: true } });
      }
    } });
    try {
      runtime.realizePlayWorld(); runtime.start(); armed = true; runtime.tick();
      expect(result).toBeDefined();
      const reply = await result!;
      expect(reply).toMatchObject({ success: true, sessionGeneration: 7, requestId: 1,
        paused: true, pauseReasons: ["user"], tickIndex: 1, sceneAssetGuid: "root" });
      expect(reply.commandRevision).toBe(commands.length);
      runtime.advance(20); runtime.tick();
      expect(runtime.getWorld().clock.tickIndex).toBe(1);
    } finally { runtime.stop(); }
  });

  it("composes user, lifecycle and loading holds and rebases elapsed time on the final resume", async () => {
    const runtime = makeRuntime({ dt: 0.1 });
    let requestId = 0;
    const pause = (reason: "user" | "lifecycle" | "loading", paused: boolean) => runtime.requestSessionBoundary({
      sessionGeneration: 7, requestId: ++requestId, action: { kind: "pause", reason, paused } });
    try {
      runtime.realizePlayWorld(); runtime.start(); runtime.advance(0.15);
      expect(runtime.getWorld().clock.tickIndex).toBe(1);
      await pause("user", true); await pause("lifecycle", true); await pause("loading", true);
      runtime.executeConsoleCommand("resume");
      expect((await pause("lifecycle", false)).pauseReasons).toEqual(["loading"]);
      runtime.tick();
      expect(runtime.getWorld().clock.tickIndex).toBe(1);
      expect((await pause("loading", false)).paused).toBe(false);
      runtime.advance(300);
      expect(runtime.getWorld().clock.tickIndex).toBe(1);
      runtime.advance(0.1);
      expect(runtime.getWorld().clock.tickIndex).toBe(2);
    } finally { runtime.stop(); }
  });

  it("rejects stale, repeated, malformed, overflowing and stopped requests without changing the world", async () => {
    const runtime = makeRuntime();
    const pause = (requestId: number, sessionGeneration = 7) => runtime.requestSessionBoundary({
      sessionGeneration, requestId, action: { kind: "pause", reason: "user", paused: true } });
    try {
      runtime.realizePlayWorld(); runtime.start();
      expect((await pause(1, 6)).success).toBe(false);
      expect((await pause(Number.NaN)).success).toBe(false);
      const pending = Array.from({ length: 64 }, (_, index) => pause(index + 1));
      const overflow = pause(65);
      expect((await overflow).success).toBe(false);
      expect((await Promise.all(pending)).every(result => result.success)).toBe(true);
      expect((await pause(64)).success).toBe(false);
      const stopped = pause(66);
      runtime.stop();
      expect((await stopped).success).toBe(false);
      expect((await pause(67)).success).toBe(false);
      expect(runtime.getWorld().clock.tickIndex).toBe(0);
    } finally { runtime.stop(); }
  });

  it("resets every resolved input device while paused without ticking or accepting queued presses", async () => {
    const runtime = makeRuntime({ inputMappings: {
      actions: [{ name: "Fire", bindings: [{ device: "key", code: "KeyF" }, { device: "mouseButton", code: "0" }, { device: "gamepadButton", code: "0:0" }] }],
      axes: [{ name: "Move", bindings: [{ device: "gamepadAxis", code: "0:0" }, { device: "touch", code: "move" }] }],
    } });
    try {
      runtime.realizePlayWorld(); runtime.start();
      runtime.pushInput([{ kind: "key", tick: 0, code: "KeyF", phase: "down" },
        { kind: "pointer", tick: 0, pointerId: 2, phase: "down", x: 10, y: 20, button: 0 },
        { kind: "gamepad", tick: 0, gamepadIndex: 0, axes: [0.5], buttons: [1] },
        { kind: "touchAxis", tick: 0, controlId: "move", value: 0.5 }]);
      runtime.tick();
      expect(runtime.getResolvedInput().actions.Fire.held).toBe(true);
      runtime.pause();
      runtime.pushInput([{ kind: "key", tick: 1, code: "KeyF", phase: "down" }]);
      const reply = await runtime.requestSessionBoundary({ sessionGeneration: 7, requestId: 1, action: { kind: "resetInput" } });
      expect(reply).toMatchObject({ success: true, paused: true, tickIndex: 1 });
      expect(runtime.getResolvedInput()).toMatchObject({ actions: { Fire: { held: false, pressed: false } }, axes: { Move: 0 }, cursor: { pressed: false } });
      runtime.resume(); runtime.tick();
      expect(runtime.getResolvedInput().actions.Fire.held).toBe(false);
    } finally { runtime.stop(); }
  });

  it.each(["resume", "stop"] as const)("holds a completed engine delay until %s resolves the session", async (finish) => {
    const commands: CommandMessage[] = [];
    const runtime = makeRuntime({ playScene: { ...createDefaultScene(), actors: [createActor("actor", "Actor", { classId: "Delayed" })] },
      onCommand: command => commands.push(command) });
    await runtime.loadScripts([{ classId: "Delayed", parentClassId: "Actor", assetGuid: "delayed", anchors: [],
      source: 'export async function begin(ctx) { await ctx.delay(0.01); ctx.log("log", "test", "continued"); }',
      entryPoints: [{ name: "begin", event: "onBeginPlay", isAsync: true }] }]);
    try {
      runtime.realizePlayWorld(); runtime.start(); runtime.tick();
      await runtime.requestSessionBoundary({ sessionGeneration: 7, requestId: 1,
        action: { kind: "pause", reason: "user", paused: true } });
      await flush();
      expect(commands.some(command => command.type === "log" && command.message === "continued")).toBe(false);
      if (finish === "resume") runtime.resume(); else runtime.stop();
      await flush();
      expect(commands.some(command => command.type === "log" && command.message === "continued")).toBe(finish === "resume");
      expect(commands.some(command => command.type === "diagnostic")).toBe(false);
    } finally { runtime.stop(); }
  });

  it("reports a held continuation whose owner was destroyed during Pause as an owner cancellation", async () => {
    const commands: CommandMessage[] = [];
    const runtime = makeRuntime({ playScene: { ...createDefaultScene(), actors: [createActor("actor", "Actor", { classId: "Delayed" })] },
      onCommand: command => commands.push(command) });
    await runtime.loadScripts([{ classId: "Delayed", parentClassId: "Actor", assetGuid: "delayed", anchors: [],
      source: 'export async function begin(ctx) { await ctx.delay(0.01); ctx.log("log", "test", "continued"); }',
      entryPoints: [{ name: "begin", event: "onBeginPlay", isAsync: true }] }]);
    try {
      runtime.realizePlayWorld(); runtime.start(); runtime.tick();
      // The Delay completed in that tick; Pause holds its continuation.
      runtime.pause();
      await flush();
      expect(runtime.executeConsoleCommand('destroyactor "actor"').success).toBe(true);
      runtime.resume();
      await flush();
      const diagnostics = commands.flatMap(command => command.type === "diagnostic" ? [command.message] : []);
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]).toMatch(/owner was destroyed/);
      expect(diagnostics[0]).not.toMatch(/Scene realization/);
      expect(commands.some(command => command.type === "log" && command.message === "continued")).toBe(false);
    } finally { runtime.stop(); }
  });

  it.each(["resume", "stop"] as const)("holds a finished asset load's continuation until %s", async finish => {
    const commands: CommandMessage[] = [];
    const runtime = makeRuntime({ classAssetGuids: { Loading: "loading-class" },
      playScene: { ...createDefaultScene(), actors: [createActor("actor", "Actor", { classId: "Loading" })] },
      onCommand: command => commands.push(command) });
    try {
      await runtime.loadScripts([{ classId: "Loading", parentClassId: "Actor", assetGuid: "loading-class", anchors: [],
        source: 'export async function begin(ctx) { const result = await ctx.waitForAssetLoad(ctx.requestAssetLoad(["cold"])); ctx.setVariable("continued", result.success); }',
        entryPoints: [{ name: "begin", event: "onBeginPlay", isAsync: true }] }]);
      runtime.realizePlayWorld(); runtime.start();
      const actor = runtime.getWorld().findActor("actor")!;
      const request = commands.find(command => command.type === "assetPreload");
      if (request?.type !== "assetPreload") throw new Error("missing asset load request");
      await runtime.requestSessionBoundary({ sessionGeneration: 7, requestId: 1, action: { kind: "pause", reason: "user", paused: true } });
      runtime.notifyAssetPreloadResult({ preloadId: request.preloadId, success: true });
      await flush();
      expect(actor.getVariable("continued")).toBeUndefined();
      if (finish === "resume") runtime.resume(); else runtime.stop();
      await flush();
      expect(actor.getVariable("continued")).toBe(finish === "resume" ? true : undefined);
      expect(runtime.getWorld().clock.tickIndex).toBe(0);
    } finally { runtime.stop(); }
  });

  it("defers a cold spawn after its sources become ready while user-paused", async () => {
    const commands: CommandMessage[] = [];
    const runtime = makeRuntime({ classAssetGuids: { Loading: "loading-class", Cold: "cold-class" },
      playScene: { ...createDefaultScene(), actors: [createActor("actor", "Actor", { classId: "Loading" })] },
      onCommand: command => commands.push(command) });
    try {
      await runtime.loadScripts([{ classId: "Loading", parentClassId: "Actor", assetGuid: "loading-class", anchors: [],
        source: 'export async function begin(ctx) { await ctx.spawnActorAsync("Cold"); ctx.setVariable("continued", true); }',
        entryPoints: [{ name: "begin", event: "onBeginPlay", isAsync: true }] }]);
      runtime.realizePlayWorld(); runtime.start();
      const request = commands.find(command => command.type === "assetPreload");
      if (request?.type !== "assetPreload") throw new Error("missing class preload");
      runtime.pause();
      await runtime.loadScripts([{ classId: "Cold", parentClassId: "Actor", assetGuid: "cold-class", anchors: [], source: "", entryPoints: [] }]);
      runtime.setAssetLoadStates([{ guid: "cold-class", state: "ready" }]);
      runtime.notifyAssetPreloadResult({ preloadId: request.preloadId, success: true });
      await flush();
      expect(runtime.getWorld().getActors()).toHaveLength(1);
      runtime.resume(); await flush();
      expect(runtime.getWorld().getActors().map(actor => actor.classId)).toEqual(["Loading", "Cold"]);
      expect(runtime.getWorld().findActor("actor")!.getVariable("continued")).toBe(true);
      expect(runtime.getWorld().clock.tickIndex).toBe(0);
    } finally { runtime.stop(); }
  });

  it("queues ready-scene Begin Play and audio callbacks until the user hold clears", async () => {
    const runtime = makeRuntime({ deferSceneModelsReady: true,
      playScene: { ...createDefaultScene(), actors: [createActor("actor", "Actor", { classId: "Listener", components: [
        { id: "audio", classId: "AudioComponent", properties: {} },
      ] })] } });
    try {
      await runtime.loadScripts([{ classId: "Listener", parentClassId: "Actor", assetGuid: "listener", anchors: [],
        source: 'export function begin(ctx) { ctx.self.setVariable("began", true); } export function audio(ctx) { ctx.self.setVariable("heard", true); }',
        entryPoints: [{ name: "begin", event: "onBeginPlay", isAsync: false }, { name: "audio", event: "onAudioFinished", componentId: "audio", isAsync: false }] }]);
      runtime.pause(); runtime.realizePlayWorld(); runtime.start();
      runtime.notifySceneModelsReady("root", 1);
      runtime.applyAudioVoiceEnded({ type: "audioVoiceEnded", voiceId: "audio" });
      const actor = runtime.getWorld().findActor("actor")!;
      expect(actor.getVariable("began")).toBeUndefined(); expect(actor.getVariable("heard")).toBeUndefined();
      runtime.resume();
      expect(actor.getVariable("began")).toBe(true); expect(actor.getVariable("heard")).toBe(true);
      expect(runtime.getWorld().clock.tickIndex).toBe(0);
    } finally { runtime.stop(); }
  });
});
