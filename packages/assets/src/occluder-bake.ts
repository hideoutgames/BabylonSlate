/**
 * A Model's occluder: an axis-aligned box in its local space that lies inside it, baked at import, which occlusion
 * culling draws in its place (a model's own triangles are too many to rasterise each frame).
 *
 * The model is voxelised over its bounds. Voxels a triangle touches are surface; a flood from outside the bounds
 * through the rest marks what the outside reaches; what neither touches nor reaches lies wholly within the model's
 * closed surface. The box is grown from the voxel farthest from the surface while every voxel it covers is such an
 * inner voxel, so it never pokes out of the surface. An open mesh lets the flood in and bakes no box; so do thin and
 * flat models.
 *
 * Within a closed surface is not the same as solid: the closed shell of a building also encloses its rooms. From
 * outside the model's bounds both hide what is behind them; a viewer inside them is never shown this box
 * (`view-occlusion.ts`).
 */

import { extractGltfCollisionMesh } from "./glb-geometry";

export interface ModelOccluderBox {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}

/** A Model's baked occluder in its actor's local space (Import Scale applied), with the model's own bounds there. */
export interface ModelOccluder extends ModelOccluderBox {
  readonly boundsMin: readonly [number, number, number];
  readonly boundsMax: readonly [number, number, number];
}

/**
 * The occluder of a glTF or GLB model's rest-pose triangles, in the space its simple colliders use (Import Scale
 * baked, x mirrored into Babylon's left-handed space); null when it has none.
 */
export function bakeGltfOccluder(bytes: Uint8Array, importScale: number): ModelOccluder | null {
  const mesh = extractGltfCollisionMesh(bytes, importScale);
  if (!mesh) return null;
  const positions = Float64Array.from(mesh.positions);
  for (let index = 0; index < positions.length; index += 3) positions[index] = -positions[index]!;
  const box = bakeModelOccluderBox(positions, mesh.indices);
  if (!box) return null;
  const boundsMin: [number, number, number] = [Infinity, Infinity, Infinity], boundsMax: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let index = 0; index < positions.length; index++) {
    const axis = index % 3;
    boundsMin[axis] = Math.min(boundsMin[axis]!, positions[index]!);
    boundsMax[axis] = Math.max(boundsMax[axis]!, positions[index]!);
  }
  return { ...box, boundsMin, boundsMax };
}

/** Voxels along the model's longest side. */
export const OCCLUDER_BAKE_RESOLUTION = 32;
/** A box thinner than this many voxels on any side is not worth an occluder. */
const MIN_BOX_VOXELS = 2;

/**
 * The inner box of the triangles `indices` (three per triangle) over `positions` (x, y, z per vertex, in the model's
 * local space), or null when none: an open, thin or flat model.
 */
export function bakeModelOccluderBox(
  positions: ArrayLike<number>,
  indices: ArrayLike<number>,
  resolution = OCCLUDER_BAKE_RESOLUTION,
): ModelOccluderBox | null {
  const vertexCount = Math.floor(positions.length / 3);
  if (vertexCount < 3 || indices.length < 3) return null;
  const low = [Infinity, Infinity, Infinity], high = [-Infinity, -Infinity, -Infinity];
  for (let vertex = 0; vertex < vertexCount; vertex++)
    for (let axis = 0; axis < 3; axis++) {
      const value = positions[vertex * 3 + axis]!;
      if (value < low[axis]!) low[axis] = value;
      if (value > high[axis]!) high[axis] = value;
    }
  const extent = Math.max(high[0]! - low[0]!, high[1]! - low[1]!, high[2]! - low[2]!);
  if (!(extent > 0) || !Number.isFinite(extent)) return null;
  const size = extent / resolution;
  // One empty layer around the bounds, so the outside flood starts from every side.
  const origin = low.map((value) => value - size) as [number, number, number];
  const dims = [0, 1, 2].map((axis) => Math.ceil((high[axis]! - low[axis]!) / size) + 2) as [number, number, number];
  const [nx, ny, nz] = dims;
  const cell = (x: number, y: number, z: number) => (z * ny + y) * nx + x;
  const SURFACE = 1, OUTSIDE = 2;
  const state = new Uint8Array(nx * ny * nz);

  // Surface: every voxel a triangle touches, by the separating-axis test against the voxel grown by a hair.
  const half = size * 0.5 * (1 + 1e-6);
  const a = [0, 0, 0], b = [0, 0, 0], c = [0, 0, 0];
  for (let corner = 0; corner + 2 < indices.length; corner += 3) {
    for (let axis = 0; axis < 3; axis++) {
      a[axis] = positions[indices[corner]! * 3 + axis]!;
      b[axis] = positions[indices[corner + 1]! * 3 + axis]!;
      c[axis] = positions[indices[corner + 2]! * 3 + axis]!;
    }
    const from = [0, 1, 2].map((axis) => Math.max(0, Math.floor((Math.min(a[axis]!, b[axis]!, c[axis]!) - origin[axis]!) / size) - 1));
    const to = [0, 1, 2].map((axis) => Math.min(dims[axis]! - 1, Math.floor((Math.max(a[axis]!, b[axis]!, c[axis]!) - origin[axis]!) / size) + 1));
    for (let z = from[2]!; z <= to[2]!; z++)
      for (let y = from[1]!; y <= to[1]!; y++)
        for (let x = from[0]!; x <= to[0]!; x++) {
          const index = cell(x, y, z);
          if (state[index] === SURFACE) continue;
          const centre = [origin[0] + (x + 0.5) * size, origin[1] + (y + 0.5) * size, origin[2] + (z + 0.5) * size];
          if (triangleTouchesBox(a, b, c, centre, half)) state[index] = SURFACE;
        }
  }

  // Outside: a 6-connected flood from the empty border through every voxel that is not surface.
  const stack: number[] = [];
  const reach = (x: number, y: number, z: number) => {
    const index = cell(x, y, z);
    if (state[index] !== 0) return;
    state[index] = OUTSIDE;
    stack.push(index);
  };
  for (let z = 0; z < nz; z++)
    for (let y = 0; y < ny; y++)
      for (let x = 0; x < nx; x++)
        if (x === 0 || y === 0 || z === 0 || x === nx - 1 || y === ny - 1 || z === nz - 1) reach(x, y, z);
  while (stack.length) {
    const index = stack.pop()!;
    const x = index % nx, y = Math.floor(index / nx) % ny, z = Math.floor(index / (nx * ny));
    if (x > 0) reach(x - 1, y, z);
    if (x + 1 < nx) reach(x + 1, y, z);
    if (y > 0) reach(x, y - 1, z);
    if (y + 1 < ny) reach(x, y + 1, z);
    if (z > 0) reach(x, y, z - 1);
    if (z + 1 < nz) reach(x, y, z + 1);
  }

  // Inner voxels (state 0), counted by a 3D prefix sum so any box's count is eight reads.
  const sx = nx + 1, sy = ny + 1;
  const sums = new Int32Array(sx * sy * (nz + 1));
  const at = (x: number, y: number, z: number) => (z * sy + y) * sx + x;
  let inner = 0;
  for (let z = 0; z < nz; z++)
    for (let y = 0; y < ny; y++)
      for (let x = 0; x < nx; x++) {
        const value = state[cell(x, y, z)] === 0 ? 1 : 0;
        inner += value;
        sums[at(x + 1, y + 1, z + 1)] = value
          + sums[at(x, y + 1, z + 1)]! + sums[at(x + 1, y, z + 1)]! + sums[at(x + 1, y + 1, z)]!
          - sums[at(x, y, z + 1)]! - sums[at(x, y + 1, z)]! - sums[at(x + 1, y, z)]! + sums[at(x, y, z)]!;
      }
  if (inner === 0) return null;
  const count = (lo: number[], hi: number[]) =>
    sums[at(hi[0]! + 1, hi[1]! + 1, hi[2]! + 1)]! - sums[at(lo[0]!, hi[1]! + 1, hi[2]! + 1)]! - sums[at(hi[0]! + 1, lo[1]!, hi[2]! + 1)]!
    - sums[at(hi[0]! + 1, hi[1]! + 1, lo[2]!)]! + sums[at(lo[0]!, lo[1]!, hi[2]! + 1)]! + sums[at(lo[0]!, hi[1]! + 1, lo[2]!)]!
    + sums[at(hi[0]! + 1, lo[1]!, lo[2]!)]! - sums[at(lo[0]!, lo[1]!, lo[2]!)]!;
  const solid = (lo: number[], hi: number[]) => count(lo, hi) === (hi[0]! - lo[0]! + 1) * (hi[1]! - lo[1]! + 1) * (hi[2]! - lo[2]! + 1);

  // The seed: the inner voxel with the largest cube of inner voxels around it. A voxel is only checked for a cube
  // larger than the best so far.
  const cube = (x: number, y: number, z: number, radius: number) =>
    x - radius >= 0 && y - radius >= 0 && z - radius >= 0 && x + radius < nx && y + radius < ny && z + radius < nz
    && solid([x - radius, y - radius, z - radius], [x + radius, y + radius, z + radius]);
  let seed = -1, seedRadius = -1;
  for (let z = 0; z < nz; z++)
    for (let y = 0; y < ny; y++)
      for (let x = 0; x < nx; x++) {
        let radius = seedRadius + 1;
        if (!cube(x, y, z, radius)) continue;
        while (cube(x, y, z, radius + 1)) radius++;
        seedRadius = radius;
        seed = cell(x, y, z);
      }
  if (seed < 0) return null;
  const sxSeed = seed % nx, sySeed = Math.floor(seed / nx) % ny, szSeed = Math.floor(seed / (nx * ny));
  const lo = [sxSeed - seedRadius, sySeed - seedRadius, szSeed - seedRadius];
  const hi = [sxSeed + seedRadius, sySeed + seedRadius, szSeed + seedRadius];
  // Grow one face at a time, the face that keeps the box inner, round-robin, until no face can move.
  for (let grown = true; grown;) {
    grown = false;
    for (let face = 0; face < 6; face++) {
      const axis = face >> 1, outward = face & 1;
      const nextLo = [...lo], nextHi = [...hi];
      if (outward) nextHi[axis]! += 1;
      else nextLo[axis]! -= 1;
      if (nextLo[axis]! < 0 || nextHi[axis]! >= dims[axis]!) continue;
      if (!solid(nextLo, nextHi)) continue;
      lo[axis] = nextLo[axis]!;
      hi[axis] = nextHi[axis]!;
      grown = true;
    }
  }
  if ([0, 1, 2].some((axis) => hi[axis]! - lo[axis]! + 1 < MIN_BOX_VOXELS)) return null;
  return {
    min: [origin[0] + lo[0]! * size, origin[1] + lo[1]! * size, origin[2] + lo[2]! * size],
    max: [origin[0] + (hi[0]! + 1) * size, origin[1] + (hi[1]! + 1) * size, origin[2] + (hi[2]! + 1) * size],
  };
}

/** Whether triangle (a, b, c) touches the cube of half-size `half` at `centre` (separating-axis test). */
function triangleTouchesBox(a: number[], b: number[], c: number[], centre: number[], half: number): boolean {
  const v0 = [a[0]! - centre[0]!, a[1]! - centre[1]!, a[2]! - centre[2]!];
  const v1 = [b[0]! - centre[0]!, b[1]! - centre[1]!, b[2]! - centre[2]!];
  const v2 = [c[0]! - centre[0]!, c[1]! - centre[1]!, c[2]! - centre[2]!];
  const edges = [sub(v1, v0), sub(v2, v1), sub(v0, v2)];
  // The nine cross products of the box axes with the triangle's edges.
  for (const edge of edges)
    for (let axis = 0; axis < 3; axis++) {
      const separating = [0, 0, 0];
      separating[(axis + 1) % 3] = -edge[(axis + 2) % 3]!;
      separating[(axis + 2) % 3] = edge[(axis + 1) % 3]!;
      if (separates(separating, v0, v1, v2, half)) return false;
    }
  // The box's own axes.
  for (let axis = 0; axis < 3; axis++)
    if (Math.min(v0[axis]!, v1[axis]!, v2[axis]!) > half || Math.max(v0[axis]!, v1[axis]!, v2[axis]!) < -half) return false;
  // The triangle's plane.
  const normal = cross(edges[0]!, edges[1]!);
  return !separates(normal, v0, v1, v2, half);
}

function separates(axis: number[], v0: number[], v1: number[], v2: number[], half: number): boolean {
  const p0 = dot(axis, v0), p1 = dot(axis, v1), p2 = dot(axis, v2);
  const radius = half * (Math.abs(axis[0]!) + Math.abs(axis[1]!) + Math.abs(axis[2]!));
  return Math.min(p0, p1, p2) > radius || Math.max(p0, p1, p2) < -radius;
}

const sub = (p: number[], q: number[]) => [p[0]! - q[0]!, p[1]! - q[1]!, p[2]! - q[2]!];
const dot = (p: number[], q: number[]) => p[0]! * q[0]! + p[1]! * q[1]! + p[2]! * q[2]!;
const cross = (p: number[], q: number[]) => [p[1]! * q[2]! - p[2]! * q[1]!, p[2]! * q[0]! - p[0]! * q[2]!, p[0]! * q[1]! - p[1]! * q[0]!];
