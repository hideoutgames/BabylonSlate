import { describe, expect, it } from "vitest";
import { normalizeScene } from "./scene";
import {
  parseSplineProperties,
  sampleSplineArcPath,
  sampleSplinePath,
  splineArcPath,
  splineCentreline,
  type SplinePoint,
} from "./spline-component";

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

describe("Spline travel by distance", () => {
  const square: SplinePoint[] = [[0, 0, 0], [10, 0, 0], [10, 0, 10], [0, 0, 10]];

  it("wraps a closed loop and clamps an open path to its ends", () => {
    const loop = splineArcPath(splineCentreline({ points: square, curvature: 0, closed: true }), true);
    expect(loop.length).toBeCloseTo(40, 10);
    expect(sampleSplineArcPath(loop, 45).position).toEqual(sampleSplineArcPath(loop, 5).position);
    expect(sampleSplineArcPath(loop, -5).position).toEqual([0, 0, 5]);
    const open = splineArcPath(splineCentreline({ points: square, curvature: 0, closed: false }), false);
    expect(open.length).toBeCloseTo(30, 10);
    expect(sampleSplineArcPath(open, 99).position).toEqual([0, 0, 10]);
    expect(sampleSplineArcPath(open, -1).position).toEqual([0, 0, 0]);
  });

  it("turns the direction smoothly through a corner instead of snapping", () => {
    const open = splineArcPath(splineCentreline({ points: square, curvature: 0, closed: false }), false);
    expect(sampleSplineArcPath(open, 1).direction[0]).toBeGreaterThan(0.9);
    const corner = sampleSplineArcPath(open, 10).direction;
    expect(corner[0]).toBeCloseTo(Math.SQRT1_2, 10);
    expect(corner[2]).toBeCloseTo(Math.SQRT1_2, 10);
    // Along a 100 m curved loop, a sampled direction that snapped at each of its 128 vertices would jump
    // about 2.8°; blended tangents turn well under 1° per quarter metre.
    const large = square.map(([x, y, z]): SplinePoint => [x * 10, y, z * 10]);
    const curved = splineArcPath(sampleSplinePath({ points: large, curvature: 1, closed: true }, { subdivisions: 32 })
      .map((sample) => sample.position), true);
    let previous = sampleSplineArcPath(curved, 0).direction;
    for (let distance = 0.25; distance <= curved.length + 1; distance += 0.25) {
      const direction = sampleSplineArcPath(curved, distance).direction;
      const dot = direction[0] * previous[0] + direction[1] * previous[1] + direction[2] * previous[2];
      expect(dot).toBeGreaterThan(Math.cos(Math.PI / 180));
      previous = direction;
    }
  });

  it("drops repeated points and reports a still direction for a path with no length", () => {
    const point = splineArcPath([[1, 2, 3], [1, 2, 3]], false);
    expect(point.length).toBe(0);
    expect(sampleSplineArcPath(point, 4)).toEqual({ position: [1, 2, 3], direction: [0, 0, 0] });
  });
});
