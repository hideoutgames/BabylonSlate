import { describe, expect, it } from "vitest";
import type { CommandMessage } from "@babylonslate/bridge";
import { createActor, createDefaultScene } from "@babylonslate/core";
import { createInProcessRuntime } from "./driver";

const flush = async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); };

describe("script Delay", () => {
  it("cancels a Delay that is still counting when its owner is destroyed instead of leaving it pending", async () => {
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({
      seed: 1, seedDemoActors: false, preferSoftwarePhysics: true,
      playScene: { ...createDefaultScene(), actors: [createActor("actor", "Actor", { classId: "Delayed" })] },
      onCommand: (command) => commands.push(command),
    });
    await runtime.loadScripts([{ classId: "Delayed", parentClassId: "Actor", assetGuid: "delayed", anchors: [],
      source: 'export async function begin(ctx) { await ctx.delay(10); ctx.log("log", "test", "continued"); }',
      entryPoints: [{ name: "begin", event: "onBeginPlay", isAsync: true }] }]);
    try {
      runtime.realizePlayWorld(); runtime.start(); runtime.tick();
      expect(runtime.executeConsoleCommand('destroyactor "actor"').success).toBe(true);
      runtime.tick();
      await flush();
      const diagnostics = commands.flatMap((command) => command.type === "diagnostic" ? [command.message] : []);
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]).toMatch(/owner was destroyed/);
      expect(commands.some((command) => command.type === "log" && command.message === "continued")).toBe(false);
    } finally { runtime.stop(); }
  });
});
