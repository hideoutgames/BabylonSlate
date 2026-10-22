import { describe, expect, it } from "vitest";
import type { CommandMessage } from "@haptic/bridge";
import { createActor, createDefaultScene } from "@haptic/core";
import { createInProcessRuntime } from "./driver";

const flush = async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); };

describe("script Delay", () => {
  it("ends a counting Delay's graph quietly when its owner is destroyed instead of leaving it pending", async () => {
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({
      seed: 1, seedDemoActors: false, preferSoftwarePhysics: true,
      playScene: { ...createDefaultScene(), actors: [createActor("actor", "Actor", { classId: "Delayed" })] },
      onCommand: (command) => commands.push(command),
    });
    await runtime.loadScripts([{ classId: "Delayed", parentClassId: "Actor", assetGuid: "delayed", anchors: [],
      source: `export async function begin(ctx) {
        try { await ctx.delay(10); } catch (error) { ctx.log("log", "test", "ended " + error.name); throw error; }
        ctx.log("log", "test", "continued");
      }`,
      entryPoints: [{ name: "begin", event: "onBeginPlay", isAsync: true }] }]);
    try {
      runtime.realizePlayWorld(); runtime.start(); runtime.tick();
      expect(runtime.executeConsoleCommand('destroyactor "actor"').success).toBe(true);
      runtime.tick();
      await flush();
      const logs = commands.flatMap((command) => command.type === "log" && command.category === "test" ? [command.message] : []);
      expect(logs).toEqual(["ended AbortError"]);
      expect(commands.filter((command) => command.type === "diagnostic")).toEqual([]);
    } finally { runtime.stop(); }
  });
});
