import {
  Constants,
  Matrix,
  Mesh,
  Quaternion,
  RawTexture,
  Texture,
  Vector3,
  type Scene,
} from "@babylonjs/core";
import { landscapeWorldHeightAt, type LandscapeProperties, type Transform } from "@babylonslate/core";
import { landscapeMeshData, sceneLandscapeRoots } from "./landscape-mesh";

/**
 * Encoded ranges of the RGBA8 field: R shore distance, G depth over terrain, B the same depth at fine precision
 * over the shallows (`fineDepthSpan` metres from `fineDepthMin`), A terrain known: 255 over real terrain, then a ramp
 * from `WATER_FIELD_EXTENDED_ALPHA` down to 0 over `WATER_FIELD_EDGE_RAMP` metres past an underwater landscape edge,
 * whose depth those cells carry. Objects live in the separate, height-aware `WaterContactField`.
 */
export const WATER_FIELD_SHORE_RANGE: readonly [number, number] = [-8, 24];
export const WATER_FIELD_DEPTH_RANGE: readonly [number, number] = [-8, 32];
/** Smallest fine span: about 2 cm per step, so gentle shores shade and foam without depth terraces. */
export const WATER_FIELD_FINE_DEPTH_SPAN = 5;
const MAX_CELLS = 512;
const MIN_CELL = 0.2;
/** Cells at the field's border across which the shader hands it over to the open-water defaults (`swFieldEdge`). */
const WATER_FIELD_EDGE_CELLS = 3;

const INF = 1e20;
/**
 * Squared Euclidean distance transform (Felzenszwalb-Huttenlocher), in cell units, in place.
 * Seeds may carry a non-zero squared offset, e.g. a vertical gap, which the transform preserves.
 */
export function distanceTransform<T extends Float32Array | Float64Array>(grid: T, width: number, height: number, region?: DistanceRegion): T {
  const size = Math.max(width, height);
  if (edtF.length < size) { edtF = new Float64Array(size); edtD = new Float64Array(size); edtV = new Int32Array(size); edtZ = new Float64Array(size + 1); }
  const f = edtF, d = edtD;
  // Only `region`'s cells are wanted: columns keep the rows inside it, then only its rows run, for its columns.
  const x0 = region?.x0 ?? 0, z0 = region?.z0 ?? 0, x1 = region?.x1 ?? width, z1 = region?.z1 ?? height, cap = region?.cap ?? Infinity;
  // Columns, then rows. A line without any seed (every value at or beyond INF) stays as it is: it would come out as
  // INF plus a squared offset far below INF's precision, which callers clamp to their range anyway. With a `cap`, a
  // row whose every column distance is beyond it ends beyond it too, and is left as it is for the same reason.
  for (let x = 0; x < width; x++) {
    let seeded = false;
    for (let i = 0, j = x; i < height; i++, j += width) { const value = grid[j]!; f[i] = value; if (value < INF) seeded = true; }
    if (!seeded) continue;
    lowerEnvelope(height, z0, z1);
    for (let i = z0, j = z0 * width + x; i < z1; i++, j += width) grid[j] = d[i]!;
  }
  for (let y = z0; y < z1; y++) {
    const row = y * width;
    let near = false;
    for (let i = 0; i < width; i++) { const value = grid[row + i]!; f[i] = value; if (value <= cap) near = true; }
    if (!near) continue;
    lowerEnvelope(width, x0, x1);
    for (let i = x0; i < x1; i++) grid[row + i] = d[i]!;
  }
  return grid;
}

/**
 * The cells of a `distanceTransform` a caller reads ([x0, x1) × [z0, z1)); others are left unfinished. `cap` (squared
 * cells) is the largest distance the caller tells apart: anything beyond it may be left at any value beyond it.
 */
export type DistanceRegion = { x0: number; z0: number; x1: number; z1: number; cap?: number };

/** Scratch lines of `distanceTransform`, grown on demand and shared (allocation-free once grown). */
let edtF = new Float64Array(0), edtD = new Float64Array(0), edtV = new Int32Array(0), edtZ = new Float64Array(1);

/**
 * One line of the transform: the lower envelope of parabolas rooted at `edtF`'s first `n` values, evaluated into
 * `edtD` for positions [from, to).
 */
function lowerEnvelope(n: number, from: number, to: number): void {
  const f = edtF, d = edtD, v = edtV, z = edtZ;
  let k = 0; v[0] = 0; z[0] = -INF; z[1] = INF;
  for (let q = 1; q < n; q++) {
    let s = ((f[q]! + q * q) - (f[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!);
    while (s <= z[k]!) { k--; s = ((f[q]! + q * q) - (f[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!); }
    k++; v[k] = q; z[k] = s; z[k + 1] = INF;
  }
  k = 0;
  for (let q = from; q < to; q++) {
    while (z[k + 1]! < q) k++;
    d[q] = (q - v[k]!) * (q - v[k]!) + f[v[k]!]!;
  }
}

const encode = (value: number, range: ArrayLike<number>, min = range[0]!, max = range[1]!) =>
  Math.round(Math.max(0, Math.min(1, (value - min) / (max - min))) * 255);

function toTransform(matrix: Matrix): Transform {
  const scaling = new Vector3(), rotation = new Quaternion(), position = new Vector3();
  matrix.decompose(scaling, rotation, position);
  return {
    position: { x: position.x, y: position.y, z: position.z },
    rotation: { x: rotation.x, y: rotation.y, z: rotation.z, w: rotation.w },
    scale: { x: scaling.x, y: scaling.y, z: scaling.z },
  };
}

export interface WaterFieldSurface {
  mesh: Mesh;
  /** World surface height (without waves) at a world X/Z, or null outside the body. */
  surfaceY: (x: number, z: number) => number | null;
  /** True when the rest height varies across the body: rivers and tilted volumes. */
  restVaries?: boolean;
  /** The rest height extended beyond the footprint, for cutting objects on bodies whose rest height varies. */
  restY?: (x: number, z: number) => number;
  /** True for unbounded water, whose fields cover only the terrain and objects that reach it. */
  unbounded: boolean;
  /** Metres either side of the rest height that waves reach. */
  amplitude: number;
  /** Object distances are stored up to this range, in metres. */
  contactRange: number;
  /** Most contact-texture cells per side (project Contact Resolution); beyond it cells grow. Defaults to 1024. */
  contactCells?: number;
}

type Rect = { minX: number; minZ: number; maxX: number; maxZ: number };

/**
 * Per-surface world-aligned texture describing the terrain beneath the water: the signed
 * distance to its shorelines and the true depth over it. Built on the CPU from authored terrain,
 * so it works on every render path and backend.
 */
export class WaterField {
  texture: RawTexture | null = null;
  /** minX, minZ, 1 / sizeX, 1 / sizeZ in world metres. */
  readonly bounds = [0, 0, 1, 1];
  private data: Uint8Array | null = null;
  private width = 0;
  private height = 0;
  private rect: Rect | null = null;
  /**
   * What the texture was filled from, as numbers: per enabled landscape its data id and world matrix, then the surface
   * world matrix, the wave amplitude (which sets the depth encodings) and, for a bounded body, its world X/Z bounds.
   */
  private key = new Float64Array(64).fill(NaN);
  private keyLength = -1;
  private keyChanged = false;
  /** Inputs changed since the last fill, which waits for `WATER_FIELD_MOVE_MS` to pass. */
  private pending = false;
  /** The texture was given back (`releaseTexture`) and waits for `restore`. */
  private released = false;
  private lastFill = -Infinity;
  private readonly terrainOwner = new WeakMap<object, number>();
  private terrainIds = 0;

  private readonly scene: Scene;
  private readonly surface: WaterFieldSurface;

  constructor(scene: Scene, surface: WaterFieldSurface) {
    this.scene = scene;
    this.surface = surface;
  }

  /**
   * Preserve terrain depth across the full wave envelope, including unusually high waves. The same array every call
   * (read per draw), refreshed from the current amplitude.
   */
  get depthRange(): Readonly<Float64Array> {
    const out = this.depthRangeOut, amplitude = this.surface.amplitude;
    out[0] = Math.min(WATER_FIELD_DEPTH_RANGE[0], -amplitude - 1); out[1] = Math.max(WATER_FIELD_DEPTH_RANGE[1], amplitude + 1);
    return out;
  }

  /** One cell in texture coordinates (u, v): the same array every call, refreshed from the current size. */
  get texelSize(): Readonly<Float64Array> {
    const out = this.texelOut;
    out[0] = 1 / Math.max(1, this.width); out[1] = 1 / Math.max(1, this.height);
    return out;
  }
  private readonly depthRangeOut = new Float64Array(2);
  private readonly texelOut = new Float64Array(2);

  /** Floor of the fine depth channel: below the lowest trough, so clamped cells still read as dry land. */
  get fineDepthMin(): number {
    return Math.min(-1, -this.surface.amplitude - 0.25);
  }

  /**
   * Metres the fine depth channel covers from `fineDepthMin`: every displaced waterline (rest depth -amplitude to
   * +amplitude) plus a few metres of shallows beyond the lowest trough, so tall waves still find their shore.
   */
  get fineDepthSpan(): number {
    return Math.max(WATER_FIELD_FINE_DEPTH_SPAN, 2 * this.surface.amplitude + 4);
  }

  /**
   * Refresh when terrain or the surface changes. Returns true when the texture changed. Called every frame for every
   * visible water surface, so an unchanged frame compares numbers only: no scene scan, strings or allocation. While
   * its inputs keep changing (a dragged, animated or tide-driven body, a landscape being sculpted) it refills at most
   * every `WATER_FIELD_MOVE_MS`, keeping the previous texture in between; the last change always lands once the
   * interval passes. A first fill and a forced one never wait.
   */
  update(force = false): boolean {
    if (this.inputsChanged()) this.pending = true;
    if (!force && (!this.pending || this.released)) return false;
    const now = performance.now();
    if (!force && this.texture && now - this.lastFill < WATER_FIELD_MOVE_MS) return false;
    this.pending = false; this.lastFill = now;
    const landscapes = this.landscapes();
    const rect = this.measure(landscapes);
    if (!rect) { const had = this.texture !== null; this.release(); return had; }
    const resized = !this.rect || rect.minX !== this.rect.minX || rect.minZ !== this.rect.minZ || rect.maxX !== this.rect.maxX || rect.maxZ !== this.rect.maxZ;
    if (resized) this.allocate(rect);
    this.fillTerrain(landscapes);
    this.upload();
    return true;
  }

  /**
   * Gives back the GPU texture of a surface that stays disabled, keeping the filled data and what it was filled from,
   * so `restore` can upload it again without refilling when nothing changed meanwhile.
   */
  releaseTexture(): void {
    this.texture?.dispose(); this.texture = null; this.released = true;
  }

  /** The texture again after `releaseTexture`: re-uploaded when its inputs are unchanged, refilled otherwise. */
  restore(): boolean {
    this.released = false;
    if (this.inputsChanged()) this.pending = true;
    if (this.pending || !this.data) return this.update(true);
    if (!this.texture) this.upload();
    return true;
  }

  private upload(): void {
    if (!this.texture) {
      this.texture = RawTexture.CreateRGBATexture(this.data!, this.width, this.height, this.scene, false, false, Texture.BILINEAR_SAMPLINGMODE, Constants.TEXTURETYPE_UNSIGNED_BYTE);
      this.texture.name = `${this.surface.mesh.name}:water-field`;
      this.texture.wrapU = this.texture.wrapV = Texture.CLAMP_ADDRESSMODE;
    } else this.texture.update(this.data!);
  }

  dispose(): void { this.release(); }

  private release(): void {
    this.texture?.dispose(); this.texture = null; this.data = null; this.rect = null;
  }

  private idOf(data: object): number {
    let id = this.terrainOwner.get(data);
    if (id === undefined) { id = ++this.terrainIds; this.terrainOwner.set(data, id); }
    return id;
  }

  private landscapes(): Array<{ root: Mesh; data: LandscapeProperties }> {
    const found: Array<{ root: Mesh; data: LandscapeProperties }> = [];
    for (const root of sceneLandscapeRoots(this.scene)) {
      const data = root.isEnabled() ? landscapeMeshData(root) : null;
      if (data) found.push({ root, data });
    }
    return found;
  }

  /** Writes the current inputs into `key`; true when any differs from the last call. */
  private inputsChanged(): boolean {
    this.keyChanged = false;
    let n = 0;
    const roots = sceneLandscapeRoots(this.scene);
    for (let i = 0; i < roots.length; i++) {
      const root = roots[i]!;
      const data = root.isEnabled() ? landscapeMeshData(root) : null;
      if (!data) continue;
      n = this.put(n, this.idOf(data));
      n = this.putMatrix(n, root.getWorldMatrix().m);
    }
    n = this.putMatrix(n, this.surface.mesh.getWorldMatrix().m);
    n = this.put(n, this.surface.amplitude);
    if (!this.surface.unbounded) {
      const box = this.surface.mesh.getBoundingInfo().boundingBox;
      n = this.put(n, box.minimumWorld.x); n = this.put(n, box.minimumWorld.z);
      n = this.put(n, box.maximumWorld.x); n = this.put(n, box.maximumWorld.z);
    }
    if (n !== this.keyLength) { this.keyLength = n; this.keyChanged = true; }
    return this.keyChanged;
  }

  private putMatrix(n: number, m: ArrayLike<number>): number {
    for (let j = 0; j < 16; j++) n = this.put(n, m[j]!);
    return n;
  }

  private put(n: number, value: number): number {
    if (n >= this.key.length) {
      const grown = new Float64Array(this.key.length * 2).fill(NaN);
      grown.set(this.key); this.key = grown;
    }
    if (this.key[n] !== value) { this.key[n] = value; this.keyChanged = true; }
    return n + 1;
  }

  private measure(landscapes: Array<{ root: Mesh; data: LandscapeProperties }>): Rect | null {
    // Unbounded water also covers the depth ramp past the terrain, so it reaches zero inside the field.
    const margin = Math.max(this.surface.contactRange, this.surface.unbounded ? WATER_FIELD_EDGE_RAMP : 0) + 1;
    let rect: Rect | null = null;
    const add = (min: Vector3, max: Vector3) => {
      rect = rect
        ? { minX: Math.min(rect.minX, min.x - margin), minZ: Math.min(rect.minZ, min.z - margin), maxX: Math.max(rect.maxX, max.x + margin), maxZ: Math.max(rect.maxZ, max.z + margin) }
        : { minX: min.x - margin, minZ: min.z - margin, maxX: max.x + margin, maxZ: max.z + margin };
    };
    if (this.surface.unbounded) {
      for (const { root } of landscapes) {
        root.computeWorldMatrix(true);
        const { min, max } = root.getHierarchyBoundingVectors(true);
        const level = this.surface.surfaceY((min.x + max.x) / 2, (min.z + max.z) / 2);
        if (level !== null && min.y <= level + this.surface.amplitude) add(min, max);
      }
      if (!rect) return null;
    } else {
      if (landscapes.length === 0) return null;
      const box = this.surface.mesh.getBoundingInfo().boundingBox;
      // The shader hands the field over to the open-water defaults across its last three cells (`swFieldOn`): the body's
      // own edge must lie beyond them, or its rim (where a river meets the sea over a beach) loses its terrain depth and
      // draws as an opaque pale strip above the sand.
      const extent = Math.max(box.maximumWorld.x - box.minimumWorld.x, box.maximumWorld.z - box.minimumWorld.z) + 2;
      const pad = Math.max(1, (Math.max(MIN_CELL, extent / MAX_CELLS) * (WATER_FIELD_EDGE_CELLS + 1)));
      rect = { minX: box.minimumWorld.x - pad, minZ: box.minimumWorld.z - pad, maxX: box.maximumWorld.x + pad, maxZ: box.maximumWorld.z + pad };
    }
    const r = rect as Rect;
    // Snap to whole cells so small terrain moves reuse the allocation.
    const cell = Math.max(MIN_CELL, Math.max(r.maxX - r.minX, r.maxZ - r.minZ) / MAX_CELLS);
    const snap = (n: number, up: boolean) => (up ? Math.ceil(n / (cell * 8)) : Math.floor(n / (cell * 8))) * cell * 8;
    return { minX: snap(r.minX, false), minZ: snap(r.minZ, false), maxX: snap(r.maxX, true), maxZ: snap(r.maxZ, true) };
  }

  private allocate(rect: Rect): void {
    const cell = Math.max(MIN_CELL, Math.max(rect.maxX - rect.minX, rect.maxZ - rect.minZ) / MAX_CELLS);
    const width = Math.max(2, Math.min(MAX_CELLS, Math.ceil((rect.maxX - rect.minX) / cell)));
    const height = Math.max(2, Math.min(MAX_CELLS, Math.ceil((rect.maxZ - rect.minZ) / cell)));
    if (this.texture && (width !== this.width || height !== this.height)) { this.texture.dispose(); this.texture = null; }
    this.rect = rect; this.width = width; this.height = height;
    this.data = new Uint8Array(width * height * 4);
    this.bounds[0] = rect.minX; this.bounds[1] = rect.minZ;
    this.bounds[2] = 1 / (rect.maxX - rect.minX); this.bounds[3] = 1 / (rect.maxZ - rect.minZ);
  }

  private fillTerrain(landscapes: Array<{ root: Mesh; data: LandscapeProperties }>): void {
    const { width, height } = this, data = this.data!, count = width * height;
    const depthRange = this.depthRange, fineMin = this.fineDepthMin;
    const fineRange = [fineMin, fineMin + this.fineDepthSpan] as const;
    const transforms = landscapes.map(({ root, data }) => ({ data, transform: toTransform(root.computeWorldMatrix(true)) }));
    const depth = new Float64Array(count), known = new Uint8Array(count);
    // The water's rest height is exact every `LEVEL_STRIDE` cells and interpolated between where all four samples
    // around a cell hold water (a blending body's rest height runs the blend kernel, smooth over metres); cells near
    // the water's own edge, where only some samples have water, evaluate it exactly, and cells with no sample holding
    // water around them have none.
    const r = this.rect!, sizeX = r.maxX - r.minX, sizeZ = r.maxZ - r.minZ, stride = LEVEL_STRIDE;
    const cw = Math.ceil((width - 1) / stride) + 1, ch = Math.ceil((height - 1) / stride) + 1, levels = new Float64Array(cw * ch);
    for (let j = 0; j < ch; j++) for (let i = 0; i < cw; i++) {
      const x = Math.min(i * stride, width - 1), z = Math.min(j * stride, height - 1);
      levels[j * cw + i] = this.surface.surfaceY(r.minX + (x + 0.5) / width * sizeX, r.minZ + (z + 0.5) / height * sizeZ) ?? Number.NaN;
    }
    for (let z = 0; z < height; z++) for (let x = 0; x < width; x++) {
      const wx = r.minX + (x + 0.5) / width * sizeX, wz = r.minZ + (z + 0.5) / height * sizeZ, i = z * width + x;
      const i0 = Math.floor(x / stride), j0 = Math.floor(z / stride), i1 = Math.min(i0 + 1, cw - 1), j1 = Math.min(j0 + 1, ch - 1);
      const x0 = Math.min(i0 * stride, width - 1), x1 = Math.min(i1 * stride, width - 1), z0 = Math.min(j0 * stride, height - 1), z1 = Math.min(j1 * stride, height - 1);
      const a = levels[j0 * cw + i0]!, b = levels[j0 * cw + i1]!, c = levels[j1 * cw + i0]!, d = levels[j1 * cw + i1]!;
      let level: number | null;
      const missing = (Number.isNaN(a) ? 1 : 0) + (Number.isNaN(b) ? 1 : 0) + (Number.isNaN(c) ? 1 : 0) + (Number.isNaN(d) ? 1 : 0);
      if (missing === 4) level = null;
      else if (missing > 0) level = this.surface.surfaceY(wx, wz);
      else {
        const fx = x1 > x0 ? (x - x0) / (x1 - x0) : 0, fz = z1 > z0 ? (z - z0) / (z1 - z0) : 0;
        level = (a + (b - a) * fx) * (1 - fz) + (c + (d - c) * fx) * fz;
      }
      let ground = -Infinity;
      for (const entry of transforms) {
        const h = landscapeWorldHeightAt(entry.data, entry.transform, wx, wz);
        if (h !== null && h > ground) ground = h;
      }
      if (level !== null && ground > -Infinity) { depth[i] = level - ground; known[i] = 1; }
    }
    // Signed distance to the shoreline: positive over water, negative inland.
    const toLand = new Float64Array(count), toWater = new Float64Array(count);
    for (let i = 0; i < count; i++) {
      const land = known[i] === 1 && depth[i]! <= 0;
      toLand[i] = land ? 0 : INF;
      toWater[i] = land ? INF : 0;
    }
    const anyLand = toLand.some((n) => n === 0);
    if (anyLand) { distanceTransform(toLand, width, height); distanceTransform(toWater, width, height); }
    const cell = (this.rect!.maxX - this.rect!.minX) / width;
    const rampRings = Math.max(1, Math.ceil(WATER_FIELD_EDGE_RAMP / cell));
    const ring = extendTerrainDepth(depth, known, width, height, rampRings + 1);
    for (let i = 0; i < count; i++) {
      const shore = !anyLand ? WATER_FIELD_SHORE_RANGE[1] : known[i] === 1 && depth[i]! <= 0
        ? -(Math.sqrt(toWater[i]!) - 0.5) * cell
        : (Math.sqrt(toLand[i]!) - 0.5) * cell;
      const r = ring[i]!, carried = known[i] === 1 || r !== UNREACHED;
      data[i * 4] = encode(shore, WATER_FIELD_SHORE_RANGE);
      data[i * 4 + 1] = carried ? encode(depth[i]!, depthRange) : 255;
      data[i * 4 + 2] = carried ? encode(depth[i]!, fineRange) : 255;
      // Ring 1 starts below the shader's real-terrain threshold and the last ring reaches 0, so the ramp never steps.
      data[i * 4 + 3] = known[i] ? 255 : carried ? Math.round(WATER_FIELD_EXTENDED_ALPHA * (rampRings + 1 - r) / rampRings) : 0;
    }
  }
}

/**
 * Metres over which alpha falls to 0 beyond an underwater landscape edge. Cells there carry the edge's depth
 * (`extendTerrainDepth`), so the shader's central differences find no false slope at the coverage edge (an unknown
 * cell's sentinel read as a cliff and drew a shore line along it), and the terrain depth hands over to the shelving
 * estimate gradually instead of in a visible step. Unbounded water's field extends this far past the terrain.
 */
export const WATER_FIELD_EDGE_RAMP = 16;
/**
 * Milliseconds between refills while a field's inputs keep changing. Refilling a blending body's field runs the blend
 * kernel at every cell (a lake dragged beside Global Water cost about 30 ms a frame on the CPU); a moving body's
 * terrain and shoreline lag its pose by this much at most.
 */
export const WATER_FIELD_MOVE_MS = 150;
/** Cells between exact samples of the water's rest height while filling a field (`fillTerrain`). */
const LEVEL_STRIDE = 4;
/**
 * Alpha above which the shader treats a field sample as real terrain: only there does the terrain remove water and
 * set the shoreline from depth over slope. Extended cells start below it (`WATER_FIELD_EXTENDED_ALPHA`), so bilinear
 * filtering puts that boundary about halfway between the last real cell and the first extended one.
 */
export const WATER_FIELD_TERRAIN_ALPHA = 0.97;
/** Alpha of the first extended ring past an underwater edge, out of 255; below `WATER_FIELD_TERRAIN_ALPHA`. */
export const WATER_FIELD_EXTENDED_ALPHA = 240;
const UNREACHED = 0xffff;

/**
 * Extends underwater terrain depths into unknown cells ring by ring (each the mean of its already-reached
 * 8-neighbours), in place, for `rings` rings: the shader reads extended depth only inside the alpha ramp, so nothing
 * beyond it is visited. Dry cells neither seed nor feed the extension: past a landscape edge above the water there is
 * no terrain under the water, so those cells stay unknown and keep the shore distance measured from real land.
 * Returns each unknown cell's ring (1 outward) or `UNREACHED`; known cells read 0.
 */
function extendTerrainDepth(depth: Float64Array, known: Uint8Array, width: number, height: number, rings: number): Uint16Array {
  const count = width * height, ring = new Uint16Array(count).fill(UNREACHED), queue = new Int32Array(count);
  // Underwater terrain seeds and feeds the extension (ring 0); dry terrain is known but never reached or averaged.
  const dry = UNREACHED - 1;
  for (let i = 0; i < count; i++) if (known[i]) ring[i] = depth[i]! > 0 ? 0 : dry;
  let tail = 0;
  const enqueue = (i: number) => {
    const x = i % width, z = (i - x) / width;
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx, nz = z + dz;
      if (nx < 0 || nz < 0 || nx >= width || nz >= height) continue;
      const j = nz * width + nx;
      // Claimed for the next ring; its value is assigned once the whole ring is averaged.
      if (ring[j] === UNREACHED) { ring[j] = dry - 1; queue[tail++] = j; }
    }
  };
  for (let i = 0; i < count; i++) if (ring[i] === 0) enqueue(i);
  let head = 0;
  for (let r = 1; r <= rings && head < tail; r++) {
    const end = tail;
    // Every cell of this ring averages only earlier rings, so the result never depends on visiting order.
    for (let q = head; q < end; q++) {
      const i = queue[q]!, x = i % width, z = (i - x) / width;
      let sum = 0, n = 0;
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, nz = z + dz;
        if (nx < 0 || nz < 0 || nx >= width || nz >= height) continue;
        const j = nz * width + nx;
        if (ring[j]! < r) { sum += depth[j]!; n++; }
      }
      depth[i] = sum / n;
    }
    for (let q = head; q < end; q++) ring[queue[q]!] = r;
    if (r < rings) for (let q = head; q < end; q++) enqueue(queue[q]!);
    head = end;
  }
  for (let i = 0; i < count; i++) if (known[i]) ring[i] = 0;
  return ring;
}
