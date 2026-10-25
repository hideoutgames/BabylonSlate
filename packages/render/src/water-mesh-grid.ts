/**
 * The water surface's rest grid: graded and uniform axes, river strips, the cell budgets Water Mesh Density scales and
 * Global Water's recentre on whole cells (`updateLayout`).
 */
import { ArcRotateCamera, Vector3, VertexData, type Camera, type Matrix } from "@babylonjs/core";
import { waterFootprint, waterRiverCentreline, type WaterBodyProperties } from "@haptic/core";
import { sceneWaterQualityDeviceClamp, sceneWaterQualityRevision } from "./render-settings";
import { sceneBlends } from "./water-mesh-blend-data";
import { writeRestPositions } from "./water-mesh-rest-data";
import { L_BUDGET, L_CX, L_CZ, L_EXTENT, L_STEP, L_VERSION, type Surface } from "./water-mesh-surface";

/** Dense cells of an axis with `count` cells: the middle half. */
const denseCells = (count: number) => count - 2 * Math.floor(count / 4);

/** Fixed endpoints, dense world-sized cells near the camera, smoothly graded outer cells. */
function axis(min: number, max: number, spacing: number, camera: number, budget: number): number[] {
  const count = Math.min(budget, Math.max(8, Math.ceil((max - min) / spacing / 2) * 2));
  if ((max - min) <= count * spacing) return Array.from({ length: count + 1 }, (_, i) => min + (max - min) * i / count);
  const outer = Math.floor(count / 4), inner = denseCells(count);
  const half = inner * spacing / 2;
  const center = Math.max(min + half, Math.min(max - half, Math.round(camera / spacing) * spacing));
  const left = center - half, right = center + half;
  return Array.from({ length: count + 1 }, (_, i) => {
    if (i < outer) return left - (left - min) * Math.pow((outer - i) / outer, 3);
    if (i > count - outer) return right + (max - right) * Math.pow((i - count + outer) / outer, 3);
    return left + (i - outer) * spacing;
  });
}

/**
 * Hard grid caps that still apply after Water Mesh Density scales Surface Resolution: Global Water cells per side,
 * finite volumes' cells per side, and river rows along and columns across the stream.
 */
export const WATER_GLOBAL_CELL_BUDGET = 192;
/**
 * A spectrum Ocean's cells per side (`oceanBudget`): its FFT waves need dense geometry near the camera, so like Global
 * Water its grid is graded around the camera (dense middle half, cubic outer cells reaching its fixed edges).
 */
export const WATER_OCEAN_CELL_BUDGET = 256;
/** A spectrum Ocean rebuilds its graded grid when the camera moves this share of the dense region's width. */
const OCEAN_RECENTRE_SHARE = 0.125;
export const WATER_FINITE_CELL_BUDGET = 160;
export const WATER_RIVER_ROW_BUDGET = 512;
export const WATER_RIVER_COLUMN_BUDGET = 64;

/** Global Water cells per side for an effective resolution: even, at least 32 and at most the Global cap. */
function globalBudget(resolution: number): number {
  const cells = Math.round(resolution);
  return Math.min(WATER_GLOBAL_CELL_BUDGET, Math.max(32, cells + cells % 2));
}

/** Spectrum Ocean cells per side for an effective resolution: twice it, even, between 64 and the Ocean cap. */
function oceanBudget(resolution: number): number {
  const cells = Math.round(resolution * 2);
  return Math.min(WATER_OCEAN_CELL_BUDGET, Math.max(64, cells + cells % 2));
}

/** Cells along one axis of a finite volume: world-sized and fixed, never camera-dependent. */
function uniformAxis(min: number, max: number, worldLength: number, step: number): number[] {
  const count = Math.min(WATER_FINITE_CELL_BUDGET, Math.max(12, Math.ceil(worldLength / step / 2) * 2));
  return Array.from({ length: count + 1 }, (_, i) => min + (max - min) * i / count);
}

type RiverRow = { x: number; z: number; tx: number; tz: number; halfWidth: number };

/**
 * Rows across the sampled centreline, including rounded end caps that match the query footprint. `extend` (local units
 * per centreline sample) widens rows and caps that face a blending neighbour.
 */
function riverRows(body: WaterBodyProperties, sx: number, sz: number, step: number, extend: ((index: number) => number) | null = null): RiverRow[] {
  const line = waterRiverCentreline(body);
  const half = (i: number) => line[i]!.halfWidth + (extend ? extend(i) : 0);
  const rows: RiverRow[] = [];
  const tangent = (i: number) => {
    const a = line[Math.max(0, i - 1)]!, b = line[Math.min(line.length - 1, i + 1)]!;
    const dx = b.x - a.x, dz = b.z - a.z, length = Math.hypot(dx, dz) || 1;
    return [dx / length, dz / length] as const;
  };
  const cap = (index: number, direction: number) => {
    const p = line[index]!, [tx, tz] = tangent(index), count = 6, radius = half(index);
    for (let k = 0; k < count; k++) {
      const f = direction < 0 ? 1 - k / count : (k + 1) / count;
      const outside = f * radius;
      const halfWidth = Math.sqrt(Math.max(0, radius * radius - outside * outside));
      rows.push({ x: p.x + tx * outside * direction, z: p.z + tz * outside * direction, tx, tz, halfWidth });
    }
  };
  cap(0, -1);
  let budget = WATER_RIVER_ROW_BUDGET;
  for (let i = 0; i < line.length; i++) {
    const p = line[i]!, [tx, tz] = tangent(i);
    rows.push({ x: p.x, z: p.z, tx, tz, halfWidth: half(i) });
    const next = line[i + 1];
    if (!next) break;
    const length = Math.hypot((next.x - p.x) * sx, (next.z - p.z) * sz);
    const splits = Math.max(1, Math.min(Math.ceil(length / step), Math.floor(budget / Math.max(1, line.length - i))));
    budget -= splits;
    const [nx, nz] = tangent(i + 1);
    for (let k = 1; k < splits; k++) {
      const t = k / splits, mx = tx + (nx - tx) * t, mz = tz + (nz - tz) * t, m = Math.hypot(mx, mz) || 1;
      rows.push({ x: p.x + (next.x - p.x) * t, z: p.z + (next.z - p.z) * t, tx: mx / m, tz: mz / m, halfWidth: half(i) + (half(i + 1) - half(i)) * t });
    }
  }
  cap(line.length - 1, 1);
  return rows;
}

const eye = new Vector3(), focus = new Vector3();
/** A camera point (its position or orbit target) in world space, including a parent, without waiting for Scene.render's camera update. */
function cameraWorld(camera: Camera, local: Vector3, out: Vector3): Vector3 {
  if (camera.parent) return Vector3.TransformCoordinatesToRef(local, camera.parent.getWorldMatrix(), out);
  return out.copyFrom(local);
}

/**
 * Water Mesh Density from the project Water quality (device-clamped), re-read only when the quality revision changes;
 * the built-in material follows its Shading Detail here too, which also reaches frozen Play materials.
 */
export function syncQuality(s: Surface): void {
  const scene = s.mesh.getScene(), revision = sceneWaterQualityRevision(scene);
  s.plugin?.syncQuality(scene);
  if (revision === s.qualityRevision) return;
  s.qualityRevision = revision;
  const density = sceneWaterQualityDeviceClamp(scene).quality.meshDensity;
  if (density !== s.density) { s.density = density; s.version++; }
}

export const UNCHANGED = 0, RECENTRED = 1, REBUILT = 2;
export type LayoutChange = typeof UNCHANGED | typeof RECENTRED | typeof REBUILT;

/**
 * Keeps the rest grid current. When Global Water's centre only moves by whole cells, the grid is the same one
 * translated (its lines are fixed offsets from the snapped centre, and every other rest input is uniform over open
 * water), so only its rest positions move: `RECENTRED`, with no per-vertex rest data, allocation or new buffers (on the
 * GPU path the shader moves the uploaded grid by `gridOffset`: no upload either). Any other input change builds a new
 * grid: `REBUILT`.
 */
export function updateLayout(s: Surface, world: Matrix, inverse: Matrix): LayoutChange {
  const { body, water, mesh } = s;
  const m = world.m;
  const sx = Math.hypot(m[0]!, m[1]!, m[2]!), sz = Math.hypot(m[8]!, m[9]!, m[10]!);
  // Water Mesh Density scales Surface Resolution; the cell caps bound the result.
  const resolution = body.resolution * s.density;
  // The vertex stage reads each cascade at the mip its spacing resolves, so the spacing follows the wind sea's
  // wavelength only loosely (a twentieth of it, within a few centimetres and metres).
  const step = Math.min(3, Math.max(0.2, water.waveLength / 20)) * 96 / resolution;
  const graded = body.kind === "ocean";
  const budget = body.kind === "global" ? globalBudget(resolution) : graded ? oceanBudget(resolution) : 0;
  let cx = 0, cz = 0, extent = 0;
  if (graded) {
    // The dense cells follow the camera (or an orbit camera's target), snapped to a fraction of their width so moving
    // within it never rebuilds the grid.
    const camera = mesh.getScene().activeCamera;
    const point = camera ? cameraWorld(camera, camera instanceof ArcRotateCamera ? camera.target : camera.position, eye) : eye.setAll(0);
    const local = Vector3.TransformCoordinatesToRef(point, inverse, eye);
    const snap = denseCells(budget) * step * OCEAN_RECENTRE_SHARE;
    cx = Math.round(local.x * sx / snap) * snap / sx; cz = Math.round(local.z * sz / snap) * snap / sz;
  } else if (body.kind === "global") {
    const camera = mesh.getScene().activeCamera;
    const local = Vector3.TransformCoordinatesToRef(camera ? cameraWorld(camera, camera.position, eye) : eye.setAll(0), inverse, eye);
    // An orbiting camera looks at its target: shift the dense cells toward it (up to most of their half width), so
    // the wave geometry, and the waterline contacts that follow it, cover both the near water and what is in focus.
    if (camera instanceof ArcRotateCamera) {
      Vector3.TransformCoordinatesToRef(cameraWorld(camera, camera.target, focus), inverse, focus);
      const dx = (focus.x - local.x) * sx, dz = (focus.z - local.z) * sz, reach = Math.hypot(dx, dz);
      const half = denseCells(budget) * step / 2;
      const shift = reach > 1e-6 ? Math.min(reach / 2, half * 0.85) / reach : 0;
      local.x += dx * shift / sx; local.z += dz * shift / sz;
    }
    extent = Math.max(256, (camera?.maxZ ?? 1000) * 1.2);
    cx = Math.round(local.x * sx / step) * step / sx; cz = Math.round(local.z * sz / step) * step / sz;
  }
  // Finite layouts depend only on the body and the volume's rotation/scale, so the camera never reshapes them. A blending
  // finite body extends its grid toward finite neighbours (`SurfaceBlend.reach`): the blended union reaches past it.
  const reach = s.blend?.reach ?? 0, ex = reach / sx, ez = reach / sz;
  const state = s.layoutState;
  let shape = true;
  for (let i = 0; i < 12; i++) if (state[i] !== m[i]) shape = false;
  if (state[L_VERSION] !== s.version || state[L_STEP] !== step || state[L_BUDGET] !== budget || state[L_EXTENT] !== extent) shape = false;
  if (shape && state[L_CX] === cx && state[L_CZ] === cz) return UNCHANGED;
  s.shift[0] = cx - state[L_CX]!; s.shift[1] = cz - state[L_CZ]!;
  for (let i = 0; i < 12; i++) state[i] = m[i]!;
  state[L_VERSION] = s.version; state[L_STEP] = step; state[L_BUDGET] = budget; state[L_CX] = cx; state[L_CZ] = cz; state[L_EXTENT] = extent;
  if (shape && body.kind === "global" && s.base.length) {
    placeGlobalGrid(s, cx, cz);
    return RECENTRED;
  }
  let xs: ArrayLike<number>, zs: ArrayLike<number>, strip: RiverRow[] | null = null;
  if (body.kind === "global") {
    // Grid lines around a centre of zero, so a recentre only adds the new centre to them.
    s.gridX = Float64Array.from(axis(-extent / sx, extent / sx, step / sx, 0, budget));
    s.gridZ = Float64Array.from(axis(-extent / sz, extent / sz, step / sz, 0, budget));
    xs = s.gridX.map((x) => cx + x); zs = s.gridZ.map((z) => cz + z);
  } else if (body.kind === "river") {
    strip = riverRows(body, sx, sz, step, reach > 0 ? riverExtension(s, world, reach / Math.max(1e-6, (sx + sz) / 2)) : null);
    const widest = Math.max(...strip.map((row) => row.halfWidth)) * 2 * Math.max(sx, sz);
    const columns = Math.min(WATER_RIVER_COLUMN_BUDGET, Math.max(4, Math.ceil(widest / step / 2) * 2));
    xs = Array.from({ length: columns + 1 }, (_, i) => i / columns * 2 - 1);
    zs = strip.map((_, i) => i);
  } else if (graded) {
    // World-sized dense cells around the camera, graded out to the Ocean's fixed edges.
    xs = axis(-body.width / 2 - ex, body.width / 2 + ex, step / sx, cx, budget);
    zs = axis(-body.length / 2 - ez, body.length / 2 + ez, step / sz, cz, budget);
  } else {
    xs = uniformAxis(-body.width / 2 - ex, body.width / 2 + ex, (body.width + 2 * ex) * sx, step);
    zs = uniformAxis(-body.length / 2 - ez, body.length / 2 + ez, (body.length + 2 * ez) * sz, step);
  }
  const columns = xs.length - 1, rows = zs.length - 1, count = (columns + 1) * (rows + 1);
  s.layoutColumns = columns;
  s.base = new Float32Array(count * 3); s.positions = new Float32Array(count * 3);
  s.worldBase = new Float32Array(count * 3);
  s.normals = new Float32Array(count * 3); s.baseNormals = new Float32Array(count * 3);
  s.data = new Float32Array(count * 4); s.flow = new Float32Array(count * 3);
  s.spacing = new Float32Array(count);
  s.offsets = new Float32Array(count * 2); s.bankGradient = new Float32Array(count * 2); s.offsetsZero = true;
  const base = s.base, worldBase = s.worldBase;
  s.restMin.setAll(Infinity); s.restMax.setAll(-Infinity);
  for (let row = 0; row <= rows; row++) for (let col = 0; col <= columns; col++) {
    let x = xs[col]!, z = zs[row]!;
    if (strip) {
      const r = strip[row]!, across = x * r.halfWidth;
      x = r.x - r.tz * across; z = r.z + r.tx * across;
      // Mitred rows on widening bends can overhang the swept bank by millimetres; keep float32 vertices queryable
      // (an extended grid reaches past the bank on purpose).
      if (!reach) {
        const bank = waterFootprint(body, x, z);
        if (bank.edge < 1e-4) { x += bank.edgeX * (bank.edge - 1e-4); z += bank.edgeZ * (bank.edge - 1e-4); }
      }
    }
    else if (body.kind === "lake" || body.kind === "puddle") {
      const u = x * 2 / (body.width + 2 * ex), v = z * 2 / (body.length + 2 * ez);
      x *= Math.sqrt(1 - v * v / 2); z *= Math.sqrt(1 - u * u / 2);
    }
    const i = (row * (columns + 1) + col) * 3;
    base[i] = x; base[i + 1] = waterFootprint(body, x, z).height; base[i + 2] = z;
    s.restMin.minimizeInPlaceFromFloats(base[i]!, base[i + 1]!, base[i + 2]!);
    s.restMax.maximizeInPlaceFromFloats(base[i]!, base[i + 1]!, base[i + 2]!);
    Vector3.TransformCoordinatesFromFloatsToRef(base[i]!, base[i + 1]!, base[i + 2]!, world, eye).toArray(worldBase, i);
  }
  // World X/Z distance to the farthest neighbour: the filter of components the grid cannot resolve.
  for (let row = 0; row <= rows; row++) for (let col = 0; col <= columns; col++) {
    const index = row * (columns + 1) + col, a = index * 3;
    const left = (col > 0 ? index - 1 : index + 1) * 3, right = (col < columns ? index + 1 : index - 1) * 3;
    const below = (row > 0 ? index - columns - 1 : index + columns + 1) * 3, above = (row < rows ? index + columns + 1 : index - columns - 1) * 3;
    s.spacing[index] = Math.max(
      Math.hypot(worldBase[a]! - worldBase[left]!, worldBase[a + 2]! - worldBase[left + 2]!),
      Math.hypot(worldBase[a]! - worldBase[right]!, worldBase[a + 2]! - worldBase[right + 2]!),
      Math.hypot(worldBase[a]! - worldBase[below]!, worldBase[a + 2]! - worldBase[below + 2]!),
      Math.hypot(worldBase[a]! - worldBase[above]!, worldBase[a + 2]! - worldBase[above + 2]!),
    );
  }
  writeRestPositions(s, 0, count);
  const indices: number[] = [], uvs: number[] = [];
  for (let row = 0; row <= rows; row++) for (let col = 0; col <= columns; col++) {
    uvs.push(col / columns, row / rows);
    if (row < rows && col < columns) {
      const a = row * (columns + 1) + col, b = a + columns + 1;
      if (body.kind === "river") indices.push(a, b, a + 1, a + 1, b, b + 1);
      else indices.push(a, a + 1, b, a + 1, b + 1, b);
    }
  }
  const data = new VertexData();
  data.positions = s.positions; data.normals = s.normals; data.indices = indices; data.uvs = uvs;
  data.applyToMesh(mesh, true);
  mesh.setVerticesData("slateWaterData", s.data, true, 4);
  mesh.setVerticesData("slateWaterFlow", s.flow, true, 3);
  mesh.setVerticesData("slateWaterBaseNormal", s.baseNormals, true, 3);
  mesh.setVerticesData("slateWaterOffset", s.offsets, true, 2);
  if (s.blend) {
    s.blendData = new Float32Array(count * 4); s.blendColors = new Float32Array(count * 2); s.blendRest = new Float32Array(count * 6);
    mesh.setVerticesData("slateWaterBlend", s.blendData, true, 4);
    mesh.setVerticesData("slateWaterBlendColors", s.blendColors, true, 2);
  } else if (mesh.isVerticesDataPresent("slateWaterBlend")) {
    mesh.removeVerticesData("slateWaterBlend");
    mesh.removeVerticesData("slateWaterBlendColors");
  }
  return REBUILT;
}

const riverPoint = new Vector3();
/**
 * Per centreline sample, local units a blending river's rows widen by: the full reach where a finite neighbour's bounds
 * come within the river's half width plus the distance, fading out over one more distance.
 */
function riverExtension(s: Surface, world: Matrix, reach: number): (index: number) => number {
  const state = sceneBlends.get(s.mesh.getScene()), blend = s.blend;
  if (!state || !blend) return () => 0;
  const line = waterRiverCentreline(s.body), distance = state.distance, index = state.index;
  const bounds = index.neighbours(blend.self).map((j) => index.bodies[j]!.bounds).filter((b) => Number.isFinite(b[0]!));
  const m = world.m, scale = Math.hypot(m[0]!, m[1]!, m[2]!);
  const widths = line.map((p) => {
    Vector3.TransformCoordinatesFromFloatsToRef(p.x, p.y, p.z, world, riverPoint);
    let gap = Infinity;
    for (const b of bounds) gap = Math.min(gap, Math.hypot(Math.max(0, b[0]! - riverPoint.x, riverPoint.x - b[1]!), Math.max(0, b[4]! - riverPoint.z, riverPoint.z - b[5]!)));
    const half = p.halfWidth * scale, t = Math.max(0, Math.min(1, (half + 2 * distance - gap) / distance));
    return reach * t * t * (3 - 2 * t);
  });
  return (i) => widths[i] ?? 0;
}

/**
 * Moves Global Water's grid to a new snapped centre: rest positions and extents only, allocation-free. Open water's
 * height, normal, current, bank distance, depth and mesh spacing are the same everywhere, so nothing else changes.
 */
function placeGlobalGrid(s: Surface, cx: number, cz: number): void {
  const xs = s.gridX, zs = s.gridZ, base = s.base, columns = xs.length - 1;
  for (let row = 0; row < zs.length; row++) {
    const z = cz + zs[row]!;
    for (let col = 0; col <= columns; col++) {
      const i = (row * (columns + 1) + col) * 3;
      base[i] = cx + xs[col]!; base[i + 2] = z;
    }
  }
  s.restMin.x = base[0]!; s.restMin.z = base[2]!;
  s.restMax.x = base[base.length - 3]!; s.restMax.z = base[base.length - 1]!;
}
