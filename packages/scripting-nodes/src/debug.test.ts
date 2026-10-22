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
} from "@haptic/scripting";
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

  it("auto-casts int and vec3 wires into Print without a box converter", () => {
    const registry = createDefaultNodeRegistry();
    const intGraph: LogicGraph = {
      id: "g-int",
      kind: "event",
      nodes: [
        node(registry, "begin", "flow.event.beginPlay"),
        node(registry, "add", "math.add_int", { "default:a": 1, "default:b": 2 }),
        node(registry, "print", "debug.print"),
      ],
      edges: [
        edge("e1", "begin", "execOut", "print", "execIn"),
        edge("e2", "add", "out", "print", "value"),
      ],
    };
    const vecGraph: LogicGraph = {
      id: "g-vec",
      kind: "event",
      nodes: [
        node(registry, "begin", "flow.event.beginPlay"),
        node(registry, "make", "vector.make3", {
          "default:x": 1,
          "default:y": 2,
          "default:z": 3,
        }),
        node(registry, "print", "debug.print"),
      ],
      edges: [
        edge("e1", "begin", "execOut", "print", "execIn"),
        edge("e2", "make", "out", "print", "value"),
      ],
    };
    for (const graph of [intGraph, vecGraph]) {
      const diags = validateGraphs([graph], { assetGuid: "a" });
      expect(diags.some((d) => d.code === "type.mismatch")).toBe(false);
      const compiled = compileGraph(graph, { assetGuid: "a", registry });
      expect(compiled.source).toContain("ctx.formatValue((");
      expect(compiled.source).not.toContain("wildcard.to_");
    }
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

describe("Execute JavaScript", () => {
  it("binds inputs and outputs named like the exec pins to their own pins", () => {
    const registry = createDefaultNodeRegistry();
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        node(registry, "begin", "flow.event.beginPlay"),
        node(registry, "js", "debug.executeJavaScript", {
          inputs: [{ name: "exec", type: { kind: "float" } }],
          outputs: [{ name: "then", type: { kind: "float" } }],
          "default:in_exec": 4,
          body: "then = exec * 2;",
        }),
        node(registry, "log", "debug.log"),
      ],
      edges: [
        edge("e1", "begin", "execOut", "js", "execIn"),
        edge("e2", "js", "execOut", "log", "execIn"),
        edge("e3", "js", "out_then", "log", "message"),
      ],
    };
    const compiled = compileGraph(graph, { assetGuid: "a", registry });
    const body = compiled.source.replace(/export\s+(async\s+)?function\s+/g, "$1function ");
    const onBeginPlay = new Function(`"use strict";\n${body}\nreturn onBeginPlay;`)() as (ctx: unknown) => void;
    const logged: string[] = [];
    onBeginPlay({
      formatValue: String,
      log: (_severity: string, _category: string, message: string) => logged.push(message),
    });
    expect(logged).toEqual(["8"]);
  });

  it.each([
    [[{ name: "static", type: { kind: "float" } }], []],
    [[{ name: "eval", type: { kind: "float" } }], []],
    [[{ name: "null", type: { kind: "float" } }], []],
    [[], [{ name: "arguments", type: { kind: "float" } }]],
    [[{ name: "x", type: { kind: "float" } }], [{ name: "x", type: { kind: "float" } }]],
  ])("keeps the module loadable and fails at run time for inputs %j and outputs %j", (inputs, outputs) => {
    const registry = createDefaultNodeRegistry();
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        node(registry, "begin", "flow.event.beginPlay"),
        node(registry, "js", "debug.executeJavaScript", { inputs, outputs, body: "" }),
      ],
      edges: [edge("e1", "begin", "execOut", "js", "execIn")],
    };
    const compiled = compileGraph(graph, { assetGuid: "a", registry });
    const body = compiled.source.replace(/export\s+(async\s+)?function\s+/g, "$1function ");
    const onBeginPlay = new Function(`"use strict";\n${body}\nreturn onBeginPlay;`)() as (ctx: unknown) => void;
    expect(() => onBeginPlay({})).toThrow(/(Invalid|Duplicate) JS identifier/);
  });
});
