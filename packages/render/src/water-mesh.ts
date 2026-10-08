import { isSceneGameTimePaused } from "./scene-game-time";
import { ArcRotateCamera, Matrix, Mesh, PBRMaterial, Quaternion, Vector3, VertexBuffer, VertexData, type AbstractMesh, type Camera, type Material, type Scene, type SubMesh } from "@babylonjs/core";
import {
  createDefaultWaterDefinition, createWaterBlendSample, createWaterWaveOutput, evaluateWaterBlend, evaluateWaterVertex, MAX_WATER_BLEND_DISTANCE, normalizeWaterBody,
  normalizeWaterDefinition, waterBankFadeLength, WaterBlendIndex, waterEulerianGradient, waterFootprint, waterHorizontalEnvelope,
  waterRiverCentreline, waterWaveEnvelope, waterWaveQ, waterWaveSet,
  type Transform, type WaterBlendBody, type WaterBodyProperties, type WaterDefinition,
} from "@babylonslate/core";
import { inActiveView } from "./active-view";
import { updateDynamicMaterialBounds } from "./material-bounds";
import { sceneWaterBlendDistance, sceneWaterQualityDeviceClamp, sceneWaterQualityRevision } from "./render-settings";
import { requestWaterFft, updateSceneWaterFft } from "./water-fft";
import { applyWaterMaterialScalars, configureWaterMaterial, contactRange, WaterMaterialPlugin } from "./water-material";
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
  /** Cells per row of the current grid. */
  layoutColumns: number;
  /** Sub-meshes whose culling bounds were last padded (shadow partitioning may replace them later). */
  boundedSubMeshes: number; boundedFirst: SubMesh | null;
  /**
   * The vertex shader adds the FFT detail band's displacement (GPU path, band compiled in): finite bodies pad their
   * bounds by its horizontal bound too. `boundsDirty` re-pads at the next placement when this changes.
   */
  fftDisplaced: boolean; boundsDirty: boolean;
  /** Counted in `copyIntents`: a built-in surface that is enabled, itself and through its ancestors. */
  copyCounted: boolean;
  /** Process-unique id: blending orders and identifies surfaces by it. */
  uid: number;
  /** When the water update first found the surface disabled (performance.now), or -1 while it is enabled. */
  disabledSince: number;
  /** Its terrain and contact textures were released after it stayed disabled (`WATER_RELEASE_DISABLED_MS`). */
  released: boolean;
  /** Blending with neighbours (`syncSceneBlend`), or null while it blends with nothing. */
  blend: SurfaceBlend | null;
  /**
   * Per vertex while blending: (swell height scale, Gerstner offset scale, ownership margin, partner-colour share) as
   * the `slateWaterBlend` attribute, and the blended union bank distance, depth, current (x, y, z) and world rest height.
   */
  blendData: Float32Array; blendRest: Float32Array;
  /** Bumped by in-place body and asset edits: neighbours rebuild their blend data. */
  blendRevision: number;
  /** World matrix and enabled state the blend pass last saw. */
  blendMatrix: Float64Array; blendEnabled: boolean;
  /** Bumped whenever `blendMatrix` changes: neighbours' blend data keys compare it instead of the matrix. */
  blendStamp: number;
  /**
   * Global Water only: the first and last grid rows (inclusive) whose blend data the last write placed within a
   * neighbour's reach; empty (first > last) when none. Rows outside it hold open water's uniform rest data.
   */
  blendRows: Int32Array;
};
type SurfaceBlend = {
  /** This surface's body in the scene's `WaterBlendIndex`. */
  self: number;
  /** World metres the rest grid extends past the footprint toward finite neighbours (half the distance), else 0. */
  reach: number;
  /**
   * Identity of everything this surface's blend data depends on (rebuilt only when it changes): the distance, the grid
   * extension, this surface's stamp and revision, then each neighbour's uid, stamp and revision.
   */
  key: number[];
  /** When the blend data was last rebuilt (performance.now). */
  built: number;
  /** Blending tilts the rest height somewhere on this surface. */
  restVaries: boolean;
  /** The largest swell height scale over the grid (a calmer body takes a rougher neighbour's waves near the seam). */
  heightScale: number;
  /** New blend data for the same grid (a neighbour moved or changed): the next placement rewrites rest data only. */
  refresh: boolean;
};
/**
 * One scene's blending: its index of enabled surfaces and the distance it was built for. `waiting` is set while a
 * moved surface's neighbours keep their previous blend data (`WATER_BLEND_REFRESH_MS`).
 */
type SceneBlend = { index: WaterBlendIndex; distance: number; dirty: boolean; waiting: boolean; members: Surface[] };

/**
 * While blending surfaces move (a dragged, animated or tide-driven body), each surface rebuilds its blend data at most
 * this often (milliseconds), keeping the previous data in between; the last move always lands once the interval
 * passes. A grid that must be rebuilt (a new grid extension, a rotation out of level) never waits.
 */
export const WATER_BLEND_REFRESH_MS = 200;
const blendKey: number[] = [];
const sceneBlends = new WeakMap<Scene, SceneBlend>();
let surfaceIds = 0;
const surfaces = new WeakMap<Scene, Set<Surface>>();
const surfaceByMesh = new WeakMap<AbstractMesh, Surface>();
/**
 * Enabled built-in (WaterMaterialPlugin) surfaces per Scene whose asset can sample a scene copy, so admission stays
 * O(1) per frame. An in-place asset edit (`updateWaterMeshDefinition`) moves the surface's count to the new values;
 * enabled state (an authored Enabled off, or a deactivated actor) is followed by `syncCopyIntent`.
 */
const copyIntents = new WeakMap<Scene, { refracting: number; reflecting: number }>();
/**
 * A scene's water clock. Without runtime times (editor viewport, asset previews) it follows real time and stops
 * while game time is paused. Play keeps the simulated water time the worker's physics step evaluated for each
 * snapshot frame (a short history) and draws the time interpolated between the two frames of the applied snapshot
 * sample, exactly as actor poses are: at a published frame the rendered water is the water physics saw.
 */
type SceneWaterClock = {
  time: number;
  runtime: boolean;
  /** Snapshot frame ids with runtime water times (ascending, newest last). */
  frames: number[];
  times: number[];
  /** The applied snapshot sample (`sampleSceneWaterFrame`). */
  frameId: number;
  previousFrameId: number;
  alpha: number;
};
/** Runtime water times retained per scene; a render delayed by more frames draws the oldest retained time. */
const WATER_FRAME_HISTORY = 8;
const clocks = new WeakMap<Scene, SceneWaterClock>();
const reflections = new WeakMap<Scene, WaterReflection>();

/** Milliseconds a water surface stays disabled before it gives back its terrain and contact textures (GPU memory). */
export const WATER_RELEASE_DISABLED_MS = 2000;
/** Released surfaces that restore their terrain and contact textures in one frame when enabled again. */
export const WATER_RESTORES_PER_FRAME = 2;

function sceneClock(scene: Scene): SceneWaterClock {
  let clock = clocks.get(scene);
  if (!clock) {
    clock = { time: 0, runtime: false, frames: [], times: [], frameId: NaN, previousFrameId: NaN, alpha: 1 };
    clocks.set(scene, clock);
  }
  return clock;
}

/**
 * Sets the scene's water time; from then on it advances only through this call. With `frameId` (Play) the time is
 * the one the worker's physics step evaluated for that snapshot frame, kept for `sampleSceneWaterFrame`; a frame id
 * at or before the newest one starts the history again (a new session).
 */
export function setSceneWaterTime(scene: Scene, seconds: number, frameId?: number): void {
  if (!Number.isFinite(seconds)) return;
  const clock = sceneClock(scene);
  clock.time = seconds;
  clock.runtime = true;
  const { frames, times } = clock;
  const paired = frameId !== undefined && Number.isFinite(frameId);
  if (!paired || (frames.length && frameId <= frames[frames.length - 1]!)) frames.length = times.length = 0;
  if (!paired) return;
  frames.push(frameId); times.push(seconds);
  if (frames.length > WATER_FRAME_HISTORY) { frames.shift(); times.shift(); }
}

/** Pairs the water with the applied actor snapshot sample: its frame, previous frame and interpolation alpha. */
export function sampleSceneWaterFrame(scene: Scene, frameId: number, previousFrameId: number, alpha: number): void {
  const clock = sceneClock(scene);
  clock.frameId = frameId; clock.previousFrameId = previousFrameId; clock.alpha = alpha;
}

/** The newest runtime time sent for `frameId` or an earlier frame; the oldest retained one for an older frame. */
function frameWaterTime(clock: SceneWaterClock, frameId: number): number {
  for (let i = clock.frames.length - 1; i >= 0; i--) if (clock.frames[i]! <= frameId) return clock.times[i]!;
  return clock.times[0]!;
}

/** The time the scene's water draws at now. */
function sceneWaterTime(scene: Scene): number {
  const clock = clocks.get(scene);
  if (!clock) return 0;
  if (!clock.runtime || !clock.frames.length || !Number.isFinite(clock.frameId)) return clock.time;
  const next = frameWaterTime(clock, clock.frameId);
  const previous = Number.isFinite(clock.previousFrameId) ? frameWaterTime(clock, clock.previousFrameId) : next;
  return previous + (next - previous) * Math.max(0, Math.min(1, clock.alpha));
}

/**
 * Called once per scene render; runtime water advances only with the worker clock. Every enabled surface advances its
 * shader clock and keeps its grid and bounds current. Surfaces neither drawn last frame nor inside an active camera's
 * frustum skip their CPU vertex work (Custom Material water), their terrain and contact refreshes and their FFT detail
 * request until they are; the FFT simulations then update once for the whole scene.
 */
export function updateSceneWater(scene: Scene): void {
  const clock = sceneClock(scene);
  if (!clock.runtime && !isSceneGameTimePaused(scene)) clock.time += Math.min(0.1, scene.getEngine().getDeltaTime() / 1000 || 0);
  const time = sceneWaterTime(scene);
  reflections.get(scene)?.sync();
  const entries = surfaces.get(scene);
  if (!entries) return;
  syncSceneBlend(scene, entries);
  const now = performance.now();
  let restored = 0;
  for (const surface of entries) {
    syncCopyIntent(scene, surface);
    if (!surface.mesh.isEnabled()) {
      // Water disabled for a while gives back its terrain and contact textures (their CPU data stays); enabling it
      // uploads them again, rebuilding only what changed meanwhile.
      if (surface.disabledSince < 0) surface.disabledSince = now;
      else if (!surface.released && now - surface.disabledSince >= WATER_RELEASE_DISABLED_MS) {
        surface.field?.releaseTexture(); surface.contacts?.releaseTexture(); surface.released = surface.field !== null;
      }
      continue;
    }
    surface.disabledSince = -1;
    placeSurface(surface, time);
    // Re-enabled water restores its textures after its placement, a few surfaces per frame (streaming in a section that
    // enables many bodies spreads the work); the rest draw without them until their turn.
    if (surface.released && restored < WATER_RESTORES_PER_FRAME) {
      restored++;
      surface.released = false; surface.field?.restore(); surface.contacts?.restore(now);
    }
    const active = surface.drawn || inActiveView(scene, surface.mesh);
    surface.drawn = false;
    if (!active) continue;
    animateSurface(surface, time);
    // Waves never rebake either field: the shader reads contacts at each fragment's rendered height.
    surface.field?.update();
    surface.contacts?.update(now);
    // Visible built-in water asks for its FFT detail band (it is already known to be drawn or in view); the
    // simulations run once below, after every request.
    if (surface.plugin) requestWaterFft(scene, surface.mesh, surface.water, surface.mesh.isVisible && surface.mesh.visibility > 0);
  }
  updateSceneWaterFft(scene, time);
}

const blendPosition = new Vector3(), blendScaling = new Vector3(), blendRotation = new Quaternion();

/**
 * Keeps each surface's neighbours current (`WaterBlendIndex`), once per frame before placement. Water that blends with
 * nothing pays nothing: with the distance at 0 or a single surface and no blend in place, this returns at once; while
 * surfaces blend, a frame without changes costs one comparison of each surface's world matrix. A changed distance, a
 * moved, enabled, created, disposed or edited surface rebuilds the index; only surfaces whose own placement or
 * neighbours changed get new blend data (a rebuilt rest grid at their placement this frame).
 */
function syncSceneBlend(scene: Scene, entries: Set<Surface>): void {
  const distance = sceneWaterBlendDistance(scene);
  let state = sceneBlends.get(scene);
  if (!state) {
    if (distance === 0 || entries.size < 2) return;
    state = { index: new WaterBlendIndex(), distance: -1, dirty: true, waiting: false, members: [] };
    sceneBlends.set(scene, state);
  }
  let dirty = state.dirty || state.distance !== distance || state.waiting;
  if (!dirty) {
    // Nothing can blend until a surface is added, or the distance changes (each marks the state dirty).
    if (state.distance === 0 || entries.size < 2) return;
    for (const s of entries) {
      const enabled = s.mesh.isEnabled();
      if (enabled !== s.blendEnabled) { dirty = true; break; }
      if (!enabled) continue;
      const m = s.mesh.computeWorldMatrix(!s.mesh.isSynchronized()).m, seen = s.blendMatrix;
      for (let i = 0; i < 16; i++) if (seen[i] !== m[i]) { dirty = true; break; }
      if (dirty) break;
    }
    if (!dirty) return;
  }
  const waiting = state.waiting;
  state.dirty = false; state.distance = distance; state.waiting = false;
  const members: Surface[] = [], bodies: WaterBlendBody[] = [];
  for (const s of entries) {
    s.blendEnabled = s.mesh.isEnabled();
    const world = s.mesh.computeWorldMatrix(true), m = world.m, seen = s.blendMatrix;
    for (let i = 0; i < 16; i++) if (seen[i] !== m[i]) { seen.set(m); s.blendStamp++; break; }
    if (!s.blendEnabled || distance === 0 || Math.abs(world.determinant()) < 1e-12) continue;
    world.decompose(blendScaling, blendRotation, blendPosition);
    const transform: Transform = {
      position: { x: blendPosition.x, y: blendPosition.y, z: blendPosition.z },
      rotation: { x: blendRotation.x, y: blendRotation.y, z: blendRotation.z, w: blendRotation.w },
      scale: { x: blendScaling.x, y: blendScaling.y, z: blendScaling.z },
    };
    members.push(s); bodies.push({ definition: s.water, body: s.body, transform, revision: s.blendRevision });
  }
  state.members = members;
  if (!state.index.update(bodies, distance) && !waiting && members.every((s, i) => s.blend?.self === i || !state!.index.neighbours(i).length)) return;
  const index = state.index, now = performance.now(), key = blendKey;
  for (const s of entries) {
    const self = members.indexOf(s), neighbours = self < 0 ? [] : index.neighbours(self);
    if (!neighbours.length) {
      if (s.blend) { s.blend = null; s.version++; if (s.plugin) { s.plugin.blend = false; s.plugin.partner = null; } }
      continue;
    }
    let finite = false;
    for (const j of neighbours) if (Number.isFinite(index.bodies[j]!.bounds[0]!)) { finite = true; break; }
    const reach = finite && s.body.kind !== "global" ? distance / 2 : 0;
    // This surface's placement and revision, then each neighbour's: blend data depends on nothing else.
    key.length = 0;
    key.push(distance, reach, s.blendStamp, s.blendRevision);
    for (const j of neighbours) key.push(members[j]!.uid, members[j]!.blendStamp, members[j]!.blendRevision);
    const previous = s.blend;
    if (previous && previous.key.length === key.length && previous.key.every((value, i) => value === key[i])) { previous.self = self; continue; }
    // A level surface whose grid extension is unchanged keeps its grid and rewrites only its rest data; anything else
    // builds a new grid.
    const level = Math.abs(s.blendMatrix[1]!) < 1e-9 && Math.abs(s.blendMatrix[9]!) < 1e-9;
    const refresh = previous !== null && previous.reach === reach && level;
    // Moving neighbours: keep the previous blend data until the refresh interval passes.
    if (refresh && now - previous.built < WATER_BLEND_REFRESH_MS) { previous.self = self; state.waiting = true; continue; }
    s.blend = { self, reach, key: key.slice(), built: now, restVaries: false, heightScale: 1, refresh };
    if (refresh) s.boundsDirty = true;
    else s.version++;
    if (s.plugin) s.plugin.blend = true;
  }
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
  if (s.fftDisplaced !== (s.gpu && (s.plugin?.fftVertexCascades ?? 0) > 0)) s.boundsDirty = true;
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
  // The finest spacing decides whether the vertex stage can resolve any of the FFT detail band (a recentre keeps it).
  if (s.plugin) {
    let finest = Infinity;
    for (let index = 0; index < s.spacing.length; index++) finest = Math.min(finest, s.spacing[index]!);
    s.plugin.meshSpacing = finest;
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
  if (s.blend) {
    s.blendData = new Float32Array(count * 4); s.blendRest = new Float32Array(count * 6);
    mesh.setVerticesData("slateWaterBlend", s.blendData, true, 4);
  } else if (mesh.isVerticesDataPresent("slateWaterBlend")) {
    mesh.removeVerticesData("slateWaterBlend");
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

const blendSample = createWaterBlendSample(), blendPoint = new Vector3(), blendLift = new Vector3();
const blendPartners = new Map<number, number>();

/** Whether world X/Z lies within `reach` of any of `bounds` (min X, max X, ..., min Z, max Z). */
function inBlendReach(bounds: readonly Float64Array[], reach: number, x: number, z: number): boolean {
  for (let n = 0; n < bounds.length; n++) {
    const b = bounds[n]!;
    if (x >= b[0]! - reach && x <= b[1]! + reach && z >= b[4]! - reach && z <= b[5]! + reach) return true;
  }
  return false;
}

/** World bounds of a blending surface's neighbours, in neighbour order (reused scratch). */
const neighbourBounds: Float64Array[] = [];
function blendNeighbourBounds(state: SceneBlend, self: number): Float64Array[] {
  const list = state.index.neighbours(self);
  neighbourBounds.length = 0;
  for (const j of list) neighbourBounds.push(state.index.bodies[j]!.bounds);
  return neighbourBounds;
}

/**
 * Blended rest data of a blending surface's grid (`evaluateWaterBlend` at each vertex's world rest point): lifts the rest
 * grid to the blended rest height and fills `blendData` (the vertex attribute) and `blendRest` (union bank distance,
 * depth, current and world rest height, which `placeRestData` uploads), then the rest extents. Picks the partner whose
 * colours the most vertices mix toward. On change only: a rebuilt grid, a rotated or scaled volume, or a recentred
 * Global grid. With a vertex range (`first` to `end`), only those vertices are rewritten (Global Water's rows near a
 * neighbour, `placeGlobalBlend`): the rest extents then cover open water's plane and the range, and the height scale
 * and partner come from the range alone (open water outside it has neither).
 */
function placeBlend(s: Surface, world: Matrix, inverse: Matrix, first = 0, end = s.base.length / 3): void {
  const state = sceneBlends.get(s.mesh.getScene()), blend = s.blend;
  if (!state || !blend) return;
  const base = s.base, data = s.blendData, rest = s.blendRest, sample = blendSample;
  const partners = blendPartners;
  partners.clear();
  let varies = false;
  Vector3.TransformNormalFromFloatsToRef(0, 1, 0, inverse, blendLift);
  const ranged = first > 0 || end < base.length / 3;
  // A range leaves open water's plane (local y = 0) everywhere else.
  if (ranged) { s.restMin.y = 0; s.restMax.y = 0; }
  else { s.restMin.setAll(Infinity); s.restMax.setAll(-Infinity); }
  // Vertices beyond every neighbour's reach keep the body's own rest data (most of a Global grid): no kernel call.
  const reach = state.distance / 2, near = blendNeighbourBounds(state, blend.self);
  const open = s.body.kind === "global";
  for (let v = first; v < end; v++) {
    const i = v * 3, d = v * 4, r = v * 6;
    // The own rest height first (a recentred Global grid keeps the previous lift; its own plane is at 0).
    base[i + 1] = open ? 0 : waterFootprint(s.body, base[i]!, base[i + 2]!).height;
    Vector3.TransformCoordinatesFromFloatsToRef(base[i]!, base[i + 1]!, base[i + 2]!, world, blendPoint);
    if (!inBlendReach(near, reach, blendPoint.x, blendPoint.z)) {
      // NaN marks the body's own rest data for `placeRestData`.
      data[d] = 1; data[d + 1] = 1; data[d + 2] = 1; data[d + 3] = 0;
      rest[r] = NaN; rest[r + 5] = blendPoint.y;
    } else if (evaluateWaterBlend(state.index, blend.self, blendPoint.x, blendPoint.y, blendPoint.z, sample)) {
      const lift = sample.restHeight - sample.ownRestHeight;
      if (Math.abs(lift) > 1e-4) varies = true;
      base[i] = base[i]! + blendLift.x * lift; base[i + 1] = base[i + 1]! + blendLift.y * lift; base[i + 2] = base[i + 2]! + blendLift.z * lift;
      data[d] = sample.heightScale; data[d + 1] = sample.offsetScale; data[d + 2] = sample.margin; data[d + 3] = sample.foreign;
      rest[r] = Math.max(-1e4, Math.min(1e4, sample.union)); rest[r + 1] = sample.depth;
      rest[r + 2] = sample.flowX; rest[r + 3] = sample.flowY; rest[r + 4] = sample.flowZ; rest[r + 5] = sample.restHeight;
      if (sample.partner >= 0) partners.set(sample.partner, (partners.get(sample.partner) ?? 0) + sample.foreign);
    } else {
      // No water of this body here: outside the union and owned by nobody, so the fragment discards.
      data[d] = 0; data[d + 1] = 0; data[d + 2] = -1; data[d + 3] = 0;
      rest[r] = -1; rest[r + 1] = 0; rest[r + 2] = rest[r + 3] = rest[r + 4] = 0; rest[r + 5] = blendPoint.y;
    }
    if (ranged) {
      s.restMin.y = Math.min(s.restMin.y, base[i + 1]!); s.restMax.y = Math.max(s.restMax.y, base[i + 1]!);
    } else {
      s.restMin.minimizeInPlaceFromFloats(base[i]!, base[i + 1]!, base[i + 2]!);
      s.restMax.maximizeInPlaceFromFloats(base[i]!, base[i + 1]!, base[i + 2]!);
    }
  }
  blend.restVaries = varies;
  let highest = 1;
  for (let d = first * 4; d < end * 4; d += 4) highest = Math.max(highest, data[d]!);
  blend.heightScale = highest;
  let partner = -1, most = 0;
  for (const [index, weight] of partners) if (weight > most) { most = weight; partner = index; }
  if (s.plugin) s.plugin.partner = partner >= 0 ? state.index.bodies[partner]!.definition : null;
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
  s.fftDisplaced = s.gpu && (s.plugin?.fftVertexCascades ?? 0) > 0;
  if (!s.base.length) return;
  // A blending surface can take a rougher neighbour's waves near the seam: pad by its largest swell scale.
  const blendScale = s.blend ? s.blend.heightScale * (s.plugin?.waveScale ?? s.body.waveScale) : s.body.waveScale;
  const vertical = waterWaveEnvelope(s.water, blendScale);
  // The FFT detail band's horizontal displacement (λ = Steepness at most) stays within λ · its 4σ height; the vertical
  // envelope already includes the band.
  const detail = s.fftDisplaced ? s.water.steepness * waterWaveSet(s.water).detailHeight * s.water.detailWaves * Math.abs(s.body.waveScale) : 0;
  const horizontal = s.body.kind === "global" ? 0 : waterHorizontalEnvelope(s.water, blendScale) + detail;
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
  const placed = s.placed, m = s.mesh.computeWorldMatrix(!s.mesh.isSynchronized()).m;
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
  // A blending surface lifts its grid to the blended rest height before its bounds are padded. A blending Global grid
  // on the GPU path that only recentred or whose neighbours changed rewrites and uploads only the rows near a neighbour
  // (`placeGlobalBlend`): open water's own rest data are uniform everywhere else.
  const refresh = s.blend?.refresh === true;
  const globalRows = s.blend !== null && s.gpu && s.body.kind === "global" && !rebuilt && (layout === RECENTRED || refresh);
  if (globalRows) placeGlobalBlend(s, layout === RECENTRED);
  else if (s.blend && (rebuilt || layout === RECENTRED || refresh)) placeBlend(s, world, inverse);
  const subMeshes = s.mesh.subMeshes ?? [];
  // A translation alone needs no new bounds: Babylon moves the local bounds with the world matrix.
  if (rebuilt || layout === RECENTRED || s.boundsDirty || subMeshes.length !== s.boundedSubMeshes || (subMeshes[0] ?? null) !== s.boundedFirst) {
    updateBounds(s, world, inverse, !rebuilt && !s.boundsDirty && layout === RECENTRED);
  }
  if (globalRows) { s.blend!.refresh = false; return; }
  if (rebuilt || (layout === RECENTRED && s.blend) || refresh) {
    if (s.blend) s.blend.refresh = false;
    placeRestData(s);
    return;
  }
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
  const blended = s.blend !== null && s.blendRest.length === s.base.length * 2;
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
    const r = i / 3 * 6;
    // A blending grid keeps its own bank distance signed: an extended grid discards past it.
    if (blended) s.data[d + 1] = Math.min(10000, Math.max(-10000, footprint.edge / outward));
    if (blended && !Number.isNaN(s.blendRest[r]!)) {
      // Blending: the union shoreline (negative outside it, where the fragment discards), blended depth and current.
      s.data[d + 1] = s.blendRest[r]!; s.data[d + 2] = s.blendRest[r + 1]!;
      s.flow[i] = s.blendRest[r + 2]!; s.flow[i + 1] = s.blendRest[r + 3]!; s.flow[i + 2] = s.blendRest[r + 4]!;
    }
    // The GPU path's static vertex inputs: the spacing filter replaces the CPU height; time is a uniform.
    if (s.gpu) { s.data[d] = s.spacing[i / 3]!; s.data[d + 3] = 0; }
  }
  if (blended) {
    blendNormals(s, 0, s.base.length / 3);
    if (s.body.kind === "global") globalReachRows(s, s.blendRows);
  }
  s.mesh.updateVerticesData("slateWaterFlow", s.flow);
  s.mesh.updateVerticesData("slateWaterBaseNormal", s.baseNormals);
  if (blended) s.mesh.updateVerticesData("slateWaterBlend", s.blendData);
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

const globalFlow = new Vector3(), globalNormal = new Vector3(), rowStart = new Vector3(), rowEnd = new Vector3(), reachRows = new Int32Array(2);

/**
 * The first and last rows (inclusive) of a blending Global grid that come within a neighbour's reach, into `out`
 * (first > last when none). Each row is a straight line in world space, so its end points bound it.
 */
function globalReachRows(s: Surface, out: Int32Array): void {
  const state = sceneBlends.get(s.mesh.getScene()), blend = s.blend;
  out[0] = 1; out[1] = 0;
  if (!state || !blend) return;
  const base = s.base, stride = s.layoutColumns + 1, rows = base.length / 3 / stride - 1, world = s.world;
  const reach = state.distance / 2, near = blendNeighbourBounds(state, blend.self);
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

/** Uploads vertices [first, end) of one attribute in place (`data` is the buffer's own CPU array), else all of it. */
function uploadVertexRange(mesh: Mesh, kind: string, data: Float32Array, stride: number, first: number, end: number): void {
  const vertexBuffer = mesh.getVertexBuffer(kind), buffer = vertexBuffer?.getBuffer();
  if (!vertexBuffer || !buffer || !vertexBuffer.isUpdatable() || vertexBuffer.getData() !== data || end <= first) {
    mesh.updateVerticesData(kind, data);
    return;
  }
  mesh.getEngine().updateDynamicVertexBuffer(buffer, data.subarray(first * stride, end * stride), first * stride * 4);
}

/**
 * A blending Global grid on the GPU path after a recentre or a neighbour change: only the rows within a neighbour's
 * reach (now, or at the last write, which return to open water) plus one row either side (the rest normals' fit reads
 * them) are rewritten (`placeBlend` over their vertices, then uniform open-water rest data where no neighbour reaches)
 * and uploaded in place. A recentre still uploads every rest position (the whole grid moved); nothing else outside the
 * rows changes, so a Global grid whose neighbours are out of reach uploads only its positions, as when it blends with
 * nothing.
 */
function placeGlobalBlend(s: Surface, recentred: boolean): void {
  const stride = s.layoutColumns + 1, count = s.base.length / 3, rows = count / stride - 1;
  globalReachRows(s, reachRows);
  const first = Math.max(0, Math.min(reachRows[0]!, s.blendRows[0]!) - 1);
  const last = Math.min(rows, Math.max(reachRows[1]!, s.blendRows[1]!) + 1);
  s.blendRows[0] = reachRows[0]!; s.blendRows[1] = reachRows[1]!;
  const begin = first * stride, end = (last + 1) * stride;
  if (last >= first) placeBlend(s, s.world, s.inverse, begin, end);
  else { s.restMin.y = 0; s.restMax.y = 0; }
  if (recentred) {
    s.positions.set(s.base);
    s.mesh.updateVerticesData(VertexBuffer.PositionKind, s.positions, false);
  }
  if (last < first) return;
  const world = s.world, rest = s.blendRest;
  const depth = s.body.depth * Vector3.TransformNormalFromFloatsToRef(0, 1, 0, world, point).length();
  globalFlow.set(Math.cos(s.body.flowDirection * Math.PI / 180), 0, Math.sin(s.body.flowDirection * Math.PI / 180));
  Vector3.TransformNormalToRef(globalFlow, world, globalFlow);
  globalFlow.scaleInPlace(s.body.flowSpeed / Math.max(1e-6, Math.hypot(globalFlow.x, globalFlow.z)));
  s.inverse.transposeToRef(normalMatrix);
  Vector3.TransformNormalFromFloatsToRef(0, 1, 0, normalMatrix, globalNormal);
  globalNormal.scaleInPlace(globalNormal.y < 0 ? -1 : 1).normalize();
  for (let v = begin; v < end; v++) {
    const i = v * 3, d = v * 4, r = v * 6, own = Number.isNaN(rest[r]!);
    s.data[d + 1] = own ? 10000 : rest[r]!; s.data[d + 2] = own ? depth : rest[r + 1]!;
    s.flow[i] = own ? globalFlow.x : rest[r + 2]!; s.flow[i + 1] = own ? globalFlow.y : rest[r + 3]!; s.flow[i + 2] = own ? globalFlow.z : rest[r + 4]!;
    globalNormal.toArray(s.baseNormals, i);
    s.normals[i] = 0; s.normals[i + 1] = 1; s.normals[i + 2] = 0;
  }
  blendNormals(s, begin, end);
  if (!recentred) {
    for (let i = begin * 3; i < end * 3; i++) s.positions[i] = s.base[i]!;
    uploadVertexRange(s.mesh, VertexBuffer.PositionKind, s.positions, 3, begin, end);
  }
  uploadVertexRange(s.mesh, VertexBuffer.NormalKind, s.normals, 3, begin, end);
  uploadVertexRange(s.mesh, "slateWaterData", s.data, 4, begin, end);
  uploadVertexRange(s.mesh, "slateWaterFlow", s.flow, 3, begin, end);
  uploadVertexRange(s.mesh, "slateWaterBaseNormal", s.baseNormals, 3, begin, end);
  uploadVertexRange(s.mesh, "slateWaterBlend", s.blendData, 4, begin, end);
}

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
function blendNormals(s: Surface, first: number, end: number): void {
  const columns = s.layoutColumns, rest = s.blendRest, world = s.worldBase, count = s.base.length / 3, data = s.blendData;
  const rows = count / (columns + 1) - 1;
  if (marginScratch.length < count) marginScratch = new Float32Array(count);
  const metres = marginScratch;
  s.world.transposeToRef(toLocalNormal);
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
    baseNormal.set(-gx, 1, -gz).normalize().toArray(s.baseNormals, v * 3);
    if (s.gpu) { Vector3.TransformNormalToRef(baseNormal, toLocalNormal, localNormal); localNormal.normalize().toArray(s.normals, v * 3); }
  }
  for (let v = first; v < end; v++) data[v * 4 + 2] = metres[v]!;
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
  const set = waterWaveSet(s.water), scale = s.plugin?.waveScale ?? s.body.waveScale, o = waveOut, blend = s.blend ? s.blendData : null;
  // Finite bodies fade the horizontal offset to zero at their banks, exactly as queries do (`waterBankGain`).
  const fadeLength = s.body.kind === "global" ? 0 : waterBankFadeLength(s.water, scale), gerstner = waterWaveQ(set, scale) > 0;
  for (let i = 0; i < s.base.length; i += 3) {
    const x = s.base[i]!, y = s.base[i + 1]!, z = s.base[i + 2]!;
    const d = i / 3 * 4, v = i / 3 * 2;
    // Forward evaluation at this vertex's world rest point: the mesh never inverts, queries do.
    // Blending scales the swell height and the Gerstner offset (and its fade length) by the vertex's blend data.
    const heightScale = blend ? blend[d]! : 1, offsetScale = blend ? blend[d + 1]! : 1;
    evaluateWaterVertex(set, s.worldBase[i]!, s.worldBase[i + 2]!, time, s.spacing[i / 3]!, scale, s.data[d + 1]!, fadeLength * offsetScale, s.bankGradient[v]!, s.bankGradient[v + 1]!, o);
    const height = o[0]! * heightScale, offsetX = o[1]! * offsetScale, offsetZ = o[2]! * offsetScale;
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
const fieldSample = createWaterBlendSample();
/**
 * Rest surface height (no waves) at a world X/Z, or null outside the body's footprint (unless `beyond`). A blending
 * surface answers with the blended rest height inside the blended shoreline.
 */
function waterSurfaceY(s: Surface, x: number, z: number, beyond = false): number | null {
  const state = s.blend ? sceneBlends.get(s.mesh.getScene()) : undefined;
  if (state && s.blend && evaluateWaterBlend(state.index, s.blend.self, x, s.world.m[13]!, z, fieldSample) && (beyond || fieldSample.union >= 0)) {
    return fieldSample.restHeight;
  }
  Vector3.TransformCoordinatesFromFloatsToRef(x, s.world.m[13]!, z, s.inverse, scratch);
  const footprint = waterFootprint(s.body, scratch.x, scratch.z);
  if (!footprint.inside && !beyond) return null;
  Vector3.TransformCoordinatesFromFloatsToRef(scratch.x, footprint.height, scratch.z, s.world, scratch);
  return scratch.y;
}

/** Rivers and volumes tilted out of the horizontal have a rest height that varies across the body. */
const restVaries = (s: Surface) => s.body.kind === "river" || Math.abs(s.world.m[1]!) > 1e-9 || Math.abs(s.world.m[9]!) > 1e-9 || s.blend?.restVaries === true;

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
  markBlendDirty(surface);
  mesh.setEnabled(surface.body.enabled);
  syncCopyIntent(mesh.getScene(), surface);
  refreshSurface(surface, sceneWaterTime(mesh.getScene()));
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
  refreshSurface(surface, sceneWaterTime(mesh.getScene()));
  return true;
}

/**
 * Apply an edited Water definition to a built surface without rebuilding it, e.g. while a Details value scrubs.
 * Built-in shading reads the definition on every bind (swell constants with Steepness, Wave Model, Peak Sharpness and
 * Wave Seed, Color Variation, the Refraction amount and the FFT band's Detail Waves gain) and the CPU waves on every
 * resample, so this re-applies the material's own scalars (Roughness, Reflection Strength), re-evaluates once the
 * defines that follow the asset (Wave Model, Stylized Look, a feature term crossing zero, Refraction or Detail Waves
 * crossing zero, Object Reflections), moves the surface's scene-copy intent to the new values, re-pads the culling
 * bounds for the new wave envelopes, refreshes the contact range of both fields and resamples CPU vertices, also under a
 * paused clock. A Wave Length edit changes the grid step, so the placement below builds a new rest grid in place
 * (Global Water too). The scene's water clock keeps running. Returns false, changing nothing, for other meshes and for
 * edits that need a rebuild: Style compiles into the shader and Custom Material replaces it.
 */
export function updateWaterMeshDefinition(mesh: Mesh, input: unknown): boolean {
  const surface = surfaceByMesh.get(mesh);
  if (!surface) return false;
  const water = surface.water, next = normalizeWaterDefinition(input);
  if (next.style !== water.style || next.materialGuid !== water.materialGuid) return false;
  const scene = mesh.getScene(), range = contactRange(water);
  // The copy intent counts this surface by its asset's Refraction and Object Reflections.
  if (surface.copyCounted) countCopyIntent(scene, water, -1);
  Object.assign(water, next);
  if (surface.copyCounted) countCopyIntent(scene, water, 1);
  if (surface.plugin && mesh.material instanceof PBRMaterial) {
    applyWaterMaterialScalars(mesh.material, water);
    surface.plugin.definitionChanged();
  }
  surface.boundsDirty = true;
  markBlendDirty(surface);
  // A paused clock repeats the cached time, which would otherwise skip the CPU resample.
  surface.time = null;
  refreshSurface(surface, sceneWaterTime(scene));
  // The terrain field's change key omits the contact range its margin uses; the contact field notices range and
  // wave-envelope changes itself.
  surface.field?.update(contactRange(water) !== range);
  surface.contacts?.update(performance.now());
  return true;
}

/** An in-place edit, creation or disposal: the surface's neighbours rebuild at the next water update. */
function markBlendDirty(s: Surface): void {
  s.blendRevision++;
  const state = sceneBlends.get(s.mesh.getScene());
  if (state) state.dirty = true;
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
    copyCounted: false, uid: ++surfaceIds, blend: null, blendData: empty, blendRest: empty, blendRevision: 0,
    blendMatrix: new Float64Array(16).fill(NaN), blendEnabled: false, blendStamp: 0, blendRows: Int32Array.of(1, 0), layoutColumns: 0, disabledSince: -1, released: false,
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
  markBlendDirty(surface);
  mesh.onDisposeObservable.addOnce(() => {
    entries.delete(surface);
    markBlendDirty(surface);
    if (surface.copyCounted) countCopyIntent(scene, water, -1);
    surface.copyCounted = false;
  });
  refreshSurface(surface, sceneWaterTime(scene));
  if (plugin) {
    const fieldSurface: WaterFieldSurface = {
      mesh, unbounded: body.kind === "global",
      // Read live: `updateWaterMeshDefinition` edits the shared definition in place.
      get contactRange() { return contactRange(water); },
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
