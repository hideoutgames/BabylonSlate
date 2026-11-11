import { describe, expect, it } from "vitest";
import type { CodegenContext } from "@haptic/scripting";
import { createDefaultNodeRegistry } from "./index";

const registry = createDefaultNodeRegistry();

/** Runs one pure node's generated code with literal inputs (an omitted one takes its pin default) and returns `out`. */
function evaluate(id: string, inputs: Record<string, unknown>, output = "out"): unknown {
  const def = registry.get(id)!;
  const pins = def.pins({});
  const hoisted = new Set<string>();
  const ctx = {
    graph: { id: "g", kind: "event", nodes: [], edges: [] },
    node: { id: "n", typeId: id, position: { x: 0, y: 0 }, pins, properties: {} },
    indent: "",
    input: (pinId: string) => `(${JSON.stringify(pinId in inputs ? inputs[pinId] : pins.find((pin) => pin.id === pinId)?.defaultValue)})`,
    isWired: () => true,
    output: (pinId: string) => `out_${pinId}`,
    emit: () => { throw new Error(`${id} is not a pure node`); },
    hoist: (line: string) => hoisted.add(line),
    requestAsync: () => {},
  } as unknown as CodegenContext;
  const pure = def.codegen(ctx) as Record<string, string>;
  return new Function([...hoisted, `return ${pure[output]};`].join("\n"))();
}

describe("math nodes outside their domain", () => {
  it.each([
    ["math.div", { a: 6, b: 3 }, 2],
    ["math.div", { a: 6, b: 0 }, 0],
    ["math.div", { a: 0, b: 0 }, 0],
    ["math.mod", { a: 7, b: 4 }, 3],
    ["math.mod", { a: -7, b: 4 }, -3],
    ["math.mod", { a: 7, b: 0 }, 0],
    ["math.div_int", { a: 7, b: 0 }, 0],
    ["math.mod_int", { a: 7, b: 0 }, 0],
    ["math.sqrt", { in: 9 }, 3],
    ["math.sqrt", { in: -9 }, 0],
    ["math.power", { base: 2, exp: 10 }, 1024],
    ["math.power", { base: -8, exp: 1 / 3 }, 0],
    ["math.power", { base: 0, exp: -1 }, 0],
    ["math.ln", { value: -1 }, 0],
    // A dot product a rounding error past 1 reads as 1.
    ["math.acos", { in: 1.0000001 }, 0],
    ["math.asinDegrees", { in: -2 }, -90],
  ])("%s of %o is %s, never NaN or Infinity", (id, inputs, expected) => {
    expect(evaluate(id, inputs)).toBeCloseTo(expected, 9);
  });

  it.each([
    ["vector.div2", { a: { x: 6, y: 4 }, b: { x: 3, y: 0 } }, { x: 2, y: 0 }],
    ["vector.div3", { a: { x: 6, y: 4, z: 1 }, b: { x: 0, y: 2, z: 0 } }, { x: 0, y: 2, z: 0 }],
    ["vector.div4", { a: { x: 6, y: 4, z: 1, w: 8 }, b: { x: 2, y: 0, z: 1, w: 4 } }, { x: 3, y: 0, z: 1, w: 2 }],
  ])("%s gives 0 for a component divided by zero", (id, inputs, expected) => {
    expect(evaluate(id, inputs)).toEqual(expected);
  });
});

describe("Nearly Equal nodes", () => {
  it.each([
    ["math.compare", 1, 1.00005, 1.0005],
    ["vector.nearlyEqual2", { x: 1, y: 2 }, { x: 1.00005, y: 2 }, { x: 1.0005, y: 2 }],
    ["vector.nearlyEqual", { x: 1, y: 2, z: 3 }, { x: 1, y: 2, z: 3.00005 }, { x: 1, y: 2, z: 3.0005 }],
    ["vector.nearlyEqual4", { x: 1, y: 2, z: 3, w: 4 }, { x: 1, y: 2, z: 3, w: 4.00005 }, { x: 1, y: 2, z: 3, w: 4.0005 }],
    ["color.nearlyEqual", { x: 1, y: 0, z: 0, w: 1 }, { x: 1, y: 0.00005, z: 0, w: 1 }, { x: 1, y: 0.0005, z: 0, w: 1 }],
    ["rotator.nearlyEqual", { pitch: 0, yaw: 10, roll: 0 }, { pitch: 0, yaw: 10.00005, roll: 0 }, { pitch: 0, yaw: 10.0005, roll: 0 }],
  ])("%s has a Tolerance pin defaulting to 0.0001 and compares by it", (id, a, near, far) => {
    expect(registry.get(id)!.pins({}).find((pin) => pin.id === "tolerance")?.defaultValue).toBe(0.0001);
    expect(evaluate(id, { a, b: near })).toBe(true);
    expect(evaluate(id, { a, b: far })).toBe(false);
    expect(evaluate(id, { a, b: far, tolerance: 0.001 })).toBe(true);
  });
});

describe("sibling nodes every number and vector type has", () => {
  it.each([
    ["math.abs_int", { value: -4 }, 4],
    ["math.min_int", { a: 3, b: -2 }, -2],
    ["math.max_int", { a: 3, b: -2 }, 3],
    ["math.clamp_int", { value: 9, min: 2, max: 5 }, 5],
    ["math.clamp_int", { value: -9, min: 2, max: 5 }, 2],
    ["math.clamp_int", { value: 7 }, 1],
    ["math.sign_int", { value: -12 }, -1],
    ["math.sign_int", { value: 0 }, 0],
    ["vector.negate2", { vector: { x: 1, y: -2 } }, { x: -1, y: 2 }],
    ["vector.negate4", { vector: { x: 1, y: -2, z: 3, w: -4 } }, { x: -1, y: 2, z: -3, w: 4 }],
    // Half of the remaining distance with Delta Time 0.5 and the default Interp Speed 1.
    ["vector.interpTo2", { current: { x: 0, y: 0 }, target: { x: 4, y: 8 }, deltaTime: 0.5 }, { x: 2, y: 4 }],
    ["vector.interpTo4", { current: { x: 0, y: 0, z: 0, w: 0 }, target: { x: 4, y: 8, z: 2, w: 6 }, deltaTime: 0.5 }, { x: 2, y: 4, z: 1, w: 3 }],
    // Interp Speed 0 jumps to Target.
    ["vector.interpTo2", { current: { x: 0, y: 0 }, target: { x: 4, y: 8 }, deltaTime: 0.5, interpSpeed: 0 }, { x: 4, y: 8 }],
  ])("%s of %o is %o", (id, inputs, expected) => {
    expect(evaluate(id, inputs)).toEqual(expected);
  });

  it("sorts a copy as a pure node, ascending or descending", () => {
    const array = [3, 1, 2];
    expect(evaluate("array.sort", { array })).toEqual([1, 2, 3]);
    expect(evaluate("array.sort", { array, descending: true })).toEqual([3, 2, 1]);
    expect(array).toEqual([3, 1, 2]);
  });
});
