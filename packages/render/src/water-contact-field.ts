import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import { Constants } from "@babylonjs/core/Engines/constants";
// Registers the Engine's raw texture functions, which the contact texture is created and updated with.
import "@babylonjs/core/Engines/Extensions/engine.rawTexture";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import type { ThinEngine } from "@babylonjs/core/Engines/thinEngine";
import { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { Geometry } from "@babylonjs/core/Meshes/geometry";
import { InstancedMesh } from "@babylonjs/core/Meshes/instancedMesh";
import { LinesMesh } from "@babylonjs/core/Meshes/linesMesh";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { Scene } from "@babylonjs/core/scene";
import { viewOfBox, type BoxView } from "./active-view";
import { geometryRevision, unwatchGeometry, watchGeometry } from "./geometry-revision";
import { isEditorHelperMesh } from "./helper-mesh";
import { RENDERING_GROUP } from "./sorting";
import {
  contactRasterReach, contactRasterTarget, contactSmoothRadius, rasterContactWindow, WATER_CONTACT_LAYER_OFFSETS,
  type ContactRasterGrid, type ContactRasterJob, type ContactRasterPiece, type ContactWindow,
} from "./water-contact-raster";
import { sharedContactRaster, type ContactRasterClient } from "./water-contact-worker-client";
import type { WaterFieldSurface } from "./water-field";

export { minimumFilter, WATER_CONTACT_LAYER_OFFSETS } from "./water-contact-raster";

const LAYERS = WATER_CONTACT_LAYER_OFFSETS.length;
/**
 * Most texels per side (the Contact Resolution cap, `WaterFieldSurface.contactCells`); beyond it the cells grow
 * rather than the texture.
 */
const MAX_CELLS = 1024;
const MIN_CELLS = 64;
const MIN_CELL = 0.06;
const MAX_TARGET_CELL = 0.25;
/** Scene scans for added, removed and re-enabled objects. */
const SCAN_MS = 100;
/** Moving objects rebuild their neighbourhood at most this often. */
const MOVE_MS = 33;
/** A moving surface cuts every object again at most this often (milliseconds). */
const SURFACE_MOVE_MS = 150;
const SURFACE_SAME = 0, SURFACE_MOVED = 1, SURFACE_CHANGED = 2;
/**
 * The contact cost cap: milliseconds of main-thread contact work (`WaterContactField.drain`) a scene's surfaces start
 * in one frame. A moving object only queues the window around it (`WaterContactField.enqueue`); each frame the scene's
 * queue serves its most important windows first (`WaterContactField.next`) until this is spent, and always one, so a
 * frame costs at most this plus the window that crosses it (at most `MAX_WINDOW` cells a side). Re-slicing stale
 * objects also stops once it is spent (after at least one object per surface), and the rest wait for later frames. A
 * full rebuild outside a forced update or a settle (a new surface, a reshaped body, a resolution change) only queues
 * every cell. Windows still wait only while the cap is spent, so every one is built. With the contact worker
 * (`water-contact-worker-client.ts`) the windows are built off the main thread, and only sending them and applying
 * their results count.
 */
export const WATER_CONTACT_FRAME_BUDGET_MS = 2;
/** At least this much per window counts against the cap, so a clock that does not advance within a frame still spreads them. */
const MIN_WINDOW_MS = 0.1;
/** A window waiting this long (seen by a camera) goes before every other, oldest first, so none starves behind nearer ones. */
const OVERDUE_MS = 250;
/** A window no camera sees waits this long before it runs, and this long before it goes ahead of the seen windows. */
const OFFSCREEN_MS = 400, OFFSCREEN_OVERDUE_MS = 1500;
/**
 * A seen window waits before it runs by a delay that grows from nothing at `FAR_START` metres from the nearest camera to
 * `FAR_MAX_MS` at `FAR_END` (below `OVERDUE_MS`, so waiting never makes a window overdue before it may run): far foam is
 * a few pixels, and several moves of it become one rebuild.
 */
const FAR_START = 100, FAR_END = 400, FAR_MAX_MS = 200;
/** The most cells per side one window built on the main thread covers: larger regions are cut into blocks of about this size. */
const MAX_WINDOW = 64;
/**
 * The most cells per side one window sent to the contact worker covers. The worker has no frame budget, so its windows
 * are larger: a full 1024-cell rebuild is about sixteen jobs, each costing the main thread one copy of the objects in
 * reach and one upload.
 */
const WORKER_WINDOW = 256;
/**
 * Windows a scene has at the contact worker at once. Two keep it busy (one builds while the other's result travels)
 * while the rest stay queued, where a later move merges into them and the priority order still picks the next.
 */
const WORKER_FLIGHT = 2;
/** Per scene and frame: the frame this counts, the milliseconds of window rebuilds started, and how many (or full rebuilds) ran. */
const frameBudgets = new WeakMap<Scene, { frame: number; spent: number; ran: number }>();
/** The contact fields of each scene, whose queued windows share the frame's budget. */
const sceneFields = new WeakMap<Scene, Set<WaterContactField>>();

function frameBudget(scene: Scene): { frame: number; spent: number; ran: number } {
  let budget = frameBudgets.get(scene);
  if (!budget) { budget = { frame: NaN, spent: 0, ran: 0 }; frameBudgets.set(scene, budget); }
  const frame = scene.getFrameId();
  if (budget.frame !== frame) { budget.frame = frame; budget.spent = 0; budget.ran = 0; }
  return budget;
}
/** Most rest-height samples per side over an object on a sloped body (rivers, tilted volumes), bilinearly interpolated. */
const REST_GRID = 17;
const REST_SPACING = 1;

/** Meshes that can meet the water: visible world geometry, not editor helpers, terrain or water. */
export function isWaterContactMesh(mesh: AbstractMesh): boolean {
  // LOD levels share their master's placement; the master already counts.
  if (mesh.isBlocked || !(mesh instanceof Mesh || mesh instanceof InstancedMesh) || mesh instanceof LinesMesh) return false;
  // Foreground and UI groups are overlays, not world geometry.
  if (!mesh.isEnabled() || !mesh.isVisible || mesh.visibility <= 0 || mesh.renderingGroupId > RENDERING_GROUP.world) return false;
  // Infinite-distance meshes (sky domes) follow the camera: their geometry crossing the surface is no waterline.
  if (isEditorHelperMesh(mesh) || mesh.infiniteDistance) return false;
  const meta = mesh.metadata as Record<string, unknown> | null;
  if (meta && (meta.slateWater || meta.slateWaterRemoval || meta.landscapeRoot || meta.slateLandscape || meta.skybox)) return false;
  // Unindexed geometry (e.g. flat-shaded glTF primitives) draws its vertices as consecutive triangles.
  const source = mesh instanceof InstancedMesh ? mesh.sourceMesh : mesh;
  return mesh.getTotalIndices() > 0 || (source.isUnIndexed && mesh.getTotalVertices() >= 3);
}

type Rect = { minX: number; minZ: number; maxX: number; maxZ: number };
type Window = ContactWindow;
/**
 * A window waiting for the frame budget. `since` is when it was first queued (a window that grows or merges while it
 * waits keeps its age); `hidden` is whether no body draws this surface anywhere in it, as of `stamp`.
 */
type Queued = Window & { since: number; stamp: number; hidden: boolean };
/**
 * A window sent to the contact worker. `generation` is the field's when it was sent: a result from an older generation
 * is dropped. `seq` orders every write of the field's texels; a result older than a write that overlapped it while it
 * was out (`superseded`) is dropped too, and its window queued again, so an older result never lands over a newer one.
 * `texels` is the result once it is back, waiting to be applied.
 */
type Flight = { window: Window; since: number; generation: number; seq: number; superseded: boolean; texels: Uint8Array | null };
/** `WaterContactField.next`'s answer, reused: the queue index of the window to build next and its sort key (lowest first). */
const pick = { index: -1, key: Infinity };
const boxView: BoxView = { visible: true, distance: 0 };

/** One rigid placement of a mesh's geometry: a mesh, an instance, or one thin instance. */
type Piece = {
  mesh: AbstractMesh;
  /** Thin-instance index, or -1. */
  instance: number;
  matrix: Float64Array;
  /** The watched geometry and its position revision when last sliced (NaN when its updates cannot be counted). */
  geometry: Geometry | null;
  revision: number;
  stale: boolean;
  /** XZ bounds of the triangles inside the wave envelope; null when none reach it. */
  bounds: Rect | null;
  /** Per layer: x0, z0, x1, z1 cross-section segments at that layer's height. */
  contours: Float64Array[];
  /** Per layer: the cross-section closes, so its interior is known. */
  closed: boolean[];
  /** Triangles within the envelope: world x, height above the local rest height, world z for three corners. */
  triangles: Float64Array;
};

/**
 * The last scan's placements of one thin-instanced mesh. They are reused until its transform, geometry or
 * instance matrices change, so a static forest is not walked instance by instance every scan.
 */
type ThinPlacements = {
  scan: number;
  surface: number;
  geometry: Geometry;
  revision: number;
  world: Float64Array;
  /**
   * The instance matrices' values (16 per instance) at the last walk. Babylon keeps the very object a caller passes to
   * `thinInstanceSetMatrixAt`, so a caller reusing one Matrix moves an instance without replacing it: compare values.
   */
  matrices: Float64Array;
  /** Keys of the instances that reach the wave envelope. */
  keys: string[];
};

const sourceGeometry = (mesh: AbstractMesh): Geometry | null => (mesh instanceof InstancedMesh ? mesh.sourceMesh : mesh as Mesh).geometry ?? null;
/** Position revision of a watched geometry, or NaN when its updates cannot be counted (never equal, so never cached). */
const positionRevision = (geometry: Geometry | null) => geometry ? geometryRevision(geometry)?.positions ?? NaN : NaN;

const localBounds = new WeakMap<object, { min: Vector3; max: Vector3; revision: number }>();
/** Local bounds of a geometry's vertices, cached until its positions are rewritten, e.g. by a simulated cable. */
function geometryBounds(positions: ArrayLike<number>, revision: number): { min: Vector3; max: Vector3 } {
  let bounds = localBounds.get(positions as object);
  if (!bounds || bounds.revision !== revision) {
    const min = new Vector3(Infinity, Infinity, Infinity), max = new Vector3(-Infinity, -Infinity, -Infinity);
    for (let i = 0; i + 2 < positions.length; i += 3) {
      min.minimizeInPlaceFromFloats(positions[i]!, positions[i + 1]!, positions[i + 2]!);
      max.maximizeInPlaceFromFloats(positions[i]!, positions[i + 1]!, positions[i + 2]!);
    }
    bounds = { min, max, revision };
    localBounds.set(positions as object, bounds);
  }
  return bounds;
}

const corner = new Vector3();
function worldBox(min: Vector3, max: Vector3, matrix: Matrix): { min: Vector3; max: Vector3 } {
  const outMin = new Vector3(Infinity, Infinity, Infinity), outMax = new Vector3(-Infinity, -Infinity, -Infinity);
  for (let i = 0; i < 8; i++) {
    Vector3.TransformCoordinatesFromFloatsToRef(i & 1 ? max.x : min.x, i & 2 ? max.y : min.y, i & 4 ? max.z : min.z, matrix, corner);
    outMin.minimizeInPlace(corner); outMax.maximizeInPlace(corner);
  }
  return { min: outMin, max: outMax };
}

const sameMatrix = (a: Float64Array, b: ArrayLike<number>) => {
  for (let i = 0; i < 16; i++) if (a[i] !== b[i]) return false;
  return true;
};

/**
 * Cells some point of a placement must move from where it was last sliced before it is sliced again: a floating object
 * bobs a little every frame, and re-slicing it each time cost a window rebuild per object every `MOVE_MS`. Its contacts
 * trail it by less than this.
 */
const MOVE_TOLERANCE_CELLS = 0.25;
/** The rotation and scale entries of a 4 × 4 world matrix. */
const FRAME_ENTRIES = [0, 1, 2, 4, 5, 6, 8, 9, 10] as const;

/**
 * Whether world matrix `next` puts some point within `reach` of the placement's local origin more than `tolerance` from
 * where `last` put it (bounded by the translation's change plus the frame's change times `reach`). Any change counts
 * while `tolerance` is 0.
 */
export function movedBeyond(last: ArrayLike<number>, next: ArrayLike<number>, reach: number, tolerance: number): boolean {
  if (tolerance <= 0) {
    for (let i = 0; i < 16; i++) if (last[i] !== next[i]) return true;
    return false;
  }
  const dx = next[12]! - last[12]!, dy = next[13]! - last[13]!, dz = next[14]! - last[14]!;
  let frame = 0;
  for (const i of FRAME_ENTRIES) { const d = next[i]! - last[i]!; frame += d * d; }
  return Math.sqrt(dx * dx + dy * dy + dz * dz) + Math.sqrt(frame) * reach > tolerance;
}

/** A placement's farthest local point from its origin, from its bounding sphere. */
function localReach(mesh: AbstractMesh): number {
  const sphere = mesh.getBoundingInfo().boundingSphere;
  return sphere.center.length() + sphere.radius;
}

/**
 * Contact-eligible meshes of a scene (`isWaterContactMesh`), gathered once and shared by every surface's scan, so many
 * water bodies do not each test every scene mesh. A list serves later scans for `CANDIDATE_MS` while the scene's mesh
 * count is unchanged; a surface's full rescan gathers afresh.
 */
type ContactMeshes = { meshes: AbstractMesh[]; builtAt: number; count: number };
const contactMeshes = new WeakMap<Scene, ContactMeshes>();
/** A newly enabled or shown object meets the water within `SCAN_MS` plus this. */
const CANDIDATE_MS = SCAN_MS / 2;
/** Surfaces' periodic scans fall in this many phases of `SCAN_MS`, so many bodies never all scan in one frame. */
const SCAN_PHASES = 6;
let scanPhases = 0;

/** `WaterContactField.fill`'s texels of one window, shared and grown on demand. */
let scratchTexels = new Uint8Array(0);

/** A growable list of numbers, shared by `slice` calls (allocation-free once grown); `length` values are in use. */
type Values = { values: Float64Array; length: number };
const values = (): Values => ({ values: new Float64Array(64), length: 0 });
/** Room for `more` values after the ones in use. */
function room(list: Values, more: number): Float64Array {
  if (list.length + more > list.values.length) {
    const grown = new Float64Array(Math.max(list.values.length * 2, list.length + more));
    grown.set(list.values.subarray(0, list.length));
    list.values = grown;
  }
  return list.values;
}
/**
 * `slice`'s scratch: the placed vertices (world x, height above the rest height, world z), the vertices whose x and z
 * are known (`sliceKnown[v] === sliceStamp`), the envelope triangles, each layer's cross-section and the mid-height one.
 */
let sliceWorld = new Float64Array(0), sliceKnown = new Uint32Array(0), sliceStamp = 0;
const sliceTriangles = values(), sliceSection = values();
const sliceLayers: Values[] = WATER_CONTACT_LAYER_OFFSETS.map(values);
const sliceMatrix = new Matrix();
/** The triangles of a placement that reaches no envelope (never written). */
const NO_VALUES = new Float64Array(0);

function sceneContactMeshes(scene: Scene, now: number, fresh: boolean): readonly AbstractMesh[] {
  let entry = contactMeshes.get(scene);
  if (!entry) { entry = { meshes: [], builtAt: -Infinity, count: -1 }; contactMeshes.set(scene, entry); }
  if (fresh || entry.count !== scene.meshes.length || !(now - entry.builtAt < CANDIDATE_MS) || now < entry.builtAt) {
    const meshes = entry.meshes;
    meshes.length = 0;
    for (const mesh of scene.meshes) if (isWaterContactMesh(mesh)) meshes.push(mesh);
    entry.builtAt = now; entry.count = scene.meshes.length;
  }
  return entry.meshes;
}

const union = (a: Rect | null, b: Rect | null): Rect | null => !a ? b : !b ? a
  : { minX: Math.min(a.minX, b.minX), minZ: Math.min(a.minZ, b.minZ), maxX: Math.max(a.maxX, b.maxX), maxZ: Math.max(a.maxZ, b.maxZ) };

/** How `WaterContactField.step` runs: a frame's update, a forced rebuild, or a settle. */
const FRAME = 0, FORCE = 1, SETTLE = 2;

/** Optional collaborators of a contact field. */
export type WaterContactFieldOptions = {
  /**
   * Where queued windows are built off the main thread. Defaults to the realm's contact worker
   * (`sharedContactRaster`), or none on a `NullEngine` or where workers do not exist; null builds every window on
   * the main thread.
   */
  raster?: ContactRasterClient | null;
};

/**
 * Per-surface, objects-only contact texture: the signed horizontal distance to every object
 * crossing the water at four heights across the wave envelope (negative inside closed objects).
 * Heights are relative to the local rest height, so sloped rivers cut each part of an object at
 * its own waterline. Surfaces just above or below a layer add a weighted vertical distance, so
 * shallow hulls, rafts and deck undersides between layers still meet the rising and falling water.
 * Rebuilt only when objects move, deform, appear or disappear, or the surface or wave envelope
 * changes; waves never rebake it. Only the cells an object's movement can change are rebuilt, as queued windows that
 * share the scene's per-frame cost cap (`WATER_CONTACT_FRAME_BUDGET_MS`): the most important (seen, near, longest
 * waiting) first, and none that no body draws. Until its window is built a cell keeps its last result, so contacts follow a
 * moving object a few frames late, never wrongly. Only a forced update and `settle` build at once.
 *
 * The texture lives on the Engine, not in the Scene's texture list: the forward graph counts that list for readiness,
 * and a contact texture reallocated as objects spread would otherwise send every view through a whole-Scene probe.
 */
export class WaterContactField {
  texture: BaseTexture | null = null;
  /** minX, minZ, 1 / sizeX, 1 / sizeZ in world metres. */
  readonly bounds = [0, 0, 1, 1];
  /** The wave envelope (metres either side of rest) the current layers were built for. */
  amplitude = 0;
  /** Distances are clamped to +/- this many metres. */
  range = 1;
  private data: Uint8Array | null = null;
  private width = 0;
  private height = 0;
  private cell = 1;
  /** Texels per side this surface may use (Contact Resolution). */
  private maxCells = MAX_CELLS;
  private rect: Rect | null = null;
  private readonly pieces = new Map<string, Piece>();
  private readonly thin = new Map<Mesh, ThinPlacements>();
  private scans = 0;
  /** Bumped when the surface changes, which invalidates every cached thin-instance placement. */
  private surfaceEpoch = 0;
  private dirty: Rect[] = [];
  /** Windows of `data` that changed and wait for the frame budget; none overlap. */
  private readonly queue: Queued[] = [];
  /** Windows at the contact worker, and results back from it that wait to be applied (`texels`). */
  private readonly flight: Flight[] = [];
  /** Bumped whenever results sent earlier could be wrong to apply: a new allocation, a synchronous rebuild, a release. */
  private generation = 0;
  /** Counts every write of texels (built here, or sent to the worker), ordering them for `Flight.seq`. */
  private writes = 0;
  /** Windows were built since `update` last reported. */
  private touched = false;
  private lastScan = -Infinity;
  /** Milliseconds this surface's periodic scans run ahead of the others' (`SCAN_PHASES`). */
  private readonly scanPhase = (scanPhases++ % SCAN_PHASES) * SCAN_MS / SCAN_PHASES;
  private lastBuild = -Infinity;
  /** The surface moved since its last full rebuild, which waits for `SURFACE_MOVE_MS` to pass. */
  private surfaceMoved = false;
  /** Every object is cut again and every cell rebuilt at the next update (`invalidate`, or a change while released). */
  private reshaped = false;
  /** The frame's budget ran out with stale objects left unsliced: the next update slices on without waiting for `MOVE_MS`. */
  private backlog = false;
  /** The texture was given back (`releaseTexture`) and waits for `restore`. */
  private released = false;
  private readonly surfaceState = new Float64Array(19).fill(NaN);
  private readonly scratch = new Matrix();

  private readonly scene: Scene;
  private readonly surface: WaterFieldSurface;
  private readonly raster: ContactRasterClient | null;

  constructor(scene: Scene, surface: WaterFieldSurface, options: WaterContactFieldOptions = {}) {
    this.scene = scene;
    this.surface = surface;
    this.raster = options.raster !== undefined ? options.raster : scene.getEngine() instanceof NullEngine ? null : sharedContactRaster();
    let fields = sceneFields.get(scene);
    if (!fields) { fields = new Set(); sceneFields.set(scene, fields); }
    fields.add(this);
  }

  /**
   * Windows not yet built: waiting for the frame budget (some may wait on another body drawing the surface instead), at
   * the contact worker, or back from it and waiting to be applied. Zero once every change has landed.
   */
  get queued(): number { return this.queue.length + this.flight.length; }

  /**
   * Track objects and queue what changed, then build the scene's queued windows within the frame's budget. Returns true
   * when the texture changed. A changed wave envelope, contact range or cell cap cuts every object again (within the
   * budget, at least one object per update) and queues every cell, keeping a texture bound throughout; so does a moved
   * surface, but while it keeps moving (a dragged, animated or tide-driven body) at most every `SURFACE_MOVE_MS`: its
   * contacts lag its pose by that much plus the queue, and its last pose always lands. `force` instead cuts every
   * object and builds every cell before it returns. A released texture (`releaseTexture`) waits for `restore`.
   */
  update(now: number, force = false): boolean {
    return this.step(now, force ? FORCE : FRAME);
  }

  /**
   * Finishes every change at once, as for a load: stale objects are sliced (also those `parked` would skip) and every
   * queued window and every window at the worker is built here, also where no body draws. A changed surface or
   * envelope rebuilds every cell. Returns true when the texture changed; a released texture waits for `restore`.
   */
  settle(now: number): boolean {
    return this.step(now, SETTLE);
  }

  /**
   * Cuts every object again and rebuilds every cell from the next update on, as a changed envelope does (a reshaped
   * body, whose rest heights and footprint the slices depend on). The cells keep what they show until rebuilt.
   */
  invalidate(): void {
    this.reshaped = true;
  }

  /** One update in `mode` (`FRAME`, `FORCE` or `SETTLE`); returns whether the texture changed. */
  private step(now: number, mode: number): boolean {
    const surface = this.syncSurface();
    if (surface === SURFACE_MOVED) this.surfaceMoved = true;
    if (this.released && mode !== FORCE) return false;
    const sync = mode !== FRAME;
    // A settle builds what is at the worker itself; a forced rebuild builds everything anyway.
    if (sync) this.invalidateFlight(mode === SETTLE);
    const rebuildAll = mode === FORCE || surface === SURFACE_CHANGED || this.reshaped;
    const recut = !rebuildAll && this.surfaceMoved && (sync || this.lastBuild === -Infinity || now - this.lastBuild >= SURFACE_MOVE_MS);
    const full = rebuildAll || recut;
    if (full) { this.surfaceMoved = false; this.reshaped = false; }
    if (full) { this.surfaceEpoch++; for (const piece of this.pieces.values()) piece.stale = true; }
    if (full || now - this.lastScan >= SCAN_MS) {
      // The first scan sets this surface's phase; later ones keep their spacing.
      this.lastScan = this.lastScan === -Infinity ? now - this.scanPhase : now;
      this.scan(now, full);
    }
    else this.track();
    let stale = full || this.dirty.length > 0;
    for (const piece of this.pieces.values()) stale ||= piece.stale;
    let changed = false;
    const budget = frameBudget(this.scene);
    if (stale && (full || sync || this.backlog || now - this.lastBuild >= MOVE_MS)) {
      this.lastBuild = now;
      const start = performance.now();
      changed = this.rebuild(rebuildAll, recut, now, sync, budget.spent, start);
      // Re-slicing and full rebuilds are not queued but count against the frame; a full one is the frame's progress too.
      budget.spent += Math.max(performance.now() - start, MIN_WINDOW_MS);
      if (rebuildAll) budget.ran++;
    }
    if (mode === SETTLE && this.queue.length > 0 && this.data) {
      const start = performance.now();
      // Every remaining window, whole: on the main thread a larger window costs no more per cell.
      for (const window of this.queue.splice(0)) this.write(window);
      budget.spent += Math.max(performance.now() - start, MIN_WINDOW_MS);
      budget.ran++;
    }
    WaterContactField.drain(this.scene, now);
    changed ||= this.touched; this.touched = false;
    return changed;
  }

  /**
   * Applies the worker's results for the scene's surfaces, then builds (or sends to the worker) the scene's queued
   * windows, across all its surfaces, most important first, until the frame's budget is spent (the first window of a
   * frame always runs). A window larger than a block (`MAX_WINDOW` here, `WORKER_WINDOW` at the worker) is only cut
   * into blocks, which costs nothing, and its blocks queue again. While the scene has `WORKER_FLIGHT` windows at the
   * worker, its surfaces that use the worker send no more.
   */
  private static drain(scene: Scene, now: number): void {
    const fields = sceneFields.get(scene);
    if (!fields) return;
    const budget = frameBudget(scene);
    let flying = 0;
    for (const field of fields) {
      if (field.flight.some((entry) => entry.texels !== null)) {
        const start = performance.now();
        field.applyResults();
        budget.spent += Math.max(performance.now() - start, MIN_WINDOW_MS);
      }
      flying += field.flight.length;
    }
    for (;;) {
      if (budget.ran > 0 && budget.spent >= WATER_CONTACT_FRAME_BUDGET_MS) return;
      let best: WaterContactField | null = null, index = -1, key = Infinity;
      for (const field of fields) {
        if (field.queue.length === 0 || field.released || !field.data) continue;
        if (field.worker() && flying >= WORKER_FLIGHT) continue;
        field.next(now);
        if (pick.index >= 0 && pick.key < key) { best = field; index = pick.index; key = pick.key; }
      }
      if (!best) return;
      const start = performance.now(), worker = best.worker(), before = best.flight.length;
      if (!(worker ? best.dispatch(index, worker) : best.build(index))) continue;
      flying += best.flight.length - before;
      budget.spent += Math.max(performance.now() - start, MIN_WINDOW_MS);
      budget.ran++;
    }
  }

  /** The contact worker client while it works, else null (windows are built here). */
  private worker(): ContactRasterClient | null {
    return this.raster?.available ? this.raster : null;
  }

  /**
   * Sets `pick` to this surface's most important queued window that may run now: windows no body draws wait for that to
   * change; seen windows go before unseen ones, nearer before farther, and a window that waited long enough (`OVERDUE_MS`)
   * goes before every other, oldest first. Unseen and far windows also wait a little before they run at all, so a
   * cluster of moves becomes one rebuild.
   */
  private next(now: number): void {
    pick.index = -1; pick.key = Infinity;
    const r = this.rect!, cell = this.cell, box = this.surface.mesh.getBoundingInfo().boundingBox;
    const low = box.minimumWorld.y - this.amplitude, high = box.maximumWorld.y + this.amplitude;
    const stamp = this.surface.drawStamp ?? 0;
    for (let i = 0; i < this.queue.length; i++) {
      const window = this.queue[i]!;
      if (window.stamp !== stamp) { window.hidden = this.undrawn(window); window.stamp = stamp; }
      if (window.hidden) continue;
      const { visible, distance } = viewOfBox(this.scene, r.minX + window.x0 * cell, low, r.minZ + window.z0 * cell, r.minX + window.x1 * cell, high, r.minZ + window.z1 * cell, boxView);
      const age = now - window.since;
      if (age < (visible ? FAR_MAX_MS * Math.min(1, Math.max(0, (distance - FAR_START) / (FAR_END - FAR_START))) : OFFSCREEN_MS)) continue;
      const key = age >= (visible ? OVERDUE_MS : OFFSCREEN_OVERDUE_MS) ? -1e9 - age : (visible ? 0 : 1e6) + distance - age * 1e-3;
      if (key < pick.key) { pick.key = key; pick.index = i; }
    }
  }

  /**
   * Whether no body draws this surface anywhere in the window (`WaterFieldSurface.draws`, sampled at its centre and
   * corners): contacts there are never seen, so the window waits until that changes.
   */
  private undrawn(window: Window): boolean {
    const r = this.rect!, cell = this.cell;
    return this.undrawnArea(r.minX + window.x0 * cell, r.minZ + window.z0 * cell, r.minX + window.x1 * cell, r.minZ + window.z1 * cell);
  }

  /** Whether this surface draws nowhere in the area, sampled at its centre and corners (false without `draws`). */
  private undrawnArea(x0: number, z0: number, x1: number, z1: number): boolean {
    const draws = this.surface.draws;
    if (!draws) return false;
    return !(draws((x0 + x1) / 2, (z0 + z1) / 2) || draws(x0, z0) || draws(x1, z0) || draws(x0, z1) || draws(x1, z1));
  }

  /**
   * Takes queued window `index` off the queue. One larger than `limit` cells a side is cut into blocks of at most that
   * size, which queue again (null).
   */
  private take(index: number, limit: number): Queued | null {
    const window = this.queue[index]!;
    this.queue.splice(index, 1);
    const width = window.x1 - window.x0, height = window.z1 - window.z0;
    const nx = Math.ceil(width / limit), nz = Math.ceil(height / limit);
    if (nx * nz === 1) return window;
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
      this.queue.push({
        x0: window.x0 + Math.floor(width * i / nx), x1: window.x0 + Math.floor(width * (i + 1) / nx),
        z0: window.z0 + Math.floor(height * j / nz), z1: window.z0 + Math.floor(height * (j + 1) / nz),
        since: window.since, stamp: NaN, hidden: false,
      });
    }
    return null;
  }

  /** Builds queued window `index` here, or cuts it into blocks of at most `MAX_WINDOW` cells a side and queues those (false). */
  private build(index: number): boolean {
    const window = this.take(index, MAX_WINDOW);
    if (!window) return false;
    this.write(window);
    return true;
  }

  /**
   * Sends queued window `index` to the contact worker, or cuts it into blocks of at most `WORKER_WINDOW` cells a side
   * and queues those (false). A window no object reaches is written here at once: it is all far.
   */
  private dispatch(index: number, worker: ContactRasterClient): boolean {
    const window = this.take(index, WORKER_WINDOW);
    if (!window) return false;
    const write: Window = { x0: window.x0, z0: window.z0, x1: window.x1, z1: window.z1 };
    const job = this.job(this.around(write), write);
    if (job.pieces.length === 0) { this.write(write); return true; }
    const entry: Flight = { window: write, since: window.since, generation: this.generation, seq: ++this.writes, superseded: false, texels: null };
    this.flight.push(entry);
    const size = (write.x1 - write.x0) * (write.z1 - write.z0) * 4;
    worker.run(job).then(
      (texels) => {
        if (entry.generation !== this.generation) return;
        if (texels.length === size) entry.texels = texels;
        else this.returned(entry);
      },
      () => this.returned(entry),
    );
    return true;
  }

  /** A window the worker did not build (it failed, and is disabled): queued again, keeping its age, unless already stale. */
  private returned(entry: Flight): void {
    const index = this.flight.indexOf(entry);
    if (entry.generation !== this.generation || index < 0) return;
    this.flight.splice(index, 1);
    this.enqueue(entry.window, entry.since);
  }

  /**
   * Applies the worker's results in the order they were sent. A result that a newer write overlapped while it was out
   * is dropped and its window queued again, so it never lands over newer cells.
   */
  private applyResults(): void {
    const done = this.flight.filter((entry) => entry.texels !== null).sort((a, b) => a.seq - b.seq);
    for (const entry of done) {
      this.flight.splice(this.flight.indexOf(entry), 1);
      if (entry.superseded) { this.enqueue(entry.window, entry.since); continue; }
      this.place(entry.window, entry.texels!);
      this.upload([entry.window], false);
      this.touched = true;
      this.wrote(entry.window, entry.seq);
    }
  }

  /** Builds a window here and uploads it. */
  private write(window: Window): void {
    this.fill(this.around(window), window);
    this.upload([window], false);
    this.touched = true;
    this.wrote(window, ++this.writes);
  }

  /** Marks every window still at the worker that was sent before write `seq` and overlaps its cells as superseded. */
  private wrote(window: Window, seq: number): void {
    for (const entry of this.flight) {
      if (entry.seq >= seq || entry.superseded) continue;
      if (entry.window.x0 < window.x1 && window.x0 < entry.window.x1 && entry.window.z0 < window.z1 && window.z0 < entry.window.z1) entry.superseded = true;
    }
  }

  /**
   * Drops every result sent so far (`generation`). With `requeue` their windows are queued again in the current
   * allocation's cells, keeping their age; otherwise the caller rebuilds or discards those cells itself.
   */
  private invalidateFlight(requeue: boolean): void {
    this.generation++;
    const flight = this.flight.splice(0);
    if (requeue) for (const entry of flight) this.enqueue(entry.window, entry.since);
  }

  /** The window a write window's cells are computed over (`contactRasterTarget`). */
  private around(window: Window): Window {
    return contactRasterTarget(this.grid(), window);
  }

  /** The allocation and contact settings the rasteriser builds for. */
  private grid(): ContactRasterGrid {
    const r = this.rect!;
    return {
      width: this.width, height: this.height, rectMinX: r.minX, rectMinZ: r.minZ, cell: this.cell,
      range: this.range, amplitude: this.amplitude, smoothRadius: contactSmoothRadius(this.range, this.cell),
    };
  }

  /**
   * Queues a window of changed cells, first changed at `since`. Windows that overlap it merge into one, which keeps the
   * oldest age, so nothing is built twice and a window that keeps changing while it waits still goes by when it first
   * changed.
   */
  private enqueue(next: Window, since: number): void {
    if (next.x0 >= next.x1 || next.z0 >= next.z1) return;
    let merged: Queued = { x0: next.x0, z0: next.z0, x1: next.x1, z1: next.z1, since, stamp: NaN, hidden: false };
    for (let again = true; again;) {
      again = false;
      for (let i = 0; i < this.queue.length; i++) {
        const w = this.queue[i]!;
        if (w.x0 >= merged.x1 || merged.x0 >= w.x1 || w.z0 >= merged.z1 || merged.z0 >= w.z1) continue;
        this.queue.splice(i, 1);
        merged = {
          x0: Math.min(w.x0, merged.x0), z0: Math.min(w.z0, merged.z0), x1: Math.max(w.x1, merged.x1), z1: Math.max(w.z1, merged.z1),
          since: Math.min(w.since, merged.since), stamp: NaN, hidden: false,
        };
        again = true;
        break;
      }
    }
    this.queue.push(merged);
  }

  /**
   * Whether the wave envelope, contact range or cell cap changed (`SURFACE_CHANGED`), else whether only the surface
   * placement did (`SURFACE_MOVED`). Reshaping a body invalidates the field instead (`invalidate`), so animated wave
   * bounds never trigger a rebuild.
   */
  private syncSurface(): number {
    const amplitude = Math.max(0.01, this.surface.amplitude), range = this.surface.contactRange;
    const cells = Math.max(MIN_CELLS, Math.min(MAX_CELLS, Math.round(this.surface.contactCells ?? MAX_CELLS) || MAX_CELLS));
    const state = this.surfaceState, m = this.surface.mesh.getWorldMatrix().m;
    let moved = false, changed = false;
    for (let i = 0; i < 16; i++) if (state[i] !== m[i]) { state[i] = m[i]!; moved = true; }
    if (state[16] !== amplitude || state[17] !== range || state[18] !== cells) { state[16] = amplitude; state[17] = range; state[18] = cells; changed = true; }
    this.amplitude = amplitude; this.range = range; this.maxCells = cells;
    return changed ? SURFACE_CHANGED : moved ? SURFACE_MOVED : SURFACE_SAME;
  }

  /**
   * Gives back the GPU texture of a surface that stays disabled, keeping the distances and tracked objects, so
   * `restore` uploads them again and only what moved meanwhile rebuilds. Windows at the worker queue again.
   */
  releaseTexture(): void {
    this.texture?.dispose(); this.texture = null; this.released = true;
    this.invalidateFlight(true);
  }

  /**
   * The texture again after `releaseTexture`, showing the distances it kept; anything that changed meanwhile rebuilds as
   * a frame's update would (or at once with `settle`).
   */
  restore(now: number, settle = false): void {
    this.released = false;
    const surface = this.syncSurface();
    if (surface === SURFACE_CHANGED) this.reshaped = true;
    else if (surface === SURFACE_MOVED) this.surfaceMoved = true;
    if (this.data && !this.texture) this.upload([], true);
    this.step(now, settle ? SETTLE : FRAME);
  }

  dispose(): void {
    this.release();
    sceneFields.get(this.scene)?.delete(this);
    for (const piece of this.pieces.values()) if (piece.geometry) unwatchGeometry(piece.geometry);
    for (const placements of this.thin.values()) unwatchGeometry(placements.geometry);
    this.pieces.clear(); this.thin.clear();
  }

  /** True when the mesh now draws another geometry or its positions were rewritten since the last slice. */
  private geometryChanged(piece: Piece): boolean {
    const geometry = sourceGeometry(piece.mesh);
    if (geometry !== piece.geometry) {
      if (piece.geometry) unwatchGeometry(piece.geometry);
      if (geometry) watchGeometry(geometry);
      piece.geometry = geometry;
      return true;
    }
    // An uncountable geometry (NaN) keeps its last slice; matrix changes still rebuild it.
    return !Number.isNaN(piece.revision) && positionRevision(geometry) !== piece.revision;
  }

  private release(): void {
    this.texture?.dispose(); this.texture = null; this.data = null; this.rect = null; this.queue.length = 0;
    this.invalidateFlight(false);
  }

  /** Candidate placements of every mesh that reaches the wave envelope near this surface. */
  private scan(now: number, fresh: boolean): void {
    const scan = ++this.scans;
    const seen = new Set<string>();
    const box = this.surface.mesh.getBoundingInfo().boundingBox, margin = this.range, amplitude = this.amplitude;
    // The rendered surface's world box bounds every rest height, so most meshes need no height query.
    const near = (min: Vector3, max: Vector3) => max.y >= box.minimumWorld.y - amplitude && min.y <= box.maximumWorld.y + amplitude
      && (this.surface.unbounded || (max.x >= box.minimumWorld.x - margin && min.x <= box.maximumWorld.x + margin && max.z >= box.minimumWorld.z - margin && min.z <= box.maximumWorld.z + margin));
    const reaches = (min: Vector3, max: Vector3) => {
      if (!near(min, max)) return false;
      const levels = this.levelsIn(min, max);
      return levels !== null && min.y <= levels[1] + amplitude && max.y >= levels[0] - amplitude;
    };
    const visit = (key: string, mesh: AbstractMesh, instance: number, matrix: ArrayLike<number>) => {
      seen.add(key);
      const piece = this.pieces.get(key);
      if (!piece) {
        const geometry = sourceGeometry(mesh);
        if (geometry) watchGeometry(geometry);
        this.pieces.set(key, { mesh, instance, matrix: new Float64Array(matrix), geometry, revision: NaN, stale: true, bounds: null, contours: [], closed: [], triangles: new Float64Array() });
      } else if (piece.mesh !== mesh || (instance >= 0 ? !sameMatrix(piece.matrix, matrix) : movedBeyond(piece.matrix, matrix, localReach(mesh), this.moveTolerance()))) {
        piece.mesh = mesh; piece.matrix.set(matrix); piece.stale = true;
      } else if (this.geometryChanged(piece)) piece.stale = true;
    };
    const centre = new Vector3(), sphereMin = new Vector3(), sphereMax = new Vector3();
    const meshes = sceneContactMeshes(this.scene, now, fresh);
    for (let index = 0; index < meshes.length; index++) {
      const mesh = meshes[index]!;
      if (mesh.isDisposed()) continue;
      const world = mesh.computeWorldMatrix();
      const { minimumWorld: min, maximumWorld: max } = mesh.getBoundingInfo().boundingBox;
      if (!near(min, max)) continue;
      if (mesh instanceof Mesh && mesh.hasThinInstances) {
        // Thin instances (e.g. foliage) each place the geometry; the mesh bounds already cover them all.
        const geometry = mesh.geometry, positions = mesh.getVerticesData(VertexBuffer.PositionKind);
        if (!geometry || !positions) continue;
        const instances = mesh.thinInstanceGetWorldMatrices();
        let placements = this.thin.get(mesh);
        if (placements && placements.geometry !== geometry) { unwatchGeometry(placements.geometry); this.thin.delete(mesh); placements = undefined; }
        if (!placements) {
          watchGeometry(geometry);
          placements = { scan, surface: NaN, geometry, revision: NaN, world: new Float64Array(16), matrices: new Float64Array(), keys: [] };
          this.thin.set(mesh, placements);
        }
        placements.scan = scan;
        const revision = positionRevision(geometry);
        if (placements.surface === this.surfaceEpoch && placements.revision === revision && sameMatrix(placements.world, world.m)
          && sameInstances(placements.matrices, instances) && placements.keys.every((key) => this.pieces.has(key))) {
          for (const key of placements.keys) seen.add(key);
          continue;
        }
        const local = geometryBounds(positions, revision);
        const localCentre = local.min.add(local.max).scaleInPlace(0.5), localRadius = Vector3.Distance(local.min, local.max) / 2;
        const keys: string[] = [];
        for (let i = 0; i < instances.length; i++) {
          instances[i]!.multiplyToRef(world, this.scratch);
          const m = this.scratch.m, scale = Math.sqrt(Math.max(m[0]! ** 2 + m[1]! ** 2 + m[2]! ** 2, m[4]! ** 2 + m[5]! ** 2 + m[6]! ** 2, m[8]! ** 2 + m[9]! ** 2 + m[10]! ** 2));
          Vector3.TransformCoordinatesToRef(localCentre, this.scratch, centre);
          const radius = localRadius * scale;
          sphereMin.set(centre.x - radius, centre.y - radius, centre.z - radius); sphereMax.set(centre.x + radius, centre.y + radius, centre.z + radius);
          if (!near(sphereMin, sphereMax)) continue;
          const placed = worldBox(local.min, local.max, this.scratch);
          if (!reaches(placed.min, placed.max)) continue;
          const key = `${mesh.uniqueId}:${i}`;
          keys.push(key);
          visit(key, mesh, i, m);
        }
        placements.surface = this.surfaceEpoch; placements.revision = revision;
        if (placements.matrices.length !== instances.length * 16) placements.matrices = new Float64Array(instances.length * 16);
        for (let i = 0; i < instances.length; i++) placements.matrices.set(instances[i]!.m, i * 16);
        placements.keys = keys;
        placements.world.set(world.m);
        continue;
      }
      if (reaches(min, max)) visit(`${mesh.uniqueId}`, mesh, -1, world.m);
    }
    for (const [key, piece] of this.pieces) {
      if (seen.has(key)) continue;
      if (piece.bounds) this.dirty.push(piece.bounds);
      if (piece.geometry) unwatchGeometry(piece.geometry);
      this.pieces.delete(key);
    }
    for (const [mesh, placements] of this.thin) {
      if (placements.scan === scan) continue;
      unwatchGeometry(placements.geometry);
      this.thin.delete(mesh);
    }
  }

  /**
   * Every frame, tracked placements are checked for rewritten vertices and (except thin instances) movement beyond
   * `MOVE_TOLERANCE_CELLS` since their last slice.
   */
  private track(): void {
    const tolerance = this.moveTolerance();
    for (const piece of this.pieces.values()) {
      if (piece.stale) continue;
      if (piece.mesh.isDisposed()) { piece.stale = true; continue; }
      if (this.geometryChanged(piece)) { piece.stale = true; continue; }
      if (piece.instance >= 0) continue;
      const world = piece.mesh.computeWorldMatrix();
      if (movedBeyond(piece.matrix, world.m, localReach(piece.mesh), tolerance)) { piece.matrix.set(world.m); piece.stale = true; }
    }
  }

  /** How far a placement may move before it is sliced again: none until cells are allocated. */
  private moveTolerance(): number {
    return this.rect ? this.cell * MOVE_TOLERANCE_CELLS : 0;
  }

  /**
   * Whether a stale placement can wait unsliced: this surface draws neither where its contacts were nor anywhere within
   * range of where it is (a blending neighbour owns the water there, `WaterFieldSurface.draws`), so no cell it would
   * change is seen. It stays stale and is asked again at each rebuild, which follows any change of `draws`.
   */
  private parked(piece: Piece): boolean {
    if (!this.rect || !this.surface.draws || piece.instance >= 0 || piece.mesh.isDisposed()) return false;
    const grow = this.range + this.cell, box = piece.mesh.getBoundingInfo().boundingBox;
    const { minimumWorld: min, maximumWorld: max } = box;
    if (!this.undrawnArea(min.x - grow, min.z - grow, max.x + grow, max.z + grow)) return false;
    const before = piece.bounds;
    return !before || this.undrawnArea(before.minX - grow, before.minZ - grow, before.maxX + grow, before.maxZ + grow);
  }

  /**
   * Lowest and highest rest height beneath a box, from its centre, corners and edges (e.g. a pier centred on
   * land); level bodies stop at the first sample inside the footprint. Null when the box misses the body.
   */
  private levelsIn(min: Vector3, max: Vector3): [number, number] | null {
    const cx = (min.x + max.x) / 2, cz = (min.z + max.z) / 2, varies = this.surface.restVaries === true;
    let low = Infinity, high = -Infinity;
    for (const [x, z] of [[cx, cz], [min.x, min.z], [max.x, min.z], [min.x, max.z], [max.x, max.z], [cx, min.z], [cx, max.z], [min.x, cz], [max.x, cz]] as const) {
      const level = this.surface.surfaceY(x, z);
      if (level === null) continue;
      low = Math.min(low, level); high = Math.max(high, level);
      if (!varies) break;
    }
    return low <= high ? [low, high] : null;
  }

  /**
   * Cross-sections and envelope triangles of one placement: world X/Z, heights relative to the local rest height. On a
   * level body a vertex's height decides first, and only the vertices of triangles that reach the envelope (or cross a
   * thin piece's mid-height) get their X/Z, by the same arithmetic as `Vector3.TransformCoordinatesFromFloatsToRef`.
   */
  private slice(piece: Piece): void {
    piece.stale = false; piece.bounds = null; piece.contours = []; piece.closed = []; piece.triangles = NO_VALUES;
    const mesh = piece.mesh;
    if (mesh.isDisposed()) return;
    const source = mesh instanceof InstancedMesh ? mesh.sourceMesh : mesh as Mesh;
    this.geometryChanged(piece);
    piece.revision = positionRevision(piece.geometry);
    const positions = source.getVerticesData(VertexBuffer.PositionKind);
    const indices = positions && source.isUnIndexed ? sequentialIndices(positions.length / 3) : source.getIndices();
    if (!positions || !indices) return;
    // A mesh that kept moving while its rebuild was throttled is sliced where it is now.
    if (piece.instance < 0) piece.matrix.set(mesh.computeWorldMatrix().m);
    const matrix = Matrix.FromArrayToRef(piece.matrix, 0, sliceMatrix);
    const local = geometryBounds(positions, piece.revision);
    const placed = worldBox(local.min, local.max, matrix);
    const levels = this.levelsIn(placed.min, placed.max);
    if (levels === null) return;
    const amplitude = this.amplitude, low = -amplitude, high = amplitude;
    const heights = WATER_CONTACT_LAYER_OFFSETS.map((offset) => offset * amplitude);
    const level = !this.surface.restVaries || !this.surface.restY;
    const rest = this.restHeights(placed.min, placed.max, levels[0]);
    if (sliceWorld.length < positions.length) { sliceWorld = new Float64Array(positions.length); sliceKnown = new Uint32Array(Math.ceil(positions.length / 3)); }
    if (++sliceStamp > 0xffffffff) { sliceKnown.fill(0); sliceStamp = 1; }
    const world = sliceWorld.subarray(0, positions.length), known = sliceKnown, stamp = sliceStamp, m = matrix.m;
    // A trailing partial vertex reads as the origin, as in a fresh array.
    world.fill(0, positions.length - positions.length % 3);
    for (let i = 0; i + 2 < positions.length; i += 3) {
      const x = positions[i]!, y = positions[i + 1]!, z = positions[i + 2]!;
      const ry = x * m[1]! + y * m[5]! + z * m[9]! + m[13]!;
      const rw = 1 / (x * m[3]! + y * m[7]! + z * m[11]! + m[15]!);
      if (level) {
        // X/Z wait for `place`; meanwhile the X slot keeps the vertex's w.
        world[i] = rw; world[i + 1] = ry * rw - levels[0];
        continue;
      }
      const px = (x * m[0]! + y * m[4]! + z * m[8]! + m[12]!) * rw, pz = (x * m[2]! + y * m[6]! + z * m[10]! + m[14]!) * rw;
      world[i] = px; world[i + 1] = ry * rw - rest(px, pz); world[i + 2] = pz;
      known[i / 3] = stamp;
    }
    /** World X/Z of the vertex at `p` (its index × 3), once. */
    const place = (p: number) => {
      if (known[p / 3] === stamp) return;
      known[p / 3] = stamp;
      const x = positions[p]!, y = positions[p + 1]!, z = positions[p + 2]!, rw = world[p]!;
      world[p] = (x * m[0]! + y * m[4]! + z * m[8]! + m[12]!) * rw;
      world[p + 2] = (x * m[2]! + y * m[6]! + z * m[10]! + m[14]!) * rw;
    };
    const triangles = sliceTriangles, layers = sliceLayers;
    triangles.length = 0; sliceSection.length = 0;
    for (const layer of layers) layer.length = 0;
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity, reached = false;
    // Canonical edge order makes a shared edge's crossing bitwise identical from both faces, so
    // closed cross-sections pair every endpoint exactly and their interior can be filled.
    const cross = (p: number, q: number, y: number, out: Values) => {
      const before = world[p + 1]! < world[q + 1]! || (world[p + 1] === world[q + 1] && (world[p]! < world[q]! || (world[p] === world[q] && world[p + 2]! <= world[q + 2]!)));
      const a = before ? p : q, b = before ? q : p;
      const t = (y - world[a + 1]!) / (world[b + 1]! - world[a + 1]!);
      const into = room(out, 2);
      into[out.length++] = world[a]! + (world[b]! - world[a]!) * t;
      into[out.length++] = world[a + 2]! + (world[b + 2]! - world[a + 2]!) * t;
    };
    for (let t = 0; t + 2 < indices.length; t += 3) {
      const a = indices[t]! * 3, b = indices[t + 1]! * 3, c = indices[t + 2]! * 3;
      const ya = world[a + 1]!, yb = world[b + 1]!, yc = world[c + 1]!;
      if (Math.max(ya, yb, yc) < low || Math.min(ya, yb, yc) > high) continue;
      place(a); place(b); place(c);
      const into = room(triangles, 9);
      let n = triangles.length;
      into[n++] = world[a]!; into[n++] = ya; into[n++] = world[a + 2]!;
      into[n++] = world[b]!; into[n++] = yb; into[n++] = world[b + 2]!;
      into[n++] = world[c]!; into[n++] = yc; into[n++] = world[c + 2]!;
      triangles.length = n;
      reached = true;
      minX = Math.min(minX, world[a]!, world[b]!, world[c]!); minZ = Math.min(minZ, world[a + 2]!, world[b + 2]!, world[c + 2]!);
      maxX = Math.max(maxX, world[a]!, world[b]!, world[c]!); maxZ = Math.max(maxZ, world[a + 2]!, world[b + 2]!, world[c + 2]!);
      for (let k = 0; k < LAYERS; k++) {
        const y = heights[k]!;
        const sa = ya <= y, sb = yb <= y, sc = yc <= y;
        if (sa === sb && sb === sc) continue;
        const out = layers[k]!;
        if (sa !== sb) cross(a, b, y, out);
        if (sb !== sc) cross(b, c, y, out);
        if (sc !== sa) cross(c, a, y, out);
      }
    }
    // Thin objects (a raft, a plank, a float riding the waves) can lie between two layers without crossing either, so
    // the shader's blend of the layers around the water's height never reached the hull and they showed no waterline.
    // A piece thinner than the layer spacing is also cut at its own mid-height, and that section stands in for every
    // layer within one spacing of it that it does not cross.
    const sections: Values[] = layers.slice();
    let bottom = Infinity, top = -Infinity;
    for (let i = 1; i < triangles.length; i += 3) { bottom = Math.min(bottom, triangles.values[i]!); top = Math.max(top, triangles.values[i]!); }
    const spacing = amplitude * 2 / (LAYERS - 1);
    if (triangles.length > 0 && top - bottom < spacing) {
      const middle = (bottom + top) / 2;
      let cut = false;
      for (let k = 0; k < LAYERS; k++) {
        if (layers[k]!.length > 0 || Math.abs(heights[k]! - middle) >= spacing) continue;
        if (!cut) {
          cut = true;
          for (let t = 0; t + 2 < indices.length; t += 3) {
            const a = indices[t]! * 3, b = indices[t + 1]! * 3, c = indices[t + 2]! * 3;
            const sa = world[a + 1]! <= middle, sb = world[b + 1]! <= middle, sc = world[c + 1]! <= middle;
            if (sa === sb && sb === sc) continue;
            place(a); place(b); place(c);
            if (sa !== sb) cross(a, b, middle, sliceSection);
            if (sb !== sc) cross(b, c, middle, sliceSection);
            if (sc !== sa) cross(c, a, middle, sliceSection);
          }
        }
        sections[k] = sliceSection;
      }
    }
    piece.bounds = reached ? { minX, minZ, maxX, maxZ } : null;
    piece.triangles = triangles.values.slice(0, triangles.length);
    piece.contours = sections.map((list) => list.values.slice(0, list.length));
    // A closed cross-section pairs every endpoint. Ring seams (cos/sin of 0 and 2*pi) differ by
    // rounding, so endpoints match to a tenth of a millimetre.
    piece.closed = piece.contours.map((segments) => {
      const open = new Set<string>();
      for (let i = 0; i < segments.length; i += 2) {
        const key = Math.round(segments[i]! * 1e4) + "," + Math.round(segments[i + 1]! * 1e4);
        if (open.has(key)) open.delete(key); else open.add(key);
      }
      return segments.length > 0 && open.size === 0;
    });
  }

  /**
   * Rest height under a world X/Z within a box. Level bodies use one height; sloped ones (rivers, tilted volumes)
   * interpolate a grid of rest samples, so a long object is cut at its own waterline along its whole length.
   */
  private restHeights(min: Vector3, max: Vector3, level: number): (x: number, z: number) => number {
    const restY = this.surface.restY;
    if (!this.surface.restVaries || !restY) return () => level;
    // About a sample per metre: rest heights vary smoothly, so small objects need only their corners.
    const count = (extent: number) => Math.max(2, Math.min(REST_GRID, Math.ceil(extent / REST_SPACING) + 1));
    const nx = count(max.x - min.x), nz = count(max.z - min.z);
    const sx = Math.max(1e-6, max.x - min.x) / (nx - 1), sz = Math.max(1e-6, max.z - min.z) / (nz - 1);
    const grid = new Float64Array(nx * nz);
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) grid[j * nx + i] = restY(min.x + i * sx, min.z + j * sz);
    return (x, z) => {
      const u = Math.max(0, Math.min(nx - 1, (x - min.x) / sx)), v = Math.max(0, Math.min(nz - 1, (z - min.z) / sz));
      const i = Math.min(nx - 2, Math.floor(u)), j = Math.min(nz - 2, Math.floor(v)), fu = u - i, fv = v - j;
      const a = grid[j * nx + i]! + (grid[j * nx + i + 1]! - grid[j * nx + i]!) * fu;
      const b = grid[(j + 1) * nx + i]! + (grid[(j + 1) * nx + i + 1]! - grid[(j + 1) * nx + i]!) * fu;
      return a + (b - a) * fv;
    };
  }

  /**
   * Re-slices stale placements and works out which cells that changes. Outside `sync` slicing stops once the frame's
   * budget is spent (`spent` before this update, plus what this update took since `start`), after at least one
   * placement; the rest stay stale for the next updates, least recently sliced first (`backlog`). `rebuildAll` (and an
   * allocation that cannot carry its cells over) rebuilds every cell: at once with `sync`, otherwise as one queued
   * window, the cells keeping what they show (their last result, or far for new ones) until it is built. Otherwise the
   * changed windows are queued (all of the cells for `recut`, a surface that moved). Returns whether the texture changed.
   */
  private rebuild(rebuildAll: boolean, recut: boolean, now: number, sync: boolean, spent: number, start: number): boolean {
    this.backlog = false;
    let sliced = 0;
    for (const [key, piece] of this.pieces) {
      if (!piece.stale) continue;
      if (!sync && !rebuildAll && !recut && this.parked(piece)) continue;
      if (!sync && sliced > 0 && spent + performance.now() - start >= WATER_CONTACT_FRAME_BUDGET_MS) { this.backlog = true; break; }
      const before = piece.bounds;
      this.slice(piece);
      sliced++;
      // The last sliced go to the end, so a backlog always resumes with the placements that waited longest.
      this.pieces.delete(key); this.pieces.set(key, piece);
      if (before) this.dirty.push(before);
      if (piece.bounds) this.dirty.push(piece.bounds);
    }
    let reach: Rect | null = null;
    for (const piece of this.pieces.values()) reach = union(reach, piece.bounds);
    if (!reach) {
      const had = this.texture !== null;
      this.release(); this.dirty = [];
      return had;
    }
    const target = Math.max(MIN_CELL, Math.min(MAX_TARGET_CELL, this.range / 24));
    const margin = this.range + 2 * target;
    const needed = { minX: reach.minX - margin, minZ: reach.minZ - margin, maxX: reach.maxX + margin, maxZ: reach.maxZ + margin };
    // Widely spread objects coarsen the cells in doublings, so small moves keep the allocation. Snapping to 16-cell
    // blocks adds under 32 cells per side, so the cap leaves room for it.
    const spread = Math.max(needed.maxX - needed.minX, needed.maxZ - needed.minZ) / ((this.maxCells - 32) * target);
    const cell = target * (spread > 1 ? 2 ** Math.ceil(Math.log2(spread)) : 1);
    const current = this.rect;
    const fits = current && this.cell === cell && Math.max(this.width, this.height) <= this.maxCells
      && current.minX <= needed.minX && current.minZ <= needed.minZ && current.maxX >= needed.maxX && current.maxZ >= needed.maxZ
      // Release most of an oversized field once objects leave.
      && (current.maxX - current.minX) * (current.maxZ - current.minZ) <= 4 * (needed.maxX - needed.minX + 16 * cell) * (needed.maxZ - needed.minZ + 16 * cell);
    // A moved object that outgrows the allocation carries the cells it keeps over to the new one, so only what its
    // movement changed rebuilds (a first allocation, or another cell size, rebuilds everything).
    const grown = !fits;
    if (grown && !this.allocate(needed, cell, now)) rebuildAll = true;
    const everything: Window = { x0: 0, z0: 0, x1: this.width, z1: this.height };
    const dirty = this.dirty;
    this.dirty = [];
    if (rebuildAll || recut) {
      // Every cell is rebuilt: results sent earlier would only be overwritten.
      this.queue.length = 0;
      this.invalidateFlight(false);
    }
    if (rebuildAll && sync) {
      this.fill(everything, everything);
      this.upload([everything], true);
      return true;
    }
    // A new allocation is uploaded at once, so a texture stays bound while its cells come in.
    if (grown) this.upload([everything], true);
    // Every cell is stale, but they come in as windows within the budget (for a moved surface, at its newest pose).
    if (rebuildAll || recut) { this.enqueue(everything, now); return grown; }
    for (const rect of dirty) this.enqueue(this.toWindow(rect, this.reach()), now);
    return grown;
  }

  /**
   * Allocates cells for `needed`. Returns whether the previous cells it shares with the new allocation were carried
   * over (same cell size: every allocation snaps to the same lattice) with the queued windows, and those at the
   * worker, moved to match, so only what changed needs rebuilding; otherwise everything does.
   */
  private allocate(needed: Rect, cell: number, now: number): boolean {
    // Snap to 16-cell blocks so small moves stay inside the allocation.
    const block = cell * 16;
    const rect = {
      minX: Math.floor(needed.minX / block) * block, minZ: Math.floor(needed.minZ / block) * block,
      maxX: Math.ceil(needed.maxX / block) * block, maxZ: Math.ceil(needed.maxZ / block) * block,
    };
    const width = Math.max(2, Math.round((rect.maxX - rect.minX) / cell)), height = Math.max(2, Math.round((rect.maxZ - rect.minZ) / cell));
    if (this.texture && (width !== this.width || height !== this.height)) { this.texture.dispose(); this.texture = null; }
    const previous = this.data, before = this.rect, oldWidth = this.width, oldHeight = this.height;
    const carry = previous !== null && before !== null && this.cell === cell;
    // Results computed for the previous cells land nowhere now; carried over, their windows are queued again below.
    this.invalidateFlight(carry);
    this.rect = rect; this.cell = cell; this.width = width; this.height = height;
    this.data = new Uint8Array(width * height * 4).fill(255);
    this.bounds[0] = rect.minX; this.bounds[1] = rect.minZ;
    this.bounds[2] = 1 / (width * cell); this.bounds[3] = 1 / (height * cell);
    if (!carry) { this.queue.length = 0; return false; }
    // The old cell (0, 0) lies at (dx, dz) in the new allocation.
    const dx = Math.round((before.minX - rect.minX) / cell), dz = Math.round((before.minZ - rect.minZ) / cell);
    const x0 = Math.max(0, dx), x1 = Math.min(width, dx + oldWidth), z0 = Math.max(0, dz), z1 = Math.min(height, dz + oldHeight);
    for (let z = z0; z < z1; z++) {
      this.data.set(previous.subarray(((z - dz) * oldWidth + x0 - dx) * 4, ((z - dz) * oldWidth + x1 - dx) * 4), (z * width + x0) * 4);
    }
    for (let i = this.queue.length - 1; i >= 0; i--) {
      const w = this.queue[i]!;
      w.x0 = Math.max(0, w.x0 + dx); w.x1 = Math.min(width, w.x1 + dx); w.z0 = Math.max(0, w.z0 + dz); w.z1 = Math.min(height, w.z1 + dz);
      if (w.x0 >= w.x1 || w.z0 >= w.z1) this.queue.splice(i, 1);
    }
    // The rounding filters stopped at the old allocation's edges: where an edge now lies inside, the cells within their
    // reach on either side are rebuilt, as a build of the whole new allocation would have them.
    const band = 2 * contactSmoothRadius(this.range, cell) + 1;
    const strip = (sx0: number, sz0: number, sx1: number, sz1: number) => this.enqueue({
      x0: Math.max(0, sx0), z0: Math.max(0, sz0), x1: Math.min(width, sx1), z1: Math.min(height, sz1),
    }, now);
    if (dx > 0) strip(dx - band, dz - band, dx + band, dz + oldHeight + band);
    if (dx + oldWidth < width) strip(dx + oldWidth - band, dz - band, dx + oldWidth + band, dz + oldHeight + band);
    if (dz > 0) strip(dx - band, dz - band, dx + oldWidth + band, dz + band);
    if (dz + oldHeight < height) strip(dx - band, dz + oldHeight - band, dx + oldWidth + band, dz + oldHeight + band);
    return true;
  }

  /**
   * How far (metres) a change of objects within a rectangle changes cells: their distances out to the contact range,
   * and the rounding filters' reach (twice the smoothing radius) beyond.
   */
  private reach(): number {
    return this.range + this.cell * (2 * contactSmoothRadius(this.range, this.cell) + 1);
  }

  private toWindow(rect: Rect, grow: number): Window {
    const r = this.rect!, cell = this.cell;
    return {
      x0: Math.max(0, Math.floor((rect.minX - grow - r.minX) / cell)), z0: Math.max(0, Math.floor((rect.minZ - grow - r.minZ) / cell)),
      x1: Math.min(this.width, Math.ceil((rect.maxX + grow - r.minX) / cell) + 1), z1: Math.min(this.height, Math.ceil((rect.maxZ + grow - r.minZ) / cell) + 1),
    };
  }

  /**
   * The rasteriser's job for the cells of `write`, computed over `target` (`write` or a window around it): the
   * allocation, settings and every placement within range of it, as plain arrays (the worker gets a copy).
   */
  private job(target: Window, write: Window): ContactRasterJob {
    const grid = this.grid();
    const reach = contactRasterReach(grid, target);
    const pieces: ContactRasterPiece[] = [];
    for (const { bounds: b, contours, closed, triangles } of this.pieces.values()) {
      if (b && b.maxX >= reach.minX && b.minX <= reach.maxX && b.maxZ >= reach.minZ && b.minZ <= reach.maxZ) pieces.push({ contours, closed, triangles });
    }
    return { ...grid, target, write, pieces };
  }

  /**
   * Recomputes every layer of the cells in `write`, seeding from all objects within range of them (`rasterContactWindow`).
   * `target` (`write` or a window around it) is the region computed: the rounding filters read neighbours, so the cells
   * of `write` come out exact only when `target` reaches twice the smoothing radius past them (or the edge of the texture).
   */
  private fill(target: Window, write: Window): void {
    const size = (write.x1 - write.x0) * (write.z1 - write.z0) * 4;
    if (scratchTexels.length < size) scratchTexels = new Uint8Array(size);
    const texels = scratchTexels.subarray(0, size);
    rasterContactWindow(this.job(target, write), texels);
    this.place(write, texels);
  }

  /** Copies a window's texels (rows tightly packed) into `data`. */
  private place(window: Window, texels: Uint8Array): void {
    const data = this.data!, rowBytes = (window.x1 - window.x0) * 4;
    for (let z = window.z0; z < window.z1; z++) {
      data.set(texels.subarray((z - window.z0) * rowBytes, (z - window.z0 + 1) * rowBytes), (z * this.width + window.x0) * 4);
    }
  }

  private upload(windows: Window[], full: boolean): void {
    const data = this.data!;
    const engine = this.scene.getEngine() as AbstractEngine & Partial<Pick<ThinEngine, "updateTextureData">>;
    if (!this.texture) {
      // On the Engine, not the Scene (see the class): RGBA8, no mips, bilinear, clamped. The Engine keeps `data` as the
      // texture's contents for a lost context, as for any raw texture; uploads change that array in place or replace it.
      const internal = engine.createRawTexture(data, this.width, this.height, Constants.TEXTUREFORMAT_RGBA, false, false, Texture.BILINEAR_SAMPLINGMODE, null, Constants.TEXTURETYPE_UNSIGNED_BYTE);
      this.texture = new BaseTexture(engine, internal);
      this.texture.name = `${this.surface.mesh.name}:water-contacts`;
      this.texture.wrapU = this.texture.wrapV = Texture.CLAMP_ADDRESSMODE;
      return;
    }
    const internal = this.texture.getInternalTexture();
    if (!internal) return;
    const area = windows.reduce((sum, w) => sum + (w.x1 - w.x0) * (w.z1 - w.z0), 0);
    if (full || !engine.updateTextureData || engine instanceof NullEngine || area * 2 > this.width * this.height) {
      engine.updateRawTexture(internal, data, Constants.TEXTUREFORMAT_RGBA, false, null, Constants.TEXTURETYPE_UNSIGNED_BYTE);
      return;
    }
    // Moving objects only re-upload their neighbourhood.
    for (const w of windows) {
      const rowBytes = (w.x1 - w.x0) * 4, part = new Uint8Array(rowBytes * (w.z1 - w.z0));
      for (let z = w.z0; z < w.z1; z++) part.set(data.subarray((z * this.width + w.x0) * 4, (z * this.width + w.x1) * 4), (z - w.z0) * rowBytes);
      engine.updateTextureData(internal, part, w.x0, w.z0, w.x1 - w.x0, w.z1 - w.z0);
    }
  }
}

/** Indices of unindexed geometry, whose vertices are consecutive triangles. */
function sequentialIndices(count: number): Uint32Array {
  const indices = new Uint32Array(count);
  for (let i = 0; i < count; i++) indices[i] = i;
  return indices;
}

/** The same thin-instance matrix values, in the same order. */
function sameInstances(a: Float64Array, b: readonly Matrix[]): boolean {
  if (a.length !== b.length * 16) return false;
  for (let i = 0; i < b.length; i++) {
    const m = b[i]!.m;
    for (let j = 0; j < 16; j++) if (a[i * 16 + j] !== m[j]) return false;
  }
  return true;
}
