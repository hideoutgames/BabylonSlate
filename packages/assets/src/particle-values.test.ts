import { describe, expect, it } from "vitest";
import {
  PARTICLE_COLOR_SPEC,
  PARTICLE_CURVE_MIN_KEY_GAP,
  PARTICLE_VALUE_SPECS,
  convertColorValueMode,
  convertScalarValueMode,
  normalizeColorValue,
  normalizeScalarValue,
  sampleScalarCurve,
  type ParticleScalarValue,
} from "./particle-values";

const rate = PARTICLE_VALUE_SPECS["spawn.rate"];
const size = PARTICLE_VALUE_SPECS["initialize.size"];
const spin = PARTICLE_VALUE_SPECS["initialize.rotation.speed"];

describe("particle value normalization", () => {
  it("replaces garbage and modes the property does not allow with its fallback", () => {
    for (const value of [null, "fast", 12, { mode: "bogus" }, { mode: "constant" }]) {
      expect(normalizeScalarValue(value, rate)).toEqual(rate.fallback);
    }
    expect(
      normalizeScalarValue({ mode: "range", min: 1, max: 5 }, rate),
    ).toEqual(rate.fallback);
    expect(
      normalizeScalarValue({ mode: "constant", value: Number.NaN }, size),
    ).toEqual(size.fallback);
  });

  it("orders inverted ranges, clamps them, and keeps negative rotation speeds", () => {
    expect(
      normalizeScalarValue({ mode: "range", min: 3, max: -2 }, size),
    ).toEqual({ mode: "range", min: 0, max: 3 });
    expect(
      normalizeScalarValue({ mode: "range", min: 4, max: -6 }, spin),
    ).toEqual({ mode: "range", min: -6, max: 4 });
    expect(
      normalizeScalarValue({ mode: "constant", value: 1e9 }, rate),
    ).toEqual({ mode: "constant", value: rate.max });
  });

  it("sorts curve keys, pins the ends to 0 and 1, and caps them at eight", () => {
    const value = normalizeScalarValue(
      {
        mode: "curve",
        keys: [
          { t: 0.9, value: 2 },
          { t: 0.2, value: 1 },
          "junk",
          ...Array.from({ length: 10 }, (_, i) => ({ t: 0.3 + i * 0.05, value: 1 })),
        ],
      },
      size,
    );
    if (value.mode !== "curve") throw new Error("expected a curve");
    expect(value.keys).toHaveLength(8);
    expect(value.keys[0]!.t).toBe(0);
    expect(value.keys.at(-1)!.t).toBe(1);
    const ts = value.keys.map((key) => key.t);
    expect([...ts].sort((a, b) => a - b)).toEqual(ts);
  });

  it("spaces coincident keys so every sample stays finite", () => {
    const value = normalizeScalarValue(
      {
        mode: "curve",
        keys: [
          { t: 0, value: 1 },
          { t: 0, value: 4 },
          { t: 0, value: 2 },
          { t: 1, value: 0 },
        ],
      },
      size,
    );
    if (value.mode !== "curve") throw new Error("expected a curve");
    for (let i = 1; i < value.keys.length; i += 1) {
      expect(value.keys[i]!.t - value.keys[i - 1]!.t).toBeGreaterThanOrEqual(
        PARTICLE_CURVE_MIN_KEY_GAP - 1e-12,
      );
    }
    for (const key of value.keys) {
      expect(Number.isFinite(sampleScalarCurve(value.keys, key.t))).toBe(true);
    }
  });

  it("replaces a curve with fewer than two usable keys by the curve fallback", () => {
    expect(
      normalizeScalarValue(
        { mode: "curve", keys: [{ t: 0.5, value: 3 }, { t: 0.7 }] },
        size,
      ),
    ).toEqual({ mode: "curve", keys: size.curveFallback });
  });

  it("clamps colours to 0..1 and rejects malformed colours", () => {
    expect(
      normalizeColorValue(
        { mode: "range", min: [2, -1, 0.5, 1], max: [0, 0, 0, 3] },
        PARTICLE_COLOR_SPEC,
      ),
    ).toEqual({ mode: "range", min: [1, 0, 0.5, 1], max: [0, 0, 0, 1] });
    expect(
      normalizeColorValue({ mode: "constant", color: [1, 1] }, PARTICLE_COLOR_SPEC),
    ).toEqual(PARTICLE_COLOR_SPEC.fallback);
  });
});

describe("particle curve sampling", () => {
  it("interpolates between keys and holds the end values outside 0..1", () => {
    const keys = [
      { t: 0, value: 0 },
      { t: 0.5, value: 10 },
      { t: 1, value: 4 },
    ];
    expect(sampleScalarCurve(keys, 0.25)).toBeCloseTo(5);
    expect(sampleScalarCurve(keys, 0.75)).toBeCloseTo(7);
    expect(sampleScalarCurve(keys, -1)).toBe(0);
    expect(sampleScalarCurve(keys, 2)).toBe(4);
  });
});

describe("value mode switching", () => {
  it("keeps the authored number through constant → range → constant", () => {
    const constant: ParticleScalarValue = { mode: "constant", value: 0.35 };
    const range = convertScalarValueMode(constant, "range", size);
    expect(range).toEqual({ mode: "range", min: 0.35, max: 0.35 });
    expect(convertScalarValueMode(range, "constant", size)).toEqual(constant);
  });

  it("maps a range to its midpoint and a ramp, and a curve to the span of its keys", () => {
    const range: ParticleScalarValue = { mode: "range", min: 0.2, max: 0.6 };
    expect(convertScalarValueMode(range, "constant", size)).toEqual({
      mode: "constant",
      value: 0.4,
    });
    const curve = convertScalarValueMode(range, "curve", size);
    expect(curve).toEqual({
      mode: "curve",
      keys: [
        { t: 0, value: 0.2 },
        { t: 1, value: 0.6 },
      ],
    });
    expect(
      convertScalarValueMode(
        {
          mode: "curve",
          keys: [
            { t: 0, value: 1 },
            { t: 0.5, value: 3 },
            { t: 1, value: 0 },
          ],
        },
        "range",
        size,
      ),
    ).toEqual({ mode: "range", min: 0, max: 3 });
  });

  it("turns a constant into a flat curve that samples the same value everywhere", () => {
    const curve = convertScalarValueMode({ mode: "constant", value: 7 }, "curve", size);
    if (curve.mode !== "curve") throw new Error("expected a curve");
    for (const x of [0, 0.3, 1]) expect(sampleScalarCurve(curve.keys, x)).toBe(7);
  });

  it("ignores a mode the property does not allow", () => {
    const constant: ParticleScalarValue = { mode: "constant", value: 20 };
    expect(convertScalarValueMode(constant, "range", rate)).toEqual(constant);
  });

  it("switches colours channel by channel", () => {
    expect(
      convertColorValueMode(
        { mode: "range", min: [0, 0, 1, 1], max: [1, 0, 0, 0] },
        "constant",
        PARTICLE_COLOR_SPEC,
      ),
    ).toEqual({ mode: "constant", color: [0.5, 0, 0.5, 0.5] });
    expect(
      convertColorValueMode(
        {
          mode: "curve",
          keys: [
            { t: 0, color: [1, 0.5, 0, 1] },
            { t: 1, color: [0, 1, 0, 0] },
          ],
        },
        "range",
        PARTICLE_COLOR_SPEC,
      ),
    ).toEqual({ mode: "range", min: [0, 0.5, 0, 0], max: [1, 1, 0, 1] });
  });
});
