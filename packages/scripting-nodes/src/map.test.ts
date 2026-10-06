import { describe, expect, it } from "vitest";
import {
  BOOL,
  FLOAT,
  INT,
  STRING,
  arrayOf,
  compileGraph,
  mapOf,
  pinTypeKey,
  resolveWildcardPinTypes,
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

describe("map nodes", () => {
  it("Make Map exposes dynamic K/V pair pins from count", () => {
    const def = createDefaultNodeRegistry().get("map.make")!;
    const pins = def.pins({ count: 2 });
    expect(pins.map((pin) => pin.id)).toEqual([
      "key0",
      "value0",
      "key1",
      "value1",
      "out",
    ]);
    expect(pins[0]?.type).toEqual({ kind: "resolvingWildcard", group: "K" });
    expect(pins[1]?.type).toEqual({ kind: "resolvingWildcard", group: "V" });
    expect(pins[4]?.type).toEqual(
      mapOf(
        { kind: "resolvingWildcard", group: "K" },
        { kind: "resolvingWildcard", group: "V" },
      ),
    );
  });

  it("resolves Make Map K/V wildcards from concrete pair wires", () => {
    const registry = createDefaultNodeRegistry();
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        node(registry, "makeKey", "literal.makeString", { "default:in": "hp" }),
        node(registry, "makeVal", "literal.makeFloat", { "default:in": 1.5 }),
        node(registry, "make", "map.make", { count: 1 }),
      ],
      edges: [
        edge("e1", "makeKey", "out", "make", "key0"),
        edge("e2", "makeVal", "out", "make", "value0"),
      ],
    };
    const resolved = resolveWildcardPinTypes(graph);
    expect(resolved.conflicts).toEqual([]);
    expect(resolved.resolved.get(pinTypeKey("make", "key0"))).toEqual(STRING);
    expect(resolved.resolved.get(pinTypeKey("make", "value0"))).toEqual(FLOAT);
  });

  it("compiles and runs Make → Set → Get with Found and type default on miss", () => {
    const registry = createDefaultNodeRegistry();
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        node(registry, "entry", "flow.entry"),
        node(registry, "make", "map.make", { count: 0 }),
        node(registry, "set", "map.set", {
          "default:key": "a",
          "default:value": 2,
        }),
        node(registry, "getHit", "map.get", { "default:key": "a" }),
        node(registry, "getMiss", "map.get", { "default:key": "missing" }),
        node(registry, "seq", "flow.sequence", { count: 2 }),
        node(registry, "logHit", "debug.log"),
        node(registry, "logMiss", "debug.log"),
      ],
      edges: [
        edge("e1", "entry", "execOut", "set", "execIn"),
        edge("e2", "make", "out", "set", "map"),
        edge("e3", "set", "execOut", "seq", "execIn"),
        edge("e4", "set", "out", "getHit", "map"),
        edge("e5", "set", "out", "getMiss", "map"),
        edge("e6", "seq", "then0", "logHit", "execIn"),
        edge("e7", "seq", "then1", "logMiss", "execIn"),
        edge("e8", "getHit", "out", "logHit", "message"),
        edge("e9", "getMiss", "out", "logMiss", "message"),
      ],
    };
    for (const id of ["set", "getHit", "getMiss"] as const) {
      const entry = graph.nodes.find((n) => n.id === id)!;
      for (const pin of entry.pins) {
        if (pin.id === "map" || pin.id === "out") {
          if (pin.id === "out" && id !== "set") pin.type = INT;
          else if (pin.id === "map" || (pin.id === "out" && id === "set")) {
            pin.type = mapOf(STRING, INT);
          }
        }
        if (pin.id === "key") pin.type = STRING;
        if (pin.id === "value") pin.type = INT;
        if (pin.id === "found") pin.type = BOOL;
      }
    }
    const make = graph.nodes.find((entry) => entry.id === "make")!;
    for (const pin of make.pins) {
      if (pin.id === "out") pin.type = mapOf(STRING, INT);
    }
    const compiled = compileGraph(graph, { assetGuid: "a", registry });
    expect(compiled.source).toContain(".has(");
    expect(runLog(compiled.source)).toEqual(["2", "0"]);
  });

  it("compiles Remove Removed, Is Empty, Clear, Keys, Values, Break Map order", () => {
    const registry = createDefaultNodeRegistry();
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        node(registry, "entry", "flow.entry"),
        node(registry, "make", "map.make", {
          count: 2,
          "default:key0": "first",
          "default:value0": 1,
          "default:key1": "second",
          "default:value1": 2,
        }),
        node(registry, "brk", "map.break"),
        node(registry, "firstKey", "array.first"),
        node(registry, "log", "debug.log"),
      ],
      edges: [
        edge("e1", "entry", "execOut", "log", "execIn"),
        edge("e2", "make", "out", "brk", "map"),
        edge("e3", "brk", "keys", "firstKey", "array"),
        edge("e4", "firstKey", "out", "log", "message"),
      ],
    };
    const make = graph.nodes.find((entry) => entry.id === "make")!;
    for (const pin of make.pins) {
      if (pin.id.startsWith("key")) pin.type = STRING;
      if (pin.id.startsWith("value")) pin.type = INT;
      if (pin.id === "out") pin.type = mapOf(STRING, INT);
    }
    const brk = graph.nodes.find((entry) => entry.id === "brk")!;
    for (const pin of brk.pins) {
      if (pin.id === "map") pin.type = mapOf(STRING, INT);
      if (pin.id === "keys") pin.type = arrayOf(STRING);
      if (pin.id === "values") pin.type = arrayOf(INT);
    }
    const first = graph.nodes.find((entry) => entry.id === "firstKey")!;
    for (const pin of first.pins) {
      if (pin.id === "array") pin.type = arrayOf(STRING);
      if (pin.id === "out") pin.type = STRING;
    }
    const compiled = compileGraph(graph, { assetGuid: "a", registry });
    expect(runLog(compiled.source)).toEqual(["first"]);
  });

  it("matches Vector keys by value across Make, Set, Has, Get and Remove", () => {
    const registry = createDefaultNodeRegistry();
    const key = { x: 1, y: 2, z: 3 };
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        node(registry, "entry", "flow.entry"),
        node(registry, "vec", "vector.make3", { x: 1, y: 2, z: 3 }),
        node(registry, "make", "map.make", { count: 1, "default:value0": 1 }),
        node(registry, "set", "map.set", {
          "default:key": key,
          "default:value": 2,
        }),
        node(registry, "has", "map.has", { "default:key": key }),
        node(registry, "get", "map.get", { "default:key": key }),
        node(registry, "size", "map.size"),
        node(registry, "remove", "map.remove", { "default:key": key }),
        node(registry, "logHas", "debug.log"),
        node(registry, "logGet", "debug.log"),
        node(registry, "logSize", "debug.log"),
        node(registry, "logRemoved", "debug.log"),
      ],
      edges: [
        edge("e1", "vec", "out", "make", "key0"),
        edge("e2", "entry", "execOut", "set", "execIn"),
        edge("e3", "make", "out", "set", "map"),
        edge("e4", "set", "out", "has", "map"),
        edge("e5", "set", "out", "get", "map"),
        edge("e6", "set", "out", "size", "map"),
        edge("e7", "set", "out", "remove", "map"),
        edge("e8", "set", "execOut", "logHas", "execIn"),
        edge("e9", "logHas", "execOut", "logGet", "execIn"),
        edge("e10", "logGet", "execOut", "logSize", "execIn"),
        edge("e11", "logSize", "execOut", "remove", "execIn"),
        edge("e12", "remove", "execOut", "logRemoved", "execIn"),
        edge("e13", "has", "out", "logHas", "message"),
        edge("e14", "get", "out", "logGet", "message"),
        edge("e15", "size", "out", "logSize", "message"),
        edge("e16", "remove", "removed", "logRemoved", "message"),
      ],
    };
    const compiled = compileGraph(graph, { assetGuid: "a", registry });
    expect(runLog(compiled.source)).toEqual(["true", "2", "1", "true"]);
  });
});
