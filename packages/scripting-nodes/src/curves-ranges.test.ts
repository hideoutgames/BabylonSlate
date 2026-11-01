import { describe, expect, it } from "vitest";
import {
  clampToRange,
  createSeededRng,
  curveTimeRange,
  evaluateCurveAnyOrder,
  floatCurveValueRange,
  isInRange,
  lerpFloatRange,
  mapFloatRange,
  randomInRange,
  type CurveKind,
  type RangeKind,
} from "@haptic/core";
import {
  compileGraph,
  ENGINE_STRUCTS,
  type GraphNode,
  type LogicGraph,
  type NodeRegistry,
  type PinType,
} from "@haptic/scripting";
import { createDefaultNodeRegistry } from "./index";

const registry = createDefaultNodeRegistry();

function node(reg: NodeRegistry, id: string, typeId: string, properties: Record<string, unknown> = {}): GraphNode {
  const def = reg.get(typeId);
  if (!def) throw new Error(`missing node ${typeId}`);
  return { id, typeId, position: { x: 0, y: 0 }, pins: def.pins(properties), properties };
}

function loadModule(source: string): Record<string, unknown> {
  const body = source.replace(/export\s+(async\s+)?function\s+/g, "$1function ");
  return new Function(`${body}\nreturn { run };`)() as Record<string, unknown>;
}

/** The host members these nodes compile to, bound to core and a seeded generator as ScriptHost binds them. */
function hostMembers(seed: number) {
  const rng = createSeededRng(seed);
  return {
    randomInRange: (kind: RangeKind, range: unknown) => randomInRange(kind, range, rng),
    clampToRange,
    isInRange,
    lerpFloatRange,
    mapFloatRange,
    evaluateCurve: (kind: CurveKind, curve: unknown, time: unknown) => evaluateCurveAnyOrder(kind, curve, Number(time)),
    curveTimeRange,
    floatCurveValueRange,
  };
}

/** Runs `source` (optionally fed by extra nodes) into a JavaScript sink and returns what the sink received. */
function run(
  nodes: GraphNode[],
  from: { node: string; pin: string; type: PinType },
  edges: LogicGraph["edges"] = [],
  seed = 1,
): unknown {
  const graph: LogicGraph = {
    id: "g",
    kind: "event",
    nodes: [
      node(registry, "entry", "flow.entry"),
      ...nodes,
      node(registry, "sink", "debug.executeJavaScript", {
        inputs: [{ name: "value", type: from.type }],
        body: "ctx.received.push(value);",
      }),
    ],
    edges: [
      { id: "start", sourceNodeId: "entry", sourcePinId: "execOut", targetNodeId: "sink", targetPinId: "execIn" },
      { id: "value", sourceNodeId: from.node, sourcePinId: from.pin, targetNodeId: "sink", targetPinId: "in_value" },
      ...edges,
    ],
  };
  const compiled = compileGraph(graph, { assetGuid: "a", registry });
  const ctx = { ...hostMembers(seed), received: [] as unknown[] };
  (loadModule(compiled.source).run as (ctx: unknown) => unknown)(ctx);
  return ctx.received[0];
}

const key = (Time: number, Value: unknown, Interpolation = "linear") =>
  ({ Time, Value, Interpolation, ArriveTangent: 0, LeaveTangent: 0 });

describe("range and curve nodes", () => {
  it("evaluates an unwired Float Curve literal at the given time", () => {
    const curve = { Keys: [key(0, 0), key(2, 10)], Before: "constant", After: "linear" };
    const evaluate = node(registry, "eval", "curve.evaluateFloat", { "default:curve": curve, "default:time": 3 });
    expect(run([evaluate], { node: "eval", pin: "value", type: { kind: "float" } })).toBe(15);
  });

  it("evaluates every channel of a Vector Curve", () => {
    const curve = { Keys: [key(0, { x: 0, y: 0, z: 0 }), key(1, { x: 2, y: 4, z: 6 })], Before: "constant", After: "constant" };
    const evaluate = node(registry, "eval", "curve.evaluateVector", { "default:curve": curve, "default:time": 0.5 });
    expect(run([evaluate], { node: "eval", pin: "value", type: { kind: "vec3" } })).toEqual({ x: 1, y: 2, z: 3 });
  });

  it("reads a range built with Make Structure for an engine range type", () => {
    const fields = ENGINE_STRUCTS.find((entry) => entry.id === "engine:FloatRange")!.fields;
    const make = node(registry, "make", "struct.make", {
      structGuid: "engine:FloatRange", fields, "default:Min": 10, "default:Max": 20,
    });
    const lerp = node(registry, "lerp", "range.lerpFloat", { "default:alpha": 0.25 });
    const result = run(
      [make, lerp],
      { node: "lerp", pin: "value", type: { kind: "float" } },
      [{ id: "range", sourceNodeId: "make", sourcePinId: "out", targetNodeId: "lerp", targetPinId: "range" }],
    );
    expect(result).toBe(12.5);
  });

  it("maps and clamps through Map Float Range", () => {
    const map = node(registry, "map", "range.mapFloat", {
      "default:value": 15, "default:from": { Min: 0, Max: 10 }, "default:to": { Min: 100, Max: 200 }, "default:clamp": true,
    });
    expect(run([map], { node: "map", pin: "result", type: { kind: "float" } })).toBe(200);
  });

  it("tests Integer membership with both ends included", () => {
    const inRange = node(registry, "in", "range.isIntInRange", { "default:value": 5, "default:range": { Min: 2, Max: 5 } });
    expect(run([inRange], { node: "in", pin: "result", type: { kind: "bool" } })).toBe(true);
  });

  it("draws Random Integer In Range from the seeded generator, repeatably", () => {
    const random = () => node(registry, "random", "range.randomInt", { "default:range": { Min: 1, Max: 100 } });
    const draw = (seed: number) => run([random()], { node: "random", pin: "value", type: { kind: "int" } }, [], seed);
    const expected = randomInRange("int", { Min: 1, Max: 100 }, createSeededRng(42));
    expect(draw(42)).toBe(expected);
    expect(draw(42)).toBe(draw(42));
  });

  it("offers Get Time Range for every curve type and Get Value Range for Float Curves", () => {
    const ids = registry.list().filter((entry) => entry.category === "curve").map((entry) => entry.id);
    expect(ids).toEqual(expect.arrayContaining([
      "curve.floatTimeRange", "curve.vectorTimeRange", "curve.colorTimeRange", "curve.floatValueRange",
    ]));
    const curve = { Keys: [key(-1, 4), key(3, -2)], Before: "constant", After: "constant" };
    const values = node(registry, "values", "curve.floatValueRange", { "default:curve": curve });
    expect(run([values], { node: "values", pin: "valueRange", type: { kind: "structRef", guid: "engine:FloatRange" } }))
      .toEqual({ Min: -2, Max: 4 });
  });
});
