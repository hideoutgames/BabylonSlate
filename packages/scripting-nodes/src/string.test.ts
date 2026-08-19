import { describe, expect, it } from "vitest";
import {
  compileGraph,
  arrayOf,
  STRING,
  type GraphNode,
  type LogicGraph,
  type NodeRegistry,
} from "@babylonslate/scripting";
import { createDefaultNodeRegistry, stringNodes } from "./index";

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

function loadModule(source: string): Record<string, unknown> {
  const body = source.replace(/export\s+(async\s+)?function\s+/g, "$1function ");
  return new Function(`${body}\nreturn { onBeginPlay };`)() as Record<
    string,
    unknown
  >;
}

describe("string nodes", () => {
  it("exports at least one node definition", () => {
    expect(stringNodes.length).toBeGreaterThan(0);
    expect(stringNodes[0]?.id).toBeTruthy();
    expect(stringNodes[0]?.category).toBeTruthy();
  });

  it("registers Contains, Starts With, Ends With, Replace, Split, Join, Substring, Trim, Lower, Upper, Parse Int, and Parse Float", () => {
    expect(stringNodes.map((entry) => entry.id)).toEqual(
      expect.arrayContaining([
        "string.contains",
        "string.startsWith",
        "string.endsWith",
        "string.replace",
        "string.split",
        "string.join",
        "string.substring",
        "string.trim",
        "string.toLower",
        "string.toUpper",
        "string.parseInt",
        "string.parseFloat",
      ]),
    );
    expect(stringNodes.find((entry) => entry.id === "string.contains")?.title).toBe(
      "Contains",
    );
    expect(stringNodes.find((entry) => entry.id === "string.startsWith")?.title).toBe(
      "Starts With",
    );
    expect(stringNodes.find((entry) => entry.id === "string.endsWith")?.title).toBe(
      "Ends With",
    );
    expect(stringNodes.find((entry) => entry.id === "string.toLower")?.title).toBe(
      "To Lower",
    );
    expect(stringNodes.find((entry) => entry.id === "string.toUpper")?.title).toBe(
      "To Upper",
    );
    expect(stringNodes.find((entry) => entry.id === "string.parseInt")?.title).toBe(
      "Parse Int",
    );
    expect(stringNodes.find((entry) => entry.id === "string.parseFloat")?.title).toBe(
      "Parse Float",
    );
  });

  it("types Split as string array out and Join as string array in", () => {
    const split = stringNodes.find((entry) => entry.id === "string.split");
    expect(split?.pins({}).find((pin) => pin.id === "out")?.type).toEqual(
      arrayOf(STRING),
    );
    const join = stringNodes.find((entry) => entry.id === "string.join");
    expect(join?.pins({}).find((pin) => pin.id === "array")?.type).toEqual(
      arrayOf(STRING),
    );
  });

  it("Parse Int and Parse Float expose Success bool outs", () => {
    for (const id of ["string.parseInt", "string.parseFloat"] as const) {
      const pins = stringNodes.find((entry) => entry.id === id)?.pins({}) ?? [];
      expect(pins.map((pin) => pin.id)).toEqual(
        expect.arrayContaining(["in", "out", "success"]),
      );
      expect(pins.find((pin) => pin.id === "success")?.type).toEqual({
        kind: "bool",
      });
    }
  });

  it("compiles string utilities and parse Success for valid and invalid input", () => {
    const registry = createDefaultNodeRegistry();

    for (const [typeId, needle, pinId] of [
      ["string.contains", "includes", "out"],
      ["string.startsWith", "startsWith", "out"],
      ["string.endsWith", "endsWith", "out"],
      ["string.replace", "replaceAll", "out"],
      ["string.split", "split", "out"],
      ["string.join", "join", "out"],
      ["string.substring", "substring", "out"],
      ["string.trim", "trim", "out"],
      ["string.toLower", "toLowerCase", "out"],
      ["string.toUpper", "toUpperCase", "out"],
      ["string.parseInt", "parseInt", "out"],
      ["string.parseFloat", "parseFloat", "out"],
    ] as const) {
      const graph: LogicGraph = {
        id: "g",
        kind: "event",
        nodes: [
          node(registry, "begin", "flow.event.beginPlay"),
          node(registry, "op", typeId),
          node(registry, "log", "debug.log"),
        ],
        edges: [
          {
            id: "e1",
            sourceNodeId: "begin",
            sourcePinId: "execOut",
            targetNodeId: "log",
            targetPinId: "execIn",
          },
          {
            id: "e2",
            sourceNodeId: "op",
            sourcePinId: pinId,
            targetNodeId: "log",
            targetPinId: "message",
          },
        ],
      };
      if (typeId === "string.join") {
        graph.nodes.push(
          node(registry, "split", "string.split", {
            "default:in": "a,b,c",
            "default:separator": ",",
          }),
        );
        graph.edges.push({
          id: "e3",
          sourceNodeId: "split",
          sourcePinId: "out",
          targetNodeId: "op",
          targetPinId: "array",
        });
      }
      const compiled = compileGraph(graph, { assetGuid: "a", registry });
      expect(compiled.source).toContain(needle);
    }

    const joinGraph: LogicGraph = {
      id: "join",
      kind: "event",
      nodes: [
        node(registry, "begin", "flow.event.beginPlay"),
        node(registry, "split", "string.split", {
          "default:in": "a,b,c",
          "default:separator": ",",
        }),
        node(registry, "join", "string.join", {
          "default:separator": "-",
        }),
        node(registry, "log", "debug.log"),
      ],
      edges: [
        {
          id: "e1",
          sourceNodeId: "begin",
          sourcePinId: "execOut",
          targetNodeId: "log",
          targetPinId: "execIn",
        },
        {
          id: "e2",
          sourceNodeId: "split",
          sourcePinId: "out",
          targetNodeId: "join",
          targetPinId: "array",
        },
        {
          id: "e3",
          sourceNodeId: "join",
          sourcePinId: "out",
          targetNodeId: "log",
          targetPinId: "message",
        },
      ],
    };
    const joinCompiled = compileGraph(joinGraph, { assetGuid: "a", registry });
    const joinMod = loadModule(joinCompiled.source);
    const logs: string[] = [];
    (joinMod.onBeginPlay as (ctx: unknown) => void)({
      formatValue: (value: unknown) => String(value),
      log: (_s: string, _c: string, message: string) => logs.push(message),
    });
    expect(logs).toEqual(["a-b-c"]);

    const parseGraph: LogicGraph = {
      id: "parse",
      kind: "event",
      nodes: [
        node(registry, "begin", "flow.event.beginPlay"),
        node(registry, "parse", "string.parseInt", { "default:in": "7" }),
        node(registry, "log", "debug.log"),
      ],
      edges: [
        {
          id: "e1",
          sourceNodeId: "begin",
          sourcePinId: "execOut",
          targetNodeId: "log",
          targetPinId: "execIn",
        },
        {
          id: "e2",
          sourceNodeId: "parse",
          sourcePinId: "success",
          targetNodeId: "log",
          targetPinId: "message",
        },
      ],
    };
    const parseCompiled = compileGraph(parseGraph, { assetGuid: "a", registry });
    const parseMod = loadModule(parseCompiled.source);
    const parseLogs: string[] = [];
    (parseMod.onBeginPlay as (ctx: unknown) => void)({
      formatValue: (value: unknown) => String(value),
      log: (_s: string, _c: string, message: string) => parseLogs.push(message),
    });
    expect(parseLogs).toEqual(["true"]);
  });
});
