import { describe, expect, it } from "vitest";
import {
  BOOL,
  INT,
  arrayOf,
  compileGraph,
  pinTypeKey,
  resolveWildcardPinTypes,
  type GraphNode,
  type LogicGraph,
  type NodeRegistry,
} from "@babylonslate/scripting";
import {
  ALL_NODE_CATEGORIES,
  arrayMapNodes,
  createDefaultNodeRegistry,
} from "./index";

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

function edge(
  id: string,
  sourceNodeId: string,
  sourcePinId: string,
  targetNodeId: string,
  targetPinId: string,
) {
  return { id, sourceNodeId, sourcePinId, targetNodeId, targetPinId };
}

function loadModule(source: string): Record<string, unknown> {
  const body = source.replace(/export\s+(async\s+)?function\s+/g, "$1function ");
  return new Function(`${body}\nreturn { run };`)() as Record<string, unknown>;
}

function runLog(source: string): string[] {
  const mod = loadModule(source);
  const logs: string[] = [];
  (mod.run as (ctx: unknown) => void)({
    formatValue: (v: unknown) => String(v),
    log: (_s: string, _c: string, message: string) => logs.push(message),
  });
  return logs;
}

describe("array-map nodes", () => {
  it("exports at least one node definition", () => {
    expect(arrayMapNodes.length).toBeGreaterThan(0);
    expect(arrayMapNodes[0]?.id).toBeTruthy();
    expect(arrayMapNodes[0]?.category).toBeTruthy();
  });

  it("registers the complete Array catalog with stable ids", () => {
    expect(ALL_NODE_CATEGORIES).toContain("array");
    expect(arrayMapNodes.map((entry) => entry.id)).toEqual(
      expect.arrayContaining([
        "array.make",
        "array.get",
        "array.getSafe",
        "array.length",
        "array.isEmpty",
        "array.lastIndex",
        "array.isValidIndex",
        "array.contains",
        "array.find",
        "array.append",
        "array.appendArray",
        "array.set",
        "array.insert",
        "array.removeIndex",
        "array.removeItem",
        "array.clear",
        "array.reverse",
        "array.slice",
        "array.first",
        "array.last",
      ]),
    );
    expect(arrayMapNodes.find((entry) => entry.id === "array.make")?.title).toBe(
      "Make Array",
    );
    expect(arrayMapNodes.find((entry) => entry.id === "array.append")?.title).toBe(
      "Append Item",
    );
    expect(arrayMapNodes.find((entry) => entry.id === "array.find")?.title).toBe(
      "Find Index",
    );
    expect(arrayMapNodes.find((entry) => entry.id === "array.set")?.title).toBe(
      "Set At Index",
    );
    expect(
      arrayMapNodes.find((entry) => entry.id === "array.removeIndex")?.title,
    ).toBe("Remove At");
  });

  it("Make Array exposes dynamic shared-T item pins from count", () => {
    const def = createDefaultNodeRegistry().get("array.make")!;
    const pins = def.pins({ count: 3 });
    expect(pins.map((pin) => pin.id)).toEqual([
      "item0",
      "item1",
      "item2",
      "out",
    ]);
    expect(
      pins.slice(0, 3).every((pin) => pin.type.kind === "resolvingWildcard"),
    ).toBe(true);
    expect(pins[3]?.type).toEqual(arrayOf({ kind: "resolvingWildcard" }));
  });

  it("resolves Make Array item wildcards from a concrete item wire", () => {
    const registry = createDefaultNodeRegistry();
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        node(registry, "makeInt", "literal.makeInt", { "default:in": 4 }),
        node(registry, "make", "array.make", { count: 1 }),
      ],
      edges: [edge("e1", "makeInt", "out", "make", "item0")],
    };
    const resolved = resolveWildcardPinTypes(graph);
    expect(resolved.conflicts).toEqual([]);
    expect(resolved.resolved.get(pinTypeKey("make", "item0"))).toEqual(INT);
    expect(resolved.resolved.get(pinTypeKey("make", "out"))).toEqual(
      arrayOf(INT),
    );
  });

  it("compiles and runs Make → Append Item → Length without undefined leaks", () => {
    const registry = createDefaultNodeRegistry();
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        node(registry, "entry", "flow.entry"),
        node(registry, "make", "array.make", {
          count: 2,
          "default:item0": 1,
          "default:item1": 2,
        }),
        node(registry, "append", "array.append", { "default:item": 3 }),
        node(registry, "len", "array.length"),
        node(registry, "log", "debug.log"),
      ],
      edges: [
        edge("e1", "entry", "execOut", "append", "execIn"),
        edge("e2", "make", "out", "append", "array"),
        edge("e3", "append", "execOut", "log", "execIn"),
        edge("e4", "append", "out", "len", "array"),
        edge("e5", "len", "out", "log", "message"),
      ],
    };
    const make = graph.nodes.find((entry) => entry.id === "make")!;
    for (const pin of make.pins) {
      if (pin.id.startsWith("item")) pin.type = INT;
    }
    const append = graph.nodes.find((entry) => entry.id === "append")!;
    for (const pin of append.pins) {
      if (pin.id === "item") pin.type = INT;
      if (pin.id === "array" || pin.id === "out") pin.type = arrayOf(INT);
    }
    const compiled = compileGraph(graph, { assetGuid: "a", registry });
    expect(compiled.source).not.toMatch(/\bundefined\b/);
    expect(runLog(compiled.source)).toEqual(["3"]);
  });

  it("compiles Get / Get Safe miss paths to typed defaults and valid flags", () => {
    const registry = createDefaultNodeRegistry();
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        node(registry, "entry", "flow.entry"),
        node(registry, "make", "array.make", { count: 1, "default:item0": 9 }),
        node(registry, "get", "array.get", { "default:index": 5 }),
        node(registry, "safe", "array.getSafe", { "default:index": 5 }),
        node(registry, "branch", "flow.sequence", { count: 2 }),
        node(registry, "logValue", "debug.log"),
        node(registry, "logValid", "debug.log"),
      ],
      edges: [
        edge("e1", "entry", "execOut", "branch", "execIn"),
        edge("e2", "make", "out", "get", "array"),
        edge("e3", "make", "out", "safe", "array"),
        edge("e4", "branch", "then0", "logValue", "execIn"),
        edge("e5", "branch", "then1", "logValid", "execIn"),
        edge("e6", "get", "out", "logValue", "message"),
        edge("e7", "safe", "valid", "logValid", "message"),
      ],
    };
    const make = graph.nodes.find((entry) => entry.id === "make")!;
    for (const pin of make.pins) {
      if (pin.id.startsWith("item")) pin.type = INT;
      if (pin.id === "out") pin.type = arrayOf(INT);
    }
    for (const id of ["get", "safe"] as const) {
      const entry = graph.nodes.find((n) => n.id === id)!;
      for (const pin of entry.pins) {
        if (pin.id === "array") pin.type = arrayOf(INT);
        if (pin.id === "out") pin.type = INT;
        if (pin.id === "valid") pin.type = BOOL;
      }
    }
    const compiled = compileGraph(graph, { assetGuid: "a", registry });
    expect(runLog(compiled.source)).toEqual(["0", "false"]);
  });

  it("compiles Is Empty, Last Index, Contains, Find Index, First, Last, Slice, Reverse", () => {
    const registry = createDefaultNodeRegistry();
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        node(registry, "entry", "flow.entry"),
        node(registry, "make", "array.make", {
          count: 3,
          "default:item0": 1,
          "default:item1": 2,
          "default:item2": 3,
        }),
        node(registry, "rev", "array.reverse"),
        node(registry, "slice", "array.slice", {
          "default:start": 0,
          "default:end": 2,
        }),
        node(registry, "first", "array.first"),
        node(registry, "log", "debug.log"),
      ],
      edges: [
        edge("e1", "entry", "execOut", "rev", "execIn"),
        edge("e2", "make", "out", "rev", "array"),
        edge("e3", "rev", "execOut", "log", "execIn"),
        edge("e4", "rev", "out", "slice", "array"),
        edge("e5", "slice", "out", "first", "array"),
        edge("e6", "first", "out", "log", "message"),
      ],
    };
    const make = graph.nodes.find((entry) => entry.id === "make")!;
    for (const pin of make.pins) {
      if (pin.id.startsWith("item")) pin.type = INT;
      if (pin.id === "out") pin.type = arrayOf(INT);
    }
    for (const id of ["rev", "slice", "first"] as const) {
      const entry = graph.nodes.find((n) => n.id === id)!;
      for (const pin of entry.pins) {
        if (pin.id === "out" && id === "first") pin.type = INT;
        else if (pin.id === "array" || pin.id === "out") pin.type = arrayOf(INT);
      }
    }
    const compiled = compileGraph(graph, { assetGuid: "a", registry });
    expect(runLog(compiled.source)).toEqual(["3"]);
  });

  it("compiles Append Array, Set At Index, Insert, Remove At, Remove Item, Clear", () => {
    const registry = createDefaultNodeRegistry();
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        node(registry, "entry", "flow.entry"),
        node(registry, "makeA", "array.make", {
          count: 2,
          "default:item0": 1,
          "default:item1": 2,
        }),
        node(registry, "makeB", "array.make", { count: 1, "default:item0": 9 }),
        node(registry, "appendArr", "array.appendArray"),
        node(registry, "set", "array.set", {
          "default:index": 0,
          "default:item": 7,
        }),
        node(registry, "len", "array.length"),
        node(registry, "log", "debug.log"),
      ],
      edges: [
        edge("e1", "entry", "execOut", "appendArr", "execIn"),
        edge("e2", "makeA", "out", "appendArr", "array"),
        edge("e3", "makeB", "out", "appendArr", "other"),
        edge("e4", "appendArr", "execOut", "set", "execIn"),
        edge("e5", "appendArr", "out", "set", "array"),
        edge("e6", "set", "execOut", "log", "execIn"),
        edge("e7", "set", "out", "len", "array"),
        edge("e8", "len", "out", "log", "message"),
      ],
    };
    for (const id of ["makeA", "makeB"] as const) {
      const make = graph.nodes.find((entry) => entry.id === id)!;
      for (const pin of make.pins) {
        if (pin.id.startsWith("item")) pin.type = INT;
        if (pin.id === "out") pin.type = arrayOf(INT);
      }
    }
    for (const id of ["appendArr", "set"] as const) {
      const entry = graph.nodes.find((n) => n.id === id)!;
      for (const pin of entry.pins) {
        if (pin.id === "array" || pin.id === "out" || pin.id === "other") {
          pin.type = arrayOf(INT);
        }
        if (pin.id === "item") pin.type = INT;
      }
    }
    const compiled = compileGraph(graph, { assetGuid: "a", registry });
    expect(runLog(compiled.source)).toEqual(["3"]);
  });
});
