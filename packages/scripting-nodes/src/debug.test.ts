import { describe, expect, it } from "vitest";
import {
  compileGraph,
  isDevelopmentOnlyNode,
  pin,
  validateGraphs,
  EXEC,
  type GraphNode,
  type LogicGraph,
  type NodeRegistry,
} from "@babylonslate/scripting";
import { createDefaultNodeRegistry } from "./index";

function node(
  registry: NodeRegistry,
  id: string,
  typeId: string,
  properties: Record<string, unknown> = {},
): GraphNode {
  const def = registry.get(typeId);
  return {
    id,
    typeId,
    position: { x: 0, y: 0 },
    pins: def ? def.pins(properties) : [pin("execOut", "then", "out", EXEC)],
    properties,
  };
}

function edge(
  id: string,
  sourceNodeId: string,
  sourcePinId: string,
  targetNodeId: string,
  targetPinId: string,
) {
  return { id, sourceNodeId, sourcePinId, targetNodeId, targetPinId };
}

describe("Print and Print String", () => {
  it("registers Print String as a debug catalog node", () => {
    const registry = createDefaultNodeRegistry();
    const printString = registry.get("debug.printString");
    expect(printString?.title).toBe("Print String");
    expect(printString?.developmentOnlyByDefault).toBe(true);
    expect(registry.get("debug.print")?.developmentOnlyByDefault).toBe(true);
  });

  it("compiles unconnected Print duration and color from catalog defaults", () => {
    const registry = createDefaultNodeRegistry();
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        node(registry, "begin", "flow.event.beginPlay"),
        node(registry, "print", "debug.print"),
      ],
      edges: [edge("e1", "begin", "execOut", "print", "execIn")],
    };
    const compiled = compileGraph(graph, { assetGuid: "a", registry });
    expect(compiled.source).toContain('ctx.formatValue("")');
    expect(compiled.source).toContain("2");
    expect(compiled.source).toContain('"x":1');
    expect(compiled.source).toContain('"w":1');
    expect(compiled.source).not.toMatch(
      /ctx\.print\(ctx\.formatValue\(""\), "", 0,/,
    );
  });

  it("auto-casts a float wire into Print without a box converter", () => {
    const registry = createDefaultNodeRegistry();
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        node(registry, "begin", "flow.event.beginPlay"),
        node(registry, "add", "math.add", { "default:a": 1, "default:b": 2 }),
        node(registry, "print", "debug.print"),
      ],
      edges: [
        edge("e1", "begin", "execOut", "print", "execIn"),
        edge("e2", "add", "out", "print", "value"),
      ],
    };
    const diags = validateGraphs([graph], { assetGuid: "a" });
    expect(diags.some((d) => d.code === "type.mismatch")).toBe(false);
    const compiled = compileGraph(graph, { assetGuid: "a", registry });
    expect(compiled.source).toContain("ctx.formatValue((");
    expect(compiled.source).toContain("1 + 2");
    expect(compiled.source).not.toContain("wildcard.to_");
  });

  it("does not warn when Print value is unconnected", () => {
    const registry = createDefaultNodeRegistry();
    const print = node(registry, "print", "debug.print");
    expect(print.pins.find((p) => p.id === "value")?.optional).toBe(true);
    const diags = validateGraphs(
      [
        {
          id: "g",
          kind: "event",
          nodes: [print],
          edges: [],
        },
      ],
      { assetGuid: "a" },
    );
    expect(diags.some((d) => d.code === "pin.missing_input")).toBe(false);
  });

  it("compiles Print String without formatValue", () => {
    const registry = createDefaultNodeRegistry();
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        node(registry, "begin", "flow.event.beginPlay"),
        node(registry, "print", "debug.printString", {
          "default:inString": "hello",
        }),
      ],
      edges: [edge("e1", "begin", "execOut", "print", "execIn")],
    };
    const compiled = compileGraph(graph, { assetGuid: "a", registry });
    expect(compiled.source).toContain('ctx.print("hello"');
    expect(compiled.source).not.toContain("formatValue");
  });

  it("treats Print String as development-only unless opted out", () => {
    createDefaultNodeRegistry();
    expect(
      isDevelopmentOnlyNode({
        id: "p",
        typeId: "debug.printString",
        position: { x: 0, y: 0 },
        pins: [],
        properties: {},
      }),
    ).toBe(true);
    expect(
      isDevelopmentOnlyNode({
        id: "p",
        typeId: "debug.printString",
        position: { x: 0, y: 0 },
        pins: [],
        properties: { developmentOnly: false },
      }),
    ).toBe(false);
  });
});
