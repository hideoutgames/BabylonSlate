import { describe, expect, it } from "vitest";
import { Actor } from "@babylonslate/object-model";
import { compileGraph, type GraphNode, type LogicGraph, type NodeRegistry } from "@babylonslate/scripting";
import { createDefaultNodeRegistry } from "@babylonslate/scripting-nodes";
import { ScriptHost } from "./script-host";
import { TweenRuntime } from "./tween-runtime";

const signature = [
  { name: "exec", typeId: "exec", direction: "in" },
  { name: "then", typeId: "exec", direction: "out" },
];

function node(registry: NodeRegistry, id: string, typeId: string, properties: Record<string, unknown> = {}): GraphNode {
  return { id, typeId, properties, position: { x: 0, y: 0 }, pins: registry.get(typeId)!.pins(properties) };
}

function edge(sourceNodeId: string, sourcePinId: string, targetNodeId: string, targetPinId: string) {
  return { id: `${sourceNodeId}.${sourcePinId}-${targetNodeId}.${targetPinId}`, sourceNodeId, sourcePinId, targetNodeId, targetPinId };
}

describe("FunctionLibrary tween lifetime", () => {
  it("retains the caller through nested static calls and cancels only that caller's local tween", async () => {
    const registry = createDefaultNodeRegistry();
    const inner: LogicGraph = {
      id: "Animate", kind: "function",
      nodes: [
        node(registry, "input", "flow.function.input", { pins: signature }),
        node(registry, "value", "variables.get", { variableName: "Amount", typeId: "float", scope: "local", implicitSelf: true }),
        node(registry, "tween", "tween.float", { a: 2, b: 8, duration: 2 }),
        node(registry, "log", "debug.log"),
      ],
      edges: [edge("input", "exec", "tween", "execIn"), edge("value", "value", "tween", "target"),
        edge("tween", "execOut", "log", "execIn"), edge("value", "value", "log", "message")],
    };
    const outer: LogicGraph = {
      id: "Outer", kind: "function",
      nodes: [node(registry, "input", "flow.function.input", { pins: signature }),
        node(registry, "call", "functions.call", { functionName: "Animate", classId: "InnerLibrary", static: true, implicitSelf: true, pins: signature })],
      edges: [edge("input", "exec", "call", "exec")],
    };
    const runtime = new TweenRuntime();
    const messages: string[] = [];
    const errors: unknown[] = [];
    const host = new ScriptHost({
      log: (_severity, _category, message) => { messages.push(message); },
      print: () => {}, destroyActor: () => {},
      executeConsoleCommand: () => ({ success: true, output: "" }),
      delay: async () => {}, reportError: error => { errors.push(error); },
      tween: request => runtime.start(request),
    });
    for (const [classId, graph] of [["InnerLibrary", inner], ["OuterLibrary", outer]] as const) {
      const compiled = compileGraph(graph, { registry, assetGuid: classId, exportName: graph.id,
        isLatentFunction: () => true, localPreamble: graph === inner ? ["  let __lv_Amount = 0;"] : undefined });
      await host.load({ assetGuid: classId, classId, source: compiled.source, anchors: compiled.anchors, entryPoints: compiled.entryPoints });
    }
    const cancelledActor = new Actor({ classId: "Actor" });
    const survivingActor = new Actor({ classId: "Actor" });
    const cancelled = host.createContext(cancelledActor, 0, 0).invokeFunction("OuterLibrary", "Outer", {});
    const surviving = host.createContext(survivingActor, 0, 0).invokeFunction("OuterLibrary", "Outer", {});
    runtime.advance(0.5);
    cancelledActor.destroyed = true;
    runtime.cancelInvalid();
    expect(messages).toEqual([]);
    runtime.advance(1.5);
    await Promise.all([cancelled, surviving]);
    expect(messages).toEqual(["8"]);
    expect(errors).toEqual([]);
    runtime.stop();
  });
});
