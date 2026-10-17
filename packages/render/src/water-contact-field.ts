import {
  Constants,
  InstancedMesh,
  LinesMesh,
  Matrix,
  Mesh,
  NullEngine,
  RawTexture,
  Texture,
  Vector3,
  VertexBuffer,
  type AbstractEngine,
  type AbstractMesh,
  type Geometry,
  type Scene,
  type ThinEngine,
} from "@babylonjs/core";
import { viewOfBox, type BoxView } from "./active-view";
import { geometryRevision, unwatchGeometry, watchGeometry } from "./geometry-revision";
import { isEditorHelperMesh } from "./helper-mesh";
import { RENDERING_GROUP } from "./sorting";
import { distanceTransform, type WaterFieldSurface } from "./water-field";

/**
 * Contact layers: RGBA8 channel `k` stores the signed distance to objects at rest height
 * + `WATER_CONTACT_LAYER_OFFSETS[k]` x amplitude. The shader blends the two layers around each
 * fragment's rendered (wave-displaced) height, so foam follows the real waterline without rebakes.
 */
export const WATER_CONTACT_LAYER_OFFSETS: readonly number[] = [-1, -1 / 3, 1 / 3, 1];
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
 * The contact cost cap: milliseconds of window rebuilds (`WaterContactField.fillWindow`) a scene's surfaces start in
 * one frame. A moving object only queues the window around it (`WaterContactField.enqueue`); each frame the scene's
 * queue serves its most important windows first (`WaterContactField.next`) until this is spent, and always one, so a
 * frame costs at most this plus the window that crosses it (at most `MAX_WINDOW` cells a side). Full rebuilds (a new
 * surface, a reshaped body, a resolution change or a forced update) and re-slicing moved objects run at once but are
 * counted, so queued windows wait that frame. Windows still wait only while the cap is spent, so every one is built.
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
/** The most cells per side one rebuilt window covers: larger regions are cut into blocks of about this size. */
const MAX_WINDOW = 64;
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
/** Surfaces above or below a layer count a little more than horizontal ones, so nearness is not contact. */
const VERTICAL_WEIGHT = 1.5;
/** Most rest-height samples per side over an object on a sloped body (rivers, tilted volumes), bilinearly interpolated. */
const REST_GRID = 17;
const REST_SPACING = 1;
const INF = 1e20;

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
  return mesh.getTotalIndices() > 0;
}

type Rect = { minX: number; minZ: number; maxX: number; maxZ: number };
/** Inclusive-exclusive cell window. */
type Window = { x0: number; z0: number; x1: number; z1: number };
/**
 * A window waiting for the frame budget. `since` is when it was first queued (a window that grows or merges while it
 * waits keeps its age); `hidden` is whether no body draws this surface anywhere in it, as of `stamp`.
 */
type Queued = Window & { since: number; stamp: number; hidden: boolean };
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

/** `WaterContactField.fill`'s per-window seeds, inside flags and scanline rows, shared and grown on demand. */
let scratchSeed = new Float32Array(0), scratchInside = new Uint8Array(0);
const scratchRows: number[][] = [];

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
 * moving object a few frames late, never wrongly.
 */
export class WaterContactField {
  texture: RawTexture | null = null;
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
  /** Windows were built since `update` last reported. */
  private touched = false;
  private lastScan = -Infinity;
  /** Milliseconds this surface's periodic scans run ahead of the others' (`SCAN_PHASES`). */
  private readonly scanPhase = (scanPhases++ % SCAN_PHASES) * SCAN_MS / SCAN_PHASES;
  private lastBuild = -Infinity;
  /** The surface moved since its last full rebuild, which waits for `SURFACE_MOVE_MS` to pass. */
  private surfaceMoved = false;
  /** The texture was given back (`releaseTexture`) and waits for `restore`. */
  private released = false;
  private readonly surfaceState = new Float64Array(19).fill(NaN);
  private readonly scratch = new Matrix();

  private readonly scene: Scene;
  private readonly surface: WaterFieldSurface;

  constructor(scene: Scene, surface: WaterFieldSurface) {
    this.scene = scene;
    this.surface = surface;
    let fields = sceneFields.get(scene);
    if (!fields) { fields = new Set(); sceneFields.set(scene, fields); }
    fields.add(this);
  }

  /** Windows still waiting for the frame budget (some may wait on another body drawing the surface instead). */
  get queued(): number { return this.queue.length; }

  /**
   * Track objects and queue what changed, then build the scene's queued windows within the frame's budget. Returns true
   * when the texture changed. A changed wave envelope, contact range or cell cap cuts every object again and rebuilds
   * every cell at once; so does a moved surface, but while it keeps moving (a dragged, animated or tide-driven body) at
   * most every `SURFACE_MOVE_MS` and as one queued window: its contacts lag its pose by that much plus the queue, and
   * its last pose always lands. A released texture (`releaseTexture`) waits for `restore`.
   */
  update(now: number, force = false): boolean {
    const surface = this.syncSurface();
    if (surface === SURFACE_MOVED) this.surfaceMoved = true;
    if (this.released && !force) return false;
    const rebuildAll = force || surface === SURFACE_CHANGED;
    const recut = !rebuildAll && this.surfaceMoved && (this.lastBuild === -Infinity || now - this.lastBuild >= SURFACE_MOVE_MS);
    const full = rebuildAll || recut;
    if (full) this.surfaceMoved = false;
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
    if (stale && (full || now - this.lastBuild >= MOVE_MS)) {
      this.lastBuild = now;
      const budget = frameBudget(this.scene), start = performance.now();
      changed = this.rebuild(rebuildAll, recut, now);
      // Re-slicing and full rebuilds are not queued but count against the frame; a full one is the frame's progress too.
      budget.spent += Math.max(performance.now() - start, MIN_WINDOW_MS);
      if (rebuildAll) budget.ran++;
    }
    WaterContactField.drain(this.scene, now);
    changed ||= this.touched; this.touched = false;
    return changed;
  }

  /**
   * Builds the scene's queued windows, across all its surfaces, most important first, until the frame's budget is spent
   * (the first window of a frame always runs). A window larger than `MAX_WINDOW` is only cut into blocks, which costs
   * nothing, and its blocks queue again.
   */
  private static drain(scene: Scene, now: number): void {
    const fields = sceneFields.get(scene);
    if (!fields) return;
    const budget = frameBudget(scene);
    for (;;) {
      if (budget.ran > 0 && budget.spent >= WATER_CONTACT_FRAME_BUDGET_MS) return;
      let best: WaterContactField | null = null, index = -1, key = Infinity;
      for (const field of fields) {
        if (field.queue.length === 0 || field.released || !field.data) continue;
        field.next(now);
        if (pick.index >= 0 && pick.key < key) { best = field; index = pick.index; key = pick.key; }
      }
      if (!best) return;
      const start = performance.now();
      if (!best.build(index)) continue;
      budget.spent += Math.max(performance.now() - start, MIN_WINDOW_MS);
      budget.ran++;
    }
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
    const draws = this.surface.draws;
    if (!draws) return false;
    const r = this.rect!, cell = this.cell;
    const x0 = r.minX + window.x0 * cell, x1 = r.minX + window.x1 * cell, z0 = r.minZ + window.z0 * cell, z1 = r.minZ + window.z1 * cell;
    return !(draws((x0 + x1) / 2, (z0 + z1) / 2) || draws(x0, z0) || draws(x1, z0) || draws(x0, z1) || draws(x1, z1));
  }

  /** Builds queued window `index`, or cuts it into blocks of at most `MAX_WINDOW` cells a side and queues those (false). */
  private build(index: number): boolean {
    const window = this.queue[index]!;
    this.queue.splice(index, 1);
    const width = window.x1 - window.x0, height = window.z1 - window.z0;
    const nx = Math.ceil(width / MAX_WINDOW), nz = Math.ceil(height / MAX_WINDOW);
    if (nx * nz > 1) {
      for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
        this.queue.push({
          x0: window.x0 + Math.floor(width * i / nx), x1: window.x0 + Math.floor(width * (i + 1) / nx),
          z0: window.z0 + Math.floor(height * j / nz), z1: window.z0 + Math.floor(height * (j + 1) / nz),
          since: window.since, stamp: NaN, hidden: false,
        });
      }
      return false;
    }
    // The blur and minimum filters read a few cells past the window: those are computed too, so no seam shows between
    // a rebuilt window and its stale neighbour.
    const margin = this.smoothRadius() * 2 + 1;
    this.fill({
      x0: Math.max(0, window.x0 - margin), z0: Math.max(0, window.z0 - margin),
      x1: Math.min(this.width, window.x1 + margin), z1: Math.min(this.height, window.z1 + margin),
    }, window);
    this.upload([window], false);
    this.touched = true;
    return true;
  }

  /**
   * Queues a window of changed cells. Windows that overlap it merge into one, which keeps the oldest age, so nothing is
   * built twice and a window that keeps changing while it waits still goes by when it first changed.
   */
  private enqueue(next: Window, now: number): void {
    if (next.x0 >= next.x1 || next.z0 >= next.z1) return;
    let merged: Queued = { ...next, since: now, stamp: NaN, hidden: false };
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

  /** Radius (cells) of the box blurs and minimum filter that round the distances (`smoothContacts`, `minimumFilter`). */
  private smoothRadius(): number {
    return Math.max(1, Math.round(this.range / CONTACT_SMOOTH / this.cell));
  }

  /**
   * Whether the wave envelope, contact range or cell cap changed (`SURFACE_CHANGED`), else whether only the surface
   * placement did (`SURFACE_MOVED`). Reshaping a body forces an update instead, so animated wave bounds never trigger a
   * rebuild.
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
   * `restore` uploads them again and only what moved meanwhile rebuilds.
   */
  releaseTexture(): void {
    this.texture?.dispose(); this.texture = null; this.released = true;
  }

  /** The texture again after `releaseTexture`; anything that changed meanwhile rebuilds as usual. */
  restore(now: number): void {
    this.released = false;
    if (this.syncSurface() !== SURFACE_SAME) this.surfaceMoved = true;
    if (!this.surfaceMoved && this.data && !this.texture) this.upload([], true);
    this.update(now, this.surfaceMoved || !this.data);
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
      } else if (piece.mesh !== mesh || !sameMatrix(piece.matrix, matrix)) {
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

  /** Every frame, tracked placements are checked for rewritten vertices and (except thin instances) movement. */
  private track(): void {
    for (const piece of this.pieces.values()) {
      if (piece.stale) continue;
      if (piece.mesh.isDisposed()) { piece.stale = true; continue; }
      if (this.geometryChanged(piece)) { piece.stale = true; continue; }
      if (piece.instance >= 0) continue;
      const world = piece.mesh.computeWorldMatrix();
      if (!sameMatrix(piece.matrix, world.m)) { piece.matrix.set(world.m); piece.stale = true; }
    }
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

  /** Cross-sections and envelope triangles of one placement: world X/Z, heights relative to the local rest height. */
  private slice(piece: Piece): void {
    piece.stale = false; piece.bounds = null; piece.contours = []; piece.closed = []; piece.triangles = new Float64Array();
    const mesh = piece.mesh;
    if (mesh.isDisposed()) return;
    const source = mesh instanceof InstancedMesh ? mesh.sourceMesh : mesh as Mesh;
    this.geometryChanged(piece);
    piece.revision = positionRevision(piece.geometry);
    const positions = source.getVerticesData(VertexBuffer.PositionKind), indices = source.getIndices();
    if (!positions || !indices) return;
    // A mesh that kept moving while its rebuild was throttled is sliced where it is now.
    if (piece.instance < 0) piece.matrix.set(mesh.computeWorldMatrix().m);
    const matrix = Matrix.FromArray(piece.matrix);
    const local = geometryBounds(positions, piece.revision);
    const placed = worldBox(local.min, local.max, matrix);
    const levels = this.levelsIn(placed.min, placed.max);
    if (levels === null) return;
    const amplitude = this.amplitude, low = -amplitude, high = amplitude;
    const heights = WATER_CONTACT_LAYER_OFFSETS.map((offset) => offset * amplitude);
    const rest = this.restHeights(placed.min, placed.max, levels[0]);
    const world = new Float64Array(positions.length), point = new Vector3();
    for (let i = 0; i + 2 < positions.length; i += 3) {
      Vector3.TransformCoordinatesFromFloatsToRef(positions[i]!, positions[i + 1]!, positions[i + 2]!, matrix, point);
      world[i] = point.x; world[i + 1] = point.y - rest(point.x, point.z); world[i + 2] = point.z;
    }
    const triangles: number[] = [], contours: number[][] = heights.map(() => []);
    let bounds: Rect | null = null;
    // Canonical edge order makes a shared edge's crossing bitwise identical from both faces, so
    // closed cross-sections pair every endpoint exactly and their interior can be filled.
    const cross = (p: number, q: number, y: number, out: number[]) => {
      const before = world[p + 1]! < world[q + 1]! || (world[p + 1] === world[q + 1] && (world[p]! < world[q]! || (world[p] === world[q] && world[p + 2]! <= world[q + 2]!)));
      const a = before ? p : q, b = before ? q : p;
      const t = (y - world[a + 1]!) / (world[b + 1]! - world[a + 1]!);
      out.push(world[a]! + (world[b]! - world[a]!) * t, world[a + 2]! + (world[b + 2]! - world[a + 2]!) * t);
    };
    for (let t = 0; t + 2 < indices.length; t += 3) {
      const a = indices[t]! * 3, b = indices[t + 1]! * 3, c = indices[t + 2]! * 3;
      const ya = world[a + 1]!, yb = world[b + 1]!, yc = world[c + 1]!;
      if (Math.max(ya, yb, yc) < low || Math.min(ya, yb, yc) > high) continue;
      triangles.push(world[a]!, ya, world[a + 2]!, world[b]!, yb, world[b + 2]!, world[c]!, yc, world[c + 2]!);
      bounds = union(bounds, {
        minX: Math.min(world[a]!, world[b]!, world[c]!), minZ: Math.min(world[a + 2]!, world[b + 2]!, world[c + 2]!),
        maxX: Math.max(world[a]!, world[b]!, world[c]!), maxZ: Math.max(world[a + 2]!, world[b + 2]!, world[c + 2]!),
      });
      for (let k = 0; k < LAYERS; k++) {
        const y = heights[k]!;
        const sa = ya <= y, sb = yb <= y, sc = yc <= y;
        if (sa === sb && sb === sc) continue;
        const out = contours[k]!;
        if (sa !== sb) cross(a, b, y, out);
        if (sb !== sc) cross(b, c, y, out);
        if (sc !== sa) cross(c, a, y, out);
      }
    }
    // Thin objects (a raft, a plank, a float riding the waves) can lie between two layers without crossing either, so
    // the shader's blend of the layers around the water's height never reached the hull and they showed no waterline.
    // A piece thinner than the layer spacing is also cut at its own mid-height, and that section stands in for every
    // layer within one spacing of it that it does not cross.
    let bottom = Infinity, top = -Infinity;
    for (let i = 1; i < triangles.length; i += 3) { bottom = Math.min(bottom, triangles[i]!); top = Math.max(top, triangles[i]!); }
    const spacing = amplitude * 2 / (LAYERS - 1);
    if (triangles.length > 0 && top - bottom < spacing) {
      const middle = (bottom + top) / 2;
      let section: number[] | null = null;
      for (let k = 0; k < LAYERS; k++) {
        if (contours[k]!.length > 0 || Math.abs(heights[k]! - middle) >= spacing) continue;
        if (!section) {
          section = [];
          for (let t = 0; t + 2 < indices.length; t += 3) {
            const a = indices[t]! * 3, b = indices[t + 1]! * 3, c = indices[t + 2]! * 3;
            const sa = world[a + 1]! <= middle, sb = world[b + 1]! <= middle, sc = world[c + 1]! <= middle;
            if (sa === sb && sb === sc) continue;
            if (sa !== sb) cross(a, b, middle, section);
            if (sb !== sc) cross(b, c, middle, section);
            if (sc !== sa) cross(c, a, middle, section);
          }
        }
        contours[k] = section;
      }
    }
    piece.bounds = bounds;
    piece.triangles = new Float64Array(triangles);
    piece.contours = contours.map((segments) => new Float64Array(segments));
    // A closed cross-section pairs every endpoint. Ring seams (cos/sin of 0 and 2*pi) differ by
    // rounding, so endpoints match to a tenth of a millimetre.
    piece.closed = contours.map((segments) => {
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
   * Re-slices stale placements and works out which cells that changes. `rebuildAll` (and any change of allocation)
   * rebuilds every cell at once; otherwise the changed windows are queued (all of the cells for `recut`, a surface that
   * moved) and the texture is unchanged until the frame budget builds them. Returns whether the texture changed.
   */
  private rebuild(rebuildAll: boolean, recut: boolean, now: number): boolean {
    for (const piece of this.pieces.values()) {
      if (!piece.stale) continue;
      const before = piece.bounds;
      this.slice(piece);
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
    if (grown && !this.allocate(needed, cell)) rebuildAll = true;
    const everything: Window = { x0: 0, z0: 0, x1: this.width, z1: this.height };
    const dirty = this.dirty;
    this.dirty = [];
    if (rebuildAll) {
      this.queue.length = 0;
      this.fill(everything, everything);
      this.upload([everything], true);
      return true;
    }
    if (grown) this.upload([everything], true);
    if (recut) {
      // The whole surface moved: every cell is stale, but they come in as windows within the budget, newest pose.
      this.queue.length = 0;
      this.enqueue(everything, now);
      return grown;
    }
    const grow = this.range + this.cell;
    for (const rect of dirty) this.enqueue(this.toWindow(rect, grow), now);
    return grown;
  }

  /**
   * Allocates cells for `needed`. Returns whether the previous cells it shares with the new allocation were carried
   * over (same cell size: every allocation snaps to the same lattice) with the queued windows moved to match, so only
   * what changed needs rebuilding; otherwise everything does.
   */
  private allocate(needed: Rect, cell: number): boolean {
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
    return true;
  }

  private toWindow(rect: Rect, grow: number): Window {
    const r = this.rect!, cell = this.cell;
    return {
      x0: Math.max(0, Math.floor((rect.minX - grow - r.minX) / cell)), z0: Math.max(0, Math.floor((rect.minZ - grow - r.minZ) / cell)),
      x1: Math.min(this.width, Math.ceil((rect.maxX + grow - r.minX) / cell) + 1), z1: Math.min(this.height, Math.ceil((rect.maxZ + grow - r.minZ) / cell) + 1),
    };
  }

  /**
   * Recomputes every layer of the cells in `write`, seeding from all objects within range of them. `target` (`write` or
   * a window around it) is the region computed: the rounding filters read neighbours, so the cells of `write` come out
   * exact only when `target` reaches `smoothRadius() * 2` cells past them (or the edge of the texture).
   */
  private fill(target: Window, write: Window): void {
    const r = this.rect!, cell = this.cell, data = this.data!;
    const reachCells = Math.ceil(this.range / cell) + 2;
    const w: Window = { x0: Math.max(0, target.x0 - reachCells), z0: Math.max(0, target.z0 - reachCells), x1: Math.min(this.width, target.x1 + reachCells), z1: Math.min(this.height, target.z1 + reachCells) };
    const cw = w.x1 - w.x0, ch = w.z1 - w.z0;
    const reach = { minX: r.minX + w.x0 * cell - this.range, minZ: r.minZ + w.z0 * cell - this.range, maxX: r.minX + w.x1 * cell + this.range, maxZ: r.minZ + w.z1 * cell + this.range };
    const pieces = Array.from(this.pieces.values()).filter(({ bounds: b }) => b && b.maxX >= reach.minX && b.minX <= reach.maxX && b.maxZ >= reach.minZ && b.minZ <= reach.maxZ);
    if (pieces.length === 0) {
      // No object within range: every layer reads the far end (255), exactly what the filters would arrive at, without them.
      for (let z = write.z0; z < write.z1; z++) data.fill(255, (z * this.width + write.x0) * 4, (z * this.width + write.x1) * 4);
      return;
    }
    // Shared scratch, grown on demand: moving objects rebuild windows many times a second.
    if (scratchSeed.length < cw * ch) { scratchSeed = new Float32Array(cw * ch); scratchInside = new Uint8Array(cw * ch); }
    while (scratchRows.length < ch) scratchRows.push([]);
    const seed = scratchSeed.subarray(0, cw * ch), inside = scratchInside.subarray(0, cw * ch), rows = scratchRows;
    // Cell-centre coordinates: cell (i, j) of the window has its centre at u = i, v = j.
    const u = (x: number) => (x - r.minX) / cell - 0.5 - w.x0, v = (z: number) => (z - r.minZ) / cell - 0.5 - w.z0;
    const rangeCells = this.range / cell, spacing = this.amplitude * 2 / (LAYERS - 1);
    // Only the target cells are read, and distances beyond the range all encode alike.
    const region = { x0: target.x0 - w.x0, z0: target.z0 - w.z0, x1: target.x1 - w.x0, z1: target.z1 - w.z0, cap: rangeCells * rangeCells };
    for (let k = 0; k < LAYERS; k++) {
      seed.fill(INF); inside.fill(0);
      for (const piece of pieces) {
        const y = WATER_CONTACT_LAYER_OFFSETS[k]! * this.amplitude;
        const segments = piece.contours[k]!;
        for (let s = 0; s < segments.length; s += 4) {
          seedSegment(seed, cw, ch, u(segments[s]!), v(segments[s + 1]!), u(segments[s + 2]!), v(segments[s + 3]!));
        }
        const t = piece.triangles;
        for (let s = 0; s < t.length; s += 9) {
          const dy0 = t[s + 1]! - y, dy1 = t[s + 4]! - y, dy2 = t[s + 7]! - y;
          if (Math.min(dy0, dy1, dy2) > spacing || Math.max(dy0, dy1, dy2) < -spacing) continue;
          seedTriangle(seed, cw, ch, u(t[s]!), v(t[s + 2]!), dy0, u(t[s + 3]!), v(t[s + 5]!), dy1, u(t[s + 6]!), v(t[s + 8]!), dy2, VERTICAL_WEIGHT / cell, spacing / cell * VERTICAL_WEIGHT);
        }
        if (piece.closed[k]) fillInside(inside, rows, cw, ch, segments, u, v);
      }
      distanceTransform(seed, cw, ch, region);
      // Signed distance over the target (negative inside), rounded where objects' distances meet (`smoothContacts`).
      const tw = target.x1 - target.x0, th = target.z1 - target.z0, signed = contactScratch(tw * th);
      for (let z = 0; z < th; z++) for (let x = 0; x < tw; x++) {
        const i = (z + target.z0 - w.z0) * cw + (x + target.x0 - w.x0);
        const distance = Math.min(rangeCells, Math.sqrt(seed[i]!)) / rangeCells;
        signed[z * tw + x] = inside[i] ? -distance : distance;
      }
      const exact = contactExact(tw * th), floor = contactFloor(tw * th), radius = this.smoothRadius();
      exact.set(signed); floor.set(signed);
      smoothContacts(signed, tw, th, radius);
      // The smallest exact distance under each cell's blur kernel: where any part of an object is that near (a hull, or
      // a face just above or below the layer) the exact distance stands, so waterlines keep their place; the rounding
      // takes over where everything under the kernel is three radii away or more, where creases between objects form.
      minimumFilter(floor, tw, th, radius * 2);
      const near = radius * 3 / rangeCells, far = near * 2;
      for (let z = write.z0 - target.z0; z < write.z1 - target.z0; z++) for (let x = write.x0 - target.x0; x < write.x1 - target.x0; x++) {
        const i = z * tw + x, e = exact[i]!, t = Math.max(0, Math.min(1, (floor[i]! - near) / (far - near)));
        const value = e + (signed[i]! - e) * t * t * (3 - 2 * t);
        data[((z + target.z0) * this.width + x + target.x0) * 4 + k] = Math.round(Math.max(0, Math.min(1, 0.5 + value * 0.5)) * 255);
      }
    }
  }

  private upload(windows: Window[], full: boolean): void {
    const data = this.data!;
    if (!this.texture) {
      this.texture = RawTexture.CreateRGBATexture(data, this.width, this.height, this.scene, false, false, Texture.BILINEAR_SAMPLINGMODE, Constants.TEXTURETYPE_UNSIGNED_BYTE);
      this.texture.name = `${this.surface.mesh.name}:water-contacts`;
      this.texture.wrapU = this.texture.wrapV = Texture.CLAMP_ADDRESSMODE;
      return;
    }
    const engine = this.scene.getEngine() as AbstractEngine & Partial<Pick<ThinEngine, "updateTextureData">>;
    const internal = this.texture.getInternalTexture();
    const area = windows.reduce((sum, w) => sum + (w.x1 - w.x0) * (w.z1 - w.z0), 0);
    if (full || !internal || !engine.updateTextureData || engine instanceof NullEngine || area * 2 > this.width * this.height) { this.texture.update(data); return; }
    // Moving objects only re-upload their neighbourhood.
    for (const w of windows) {
      const rowBytes = (w.x1 - w.x0) * 4, part = new Uint8Array(rowBytes * (w.z1 - w.z0));
      for (let z = w.z0; z < w.z1; z++) part.set(data.subarray((z * this.width + w.x0) * 4, (z * this.width + w.x1) * 4), (z - w.z0) * rowBytes);
      engine.updateTextureData(internal, part, w.x0, w.z0, w.x1 - w.x0, w.z1 - w.z0);
    }
  }
}

/**
 * The smoothing radius of the contact distances is the contact range over this (about half the Contact Foam Width):
 * where two objects' distances meet, the hard minimum of a distance transform creases along their bisector, and every
 * contour drawn from it (rings, lines) kinks into a straight crack there. Two box passes of radius r (a tent of
 * radius 2r) round the crease like a smooth minimum where everything under the kernel is far from any object; near
 * objects the exact distance stands, so thin objects keep their waterline (`minimumFilter`).
 */
const CONTACT_SMOOTH = 12;
let smoothLine = new Float32Array(0), smoothValues = new Float32Array(0);
let exactValues = new Float32Array(0), floorValues = new Float32Array(0);
function contactFloor(size: number): Float32Array {
  if (floorValues.length < size) floorValues = new Float32Array(size);
  return floorValues.subarray(0, size);
}
function contactExact(size: number): Float32Array {
  if (exactValues.length < size) exactValues = new Float32Array(size);
  return exactValues.subarray(0, size);
}
function contactScratch(size: number): Float32Array {
  if (smoothValues.length < size) smoothValues = new Float32Array(size);
  return smoothValues.subarray(0, size);
}

/** Two separable box blurs of radius `r` over a `width` × `height` grid in place, clamped at its edges. Allocation-free once grown. */
export function smoothContacts(values: Float32Array, width: number, height: number, r: number): void {
  const size = Math.max(width, height);
  if (smoothLine.length < size) smoothLine = new Float32Array(size);
  for (let n = 0; n < 2; n++) { boxPass(values, width, height, width, 1, r); boxPass(values, height, width, 1, width, r); }
}

let minimumQueue = new Int32Array(0);
/**
 * The minimum over a (2r + 1)² window of a `width` × `height` grid in place (separable, clamped at its edges), in time
 * independent of `r`. Allocation-free once grown.
 */
export function minimumFilter(values: Float32Array, width: number, height: number, r: number): void {
  const size = Math.max(width, height);
  if (smoothLine.length < size) smoothLine = new Float32Array(size);
  if (minimumQueue.length < size) minimumQueue = new Int32Array(size);
  minimumPass(values, width, height, width, 1, r);
  minimumPass(values, height, width, 1, width, r);
}

/**
 * One sliding minimum along `lines` lines of `count` values: a queue of indices whose values increase from its head,
 * each entering once and leaving once, so a cell costs the same at any radius (a full rebuild filters up to four
 * million layer cells).
 */
function minimumPass(values: Float32Array, count: number, lines: number, stride: number, step: number, r: number): void {
  const line = smoothLine, queue = minimumQueue;
  for (let l = 0; l < lines; l++) {
    const base = l * stride;
    for (let i = 0; i < count; i++) line[i] = values[base + i * step]!;
    let head = 0, tail = 0, next = 0;
    for (let i = 0; i < count; i++) {
      for (const end = Math.min(count - 1, i + r); next <= end; next++) {
        const value = line[next]!;
        while (tail > head && line[queue[tail - 1]!]! >= value) tail--;
        queue[tail++] = next;
      }
      while (queue[head]! < i - r) head++;
      values[base + i * step] = line[queue[head]!]!;
    }
  }
}

/** One box blur along `lines` lines of `count` values (line l starts at l × `stride`, values `step` apart). */
function boxPass(values: Float32Array, count: number, lines: number, stride: number, step: number, r: number): void {
  const line = smoothLine, last = count - 1, scale = 1 / (2 * r + 1);
  for (let l = 0; l < lines; l++) {
    const base = l * stride;
    for (let i = 0; i < count; i++) line[i] = values[base + i * step]!;
    // Running sum over [i - r, i + r], clamped at the ends.
    let sum = 0;
    for (let j = -r; j <= r; j++) sum += line[j < 0 ? 0 : j > last ? last : j]!;
    for (let i = 0; i < count; i++) {
      values[base + i * step] = sum * scale;
      const add = i + r + 1, drop = i - r;
      sum += line[add > last ? last : add]! - line[drop < 0 ? 0 : drop]!;
    }
  }
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

/** Exact squared distances (cell units) from nearby cell centres to a cross-section segment. */
function seedSegment(seed: Float32Array, width: number, height: number, u0: number, v0: number, u1: number, v1: number): void {
  const du = u1 - u0, dv = v1 - v0, length2 = du * du + dv * dv;
  const alongU = Math.abs(du) >= Math.abs(dv);
  const [a0, a1] = alongU ? [Math.min(u0, u1), Math.max(u0, u1)] : [Math.min(v0, v1), Math.max(v0, v1)];
  const first = Math.max(0, Math.floor(a0) - 1), last = Math.min((alongU ? width : height) - 1, Math.ceil(a1) + 1);
  for (let major = first; major <= last; major++) {
    // The segment's cross coordinate at this column (or row), clamped to its extent.
    const t = alongU ? (du === 0 ? 0 : (major - u0) / du) : (dv === 0 ? 0 : (major - v0) / dv);
    const c = t <= 0 ? (alongU ? v0 : u0) : t >= 1 ? (alongU ? v1 : u1) : (alongU ? v0 + dv * t : u0 + du * t);
    const lo = Math.max(0, Math.ceil(c - 1.5)), hi = Math.min((alongU ? height : width) - 1, Math.floor(c + 1.5));
    for (let minor = lo; minor <= hi; minor++) {
      const i = alongU ? major : minor, j = alongU ? minor : major;
      const s = length2 > 0 ? Math.max(0, Math.min(1, ((i - u0) * du + (j - v0) * dv) / length2)) : 0;
      const x = i - u0 - du * s, y = j - v0 - dv * s, h2 = x * x + y * y;
      if (h2 <= 1) {
        const index = j * width + i;
        if (h2 < seed[index]!) seed[index] = h2;
      }
    }
  }
}

/**
 * Surfaces between layers: each covered cell centre gets the weighted vertical gap to the
 * triangle, so the distance transform yields an anisotropic 3D distance at the layer's height.
 */
function seedTriangle(seed: Float32Array, width: number, height: number,
  u0: number, v0: number, y0: number, u1: number, v1: number, y1: number, u2: number, v2: number, y2: number, weight: number, limit: number): void {
  const area = (u1 - u0) * (v2 - v0) - (u2 - u0) * (v1 - v0);
  if (Math.abs(area) < 1e-9) return;
  const iMin = Math.max(0, Math.ceil(Math.min(u0, u1, u2))), iMax = Math.min(width - 1, Math.floor(Math.max(u0, u1, u2)));
  const jMin = Math.max(0, Math.ceil(Math.min(v0, v1, v2))), jMax = Math.min(height - 1, Math.floor(Math.max(v0, v1, v2)));
  for (let j = jMin; j <= jMax; j++) for (let i = iMin; i <= iMax; i++) {
    const b1 = ((i - u0) * (v2 - v0) - (u2 - u0) * (j - v0)) / area;
    const b2 = ((u1 - u0) * (j - v0) - (i - u0) * (v1 - v0)) / area;
    if (b1 < 0 || b2 < 0 || b1 + b2 > 1) continue;
    const gap = Math.abs(y0 + (y1 - y0) * b1 + (y2 - y0) * b2) * weight;
    if (gap > limit) continue;
    const index = j * width + i;
    if (gap * gap < seed[index]!) seed[index] = gap * gap;
  }
}

/** Even-odd scanline fill of a closed cross-section at cell centres. */
function fillInside(inside: Uint8Array, rows: number[][], width: number, height: number, segments: Float64Array, u: (x: number) => number, v: (z: number) => number): void {
  let used = false;
  for (let s = 0; s < segments.length; s += 4) {
    const u0 = u(segments[s]!), v0 = v(segments[s + 1]!), u1 = u(segments[s + 2]!), v1 = v(segments[s + 3]!);
    const first = Math.max(0, Math.ceil(Math.min(v0, v1))), last = Math.min(height - 1, Math.floor(Math.max(v0, v1)));
    for (let j = first; j <= last; j++) {
      if ((v0 <= j) === (v1 <= j)) continue;
      rows[j]!.push(u0 + (u1 - u0) * (j - v0) / (v1 - v0));
      used = true;
    }
  }
  if (!used) return;
  for (let j = 0; j < height; j++) {
    const row = rows[j]!;
    // An odd count means a gap the endpoint check could not see; leave that row unsigned.
    if (row.length < 2 || row.length % 2 === 1) { row.length = 0; continue; }
    row.sort((a, b) => a - b);
    for (let p = 0; p + 1 < row.length; p += 2) {
      const from = Math.max(0, Math.ceil(row[p]!)), to = Math.min(width - 1, Math.floor(row[p + 1]!));
      for (let i = from; i <= to; i++) inside[j * width + i] = 1;
    }
    row.length = 0;
  }
}
