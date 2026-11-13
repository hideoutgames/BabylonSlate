import { describe, expect, it } from "vitest";
import {
  blendSpaceAxisDelta,
  blendSpaceAxisValue,
  blendSpaceTriangles,
  blendSpaceWeights,
  delaunayTriangles,
  type BlendSpaceLayout,
} from "./blend-space";

const speed = { min: 0, max: 6, wrap: false };
const direction = { min: -180, max: 180, wrap: true };

function rounded(weights: number[]): number[] {
  return weights.map((weight) => Math.round(weight * 1000) / 1000);
}

describe("blendSpaceAxisValue", () => {
  it.each([
    [speed, 3, 3],
    [speed, -2, 0],
    [speed, 9, 6],
    [direction, 190, -170],
    [direction, -190, 170],
    [direction, 180, 180],
    [direction, -180, -180],
    [direction, 540, 180],
  ])("maps %o input %d to %d", (axis, input, expected) => {
    expect(blendSpaceAxisValue(axis, input)).toBeCloseTo(expected, 9);
  });

  it("reads a non-finite input or an empty range as the axis minimum", () => {
    expect(blendSpaceAxisValue(speed, Number.NaN)).toBe(0);
    expect(blendSpaceAxisValue({ min: 2, max: 2, wrap: false }, 5)).toBe(2);
  });
});

describe("blendSpaceAxisDelta", () => {
  it("goes the short way round a wrapping axis", () => {
    expect(blendSpaceAxisDelta(direction, 170, -170)).toBeCloseTo(20, 9);
    expect(blendSpaceAxisDelta(direction, -170, 170)).toBeCloseTo(-20, 9);
    expect(blendSpaceAxisDelta(speed, 1, 5)).toBe(4);
  });
});

describe("blendSpaceWeights on one axis", () => {
  const walkRun: BlendSpaceLayout = {
    axes: [speed],
    samples: [{ x: 0, y: 0 }, { x: 6, y: 0 }, { x: 2, y: 0 }],
  };

  it.each([
    [0, [1, 0, 0]],
    [1, [0.5, 0, 0.5]],
    [2, [0, 0, 1]],
    [5, [0, 0.75, 0.25]],
    [-3, [1, 0, 0]],
    [8, [0, 1, 0]],
  ])("speed %d weighs Idle, Run, Walk as %o", (x, expected) => {
    expect(rounded(blendSpaceWeights(walkRun, { x, y: 0 }))).toEqual(expected);
  });

  it("gives no weights without samples, and the whole weight to a lone sample", () => {
    expect(blendSpaceWeights({ axes: [speed], samples: [] }, { x: 1, y: 0 })).toEqual([]);
    expect(blendSpaceWeights({ axes: [speed], samples: [{ x: 3, y: 0 }] }, { x: 1, y: 0 })).toEqual([1]);
  });
});

describe("blendSpaceWeights on two axes", () => {
  // A square: Idle at the origin corner, Walk, Strafe and Run at the others.
  const square: BlendSpaceLayout = {
    axes: [{ min: 0, max: 4, wrap: false }, { min: 0, max: 4, wrap: false }],
    samples: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 0, y: 4 }, { x: 4, y: 4 }],
  };

  it("plays a sample alone on its own position", () => {
    for (let index = 0; index < square.samples.length; index++) {
      const weights = blendSpaceWeights(square, square.samples[index]!);
      expect(rounded(weights)).toEqual(square.samples.map((_, other) => (other === index ? 1 : 0)));
    }
  });

  it("splits an edge midpoint between its two samples", () => {
    expect(rounded(blendSpaceWeights(square, { x: 2, y: 0 }))).toEqual([0.5, 0.5, 0, 0]);
    expect(rounded(blendSpaceWeights(square, { x: 0, y: 1 }))).toEqual([0.75, 0, 0.25, 0]);
  });

  it("weighs a point inside a triangle by its barycentric coordinates, summing to 1", () => {
    const weights = blendSpaceWeights(square, { x: 1, y: 1 });
    expect(weights.reduce((sum, weight) => sum + weight, 0)).toBeCloseTo(1, 9);
    // Whichever diagonal the square splits on, (1, 1) sits in a triangle with Idle at weight 0.5.
    expect(weights[0]).toBeCloseTo(0.5, 9);
  });

  it("clamps a point outside the axes onto the nearest edge", () => {
    expect(rounded(blendSpaceWeights(square, { x: 2, y: -10 }))).toEqual([0.5, 0.5, 0, 0]);
  });

  it("projects a point outside the samples' hull onto its nearest edge", () => {
    const triangle: BlendSpaceLayout = {
      axes: [{ min: 0, max: 4, wrap: false }, { min: 0, max: 4, wrap: false }],
      samples: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 0, y: 4 }],
    };
    // (4, 4) is off the hypotenuse; its nearest point there is (2, 2), between the two far corners.
    expect(rounded(blendSpaceWeights(triangle, { x: 4, y: 4 }))).toEqual([0, 0.5, 0.5]);
  });

  it("wraps an angle axis so -190° reads as 170°", () => {
    const directions: BlendSpaceLayout = {
      axes: [{ min: 0, max: 6, wrap: false }, direction],
      samples: [{ x: 0, y: -180 }, { x: 0, y: 180 }, { x: 6, y: -180 }, { x: 6, y: 180 }, { x: 0, y: 0 }, { x: 6, y: 0 }],
    };
    const wrapped = blendSpaceWeights(directions, { x: 3, y: -190 });
    const direct = blendSpaceWeights(directions, { x: 3, y: 170 });
    expect(rounded(wrapped)).toEqual(rounded(direct));
  });

  it("interpolates along the line when every sample is collinear", () => {
    const line: BlendSpaceLayout = {
      axes: [{ min: 0, max: 4, wrap: false }, { min: 0, max: 4, wrap: false }],
      samples: [{ x: 0, y: 0 }, { x: 2, y: 2 }, { x: 4, y: 4 }],
    };
    expect(blendSpaceTriangles(line)).toEqual([]);
    expect(rounded(blendSpaceWeights(line, { x: 3, y: 3 }))).toEqual([0, 0.5, 0.5]);
  });
});

describe("delaunayTriangles", () => {
  it("triangulates a square into two triangles that use all four corners", () => {
    const triangles = delaunayTriangles([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }]);
    expect(triangles).toHaveLength(2);
    expect(new Set(triangles.flat())).toEqual(new Set([0, 1, 2, 3]));
  });

  it("covers a grid of nine points with eight triangles and no overlaps", () => {
    const points = [0, 1, 2].flatMap((y) => [0, 1, 2].map((x) => ({ x, y })));
    const triangles = delaunayTriangles(points);
    expect(triangles).toHaveLength(8);
    const area = triangles.reduce((sum, [a, b, c]) => {
      const pa = points[a]!;
      const pb = points[b]!;
      const pc = points[c]!;
      return sum + Math.abs((pb.x - pa.x) * (pc.y - pa.y) - (pb.y - pa.y) * (pc.x - pa.x)) / 2;
    }, 0);
    expect(area).toBeCloseTo(4, 9);
  });

  it("keeps the first of two samples on one position", () => {
    const triangles = delaunayTriangles([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }]);
    expect(triangles).toHaveLength(1);
    expect(new Set(triangles.flat())).toEqual(new Set([0, 1, 3]));
  });
});
