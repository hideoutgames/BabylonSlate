/**
 * When blend data change: the per-frame sync of each scene's `WaterBlendIndex` (`syncSceneBlend`) and a moved body's
 * budgeted blend refresh (`BlendRebuild`), which keeps the previous data until every vertex has its new data.
 */
import { Matrix, Quaternion, Vector3, type Scene } from "@babylonjs/core";
import { WaterBlendIndex, type Transform, type WaterBlendBody } from "@haptic/core";
import { sceneWaterBlendDistance } from "./render-settings";
import {
  beginBlend, blendFit, blendInputs, blendRange, createBlendInputs, finishBlend, globalReachRows, globalWriteRows, sceneBlends, type BlendInputs,
  type SceneBlend,
} from "./water-mesh-blend-data";
import { centredGrid, globalRestRange, restDataRange, uploadGlobalRows, uploadRestData } from "./water-mesh-rest-data";
import { NO_PARTNERS, type RestBuffers, type Surface, type SurfaceBlend } from "./water-mesh-surface";

type RestArray = "base" | "worldBase" | "normals" | "baseNormals" | "data" | "flow" | "bankGradient" | "blendData" | "blendColors" | "blendRest";
/** `RestBuffers`' arrays with their floats per vertex. */
const REST_ARRAYS: ReadonlyArray<readonly [RestArray, number]> = [
  ["base", 3], ["worldBase", 3], ["normals", 3], ["baseNormals", 3], ["data", 4], ["flow", 3], ["bankGradient", 2], ["blendData", 4], ["blendColors", 2],
  ["blendRest", 6],
];
type StageBuffers = RestBuffers & { metres: Float32Array };

const KERNEL = 0, FIT = 1, LANDED = 2;
/**
 * A moved blending body's periodic blend refresh, spread over frames (`advanceBlendRebuild`). It evaluates a frozen copy
 * of the neighbour index and the world matrix of the frame it began in, into staging copies of the per-vertex arrays: the
 * surface keeps drawing its previous blend data until every vertex has its new data, which then replaces it at once.
 * Vertices [first, end) are written (all of them, or a Global grid's rows near a neighbour: `rows`), in two passes of
 * `BLEND_CHUNK` vertices: blend and rest data (`KERNEL`), then the rest normals' fit, which reads neighbours (`FIT`).
 */
export type BlendRebuild = {
  active: boolean;
  /** Began this frame: the staging copies are seeded at the first advance, from the surface as it is then. */
  pending: boolean;
  /** `SurfaceBlend.key` this rebuild lands, and when it began (performance.now). */
  key: number[]; started: number;
  index: WaterBlendIndex; inputs: BlendInputs; self: number; distance: number;
  world: Matrix; inverse: Matrix;
  buffers: StageBuffers;
  phase: number; cursor: number; first: number; end: number;
  /** A GPU Global grid: only the rows near a neighbour are written, `reach` being the rows within a neighbour's reach. */
  rows: boolean; reach: Int32Array;
};

/**
 * While blending surfaces move (a dragged, animated or tide-driven body), each surface starts a new blend refresh at most
 * this often (milliseconds), keeping the previous data in between; the last move always lands once the interval
 * passes. A grid that must be rebuilt (a new grid extension, a rotation out of level) never waits.
 */
export const WATER_BLEND_REFRESH_MS = 200;
/**
 * Milliseconds of blend refresh work all of a scene's surfaces do in one frame. A refresh runs in chunks of
 * `BLEND_CHUNK` vertices: each rebuilding surface advances at least one chunk a frame, and more while this is unspent. A
 * refresh too big for that to land within `WATER_BLEND_DEADLINE_MS` also advances an even share of its chunks per frame
 * (so a large grid costs a few milliseconds a frame for a few frames, not one frame's worth of rewrite), and one still
 * unfinished at the deadline (or after two frames when frames are slower than half of it) ignores the budget and finishes
 * in its frame, so a refresh always lands.
 */
export const WATER_BLEND_FRAME_BUDGET_MS = 2;
export const WATER_BLEND_DEADLINE_MS = 100;
const BLEND_CHUNK = 32;
/** At least a hair per chunk, so a clock that does not advance within a frame still spreads the work. */
const BLEND_CHUNK_MIN_MS = 0.05;
const blendKey: number[] = [];

const blendPosition = new Vector3(), blendScaling = new Vector3(), blendRotation = new Quaternion();

/**
 * Keeps each surface's neighbours current (`WaterBlendIndex`), once per frame before placement. Water that blends with
 * nothing pays nothing: with the distance at 0 or a single surface and no blend in place, this returns at once; while
 * surfaces blend, a frame without changes costs one comparison of each surface's world matrix. A changed distance, a
 * moved, enabled, created, disposed or edited surface rebuilds the index; only surfaces whose own placement or
 * neighbours changed get new blend data: a rebuilt rest grid at their placement this frame, or, for a level surface
 * with an unchanged grid extension, a budgeted refresh (`BlendRebuild`) that keeps the previous data until it lands.
 */
export function syncSceneBlend(scene: Scene, entries: Set<Surface>): void {
  const distance = sceneWaterBlendDistance(scene);
  let state = sceneBlends.get(scene);
  if (!state) {
    if (distance === 0 || entries.size < 2) return;
    state = { index: new WaterBlendIndex(), distance: -1, dirty: true, waiting: false, members: [], spent: 0 };
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
      if (s.blend) {
        s.blend = null; s.version++;
        if (s.plugin) { s.plugin.blend = false; s.plugin.partners = NO_PARTNERS; }
        if (s.nodes) s.nodes.partners = NO_PARTNERS;
      }
      s.stage = null;
      continue;
    }
    let finite = false;
    for (const j of neighbours) if (Number.isFinite(index.bodies[j]!.bounds[0]!)) { finite = true; break; }
    const reach = finite && s.body.kind !== "global" ? distance / 2 : 0;
    // This surface's placement and revision, then each neighbour's: blend data depends on nothing else.
    key.length = 0;
    key.push(distance, reach, s.blendStamp, s.blendRevision);
    for (const j of neighbours) key.push(members[j]!.uid, members[j]!.blendStamp, members[j]!.blendRevision);
    const previous = s.blend, stage = s.stage;
    if (previous && sameKey(previous.key, key)) {
      // Back at the pose its data is for: a refresh still running for another one is moot.
      if (stage) stage.active = false;
      previous.self = self;
      continue;
    }
    // A level surface whose grid extension is unchanged keeps its grid and refreshes only its rest data, spread over
    // frames (`advanceBlendRebuild`); anything else builds a new grid at once.
    const level = Math.abs(s.blendMatrix[1]!) < 1e-9 && Math.abs(s.blendMatrix[9]!) < 1e-9;
    if (previous && previous.reach === reach && level) {
      previous.self = self;
      // A refresh already running finishes on the pose it began with (its frozen index keeps it consistent); a
      // newer pose is picked up by the one that follows it.
      if (stage?.active) { state.waiting = true; continue; }
      // Moving neighbours: keep the previous blend data until the refresh interval passes.
      if (now - previous.built < WATER_BLEND_REFRESH_MS) { state.waiting = true; continue; }
      beginBlendRebuild(s, previous, key, index, bodies, now);
      continue;
    }
    if (stage) stage.active = false;
    s.blend = { self, reach, key: key.slice(), built: now, restVaries: false, heightScale: 1, partners: [null, null, null] };
    s.version++;
    if (s.plugin) s.plugin.blend = true;
  }
}

const sameKey = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((value, i) => value === b[i]);

/**
 * Starts `s`'s blend refresh for `key`: its own copy of the neighbour index (updated to this frame's bodies, so the
 * budgeted chunks that follow see one consistent pose however the bodies move meanwhile). The first advance seeds the
 * staging buffers; the surface's blend data stay as they are until the refresh lands.
 */
function beginBlendRebuild(s: Surface, blend: SurfaceBlend, key: readonly number[], live: WaterBlendIndex, bodies: readonly WaterBlendBody[], now: number): void {
  const stage = s.stage ??= createBlendRebuild();
  stage.index.update(bodies, live.distance);
  stage.distance = live.distance; stage.self = blend.self; stage.started = now; blend.built = now;
  stage.key.length = 0;
  for (const value of key) stage.key.push(value);
  stage.active = true; stage.pending = true;
}

const point = new Vector3(), writeRows = new Int32Array(2);

function createBlendRebuild(): BlendRebuild {
  const world = Matrix.Identity(), inverse = Matrix.Identity();
  return {
    active: false, pending: false, key: [], started: 0, index: new WaterBlendIndex(), inputs: createBlendInputs(), self: 0, distance: 0,
    world, inverse, buffers: createStageBuffers(0), phase: LANDED, cursor: 0, first: 0, end: 0, rows: false, reach: new Int32Array(2),
  };
}

function createStageBuffers(count: number): StageBuffers {
  return {
    base: new Float32Array(count * 3), worldBase: new Float32Array(count * 3), normals: new Float32Array(count * 3),
    baseNormals: new Float32Array(count * 3), data: new Float32Array(count * 4), flow: new Float32Array(count * 3),
    bankGradient: new Float32Array(count * 2), blendData: new Float32Array(count * 4), blendColors: new Float32Array(count * 2),
    blendRest: new Float32Array(count * 6),
    restMin: new Vector3(), restMax: new Vector3(), metres: new Float32Array(count),
  };
}

/** Copies vertices [first, end) of every per-vertex array. */
function copyRestRange(from: RestBuffers, to: RestBuffers, first: number, end: number): void {
  for (const [key, stride] of REST_ARRAYS) to[key].set(from[key].subarray(first * stride, end * stride), first * stride);
}

/**
 * Prepares a refresh that began this frame: the surface's own world matrix and, over the vertices it will write (and one
 * row beyond on a Global grid, which the fit may read), a copy of its current arrays, so that anything the write leaves
 * alone stays as it is. The kernel's extremes start from the surface's.
 */
function seedBlendRebuild(s: Surface, r: BlendRebuild): void {
  r.pending = false;
  const count = s.base.length / 3, stride = s.layoutColumns + 1, inputs = r.inputs;
  if (r.buffers.base.length !== count * 3) r.buffers = createStageBuffers(count);
  r.world.copyFrom(s.world); r.inverse.copyFrom(s.inverse);
  blendInputs(inputs, r.index, r.distance, r.self, r.world, r.inverse);
  r.rows = centredGrid(s);
  let first = 0, end = count, from = 0, to = count;
  if (r.rows) {
    globalReachRows(s, inputs, r.reach);
    globalWriteRows(s, r.reach, writeRows);
    first = writeRows[0]! * stride; end = (writeRows[1]! + 1) * stride;
    from = Math.max(0, first - stride); to = Math.min(count, end + stride);
  }
  const b = r.buffers;
  copyRestRange(s, b, from, to);
  b.restMin.copyFrom(s.restMin); b.restMax.copyFrom(s.restMax);
  r.first = first; r.end = Math.max(first, end); r.cursor = first;
  if (r.end > r.first) { beginBlend(inputs, b, first > 0 || end < count); r.phase = KERNEL; }
  else r.phase = LANDED;
}

/** One chunk of a refresh: the kernel and rest data of up to `BLEND_CHUNK` vertices, then (after all) the normals' fit. */
function stepBlendRebuild(s: Surface, r: BlendRebuild): void {
  const b = r.buffers, end = Math.min(r.cursor + BLEND_CHUNK, r.end);
  if (r.phase === KERNEL) {
    blendRange(r.inputs, s, b, r.cursor, end);
    if (r.rows) globalRestRange(s, b, r.world, r.inverse, r.cursor, end);
    else restDataRange(s, b, r.world, r.inverse, true, r.cursor, end);
    r.cursor = end;
    if (end >= r.end) { r.phase = FIT; r.cursor = r.first; }
  } else {
    blendFit(s, b, r.world, b.metres, r.cursor, end);
    r.cursor = end;
    if (end >= r.end) r.phase = LANDED;
  }
}

const blendChunks = (vertices: number) => Math.ceil(vertices / BLEND_CHUNK);
/** Chunks a refresh has left: its remaining kernel chunks and every fit chunk. */
const blendChunksLeft = (r: BlendRebuild) =>
  r.phase === LANDED ? 0 : r.phase === KERNEL ? blendChunks(r.end - r.cursor) + blendChunks(r.end - r.first) : blendChunks(r.end - r.cursor);

/**
 * Advances `s`'s blend refresh by the frame's share of `WATER_BLEND_FRAME_BUDGET_MS`, but by at least the chunks that
 * would land it before `WATER_BLEND_DEADLINE_MS` if every frame did as many (and at least one), and lands it when every
 * vertex is written: returns whether it did. An overdue refresh (slow frames) finishes in this frame regardless.
 */
export function advanceBlendRebuild(s: Surface, now: number): boolean {
  const r = s.stage!, scene = s.mesh.getScene(), state = sceneBlends.get(scene);
  if (!state || !s.blend) { r.active = false; return false; }
  if (r.pending) {
    const start = performance.now();
    seedBlendRebuild(s, r);
    state.spent += Math.max(performance.now() - start, BLEND_CHUNK_MIN_MS);
  }
  const frame = scene.getEngine().getDeltaTime(), window = Math.max(WATER_BLEND_DEADLINE_MS, 2 * frame), elapsed = now - r.started;
  // A refresh too big for the budget within the window takes an even share of its chunks per frame instead, so it
  // lands before the deadline rather than at it.
  const share = Math.ceil(blendChunksLeft(r) / Math.max(1, Math.floor((window - elapsed) / Math.max(frame, 1))));
  const overdue = elapsed >= window;
  let ran = 0;
  while (r.phase !== LANDED) {
    if (ran >= share && !overdue && state.spent >= WATER_BLEND_FRAME_BUDGET_MS) return false;
    const start = performance.now();
    stepBlendRebuild(s, r);
    state.spent += Math.max(performance.now() - start, BLEND_CHUNK_MIN_MS);
    ran++;
  }
  landBlendRebuild(s, r, state);
  return true;
}

/**
 * Swaps a finished refresh in: the staged arrays replace the surface's over the vertices written, the results of the
 * write apply, and the new data upload once (the same uploads as the write at once, `placeRestData` or `placeGlobalBlend`).
 */
function landBlendRebuild(s: Surface, r: BlendRebuild, state: SceneBlend): void {
  r.active = false; state.waiting = true;
  const blend = s.blend!, b = r.buffers;
  blend.key.length = 0;
  for (const value of r.key) blend.key.push(value);
  s.boundsDirty = true;
  if (r.rows) {
    s.blendRows[0] = r.reach[0]!; s.blendRows[1] = r.reach[1]!;
    if (r.end <= r.first) { s.restMin.y = 0; s.restMax.y = 0; return; }
  }
  finishBlend(s, r.inputs);
  for (let v = r.first; v < r.end; v++) b.blendData[v * 4 + 2] = b.metres[v]!;
  copyRestRange(b, s, r.first, r.end);
  s.restMin.copyFrom(b.restMin); s.restMax.copyFrom(b.restMax);
  if (r.rows) { uploadGlobalRows(s, r.first, r.end); return; }
  // The CPU path displaces from the world rest points of the pose it is at now.
  if (!s.gpu) {
    for (let i = 0; i < s.base.length; i += 3) {
      Vector3.TransformCoordinatesFromFloatsToRef(s.base[i]!, s.base[i + 1]!, s.base[i + 2]!, s.world, point).toArray(s.worldBase, i);
    }
  }
  if (s.body.kind === "global") globalReachRows(s, r.inputs, s.blendRows);
  uploadRestData(s, true);
}

/** An in-place edit, creation or disposal: the surface's neighbours rebuild at the next water update. */
export function markBlendDirty(s: Surface): void {
  s.blendRevision++;
  const state = sceneBlends.get(s.mesh.getScene());
  if (state) state.dirty = true;
}
