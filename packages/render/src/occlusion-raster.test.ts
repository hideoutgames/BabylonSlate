import { describe, expect, it } from "vitest";
import { OcclusionBuffer } from "./occlusion-raster";

type Vec = [number, number, number];

/** Babylon's left-handed look-at view times its perspective projection (Matrix.m layout), in doubles. */
function viewProjection(eye: Vec, target: Vec, fov: number, aspect: number, near: number, far: number): number[] {
  const z = normalize(sub(target, eye));
  const x = normalize(cross([0, 1, 0], z));
  const y = cross(z, x);
  const view = [
    x[0], y[0], z[0], 0,
    x[1], y[1], z[1], 0,
    x[2], y[2], z[2], 0,
    -dot(x, eye), -dot(y, eye), -dot(z, eye), 1,
  ];
  const f = 1 / Math.tan(fov / 2);
  const projection = [
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, far / (far - near), 1,
    0, 0, -near * far / (far - near), 0,
  ];
  const out = new Array<number>(16).fill(0);
  for (let row = 0; row < 4; row++)
    for (let column = 0; column < 4; column++)
      for (let k = 0; k < 4; k++) out[row * 4 + column]! += view[row * 4 + k]! * projection[k * 4 + column]!;
  return out;
}

const sub = (a: Vec, b: Vec): Vec => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec, b: Vec): Vec => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: Vec, s: number): Vec => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: Vec, b: Vec) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec, b: Vec): Vec => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const normalize = (a: Vec): Vec => scale(a, 1 / Math.hypot(...a));

/** A seeded generator, so a failing case reproduces. */
function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Whether the segment from `eye` to `point` crosses triangle (a, b, c) strictly before `point` (Möller–Trumbore). */
function segmentHits(eye: Vec, point: Vec, a: Vec, b: Vec, c: Vec): boolean {
  const direction = sub(point, eye);
  const ab = sub(b, a), ac = sub(c, a);
  const p = cross(direction, ac);
  const determinant = dot(ab, p);
  if (Math.abs(determinant) < 1e-12) return false;
  const inverse = 1 / determinant;
  const s = sub(eye, a);
  const u = dot(s, p) * inverse;
  if (u < 0 || u > 1) return false;
  const q = cross(s, ab);
  const v = dot(direction, q) * inverse;
  if (v < 0 || u + v > 1) return false;
  const t = dot(ac, q) * inverse;
  return t > 0 && t < 1;
}

/** Points over a box's surface: a grid on each face, corners and edges included. */
function boxSamples(min: Vec, max: Vec, steps = 6): Vec[] {
  const points: Vec[] = [];
  for (let axis = 0; axis < 3; axis++) {
    for (const side of [min[axis]!, max[axis]!]) {
      for (let i = 0; i <= steps; i++) {
        for (let j = 0; j <= steps; j++) {
          const point: Vec = [0, 0, 0];
          const [u, v] = [(axis + 1) % 3, (axis + 2) % 3];
          point[axis] = side;
          point[u] = min[u]! + (max[u]! - min[u]!) * (i / steps);
          point[v] = min[v]! + (max[v]! - min[v]!) * (j / steps);
          points.push(point);
        }
      }
    }
  }
  return points;
}

/** A box's twelve triangles. */
function boxTriangles(min: Vec, max: Vec): { positions: number[]; indices: number[] } {
  const positions: number[] = [];
  for (let corner = 0; corner < 8; corner++)
    positions.push(corner & 1 ? max[0] : min[0], corner & 2 ? max[1] : min[1], corner & 4 ? max[2] : min[2]);
  const faces = [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]];
  const indices = faces.flatMap(([a, b, c, d]) => [a!, b!, c!, a!, c!, d!]);
  return { positions, indices };
}

function triangleList(positions: number[], indices: number[]): [Vec, Vec, Vec][] {
  const at = (index: number): Vec => [positions[index * 3]!, positions[index * 3 + 1]!, positions[index * 3 + 2]!];
  const triangles: [Vec, Vec, Vec][] = [];
  for (let corner = 0; corner < indices.length; corner += 3)
    triangles.push([at(indices[corner]!), at(indices[corner + 1]!), at(indices[corner + 2]!)]);
  return triangles;
}

const FOV = 1, ASPECT = 2, NEAR = 0.1, FAR = 1000;

describe("OcclusionBuffer", () => {
  it.each([
    ["at the origin", [0, 0, 0] as Vec],
    // 100 km out, where a float32 matrix would be off by centimetres.
    ["far from the origin", [1e5, 20, -1e5] as Vec],
  ])("never calls a box occluded that some ray from the eye reaches, %s (fuzz)", (_, origin) => {
    const next = random(origin[0] === 0 ? 1 : 2);
    const buffer = new OcclusionBuffer(128, 64);
    let occluded = 0, tested = 0;
    for (let scene = 0; scene < 150; scene++) {
      const eye = add(origin, [next() * 4 - 2, next() * 2, next() * 4 - 2]);
      const forward = normalize([next() - 0.5, (next() - 0.5) * 0.4, 1]);
      buffer.begin(viewProjection(eye, add(eye, forward), FOV, ASPECT, NEAR, FAR), NEAR);
      const triangles: [Vec, Vec, Vec][] = [];
      for (let index = 0; index < 6; index++) {
        // Boxes and walls between 1 m and 20 m ahead, some reaching behind the eye.
        const centre = add(eye, add(scale(forward, 1 + next() * 19), [next() * 16 - 8, next() * 6 - 3, next() * 16 - 8]));
        const half: Vec = next() < 0.5 ? [next() * 4, next() * 3, 0.05 + next() * 0.2] : [next() * 3, next() * 3, next() * 3];
        const { positions, indices } = boxTriangles(sub(centre, half), add(centre, half));
        buffer.rasterize(positions, indices);
        triangles.push(...triangleList(positions, indices));
      }
      buffer.finish();
      for (let box = 0; box < 80; box++) {
        const centre = add(eye, add(scale(forward, 2 + next() * 40), [next() * 30 - 15, next() * 10 - 5, next() * 30 - 15]));
        const half: Vec = [0.05 + next() * 2, 0.05 + next() * 2, 0.05 + next() * 2];
        const min = sub(centre, half), max = add(centre, half);
        tested++;
        if (!buffer.occluded(...min, ...max)) continue;
        occluded++;
        for (const point of boxSamples(min, max)) {
          const blocked = triangles.some(([a, b, c]) => segmentHits(eye, point, a, b, c));
          if (!blocked) throw new Error(`A visible point ${point.join(", ")} of box ${min.join(", ")} – ${max.join(", ")} was called occluded (scene ${scene}).`);
        }
      }
    }
    // The test is not vacuous: a fair share of boxes is culled.
    expect(occluded / tested).toBeGreaterThan(0.05);
  });

  const wall = boxTriangles([-5, -5, 5], [5, 5, 5.2]);
  const lookForward = () => viewProjection([0, 0, 0], [0, 0, 1], FOV, ASPECT, NEAR, FAR);

  it("culls a box behind a wall and keeps one beside it or in front of it", () => {
    const buffer = new OcclusionBuffer(128, 64);
    buffer.begin(lookForward(), NEAR);
    buffer.rasterize(wall.positions, wall.indices);
    buffer.finish();
    expect(buffer.occluded(-1, -1, 10, 1, 1, 12)).toBe(true);
    expect(buffer.occluded(8, -1, 10, 10, 1, 12)).toBe(false);
    expect(buffer.occluded(-1, -1, 3, 1, 1, 4)).toBe(false);
    // A box that reaches through the wall toward the eye.
    expect(buffer.occluded(-1, -1, 4.9, 1, 1, 12)).toBe(false);
  });

  it("calls everything visible before finish and after begin", () => {
    const buffer = new OcclusionBuffer(64, 32);
    expect(buffer.occluded(-1, -1, 10, 1, 1, 12)).toBe(false);
    buffer.begin(lookForward(), NEAR);
    buffer.rasterize(wall.positions, wall.indices);
    buffer.finish();
    buffer.begin(lookForward(), NEAR);
    expect(buffer.occluded(-1, -1, 10, 1, 1, 12)).toBe(false);
    buffer.finish();
    expect(buffer.occluded(-1, -1, 10, 1, 1, 12)).toBe(false);
  });

  it("calls a box with a corner at or behind the near plane visible, even inside an occluder's shadow", () => {
    const buffer = new OcclusionBuffer(128, 64);
    buffer.begin(lookForward(), NEAR);
    buffer.rasterize(wall.positions, wall.indices);
    buffer.finish();
    expect(buffer.occluded(-1, -1, -2, 1, 1, 12)).toBe(false);
    expect(buffer.occluded(-1, -1, 0.05, 1, 1, 12)).toBe(false);
    // Wholly behind the camera.
    expect(buffer.occluded(-1, -1, -12, 1, 1, -10)).toBe(false);
  });

  it("clips occluders crossing the near plane and still uses what lies in front", () => {
    const buffer = new OcclusionBuffer(128, 64);
    buffer.begin(lookForward(), NEAR);
    // A floor-to-ceiling slab from behind the camera to 6 m ahead, to the right of the view axis.
    const slab = boxTriangles([0.5, -50, -10], [0.7, 50, 6]);
    buffer.rasterize(slab.positions, slab.indices);
    buffer.finish();
    // Behind the slab, far right of the view: hidden. Left of it: seen.
    expect(buffer.occluded(3, -1, 8, 4, 1, 9)).toBe(true);
    expect(buffer.occluded(-4, -1, 8, -3, 1, 9)).toBe(false);
    // Nothing behind the camera occludes.
    const behind = boxTriangles([-50, -50, -3], [50, 50, -2]);
    buffer.begin(lookForward(), NEAR);
    buffer.rasterize(behind.positions, behind.indices);
    buffer.finish();
    expect(buffer.occluded(-1, -1, 10, 1, 1, 12)).toBe(false);
  });

  it("never lets a receding occluder hide what stands in front of its far part", () => {
    const buffer = new OcclusionBuffer(128, 64);
    buffer.begin(lookForward(), NEAR);
    // A floor 1 m below the eye from 2 m to 100 m ahead: it covers the lower half of the view, 2 m to 100 m deep.
    const floor = boxTriangles([-100, -1.1, 2], [100, -1, 100]);
    buffer.rasterize(floor.positions, floor.indices);
    buffer.finish();
    // A crate on it 6 m ahead covers floor from about 7 m away on screen, yet is in front of it.
    expect(buffer.occluded(-0.2, -0.9, 6, 0.2, -0.8, 6.5)).toBe(false);
  });

  it("does not hide what shows through a gap between two occluders narrower than a texel", () => {
    const buffer = new OcclusionBuffer(128, 64);
    buffer.begin(lookForward(), NEAR);
    // Two walls 5 m ahead with a 1 cm slit between them at x = 0, far under a texel (about 9 cm there).
    for (const [from, to] of [[-5, -0.005], [0.005, 5]] as const) {
      const wall = boxTriangles([from, -5, 5], [to, 5, 5.2]);
      buffer.rasterize(wall.positions, wall.indices);
    }
    buffer.finish();
    expect(buffer.occluded(-1, -1, 10, 1, 1, 12)).toBe(false);
    expect(buffer.occluded(-3, -1, 10, -2, 1, 12)).toBe(true);
  });

  it("calls a box reaching past the buffer's edge visible", () => {
    const buffer = new OcclusionBuffer(128, 64);
    buffer.begin(lookForward(), NEAR);
    const huge = boxTriangles([-500, -500, 5], [500, 500, 5.2]);
    buffer.rasterize(huge.positions, huge.indices);
    buffer.finish();
    expect(buffer.occluded(-1, -1, 10, 1, 1, 12)).toBe(true);
    expect(buffer.occluded(-1, -1, 10, 100, 1, 12)).toBe(false);
  });

  it("skips triangles of the culled winding", () => {
    const triangle = [-5, -5, 5, 0, 5, 5, 5, -5, 5];
    const hidden = [-0.5, -0.5, 10, 0.5, 0.5, 11] as const;
    const results = (["clockwise", "counterClockwise", "both"] as const).map((winding) => {
      const buffer = new OcclusionBuffer(128, 64);
      buffer.begin(lookForward(), NEAR);
      buffer.rasterize(triangle, undefined, undefined, winding);
      buffer.finish();
      return buffer.occluded(...hidden);
    });
    expect(results.filter(Boolean)).toHaveLength(2);
    expect(results[2]).toBe(true);
  });

  it("places occluders with a world transform", () => {
    const buffer = new OcclusionBuffer(128, 64);
    buffer.begin(lookForward(), NEAR);
    const unit = boxTriangles([-1, -1, -0.1], [1, 1, 0.1]);
    // Scale 5 and move 5 m ahead.
    buffer.rasterize(unit.positions, unit.indices, [5, 0, 0, 0, 0, 5, 0, 0, 0, 0, 1, 0, 0, 0, 5, 1]);
    buffer.finish();
    expect(buffer.occluded(-1, -1, 10, 1, 1, 12)).toBe(true);
    expect(buffer.occluded(-1, -1, 4, 1, 1, 12)).toBe(false);
  });
});
