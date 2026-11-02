import { describe, expect, it } from "vitest";
import {
  clampToRange,
  curveKeyAxes,
  curveKeyTangent,
  curveTimeRange,
  evaluateCurve,
  evaluateCurveAnyOrder,
  floatCurveValueRange,
  isInRange,
  lerpFloatRange,
  mapFloatRange,
  normalizeCurve,
  normalizeRange,
  randomInRange,
  type CurveExtrapolation,
} from "./curves";
import type { Rng } from "./math-rng";

function key(Time: number, Value: unknown, Interpolation = "linear", ArriveTangent: unknown = 0, LeaveTangent: unknown = 0) {
  return { Time, Value, Interpolation, ArriveTangent, LeaveTangent };
}

function floatCurve(keys: unknown[], Before: CurveExtrapolation = "constant", After: CurveExtrapolation = "constant") {
  return { Keys: keys, Before, After };
}

function sequence(values: number[]): Rng {
  let index = 0;
  const next = () => values[index++ % values.length]!;
  return { next, nextFloat: next };
}

describe("curve interpolation", () => {
  it.each([
    ["constant", 0.99, 0],
    ["linear", 0.25, 2.5],
    ["quadIn", 0.5, 2.5],
    ["cubicOut", 0.5, 8.75],
  ])("follows the start key's %s interpolation", (interpolation, time, expected) => {
    const curve = floatCurve([key(0, 0, interpolation), key(1, 10)]);
    expect(evaluateCurve("float", curve, time)).toBeCloseTo(expected, 6);
  });

  it("reaches the next key's value exactly at its time", () => {
    expect(evaluateCurve("float", floatCurve([key(0, 0, "constant"), key(1, 10)]), 1)).toBe(10);
  });

  it("uses Custom tangents as slopes per second", () => {
    expect(evaluateCurve("float", floatCurve([key(0, 0, "custom"), key(1, 1, "custom")]), 0.25)).toBeCloseTo(0.15625, 6);
    expect(evaluateCurve("float", floatCurve([key(0, 0, "custom", 0, 2), key(1, 1, "custom")]), 0.5)).toBeCloseTo(0.75, 6);
    // Twice the duration halves the tangent's effect per unit of normalised time.
    expect(evaluateCurve("float", floatCurve([key(0, 0, "custom", 0, 1), key(2, 1, "custom")]), 1)).toBeCloseTo(0.75, 6);
  });

  it("gives Auto keys neighbour slopes, flat peaks and one-sided end slopes", () => {
    const peak = floatCurve([key(0, 0, "auto"), key(1, 10, "auto"), key(2, 0, "auto")]);
    // Start tangent 10, peak tangent 0: 0.125 * 10 + 0.5 * 10.
    expect(evaluateCurve("float", peak, 0.5)).toBeCloseTo(6.25, 6);
    expect(evaluateCurve("float", peak, 1.5)).toBeCloseTo(6.25, 6);
    // Two Auto keys form a straight line.
    expect(evaluateCurve("float", floatCurve([key(0, 0, "auto"), key(1, 10, "auto")]), 0.25)).toBeCloseTo(2.5, 6);
    // Monotonic keys: the middle tangent is (5 - 0) / 3.
    const rising = floatCurve([key(0, 0, "auto"), key(1, 1, "auto"), key(3, 5, "auto")]);
    expect(evaluateCurve("float", rising, 2)).toBeCloseTo(0.5 * 1 + 0.125 * (5 / 3) * 2 + 0.5 * 5 - 0.125 * 2 * 2, 6);
  });

  it("reports each key's tangent as evaluation uses it", () => {
    const curve = floatCurve([key(0, 0, "auto"), key(1, 10, "linear"), key(2, 0, "custom", -3, 4), key(4, 6, "auto")]);
    // Auto at the start: the slope of its only segment.
    expect(curveKeyTangent("float", curve, 0, 0, "leave")).toBe(10);
    // Linear keys still get the automatic tangent; a peak is flat.
    expect(curveKeyTangent("float", curve, 1, 0, "arrive")).toBe(0);
    // Custom keys keep their own arrive and leave tangents.
    expect(curveKeyTangent("float", curve, 2, 0, "arrive")).toBe(-3);
    expect(curveKeyTangent("float", curve, 2, 0, "leave")).toBe(4);
    expect(curveKeyTangent("float", curve, 9, 0, "leave")).toBe(0);
    const vector = floatCurve([key(0, { x: 0, y: 0, z: 0 }, "auto"), key(2, { x: 2, y: 4, z: -6 }, "auto")]);
    expect([0, 1, 2].map((c) => curveKeyTangent("vec3", vector, 1, c, "arrive"))).toEqual([1, 2, -3]);
  });

  it("evaluates every channel of a Vector and a Color curve with the key's interpolation", () => {
    const vector = floatCurve([key(0, { x: 0, y: 0, z: 0 }), key(1, { x: 2, y: 4, z: 6 })]);
    expect(evaluateCurve("vec3", vector, 0.5)).toEqual({ x: 1, y: 2, z: 3 });
    const color = floatCurve([key(0, { x: 1, y: 0, z: 0, w: 1 }, "constant"), key(1, { x: 0, y: 0, z: 1, w: 0 })]);
    expect(evaluateCurve("color", color, 0.5)).toEqual({ x: 1, y: 0, z: 0, w: 1 });
    expect(evaluateCurve("color", color, 2)).toEqual({ x: 0, y: 0, z: 1, w: 0 });
  });

  it("is zero without keys and constant with one key", () => {
    expect(evaluateCurve("float", floatCurve([]), 3)).toBe(0);
    expect(evaluateCurve("vec3", floatCurve([]), 3)).toEqual({ x: 0, y: 0, z: 0 });
    expect(evaluateCurve("float", floatCurve([key(2, 7)], "linear", "linear"), -5)).toBe(7);
  });
});

describe("Vector keys that set only some axes", () => {
  const v = (x: number, y: number, z: number) => ({ x, y, z });
  const axes = (Axes: number, Time: number, Value: unknown, Interpolation = "linear") => ({ ...key(Time, Value, Interpolation), Axes });

  it("evaluates each axis from the keys that set it", () => {
    const curve = floatCurve([key(0, v(0, 0, 0)), axes(1, 1, v(10, 99, 99)), key(2, v(0, 20, 4))]);
    // X has a key at 1 s; Y and Z run straight from 0 s to 2 s past it.
    expect(evaluateCurve("vec3", curve, 1)).toEqual({ x: 10, y: 10, z: 2 });
    expect(evaluateCurve("vec3", curve, 0.5)).toEqual({ x: 5, y: 5, z: 1 });
    // Keys that set every axis evaluate as before.
    expect(curveKeyAxes("vec3", curve.Keys[0])).toBe(7);
    expect(curveKeyAxes("vec3", curve.Keys[1])).toBe(1);
    expect(curveKeyAxes("float", { Axes: 1 })).toBe(1);
    expect(curveKeyAxes("color", { Axes: 1 })).toBe(15);
  });

  it("holds an axis outside its own keys and extrapolates over the whole curve's time range", () => {
    const keys = [key(0, v(0, 0, 0)), key(1, v(5, 7, 1)), axes(1, 3, v(10, 0, 0))];
    const held = floatCurve(keys);
    // Only X reaches 3 s: Y and Z hold their last values.
    expect(evaluateCurve("vec3", held, 2)).toEqual({ x: 7.5, y: 7, z: 1 });
    // Cycle repeats the whole 3 s for every axis: 3.5 s plays as 0.5 s.
    expect(evaluateCurve("vec3", floatCurve(keys, "constant", "cycle"), 3.5)).toEqual({ x: 2.5, y: 3.5, z: 0.5 });
    // Linear continues X's end slope (2.5 per second); Y and Z ended earlier and stay flat.
    expect(evaluateCurve("vec3", floatCurve(keys, "constant", "linear"), 4)).toEqual({ x: 12.5, y: 7, z: 1 });
  });

  it("finds each axis's tangent among the keys that set it", () => {
    const curve = floatCurve([key(0, v(0, 0, 0), "auto"), axes(1, 1, v(4, 0, 0), "auto"), key(2, v(10, 10, 10), "auto")]);
    // X's middle key sits between 0 and 10 over 2 s; it sets no Y.
    expect(curveKeyTangent("vec3", curve, 1, 0, "leave")).toBe(5);
    expect(curveKeyTangent("vec3", curve, 1, 1, "leave")).toBe(0);
    // Y's first key has only its end key as a neighbour.
    expect(curveKeyTangent("vec3", curve, 0, 1, "leave")).toBe(5);
  });

  it("writes Axes on every Vector key when normalising, letting keys of other axes share a time", () => {
    const shared = normalizeCurve("vec3", floatCurve([axes(1, 1, v(1, 0, 0)), axes(6, 1, v(0, 2, 3)), key(2, v(1, 1, 1))]));
    expect(shared.Keys.map((entry) => [entry.Time, entry.Axes])).toEqual([[1, 1], [1, 6], [2, 7]]);
    // Keys that set a common axis are still pushed apart.
    const overlapping = normalizeCurve("vec3", floatCurve([axes(1, 1, v(1, 0, 0)), axes(3, 1, v(0, 2, 3))]));
    expect(overlapping.Keys.map((entry) => entry.Time)).toEqual([1, 1.001]);
    // A key that sets no axis is dropped; Float and Color keys carry no Axes.
    expect(normalizeCurve("vec3", floatCurve([axes(0, 0, v(1, 1, 1)), axes(2, 1, v(1, 1, 1))])).Keys.map((entry) => entry.Axes)).toEqual([2]);
    expect(normalizeCurve("float", floatCurve([key(0, 1)])).Keys[0]).not.toHaveProperty("Axes");
  });
});

describe("curve extrapolation", () => {
  const ramp = (mode: CurveExtrapolation) => floatCurve([key(0, 0), key(2, 10)], mode, mode);

  it.each([
    ["constant", -1, 0],
    ["constant", 3, 10],
    ["linear", -1, -5],
    ["linear", 3, 15],
    ["cycle", 2.5, 2.5],
    ["cycle", 3.5, 7.5],
    ["cycle", -0.5, 7.5],
    ["oscillate", 3.5, 2.5],
    ["oscillate", 4.5, 2.5],
    ["oscillate", -0.5, 2.5],
  ] as const)("%s at time %s", (mode, time, expected) => {
    expect(evaluateCurve("float", ramp(mode), time)).toBeCloseTo(expected, 6);
  });

  it("continues a Custom end key's tangent and holds a Constant segment's value", () => {
    expect(evaluateCurve("float", floatCurve([key(0, 1, "custom", 0, 3), key(1, 2, "custom")], "linear"), -1)).toBeCloseTo(-2, 6);
    expect(evaluateCurve("float", floatCurve([key(0, 1, "constant"), key(1, 2)], "constant", "linear"), 5)).toBe(2);
  });
});

describe("curve normalisation", () => {
  it("sorts keys, keeps a minimum gap and resolves unknown names", () => {
    const curve = normalizeCurve("float", {
      Keys: [key(2, 10, "bogus"), key(1, 5), key(1, 6)],
      Before: "sideways",
      After: 3,
    });
    expect(curve.Keys.map((entry) => [entry.Time, entry.Value, entry.Interpolation])).toEqual([
      [1, 5, "linear"], [1.001, 6, "linear"], [2, 10, "auto"],
    ]);
    expect([curve.Before, curve.After]).toEqual(["constant", "oscillate"]);
  });

  it("evaluates keys built out of order", () => {
    expect(evaluateCurveAnyOrder("float", floatCurve([key(2, 10), key(0, 0)]), 1)).toBeCloseTo(5, 6);
  });

  it("reports time and value ranges from the keys", () => {
    const curve = floatCurve([key(-1, 4), key(0.5, -2), key(3, 1)]);
    expect(curveTimeRange(curve)).toEqual({ Min: -1, Max: 3 });
    expect(floatCurveValueRange(curve)).toEqual({ Min: -2, Max: 4 });
    expect(curveTimeRange(floatCurve([]))).toEqual({ Min: 0, Max: 0 });
  });
});

describe("ranges", () => {
  it("swaps crossing ends on every axis", () => {
    expect(normalizeRange("float", { Min: 5, Max: 2 })).toEqual({ Min: 2, Max: 5 });
    expect(normalizeRange("int", { Min: 2.7, Max: -1.2 })).toEqual({ Min: -1, Max: 2 });
    expect(normalizeRange("vec3", { Min: { x: 1, y: 5, z: 0 }, Max: { x: 2, y: 3, z: 0 } })).toEqual({
      Min: { x: 1, y: 3, z: 0 }, Max: { x: 2, y: 5, z: 0 },
    });
    expect(normalizeRange("rotator", { Min: { pitch: 10, yaw: 0, roll: 0 }, Max: { pitch: -10, yaw: 45, roll: 0 } })).toEqual({
      Min: { pitch: -10, yaw: 0, roll: 0 }, Max: { pitch: 10, yaw: 45, roll: 0 },
    });
  });

  it("draws integers with both ends included and floats from Min up to Max", () => {
    const ints = sequence([0, 1, 2, 3]);
    expect([0, 1, 2, 3].map(() => randomInRange("int", { Min: 5, Max: 3 }, ints))).toEqual([3, 4, 5, 3]);
    expect(randomInRange("float", { Min: 2, Max: 4 }, sequence([0.5]))).toBe(3);
    expect(randomInRange("vec2", { Min: { x: 0, y: 10 }, Max: { x: 1, y: 20 } }, sequence([0.25, 0.75]))).toEqual({ x: 0.25, y: 17.5 });
    expect(randomInRange("int", { Min: 4, Max: 4 }, sequence([7]))).toBe(4);
  });

  it("clamps, tests membership with both ends included, and maps between ranges", () => {
    expect(clampToRange("vec3", { x: -3, y: 0.5, z: 9 }, { Min: { x: 0, y: 0, z: 0 }, Max: { x: 1, y: 1, z: 1 } }))
      .toEqual({ x: 0, y: 0.5, z: 1 });
    expect(clampToRange("int", 9, { Min: 1, Max: 4 })).toBe(4);
    expect(isInRange("float", 5, { Min: 2, Max: 5 })).toBe(true);
    expect(isInRange("float", 5.0001, { Min: 2, Max: 5 })).toBe(false);
    expect(isInRange("int", 3, { Min: 5, Max: 2 })).toBe(true);
    expect(lerpFloatRange({ Min: 2, Max: 4 }, 0.5)).toBe(3);
    expect(lerpFloatRange({ Min: 2, Max: 4 }, 2)).toBe(6);
    expect(mapFloatRange(15, { Min: 0, Max: 10 }, { Min: 100, Max: 200 }, false)).toBe(250);
    expect(mapFloatRange(15, { Min: 0, Max: 10 }, { Min: 100, Max: 200 }, true)).toBe(200);
    expect(mapFloatRange(15, { Min: 3, Max: 3 }, { Min: 100, Max: 200 }, false)).toBe(100);
  });
});
