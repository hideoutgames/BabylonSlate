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
import { geometryRevision, unwatchGeometry, watchGeometry } from "./geometry-revision";
import { isEditorHelperMesh } from "./helper-mesh";
import { RENDERING_GROUP } from "./sorting";
import type { WaterContactJobMessage, WaterContactWorkerReply } from "./water-contact-jobs";
import { fillContactWindow, WATER_CONTACT_LAYER_OFFSETS, type ContactGrid, type ContactPiece, type ContactRect, type ContactWindow } from "./water-contact-kernel";
import { attachWaterContactWorker, type WaterContactWorkerLink } from "./water-contact-offthread";
import type { WaterFieldSurface } from "./water-field";

export { minimumFilter, smoothContacts, WATER_CONTACT_LAYER_OFFSETS } from "./water-contact-kernel";

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
 * Milliseconds of contact rebuilds all of a scene's surfaces start in one frame. Full rebuilds (a new surface, a
 * reshaped body, a forced update) never wait but count; one moving-object rebuild always runs. Once it is spent, further surfaces wait for a later frame unless they are overdue (`MOVE_WAIT_MS`, or
 * two frames when frames are slower than half of it) or were the longest waiter the previous frame skipped, so the
 * surfaces visited first never starve the later ones.
 */
export const WATER_CONTACT_FRAME_BUDGET_MS = 2;
const MOVE_WAIT_MS = 100;
/**
 * Per scene and frame: rebuild time spent, moving rebuilds run, and the last build time of the longest-waiting surface
 * skipped (this frame's, and the previous frame's, which has priority now).
 */
const rebuildBudgets = new WeakMap<Scene, { frame: number; spent: number; moving: number; oldest: number; priority: number }>();
/**
 * Milliseconds an off-thread rebuild may take before its worker counts as hung: every field then rebuilds on the main
 * thread. Far above any real job, queued behind other surfaces' (a full 1024² rebuild takes a fraction of a second on
 * desktop), and measured with the frame clock: a reply that arrived while the render loop was paused lands first.
 */
export const WATER_CONTACT_WORKER_TIMEOUT_MS = 10_000;
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
  return mesh.getTotalIndices() > 0;
}

type Rect = ContactRect;
type Window = ContactWindow;

/**
 * One rigid placement of a mesh's geometry: a mesh, an instance, or one thin instance, with its cuts through the wave
 * envelope (`ContactPiece`). Off the thread, the cuts' arrays move to the worker once sent and are empty here.
 */
type Piece = ContactPiece & {
  mesh: AbstractMesh;
  /** Thin-instance index, or -1. */
  instance: number;
  matrix: Float64Array;
  /** The watched geometry and its position revision when last sliced (NaN when its updates cannot be counted). */
  geometry: Geometry | null;
  revision: number;
  stale: boolean;
};

/** The contact texture's cells: its world rectangle (whole 16-cell blocks), cell size and texels per side. */
type Layout = { rect: Rect; cell: number; width: number; height: number };
/** One rebuild: the layout and windows it fills and the envelope its objects were cut for. */
type ContactJob = { id: number; layout: Layout; windows: Window[]; full: boolean; amplitude: number; range: number; sent: number };

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
 * changes; waves never rebake it.
 *
 * Objects are cut on the main thread; the distance passes (`fillContactWindow`) run on a contact worker where one can
 * start (`attachWaterContactWorker`), else here. Off the thread, one rebuild per surface is in flight at a time: what
 * changes meanwhile rebuilds once it lands, at the first `update` after its reply, and until then the texture, `bounds`,
 * `amplitude` and `range` stay those of the last landed rebuild, so the shader never reads a half-applied one.
 */
export class WaterContactField {
  texture: RawTexture | null = null;
  /** minX, minZ, 1 / sizeX, 1 / sizeZ in world metres, of the texture drawn. */
  readonly bounds = [0, 0, 1, 1];
  /** The wave envelope (metres either side of rest) the texture's layers were built for. */
  amplitude = 0;
  /** The texture's distances are clamped to +/- this many metres. */
  range = 1;
  /** The texture's layout and distances, replaced as rebuilds land (`place`). */
  private data: Uint8Array | null = null;
  private width = 0;
  private height = 0;
  private cell = 1;
  private rect: Rect | null = null;
  /** The wave envelope and contact range objects are cut for now (`syncSurface`); the next rebuild uses them. */
  private cutAmplitude = 0;
  private cutRange = 1;
  /** Texels per side this surface may use (Contact Resolution). */
  private maxCells = MAX_CELLS;
  private readonly pieces = new Map<string, Piece>();
  /** The off-thread path: tried at the first rebuild, then kept until `dispose`; `offthread` turns off on a failure. */
  private link: WaterContactWorkerLink | null = null;
  private linkTried = false;
  private offthread = false;
  private jobs = 0;
  /** The rebuild the worker is filling, and its reply's blocks once they arrive (landed by the next `update`). */
  private inflight: ContactJob | null = null;
  private arrived: Uint8Array[] | null = null;
  /** Keys cut again since the worker last received them, and keys gone since then. */
  private readonly unsent = new Set<string>();
  private removed: string[] = [];
  /** A full rebuild is owed: requested while another was in flight, or the worker failed. */
  private fullPending = false;
  private readonly thin = new Map<Mesh, ThinPlacements>();
  private scans = 0;
  /** Bumped when the surface changes, which invalidates every cached thin-instance placement. */
  private surfaceEpoch = 0;
  private dirty: Rect[] = [];
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
  }

  /**
   * Track objects and rebuild what changed. Returns true when the texture changed. A changed wave envelope, contact
   * range or cell cap cuts every object again at once; so does a moved surface, but while it keeps moving (a dragged,
   * animated or tide-driven body) at most every `SURFACE_MOVE_MS`: its contacts lag its pose by that much at most, and
   * its last pose always lands. A released texture (`releaseTexture`) waits for `restore`. Off the thread, a finished
   * rebuild lands first, and a new one starts only once none is in flight.
   */
  update(now: number, force = false): boolean {
    const landed = this.arrived !== null && this.land();
    if (this.inflight && now - this.inflight.sent >= WATER_CONTACT_WORKER_TIMEOUT_MS) this.link?.fail("timed out");
    const surface = this.syncSurface();
    if (surface === SURFACE_MOVED) this.surfaceMoved = true;
    if (this.released && !force) return landed;
    const full = force || surface === SURFACE_CHANGED
      || (this.surfaceMoved && (this.lastBuild === -Infinity || now - this.lastBuild >= SURFACE_MOVE_MS));
    if (full) {
      this.surfaceMoved = false; this.fullPending = true; this.surfaceEpoch++;
      for (const piece of this.pieces.values()) piece.stale = true;
    }
    if (full || now - this.lastScan >= SCAN_MS) {
      // The first scan sets this surface's phase; later ones keep their spacing.
      this.lastScan = this.lastScan === -Infinity ? now - this.scanPhase : now;
      this.scan(now, full);
    }
    else this.track();
    let stale = this.fullPending || this.dirty.length > 0;
    for (const piece of this.pieces.values()) stale ||= piece.stale;
    // One rebuild per surface is in flight at a time; what changed meanwhile waits for it to land.
    if (!stale || this.inflight) return landed;
    const rebuildFull = this.fullPending;
    if (!rebuildFull && now - this.lastBuild < MOVE_MS) return landed;
    // Many surfaces with moving objects share a per-frame budget (`WATER_CONTACT_FRAME_BUDGET_MS`).
    let budget = rebuildBudgets.get(this.scene);
    if (!budget) { budget = { frame: NaN, spent: 0, moving: 0, oldest: Infinity, priority: -Infinity }; rebuildBudgets.set(this.scene, budget); }
    const frame = this.scene.getFrameId();
    if (budget.frame !== frame) {
      budget.frame = frame; budget.spent = 0; budget.moving = 0;
      budget.priority = budget.oldest === Infinity ? -Infinity : budget.oldest; budget.oldest = Infinity;
    }
    if (!rebuildFull && budget.moving > 0 && budget.spent >= WATER_CONTACT_FRAME_BUDGET_MS
      && now - this.lastBuild < Math.max(MOVE_WAIT_MS, 2 * this.scene.getEngine().getDeltaTime()) && this.lastBuild > budget.priority) {
      budget.oldest = Math.min(budget.oldest, this.lastBuild);
      return landed;
    }
    if (!rebuildFull) budget.moving++;
    this.lastBuild = now; this.fullPending = false;
    // Off the thread this is the cutting and posting only.
    const start = performance.now(), changed = this.rebuild(rebuildFull, now);
    // At least a hair per rebuild, so a clock that does not advance within a frame still spreads them.
    budget.spent += Math.max(performance.now() - start, 0.25);
    return landed || changed;
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
    this.cutAmplitude = amplitude; this.cutRange = range; this.maxCells = cells;
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

  /** Releases the texture and leaves the contact worker, which drops this surface's pieces (and exits if it was the last). */
  dispose(): void {
    this.release();
    this.link?.detach();
    this.link = null; this.linkTried = true; this.offthread = false; this.inflight = null; this.arrived = null;
    this.unsent.clear(); this.removed = [];
    for (const piece of this.pieces.values()) if (piece.geometry) unwatchGeometry(piece.geometry);
    for (const placements of this.thin.values()) unwatchGeometry(placements.geometry);
    this.pieces.clear(); this.thin.clear();
  }

  /** A reply from the contact worker: the blocks of the rebuild in flight wait for the next `update` to land them. */
  private receive(reply: WaterContactWorkerReply): void {
    if (reply.job !== this.inflight?.id) return;
    if (reply.type === "error") this.link?.fail(reply.message);
    else this.arrived = reply.blocks;
  }

  /**
   * The off-thread path failed (`attachWaterContactWorker`): the worker held the cuts, whose arrays were transferred to
   * it, so every object is cut again and rebuilt here in full at the next `update`.
   */
  private fallBack(): void {
    this.offthread = false; this.inflight = null; this.arrived = null;
    this.unsent.clear(); this.removed = [];
    for (const piece of this.pieces.values()) piece.stale = true;
    this.fullPending = true;
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
    this.texture?.dispose(); this.texture = null; this.data = null; this.rect = null;
  }

  /** Candidate placements of every mesh that reaches the wave envelope near this surface. */
  private scan(now: number, fresh: boolean): void {
    const scan = ++this.scans;
    const seen = new Set<string>();
    const box = this.surface.mesh.getBoundingInfo().boundingBox, margin = this.cutRange, amplitude = this.cutAmplitude;
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
      this.unsent.delete(key);
      if (this.offthread) this.removed.push(key);
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
    const amplitude = this.cutAmplitude, low = -amplitude, high = amplitude;
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
   * Cuts the stale objects again and rebuilds the windows they touched, or everything for a full rebuild or a new
   * layout. With a contact worker the job is posted and lands at a later `update`; otherwise it is filled here and
   * lands at once. Returns true when the texture changed now.
   */
  private rebuild(full: boolean, now: number): boolean {
    // Cuts are recorded for the worker until it is known whether there is one.
    const record = this.offthread || !this.linkTried;
    for (const [key, piece] of this.pieces) {
      if (!piece.stale) continue;
      const before = piece.bounds;
      this.slice(piece);
      if (record) this.unsent.add(key);
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
    const range = this.cutRange;
    const target = Math.max(MIN_CELL, Math.min(MAX_TARGET_CELL, range / 24));
    const margin = range + 2 * target;
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
    const layout: Layout = fits && current ? { rect: current, cell, width: this.width, height: this.height } : planLayout(needed, cell);
    if (!fits) full = true;
    const windows: Window[] = [];
    if (full) windows.push({ x0: 0, z0: 0, x1: layout.width, z1: layout.height });
    else {
      const grow = range + layout.cell;
      for (const rect of this.dirty) addWindow(windows, toWindow(layout, rect, grow));
    }
    this.dirty = [];
    const job: ContactJob = { id: ++this.jobs, layout, windows, full, amplitude: this.cutAmplitude, range, sent: now };
    if (this.dispatch(job)) return false;
    // Here: fill the current distances in place, or a new layout's into a new array, and land at once.
    const data = fits && this.data ? this.data : new Uint8Array(layout.width * layout.height * 4);
    for (const window of windows) fillContactWindow(gridOf(job), this.pieces.values(), window, data, layout.width);
    return this.place(job, data, null);
  }

  /**
   * Posts a rebuild to the contact worker with the cuts it has not received (their arrays are transferred) and the
   * keys gone; joins a worker at the first rebuild. False when the rebuild runs here instead.
   */
  private dispatch(job: ContactJob): boolean {
    if (!this.linkTried) {
      this.linkTried = true;
      this.link = attachWaterContactWorker({ reply: (reply) => this.receive(reply), fail: () => this.fallBack() }, job.layout.width * job.layout.height);
      this.offthread = this.link !== null;
    }
    if (!this.offthread || !this.link) { this.unsent.clear(); return false; }
    const updated: WaterContactJobMessage["updated"] = [], transfer = new Set<ArrayBuffer>();
    for (const key of this.unsent) {
      const piece = this.pieces.get(key);
      if (!piece) continue;
      updated.push({ key, piece: { bounds: piece.bounds, contours: piece.contours, closed: piece.closed, triangles: piece.triangles } });
      transfer.add(piece.triangles.buffer as ArrayBuffer);
      for (const segments of piece.contours) transfer.add(segments.buffer as ArrayBuffer);
    }
    const removed = this.removed;
    this.unsent.clear(); this.removed = [];
    this.inflight = job;
    this.link.post({ type: "job", field: this.link.field, job: job.id, removed, updated, grid: gridOf(job), windows: job.windows }, [...transfer]);
    // A post that failed fell back (`fallBack`): this rebuild runs here.
    return this.offthread;
  }

  /** Lands the worker's reply to the rebuild in flight (`receive`): a full one brings its whole layout's distances. */
  private land(): boolean {
    const job = this.inflight!, blocks = this.arrived!;
    this.inflight = null; this.arrived = null;
    if (job.full) return this.place(job, blocks[0]!, blocks);
    const data = this.data;
    // Windows always follow the layout they were cut in; should it be gone, everything rebuilds.
    if (!data || this.rect !== job.layout.rect) { this.fullPending = true; return false; }
    for (let i = 0; i < job.windows.length; i++) {
      const w = job.windows[i]!, block = blocks[i]!, rowBytes = (w.x1 - w.x0) * 4;
      for (let z = w.z0; z < w.z1; z++) data.set(block.subarray((z - w.z0) * rowBytes, (z - w.z0 + 1) * rowBytes), (z * this.width + w.x0) * 4);
    }
    return this.place(job, data, blocks);
  }

  /**
   * Puts a finished rebuild in place: its layout and distances, what the shader reads with them (`bounds`, `amplitude`,
   * `range`) and, unless released, the texture. True when the texture changed.
   */
  private place(job: ContactJob, data: Uint8Array, blocks: Uint8Array[] | null): boolean {
    const { rect, cell, width, height } = job.layout;
    if (this.texture && (width !== this.width || height !== this.height)) { this.texture.dispose(); this.texture = null; }
    this.rect = rect; this.cell = cell; this.width = width; this.height = height; this.data = data;
    this.bounds[0] = rect.minX; this.bounds[1] = rect.minZ;
    this.bounds[2] = 1 / (width * cell); this.bounds[3] = 1 / (height * cell);
    this.amplitude = job.amplitude; this.range = job.range;
    // A released surface keeps the distances for `restore` to upload.
    if (this.released) return false;
    this.upload(job.windows, job.full, blocks);
    return true;
  }

  /** `blocks`, when given, hold each window's distances already packed (the worker's reply). */
  private upload(windows: Window[], full: boolean, blocks: Uint8Array[] | null = null): void {
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
    for (let i = 0; i < windows.length; i++) {
      const w = windows[i]!, rowBytes = (w.x1 - w.x0) * 4;
      let part = blocks?.[i];
      if (!part) {
        part = new Uint8Array(rowBytes * (w.z1 - w.z0));
        for (let z = w.z0; z < w.z1; z++) part.set(data.subarray((z * this.width + w.x0) * 4, (z * this.width + w.x1) * 4), (z - w.z0) * rowBytes);
      }
      engine.updateTextureData(internal, part, w.x0, w.z0, w.x1 - w.x0, w.z1 - w.z0);
    }
  }
}

const gridOf = ({ layout, range, amplitude }: ContactJob): ContactGrid =>
  ({ minX: layout.rect.minX, minZ: layout.rect.minZ, cell: layout.cell, width: layout.width, height: layout.height, range, amplitude });

/** A layout covering `needed`, snapped to 16-cell blocks so small moves stay inside it. */
function planLayout(needed: Rect, cell: number): Layout {
  const block = cell * 16;
  const rect = {
    minX: Math.floor(needed.minX / block) * block, minZ: Math.floor(needed.minZ / block) * block,
    maxX: Math.ceil(needed.maxX / block) * block, maxZ: Math.ceil(needed.maxZ / block) * block,
  };
  return { rect, cell, width: Math.max(2, Math.round((rect.maxX - rect.minX) / cell)), height: Math.max(2, Math.round((rect.maxZ - rect.minZ) / cell)) };
}

function toWindow({ rect: r, cell, width, height }: Layout, rect: Rect, grow: number): Window {
  return {
    x0: Math.max(0, Math.floor((rect.minX - grow - r.minX) / cell)), z0: Math.max(0, Math.floor((rect.minZ - grow - r.minZ) / cell)),
    x1: Math.min(width, Math.ceil((rect.maxX + grow - r.minX) / cell) + 1), z1: Math.min(height, Math.ceil((rect.maxZ + grow - r.minZ) / cell) + 1),
  };
}

/** Overlapping windows merge, so a cell is never computed twice in one rebuild. */
function addWindow(windows: Window[], next: Window): void {
  if (next.x0 >= next.x1 || next.z0 >= next.z1) return;
  for (let i = 0; i < windows.length; i++) {
    const w = windows[i]!;
    if (w.x0 <= next.x1 && next.x0 <= w.x1 && w.z0 <= next.z1 && next.z0 <= w.z1) {
      windows.splice(i, 1);
      addWindow(windows, { x0: Math.min(w.x0, next.x0), z0: Math.min(w.z0, next.z0), x1: Math.max(w.x1, next.x1), z1: Math.max(w.z1, next.z1) });
      return;
    }
  }
  windows.push(next);
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
