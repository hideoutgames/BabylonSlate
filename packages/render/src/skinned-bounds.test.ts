import { describe, expect, it } from "vitest";
import { posedBox, skinnedBoneBoxes } from "./skinned-bounds";

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
/** A matrix as Babylon stores one, which moves a position by `x`, `y`, `z`. */
const moved = (x: number, y: number, z: number) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
/** A quarter turn about Z: (x, y) goes to (-y, x). */
const QUARTER_TURN = [0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function box(boxes: Float32Array, bone: number): number[] {
  return Array.from(boxes.slice(bone * 6, bone * 6 + 6));
}

function posed(boxes: Float32Array, matrices: number[], margin = 0) {
  const min = { x: 77, y: 77, z: 77 }, max = { x: 77, y: 77, z: 77 };
  const found = posedBox(boxes, matrices, min, max, margin);
  return { found, min: [min.x, min.y, min.z], max: [max.x, max.y, max.z] };
}

describe("skinned bounds", () => {
  it("boxes the vertices each bone moves, and only those it moves", () => {
    const positions = [0, 0, 0, 1, 2, 3, -1, 5, 2, 9, 9, 9];
    // Vertex 0: bone 0. Vertex 1: bones 0 and 1. Vertex 2: bone 1. Vertex 3: no weight at all, its indices at bone 1.
    const joints = [0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 1, 1, 1, 1];
    const weights = [1, 0, 0, 0, 0.5, 0.5, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0];
    const boxes = skinnedBoneBoxes(positions, [joints], [weights], 3)!;
    expect(box(boxes, 0)).toEqual([0, 0, 0, 1, 2, 3]);
    expect(box(boxes, 1)).toEqual([-1, 2, 2, 1, 5, 3]);
    // A bone that moves nothing has no box: its minimum is above its maximum.
    expect(box(boxes, 2)).toEqual([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]);
  });

  it("counts the influences of an extra set", () => {
    const positions = [1, 1, 1, 4, 4, 4];
    const boxes = skinnedBoneBoxes(positions, [[0, 0, 0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 2, 0, 0]], [[1, 0, 0, 0, 0.75, 0, 0, 0], [0, 0, 0, 0, 0, 0.25, 0, 0]], 3)!;
    expect(box(boxes, 0)).toEqual([1, 1, 1, 4, 4, 4]);
    // The second vertex's fifth influence.
    expect(box(boxes, 2)).toEqual([4, 4, 4, 4, 4, 4]);
    expect(box(boxes, 1)[0]).toBe(Infinity);
  });

  it("rounds a box outwards to 32-bit floats, so it holds its 64-bit positions", () => {
    // 0.1 lies between two 32-bit floats; so does -0.1, and a value too small for any but zero.
    const boxes = skinnedBoneBoxes([0.1, -0.1, 1e-60], [[0, 0, 0, 0]], [[1, 0, 0, 0]], 1)!;
    expect(box(boxes, 0)).toEqual([
      0.09999999403953552, -0.10000000149011612, 0,
      0.10000000149011612, -0.09999999403953552, 1.401298464324817e-45,
    ]);
  });

  it("refuses an index that names no bone", () => {
    const one = [1, 0, 0, 0];
    expect(skinnedBoneBoxes([0, 0, 0], [[2, 0, 0, 0]], [one], 2)).toBeNull();
    expect(skinnedBoneBoxes([0, 0, 0], [[-1, 0, 0, 0]], [one], 2)).toBeNull();
    expect(skinnedBoneBoxes([0, 0, 0], [[0.5, 0, 0, 0]], [one], 2)).toBeNull();
    // An unweighted slot's index is never read.
    expect(skinnedBoneBoxes([0, 0, 0], [[0, 9, 0, 0]], [one], 2)).not.toBeNull();
  });

  it("joins each bone's box where its matrix puts it", () => {
    const boxes = skinnedBoneBoxes(
      [0, 0, 0, 2, 1, 0, 5, 5, 5, 6, 7, 8], [[0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]], [[1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]], 3)!;
    // As authored: both boxes where they are.
    expect(posed(boxes, [...IDENTITY, ...IDENTITY, ...IDENTITY])).toEqual({ found: true, min: [0, 0, 0], max: [6, 7, 8] });
    // The second bone carries its box (5..6, 5..7, 5..8) away by (10, -20, 0).
    expect(posed(boxes, [...IDENTITY, ...moved(10, -20, 0), ...IDENTITY])).toEqual({ found: true, min: [0, -15, 0], max: [16, 1, 8] });
    // The first bone turns its box (0..2, 0..1) a quarter about Z: x spans -1..0 and y spans 0..2.
    expect(posed(boxes, [...QUARTER_TURN, ...moved(0, 0, 0), ...IDENTITY])).toEqual({ found: true, min: [-1, 0, 0], max: [6, 7, 8] });
    // A bone that moves no vertex adds nothing, wherever its matrix is.
    expect(posed(boxes, [...IDENTITY, ...IDENTITY, ...moved(1000, 1000, 1000)])).toEqual({ found: true, min: [0, 0, 0], max: [6, 7, 8] });
  });

  it("widens the box by a share of its size on every side", () => {
    const boxes = skinnedBoneBoxes([0, 0, 0, 10, 20, 40], [[0, 0, 0, 0, 0, 0, 0, 0]], [[1, 0, 0, 0, 1, 0, 0, 0]], 1)!;
    expect(posed(boxes, IDENTITY, 0.1)).toEqual({ found: true, min: [-1, -2, -4], max: [11, 22, 44] });
  });

  it("finds no box, and writes none, when no bone moves a vertex or a matrix is not finite", () => {
    const empty = skinnedBoneBoxes([1, 2, 3], [[0, 0, 0, 0]], [[0, 0, 0, 0]], 1)!;
    expect(posed(empty, IDENTITY)).toEqual({ found: false, min: [77, 77, 77], max: [77, 77, 77] });
    const boxes = skinnedBoneBoxes([1, 2, 3], [[0, 0, 0, 0]], [[1, 0, 0, 0]], 1)!;
    expect(posed(boxes, moved(Number.NaN, 0, 0))).toEqual({ found: false, min: [77, 77, 77], max: [77, 77, 77] });
    expect(posed(boxes, moved(0, Number.POSITIVE_INFINITY, 0))).toEqual({ found: false, min: [77, 77, 77], max: [77, 77, 77] });
    // Fewer matrices than bones: the bones without one are left out.
    expect(posed(boxes, [])).toEqual({ found: false, min: [77, 77, 77], max: [77, 77, 77] });
  });

  it("holds every vertex of any pose, skinned the long way", () => {
    // A fixed sequence, so the poses are the same on every run.
    let seed = 12345;
    const random = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const bones = 6, vertices = 200;
    const positions: number[] = [], joints: number[] = [], weights: number[] = [];
    for (let vertex = 0; vertex < vertices; vertex += 1) {
      positions.push(random() * 4 - 2, random() * 4 - 2, random() * 4 - 2);
      const raw = [random(), random(), random() < 0.5 ? 0 : random(), 0];
      const sum = raw.reduce((a, b) => a + b, 0);
      for (let slot = 0; slot < 4; slot += 1) {
        joints.push(Math.floor(random() * bones));
        weights.push(raw[slot]! / sum);
      }
    }
    const boxes = skinnedBoneBoxes(positions, [joints], [weights], bones)!;
    for (let pose = 0; pose < 20; pose += 1) {
      // Any affine matrices: turned, sheared, scaled (mirrored too) and moved.
      const matrices: number[] = [];
      for (let bone = 0; bone < bones; bone += 1) {
        const m = Array.from({ length: 16 }, () => random() * 4 - 2);
        m[3] = m[7] = m[11] = 0; m[15] = 1;
        matrices.push(...m);
      }
      const min = { x: 0, y: 0, z: 0 }, max = { x: 0, y: 0, z: 0 };
      expect(posedBox(boxes, matrices, min, max, 0)).toBe(true);
      let outside = 0;
      for (let vertex = 0; vertex < vertices; vertex += 1) {
        const [x, y, z] = positions.slice(vertex * 3, vertex * 3 + 3) as [number, number, number];
        const at = [0, 0, 0];
        for (let slot = 0; slot < 4; slot += 1) {
          const weight = weights[vertex * 4 + slot]!, m = joints[vertex * 4 + slot]! * 16;
          for (let axis = 0; axis < 3; axis += 1)
            at[axis]! += weight * (x * matrices[m + axis]! + y * matrices[m + 4 + axis]! + z * matrices[m + 8 + axis]! + matrices[m + 12 + axis]!);
        }
        const slack = 1e-9;
        if (at[0]! < min.x - slack || at[0]! > max.x + slack || at[1]! < min.y - slack || at[1]! > max.y + slack || at[2]! < min.z - slack || at[2]! > max.z + slack) outside += 1;
      }
      expect(outside, `pose ${pose}`).toBe(0);
      // And it is no looser than the bones' boxes moved corner by corner.
      const corners = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
      for (let bone = 0; bone < bones; bone += 1) {
        const [x0, y0, z0, x1, y1, z1] = box(boxes, bone) as [number, number, number, number, number, number];
        if (x0 > x1) continue;
        for (let corner = 0; corner < 8; corner += 1) {
          const x = corner & 1 ? x1 : x0, y = corner & 2 ? y1 : y0, z = corner & 4 ? z1 : z0, m = bone * 16;
          for (let axis = 0; axis < 3; axis += 1) {
            const value = x * matrices[m + axis]! + y * matrices[m + 4 + axis]! + z * matrices[m + 8 + axis]! + matrices[m + 12 + axis]!;
            corners.min[axis] = Math.min(corners.min[axis]!, value);
            corners.max[axis] = Math.max(corners.max[axis]!, value);
          }
        }
      }
      for (const [axis, name] of (["x", "y", "z"] as const).entries()) {
        expect(min[name], `pose ${pose}`).toBeCloseTo(corners.min[axis]!, 9);
        expect(max[name], `pose ${pose}`).toBeCloseTo(corners.max[axis]!, 9);
      }
    }
  });
});
