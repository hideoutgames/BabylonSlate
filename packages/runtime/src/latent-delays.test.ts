import { describe, expect, it } from "vitest";
import { createActor } from "@haptic/core";
import { startGraphScenario } from "./testing/graph-scenario";

describe("script Delay", () => {
  it("ends a counting Delay's graph quietly when its owner is destroyed instead of leaving it pending", async () => {
    const scenario = await startGraphScenario({
      actors: [createActor("actor", "Actor", { classId: "Delayed" })],
      scripts: [{ classId: "Delayed", parentClassId: "Actor", assetGuid: "delayed", anchors: [],
        source: `export async function begin(ctx) {
        try { await ctx.delay(10); } catch (error) { ctx.log("log", "test", "ended " + error.name); throw error; }
        ctx.log("log", "test", "continued");
      }`,
        entryPoints: [{ name: "begin", event: "onBeginPlay", isAsync: true }] }],
    });
    try {
      await scenario.tick();
      expect(scenario.runtime.executeConsoleCommand('destroyactor "actor"').success).toBe(true);
      await scenario.tick();
      expect(scenario.logs("test")).toEqual(["ended AbortError"]);
      expect(scenario.diagnostics()).toEqual([]);
    } finally { scenario.stop(); }
  });
});
