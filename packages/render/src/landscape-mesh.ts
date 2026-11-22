import type { Camera } from "@babylonjs/core/Cameras/camera";
import { PickingInfo } from "@babylonjs/core/Collisions/pickingInfo";
import type { Ray } from "@babylonjs/core/Culling/ray";
import { Vector3, type Matrix } from "@babylonjs/core/Maths/math.vector";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import type { Observer } from "@babylonjs/core/Misc/observable";
import type { Scene } from "@babylonjs/core/scene";
import { parseLandscapeProperties, type LandscapeProperties } from "@haptic/core";
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

type ChunkLodRange = { indexStart: number; indexCount: number };
type ChunkIndexLayout = {
  indices: Uint16Array;
  lods: readonly ChunkLodRange[];
};

type Chunk = {
  mesh: Mesh;
  x: number;
  z: number;
  width: number;
  depth: number;
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
/** Cached static concatenated `[LOD0 | LOD1 | LOD2 | LOD3]` index buffers keyed by `${width}x${depth}`. */
const indexLayoutCache = new Map<string, ChunkIndexLayout>();
const NO_ROOTS: readonly Mesh[] = [];

function sampleSteps(length: number, stride: number): number[] {
  const steps: number[] = [];
  for (let v = 0; v < length; v += stride) steps.push(v);
  steps.push(length);
  return steps;
}

/**
 * Builds (and caches) one static concatenated index buffer containing `[LOD0 | LOD1 | LOD2 | LOD3]`
 * for a `(w, d)` cell chunk.
 * - LOD0 (stride 1): full surface quads, no skirts, starting at index 0.
 * - LOD1..LOD3 (strides 2, 4, 8): coarser surface quads + 4 outward-facing perimeter skirt strips
 *   so cracks between neighboring chunks at different LODs are completely hidden.
 */
function getChunkIndexLayout(w: number, d: number): ChunkIndexLayout {
  const key = `${w}x${d}`;
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

    // Perimeter downward skirt strips on coarser LODs (LOD1..LOD3) with outward-facing LH winding.
    if (lodIdx > 0) {
      // North edge (z = 0, outward normal -Z)
      for (let xi = 0; xi < xs.length - 1; xi++) {
        const x0 = xs[xi]!;
        const x1 = xs[xi + 1]!;
        const t0 = x0;
        const t1 = x1;
        const s0 = northSkirtStart + x0;
        const s1 = northSkirtStart + x1;
        raw.push(t0, s0, t1, t1, s0, s1);
      }
      // South edge (z = d, outward normal +Z)
      const southRow = d * row;
      for (let xi = 0; xi < xs.length - 1; xi++) {
        const x0 = xs[xi]!;
        const x1 = xs[xi + 1]!;
        const t0 = southRow + x0;
        const t1 = southRow + x1;
        const s0 = southSkirtStart + x0;
        const s1 = southSkirtStart + x1;
        raw.push(t0, t1, s0, t1, s1, s0);
      }
      // West edge (x = 0, outward normal -X)
      for (let zi = 0; zi < zs.length - 1; zi++) {
        const z0 = zs[zi]!;
        const z1 = zs[zi + 1]!;
        const t0 = z0 * row;
        const t1 = z1 * row;
        const s0 = westSkirtStart + z0;
        const s1 = westSkirtStart + z1;
        raw.push(t0, t1, s0, t1, s1, s0);
      }
      // East edge (x = w, outward normal +X)
      for (let zi = 0; zi < zs.length - 1; zi++) {
        const z0 = zs[zi]!;
        const z1 = zs[zi + 1]!;
        const t0 = z0 * row + w;
        const t1 = z1 * row + w;
        const s0 = eastSkirtStart + z0;
        const s1 = eastSkirtStart + z1;
        raw.push(t0, s0, t1, t1, s0, s1);
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
 * Writes interior heightfield vertices plus 4 perimeter downward skirt strips directly
 * into the chunk's pre-allocated `Float32Array` buffers (zero per-vertex allocations).
 */
function fillChunkBuffers(data: LandscapeProperties, chunk: Chunk): void {
  const { width: w, depth: d, positions, normals, uvs, colors } = chunk;
  const side = data.subdivisions + 1;
  const dx = data.width / data.subdivisions;
  const dz = data.depth / data.subdivisions;
  const halfW = data.width * 0.5;
  const halfD = data.depth * 0.5;
  const skirtDepth = Math.max(dx, dz) * 1.5;
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
  force = false,
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
    !force &&
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
      const layout = getChunkIndexLayout(w, d);
      const mesh = new Mesh(`${name}:landscape:${x}:${z}`, scene);
      const chunk: Chunk = {
        mesh,
        x,
        z,
        width: w,
        depth: d,
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

/** A trace crossing more cells than this tests the whole chunk instead. */
const MAX_TRACE_CELLS = 64;
/** What `intersectLandscapeChunk` reads of a chunk's geometry beyond its public API (Babylon 9.29 internals, as its picking reads them). */
type PointsArray = { _generatePointsArray(): boolean; readonly _positions: Vector3[] | null };

/**
 * A ray's nearest hit on a landscape chunk, testing only the LOD0 cells the ray's segment crosses
 * (and their neighbours) rather than every face. Always tests LOD0 (`indexStart = 0`, no skirts)
 * regardless of the chunk's active render LOD, so picking and brush sculpting always hit exact
 * full-resolution terrain.
 */
export function intersectLandscapeChunk(mesh: Mesh, ray: Ray, world: Matrix): PickingInfo | undefined {
  const chunk = chunkOf.get(mesh);
  const root = chunk ? (mesh.metadata as { landscapeRoot?: Mesh } | null)?.landscapeRoot : undefined;
  const data = root ? landscapes.get(root)?.data : undefined;
  const subMesh = mesh.subMeshes?.length === 1 ? mesh.subMeshes[0] : undefined;
  const fillMode = subMesh?.getMaterial()?.fillMode;
  if (!chunk || !data || !subMesh || !hasRevisionTrackedLandscapeGeometry(mesh) || (fillMode !== 0 && fillMode !== 1 && fillMode !== 2)) return undefined;
  const info = new PickingInfo();
  // Its bounds first, as `AbstractMesh.intersects` tests them.
  const bounds = mesh.getBoundingInfo();
  if (!ray.intersectsSphere(bounds.boundingSphere, 0) || !ray.intersectsBox(bounds.boundingBox, 0)) return info;
  const points = mesh as unknown as PointsArray;
  const indices = mesh.getIndices();
  if (!points._generatePointsArray() || !points._positions || !indices) return undefined;
  const dx = data.width / data.subdivisions;
  const dz = data.depth / data.subdivisions;
  const endX = ray.origin.x + ray.direction.x * ray.length;
  const endZ = ray.origin.z + ray.direction.z * ray.length;
  const cell = (value: number, half: number, size: number) => Math.floor((value + half) / size);
  // Grid cells, padded by one so a hit on a cell's edge meets the face Babylon would test first.
  const x0 = Math.max(chunk.x, cell(Math.min(ray.origin.x, endX), data.width / 2, dx) - 1);
  const x1 = Math.min(chunk.x + chunk.width - 1, cell(Math.max(ray.origin.x, endX), data.width / 2, dx) + 1);
  const z0 = Math.max(chunk.z, cell(Math.min(ray.origin.z, endZ), data.depth / 2, dz) - 1);
  const z1 = Math.min(chunk.z + chunk.depth - 1, cell(Math.max(ray.origin.z, endZ), data.depth / 2, dz) + 1);
  if (!Number.isFinite(x0 + x1 + z0 + z1)) return undefined;
  if (x1 >= x0 && z1 >= z0 && (x1 - x0 + 1) * (z1 - z0 + 1) > MAX_TRACE_CELLS) return undefined;
  const positions = points._positions;
  let nearest: { bu: number | null; bv: number | null; distance: number; faceId: number } | null = null;
  // Always read LOD0 faces (`indexStart = 0`, zero skirt triangles) regardless of active render LOD.
  for (let z = z0; z <= z1; z++) {
    for (let x = x0; x <= x1; x++) {
      const first = 2 * ((z - chunk.z) * chunk.width + (x - chunk.x));
      for (let face = first; face < first + 2; face++) {
        const at = face * 3;
        const p0 = positions[indices[at]!];
        const p1 = positions[indices[at + 1]!];
        const p2 = positions[indices[at + 2]!];
        if (!p0 || !p1 || !p2) continue;
        const hit = ray.intersectsTriangle(p0, p1, p2);
        if (!hit || hit.distance < 0 || (nearest && !(hit.distance < nearest.distance))) continue;
        nearest = { bu: hit.bu, bv: hit.bv, distance: hit.distance, faceId: face };
      }
    }
  }
  if (!nearest) return info;
  // As `AbstractMesh.intersects` answers a hit.
  const worldOrigin = Vector3.TransformCoordinates(ray.origin, world);
  const pickedPoint = Vector3.TransformNormal(ray.direction.scale(nearest.distance), world).addInPlace(worldOrigin);
  info.hit = true;
  info.distance = Vector3.Distance(worldOrigin, pickedPoint);
  info.pickedPoint = pickedPoint;
  info.pickedMesh = mesh;
  info.bu = nearest.bu || 0;
  info.bv = nearest.bv || 0;
  info.subMeshFaceId = nearest.faceId;
  info.faceId = nearest.faceId;
  info.subMeshId = subMesh._id;
  return info;
}

export interface UpdateLandscapeMeshOptions {
  /** Force vertex upload even when `properties` mutates the same typed arrays in place (e.g. live sculpt session). */
  forceDirty?: boolean;
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
  const forceDirty = options?.forceDirty === true;
  const preserveMaterial = assets === undefined && data.materialGuid === previous.materialGuid;
  let anyDirty = false;
  for (const chunk of state.chunks) {
    let dirty = forceDirty || data.width !== previous.width || data.depth !== previous.depth;
    if (!dirty && (data.heights !== previous.heights || data.weights !== previous.weights)) {
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
