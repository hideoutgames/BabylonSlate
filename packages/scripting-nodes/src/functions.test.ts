import { describe, expect, it } from "vitest";
import {
  BOOL,
  EXEC,
  FLOAT,
  INT,
  STRING,
  compileGraph,
  type GraphNode,
  type LogicGraph,
  type NodeRegistry,
} from "@babylonslate/scripting";
import { createDefaultNodeRegistry, functionCallNodes } from "./index";

function node(
  registry: NodeRegistry,
  id: string,
  typeId: string,
  properties: Record<string, unknown> = {},
): GraphNode {
  const def = registry.get(typeId);
  if (!def) throw new Error(`missing node ${typeId}`);
  return {
    id,
    typeId,
    position: { x: 0, y: 0 },
    pins: def.pins(properties),
    properties,
  };
}

describe("functions.call", () => {
  it("is registered under the functions category", () => {
    expect(functionCallNodes.map((entry) => entry.id)).toContain(
      "functions.call",
    );
    const registry = createDefaultNodeRegistry();
    expect(registry.get("functions.call")?.title).toBe("Call");
    expect(registry.get("functions.call")?.category).toBe("functions");
  });

  it("defaults to exec in/out when no pin rows are authored", () => {
    const def = createDefaultNodeRegistry().get("functions.call")!;
    expect(
      def.pins({}).map((pin) => ({
        id: pin.id,
        direction: pin.direction,
        type: pin.type,
      })),
    ).toEqual([
      { id: "execIn", direction: "in", type: EXEC },
      { id: "execOut", direction: "out", type: EXEC },
    ]);
  });

  it("maps authored pin rows and coerces type ids", () => {
    const def = createDefaultNodeRegistry().get("functions.call")!;
    const pins = def.pins({
      pins: [
        { name: "exec", typeId: "exec", direction: "in" },
        { name: "amount", typeId: "float", direction: "in" },
        { name: "flag", typeId: "bool", direction: "in" },
        { name: "count", typeId: "int", direction: "in" },
        { name: "label", typeId: "string", direction: "in" },
        { name: "kind", typeId: "enum", direction: "in" },
        { name: "then", typeId: "exec", direction: "out" },
        { name: "", typeId: "float", direction: "in" },
        null,
      ],
    });
    expect(
      pins.map((pin) => ({
        id: pin.id,
        direction: pin.direction,
        type: pin.type,
      })),
    ).toEqual([
      { id: "exec", direction: "in", type: EXEC },
      { id: "amount", direction: "in", type: FLOAT },
      { id: "flag", direction: "in", type: BOOL },
      { id: "count", direction: "in", type: INT },
      { id: "label", direction: "in", type: STRING },
      { id: "kind", direction: "in", type: STRING },
      { id: "then", direction: "out", type: EXEC },
    ]);
  });

  it("compiles to a sanitized JS identifier call", () => {
    const registry = createDefaultNodeRegistry();
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        node(registry, "begin", "flow.event.beginPlay"),
        node(registry, "call", "functions.call", {
          functionName: "2 Jump!",
          pins: [
            { name: "exec", typeId: "exec", direction: "in" },
            { name: "then", typeId: "exec", direction: "out" },
          ],
        }),
      ],
      edges: [
        {
          id: "e1",
          sourceNodeId: "begin",
          sourcePinId: "execOut",
          targetNodeId: "call",
          targetPinId: "exec",
        },
      ],
    };
    const compiled = compileGraph(graph, { assetGuid: "a", registry });
    expect(compiled.source).toContain("_2_Jump_(ctx);");
  });

  it("falls back to fn when functionName is missing", () => {
    const registry = createDefaultNodeRegistry();
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        node(registry, "begin", "flow.event.beginPlay"),
        node(registry, "call", "functions.call", {}),
      ],
      edges: [
        {
          id: "e1",
          sourceNodeId: "begin",
          sourcePinId: "execOut",
          targetNodeId: "call",
          targetPinId: "execIn",
        },
      ],
    };
    const compiled = compileGraph(graph, { assetGuid: "a", registry });
    expect(compiled.source).toContain("fn(ctx);");
  });
});
