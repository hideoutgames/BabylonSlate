import { describe, expect, it } from "vitest";
import {
  compileGraph,
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

function loadModule(source: string): Record<string, unknown> {
  const body = source.replace(/export\s+(async\s+)?function\s+/g, "$1function ");
  return new Function(`${body}\nreturn { onBeginPlay };`)() as Record<
    string,
    unknown
  >;
}

describe("vector nodes", () => {
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

  it.each([
    ["vector.make2", "vector.normalize2", ["x", "y"]],
    ["vector.make3", "vector.normalize3", ["x", "y", "z"]],
    ["vector.make4", "vector.normalize4", ["x", "y", "z", "w"]],
  ] as const)("%s → %s reads a changing input once for a unit result", (makeId, normalizeId, axes) => {
    const registry = createDefaultNodeRegistry();
    const graph: LogicGraph = {
      id: "norm",
      kind: "event",
      nodes: [
        node(registry, "begin", "flow.event.beginPlay"),
        ...axes.map((axis) => node(registry, `r${axis}`, "math.random")),
        node(registry, "make", makeId),
        node(registry, "norm", normalizeId),
        node(registry, "log", "debug.log"),
      ],
      edges: [
        { id: "e1", sourceNodeId: "begin", sourcePinId: "execOut", targetNodeId: "log", targetPinId: "execIn" },
        ...axes.map((axis) => ({ id: `w${axis}`, sourceNodeId: `r${axis}`, sourcePinId: "out", targetNodeId: "make", targetPinId: axis })),
        { id: "e2", sourceNodeId: "make", sourcePinId: "out", targetNodeId: "norm", targetPinId: "v" },
        { id: "e3", sourceNodeId: "norm", sourcePinId: "out", targetNodeId: "log", targetPinId: "message" },
      ],
    };
    const compiled = compileGraph(graph, { assetGuid: "a", registry });
    let sample = 0;
    const logged: Array<Record<string, number>> = [];
    (loadModule(compiled.source).onBeginPlay as (ctx: unknown) => void)({
      random: { float: () => (sample += 1) },
      formatValue: (value: Record<string, number>) => value,
      log: (_severity: string, _category: string, value: Record<string, number>) => logged.push(value),
    });
    expect(sample).toBe(axes.length);
    expect(Math.hypot(...axes.map((axis) => logged[0]![axis]!))).toBeCloseTo(1, 12);
  });
});
