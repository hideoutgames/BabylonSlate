import { describe, expect, it } from "vitest";
import type { CommandMessage } from "@haptic/bridge";
import { createActor, createDefaultScene } from "@haptic/core";
import { createInProcessRuntime } from "./driver";
import type { CompiledScript } from "./script-host";

/** A class whose tick logs `message` at `severity`. */
function tickLogger(classId: string, severity: "log" | "error", message: string): CompiledScript {
  return {
    classId, parentClassId: "Actor", assetGuid: `${classId}.class`, anchors: [],
    source: `export function onTick(ctx) { ctx.log(${JSON.stringify(severity)}, "Probe", ${JSON.stringify(message)}); }`,
    entryPoints: [{ name: "onTick", event: "onTick", isAsync: false }],
  };
}

async function start(pauseOnErrors: boolean) {
  const commands: CommandMessage[] = [];
  const runtime = createInProcessRuntime({
    seed: 1, seedDemoActors: false, preferSoftwarePhysics: true, pauseOnErrors,
    // The failing actor ticks first, so the logger shows whether the rest of its tick still ran.
    playScene: { ...createDefaultScene(), actors: [
      createActor("broken", "Broken", { classId: "Broken" }),
      createActor("logger", "Logger", { classId: "Logger" }),
    ] },
    onCommand: (command) => commands.push(command),
  });
  await runtime.loadScripts([tickLogger("Broken", "error", "boom"), tickLogger("Logger", "log", "tick")]);
  runtime.realizePlayWorld();
  runtime.start();
  const logs = () => commands.flatMap((command) => command.type === "log" && command.category === "Probe" ? [command.message] : []);
  const pauses = () => commands.filter((command) => command.type === "sessionPaused");
  return { runtime, logs, pauses };
}

describe("Pause On Errors", () => {
  it("pauses at the end of the tick of a source's first error and names it", async () => {
    const { runtime, logs, pauses } = await start(true);
    try {
      runtime.tick();
      expect(logs()).toEqual(["boom", "tick"]);
      expect(pauses()).toEqual([{ type: "sessionPaused", paused: true,
        cause: expect.objectContaining({ code: "runtime.log", message: "boom" }) }]);
      runtime.tick();
      expect(runtime.getWorld().clock.tickIndex).toBe(1);

      // Resumed, the same source keeps reporting but never pauses again.
      runtime.resume();
      runtime.tick();
      runtime.tick();
      expect(runtime.getWorld().clock.tickIndex).toBe(3);
      expect(pauses()).toHaveLength(1);
      expect(runtime.getDiagnostics().entries()).toEqual([expect.objectContaining({ code: "runtime.log", count: 3 })]);
    } finally { runtime.stop(); }
  });

  it("keeps running on errors when it is off", async () => {
    const { runtime, pauses } = await start(false);
    try {
      runtime.tick();
      runtime.tick();
      expect(runtime.getWorld().clock.tickIndex).toBe(2);
      expect(pauses()).toEqual([]);
    } finally { runtime.stop(); }
  });
});
