import { ArcRotateCamera, Matrix, Mesh, PBRMaterial, Vector3, VertexBuffer, VertexData, type AbstractMesh, type Camera, type Material, type Scene, type SubMesh } from "@babylonjs/core";
import {
  createDefaultWaterDefinition, createWaterWaveOutput, evaluateWaterVertex, normalizeWaterBody, normalizeWaterDefinition, waterBankFadeLength,
  waterEulerianGradient, waterFootprint, waterHorizontalEnvelope, waterRiverCentreline, waterWaveEnvelope, waterWaveQ, waterWaveSet,
  type WaterBodyProperties, type WaterDefinition,
} from "@babylonslate/core";
import { inActiveView } from "./active-view";
import { updateDynamicMaterialBounds } from "./material-bounds";
import { sceneWaterQualityDeviceClamp, sceneWaterQualityRevision } from "./render-settings";
import { requestWaterFft, updateSceneWaterFft } from "./water-fft";
import { configureWaterMaterial, contactRange, WaterMaterialPlugin } from "./water-material";
import { WaterContactField } from "./water-contact-field";
import { WaterField, type WaterFieldSurface } from "./water-field";
import { WaterReflection } from "./water-reflection";

/**
 * Inputs of a built grid, compared each frame without building strings: the world rotation/scale (0-11), then the
 * surface version, grid step, Global cell budget, Global centre and Global extent.
 */
const LAYOUT_STATE = 18;
const L_VERSION = 12, L_STEP = 13, L_BUDGET = 14, L_CX = 15, L_CZ = 16, L_EXTENT = 17;

type Surface = {
  mesh: Mesh; water: WaterDefinition; body: WaterBodyProperties; plugin: WaterMaterialPlugin | null;
  field: WaterField | null; contacts: WaterContactField | null;
  world: Matrix; inverse: Matrix;
  /**
   * The built-in material displaces the static rest grid in its vertex shader (`SLATE_WATER_GPU_WAVES`); Custom
   * Material water (and `setWaterGpuWaves(mesh, false)`) uploads CPU-displaced vertices every simulation step.
   */
  gpu: boolean;
  /** Inputs of the current grid (`LAYOUT_STATE`); NaN until built. */
  layoutState: Float64Array;
  /**
   * Global Water's grid lines relative to its snapped centre, in local units: a recentre adds the new centre to these
   * instead of building the grid again.
   */
  gridX: Float64Array; gridZ: Float64Array;
  /** Local extents of the rest grid, kept with it so bounds never rescan the vertices. */
  restMin: Vector3; restMax: Vector3;
  /** Local X/Z by which the last recentre moved the grid (shifts sub-mesh bounds). */
  shift: Float64Array;
  /** World matrix the per-vertex rest data was computed for; NaN forces a recompute. */
  placed: Float64Array;
  time: number | null; version: number;
  /** Project Water quality the grid was built for: the revision checked each frame, and its mesh density. */
  qualityRevision: number; density: number;
  /** Drawn by any pass since the last water update (the main view, a capture or another view's camera). */
  drawn: boolean;
  /**
   * Rest grid (local) and its world rest points. Every other per-vertex rest input (spacing, normals, current, bank
   * distance, depth) depends only on the volume's rotation and scale; `worldBase` is the CPU path's input and goes stale
   * on the GPU path while the volume only translates.
   */
  base: Float32Array; worldBase: Float32Array; positions: Float32Array; normals: Float32Array;
  baseNormals: Float32Array; data: Float32Array; flow: Float32Array; spacing: Float32Array;
  /** World X/Z Gerstner offset per vertex on the CPU path (the built-in shader subtracts it to find each fragment's rest point). */
  offsets: Float32Array;
  /** World X/Z direction in which each vertex's bank distance grows; the bank fade's gradient follows it. */
  bankGradient: Float32Array;
  /** Whether the last uploaded offsets were all zero, so calm water skips re-uploading them. */
  offsetsZero: boolean;
  /** Sub-meshes whose culling bounds were last padded (shadow partitioning may replace them later). */
  boundedSubMeshes: number; boundedFirst: SubMesh | null;
  /**
   * The vertex shader adds the FFT detail band's displacement (GPU path, band compiled in): finite bodies pad their
   * bounds by its horizontal bound too. `boundsDirty` re-pads at the next placement when this changes.
   */
  fftDisplaced: boolean; boundsDirty: boolean;
  /** Counted in `copyIntents`: a built-in surface that is enabled, itself and through its ancestors. */
  copyCounted: boolean;
};
const surfaces = new WeakMap<Scene, Set<Surface>>();
const surfaceByMesh = new WeakMap<AbstractMesh, Surface>();
/**
 * Enabled built-in (WaterMaterialPlugin) surfaces per Scene whose asset can sample a scene copy, so admission stays
 * O(1) per frame. An asset is fixed per surface: editing it rebuilds the mesh. Enabled state (an authored Enabled
 * off, or a deactivated actor) is followed by `syncCopyIntent`.
 */
const copyIntents = new WeakMap<Scene, { refracting: number; reflecting: number }>();
const clocks = new WeakMap<Scene, { time: number; runtime: boolean }>();
const reflections = new WeakMap<Scene, WaterReflection>();

export function setSceneWaterTime(scene: Scene, seconds: number): void {
  if (Number.isFinite(seconds)) clocks.set(scene, { time: seconds, runtime: true });
}

/**
 * Called once per scene render; runtime water advances only with the worker clock. Every enabled surface advances its
 * shader clock and keeps its grid and bounds current. Surfaces neither drawn last frame nor inside an active camera's
 * frustum skip their CPU vertex work (Custom Material water), their terrain and contact refreshes and their FFT detail
 * request until they are; the FFT simulations then update once for the whole scene.
 */
export function updateSceneWater(scene: Scene): void {
  const clock = clocks.get(scene) ?? { time: 0, runtime: false };
  if (!clock.runtime) clock.time += Math.min(0.1, scene.getEngine().getDeltaTime() / 1000 || 0);
  clocks.set(scene, clock);
  reflections.get(scene)?.sync();
  const entries = surfaces.get(scene);
  if (!entries) return;
  const now = performance.now();
  for (const surface of entries) {
    syncCopyIntent(scene, surface);
    if (!surface.mesh.isEnabled()) continue;
    placeSurface(surface, clock.time);
    const active = surface.drawn || inActiveView(scene, surface.mesh);
    surface.drawn = false;
    if (!active) continue;
    animateSurface(surface, clock.time);
    // Waves never rebake either field: the shader reads contacts at each fragment's rendered height.
    surface.field?.update();
    surface.contacts?.update(now);
    // Visible built-in water asks for its FFT detail band (it is already known to be drawn or in view); the
    // simulations run once below, after every request.
    if (surface.plugin) requestWaterFft(scene, surface.mesh, surface.water, surface.mesh.isVisible && surface.mesh.visibility > 0);
  }
  updateSceneWaterFft(scene, clock.time);
}

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
export const WATER_FINITE_CELL_BUDGET = 160;
export const WATER_RIVER_ROW_BUDGET = 512;
export const WATER_RIVER_COLUMN_BUDGET = 64;

/** Global Water cells per side for an effective resolution: even, at least 32 and at most the Global cap. */
function globalBudget(resolution: number): number {
  const cells = Math.round(resolution);
  return Math.min(WATER_GLOBAL_CELL_BUDGET, Math.max(32, cells + cells % 2));
}

/** Cells along one axis of a finite volume: world-sized and fixed, never camera-dependent. */
function uniformAxis(min: number, max: number, worldLength: number, step: number): number[] {
  const count = Math.min(WATER_FINITE_CELL_BUDGET, Math.max(12, Math.ceil(worldLength / step / 2) * 2));
  return Array.from({ length: count + 1 }, (_, i) => min + (max - min) * i / count);
}

type RiverRow = { x: number; z: number; tx: number; tz: number; halfWidth: number };

/** Rows across the sampled centreline, including rounded end caps that match the query footprint. */
function riverRows(body: WaterBodyProperties, sx: number, sz: number, step: number): RiverRow[] {
  const line = waterRiverCentreline(body);
  const rows: RiverRow[] = [];
  const tangent = (i: number) => {
    const a = line[Math.max(0, i - 1)]!, b = line[Math.min(line.length - 1, i + 1)]!;
    const dx = b.x - a.x, dz = b.z - a.z, length = Math.hypot(dx, dz) || 1;
    return [dx / length, dz / length] as const;
  };
  const cap = (index: number, direction: number) => {
    const p = line[index]!, [tx, tz] = tangent(index), count = 6;
    for (let k = 0; k < count; k++) {
      const f = direction < 0 ? 1 - k / count : (k + 1) / count;
      const outside = f * p.halfWidth;
      const halfWidth = Math.sqrt(Math.max(0, p.halfWidth * p.halfWidth - outside * outside));
      rows.push({ x: p.x + tx * outside * direction, z: p.z + tz * outside * direction, tx, tz, halfWidth });
    }
  };
  cap(0, -1);
  let budget = WATER_RIVER_ROW_BUDGET;
  for (let i = 0; i < line.length; i++) {
    const p = line[i]!, [tx, tz] = tangent(i);
    rows.push({ x: p.x, z: p.z, tx, tz, halfWidth: p.halfWidth });
    const next = line[i + 1];
    if (!next) break;
    const length = Math.hypot((next.x - p.x) * sx, (next.z - p.z) * sz);
    const splits = Math.max(1, Math.min(Math.ceil(length / step), Math.floor(budget / Math.max(1, line.length - i))));
    budget -= splits;
    const [nx, nz] = tangent(i + 1);
    for (let k = 1; k < splits; k++) {
      const t = k / splits, mx = tx + (nx - tx) * t, mz = tz + (nz - tz) * t, m = Math.hypot(mx, mz) || 1;
      rows.push({ x: p.x + (next.x - p.x) * t, z: p.z + (next.z - p.z) * t, tx: mx / m, tz: mz / m, halfWidth: p.halfWidth + (next.halfWidth - p.halfWidth) * t });
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
 * the built-in material follows its Shading Detail here too, which also reaches frozen Play materials. A material that
 * now samples the FFT detail band (or stops) in its vertex shader re-pads the culling bounds.
 */
function syncQuality(s: Surface): void {
  const scene = s.mesh.getScene(), revision = sceneWaterQualityRevision(scene);
  s.plugin?.syncQuality(scene);
  if (revision === s.qualityRevision) return;
  s.qualityRevision = revision;
  const density = sceneWaterQualityDeviceClamp(scene).quality.meshDensity;
  if (density !== s.density) { s.density = density; s.version++; }
  if (s.fftDisplaced !== (s.gpu && (s.plugin?.fftDetailCascades ?? 0) > 0)) s.boundsDirty = true;
}

const UNCHANGED = 0, RECENTRED = 1, REBUILT = 2;
type LayoutChange = typeof UNCHANGED | typeof RECENTRED | typeof REBUILT;

/**
 * Keeps the rest grid current. When Global Water's centre only moves by whole cells, the grid is the same one
 * translated (its lines are fixed offsets from the snapped centre, and every other rest input is uniform over open
 * water), so only its rest positions move: `RECENTRED`, with no per-vertex rest data, allocation or new buffers. Any
 * other input change builds a new grid: `REBUILT`.
 */
function updateLayout(s: Surface, world: Matrix, inverse: Matrix): LayoutChange {
  const { body, water, mesh } = s;
  const m = world.m;
  const sx = Math.hypot(m[0]!, m[1]!, m[2]!), sz = Math.hypot(m[8]!, m[9]!, m[10]!);
  // Water Mesh Density scales Surface Resolution; the cell caps bound the result.
  const resolution = body.resolution * s.density;
  const step = Math.max(0.025, water.waveLength / 12 * 48 / resolution);
  const budget = body.kind === "global" ? globalBudget(resolution) : 0;
  let cx = 0, cz = 0, extent = 0;
  if (body.kind === "global") {
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
  // Finite layouts depend only on the body and the volume's rotation/scale, so the camera never reshapes them.
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
    strip = riverRows(body, sx, sz, step);
    const widest = Math.max(...strip.map((row) => row.halfWidth)) * 2 * Math.max(sx, sz);
    const columns = Math.min(WATER_RIVER_COLUMN_BUDGET, Math.max(4, Math.ceil(widest / step / 2) * 2));
    xs = Array.from({ length: columns + 1 }, (_, i) => i / columns * 2 - 1);
    zs = strip.map((_, i) => i);
  } else {
    xs = uniformAxis(-body.width / 2, body.width / 2, body.width * sx, step);
    zs = uniformAxis(-body.length / 2, body.length / 2, body.length * sz, step);
  }
  const columns = xs.length - 1, rows = zs.length - 1, count = (columns + 1) * (rows + 1);
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
      // Mitred rows on widening bends can overhang the swept bank by millimetres; keep float32 vertices queryable.
      const bank = waterFootprint(body, x, z);
      if (bank.edge < 1e-4) { x += bank.edgeX * (bank.edge - 1e-4); z += bank.edgeZ * (bank.edge - 1e-4); }
    }
    else if (body.kind === "lake" || body.kind === "puddle") {
      const u = x * 2 / body.width, v = z * 2 / body.length;
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
  s.positions.set(base);
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
  return REBUILT;
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

const waveOut = createWaterWaveOutput(), slopeOut = new Float64Array(2);
const normalMatrix = new Matrix(), toLocalNormal = new Matrix();
const up = new Vector3(), across = new Vector3(), along = new Vector3(), boundsMin = new Vector3(), boundsMax = new Vector3(), boundsPad = new Vector3();
const point = new Vector3(), baseNormal = new Vector3(), localNormal = new Vector3(), flowVector = new Vector3(), edge = new Vector3();

/**
 * Culling bounds stay fixed while waves animate: the rest extents padded by the wave envelopes (horizontally only for
 * finite bodies, whose edges move with Gerstner waves), converted to local space. GPU-displaced vertices stay inside
 * them, fields keyed on the mesh bounds never rebuild per frame, and no per-frame extents pass runs.
 */
function updateBounds(s: Surface, world: Matrix, inverse: Matrix, recentred: boolean): void {
  s.boundsDirty = false;
  s.fftDisplaced = s.gpu && (s.plugin?.fftDetailCascades ?? 0) > 0;
  if (!s.base.length) return;
  const vertical = waterWaveEnvelope(s.water, s.body.waveScale);
  // The FFT detail band's horizontal displacement (λ = Steepness at most) stays within λ · its 4σ height; the vertical
  // envelope already includes the band.
  const detail = s.fftDisplaced ? s.water.steepness * waterWaveSet(s.water).detailHeight * s.water.detailWaves * Math.abs(s.body.waveScale) : 0;
  const horizontal = s.body.kind === "global" ? 0 : waterHorizontalEnvelope(s.water, s.body.waveScale) + detail;
  const m = inverse.m;
  boundsPad.set(
    Math.abs(m[0]!) * horizontal + Math.abs(m[4]!) * vertical + Math.abs(m[8]!) * horizontal,
    Math.abs(m[1]!) * horizontal + Math.abs(m[5]!) * vertical + Math.abs(m[9]!) * horizontal,
    Math.abs(m[2]!) * horizontal + Math.abs(m[6]!) * vertical + Math.abs(m[10]!) * horizontal,
  );
  updateDynamicMaterialBounds(s.mesh, boundsMin.copyFrom(s.restMin).subtractInPlace(boundsPad), boundsMax.copyFrom(s.restMax).addInPlace(boundsPad));
  const subMeshes = s.mesh.subMeshes ?? [];
  // Padded sub-mesh bounds that a recentre translated keep their padding; new or rebuilt ones rescan their vertices.
  const shift = recentred && subMeshes.length === s.boundedSubMeshes && (subMeshes[0] ?? null) === s.boundedFirst;
  for (const subMesh of subMeshes) if (!subMesh.IsGlobal) {
    if (shift) {
      const info = subMesh.getBoundingInfo();
      boundsMin.copyFrom(info.minimum).addInPlaceFromFloats(s.shift[0]!, 0, s.shift[1]!);
      boundsMax.copyFrom(info.maximum).addInPlaceFromFloats(s.shift[0]!, 0, s.shift[1]!);
      info.reConstruct(boundsMin, boundsMax, world);
      continue;
    }
    const info = subMesh.refreshBoundingInfo(s.base).getBoundingInfo();
    boundsMin.copyFrom(info.minimum).subtractInPlace(boundsPad); boundsMax.copyFrom(info.maximum).addInPlace(boundsPad);
    info.reConstruct(boundsMin, boundsMax, world);
  }
  s.boundedSubMeshes = subMeshes.length; s.boundedFirst = subMeshes[0] ?? null;
}

/**
 * Every frame for every enabled surface, allocation-free unless the grid is rebuilt: advances the shader clock and keeps
 * the grid and padded bounds current. Per-vertex rest data (base normals, current, bank distance, depth, spacing) depend
 * only on the grid and the volume's rotation and scale, so only a rebuilt grid or a rotated or scaled volume recomputes
 * and uploads them. On the GPU path a translated volume uploads nothing (the shader reads world positions) and a Global
 * recentre uploads only its rest positions; the CPU path re-derives its world rest points for its next animation step.
 */
function placeSurface(s: Surface, time: number): void {
  if (s.plugin) s.plugin.time = time;
  const placed = s.placed, m = s.mesh.computeWorldMatrix(true).m;
  let linear = false, translated = false;
  for (let i = 0; i < 12; i++) if (placed[i] !== m[i]) { linear = true; break; }
  for (let i = 12; i < 16; i++) if (placed[i] !== m[i]) { translated = true; break; }
  if (linear || translated) {
    // A degenerate (zero-scale) transform keeps the last valid placement until it becomes invertible again.
    const world = s.mesh.getWorldMatrix();
    if (Math.abs(world.determinant()) < 1e-12) return;
    s.world.copyFrom(world); world.invertToRef(s.inverse);
    for (let i = 0; i < 16; i++) placed[i] = m[i]!;
    // A level body can take the view's planar reflection; tilting a volume out of level recompiles without it.
    if (linear && s.plugin) s.plugin.flat = !restVaries(s);
  }
  const world = s.world, inverse = s.inverse;
  syncQuality(s);
  const layout = updateLayout(s, world, inverse);
  const rebuilt = linear || layout === REBUILT;
  const subMeshes = s.mesh.subMeshes ?? [];
  // A translation alone needs no new bounds: Babylon moves the local bounds with the world matrix.
  if (rebuilt || layout === RECENTRED || s.boundsDirty || subMeshes.length !== s.boundedSubMeshes || (subMeshes[0] ?? null) !== s.boundedFirst) {
    updateBounds(s, world, inverse, !rebuilt && !s.boundsDirty && layout === RECENTRED);
  }
  if (rebuilt) { placeRestData(s); return; }
  if (layout === RECENTRED && s.gpu) {
    s.positions.set(s.base);
    s.mesh.updateVerticesData(VertexBuffer.PositionKind, s.positions, false);
  }
  if ((layout === RECENTRED || translated) && !s.gpu) {
    for (let i = 0; i < s.base.length; i += 3) {
      Vector3.TransformCoordinatesFromFloatsToRef(s.base[i]!, s.base[i + 1]!, s.base[i + 2]!, world, point).toArray(s.worldBase, i);
    }
    s.time = null;
  }
}

/** Recomputes and uploads every per-vertex rest input of the current grid and placement. */
function placeRestData(s: Surface): void {
  const world = s.world, inverse = s.inverse;
  inverse.transposeToRef(normalMatrix);
  const depth = s.body.depth * Vector3.TransformNormalFromFloatsToRef(0, 1, 0, world, point).length();
  for (let i = 0; i < s.base.length; i += 3) {
    const x = s.base[i]!, y = s.base[i + 1]!, z = s.base[i + 2]!;
    const d = i / 3 * 4, v = i / 3 * 2;
    Vector3.TransformCoordinatesFromFloatsToRef(x, y, z, world, point).toArray(s.worldBase, i);
    const footprint = waterFootprint(s.body, x, z);
    baseNormal.set(-footprint.slopeX, 1, -footprint.slopeZ);
    // The GPU path's vertex normal is the rest normal: the fragment shader derives its own from the swell.
    if (s.gpu) localNormal.copyFrom(baseNormal).normalize().toArray(s.normals, i);
    Vector3.TransformNormalToRef(baseNormal, normalMatrix, baseNormal);
    baseNormal.scaleInPlace(baseNormal.y < 0 ? -1 : 1).normalize();
    baseNormal.toArray(s.baseNormals, i);
    edge.set(footprint.edgeX, 0, footprint.edgeZ); Vector3.TransformNormalToRef(edge, normalMatrix, edge);
    const outward = edge.length() || 1;
    s.bankGradient[v] = -edge.x / outward; s.bankGradient[v + 1] = -edge.z / outward;
    flowVector.set(footprint.flowX, footprint.flowY, footprint.flowZ); Vector3.TransformNormalToRef(flowVector, world, flowVector);
    flowVector.scaleInPlace(s.body.flowSpeed / Math.max(1e-6, Math.hypot(flowVector.x, flowVector.z))).toArray(s.flow, i);
    s.data[d + 1] = Math.min(10000, Math.max(0, footprint.edge / outward));
    s.data[d + 2] = depth;
    // The GPU path's static vertex inputs: the spacing filter replaces the CPU height; time is a uniform.
    if (s.gpu) { s.data[d] = s.spacing[i / 3]!; s.data[d + 3] = 0; }
  }
  s.mesh.updateVerticesData("slateWaterFlow", s.flow);
  s.mesh.updateVerticesData("slateWaterBaseNormal", s.baseNormals);
  if (s.gpu) {
    // A static rest grid: the vertex shader adds every displacement and computes its own offsets.
    if (!s.offsetsZero) { s.offsets.fill(0); s.offsetsZero = true; s.mesh.updateVerticesData("slateWaterOffset", s.offsets); }
    s.positions.set(s.base);
    s.mesh.updateVerticesData(VertexBuffer.PositionKind, s.positions, false);
    s.mesh.updateVerticesData(VertexBuffer.NormalKind, s.normals);
    s.mesh.updateVerticesData("slateWaterData", s.data);
  }
  // CPU vertices resample at the next animation step even while the clock is paused.
  s.time = null;
}

/** CPU path only: displaces the rest grid with `evaluateWaterVertex` at the simulation time and uploads it. */
function animateSurface(s: Surface, time: number): void {
  if (s.gpu || s.time === time || !s.base.length) return;
  const world = s.world, inverse = s.inverse;
  world.transposeToRef(toLocalNormal);
  // World-axis displacements (vertical waves, Gerstner X/Z offsets) expressed in the mesh's local space.
  Vector3.TransformNormalFromFloatsToRef(0, 1, 0, inverse, up);
  Vector3.TransformNormalFromFloatsToRef(1, 0, 0, inverse, across);
  Vector3.TransformNormalFromFloatsToRef(0, 0, 1, inverse, along);
  const set = waterWaveSet(s.water), scale = s.body.waveScale, o = waveOut;
  // Finite bodies fade the horizontal offset to zero at their banks, exactly as queries do (`waterBankGain`).
  const fadeLength = s.body.kind === "global" ? 0 : waterBankFadeLength(s.water, scale), gerstner = waterWaveQ(set, scale) > 0;
  for (let i = 0; i < s.base.length; i += 3) {
    const x = s.base[i]!, y = s.base[i + 1]!, z = s.base[i + 2]!;
    const d = i / 3 * 4, v = i / 3 * 2;
    // Forward evaluation at this vertex's world rest point: the mesh never inverts, queries do.
    evaluateWaterVertex(set, s.worldBase[i]!, s.worldBase[i + 2]!, time, s.spacing[i / 3]!, scale, s.data[d + 1]!, fadeLength, s.bankGradient[v]!, s.bankGradient[v + 1]!, o);
    const height = o[0]!, offsetX = o[1]!, offsetZ = o[2]!;
    s.offsets[v] = offsetX; s.offsets[v + 1] = offsetZ;
    s.positions[i] = x + up.x * height + across.x * offsetX + along.x * offsetZ;
    s.positions[i + 1] = y + up.y * height + across.y * offsetX + along.y * offsetZ;
    s.positions[i + 2] = z + up.z * height + across.z * offsetX + along.z * offsetZ;
    // Eulerian world slope J⁻ᵀ(∇rest + ∇H), the same normal a query at the displaced point reports.
    const ny = Math.max(1e-6, s.baseNormals[i + 1]!);
    waterEulerianGradient(o, o[3]! - s.baseNormals[i]! / ny, o[4]! - s.baseNormals[i + 2]! / ny, slopeOut);
    localNormal.set(-slopeOut[0]!, 1, -slopeOut[1]!);
    Vector3.TransformNormalToRef(localNormal, toLocalNormal, localNormal); localNormal.normalize().toArray(s.normals, i);
    s.data[d] = height; s.data[d + 3] = time;
  }
  s.mesh.updateVerticesData(VertexBuffer.PositionKind, s.positions, false);
  s.mesh.updateVerticesData(VertexBuffer.NormalKind, s.normals);
  s.mesh.updateVerticesData("slateWaterData", s.data);
  // Only built-in shading reads the offsets; calm water uploads its zeros once.
  if (s.plugin && (gerstner || !s.offsetsZero)) {
    s.mesh.updateVerticesData("slateWaterOffset", s.offsets);
    s.offsetsZero = !gerstner;
  }
  s.time = time;
}

/** A full update outside the frame loop: creation, handle edits and path switches. */
function refreshSurface(s: Surface, time: number): void {
  placeSurface(s, time);
  animateSurface(s, time);
}

const scratch = new Vector3();
/** Rest surface height (no waves) at a world X/Z, or null outside the body's footprint (unless `beyond`). */
function waterSurfaceY(s: Surface, x: number, z: number, beyond = false): number | null {
  Vector3.TransformCoordinatesFromFloatsToRef(x, s.world.m[13]!, z, s.inverse, scratch);
  const footprint = waterFootprint(s.body, scratch.x, scratch.z);
  if (!footprint.inside && !beyond) return null;
  Vector3.TransformCoordinatesFromFloatsToRef(scratch.x, footprint.height, scratch.z, s.world, scratch);
  return scratch.y;
}

/** Rivers and volumes tilted out of the horizontal have a rest height that varies across the body. */
const restVaries = (s: Surface) => s.body.kind === "river" || Math.abs(s.world.m[1]!) > 1e-9 || Math.abs(s.world.m[9]!) > 1e-9;

/**
 * Whether any live built-in water in `scene` (a custom material has no WaterMaterialPlugin) has an asset that samples
 * the scene copy under the given device-effective features: Refraction above zero while refraction runs, or Object
 * Reflections while a screen-space march runs. The scene-level form of `waterMeshSamplesSceneCopy`; O(1).
 */
export function sceneWaterSamplesSceneCopy(scene: Scene, refraction: boolean, screenSpace: boolean): boolean {
  const intents = copyIntents.get(scene);
  return intents !== undefined && ((refraction && intents.refracting > 0) || (screenSpace && intents.reflecting > 0));
}

/**
 * Counts a built-in surface's copy intent only while it is enabled, itself and through its ancestors (a deactivated
 * actor disables its children without notifying them, so the water update checks every frame: O(1), no allocation).
 * Disabled water therefore keeps no copy, own pair or ledger charge planned; enabling it re-plans the view's graph.
 */
function syncCopyIntent(scene: Scene, s: Surface): void {
  const counted = s.plugin !== null && !s.mesh.isDisposed() && s.mesh.isEnabled();
  if (counted === s.copyCounted) return;
  s.copyCounted = counted;
  countCopyIntent(scene, s.water, counted ? 1 : -1);
}

function countCopyIntent(scene: Scene, water: WaterDefinition, delta: 1 | -1): void {
  let intents = copyIntents.get(scene);
  if (!intents) { intents = { refracting: 0, reflecting: 0 }; copyIntents.set(scene, intents); }
  if (water.refraction > 0) intents.refracting = Math.max(0, intents.refracting + delta);
  if (water.objectReflections) intents.reflecting = Math.max(0, intents.reflecting + delta);
}

/**
 * Whether `mesh` is built-in water whose asset can sample the view's scene copy: Refraction above zero while
 * refraction runs, or Object Reflections while a screen-space march runs. A per-frame check: no allocation.
 */
export function waterMeshSamplesSceneCopy(mesh: AbstractMesh, refraction: boolean, screenSpace: boolean): boolean {
  if ((mesh.metadata as { slateWater?: unknown } | null)?.slateWater !== true) return false;
  const surface = surfaceByMesh.get(mesh);
  if (!surface?.plugin) return false;
  return (refraction && surface.water.refraction > 0) || (screenSpace && surface.water.objectReflections);
}

/** The live body of a built water mesh, or null for other meshes. */
export function waterMeshBody(mesh: Mesh): Readonly<WaterBodyProperties> | null {
  return surfaceByMesh.get(mesh)?.body ?? null;
}

/**
 * Whether a built water mesh's rest height varies across it (a river, or a volume tilted out of level), the same
 * test its WaterField and contacts use; null for other meshes. A level body rests on its local y = 0 plane.
 */
export function waterMeshRestVaries(mesh: Mesh): boolean | null {
  const surface = surfaceByMesh.get(mesh);
  return surface ? restVaries(surface) : null;
}

/**
 * Reshape a water mesh in place, e.g. while an editor handle drags. The authored
 * component remains the source of truth; a committed change rebuilds the mesh.
 */
export function updateWaterMeshBody(mesh: Mesh, input: unknown): boolean {
  const surface = surfaceByMesh.get(mesh);
  if (!surface) return false;
  Object.assign(surface.body, normalizeWaterBody(input, surface.body.kind));
  surface.version++; surface.placed.fill(NaN);
  mesh.setEnabled(surface.body.enabled);
  syncCopyIntent(mesh.getScene(), surface);
  refreshSurface(surface, clocks.get(mesh.getScene())?.time ?? 0);
  surface.field?.update(true);
  surface.contacts?.update(performance.now(), true);
  return true;
}

/**
 * Switch a built-in water surface between GPU vertex waves (the default) and CPU-displaced vertices, e.g. for a
 * CPU-vs-GPU parity capture. Custom Material water always uses the CPU path. Returns false for other meshes.
 */
export function setWaterGpuWaves(mesh: Mesh, enabled: boolean): boolean {
  const surface = surfaceByMesh.get(mesh);
  if (!surface?.plugin) return false;
  if (surface.gpu === enabled) return true;
  surface.gpu = enabled;
  surface.plugin.gpuWaves = enabled;
  // The previous shader must never draw the new vertex layout (it would displace CPU-displaced vertices again): skip
  // the surface while the new variant compiles, then restore shader hot swapping at its first bind.
  const material = mesh.material;
  if (material?.allowShaderHotSwapping) {
    material.allowShaderHotSwapping = false;
    material.onBindObservable.addOnce(() => { material.allowShaderHotSwapping = true; });
  }
  // The vertex data layout changes with the path: rewrite every static attribute.
  surface.placed.fill(NaN);
  refreshSurface(surface, clocks.get(mesh.getScene())?.time ?? 0);
  return true;
}

/** Finite volumes keep fixed bounds; only Global Water Volume follows the camera. */
export function createWaterMesh(scene: Scene, name: string, input: WaterBodyProperties, definition?: WaterDefinition, customMaterial?: Material | null): Mesh {
  const body = normalizeWaterBody(input, input.kind), water = normalizeWaterDefinition(definition ?? createDefaultWaterDefinition());
  const mesh = new Mesh(name, scene);
  mesh.setEnabled(body.enabled);
  mesh.metadata = { ...(mesh.metadata ?? {}), slateWater: true };
  let plugin: WaterMaterialPlugin | null = null;
  if (customMaterial) mesh.material = customMaterial;
  else {
    const material = new PBRMaterial(`${name}:water`, scene);
    configureWaterMaterial(material, water);
    plugin = new WaterMaterialPlugin(material, water, body);
    plugin.mesh = mesh;
    plugin.gpuWaves = true;
    // Unlit Stylized water never samples a reflection.
    if (water.style !== "stylized") {
      let reflection = reflections.get(scene);
      if (!reflection) { reflection = new WaterReflection(scene); reflections.set(scene, reflection); }
      reflection.add(material);
    }
    mesh.material = material;
    mesh.onDisposeObservable.addOnce(() => material.dispose());
  }
  const empty = new Float32Array();
  const surface: Surface = {
    mesh, water, body, plugin, field: null, contacts: null, world: Matrix.Identity(), inverse: Matrix.Identity(), gpu: plugin !== null,
    layoutState: new Float64Array(LAYOUT_STATE).fill(NaN), gridX: new Float64Array(), gridZ: new Float64Array(),
    restMin: new Vector3(), restMax: new Vector3(), shift: new Float64Array(2), placed: new Float64Array(16).fill(NaN), time: null, version: 0,
    qualityRevision: NaN, density: 1, drawn: true,
    base: empty, worldBase: empty, positions: empty, normals: empty, baseNormals: empty, data: empty, flow: empty, spacing: empty,
    offsets: empty, bankGradient: empty, offsetsZero: true, boundedSubMeshes: -1, boundedFirst: null, fftDisplaced: false, boundsDirty: false,
    copyCounted: false,
  };
  let entries = surfaces.get(scene);
  if (!entries) {
    entries = new Set(); surfaces.set(scene, entries);
    const observer = scene.onBeforeRenderObservable.add(() => updateSceneWater(scene));
    scene.onDisposeObservable.addOnce(() => { scene.onBeforeRenderObservable.remove(observer); surfaces.delete(scene); clocks.delete(scene); reflections.delete(scene); });
  }
  entries.add(surface);
  surfaceByMesh.set(mesh, surface);
  // Any pass that draws the surface (views, captures, depth pre-pass) keeps its CPU work running next frame.
  mesh.onBeforeRenderObservable.add(() => { surface.drawn = true; });
  syncCopyIntent(scene, surface);
  mesh.onDisposeObservable.addOnce(() => {
    entries.delete(surface);
    if (surface.copyCounted) countCopyIntent(scene, water, -1);
    surface.copyCounted = false;
  });
  refreshSurface(surface, clocks.get(scene)?.time ?? 0);
  if (plugin) {
    const fieldSurface: WaterFieldSurface = {
      mesh, unbounded: body.kind === "global", contactRange: contactRange(water),
      // The envelope bounds |H| exactly; the margin keeps the outermost contact layers off the clamp.
      get amplitude() { return waterWaveEnvelope(water, body.waveScale) + 0.05; },
      // Contact Resolution caps the contact texture's cells per side; a change rebuilds it.
      get contactCells() { return sceneWaterQualityDeviceClamp(scene).quality.contactResolution; },
      surfaceY: (x, z) => waterSurfaceY(surface, x, z),
      get restVaries() { return restVaries(surface); },
      restY: (x, z) => waterSurfaceY(surface, x, z, true)!,
    };
    const field = new WaterField(scene, fieldSurface), contacts = new WaterContactField(scene, fieldSurface);
    surface.field = field; surface.contacts = contacts;
    plugin.field = field; plugin.contacts = contacts;
    field.update(true);
    contacts.update(performance.now(), true);
    mesh.onDisposeObservable.addOnce(() => { field.dispose(); contacts.dispose(); });
  }
  return mesh;
}
