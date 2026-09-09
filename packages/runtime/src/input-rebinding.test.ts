import { describe, expect, it } from "vitest";
import { compileGraph, type GraphNode, type LogicGraph } from "@babylonslate/scripting";
import { createDefaultNodeRegistry } from "@babylonslate/scripting-nodes";
import { createInProcessRuntime } from "./driver";

describe("compiled runtime input rebinding", () => {
  it("changes a binding from Begin Play and restores exported overrides in another session", async () => {
    const registry = createDefaultNodeRegistry();
    expect(registry.get("input.setBinding")).toBeDefined();
    const make = (id: string, typeId: string, properties: Record<string, unknown> = {}): GraphNode => ({
      id, typeId, properties, position: { x: 0, y: 0 }, pins: registry.get(typeId)!.pins(properties),
    });
    const graph: LogicGraph = {
      id: "rebind", kind: "event",
      nodes: [
        make("begin", "flow.event.beginPlay"),
        make("set", "input.setBinding", { kind: "action", mapping: "Jump", index: 0, device: "key", code: "KeyJ" }),
        make("get", "input.getBinding", { kind: "action", mapping: "Jump", index: 0 }),
        make("log", "debug.log"),
      ],
      edges: [
        { id: "e1", sourceNodeId: "begin", sourcePinId: "execOut", targetNodeId: "set", targetPinId: "execIn" },
        { id: "e2", sourceNodeId: "set", sourcePinId: "execOut", targetNodeId: "log", targetPinId: "execIn" },
        { id: "e3", sourceNodeId: "get", sourcePinId: "code", targetNodeId: "log", targetPinId: "message" },
      ],
    };
    const compiled = compileGraph(graph, { assetGuid: "rebind-class", registry });
    const runtime = createInProcessRuntime({ seed: 1, seedDemoActors: false });
    await runtime.loadScripts([{ assetGuid: "rebind-class", classId: "Rebinder", ...compiled }]);
    runtime.spawnScriptedActor({ classId: "Rebinder" });
    runtime.start();
    expect(runtime.getLogRing().entries().map((entry) => entry.message)).toContain("KeyJ");
    runtime.pushInput([{ kind: "key", tick: 0, phase: "down", code: "KeyJ" }]);
    runtime.tick();
    expect(runtime.getResolvedInput().actions.Jump?.pressed).toBe(true);
    const saved = runtime.inputBindings.exportBindings();
    runtime.stop();

    const next = createInProcessRuntime({ seed: 2, seedDemoActors: false });
    expect(next.inputBindings.importBindings(saved)).toBe(true);
    next.start();
    next.pushInputBuffer((await import("@babylonslate/input")).encodeInputEvents([{ kind: "key", tick: 0, phase: "down", code: "KeyJ" }]));
    next.tick();
    expect(next.getResolvedInput().actions.Jump?.pressed).toBe(true);
    next.stop();
  });
});
