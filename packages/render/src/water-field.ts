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
import { landscapeMeshData } from "./landscape-mesh";

/**
 * Encoded ranges of the RGBA8 field: R shore distance, G depth over terrain, B the same depth at fine precision
 * over the shallows (`WATER_FIELD_FINE_DEPTH_SPAN` metres from `fineDepthMin`), A terrain known.
 * Objects live in the separate, height-aware `WaterContactField`.
 */
export const WATER_FIELD_SHORE_RANGE: readonly [number, number] = [-8, 24];
export const WATER_FIELD_DEPTH_RANGE: readonly [number, number] = [-8, 32];
/** About 2 cm per step, so gentle shores shade and foam without depth terraces. */
export const WATER_FIELD_FINE_DEPTH_SPAN = 5;
const MAX_CELLS = 512;
const MIN_CELL = 0.2;

const INF = 1e20;
/**
 * Squared Euclidean distance transform (Felzenszwalb-Huttenlocher), in cell units, in place.
 * Seeds may carry a non-zero squared offset, e.g. a vertical gap, which the transform preserves.
 */
export function distanceTransform<T extends Float32Array | Float64Array>(grid: T, width: number, height: number): T {
  const size = Math.max(width, height);
  const f = new Float64Array(size), d = new Float64Array(size), v = new Int32Array(size), z = new Float64Array(size + 1);
  const pass = (n: number, get: (i: number) => number, set: (i: number, value: number) => void) => {
    for (let i = 0; i < n; i++) f[i] = get(i);
    let k = 0; v[0] = 0; z[0] = -INF; z[1] = INF;
    for (let q = 1; q < n; q++) {
      let s = ((f[q]! + q * q) - (f[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!);
      while (s <= z[k]!) { k--; s = ((f[q]! + q * q) - (f[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!); }
      k++; v[k] = q; z[k] = s; z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < n; q++) {
      while (z[k + 1]! < q) k++;
      d[q] = (q - v[k]!) * (q - v[k]!) + f[v[k]!]!;
    }
    for (let i = 0; i < n; i++) set(i, d[i]!);
  };
  for (let x = 0; x < width; x++) pass(height, (i) => grid[i * width + x]!, (i, value) => { grid[i * width + x] = value; });
  for (let y = 0; y < height; y++) pass(width, (i) => grid[y * width + i]!, (i, value) => { grid[y * width + i] = value; });
  return grid;
}

const encode = (value: number, [min, max]: readonly [number, number]) =>
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
  /** True for unbounded water, whose fields cover only the terrain and objects that reach it. */
  unbounded: boolean;
  /** Metres either side of the rest height that waves reach. */
  amplitude: number;
  /** Object distances are stored up to this range, in metres. */
  contactRange: number;
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
  private terrainKey = "";
  private readonly terrainOwner = new WeakMap<object, number>();
  private terrainIds = 0;

  private readonly scene: Scene;
  private readonly surface: WaterFieldSurface;

  constructor(scene: Scene, surface: WaterFieldSurface) {
    this.scene = scene;
    this.surface = surface;
  }

  /** Preserve terrain depth across the full wave envelope, including unusually high waves. */
  get depthRange(): readonly [number, number] {
    return [Math.min(WATER_FIELD_DEPTH_RANGE[0], -this.surface.amplitude - 1), Math.max(WATER_FIELD_DEPTH_RANGE[1], this.surface.amplitude + 1)];
  }

  /** One cell in texture coordinates (u, v). */
  get texelSize(): readonly [number, number] {
    return [1 / Math.max(1, this.width), 1 / Math.max(1, this.height)];
  }

  /** Floor of the fine depth channel: below the lowest trough, so clamped cells still read as dry land. */
  get fineDepthMin(): number {
    return Math.min(-1, -this.surface.amplitude - 0.25);
  }

  /** Refresh when terrain or the surface changes. Returns true when the texture changed. */
  update(force = false): boolean {
    const landscapes = this.landscapes();
    const surfaceBox = this.surface.mesh.getBoundingInfo().boundingBox;
    const terrainKey = landscapes.map(({ root, data }) => this.idOf(data) + ":" + Array.from(root.getWorldMatrix().m).join(",")).join("|")
      + "@" + Array.from(this.surface.mesh.getWorldMatrix().m).join(",")
      + "@" + this.depthRange.join(",") + "," + this.fineDepthMin
      + "@" + (this.surface.unbounded ? "" : [surfaceBox.minimumWorld.x, surfaceBox.minimumWorld.z, surfaceBox.maximumWorld.x, surfaceBox.maximumWorld.z].join(","));
    if (!force && terrainKey === this.terrainKey) return false;
    this.terrainKey = terrainKey;
    const rect = this.measure(landscapes);
    if (!rect) { const had = this.texture !== null; this.release(); return had; }
    const resized = !this.rect || rect.minX !== this.rect.minX || rect.minZ !== this.rect.minZ || rect.maxX !== this.rect.maxX || rect.maxZ !== this.rect.maxZ;
    if (resized) this.allocate(rect);
    this.fillTerrain(landscapes);
    if (!this.texture) {
      this.texture = RawTexture.CreateRGBATexture(this.data!, this.width, this.height, this.scene, false, false, Texture.BILINEAR_SAMPLINGMODE, Constants.TEXTURETYPE_UNSIGNED_BYTE);
      this.texture.name = `${this.surface.mesh.name}:water-field`;
      this.texture.wrapU = this.texture.wrapV = Texture.CLAMP_ADDRESSMODE;
    } else this.texture.update(this.data!);
    return true;
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
    for (const mesh of this.scene.meshes) {
      if (!(mesh instanceof Mesh) || !(mesh.metadata as { slateLandscape?: boolean } | null)?.slateLandscape || !mesh.isEnabled()) continue;
      const data = landscapeMeshData(mesh);
      if (data) found.push({ root: mesh, data });
    }
    return found;
  }

  private measure(landscapes: Array<{ root: Mesh; data: LandscapeProperties }>): Rect | null {
    const margin = this.surface.contactRange + 1;
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
      rect = { minX: box.minimumWorld.x - 1, minZ: box.minimumWorld.z - 1, maxX: box.maximumWorld.x + 1, maxZ: box.maximumWorld.z + 1 };
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

  private cellCenter(x: number, z: number): [number, number] {
    const r = this.rect!;
    return [r.minX + (x + 0.5) / this.width * (r.maxX - r.minX), r.minZ + (z + 0.5) / this.height * (r.maxZ - r.minZ)];
  }

  private fillTerrain(landscapes: Array<{ root: Mesh; data: LandscapeProperties }>): void {
    const { width, height } = this, data = this.data!, count = width * height;
    const depthRange = this.depthRange, fineMin = this.fineDepthMin;
    const fineRange = [fineMin, fineMin + WATER_FIELD_FINE_DEPTH_SPAN] as const;
    const transforms = landscapes.map(({ root, data }) => ({ data, transform: toTransform(root.computeWorldMatrix(true)) }));
    const depth = new Float64Array(count), known = new Uint8Array(count);
    for (let z = 0; z < height; z++) for (let x = 0; x < width; x++) {
      const [wx, wz] = this.cellCenter(x, z), i = z * width + x;
      const level = this.surface.surfaceY(wx, wz);
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
    for (let i = 0; i < count; i++) {
      const shore = !anyLand ? WATER_FIELD_SHORE_RANGE[1] : known[i] === 1 && depth[i]! <= 0
        ? -(Math.sqrt(toWater[i]!) - 0.5) * cell
        : (Math.sqrt(toLand[i]!) - 0.5) * cell;
      data[i * 4] = encode(shore, WATER_FIELD_SHORE_RANGE);
      data[i * 4 + 1] = known[i] ? encode(depth[i]!, depthRange) : 255;
      data[i * 4 + 2] = known[i] ? encode(depth[i]!, fineRange) : 255;
      data[i * 4 + 3] = known[i] ? 255 : 0;
    }
  }
}
