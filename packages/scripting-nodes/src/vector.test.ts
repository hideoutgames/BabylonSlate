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

const edge = (id: string, source: string, sourcePin: string, target: string, targetPin: string) => ({
  id, sourceNodeId: source, sourcePinId: sourcePin, targetNodeId: target, targetPinId: targetPin,
});

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

  it.each([
    ["vector.add3", "a"], ["vector.sub3", "a"], ["vector.mul3", "b"], ["vector.div3", "a"],
    ["vector.scale3", "v"], ["vector.dot3", "b"], ["vector.cross3", "a"], ["vector.length3", "v"],
    ["vector.lengthSquared3", "v"], ["vector.distance3", "b"], ["vector.lerp3", "a"],
  ] as const)("%s reads a changing Vector3 on pin %s once", (typeId, pinId) => {
    const registry = createDefaultNodeRegistry();
    const graph: LogicGraph = {
      id: "once",
      kind: "event",
      nodes: [
        node(registry, "begin", "flow.event.beginPlay"),
        ...["x", "y", "z"].map((axis) => node(registry, `r${axis}`, "math.random")),
        node(registry, "make", "vector.make3"),
        node(registry, "op", typeId),
        node(registry, "log", "debug.log"),
      ],
      edges: [
        { id: "e1", sourceNodeId: "begin", sourcePinId: "execOut", targetNodeId: "log", targetPinId: "execIn" },
        ...["x", "y", "z"].map((axis) => ({ id: `w${axis}`, sourceNodeId: `r${axis}`, sourcePinId: "out", targetNodeId: "make", targetPinId: axis })),
        { id: "e2", sourceNodeId: "make", sourcePinId: "out", targetNodeId: "op", targetPinId: pinId },
        { id: "e3", sourceNodeId: "op", sourcePinId: "out", targetNodeId: "log", targetPinId: "message" },
      ],
    };
    const compiled = compileGraph(graph, { assetGuid: "a", registry });
    let samples = 0;
    (loadModule(compiled.source).onBeginPlay as (ctx: unknown) => void)({
      random: { float: () => (samples += 1) },
      formatValue: (value: unknown) => value,
      log: () => {},
    });
    expect(samples).toBe(3);
  });

  it("Break Vector3 reads its input once per statement for all of its outputs", () => {
    const registry = createDefaultNodeRegistry();
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        node(registry, "begin", "flow.event.beginPlay"),
        node(registry, "pos", "variables.get", { variableName: "Pos", typeId: "vec3", implicitSelf: true }),
        node(registry, "break", "vector.break3"),
        node(registry, "concat", "string.concat"),
        node(registry, "logXY", "debug.log"),
        node(registry, "logZ", "debug.log"),
      ],
      edges: [
        edge("e1", "begin", "execOut", "logXY", "execIn"),
        edge("e2", "logXY", "execOut", "logZ", "execIn"),
        edge("e3", "pos", "value", "break", "in"),
        edge("e4", "break", "x", "concat", "a"),
        edge("e5", "break", "y", "concat", "b"),
        edge("e6", "concat", "out", "logXY", "message"),
        edge("e7", "break", "z", "logZ", "message"),
      ],
    };
    let reads = 0;
    const logs: string[] = [];
    (loadModule(compileGraph(graph, { assetGuid: "a", registry }).source).onBeginPlay as (ctx: unknown) => void)({
      getVariable: () => {
        reads += 1;
        return { x: reads, y: reads * 10, z: reads * 100 };
      },
      formatValue: (value: unknown) => String(value),
      log: (_severity: string, _category: string, message: string) => logs.push(message),
    });
    // X and Y share one read; the next statement reads Pos again.
    expect({ reads, logs }).toEqual({ reads: 2, logs: ["110", "200"] });
  });

  it("For Loop reads a shared Last Index again after each iteration", () => {
    const registry = createDefaultNodeRegistry();
    // Break's X bounds the loop and its Y feeds the body, so both read Limit
    // through one memo. The body lowers Limit; the next bound check sees it.
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        node(registry, "begin", "flow.event.beginPlay"),
        node(registry, "limit", "variables.get", { variableName: "Limit", typeId: "vec3", implicitSelf: true }),
        node(registry, "break", "vector.break3"),
        node(registry, "loop", "flow.forLoop", { "default:firstIndex": 0 }),
        node(registry, "log", "debug.log"),
      ],
      edges: [
        edge("e1", "begin", "execOut", "loop", "execIn"),
        edge("e2", "limit", "value", "break", "in"),
        edge("e3", "break", "x", "loop", "lastIndex"),
        edge("e4", "loop", "loopBody", "log", "execIn"),
        edge("e5", "break", "y", "log", "message"),
      ],
    };
    let limit = { x: 1, y: 7, z: 0 };
    const logs: string[] = [];
    (loadModule(compileGraph(graph, { assetGuid: "a", registry }).source).onBeginPlay as (ctx: unknown) => void)({
      getVariable: () => limit,
      formatValue: (value: unknown) => String(value),
      log: (_severity: string, _category: string, message: string) => {
        logs.push(message);
        limit = { x: 0, y: 0, z: 0 };
      },
    });
    expect(logs).toEqual(["7"]);
  });
});
