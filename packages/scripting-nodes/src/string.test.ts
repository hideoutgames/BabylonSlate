import { describe, expect, it } from "vitest";
import {
  compileGraph,
  arrayOf,
  STRING,
  BOXED_WILDCARD,
  type GraphNode,
  type LogicGraph,
  type NodeRegistry,
} from "@babylonslate/scripting";
import { createDefaultNodeRegistry } from "./index";
import {
  FORMAT_ARG_PIN_PREFIX,
  formatArgNameFromPinId,
  formatArgPinId,
  parseFormatPlaceholders,
  parseFormatTokens,
  stringNodes,
} from "./string";

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

describe("format placeholder parsing", () => {
  it("defaults to {input} and accepts arbitrary nonempty names", () => {
    expect(parseFormatPlaceholders("{input}")).toEqual(["input"]);
    expect(parseFormatPlaceholders("{0} {#} {input pin}")).toEqual([
      "0",
      "#",
      "input pin",
    ]);
  });

  it("shares a pin for repeated tokens and ignores escaped braces", () => {
    expect(parseFormatPlaceholders("{name} {name}")).toEqual(["name"]);
    expect(parseFormatPlaceholders("Hello {{name}} {name}")).toEqual(["name"]);
    expect(parseFormatTokens("a {{b}} {c} }} {{")).toEqual([
      { kind: "lit", text: "a {b} " },
      { kind: "arg", name: "c" },
      { kind: "lit", text: " } {" },
    ]);
  });

  it("encodes placeholder names into stable pin ids", () => {
    expect(formatArgPinId("input pin")).toBe(
      `${FORMAT_ARG_PIN_PREFIX}${encodeURIComponent("input pin")}`,
    );
    expect(formatArgNameFromPinId(formatArgPinId("#"))).toBe("#");
    expect(formatArgNameFromPinId(formatArgPinId("0"))).toBe("0");
    expect(formatArgNameFromPinId("format")).toBeUndefined();
  });
});

describe("string.format node", () => {
  it("registers Format String with default {input} argument pin", () => {
    expect(stringNodes.map((entry) => entry.id)).toContain("string.format");
    const def = stringNodes.find((entry) => entry.id === "string.format");
    expect(def?.title).toBe("Format String");
    expect(def?.category).toBe("string");
    expect(def?.pure).toBe(true);
    const pins = def!.pins({ "default:format": "{input}" });
    expect(pins.map((pin) => pin.id)).toEqual([
      "format",
      formatArgPinId("input"),
      "out",
    ]);
    expect(pins.find((pin) => pin.id === "format")?.type).toEqual(STRING);
    expect(pins.find((pin) => pin.id === formatArgPinId("input"))?.type).toEqual(
      BOXED_WILDCARD,
    );
    expect(pins.find((pin) => pin.id === "out")?.type).toEqual(STRING);
  });

  it("builds independent boxed wildcard pins for each unique placeholder", () => {
    const pins = stringNodes
      .find((entry) => entry.id === "string.format")!
      .pins({ "default:format": "{0} {#} {0} {input pin}" });
    const argPins = pins.filter((pin) => pin.id.startsWith(FORMAT_ARG_PIN_PREFIX));
    expect(argPins.map((pin) => pin.name)).toEqual(["0", "#", "input pin"]);
    expect(argPins.every((pin) => pin.type.kind === "boxedWildcard")).toBe(true);
  });

  it("omits argument pins when the Format input is wired", () => {
    const pins = stringNodes
      .find((entry) => entry.id === "string.format")!
      .pins({
        "default:format": "{input} {count}",
        formatWired: true,
      });
    expect(pins.map((pin) => pin.id)).toEqual(["format", "out"]);
  });

  it("compiles placeholders through ctx.formatValue", () => {
    const registry = createDefaultNodeRegistry();
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        node(registry, "begin", "flow.event.beginPlay"),
        node(registry, "fmt", "string.format", {
          "default:format": "Hi {name}",
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
          sourceNodeId: "fmt",
          sourcePinId: "out",
          targetNodeId: "log",
          targetPinId: "message",
        },
      ],
    };
    const compiled = compileGraph(graph, { assetGuid: "a", registry });
    expect(compiled.source).toContain("ctx.formatValue");
    expect(compiled.source).toContain('"Hi "');
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
