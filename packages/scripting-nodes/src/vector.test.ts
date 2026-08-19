import { describe, expect, it } from "vitest";
import {
  compileGraph,
  type GraphNode,
  type LogicGraph,
  type NodeRegistry,
} from "@babylonslate/scripting";
import { createDefaultNodeRegistry, vectorNodes } from "./index";

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

describe("vector nodes", () => {
  it("exports at least one node definition", () => {
    expect(vectorNodes.length).toBeGreaterThan(0);
    expect(vectorNodes[0]?.id).toBeTruthy();
    expect(vectorNodes[0]?.category).toBeTruthy();
  });

  it("registers subtract, multiply, divide, dot, cross, length, and lerp", () => {
    expect(vectorNodes.map((entry) => entry.id)).toEqual(
      expect.arrayContaining([
        "vector.sub3",
        "vector.mul3",
        "vector.div3",
        "vector.dot3",
        "vector.cross3",
        "vector.length3",
        "vector.normalize3",
        "vector.distance3",
        "vector.lerp3",
        "vector.add2",
        "vector.scale2",
        "vector.add4",
        "vector.scale4",
      ]),
    );
  });

  it("registers Break Vector2 and Break Vector4 beside the Make nodes", () => {
    expect(vectorNodes.map((entry) => entry.id)).toEqual(
      expect.arrayContaining([
        "vector.make2",
        "vector.break2",
        "vector.make4",
        "vector.break4",
      ]),
    );
    const break2 = vectorNodes.find((entry) => entry.id === "vector.break2");
    expect(break2?.pins({}).map((pin) => pin.id)).toEqual(["in", "x", "y"]);
    const break4 = vectorNodes.find((entry) => entry.id === "vector.break4");
    expect(break4?.pins({}).map((pin) => pin.id)).toEqual([
      "in",
      "x",
      "y",
      "z",
      "w",
    ]);
  });

  it("registers LengthSquared for Vector2/3/4 and Distance Vector4", () => {
    expect(vectorNodes.map((entry) => entry.id)).toEqual(
      expect.arrayContaining([
        "vector.lengthSquared2",
        "vector.lengthSquared3",
        "vector.lengthSquared4",
        "vector.distance4",
      ]),
    );
    expect(
      vectorNodes.find((entry) => entry.id === "vector.lengthSquared3")?.title,
    ).toBe("Vector3 Length Squared");
    expect(vectorNodes.find((entry) => entry.id === "vector.distance4")?.title).toBe(
      "Distance Vector4",
    );
  });

  it("Normalize Vector3 is zero-safe and LengthSquared compiles", () => {
    const registry = createDefaultNodeRegistry();
    const normalizeGraph: LogicGraph = {
      id: "norm",
      kind: "event",
      nodes: [
        node(registry, "begin", "flow.event.beginPlay"),
        node(registry, "make", "vector.make3", {
          "default:x": 0,
          "default:y": 0,
          "default:z": 0,
        }),
        node(registry, "norm", "vector.normalize3"),
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
          sourceNodeId: "make",
          sourcePinId: "out",
          targetNodeId: "norm",
          targetPinId: "v",
        },
        {
          id: "e3",
          sourceNodeId: "norm",
          sourcePinId: "out",
          targetNodeId: "log",
          targetPinId: "message",
        },
      ],
    };
    const normalizeCompiled = compileGraph(normalizeGraph, {
      assetGuid: "a",
      registry,
    });
    expect(normalizeCompiled.source).toMatch(/1e-8/);

    const lengthGraph: LogicGraph = {
      id: "len",
      kind: "event",
      nodes: [
        node(registry, "begin", "flow.event.beginPlay"),
        node(registry, "make", "vector.make3", {
          "default:x": 0,
          "default:y": 0,
          "default:z": 0,
        }),
        node(registry, "len2", "vector.lengthSquared3"),
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
          sourceNodeId: "make",
          sourcePinId: "out",
          targetNodeId: "len2",
          targetPinId: "v",
        },
        {
          id: "e3",
          sourceNodeId: "len2",
          sourcePinId: "out",
          targetNodeId: "log",
          targetPinId: "message",
        },
      ],
    };
    const compiled = compileGraph(lengthGraph, { assetGuid: "a", registry });
    const mod = loadModule(compiled.source);
    const logs: string[] = [];
    (mod.onBeginPlay as (ctx: unknown) => void)({
      formatValue: (value: unknown) => String(value),
      log: (_s: string, _c: string, message: string) => logs.push(message),
    });
    expect(logs).toEqual(["0"]);
  });
});
