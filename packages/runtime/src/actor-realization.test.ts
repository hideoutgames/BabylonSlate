import { describe, expect, it } from "vitest";
import type { CommandMessage } from "@haptic/bridge";
import { INFINITE_LOOP_DIAGNOSTIC_CODE } from "@haptic/debugger";
import { createInProcessRuntime } from "./driver";

describe("scripted actor realization", () => {
  it("removes an actor whose Begin Play loops and returns null instead of the half-spawned actor", async () => {
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({
      seed: 1, seedDemoActors: false, includeDebugCommands: true, infiniteLoopDetection: true, loopCount: 5,
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
});
