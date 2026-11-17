import { afterEach, describe, expect, it } from "vitest";
import {
  customEasingCurve, customEasingCurveClassId, customEasingCurveLabel, parseEasingCurve, sampleEasingCurve, setCustomEasingCurves,
} from "./easing";

/** 129 samples rising from 0 at Alpha 0 to 1 at Alpha 0.5 and falling back to 0 at Alpha 1. */
const TRIANGLE = Array.from({ length: 129 }, (_, index) => (index <= 64 ? index / 64 : (128 - index) / 64));

describe("engine easing", () => {
  it("uses saved numeric enum choices and falls back to Linear for unsupported values", () => {
    expect(sampleEasingCurve(parseEasingCurve(2), 0.25)).toBeCloseTo(0.4375);
    expect(sampleEasingCurve(parseEasingCurve("sineIn"), 0.5)).toBeCloseTo(0.2928932188);
    for (const invalid of [undefined, -1, 31, 1.5, "unknown"]) {
      expect(sampleEasingCurve(parseEasingCurve(invalid), 0.25)).toBe(0.25);
    }
  });

  it("clamps elapsed time while retaining Back and Elastic output overshoot", () => {
    expect(sampleEasingCurve("expoIn", -0.1)).toBe(0);
    expect(sampleEasingCurve("expoOut", 1.1)).toBe(1);
    expect(sampleEasingCurve("elasticOut", 0.15)).toBeGreaterThan(1);
    expect(sampleEasingCurve("backIn", 0.25)).toBeLessThan(0);
    expect(sampleEasingCurve("backOut", 0.75)).toBeGreaterThan(1);
  });
});

describe("custom easing curves", () => {
  afterEach(() => setCustomEasingCurves({}));

  it("samples a registered table: its own ends, linear between samples, Alpha clamped like the built-in curves", () => {
    setCustomEasingCurves({ Tri: TRIANGLE });
    expect(sampleEasingCurve("class:Tri", 0)).toBe(0);
    expect(sampleEasingCurve("class:Tri", 0.25)).toBe(0.5);
    expect(sampleEasingCurve("class:Tri", 0.5)).toBe(1);
    // The end is the table's, not 1.
    expect(sampleEasingCurve("class:Tri", 1)).toBe(0);
    // Half way between samples 1 (1/64) and 2 (2/64).
    expect(sampleEasingCurve("class:Tri", 3 / 256)).toBe(0.0234375);
    expect(sampleEasingCurve("class:Tri", 1.5)).toBe(0);
    expect(sampleEasingCurve("class:Tri", -2)).toBe(0);
    expect(sampleEasingCurve("class:Tri", Number.NaN)).toBe(0);
    setCustomEasingCurves({ Raised: TRIANGLE.map((value) => value + 0.5) });
    expect(sampleEasingCurve("class:Raised", 0)).toBe(0.5);
    expect(sampleEasingCurve("class:Raised", -1)).toBe(0.5);
    expect(sampleEasingCurve("class:Raised", 2)).toBe(0.5);
  });

  it("leaves the built-in curves and their exact ends alone while custom curves are registered", () => {
    setCustomEasingCurves({ Tri: TRIANGLE });
    expect(sampleEasingCurve("quadIn", 0.5)).toBe(0.25);
    expect(sampleEasingCurve("expoIn", 0)).toBe(0);
    expect(sampleEasingCurve("elasticOut", 1)).toBe(1);
  });

  it("samples an unregistered or dropped curve as Linear, and each registration replaces the last", () => {
    expect(sampleEasingCurve("class:Tri", 0.25)).toBe(0.25);
    expect(sampleEasingCurve("class:Tri", 1)).toBe(1);
    const nan = [...TRIANGLE]; nan[7] = Number.NaN;
    const infinite = [...TRIANGLE]; infinite[128] = Number.POSITIVE_INFINITY;
    setCustomEasingCurves({ Short: TRIANGLE.slice(1), Long: [...TRIANGLE, 0], Nan: nan, Infinite: infinite, Tri: TRIANGLE });
    for (const dropped of ["Short", "Long", "Nan", "Infinite"]) {
      expect(sampleEasingCurve(customEasingCurve(dropped), 0.25), dropped).toBe(0.25);
      expect(sampleEasingCurve(customEasingCurve(dropped), 0), dropped).toBe(0);
    }
    expect(sampleEasingCurve("class:Tri", 0.25)).toBe(0.5);
    setCustomEasingCurves({ Other: TRIANGLE });
    expect(sampleEasingCurve("class:Tri", 0.25)).toBe(0.25);
    expect(sampleEasingCurve("class:Other", 0.25)).toBe(0.5);
    // The registry keeps its own copy.
    const table = [...TRIANGLE];
    setCustomEasingCurves({ Copy: table });
    table[32] = 9;
    expect(sampleEasingCurve("class:Copy", 0.25)).toBe(0.5);
  });

  it("parses a well-formed reference whether or not it is registered, and nothing malformed", () => {
    expect(parseEasingCurve("class:Tri")).toBe("class:Tri");
    expect(parseEasingCurve("class:My Curve")).toBe("class:My Curve");
    for (const malformed of ["class:", "class: Tri", "class:Tri ", "Class:Tri", "classTri", "class:\n"]) {
      expect(parseEasingCurve(malformed), malformed).toBe("linear");
    }
    expect(customEasingCurveClassId("class:Tri")).toBe("Tri");
    expect(customEasingCurveClassId("quadIn")).toBeNull();
    expect(customEasingCurveClassId("class:")).toBeNull();
  });

  it("names a custom curve after its Class, and nothing else", () => {
    expect(customEasingCurveLabel("class:Smooth Step")).toBe("Smooth Step (Custom)");
    expect(customEasingCurveLabel("quadIn")).toBeNull();
    expect(customEasingCurveLabel("custom")).toBeNull();
    expect(customEasingCurveLabel(undefined)).toBeNull();
  });
});
