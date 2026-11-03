import { describe, expect, it } from "vitest";
import { compileGraph, type GraphNode, type LogicGraph, type NodeRegistry } from "@haptic/scripting";
import { createDefaultNodeRegistry } from "./index";

function node(registry: NodeRegistry, id: string, typeId: string, properties: Record<string, unknown> = {}): GraphNode {
  const def = registry.get(typeId);
  if (!def) throw new Error(`missing node ${typeId}`);
  return { id, typeId, position: { x: 0, y: 0 }, pins: def.pins(properties), properties };
}

describe("global parameter nodes", () => {
  it("sets and reads a collection's parameter by name through the context", () => {
    const registry = createDefaultNodeRegistry();
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        node(registry, "begin", "flow.event.beginPlay"),
        node(registry, "set", "globalParameters.setVectorParameter", { "default:collection": "fx", "default:parameter": "Wind", "default:value": { x: 1, y: 2, z: 3 } }),
        node(registry, "get", "globalParameters.getColorParameter", { "default:collection": "fx", "default:parameter": "Tint" }),
        node(registry, "log", "debug.log"),
      ],
      edges: [
        { id: "e1", sourceNodeId: "begin", sourcePinId: "execOut", targetNodeId: "set", targetPinId: "execIn" },
        { id: "e2", sourceNodeId: "set", sourcePinId: "execOut", targetNodeId: "log", targetPinId: "execIn" },
        { id: "e3", sourceNodeId: "get", sourcePinId: "found", targetNodeId: "log", targetPinId: "message" },
      ],
    };
    const body = compileGraph(graph, { assetGuid: "a", registry }).source.replace(/export\s+(async\s+)?function\s+/g, "$1function ");
    const mod = new Function(`${body}\nreturn { onBeginPlay };`)() as { onBeginPlay: (ctx: unknown) => void };
    const calls: unknown[][] = [];
    const logged: unknown[] = [];
    mod.onBeginPlay({
      self: { guid: "self" },
      formatValue: (value: unknown) => value,
      log: (_severity: string, _category: string, value: unknown) => logged.push(value),
      setGlobalVectorParameter: (...args: unknown[]) => calls.push(["set", ...args]),
      getGlobalColorParameter: (...args: unknown[]) => { calls.push(["get", ...args]); return { found: true, value: { x: 1, y: 1, z: 1, w: 1 } }; },
    });
    expect(calls).toEqual([["set", "fx", "Wind", { x: 1, y: 2, z: 3 }], ["get", "fx", "Tint"]]);
    expect(logged).toEqual([true]);
    expect(registry.get("globalParameters.getFloatParameter")?.pure).toBe(true);
  });
});
