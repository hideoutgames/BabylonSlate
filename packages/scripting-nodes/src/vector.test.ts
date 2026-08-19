import { describe, expect, it } from "vitest";
import { vectorNodes } from "./vector";

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
});
