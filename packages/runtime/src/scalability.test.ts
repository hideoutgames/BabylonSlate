import { describe, expect, it } from "vitest";
import { compileGraph, type GraphNode, type LogicGraph } from "@babylonslate/scripting";
import { createDefaultNodeRegistry } from "@babylonslate/scripting-nodes";
import { createInProcessRuntime } from "./driver";
import type { CommandMessage } from "@babylonslate/bridge";

const registry = createDefaultNodeRegistry();
function node(id: string, typeId: string, properties: Record<string, unknown> = {}): GraphNode {
  return { id, typeId, properties, position: { x: 0, y: 0 }, pins: registry.get(typeId)!.pins(properties) };
}
const edge = (sourceNodeId: string, sourcePinId: string, targetNodeId: string, targetPinId: string) =>
  ({ id: `${sourceNodeId}:${sourcePinId}:${targetNodeId}:${targetPinId}`, sourceNodeId, sourcePinId, targetNodeId, targetPinId });
async function run(graph: LogicGraph) {
  const commands: CommandMessage[] = [];
  const runtime = createInProcessRuntime({ seed: 1, seedDemoActors: false, preferSoftwarePhysics: true,
    renderSettings: { mode: "cel" }, frameCap: 30, onCommand: (command) => commands.push(command) });
  const compiled = compileGraph(graph, { registry, assetGuid: "scalability-class" });
  await runtime.loadScripts([{ assetGuid: "scalability-class", classId: "SettingsActor", source: compiled.source,
    anchors: compiled.anchors, entryPoints: compiled.entryPoints }]);
  const actor = runtime.spawnScriptedActor({ classId: "SettingsActor" });
  runtime.start(); runtime.tick();
  return { runtime, commands, actor };
}
describe("compiled Class Graph scalability", () => {
  it.each(["low", "medium", "high", "ultra"])("executes the %s enum preset without changing artistic mode or frame cap", async (preset) => {
    const { runtime } = await run({ id: "settings", kind: "event", nodes: [node("begin", "flow.event.beginPlay"), node("preset", "scalability.setPreset", { preset })],
      edges: [edge("begin", "execOut", "preset", "execIn")] });
    try {
      expect(runtime.getScalability().requested.render.quality?.lighting.profile).toBe(preset);
      expect(runtime.getScalability().requested.render.mode).toBe("cel");
      expect(runtime.getScalability().requested.frameCap).toBe(30);
      expect(runtime.getScalability().effective).toBeNull();
    } finally { runtime.stop(); }
  });
  it("executes typed setters, emits confirmed readback through the event and shares reset with console commands", async () => {
    const { runtime, commands, actor } = await run({ id: "settings", kind: "event", nodes: [
      node("begin", "flow.event.beginPlay"), node("cap", "scalability.setFrameCap", { fps: 20 }),
      node("scale", "scalability.setRenderScale", { scale: 0.5 }), node("aa", "scalability.setAntialiasing", { enabled: true }),
      node("changed", "flow.event.scalabilityChanged"), node("log", "debug.log"),
      node("resetEvent", "flow.event.custom", { name: "Restore" }), node("reset", "scalability.reset"),
    ], edges: [edge("begin", "execOut", "cap", "execIn"), edge("cap", "execOut", "scale", "execIn"), edge("scale", "execOut", "aa", "execIn"),
      edge("changed", "execOut", "log", "execIn"), edge("changed", "settings", "log", "message"), edge("resetEvent", "execOut", "reset", "execIn")] });
    try {
      const snapshot = runtime.getScalability();
      expect(snapshot.requested).toMatchObject({ frameCap: 20, render: { effects: { fxaa: true }, quality: { resolution: { scale: 0.5, dynamic: false } } } });
      runtime.applyScalabilityStatus({ revision: snapshot.result.revision, status: "applied", message: "Ready", effective: snapshot.requested });
      const logs = commands.filter((command) => command.type === "log");
      expect(logs).toHaveLength(1);
      expect(logs[0]?.message).toContain('"appliedRevision":3');
      runtime.applyScalabilityStatus({ revision: 1, status: "failed", message: "Stale failure" });
      expect(commands.filter((command) => command.type === "log")).toHaveLength(1);
      runtime.executeConsoleCommand("quality lighting budget 3");
      expect(runtime.getScalability().requested.render.quality?.lighting.maxLocalLights).toBe(3);
      runtime.invokeScriptEvent("SettingsActor", "Restore", actor);
      expect(runtime.getScalability().requested.frameCap).toBe(30);
      expect(runtime.getScalability().requested.render.quality?.resolution.scale).toBe(1);
    } finally { runtime.stop(); }
  });
  it("returns validation failures from a graph instead of changing requested settings", async () => {
    const { runtime, commands } = await run({ id: "settings", kind: "event", nodes: [node("begin", "flow.event.beginPlay"),
      node("cap", "scalability.setFrameCap", { fps: -10 }), node("log", "debug.log")],
      edges: [edge("begin", "execOut", "cap", "execIn"), edge("cap", "execOut", "log", "execIn"), edge("cap", "result", "log", "message")] });
    try {
      expect(commands.filter((command) => command.type === "setScalability")).toHaveLength(0);
      expect(commands.find((command) => command.type === "log")?.message).toContain('"status":"failed"');
      expect(runtime.getScalability().requested.frameCap).toBe(30);
    } finally { runtime.stop(); }
  });
});
