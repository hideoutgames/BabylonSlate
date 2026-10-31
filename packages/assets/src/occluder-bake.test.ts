import { describe, expect, it } from "vitest";
import { convexHullMesh, type HullVec3 } from "./convex-hull";
import { buildBoxGlbFixture } from "./glb-geometry";
import { importModel } from "./importers/model";
import { normalizeModelPayload } from "./model-payload";
import { bakeGltfOccluder, bakeModelOccluderBox } from "./occluder-bake";

type Mesh = { positions: number[]; indices: number[] };

/** A box's twelve triangles; `skip` leaves out the faces it names (0..5: −x, +x, −y, +y, −z, +z). */
function box(min: number[], max: number[], skip: number[] = []): Mesh {
  const positions: number[] = [];
  for (let corner = 0; corner < 8; corner++)
    positions.push(corner & 1 ? max[0]! : min[0]!, corner & 2 ? max[1]! : min[1]!, corner & 4 ? max[2]! : min[2]!);
  const faces = [[0, 2, 6, 4], [1, 3, 7, 5], [0, 1, 5, 4], [2, 3, 7, 6], [0, 1, 3, 2], [4, 5, 7, 6]];
  const indices = faces.flatMap((face, index) => skip.includes(index) ? [] : [face[0]!, face[1]!, face[2]!, face[0]!, face[2]!, face[3]!]);
  return { positions, indices };
}

function merge(...meshes: Mesh[]): Mesh {
  const positions: number[] = [], indices: number[] = [];
  for (const mesh of meshes) {
    const base = positions.length / 3;
    positions.push(...mesh.positions);
    indices.push(...mesh.indices.map((index) => index + base));
  }
  return { positions, indices };
}

/** Whether `point` is inside the closed mesh: a ray along a slanted axis crosses it an odd number of times. */
function inside(mesh: Mesh, point: number[]): boolean {
  const direction = [0.5773, 0.5774, 0.5775];
  let crossings = 0;
  for (let corner = 0; corner < mesh.indices.length; corner += 3) {
    const [a, b, c] = [0, 1, 2].map((offset) => [0, 1, 2].map((axis) => mesh.positions[mesh.indices[corner + offset]! * 3 + axis]!));
    const ab = a!.map((value, axis) => b![axis]! - value), ac = a!.map((value, axis) => c![axis]! - value);
    const p = [direction[1]! * ac[2]! - direction[2]! * ac[1]!, direction[2]! * ac[0]! - direction[0]! * ac[2]!, direction[0]! * ac[1]! - direction[1]! * ac[0]!];
    const determinant = ab[0]! * p[0]! + ab[1]! * p[1]! + ab[2]! * p[2]!;
    if (Math.abs(determinant) < 1e-12) continue;
    const s = point.map((value, axis) => value - a![axis]!);
    const u = (s[0]! * p[0]! + s[1]! * p[1]! + s[2]! * p[2]!) / determinant;
    if (u < 0 || u > 1) continue;
    const q = [s[1]! * ab[2]! - s[2]! * ab[1]!, s[2]! * ab[0]! - s[0]! * ab[2]!, s[0]! * ab[1]! - s[1]! * ab[0]!];
    const v = (direction[0]! * q[0]! + direction[1]! * q[1]! + direction[2]! * q[2]!) / determinant;
    if (v < 0 || u + v > 1) continue;
    if ((ac[0]! * q[0]! + ac[1]! * q[1]! + ac[2]! * q[2]!) / determinant > 0) crossings++;
  }
  return crossings % 2 === 1;
}

/** Points over the box: a grid through its volume, corners and faces included. */
function samples(result: { min: readonly number[]; max: readonly number[] }, steps = 4): number[][] {
  const points: number[][] = [];
  for (let i = 0; i <= steps; i++)
    for (let j = 0; j <= steps; j++)
      for (let k = 0; k <= steps; k++)
        points.push([i, j, k].map((step, axis) => result.min[axis]! + ((result.max[axis]! - result.min[axis]!) * step) / steps));
  return points;
}

function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), state | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("bakeModelOccluderBox", () => {
  it("bakes a box inside a closed cube, nearly as large as it", () => {
    const cube = box([-1, -1, -1], [1, 1, 1]);
    const result = bakeModelOccluderBox(cube.positions, cube.indices)!;
    for (let axis = 0; axis < 3; axis++) {
      expect(result.min[axis]).toBeGreaterThan(-1);
      expect(result.max[axis]).toBeLessThan(1);
      expect(result.max[axis]! - result.min[axis]!).toBeGreaterThan(1.6);
    }
  });

  it("bakes none for an open box, a flat plane or a thin slab", () => {
    const open = box([-1, -1, -1], [1, 1, 1], [3]);
    expect(bakeModelOccluderBox(open.positions, open.indices)).toBeNull();
    expect(bakeModelOccluderBox([-1, 0, -1, 1, 0, -1, 1, 0, 1, -1, 0, 1], [0, 1, 2, 0, 2, 3])).toBeNull();
    const slab = box([-1, -0.01, -1], [1, 0.01, 1]);
    expect(bakeModelOccluderBox(slab.positions, slab.indices)).toBeNull();
  });

  it("stays inside an L of two overlapping boxes, in the larger arm", () => {
    // Two closed boxes overlapping: the union's inner voxels are those inside either (a ray inside crosses both).
    const shape = merge(box([0, 0, 0], [4, 1, 1]), box([0, 0, 0], [1, 4, 1]));
    const result = bakeModelOccluderBox(shape.positions, shape.indices)!;
    for (const point of samples(result))
      expect(point[0]! < 4 && point[1]! < 4 && point.every((value) => value > 0) && point[2]! < 1 && (point[0]! < 1 || point[1]! < 1)).toBe(true);
  });

  it("never reaches outside a random convex model (fuzz)", () => {
    const next = random(7);
    let baked = 0;
    for (let model = 0; model < 40; model++) {
      const scale = [0.5 + next() * 4, 0.5 + next() * 4, 0.5 + next() * 4];
      const offset = [next() * 200 - 100, next() * 20, next() * 200 - 100];
      const points: HullVec3[] = Array.from({ length: 12 + Math.floor(next() * 40) }, () => ({
        x: offset[0]! + (next() - 0.5) * scale[0]!, y: offset[1]! + (next() - 0.5) * scale[1]!, z: offset[2]! + (next() - 0.5) * scale[2]!,
      }));
      const hull = convexHullMesh(points);
      const mesh = { positions: hull.vertices.flatMap((vertex) => [vertex.x, vertex.y, vertex.z]), indices: hull.indices };
      const result = bakeModelOccluderBox(mesh.positions, mesh.indices);
      if (!result) continue;
      baked++;
      for (const point of samples(result)) expect(inside(mesh, point), `model ${model} point ${point.join(", ")}`).toBe(true);
    }
    // Not vacuous: most convex models bake a box.
    expect(baked).toBeGreaterThan(30);
  });
});

describe("the Model import's occluder", () => {
  it("bakes a box inside the GLB's cube, at its Import Scale, with the model's bounds", () => {
    const occluder = bakeGltfOccluder(buildBoxGlbFixture(1), 2)!;
    expect(occluder.boundsMin).toEqual([-1, -1, -1]);
    expect(occluder.boundsMax).toEqual([1, 1, 1]);
    for (let axis = 0; axis < 3; axis++) {
      expect(occluder.min[axis]).toBeGreaterThan(-1);
      expect(occluder.max[axis]).toBeLessThan(1);
    }
  });

  it("is stored in the imported Model's payload, and a payload without one, or a malformed one, reads as none", async () => {
    const results = await importModel(buildBoxGlbFixture(1), { fileName: "crate.glb", existingGuids: new Set() });
    const model = results.find((result) => result.type === "Model")!;
    expect(normalizeModelPayload(model.payload).occluder).toMatchObject({ boundsMin: [-0.5, -0.5, -0.5] });
    expect(normalizeModelPayload({}).occluder).toBeNull();
    expect(normalizeModelPayload({ occluder: { min: [1, 0, 0], max: [0, 1, 1], boundsMin: [-1, -1, -1], boundsMax: [1, 1, 1] } }).occluder).toBeNull();
  });
});
