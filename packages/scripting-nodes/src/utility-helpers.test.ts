import { describe, expect, it } from "vitest";
import {
  arrayOf, BOOL, compileGraph, FLOAT, pin,
  type CodegenContext, type GraphNode, type GraphPin, type LogicGraph, type PinType,
} from "@haptic/scripting";
import { createDefaultNodeRegistry } from "./index";
import { utilityHelperNodes } from "./utility-helpers";

/** Runs one node's generated code with literal inputs and returns its data outputs. */
function run(id: string, inputs: Record<string, unknown>, options: { pins?: GraphPin[]; ctx?: Record<string, unknown> } = {}) {
  const def = utilityHelperNodes.find((node) => node.id === id)!;
  const hoisted = new Set<string>();
  const emits: string[] = [];
  const ctx = {
    graph: { id: "g", kind: "event", nodes: [], edges: [] },
    node: { id: "n", typeId: id, position: { x: 0, y: 0 }, pins: options.pins ?? def.pins({}), properties: {} },
    indent: "",
    input: (pinId: string) => `(${JSON.stringify(inputs[pinId])})`,
    isWired: () => true,
    output: (pinId: string) => `out_${pinId}`,
    emit: (line: string) => emits.push(line),
    hoist: (line: string) => hoisted.add(line),
    requestAsync: () => {},
  } as unknown as CodegenContext;
  const pure = def.codegen(ctx) as Record<string, string> | undefined;
  const outs = def.pins({}).filter((entry) => entry.direction === "out" && entry.type.kind !== "exec").map((entry) => entry.id);
  const body = [...hoisted, ...outs.map((out) => `let out_${out};`), ...emits,
    `return { ${outs.map((out) => `${out}: ${pure?.[out] ?? `out_${out}`}`).join(", ")} };`].join("\n");
  return (new Function("ctx", body) as (ctx: unknown) => Record<string, unknown>)(options.ctx ?? {});
}

const v = (x: number, y: number, z: number) => ({ x, y, z });
const close = (x: number, y: number, z: number) => ({ x: expect.closeTo(x, 9), y: expect.closeTo(y, 9), z: expect.closeTo(z, 9) });

describe("utility helper nodes", () => {
  it.each([
    ["math.exp", { value: 1 }, Math.E],
    ["math.ln", { value: Math.E }, 1],
    ["math.ln", { value: 0 }, 0],
    ["math.logarithm", { value: 1000, base: 10 }, 3],
    ["math.logarithm", { value: 8, base: 2 }, 3],
    ["math.logarithm", { value: 5, base: 1 }, 0],
    ["math.truncate", { value: -2.7 }, -2],
    ["math.truncate", { value: 2.7 }, 2],
    ["math.fraction", { value: -1.25 }, 0.75],
    ["math.square", { value: -3 }, 9],
    ["math.wrap", { value: 370, min: 0, max: 360 }, 10],
    ["math.wrap", { value: -10, min: 0, max: 360 }, 350],
    ["math.wrap", { value: 5, min: 2, max: 2 }, 2],
    ["math.snapToGrid", { value: 7.4, gridSize: 5 }, 5],
    ["math.snapToGrid", { value: 7.6, gridSize: 5 }, 10],
    ["math.snapToGrid", { value: 3, gridSize: 0 }, 3],
    ["math.normalizeAxis", { angle: 190 }, -170],
    ["math.normalizeAxis", { angle: -190 }, 170],
    ["math.normalizeAxis", { angle: -180 }, 180],
    ["math.normalizeAxis", { angle: 540 }, 180],
    ["math.clampAngle", { angle: 100, minAngle: -90, maxAngle: 90 }, 90],
    ["math.clampAngle", { angle: -100, minAngle: -90, maxAngle: 90 }, -90],
    ["math.clampAngle", { angle: 45, minAngle: -90, maxAngle: 90 }, 45],
    // The arc from 90 round to -90 passes 180: 170 is inside it, 10 is nearer its 90 end.
    ["math.clampAngle", { angle: 170, minAngle: 90, maxAngle: -90 }, 170],
    ["math.clampAngle", { angle: 10, minAngle: 90, maxAngle: -90 }, 90],
    ["math.xor", { a: true, b: false }, true],
    ["math.xor", { a: true, b: true }, false],
    ["math.bitwiseAnd", { a: 12, b: 10 }, 8],
    ["math.bitwiseOr", { a: 12, b: 10 }, 14],
    ["math.bitwiseXor", { a: 12, b: 10 }, 6],
    ["math.bitwiseNot", { value: 0 }, -1],
    ["math.shiftLeft", { value: 3, shift: 2 }, 12],
    ["math.shiftRight", { value: -8, shift: 1 }, -4],
    ["math.floatInterpTo", { current: 0, target: 10, deltaTime: 0.1, interpSpeed: 5 }, 5],
    ["math.floatInterpTo", { current: 0, target: 10, deltaTime: 1, interpSpeed: 5 }, 10],
    ["math.floatInterpTo", { current: 0, target: 10, deltaTime: 0.1, interpSpeed: 0 }, 10],
    ["math.floatInterpToConstant", { current: 0, target: 10, deltaTime: 0.5, interpSpeed: 4 }, 2],
    ["math.floatInterpToConstant", { current: 0, target: -10, deltaTime: 0.5, interpSpeed: 4 }, -2],
    ["math.floatInterpToConstant", { current: 9, target: 10, deltaTime: 0.5, interpSpeed: 4 }, 10],
    ["vector.angleBetween", { a: v(1, 0, 0), b: v(0, 1, 0) }, 90],
    ["vector.angleBetween", { a: v(1, 0, 0), b: v(-2, 0, 0) }, 180],
    ["vector.angleBetween", { a: v(0, 0, 0), b: v(1, 0, 0) }, 0],
    ["vector.nearlyEqual", { a: v(1, 2, 3), b: v(1.00005, 2, 3), tolerance: 0.0001 }, true],
    ["vector.nearlyEqual", { a: v(1, 2, 3), b: v(1.001, 2, 3), tolerance: 0.0001 }, false],
  ] as const)("%s %j", (id, inputs, expected) => {
    const { out } = run(id, inputs);
    if (typeof expected === "number") expect(out).toBeCloseTo(expected, 9);
    else expect(out).toBe(expected);
  });

  it.each([
    ["vector.interpTo", { current: v(0, 0, 0), target: v(10, 0, 0), deltaTime: 0.1, interpSpeed: 5 }, close(5, 0, 0)],
    ["vector.interpToConstant", { current: v(0, 0, 0), target: v(3, 4, 0), deltaTime: 0.5, interpSpeed: 2 }, close(0.6, 0.8, 0)],
    ["vector.interpToConstant", { current: v(0, 0, 0), target: v(3, 4, 0), deltaTime: 1, interpSpeed: 10 }, v(3, 4, 0)],
    ["vector.unitDirection", { from: v(1, 1, 1), to: v(1, 4, 5) }, close(0, 0.6, 0.8)],
    ["vector.unitDirection", { from: v(1, 1, 1), to: v(1, 1, 1) }, v(0, 0, 0)],
    ["vector.projectOnTo", { vector: v(2, 3, 4), target: v(0, 0, 2) }, close(0, 0, 4)],
    ["vector.projectOnToPlane", { vector: v(2, 3, 4), planeNormal: v(0, 0, 5) }, close(2, 3, 0)],
    ["vector.mirrorByNormal", { vector: v(1, -1, 0), normal: v(0, 2, 0) }, close(1, 1, 0)],
    ["vector.clampSize", { vector: v(3, 4, 0), min: 0, max: 2.5 }, close(1.5, 2, 0)],
    ["vector.clampSize", { vector: v(0.3, 0.4, 0), min: 1, max: 5 }, close(0.6, 0.8, 0)],
    ["vector.clampSize", { vector: v(0, 0, 0), min: 1, max: 5 }, v(0, 0, 0)],
    ["vector.negate", { vector: v(1, -2, 3) }, v(-1, 2, -3)],
    // The short way from yaw 170 to -170 crosses 180.
    ["rotator.interpTo", { current: { pitch: 10, yaw: 170, roll: 0 }, target: { pitch: 20, yaw: -170, roll: 0 }, deltaTime: 0.1, interpSpeed: 5 },
      { pitch: 15, yaw: 180, roll: 0 }],
    ["string.findSubstring", { string: "banana", substring: "an", fromEnd: false }, 1],
    ["string.findSubstring", { string: "banana", substring: "an", fromEnd: true }, 3],
    ["string.findSubstring", { string: "abc", substring: "x", fromEnd: false }, -1],
    ["string.reverse", { string: "abc" }, "cba"],
    ["string.isEmpty", { string: "" }, true],
    ["string.isEmpty", { string: "a" }, false],
    ["string.padLeft", { string: "7", length: 3, padCharacter: "0" }, "007"],
    ["string.padLeft", { string: "long", length: 2, padCharacter: "0" }, "long"],
    ["string.padRight", { string: "ab", length: 4, padCharacter: "" }, "ab  "],
    ["string.formatFloat", { value: 3.14159, decimals: 2 }, "3.14"],
    ["string.formatFloat", { value: 2, decimals: 0 }, "2"],
    ["string.formatFloat", { value: -0.5, decimals: 1 }, "-0.5"],
  ] as const)("%s %j", (id, inputs, expected) => {
    expect(run(id, inputs).out).toEqual(expected);
  });

  it("Ease blends A to B by the eased Alpha", () => {
    const calls: unknown[][] = [];
    const ctx = { easeAlpha: (curve: unknown, alpha: number) => (calls.push([curve, alpha]), alpha * alpha) };
    expect(run("math.ease", { a: 2, b: 12, alpha: 0.5, curve: "quadIn" }, { ctx }).out).toBe(4.5);
    expect(calls).toEqual([["quadIn", 0.5]]);
  });

  it("array helpers return a changed copy and leave the input array alone", () => {
    const input = [3, 1, 2];
    expect(run("array.sort", { array: input, descending: false }).out).toEqual([1, 2, 3]);
    expect(run("array.sort", { array: input, descending: true }).out).toEqual([3, 2, 1]);
    expect(run("array.sort", { array: ["b", "C", "a"], descending: false }).out).toEqual(["C", "a", "b"]);
    expect(run("array.addUnique", { array: [1, 2], item: 2 })).toEqual({ out: [1, 2], index: 1 });
    expect(run("array.addUnique", { array: [1, 2], item: 3 })).toEqual({ out: [1, 2, 3], index: 2 });
    expect(run("array.swap", { array: ["a", "b", "c"], first: 0, second: 2 }).out).toEqual(["c", "b", "a"]);
    expect(run("array.swap", { array: ["a", "b"], first: 0, second: 2 }).out).toEqual(["a", "b"]);
    const floats = createDefaultNodeRegistry().get("array.resize")!.pins({})
      .map((entry) => entry.id === "out" || entry.id === "array" ? { ...entry, type: arrayOf(FLOAT) } : entry);
    expect(run("array.resize", { array: [1, 2, 3], size: 1 }, { pins: floats }).out).toEqual([1]);
    expect(run("array.resize", { array: [1], size: 3 }, { pins: floats }).out).toEqual([1, 0, 0]);
    expect(run("array.resize", { array: [1], size: -2 }, { pins: floats }).out).toEqual([]);
    expect(input).toEqual([3, 1, 2]);
  });

  it.each([
    ["array.maxOfFloat", [1, 5.5, 5.5, 2], { index: 1, value: 5.5 }],
    ["array.minOfFloat", [1, -5, 0, -5], { index: 1, value: -5 }],
    ["array.maxOfInt", [], { index: -1, value: 0 }],
    ["array.minOfInt", [4, 3], { index: 1, value: 3 }],
  ] as const)("%s %j", (id, array, expected) => {
    expect(run(id, { array })).toEqual(expected);
  });

  /**
   * Compiles Begin Play -> Print of `typeId`'s `output`, with `input` wired from a node that counts
   * its reads, and runs it. `compile` are the compile options an editor Play adds.
   */
  function runCompiled(typeId: string, input: string, output: string, type: PinType, read: () => unknown,
    properties: Record<string, unknown> = {}, compile: { instrumentInfiniteLoops?: boolean } = {}) {
    const registry = createDefaultNodeRegistry();
    registry.register({
      id: "test.read", title: "Read", category: "test", pure: true,
      pins: () => [pin("out", "Out", "out", type)], codegen: () => ({ out: "ctx.read()" }),
    });
    const node = (id: string, nodeType: string, nodeProperties: Record<string, unknown> = {}): GraphNode => ({
      id, typeId: nodeType, position: { x: 0, y: 0 }, pins: registry.get(nodeType)!.pins(nodeProperties), properties: nodeProperties,
    });
    const op = node("op", typeId, properties);
    const exec = op.pins.some((entry) => entry.kind === "exec");
    const edge = (id: string, sourceNodeId: string, sourcePinId: string, targetNodeId: string, targetPinId: string) =>
      ({ id, sourceNodeId, sourcePinId, targetNodeId, targetPinId });
    const graph: LogicGraph = {
      id: "g", kind: "event",
      nodes: [node("begin", "flow.event.beginPlay"), node("read", "test.read"), op, node("log", "debug.log")],
      edges: [
        ...(exec
          ? [edge("e1", "begin", "execOut", "op", "execIn"), edge("e2", "op", "execOut", "log", "execIn")]
          : [edge("e1", "begin", "execOut", "log", "execIn")]),
        edge("e3", "read", "out", "op", input),
        edge("e4", "op", output, "log", "message"),
      ],
    };
    const source = compileGraph(graph, { assetGuid: "a", registry, ...compile }).source.replace(/export\s+function\s+/g, "function ");
    let reads = 0;
    const logged: unknown[] = [];
    (new Function(`${source}\nreturn onBeginPlay;`)() as (ctx: unknown) => void)({
      read: () => { reads += 1; return read(); },
      checkInfiniteLoop: () => {},
      formatValue: (value: unknown) => value,
      log: (_severity: string, _category: string, value: unknown) => logged.push(value),
    });
    return { reads, logged };
  }

  it("Max Of runs in an editor compile, whose loop guards need a ctx the helper does not have", () => {
    expect(runCompiled("array.maxOfFloat", "array", "value", arrayOf(FLOAT), () => [1, 5.5, 2], {}, { instrumentInfiniteLoops: true }))
      .toEqual({ reads: 1, logged: [5.5] });
  });

  it.each([
    ["math.square", "value", FLOAT, () => 3, 9],
    ["vector.nearlyEqual", "tolerance", FLOAT, () => 0.5, true],
  ] as const)("%s reads a changing %s once", (typeId, input, type, read, expected) => {
    expect(runCompiled(typeId, input, "out", type, read)).toEqual({ reads: 1, logged: [expected] });
  });

  it("Sort Array reads Descending once, not once per comparison", () => {
    expect(runCompiled("array.sort", "descending", "out", BOOL, () => true, { "default:array": [2, 9, 4, 7, 1] }))
      .toEqual({ reads: 1, logged: [[9, 7, 4, 2, 1]] });
  });
});
