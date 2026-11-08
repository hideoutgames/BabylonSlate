import { describe, expect, it, vi } from "vitest";
import type { CommandMessage } from "@haptic/bridge";
import { createActor, createDefaultScene } from "@haptic/core";
import { INFINITE_LOOP_DIAGNOSTIC_CODE } from "@haptic/debugger";
import { createInProcessRuntime } from "./driver";
import { OwnerAdmission } from "./owner-admission";
import type { CompiledScript } from "./script-host";

function tickCounter(classId: string, parentClassId: string, body = ""): CompiledScript {
  return {
    assetGuid: `${classId}.class`, classId, parentClassId, anchors: [],
    entryPoints: [{ name: "onTick", event: "onTick", isAsync: false }],
    source: `export function onTick(ctx) { ${body} ctx.self.setVariable("ticks", (ctx.self.getVariable("ticks") ?? 0) + 1); }`,
  };
}

describe("scripted actor realization", () => {
  it("removes an actor whose Begin Play loops and returns null instead of the half-spawned actor", async () => {
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({
      seed: 1, includeDebugCommands: true, infiniteLoopDetection: true, loopCount: 5,
      onCommand: (command) => commands.push(command),
    });
    try {
      await runtime.loadScripts([{
        assetGuid: "looper", classId: "Looper", parentClassId: "Actor", anchors: [],
        entryPoints: [{ name: "begin", event: "onBeginPlay", isAsync: false }],
        source: "export function begin(ctx) { while (true) { ctx.checkInfiniteLoop(); } }",
      }]);

      let spawned: unknown;
      expect(() => { spawned = runtime.spawnScriptedActor({ classId: "Looper" }); }).not.toThrow();

      expect(spawned).toBeNull();
      expect(commands.filter((command) => command.type === "diagnostic").map((command) =>
        command.type === "diagnostic" ? command.code : null)).toEqual([INFINITE_LOOP_DIAGNOSTIC_CODE]);
      const spawn = commands.find((command) => command.type === "spawn" && command.classId === "Looper");
      expect(spawn).toBeDefined();
      expect(commands).toContainEqual(expect.objectContaining({
        type: "despawn", slotId: spawn?.type === "spawn" ? spawn.slotId : -1,
      }));
      runtime.getWorld().flushPending();
      expect(runtime.getWorld().getActors().some((actor) => actor.classId === "Looper")).toBe(false);
    } finally { runtime.stop(); }
  });

  it("ticks scene, spawned and component scripts without a guard closure per call, and a looping Tick still aborts the tick", async () => {
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({
      seed: 1, preferSoftwarePhysics: true, infiniteLoopDetection: true, loopCount: 5,
      playScene: { ...createDefaultScene(), actors: [
        createActor("looper", "Looper", { classId: "Looper" }),
        createActor("ticker", "Ticker", { classId: "Ticker", components: [{ id: "counter", classId: "Counter", properties: {} }] }),
      ] },
      onCommand: (command) => commands.push(command),
    });
    const guard = vi.spyOn(OwnerAdmission.prototype, "guard");
    try {
      await runtime.loadScripts([
        tickCounter("Looper", "Actor", 'if (ctx.self.getVariable("loop") === true) { while (true) { ctx.checkInfiniteLoop(); } }'),
        tickCounter("Ticker", "Actor"),
        tickCounter("Counter", "ActorComponent"),
      ]);
      runtime.realizePlayWorld();
      runtime.start();
      const spawned = runtime.spawnScriptedActor({ classId: "Ticker" })!;
      runtime.getWorld().flushPending();
      const world = runtime.getWorld();
      const looper = world.findActor("looper")!;
      const ticker = world.findActor("ticker")!;
      const counter = ticker.components.find((component) => component.classId === "Counter")!;
      guard.mockClear();

      runtime.tick();
      runtime.tick();
      expect([looper, ticker, spawned, counter].map((owner) => owner.getVariable("ticks"))).toEqual([2, 2, 2, 2]);
      expect(guard).not.toHaveBeenCalled();

      // Through the Tick guard an infinite loop still propagates and ends the tick's actor phase.
      looper.setVariable("loop", true);
      runtime.tick();
      expect(commands.filter((command) => command.type === "diagnostic").map((command) =>
        command.type === "diagnostic" ? command.code : null)).toEqual([INFINITE_LOOP_DIAGNOSTIC_CODE]);
      expect([ticker, spawned, counter].map((owner) => owner.getVariable("ticks"))).toEqual([2, 2, 2]);
    } finally {
      guard.mockRestore();
      runtime.stop();
    }
  });
});
