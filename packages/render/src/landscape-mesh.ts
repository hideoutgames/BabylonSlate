import type { Camera } from "@babylonjs/core/Cameras/camera";
import { PickingInfo } from "@babylonjs/core/Collisions/pickingInfo";
import type { Ray } from "@babylonjs/core/Culling/ray";
import { Vector3, type Matrix } from "@babylonjs/core/Maths/math.vector";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import type { Observer } from "@babylonjs/core/Misc/observable";
import type { Scene } from "@babylonjs/core/scene";
import { parseLandscapeProperties, type LandscapeProperties, type LandscapeRegion } from "@haptic/core";
import type { MeshAssetContext } from "./mesh-assets";
import { RENDERING_GROUP } from "./sorting";
import { applyMaterialBounds } from "./material-bounds";
import { sceneRenderingSettings } from "./render-settings";
import { markSmoothNormalShadowCaster } from "./shadow-bias";

const CHUNK_CELLS = 32;
/** Camera-space distances (metres) for transitioning from LOD0 -> LOD1 -> LOD2 -> LOD3 at `lodDistanceScale = 1`. */
export const LANDSCAPE_LOD_DISTANCES = [45, 110, 240] as const;
const LOD_HYSTERESIS = 0.05;
const CAMERA_MOVE_THRESHOLD_SQ = 0.25; // 0.5 m
const LOD_STRIDES = [1, 2, 4, 8] as const;
const INV_255 = 1 / 255;
/** Skirt depth beyond twice the largest edge error, in cells: covers rasterization gaps at T-junctions. */
const SKIRT_MARGIN_CELLS = 0.5;
/** Skirt edges (`ChunkIndexLayout` bits): only edges shared with another chunk get a skirt. */
const NORTH = 1, SOUTH = 2, WEST = 4, EAST = 8;

type ChunkLodRange = { indexStart: number; indexCount: number };
type ChunkIndexLayout = {
  indices: Uint16Array;
  lods: readonly ChunkLodRange[];
};

type Chunk = {
  mesh: Mesh;
  root: Mesh;
  x: number;
  z: number;
  width: number;
  depth: number;
  /** Edges with a skirt (`NORTH | SOUTH | WEST | EAST`). */
  skirts: number;
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  colors: Float32Array;
  layout: ChunkIndexLayout;
  activeLod: number;
};

type LandscapeLodState = {
  chunks: Set<Chunk>;
  lastCamX: number;
  lastCamY: number;
  lastCamZ: number;
  lastScale: number;
  lastAutoLod: boolean;
  dirty: boolean;
  beforeRender: Observer<Scene> | null;
};

const landscapes = new WeakMap<Mesh, { data: LandscapeProperties; chunks: Chunk[] }>();
/** Each chunk mesh's chunk: its cells' place in the heightfield and its pre-allocated vertex buffers. */
const chunkOf = new WeakMap<Mesh, Chunk>();
/** Landscape roots in each scene, kept by creation and scene membership so per-frame readers never scan the scene. */
const sceneRoots = new WeakMap<Scene, Mesh[]>();
/** Per-scene chunk LOD controller state, attached once on `scene.onBeforeRenderObservable`. */
const lodStateByScene = new WeakMap<Scene, LandscapeLodState>();
/**
 * Concatenated `[LOD0 | LOD1 | LOD2 | LOD3]` index arrays keyed by `${width}x${depth}:${skirts}`, built once per chunk
 * shape on the CPU. Each chunk's geometry still uploads its own GPU copy (Babylon's `Geometry` owns its index buffer).
 */
const indexLayoutCache = new Map<string, ChunkIndexLayout>();
const NO_ROOTS: readonly Mesh[] = [];

function sampleSteps(length: number, stride: number): number[] {
  const steps: number[] = [];
  for (let v = 0; v < length; v += stride) steps.push(v);
  steps.push(length);
  return steps;
}

/**
 * Builds (and caches) one static concatenated index array containing `[LOD0 | LOD1 | LOD2 | LOD3]` for a `(w, d)` cell
 * chunk. Each LOD is its surface quads, LOD0's first so a face id below `2 * w * d` is a LOD0 cell's, then a downward
 * skirt strip on each edge in `skirts`: edges shared with a neighbouring chunk, which may draw another LOD there. The
 * outer border of the landscape has no skirt, so none hangs visibly below it.
 */
function getChunkIndexLayout(w: number, d: number, skirts: number): ChunkIndexLayout {
  const key = `${w}x${d}:${skirts}`;
  const cached = indexLayoutCache.get(key);
  if (cached) return cached;

  const row = w + 1;
  const interiorCount = row * (d + 1);
  const northSkirtStart = interiorCount;
  const southSkirtStart = northSkirtStart + (w + 1);
  const westSkirtStart = southSkirtStart + (w + 1);
  const eastSkirtStart = westSkirtStart + (d + 1);

  const raw: number[] = [];
  const lods: ChunkLodRange[] = [];

  for (let lodIdx = 0; lodIdx < LOD_STRIDES.length; lodIdx++) {
    const stride = LOD_STRIDES[lodIdx]!;
    if (lodIdx > 0 && (w < stride || d < stride)) break;

    const indexStart = raw.length;
    const xs = sampleSteps(w, stride);
    const zs = sampleSteps(d, stride);

    // Top surface quads; Babylon left-handed front face points +Y: (a, a+1, b) & (a+1, b+1, b).
    for (let zi = 0; zi < zs.length - 1; zi++) {
      const z0 = zs[zi]!;
      const z1 = zs[zi + 1]!;
      const row0 = z0 * row;
      const row1 = z1 * row;
      for (let xi = 0; xi < xs.length - 1; xi++) {
        const x0 = xs[xi]!;
        const x1 = xs[xi + 1]!;
        const a = row0 + x0;
        const a1 = row0 + x1;
        const b = row1 + x0;
        const b1 = row1 + x1;
        raw.push(a, a1, b, a1, b1, b);
      }
    }

    // Downward skirt strips with outward-facing LH winding.
    if (skirts & NORTH) {
      // z = 0, outward normal -Z
      for (let xi = 0; xi < xs.length - 1; xi++) {
        const x0 = xs[xi]!;
        const x1 = xs[xi + 1]!;
        raw.push(x0, northSkirtStart + x0, x1, x1, northSkirtStart + x0, northSkirtStart + x1);
      }
    }
    if (skirts & SOUTH) {
      // z = d, outward normal +Z
      const southRow = d * row;
      for (let xi = 0; xi < xs.length - 1; xi++) {
        const x0 = xs[xi]!;
        const x1 = xs[xi + 1]!;
        raw.push(southRow + x0, southRow + x1, southSkirtStart + x0, southRow + x1, southSkirtStart + x1, southSkirtStart + x0);
      }
    }
    if (skirts & WEST) {
      // x = 0, outward normal -X
      for (let zi = 0; zi < zs.length - 1; zi++) {
        const z0 = zs[zi]!;
        const z1 = zs[zi + 1]!;
        raw.push(z0 * row, z1 * row, westSkirtStart + z0, z1 * row, westSkirtStart + z1, westSkirtStart + z0);
      }
    }
    if (skirts & EAST) {
      // x = w, outward normal +X
      for (let zi = 0; zi < zs.length - 1; zi++) {
        const z0 = zs[zi]!;
        const z1 = zs[zi + 1]!;
        raw.push(z0 * row + w, eastSkirtStart + z0, z1 * row + w, z1 * row + w, eastSkirtStart + z0, eastSkirtStart + z1);
      }
    }

    lods.push({ indexStart, indexCount: raw.length - indexStart });
  }

  const layout: ChunkIndexLayout = {
    indices: new Uint16Array(raw),
    lods,
  };
  indexLayoutCache.set(key, layout);
  return layout;
}

/**
 * The largest vertical distance, over a chunk's skirted edges and its coarser LODs, between an edge drawn at that LOD
 * (a straight line between its samples) and the full-resolution edge. A neighbour shares the edge's samples, so two
 * chunks meeting there at any LODs are at most twice this apart: the higher one's skirt must reach that far down.
 */
function maxSkirtedEdgeError(data: LandscapeProperties, chunk: Chunk): number {
  const side = data.subdivisions + 1;
  const heights = data.heights;
  let worst = 0;
  const edge = (start: number, step: number, length: number) => {
    for (let lod = 1; lod < chunk.layout.lods.length; lod++) {
      const steps = sampleSteps(length, LOD_STRIDES[lod]!);
      for (let i = 0; i < steps.length - 1; i++) {
        const s0 = steps[i]!;
        const s1 = steps[i + 1]!;
        const h0 = heights[start + s0 * step]!;
        const h1 = heights[start + s1 * step]!;
        for (let s = s0 + 1; s < s1; s++) {
          const error = Math.abs(heights[start + s * step]! - (h0 + (h1 - h0) * (s - s0) / (s1 - s0)));
          if (error > worst) worst = error;
        }
      }
    }
  };
  const origin = chunk.z * side + chunk.x;
  if (chunk.skirts & NORTH) edge(origin, 1, chunk.width);
  if (chunk.skirts & SOUTH) edge(origin + chunk.depth * side, 1, chunk.width);
  if (chunk.skirts & WEST) edge(origin, side, chunk.depth);
  if (chunk.skirts & EAST) edge(origin + chunk.width, side, chunk.depth);
  return worst;
}

/**
 * Writes interior heightfield vertices plus 4 perimeter downward skirt rows directly into the chunk's pre-allocated
 * `Float32Array` buffers (zero per-vertex allocations). The skirt depth follows the chunk's edge error, so it covers
 * the gap to a neighbour at any LOD; it is the same at every LOD, so a LOD switch never rewrites vertices.
 */
function fillChunkBuffers(data: LandscapeProperties, chunk: Chunk): void {
  const { width: w, depth: d, positions, normals, uvs, colors } = chunk;
  const side = data.subdivisions + 1;
  const dx = data.width / data.subdivisions;
  const dz = data.depth / data.subdivisions;
  const halfW = data.width * 0.5;
  const halfD = data.depth * 0.5;
  const skirtDepth = chunk.skirts ? 2 * maxSkirtedEdgeError(data, chunk) + Math.max(dx, dz) * SKIRT_MARGIN_CELLS : 0;
  const heights = data.heights;
  const weights = data.weights;

  let vi = 0;
  for (let z = 0; z <= d; z++) {
    const gz = z + chunk.z;
    const pz = gz * dz - halfD;
    const back = gz > 0 ? gz - 1 : 0;
    const front = gz < side - 1 ? gz + 1 : side - 1;
    const invDzSpan = 1 / ((front - back) * dz);
    const rowBase = gz * side;
    const backBase = back * side;
    const frontBase = front * side;

    for (let x = 0; x <= w; x++) {
      const gx = x + chunk.x;
      const i = rowBase + gx;
      const px = gx * dx - halfW;
      const py = heights[i]!;

      const p3 = vi * 3;
      positions[p3] = px;
      positions[p3 + 1] = py;
      positions[p3 + 2] = pz;

      // Sample beyond chunk boundaries so adjacent chunks share identical normals.
      const left = gx > 0 ? gx - 1 : 0;
      const right = gx < side - 1 ? gx + 1 : side - 1;
      const nx = -(heights[rowBase + right]! - heights[rowBase + left]!) / ((right - left) * dx);
      const nz = -(heights[frontBase + gx]! - heights[backBase + gx]!) * invDzSpan;
      const invLen = 1 / Math.hypot(nx, 1, nz);
      normals[p3] = nx * invLen;
      normals[p3 + 1] = invLen;
      normals[p3 + 2] = nz * invLen;

      const p2 = vi * 2;
      uvs[p2] = px * 0.125;
      uvs[p2 + 1] = pz * 0.125;

      const p4 = vi * 4;
      const w4 = i * 4;
      colors[p4] = weights[w4]! * INV_255;
      colors[p4 + 1] = weights[w4 + 1]! * INV_255;
      colors[p4 + 2] = weights[w4 + 2]! * INV_255;
      colors[p4 + 3] = weights[w4 + 3]! * INV_255;

      vi++;
    }
  }

  // Copy perimeter vertices downward by `skirtDepth`, preserving normals, UVs, and splat weights.
  const copySkirtVertex = (srcIndex: number, dstIndex: number): void => {
    const s3 = srcIndex * 3;
    const d3 = dstIndex * 3;
    positions[d3] = positions[s3]!;
    positions[d3 + 1] = positions[s3 + 1]! - skirtDepth;
    positions[d3 + 2] = positions[s3 + 2]!;
    normals[d3] = normals[s3]!;
    normals[d3 + 1] = normals[s3 + 1]!;
    normals[d3 + 2] = normals[s3 + 2]!;

    const s2 = srcIndex * 2;
    const d2 = dstIndex * 2;
    uvs[d2] = uvs[s2]!;
    uvs[d2 + 1] = uvs[s2 + 1]!;

    const s4 = srcIndex * 4;
    const d4 = dstIndex * 4;
    colors[d4] = colors[s4]!;
    colors[d4 + 1] = colors[s4 + 1]!;
    colors[d4 + 2] = colors[s4 + 2]!;
    colors[d4 + 3] = colors[s4 + 3]!;
  };

  const row = w + 1;
  // North (z = 0, x = 0..w)
  for (let x = 0; x <= w; x++) copySkirtVertex(x, vi++);
  // South (z = d, x = 0..w)
  const southRow = d * row;
  for (let x = 0; x <= w; x++) copySkirtVertex(southRow + x, vi++);
  // West (x = 0, z = 0..d)
  for (let z = 0; z <= d; z++) copySkirtVertex(z * row, vi++);
  // East (x = w, z = 0..d)
  for (let z = 0; z <= d; z++) copySkirtVertex(z * row + w, vi++);
}

function applyChunkLod(chunk: Chunk, lodIndex: number): void {
  const clamped = Math.max(0, Math.min(chunk.layout.lods.length - 1, lodIndex));
  if (chunk.activeLod === clamped) return;
  const subMesh = chunk.mesh.subMeshes?.[0];
  if (!subMesh) return;
  const range = chunk.layout.lods[clamped]!;
  subMesh.indexStart = range.indexStart;
  subMesh.indexCount = range.indexCount;
  chunk.activeLod = clamped;
}

function pickLandscapeLodIndex(
  dist: number,
  scale: number,
  lodCount: number,
  currentLod: number,
): number {
  let target = 0;
  for (let i = 0; i < lodCount - 1 && i < LANDSCAPE_LOD_DISTANCES.length; i++) {
    const base = LANDSCAPE_LOD_DISTANCES[i]! * scale;
    const threshold = currentLod > i
      ? base * (1 - LOD_HYSTERESIS)
      : base * (1 + LOD_HYSTERESIS);
    if (dist > threshold) target = i + 1;
    else break;
  }
  return target;
}

function ensureLodController(scene: Scene): LandscapeLodState {
  let state = lodStateByScene.get(scene);
  if (state) return state;
  state = {
    chunks: new Set(),
    lastCamX: Number.NaN,
    lastCamY: Number.NaN,
    lastCamZ: Number.NaN,
    lastScale: Number.NaN,
    lastAutoLod: true,
    dirty: true,
    beforeRender: null,
  };
  const captured = state;
  captured.beforeRender = scene.onBeforeRenderObservable.add(() => {
    updateLandscapeLods(scene);
  });
  scene.onDisposeObservable.addOnce(() => {
    if (captured.beforeRender) scene.onBeforeRenderObservable.remove(captured.beforeRender);
    captured.beforeRender = null;
    captured.chunks.clear();
    lodStateByScene.delete(scene);
  });
  lodStateByScene.set(scene, captured);
  return captured;
}

/**
 * Evaluates per-chunk geometric LODs (`LOD0..LOD3`) for all landscapes in `scene` from `camera`,
 * swapping `subMesh.indexStart` / `subMesh.indexCount` in place with zero geometry replacement,
 * zero VAO rebuild, and zero readiness invalidation.
 */
export function updateLandscapeLods(
  scene: Scene,
  camera: Camera | null = scene.activeCamera,
): void {
  const state = lodStateByScene.get(scene);
  if (!state || state.chunks.size === 0 || !camera) return;
  const settings = sceneRenderingSettings(scene);
  const scale = settings.lodDistanceScale;
  const autoLod = settings.autoLod;
  const cam = camera.globalPosition ?? camera.position;
  const dx = cam.x - state.lastCamX;
  const dy = cam.y - state.lastCamY;
  const dz = cam.z - state.lastCamZ;
  if (
    !state.dirty &&
    scale === state.lastScale &&
    autoLod === state.lastAutoLod &&
    dx * dx + dy * dy + dz * dz <= CAMERA_MOVE_THRESHOLD_SQ
  ) {
    return;
  }
  state.lastCamX = cam.x;
  state.lastCamY = cam.y;
  state.lastCamZ = cam.z;
  state.lastScale = scale;
  state.lastAutoLod = autoLod;
  state.dirty = false;

  for (const chunk of state.chunks) {
    if (chunk.mesh.isDisposed()) {
      state.chunks.delete(chunk);
      continue;
    }
    if (!autoLod || chunk.layout.lods.length <= 1) {
      applyChunkLod(chunk, 0);
      continue;
    }
    const sphere = chunk.mesh.getBoundingInfo().boundingSphere;
    const dist = Math.max(0, Vector3.Distance(cam, sphere.centerWorld) - sphere.radiusWorld);
    const targetLod = pickLandscapeLodIndex(dist, scale, chunk.layout.lods.length, chunk.activeLod);
    applyChunkLod(chunk, targetLod);
  }
}

function registerLandscape(scene: Scene, root: Mesh, chunks: readonly Chunk[]): void {
  let roots = sceneRoots.get(scene);
  if (!roots) {
    const list: Mesh[] = roots = [];
    sceneRoots.set(scene, list);
    const removed = scene.onMeshRemovedObservable.add((mesh) => {
      const index = list.indexOf(mesh as Mesh);
      if (index >= 0) list.splice(index, 1);
      const chunk = chunkOf.get(mesh as Mesh);
      if (chunk) lodStateByScene.get(scene)?.chunks.delete(chunk);
    });
    // A root moved out of the scene and back (e.g. by an asset container) returns to the list.
    const added = scene.onNewMeshAddedObservable.add((mesh) => {
      if (mesh instanceof Mesh && landscapes.has(mesh) && !mesh.isDisposed() && !list.includes(mesh)) list.push(mesh);
    });
    scene.onDisposeObservable.addOnce(() => {
      scene.onMeshRemovedObservable.remove(removed); scene.onNewMeshAddedObservable.remove(added); sceneRoots.delete(scene);
    });
  }
  if (!roots.includes(root)) roots.push(root);
  const lodState = ensureLodController(scene);
  for (const chunk of chunks) lodState.chunks.add(chunk);
  lodState.dirty = true;
}

/** Landscape roots currently in the scene (enabled or not), without scanning `scene.meshes`. */
export function sceneLandscapeRoots(scene: Scene): readonly Mesh[] {
  return sceneRoots.get(scene) ?? NO_ROOTS;
}

/** Each chunk's own geometry: only `updateLandscapeMesh` writes its updatable buffers, through notified vertex updates. */
const chunkGeometries = new WeakMap<Mesh, Mesh["geometry"]>();

/** True while `mesh` is a landscape chunk drawing its own geometry, whose updates `geometryRevision` counts. */
export function hasRevisionTrackedLandscapeGeometry(mesh: Mesh): boolean {
  const geometry = chunkGeometries.get(mesh);
  return !!geometry && mesh.geometry === geometry;
}

export function createLandscapeMesh(scene: Scene, name: string, properties: unknown, assets?: MeshAssetContext): Mesh {
  const data = parseLandscapeProperties(properties);
  const root = new Mesh(name, scene);
  root.isPickable = false;
  root.metadata = { ...(root.metadata ?? {}), slateLandscape: true };
  const chunks: Chunk[] = [];
  for (let z = 0; z < data.subdivisions; z += CHUNK_CELLS) {
    for (let x = 0; x < data.subdivisions; x += CHUNK_CELLS) {
      const w = Math.min(CHUNK_CELLS, data.subdivisions - x);
      const d = Math.min(CHUNK_CELLS, data.subdivisions - z);
      const vertexCount = (w + 1) * (d + 1) + 2 * (w + 1) + 2 * (d + 1);
      const skirts = (z > 0 ? NORTH : 0) | (z + d < data.subdivisions ? SOUTH : 0) |
        (x > 0 ? WEST : 0) | (x + w < data.subdivisions ? EAST : 0);
      const layout = getChunkIndexLayout(w, d, skirts);
      const mesh = new Mesh(`${name}:landscape:${x}:${z}`, scene);
      const chunk: Chunk = {
        mesh,
        root,
        x,
        z,
        width: w,
        depth: d,
        skirts,
        positions: new Float32Array(vertexCount * 3),
        normals: new Float32Array(vertexCount * 3),
        uvs: new Float32Array(vertexCount * 2),
        colors: new Float32Array(vertexCount * 4),
        layout,
        activeLod: -1,
      };
      fillChunkBuffers(data, chunk);
      const vertex = new VertexData();
      vertex.positions = chunk.positions;
      vertex.normals = chunk.normals;
      vertex.uvs = chunk.uvs;
      vertex.colors = chunk.colors;
      vertex.indices = layout.indices;
      vertex.applyToMesh(mesh, true);
      applyChunkLod(chunk, 0);
      chunkGeometries.set(mesh, mesh.geometry);
      chunkOf.set(mesh, chunk);
      // Every pick (scene picks, brushes, foliage, placement, foot placement) meets the full-resolution surface, never
      // the active coarse LOD or a skirt.
      mesh.intersects = (ray, fastCheck, trianglePredicate, onlyBoundingInfo, worldToUse, skipBoundingInfo) => onlyBoundingInfo
        ? Mesh.prototype.intersects.call(mesh, ray, fastCheck, trianglePredicate, true, worldToUse, skipBoundingInfo)
        : intersectLandscapeChunk(mesh, ray, worldToUse ?? mesh.getWorldMatrix(), skipBoundingInfo)!;
      mesh.parent = root;
      mesh.renderingGroupId = RENDERING_GROUP.world;
      mesh.hasVertexAlpha = false;
      mesh.metadata = { landscapeRoot: root };
      markSmoothNormalShadowCaster(mesh);
      chunks.push(chunk);
    }
  }
  landscapes.set(root, { data, chunks });
  registerLandscape(scene, root, chunks);
  updateLandscapeMesh(root, data, assets);
  return root;
}

/** The heightfield a landscape root currently renders, e.g. for water shorelines. */
export function landscapeMeshData(root: Mesh): LandscapeProperties | null {
  return landscapes.get(root)?.data ?? null;
}

const corner0 = new Vector3();
const corner1 = new Vector3();
const corner2 = new Vector3();
const corner3 = new Vector3();

/**
 * A local-space ray's nearest hit on a landscape chunk's full-resolution (LOD0) surface, whatever LOD it draws and
 * never on a skirt: an exact heightfield trace that tests only the cells under the ray's segment. Faces are numbered
 * as LOD0's, the first range of the chunk's indices, so `PickingInfo.getNormal` reads the drawn vertices. Undefined
 * for a mesh that is not a landscape chunk. Every chunk's `intersects` calls this.
 */
export function intersectLandscapeChunk(mesh: AbstractMesh, ray: Ray, world: Matrix, skipBoundingInfo = false): PickingInfo | undefined {
  const chunk = chunkOf.get(mesh as Mesh);
  const data = chunk ? landscapes.get(chunk.root)?.data : undefined;
  if (!chunk || !data) return undefined;
  const info = new PickingInfo();
  // Its bounds first, as `AbstractMesh.intersects` tests them.
  const bounds = mesh.getBoundingInfo();
  if (!skipBoundingInfo && (!ray.intersectsSphere(bounds.boundingSphere, 0) || !ray.intersectsBox(bounds.boundingBox, 0))) return info;
  const dx = data.width / data.subdivisions;
  const dz = data.depth / data.subdivisions;
  const halfW = data.width / 2;
  const halfD = data.depth / 2;
  const { origin, direction } = ray;
  const length = ray.length;
  // The part of the segment over the chunk's cells, by slabs in X and Z.
  let t0 = 0;
  let t1 = length;
  const slab = (o: number, dir: number, min: number, max: number) => {
    if (Math.abs(dir) < 1e-12) {
      if (o < min || o > max) t1 = -1;
      return;
    }
    const a = (min - o) / dir;
    const b = (max - o) / dir;
    t0 = Math.max(t0, Math.min(a, b));
    t1 = Math.min(t1, Math.max(a, b));
  };
  // Padded a little, so a trace along the chunk's edge (within rounding of it) reaches the triangle test that decides.
  const padX = dx * 1e-3;
  const padZ = dz * 1e-3;
  slab(origin.x, direction.x, chunk.x * dx - halfW - padX, (chunk.x + chunk.width) * dx - halfW + padX);
  slab(origin.z, direction.z, chunk.z * dz - halfD - padZ, (chunk.z + chunk.depth) * dz - halfD + padZ);
  if (!(t0 <= t1) || !Number.isFinite(t0 + t1)) return info;
  const side = data.subdivisions + 1;
  const heights = data.heights;
  const lastX = chunk.x + chunk.width - 1;
  const lastZ = chunk.z + chunk.depth - 1;
  const cellX = (t: number) => Math.floor((origin.x + direction.x * t + halfW) / dx);
  const cellZ = (t: number) => Math.floor((origin.z + direction.z * t + halfD) / dz);
  // Rows of cells the segment crosses, and in each row the cells between its X at the row's edges, padded by one so
  // a hit on a shared cell edge meets both cells.
  const rowA = cellZ(t0);
  const rowB = cellZ(t1);
  const z0 = Math.max(chunk.z, Math.min(rowA, rowB) - 1);
  const z1 = Math.min(lastZ, Math.max(rowA, rowB) + 1);
  let nearest: { bu: number; bv: number; distance: number; faceId: number } | null = null;
  // The drawn vertex exactly as the chunk's Float32 position buffer holds it, so a trace through a vertex or along an
  // edge meets the triangles the GPU draws.
  const vertex = (gx: number, gz: number, out: Vector3) =>
    out.set(Math.fround(gx * dx - halfW), heights[gz * side + gx]!, Math.fround(gz * dz - halfD));
  for (let z = z0; z <= z1; z++) {
    let ta = t0;
    let tb = t1;
    if (Math.abs(direction.z) >= 1e-12) {
      const a = ((z - 1) * dz - halfD - origin.z) / direction.z;
      const b = ((z + 2) * dz - halfD - origin.z) / direction.z;
      ta = Math.max(t0, Math.min(a, b));
      tb = Math.min(t1, Math.max(a, b));
      if (ta > tb) continue;
    }
    const colA = cellX(ta);
    const colB = cellX(tb);
    const x0 = Math.max(chunk.x, Math.min(colA, colB) - 1);
    const x1 = Math.min(lastX, Math.max(colA, colB) + 1);
    for (let x = x0; x <= x1; x++) {
      vertex(x, z, corner0);
      vertex(x + 1, z, corner1);
      vertex(x, z + 1, corner2);
      vertex(x + 1, z + 1, corner3);
      const first = 2 * ((z - chunk.z) * chunk.width + (x - chunk.x));
      // As the drawn LOD0 quad: (a, a1, b) and (a1, b1, b).
      const hits = [ray.intersectsTriangle(corner0, corner1, corner2), ray.intersectsTriangle(corner1, corner3, corner2)];
      for (let k = 0; k < 2; k++) {
        const hit = hits[k];
        if (!hit || hit.distance < 0 || (nearest && !(hit.distance < nearest.distance))) continue;
        nearest = { bu: hit.bu ?? 0, bv: hit.bv ?? 0, distance: hit.distance, faceId: first + k };
      }
    }
  }
  if (!nearest) return info;
  // As `AbstractMesh.intersects` answers a hit.
  const worldOrigin = Vector3.TransformCoordinates(origin, world);
  const pickedPoint = Vector3.TransformNormal(direction.scale(nearest.distance), world).addInPlace(worldOrigin);
  info.hit = true;
  info.distance = Vector3.Distance(worldOrigin, pickedPoint);
  info.pickedPoint = pickedPoint;
  info.pickedMesh = mesh;
  info.bu = nearest.bu || 0;
  info.bv = nearest.bv || 0;
  info.subMeshFaceId = nearest.faceId;
  info.faceId = nearest.faceId;
  info.subMeshId = mesh.subMeshes?.[0]?._id ?? 0;
  return info;
}

export interface UpdateLandscapeMeshOptions {
  /**
   * The samples a live sculpt session changed in the typed arrays it shares with the mesh (`takeDirtyRegion`): only
   * chunks within one sample of them (whose normals read them) re-upload. Without it, chunks are compared with the
   * previous field.
   */
  dirtyRegion?: LandscapeRegion | null;
}

/**
 * Rewrites heights, weights and Material in place, reusing each chunk's pre-allocated
 * `Float32Array` vertex buffers with zero per-vertex allocations. Chunks keep the
 * subdivisions the mesh was created with: a subdivision change has a new
 * `landscape:<subdivisions>` visual kind, so EditorSceneSync rebuilds the mesh.
 */
export function updateLandscapeMesh(
  root: Mesh,
  properties: unknown,
  assets?: MeshAssetContext,
  options?: UpdateLandscapeMeshOptions,
): void {
  const state = landscapes.get(root);
  if (!state) return;
  const data = parseLandscapeProperties(properties);
  const previous = state.data;
  const side = data.subdivisions + 1;
  const region = options?.dirtyRegion;
  const preserveMaterial = assets === undefined && data.materialGuid === previous.materialGuid;
  let anyDirty = false;
  for (const chunk of state.chunks) {
    let dirty = data.width !== previous.width || data.depth !== previous.depth;
    if (!dirty && region) {
      dirty = chunk.x <= region.x1 + 1 && chunk.x + chunk.width >= region.x0 - 1 &&
        chunk.z <= region.z1 + 1 && chunk.z + chunk.depth >= region.z0 - 1;
    } else if (!dirty && (data.heights !== previous.heights || data.weights !== previous.weights)) {
      for (let z = Math.max(0, chunk.z - 1); !dirty && z <= Math.min(data.subdivisions, chunk.z + chunk.depth + 1); z++) {
        for (let x = Math.max(0, chunk.x - 1); x <= Math.min(data.subdivisions, chunk.x + chunk.width + 1); x++) {
          const i = z * side + x;
          const w4 = i * 4;
          if (
            data.heights[i] !== previous.heights[i] ||
            data.weights[w4] !== previous.weights[w4] ||
            data.weights[w4 + 1] !== previous.weights[w4 + 1] ||
            data.weights[w4 + 2] !== previous.weights[w4 + 2] ||
            data.weights[w4 + 3] !== previous.weights[w4 + 3]
          ) {
            dirty = true;
            break;
          }
        }
      }
    }
    if (dirty) {
      anyDirty = true;
      fillChunkBuffers(data, chunk);
      chunk.mesh.updateVerticesData(VertexBuffer.PositionKind, chunk.positions, true);
      chunk.mesh.updateVerticesData(VertexBuffer.NormalKind, chunk.normals);
      chunk.mesh.updateVerticesData(VertexBuffer.UVKind, chunk.uvs);
      chunk.mesh.updateVerticesData(VertexBuffer.ColorKind, chunk.colors);
      // The position update rebuilt the chunk's bounds at the origin, and Babylon moves them only with the next world
      // matrix it computes, which an unmoved landscape never has: move them here, before the Material pads them.
      chunk.mesh.refreshBoundingInfo();
    }
    if (!preserveMaterial) {
      const material = data.materialGuid ? assets?.resolveMaterial?.(data.materialGuid, { scene: root.getScene() }) : null;
      chunk.mesh.material = material ?? root.getScene().defaultMaterial;
      chunk.mesh.useVertexColors = Boolean(material);
    }
    applyMaterialBounds(chunk.mesh, dirty);
    chunk.mesh.receiveShadows = true;
  }
  state.data = data;
  if (anyDirty) {
    const lodState = lodStateByScene.get(root.getScene());
    if (lodState) lodState.dirty = true;
  }
}
