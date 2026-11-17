import { afterEach, describe, expect, it } from "vitest";
import { createDefaultScene, sampleEasingCurve, setCustomEasingCurves } from "@haptic/core";
import type { CommandMessage } from "@haptic/bridge";
import { createInProcessRuntime } from "./driver";
import type { CompiledScript } from "./script-host";

/** A Class with an Evaluate override whose body is `body` (Alpha is `alpha`). */
function curveClass(classId: string, parentClassId: string, body?: string): CompiledScript {
  return {
    assetGuid: classId.toLowerCase(), classId, parentClassId, anchors: [],
    entryPoints: body ? [{ name: "Evaluate", isAsync: false }] : [],
    source: body ? `export function Evaluate(ctx) { const alpha = ctx.args.Alpha; ${body} }` : "",
  };
}

type Curves = Extract<CommandMessage, { type: "setCustomEasingCurves" }>["curves"];

function bakedCommands(commands: readonly CommandMessage[]): Curves[] {
  return commands.flatMap((command) => (command.type === "setCustomEasingCurves" ? [command.curves] : []));
}

afterEach(() => setCustomEasingCurves({}));

describe("custom easing curve baking", () => {
  it("bakes each curve Class before Play starts, with inheritance and Linear fallbacks, and sends the tables", async () => {
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({ seed: 1, dt: 0.1, preferSoftwarePhysics: true,
      playScene: createDefaultScene(), onCommand: (command) => commands.push(command) });
    try {
      await runtime.loadScripts([
        curveClass("Square", "CustomEasingCurve", "return { Value: alpha * alpha };"),
        // No override: Square's Evaluate runs on it.
        curveClass("SquareChild", "Square"),
        // Non-finite below half way, a string at Alpha 1: those samples are Linear.
        curveClass("Broken", "CustomEasingCurve", "return { Value: alpha < 0.5 ? NaN : alpha === 1 ? '2' : 2 };"),
        // Latent: its outputs come too late, so every sample is Linear.
        curveClass("Waits", "CustomEasingCurve", "return Promise.resolve({ Value: 5 });"),
        { assetGuid: "plain", classId: "Plain", parentClassId: "Object", anchors: [], entryPoints: [], source: "" },
      ]);
      const sent = bakedCommands(commands);
      expect(sent).toHaveLength(1);
      const curves = sent[0]!;
      expect(Object.keys(curves)).toEqual(["Broken", "Square", "SquareChild", "Waits"]);
      for (const table of Object.values(curves)) expect(table).toHaveLength(129);
      expect([curves.Square![0], curves.Square![64], curves.Square![128]]).toEqual([0, 0.25, 1]);
      expect(curves.Square![32]).toBe(0.0625);
      expect(curves.SquareChild).toEqual(curves.Square);
      expect([curves.Broken![0], curves.Broken![32], curves.Broken![63], curves.Broken![64], curves.Broken![127], curves.Broken![128]])
        .toEqual([0, 0.25, 63 / 128, 2, 2, 1]);
      expect([curves.Waits![0], curves.Waits![64], curves.Waits![128]]).toEqual([0, 0.5, 1]);
      // The runtime's own realm samples them already.
      expect(sampleEasingCurve("class:Square", 0.5)).toBe(0.25);
      expect(sampleEasingCurve("class:Plain", 0.5)).toBe(0.5);
      // Sent before Play starts, and not again by starting.
      runtime.realizePlayWorld();
      runtime.start();
      expect(bakedCommands(commands)).toHaveLength(1);
    } finally { runtime.stop(); }
  });

  it("bakes again on every script load and replacement, even while Play is paused, and clears with no curves left", async () => {
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({ seed: 1, dt: 0.1, preferSoftwarePhysics: true,
      playScene: createDefaultScene(), onCommand: (command) => commands.push(command) });
    try {
      await runtime.loadScripts([]);
      expect(bakedCommands(commands)).toEqual([{}]);
      await runtime.loadScripts([curveClass("Square", "CustomEasingCurve", "return { Value: alpha * alpha };")]);
      runtime.realizePlayWorld();
      runtime.start();
      runtime.pause();
      await runtime.replaceScriptSources([curveClass("Square", "CustomEasingCurve", "return { Value: 1 - alpha };")]);
      const latest = bakedCommands(commands).at(-1)!;
      expect([latest.Square![0], latest.Square![32], latest.Square![128]]).toEqual([1, 0.75, 0]);
      expect(sampleEasingCurve("class:Square", 0.25)).toBe(0.75);
      await runtime.replaceScriptSources([]);
      expect(bakedCommands(commands)).toHaveLength(4);
      expect(bakedCommands(commands).at(-1)).toEqual({});
      expect(sampleEasingCurve("class:Square", 0.25)).toBe(0.25);
    } finally { runtime.stop(); }
  });
});
