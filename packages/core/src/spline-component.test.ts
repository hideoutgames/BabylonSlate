import { describe, expect, it } from "vitest";
import { normalizeScene } from "./scene";
import { parseSplineProperties, splineCentreline, type SplinePoint } from "./spline-component";

describe("SplineComponent", () => {
  it("normalizes authored scene points and bounds malformed inputs before sampling", () => {
    const scene = normalizeScene({ actors: [{ id: "path", components: [{ id: "spline", classId: "SplineComponent", properties: {
      points: [[-200000, 2, 3], [4, 5, 200000], [NaN, 0, 0], [1, 2]], curvature: 8, closed: true,
    } }] }] });
    expect(scene.actors[0]!.components[0]!.properties).toEqual({
      points: [[-100000, 2, 3], [4, 5, 100000]], curvature: 1, closed: false,
    });
    const fallback = parseSplineProperties({ points: [[0, Infinity, 0]], curvature: NaN, closed: true });
    expect(splineCentreline(fallback)).toEqual([[0, 0, -5], [0, 0, 5]]);
    expect(fallback.closed).toBe(false);
    const bounded = parseSplineProperties({ points: Array.from({ length: 200 }, (_, index) => [index, 0, 0]), curvature: -1, closed: true });
    expect(bounded.points).toHaveLength(128);
    expect(bounded.curvature).toBe(0);
    expect(bounded.closed).toBe(true);
  });

  it("keeps straight segments exact and connects the last control point only for closed paths", () => {
    const points: SplinePoint[] = [[0, 0, 0], [0, 10, 0], [10, 10, 4]];
    expect(splineCentreline({ points, curvature: 0, closed: false })).toEqual(points);
    expect(splineCentreline({ points, curvature: 0, closed: true })).toEqual([...points, points[0]]);
  });

  it("curves through every 3D control point with the same result when the axes rotate", () => {
    const points: SplinePoint[] = [[0, 0, 0], [0, 10, 0], [10, 10, 0]];
    const line = splineCentreline({ points, curvature: 1, closed: false });
    for (const point of points) expect(line).toContainEqual(point);
    expect(line[0]).toEqual(points[0]);
    expect(line.at(-1)).toEqual(points.at(-1));
    // A smooth vertical bend bows beyond both straight chords, including in Y.
    expect(line.some(([x]) => x < -0.5)).toBe(true);
    expect(line.some(([, y]) => y > 10.5)).toBe(true);
    const rotate = ([x, y, z]: SplinePoint): SplinePoint => [z, x, y];
    const rotated = splineCentreline({ points: points.map(rotate), curvature: 1, closed: false });
    expect(rotated).toHaveLength(line.length);
    for (let index = 0; index < line.length; index++) {
      const expected = rotate(line[index]!);
      for (let axis = 0; axis < 3; axis++) expect(rotated[index]![axis]).toBeCloseTo(expected[axis]!, 10);
    }
  });

  it("curves the closing segment using its wrapped neighbors", () => {
    const points: SplinePoint[] = [[1, 0, 0], [0, 1, 0], [-1, 0, 0], [0, -1, 0]];
    const line = splineCentreline({ points, curvature: 1, closed: true });
    for (const point of points) expect(line).toContainEqual(point);
    expect(line[0]).toEqual(line.at(-1));
    // The final quadrant rounds outward instead of joining with a straight chord.
    expect(line.some(([x, y]) => x > 0.5 && y < -0.5)).toBe(true);
  });

  it("keeps repeated and collapsed control points finite", () => {
    for (const points of [
      [[0, 0, 0], [0, 0, 0], [0, 4, 0], [3, 4, 0]],
      [[3, 4, 5], [3, 4, 5], [3, 4, 5]],
    ] as SplinePoint[][]) {
      const line = splineCentreline({ points, curvature: 1, closed: true });
      expect(line.flat().every(Number.isFinite)).toBe(true);
      for (const point of points) expect(line.some((sample) => sample.every((coordinate, axis) => Math.abs(coordinate - point[axis]!) < 1e-9))).toBe(true);
    }
  });
});
