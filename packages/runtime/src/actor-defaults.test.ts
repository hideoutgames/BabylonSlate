import { describe, expect, it } from "vitest";
import type { ActorDefaults } from "@babylonslate/core";
import { createInProcessRuntime } from "./driver";
import type { CompiledScript } from "./script-host";

function ticker(classId: string, parentClassId: string, actorDefaults?: ActorDefaults): CompiledScript {
  return {
    assetGuid: classId.toLowerCase(), classId, parentClassId, anchors: [],
    entryPoints: [{ name: "onTick", event: "onTick", isAsync: false }],
    source: `export function onTick(ctx) { ctx.self.setVariable("ticks", (ctx.self.getVariable("ticks") ?? 0) + 1); }`,
    ...(actorDefaults ? { actorDefaults } : {}),
  };
}

describe("Actor Defaults", () => {
  it("skips Event Tick when it resolves to Disabled along the Class chain", async () => {
    const runtime = createInProcessRuntime({ seed: 1, seedDemoActors: false, preferSoftwarePhysics: true });
    try {
      await runtime.loadScripts([
        ticker("Base", "Actor", { eventTick: "disabled", generateHitEvents: false }),
        ticker("Inheriting", "Base", { eventTick: "inherit" }),
        ticker("Reenabled", "Base", { eventTick: "enabled", generateHitEvents: true }),
        ticker("Plain", "Actor"),
      ]);
      runtime.start();
      const spawn = (classId: string) => runtime.spawnScriptedActor({ classId })!;
      const [base, inheriting, reenabled, plain] = ["Base", "Inheriting", "Reenabled", "Plain"].map(spawn);
      runtime.tick();
      runtime.tick();
      expect(base!.getVariable("ticks")).toBeUndefined();
      expect(inheriting!.getVariable("ticks")).toBeUndefined();
      expect(inheriting!.generateHitEvents).toBe(false);
      expect(reenabled!.getVariable("ticks")).toBe(2);
      expect(reenabled!.generateHitEvents).toBe(true);
      expect(plain!.getVariable("ticks")).toBe(2);
    } finally {
      runtime.stop();
    }
  });
});
