import { describe, expect, it } from "vitest";
import {
  compileGraph,
  type GraphNode,
  type LogicGraph,
  type NodeRegistry,
} from "@babylonslate/scripting";
import { createDefaultNodeRegistry, mathNodes } from "./index";

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

describe("math nodes", () => {
  it("exports at least one node definition", () => {
    expect(mathNodes.length).toBeGreaterThan(0);
    expect(mathNodes[0]?.id).toBeTruthy();
    expect(mathNodes[0]?.category).toBeTruthy();
  });

  it("registers comparison and boolean operators used by animation rules", () => {
    const ids = mathNodes.map((node) => node.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        "math.greater",
        "math.greaterEqual",
        "math.less",
        "math.lessEqual",
        "boolean.and",
        "boolean.or",
        "boolean.not",
      ]),
    );
  });

  it("registers scalar lerp, clamp, trig, and seeded random", () => {
    expect(mathNodes.map((node) => node.id)).toEqual(
      expect.arrayContaining([
        "math.lerp",
        "math.clamp",
        "math.min",
        "math.max",
        "math.sin",
        "math.cos",
        "math.degrees",
        "math.radians",
        "math.floor",
        "math.ceil",
        "math.random",
      ]),
    );
    expect(mathNodes.find((node) => node.id === "math.random")?.title).toBe(
      "Random Float",
    );
  });

  it("registers integer math parity beside Add Int", () => {
    expect(mathNodes.map((entry) => entry.id)).toEqual(
      expect.arrayContaining([
        "math.add_int",
        "math.sub_int",
        "math.mul_int",
        "math.div_int",
        "math.mod_int",
      ]),
    );
    for (const id of [
      "math.sub_int",
      "math.mul_int",
      "math.div_int",
      "math.mod_int",
    ] as const) {
      const pins = mathNodes.find((entry) => entry.id === id)?.pins({}) ?? [];
      expect(pins.every((pin) => pin.type.kind === "int" || pin.id === "out")).toBe(
        true,
      );
      expect(pins.map((pin) => pin.type.kind)).toEqual(["int", "int", "int"]);
    }
  });

  it("registers primitive Equal and Not Equal", () => {
    expect(mathNodes.map((entry) => entry.id)).toEqual(
      expect.arrayContaining(["math.equals", "math.notEquals"]),
    );
    expect(mathNodes.find((entry) => entry.id === "math.equals")?.title).toBe(
      "Equal",
    );
    expect(mathNodes.find((entry) => entry.id === "math.notEquals")?.title).toBe(
      "Not Equal",
    );
  });

  it("registers Sign, Power, Sqrt, and Round", () => {
    expect(mathNodes.map((entry) => entry.id)).toEqual(
      expect.arrayContaining([
        "math.sign",
        "math.power",
        "math.sqrt",
        "math.round",
      ]),
    );
    expect(mathNodes.find((entry) => entry.id === "math.sign")?.title).toBe("Sign");
    expect(mathNodes.find((entry) => entry.id === "math.power")?.title).toBe(
      "Power",
    );
    expect(mathNodes.find((entry) => entry.id === "math.sqrt")?.title).toBe(
      "Sqrt",
    );
    expect(mathNodes.find((entry) => entry.id === "math.round")?.title).toBe(
      "Round",
    );
  });

  it("registers Random Int and Random Bool that codegen through ctx.random", () => {
    expect(mathNodes.map((entry) => entry.id)).toEqual(
      expect.arrayContaining(["math.randomInt", "math.randomBool"]),
    );
    expect(mathNodes.find((entry) => entry.id === "math.randomInt")?.title).toBe(
      "Random Int",
    );
    expect(mathNodes.find((entry) => entry.id === "math.randomBool")?.title).toBe(
      "Random Bool",
    );

    const registry = createDefaultNodeRegistry();
    for (const [typeId, needle] of [
      ["math.random", "ctx.random.float"],
      ["math.randomInt", "ctx.random.int"],
      ["math.randomBool", "ctx.random.bool"],
    ] as const) {
      const graph: LogicGraph = {
        id: "g",
        kind: "event",
        nodes: [
          node(registry, "begin", "flow.event.beginPlay"),
          node(registry, "rng", typeId, {
            "default:min": 1,
            "default:max": 3,
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
            sourceNodeId: "rng",
            sourcePinId: "out",
            targetNodeId: "log",
            targetPinId: "message",
          },
        ],
      };
      const compiled = compileGraph(graph, { assetGuid: "a", registry });
      expect(compiled.source).toContain(needle);
      expect(compiled.source).not.toContain("Math.random");
    }

    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        node(registry, "begin", "flow.event.beginPlay"),
        node(registry, "rb", "math.randomBool"),
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
          sourceNodeId: "rb",
          sourcePinId: "out",
          targetNodeId: "log",
          targetPinId: "message",
        },
      ],
    };
    const compiled = compileGraph(graph, { assetGuid: "a", registry });
    const calls: string[] = [];
    const mod = loadModule(compiled.source);
    (mod.onBeginPlay as (ctx: unknown) => void)({
      formatValue: (value: unknown) => String(value),
      log: () => {},
      random: {
        float: () => {
          calls.push("float");
          return 0.25;
        },
        int: (min: number, max: number) => {
          calls.push(`int:${min}:${max}`);
          return min;
        },
        bool: () => {
          calls.push("bool");
          return true;
        },
      },
    });
    expect(calls).toEqual(["bool"]);
  });

  it("compiles Equal, Sign, Power, Sqrt, Round, and integer Subtract", () => {
    const registry = createDefaultNodeRegistry();
    for (const [typeId, needle] of [
      ["math.equals", "==="],
      ["math.sign", "Math.sign"],
      ["math.power", "Math.pow"],
      ["math.sqrt", "Math.sqrt"],
      ["math.round", "Math.round"],
    ] as const) {
      const graph: LogicGraph = {
        id: "g",
        kind: "event",
        nodes: [
          node(registry, "begin", "flow.event.beginPlay"),
          node(registry, "op", typeId, {
            "default:a": 1,
            "default:b": 1,
            "default:in": -2,
            "default:base": 2,
            "default:exp": 3,
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
            sourceNodeId: "op",
            sourcePinId: "out",
            targetNodeId: "log",
            targetPinId: "message",
          },
        ],
      };
      const compiled = compileGraph(graph, { assetGuid: "a", registry });
      expect(compiled.source).toContain(needle);
    }

    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        node(registry, "begin", "flow.event.beginPlay"),
        node(registry, "sub", "math.sub_int", {
          "default:a": 5,
          "default:b": 2,
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
          sourceNodeId: "sub",
          sourcePinId: "out",
          targetNodeId: "log",
          targetPinId: "message",
        },
      ],
    };
    const compiled = compileGraph(graph, { assetGuid: "a", registry });
    const mod = loadModule(compiled.source);
    const logs: string[] = [];
    (mod.onBeginPlay as (ctx: unknown) => void)({
      formatValue: (value: unknown) => String(value),
      log: (_s: string, _c: string, message: string) => logs.push(message),
    });
    expect(logs).toEqual(["3"]);
  });
});
