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
        node(registry, "set", "globalParameters.setVector4Parameter", { "default:collection": "fx", "default:parameter": "Wind", "default:value": { x: 1, y: 2, z: 3, w: 4 } }),
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
      setGlobalVector4Parameter: (...args: unknown[]) => calls.push(["set", ...args]),
      getGlobalColorParameter: (...args: unknown[]) => { calls.push(["get", ...args]); return { found: true, value: { x: 1, y: 1, z: 1, w: 1 } }; },
    });
    expect(calls).toEqual([["set", "fx", "Wind", { x: 1, y: 2, z: 3, w: 4 }], ["get", "fx", "Tint"]]);
    expect(logged).toEqual([true]);
    expect(registry.get("globalParameters.getFloatParameter")?.pure).toBe(true);
  });

  it("has one Set and one Get node per parameter type, each with a pin of exactly that type", () => {
    const registry = createDefaultNodeRegistry();
    const pinKind = (id: string, direction: "in" | "out") => registry.get(id)?.pins({}).find((pin) => pin.id === "value" && pin.direction === direction)?.type.kind;
    for (const [kind, type] of [["Float", "float"], ["Vector2", "vec2"], ["Vector3", "vec3"], ["Vector4", "vec4"], ["Color", "color"]]) {
      expect(pinKind(`globalParameters.set${kind}Parameter`, "in")).toBe(type);
      expect(pinKind(`globalParameters.get${kind}Parameter`, "out")).toBe(type);
      expect(pinKind(`material.set${kind}Parameter`, "in")).toBe(type);
      expect(pinKind(`material.get${kind}Parameter`, "out")).toBe(type);
      expect(registry.get(`material.reset${kind}Parameter`)).toBeDefined();
    }
    // The catch-all Vector nodes are gone: they took a Vector3 and dropped Z for a Vector2 parameter.
    for (const id of ["globalParameters.setVectorParameter", "material.setVectorParameter", "material.getVectorParameter"]) expect(registry.get(id)).toBeUndefined();
  });
});
