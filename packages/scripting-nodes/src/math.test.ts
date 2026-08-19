import { describe, expect, it } from "vitest";
import { mathNodes } from "./math";

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
});
