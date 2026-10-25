/**
 * What a blending water surface's per-vertex blend data are and how one write produces them: the scene blend registry
 * (`sceneBlends`), the blend kernel over a range of vertices, a Global grid's rows within a neighbour's reach and the
 * fit of the rest normals and ownership margins.
 */
import { Matrix, Vector3, type Scene } from "@babylonjs/core";
import {
  createWaterBlendSample, evaluateWaterBlend, MAX_WATER_BLEND_DISTANCE, sameWaterColors, WATER_BLEND_COLOR_PARTNERS, waterBlendReach, waterFootprint,
  type WaterBlendIndex,
} from "@haptic/core";
import { globalRestRange, uploadGlobalRows } from "./water-mesh-rest-data";
import type { RestBuffers, Surface } from "./water-mesh-surface";

/**
 * What `blendRange` reads and accumulates: the neighbour index it evaluates (the scene's, or a rebuild's frozen copy), the
 * body's world matrix, the neighbours' world bounds, per write the extremes a finished write applies to the surface, and
 * the colour partners: neighbours coloured unlike this body, those coloured alike sharing a slot, by body index (`slots`)
 * and per slot (`partners`, one body of each).
 */
export type BlendInputs = {
  index: WaterBlendIndex; distance: number; self: number; world: Matrix; inverse: Matrix;
  near: Float64Array[]; lift: Vector3;
  ranged: boolean; varies: boolean; highest: number; slots: Map<number, number>; partners: number[];
};
/**
 * One scene's blending: its index of enabled surfaces and the distance it was built for. `waiting` is set while a
 * moved surface's neighbours keep their previous blend data (`WATER_BLEND_REFRESH_MS`).
 */
export type SceneBlend = { index: WaterBlendIndex; distance: number; dirty: boolean; waiting: boolean; members: Surface[]; spent: number };
export const sceneBlends = new WeakMap<Scene, SceneBlend>();

const blendSample = createWaterBlendSample(), blendPoint = new Vector3();

export const createBlendInputs = (): BlendInputs => ({
  index: null as unknown as WaterBlendIndex, distance: 0, self: 0, world: Matrix.Identity(), inverse: Matrix.Identity(),
  near: [], lift: new Vector3(), ranged: false, varies: false, highest: 1, slots: new Map(), partners: [],
});

/** Points `inputs` at a neighbour index, the body `self` in it and the world matrix the body is evaluated at. */
export function blendInputs(inputs: BlendInputs, index: WaterBlendIndex, distance: number, self: number, world: Matrix, inverse: Matrix): BlendInputs {
  inputs.index = index; inputs.distance = distance; inputs.self = self; inputs.world = world; inputs.inverse = inverse;
  inputs.near.length = 0;
  for (const j of index.neighbours(self)) inputs.near.push(index.bodies[j]!.bounds);
  return inputs;
}

/** The scene's own index and the surface's own placement: what a write that happens at once evaluates. */
const liveInputs = createBlendInputs();
export function liveBlendInputs(state: SceneBlend, self: number, world: Matrix, inverse: Matrix): BlendInputs {
  return blendInputs(liveInputs, state.index, state.distance, self, world, inverse);
}

/** Whether world X/Z lies within `reach` of any of `bounds` (min X, max X, ..., min Z, max Z). */
function inBlendReach(bounds: readonly Float64Array[], reach: number, x: number, z: number): boolean {
  for (let n = 0; n < bounds.length; n++) {
    const b = bounds[n]!;
    if (x >= b[0]! - reach && x <= b[1]! + reach && z >= b[4]! - reach && z <= b[5]! + reach) return true;
  }
  return false;
}

/**
 * Blended rest data of a blending surface's grid (`evaluateWaterBlend` at each vertex's world rest point): lifts the rest
 * grid to the blended rest height and fills `blendData` and `blendColors` (the vertex attributes) and `blendRest` (union
 * bank distance, depth, current and world rest height, which `placeRestData` uploads), then the rest extents. Each vertex
 * mixes toward every colour partner by its colour share. On change only: a rebuilt grid, a rotated or scaled volume, or a recentred
 * Global grid. With a vertex range (`first` to `end`), only those vertices are rewritten (Global Water's rows near a
 * neighbour, `placeGlobalBlend`): the rest extents then cover open water's plane and the range, and the height scale
 * comes from the range alone (open water outside it has none).
 */
export function placeBlend(s: Surface, world: Matrix, inverse: Matrix, first = 0, end = s.base.length / 3): void {
  const state = sceneBlends.get(s.mesh.getScene()), blend = s.blend;
  if (!state || !blend) return;
  const inputs = liveBlendInputs(state, blend.self, world, inverse);
  beginBlend(inputs, s, first > 0 || end < s.base.length / 3);
  blendRange(inputs, s, s, first, end);
  finishBlend(s, inputs);
}

/**
 * Starts a write of `b`: a range leaves open water's plane (local y = 0) everywhere else. The colour partners are this
 * body's neighbours coloured unlike it, in index order, alike-coloured ones sharing a slot; past
 * `WATER_BLEND_COLOR_PARTNERS` further colours keep this body's own.
 */
export function beginBlend(inputs: BlendInputs, b: RestBuffers, ranged: boolean): void {
  inputs.ranged = ranged; inputs.varies = false; inputs.highest = 1;
  const { index, self, slots, partners } = inputs, list = index.neighbours(self);
  slots.clear(); partners.length = 0;
  for (let n = 0; n < list.length; n++) {
    const j = list[n]!;
    if (index.colorsMatch(self, n)) continue;
    let slot = partners.findIndex((k) => sameWaterColors(index.bodies[k]!.definition, index.bodies[j]!.definition));
    if (slot < 0 && partners.length < WATER_BLEND_COLOR_PARTNERS) slot = partners.push(j) - 1;
    if (slot >= 0) slots.set(j, slot);
  }
  Vector3.TransformNormalFromFloatsToRef(0, 1, 0, inputs.inverse, inputs.lift);
  if (ranged) { b.restMin.y = 0; b.restMax.y = 0; }
  else { b.restMin.setAll(Infinity); b.restMax.setAll(-Infinity); }
}

/** The kernel over vertices [first, end) of `b`, which may be called again for further ranges of one write. */
export function blendRange(inputs: BlendInputs, s: Surface, b: RestBuffers, first: number, end: number): void {
  const base = b.base, data = b.blendData, colors = b.blendColors, rest = b.blendRest, sample = blendSample, slots = inputs.slots, lift = inputs.lift;
  const world = inputs.world, index = inputs.index, self = inputs.self, near = inputs.near, ranged = inputs.ranged;
  // Vertices beyond every neighbour's reach keep the body's own rest data (most of a Global grid): no kernel call.
  const reach = waterBlendReach(inputs.distance);
  const open = s.body.kind === "global";
  for (let v = first; v < end; v++) {
    const i = v * 3, d = v * 4, c = v * 2, r = v * 6;
    colors[c] = 0; colors[c + 1] = 0;
    // The own rest height first (a recentred Global grid keeps the previous lift; its own plane is at 0).
    base[i + 1] = open ? 0 : waterFootprint(s.body, base[i]!, base[i + 2]!).height;
    Vector3.TransformCoordinatesFromFloatsToRef(base[i]!, base[i + 1]!, base[i + 2]!, world, blendPoint);
    if (!inBlendReach(near, reach, blendPoint.x, blendPoint.z)) {
      // NaN marks the body's own rest data for `placeRestData`.
      data[d] = 1; data[d + 1] = 1; data[d + 2] = 1; data[d + 3] = 0;
      rest[r] = NaN; rest[r + 5] = blendPoint.y;
    } else if (evaluateWaterBlend(index, self, blendPoint.x, blendPoint.y, blendPoint.z, sample, true)) {
      // Past this body's reach (its grid's outer vertices) it owns nothing but takes the neighbours' surface, so the
      // shoreline and ownership interpolate toward their true values instead of stepping along the grid.
      const blendLift = sample.restHeight - sample.ownRestHeight;
      if (Math.abs(blendLift) > 1e-4) inputs.varies = true;
      base[i] = base[i]! + lift.x * blendLift; base[i + 1] = base[i + 1]! + lift.y * blendLift; base[i + 2] = base[i + 2]! + lift.z * blendLift;
      data[d] = sample.heightScale; data[d + 1] = sample.offsetScale; data[d + 2] = sample.margin; data[d + 3] = 0;
      // Each colour partner's share (the participants are in the index's scratch until the next evaluation).
      const p = index.scratch;
      for (let a = 1; a < sample.participants; a++) {
        const slot = p.colors[a] ? -1 : slots.get(p.index[a]!) ?? -1;
        if (slot === 0) data[d + 3] += p.colorWeight[a]!;
        else if (slot > 0) colors[c + slot - 1] += p.colorWeight[a]!;
      }
      rest[r] = Math.max(-1e4, Math.min(1e4, sample.union)); rest[r + 1] = sample.depth;
      rest[r + 2] = sample.flowX; rest[r + 3] = sample.flowY; rest[r + 4] = sample.flowZ; rest[r + 5] = sample.restHeight;
    } else {
      // No water of this body here: outside the union and owned by nobody, so the fragment discards.
      data[d] = 0; data[d + 1] = 0; data[d + 2] = -1; data[d + 3] = 0;
      rest[r] = -1; rest[r + 1] = 0; rest[r + 2] = rest[r + 3] = rest[r + 4] = 0; rest[r + 5] = blendPoint.y;
    }
    if (data[d]! > inputs.highest) inputs.highest = data[d]!;
    if (ranged) {
      b.restMin.y = Math.min(b.restMin.y, base[i + 1]!); b.restMax.y = Math.max(b.restMax.y, base[i + 1]!);
    } else {
      b.restMin.minimizeInPlaceFromFloats(base[i]!, base[i + 1]!, base[i + 2]!);
      b.restMax.maximizeInPlaceFromFloats(base[i]!, base[i + 1]!, base[i + 2]!);
    }
  }
}

/** Applies a finished write's results (`blendRange`'s accumulations) to the surface. */
export function finishBlend(s: Surface, inputs: BlendInputs): void {
  const blend = s.blend;
  if (!blend) return;
  blend.restVaries = inputs.varies;
  blend.heightScale = inputs.highest;
  const partners = blend.partners;
  for (let k = 0; k < WATER_BLEND_COLOR_PARTNERS; k++) {
    const j = inputs.partners[k];
    partners[k] = j === undefined ? null : inputs.index.bodies[j]!.definition;
  }
  if (s.plugin) s.plugin.partners = partners;
  if (s.nodes) s.nodes.partners = partners;
}

const rowStart = new Vector3(), rowEnd = new Vector3(), reachRows = new Int32Array(2), writeRows = new Int32Array(2);

/**
 * The first and last rows (inclusive) of a blending Global grid that come within a neighbour's reach, into `out`
 * (first > last when none). Each row is a straight line in world space, so its end points bound it.
 */
export function globalReachRows(s: Surface, inputs: BlendInputs, out: Int32Array): void {
  out[0] = 1; out[1] = 0;
  const base = s.base, stride = s.layoutColumns + 1, rows = base.length / 3 / stride - 1, world = inputs.world;
  const reach = waterBlendReach(inputs.distance), near = inputs.near;
  let first = rows + 1, last = -1;
  for (let row = 0; row <= rows; row++) {
    const a = row * stride * 3, b = (row * stride + stride - 1) * 3;
    Vector3.TransformCoordinatesFromFloatsToRef(base[a]!, 0, base[a + 2]!, world, rowStart);
    Vector3.TransformCoordinatesFromFloatsToRef(base[b]!, 0, base[b + 2]!, world, rowEnd);
    const minX = Math.min(rowStart.x, rowEnd.x), maxX = Math.max(rowStart.x, rowEnd.x);
    const minZ = Math.min(rowStart.z, rowEnd.z), maxZ = Math.max(rowStart.z, rowEnd.z);
    for (let n = 0; n < near.length; n++) {
      const bounds = near[n]!;
      if (maxX >= bounds[0]! - reach && minX <= bounds[1]! + reach && maxZ >= bounds[4]! - reach && minZ <= bounds[5]! + reach) {
        if (row < first) first = row;
        last = row;
        break;
      }
    }
  }
  out[0] = first; out[1] = last;
}

/**
 * The grid rows a Global blend write covers into `out`: those within a neighbour's reach (`reach`, now) or at the last
 * write (which return to open water), plus one row either side (the rest normals' fit reads them). first > last when empty.
 */
export function globalWriteRows(s: Surface, reach: Int32Array, out: Int32Array): void {
  const stride = s.layoutColumns + 1, rows = s.base.length / 3 / stride - 1;
  out[0] = Math.max(0, Math.min(reach[0]!, s.blendRows[0]!) - 1);
  out[1] = Math.min(rows, Math.max(reach[1]!, s.blendRows[1]!) + 1);
}

/**
 * A blending Global grid on the GPU path after a recentre: only the rows within a neighbour's
 * reach (now, or at the last write, which return to open water) plus one row either side (the rest normals' fit reads
 * them) are rewritten (`placeBlend` over their vertices, then uniform open-water rest data where no neighbour reaches)
 * and uploaded in place, positions included (their blend lift in y). A recentre moves the grid through `gridOffset`, so
 * nothing outside the rows changes: a Global grid whose neighbours are out of reach uploads nothing, as when it blends
 * with nothing.
 */
export function placeGlobalBlend(s: Surface): void {
  const state = sceneBlends.get(s.mesh.getScene()), blend = s.blend;
  if (!state || !blend) return;
  const stride = s.layoutColumns + 1;
  globalReachRows(s, liveBlendInputs(state, blend.self, s.world, s.inverse), reachRows);
  globalWriteRows(s, reachRows, writeRows);
  const first = writeRows[0]!, last = writeRows[1]!;
  s.blendRows[0] = reachRows[0]!; s.blendRows[1] = reachRows[1]!;
  const begin = first * stride, end = (last + 1) * stride;
  if (last >= first) placeBlend(s, s.world, s.inverse, begin, end);
  else { s.restMin.y = 0; s.restMax.y = 0; }
  if (last < first) return;
  globalRestRange(s, s, s.world, s.inverse, begin, end);
  blendNormals(s, begin, end);
  uploadGlobalRows(s, begin, end);
}

const toLocalNormal = new Matrix(), baseNormal = new Vector3(), localNormal = new Vector3();
let marginScratch = new Float32Array(0);
/**
 * A blending surface's rest normals follow the blended rest height: its world slope from the grid neighbours' rest
 * heights (least squares over the four neighbours), as world base normals and, on the GPU path, local vertex normals.
 * The ownership margin becomes an approximate signed distance in metres (margin over the length of its fitted gradient):
 * nearly linear across the seam, it interpolates alike on both surfaces' triangulations, so the overlap the cut code
 * keeps can stay a few centimetres wide. Vertices [first, end) only; the caller uploads. (A recentred Global grid's
 * world rest points are not rewritten on the GPU path, but its grid lines are fixed offsets from the centre, so the
 * differences between neighbours this fit reads are unchanged.)
 */
export function blendNormals(s: Surface, first: number, end: number): void {
  const count = s.base.length / 3;
  if (marginScratch.length < count) marginScratch = new Float32Array(count);
  blendFit(s, s, s.world, marginScratch, first, end);
  for (let v = first; v < end; v++) s.blendData[v * 4 + 2] = marginScratch[v]!;
}

/**
 * `blendNormals`' fit for vertices [first, end) of `b`, leaving the margins in `metres` (the caller applies them to
 * `blendData` once every vertex has been fitted: neighbouring vertices read the margins as the kernel left them).
 */
export function blendFit(s: Surface, b: RestBuffers, volume: Matrix, metres: Float32Array, first: number, end: number): void {
  const columns = s.layoutColumns, rest = b.blendRest, world = b.worldBase, data = b.blendData;
  const rows = b.base.length / 3 / (columns + 1) - 1;
  volume.transposeToRef(toLocalNormal);
  for (let v = first; v < end; v++) {
    const margin = data[v * 4 + 2]!;
    // Vertices on the body's own rest data keep its own normals and own the point outright.
    if (Number.isNaN(rest[v * 6]!)) { metres[v] = MAX_WATER_BLEND_DISTANCE; continue; }
    const col = v % (columns + 1), row = (v - col) / (columns + 1);
    let xx = 0, xz = 0, zz = 0, xh = 0, zh = 0, xm = 0, zm = 0;
    for (let k = 0; k < 4; k++) {
      const n = k === 0 ? (col > 0 ? v - 1 : -1) : k === 1 ? (col < columns ? v + 1 : -1) : k === 2 ? (row > 0 ? v - columns - 1 : -1) : (row < rows ? v + columns + 1 : -1);
      if (n < 0) continue;
      const dx = world[n * 3]! - world[v * 3]!, dz = world[n * 3 + 2]! - world[v * 3 + 2]!, dh = rest[n * 6 + 5]! - rest[v * 6 + 5]!;
      const dm = data[n * 4 + 2]! - margin;
      xx += dx * dx; xz += dx * dz; zz += dz * dz; xh += dx * dh; zh += dz * dh; xm += dx * dm; zm += dz * dm;
    }
    const det = xx * zz - xz * xz, solve = det > 1e-12;
    const gx = solve ? (zz * xh - xz * zh) / det : 0, gz = solve ? (xx * zh - xz * xh) / det : 0;
    const slope = solve ? Math.hypot((zz * xm - xz * zm) / det, (xx * zm - xz * xm) / det) : 0;
    // A flat margin (deep inside one body) is far from the seam: the floor keeps it large and its sign intact.
    metres[v] = Math.max(-MAX_WATER_BLEND_DISTANCE, Math.min(MAX_WATER_BLEND_DISTANCE, margin / Math.max(slope, 0.02)));
    baseNormal.set(-gx, 1, -gz).normalize().toArray(b.baseNormals, v * 3);
    if (s.gpu) { Vector3.TransformNormalToRef(baseNormal, toLocalNormal, localNormal); localNormal.normalize().toArray(b.normals, v * 3); }
  }
}
