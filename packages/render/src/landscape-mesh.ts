import { PickingInfo } from "@babylonjs/core/Collisions/pickingInfo";
import type { Ray } from "@babylonjs/core/Culling/ray";
import { Vector3, type Matrix } from "@babylonjs/core/Maths/math.vector";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import type { Scene } from "@babylonjs/core/scene";
import { parseLandscapeProperties, type LandscapeProperties } from "@haptic/core";
import type { MeshAssetContext } from "./mesh-assets";
import { RENDERING_GROUP } from "./sorting";
import { applyMaterialBounds } from "./material-bounds";
import { markSmoothNormalShadowCaster } from "./shadow-bias";

const CHUNK_CELLS = 32;
type Chunk = { mesh: Mesh; x: number; z: number; width: number; depth: number };
const landscapes = new WeakMap<Mesh, { data: LandscapeProperties; chunks: Chunk[] }>();
/** Each chunk mesh's chunk: its cells' place in the heightfield. */
const chunkOf = new WeakMap<Mesh, Chunk>();
/** Landscape roots in each scene, kept by creation and scene membership so per-frame readers never scan the scene. */
const sceneRoots = new WeakMap<Scene, Mesh[]>();
const NO_ROOTS: readonly Mesh[] = [];

function registerLandscape(scene: Scene, root: Mesh): void {
  let roots = sceneRoots.get(scene);
  if (!roots) {
    const list: Mesh[] = roots = [];
    sceneRoots.set(scene, list);
    const removed = scene.onMeshRemovedObservable.add((mesh) => {
      const index = list.indexOf(mesh as Mesh);
      if (index >= 0) list.splice(index, 1);
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
}

/** Landscape roots currently in the scene (enabled or not), without scanning `scene.meshes`. */
export function sceneLandscapeRoots(scene: Scene): readonly Mesh[] {
  return sceneRoots.get(scene) ?? NO_ROOTS;
}

function chunkData(data: LandscapeProperties, chunk: Omit<Chunk, "mesh">): VertexData {
  const positions: number[] = []; const normals: number[] = []; const uvs: number[] = []; const colors: number[] = []; const indices: number[] = [];
  const side = data.subdivisions + 1;
  const dx = data.width / data.subdivisions; const dz = data.depth / data.subdivisions;
  for (let z = 0; z <= chunk.depth; z++) for (let x = 0; x <= chunk.width; x++) {
    const gx = x + chunk.x; const gz = z + chunk.z; const i = gz * side + gx;
    const px = gx * dx - data.width / 2; const pz = gz * dz - data.depth / 2;
    positions.push(px, data.heights[i]!, pz);
    // Sample beyond chunk boundaries so adjacent chunks share identical normals.
    const left = Math.max(0, gx - 1); const right = Math.min(side - 1, gx + 1);
    const back = Math.max(0, gz - 1); const front = Math.min(side - 1, gz + 1);
    const nx = -(data.heights[gz * side + right]! - data.heights[gz * side + left]!) / ((right - left) * dx);
    const nz = -(data.heights[front * side + gx]! - data.heights[back * side + gx]!) / ((front - back) * dz);
    const length = Math.hypot(nx, 1, nz);
    normals.push(nx / length, 1 / length, nz / length);
    uvs.push(px / 8, pz / 8);
    colors.push(...data.weights.slice(i * 4, i * 4 + 4));
    if (x < chunk.width && z < chunk.depth) {
      const a = z * (chunk.width + 1) + x; const b = a + chunk.width + 1;
      // Babylon's left-handed front face must face above the heightfield.
      indices.push(a, a + 1, b, a + 1, b + 1, b);
    }
  }
  const vertex = new VertexData();
  Object.assign(vertex, { positions, normals, uvs, colors, indices });
  return vertex;
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
  for (let z = 0; z < data.subdivisions; z += CHUNK_CELLS) for (let x = 0; x < data.subdivisions; x += CHUNK_CELLS) {
    const mesh = new Mesh(`${name}:landscape:${x}:${z}`, scene);
    const chunk = { mesh, x, z, width: Math.min(CHUNK_CELLS, data.subdivisions - x), depth: Math.min(CHUNK_CELLS, data.subdivisions - z) };
    chunkData(data, chunk).applyToMesh(mesh, true);
    chunkGeometries.set(mesh, mesh.geometry);
    chunkOf.set(mesh, chunk);
    mesh.parent = root;
    mesh.renderingGroupId = RENDERING_GROUP.world;
    mesh.hasVertexAlpha = false;
    mesh.metadata = { landscapeRoot: root };
    markSmoothNormalShadowCaster(mesh);
    chunks.push(chunk);
  }
  landscapes.set(root, { data, chunks });
  registerLandscape(scene, root);
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
 * A ray's nearest hit on a landscape chunk, as `AbstractMesh.intersects` would answer it, testing only the cells the
 * ray's segment crosses (and their neighbours) rather than every face. `ray` is in the chunk's own space, as
 * `Scene.pickWithRay` passes it, and `world` is the chunk's world matrix; the hit answers in world units. The faces are
 * tested with Babylon's own triangle test, in the order it tests them, so the hit is the one it would find. Undefined
 * when `mesh` is not a landscape chunk drawing its own geometry with a triangle Material, or the segment crosses too
 * many cells: test the whole mesh then.
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
  // Each cell's two faces, in face order (cells row by row, as `chunkData` writes them).
  for (let z = z0; z <= z1; z++) {
    for (let x = x0; x <= x1; x++) {
      const first = 2 * ((z - chunk.z) * chunk.width + (x - chunk.x));
      for (let face = first; face < first + 2; face++) {
        const at = subMesh.indexStart + face * 3;
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
  info.faceId = nearest.faceId + subMesh.indexStart / 3;
  info.subMeshId = subMesh._id;
  return info;
}

/**
 * Rewrites heights, weights and Material in place. Chunks keep the
 * subdivisions the mesh was created with: a subdivision change has a new
 * `landscape:<subdivisions>` visual kind, so EditorSceneSync rebuilds the mesh.
 */
export function updateLandscapeMesh(root: Mesh, properties: unknown, assets?: MeshAssetContext): void {
  const state = landscapes.get(root);
  if (!state) return;
  const data = parseLandscapeProperties(properties);
  const previous = state.data;
  const side = data.subdivisions + 1;
  for (const chunk of state.chunks) {
    let dirty = data.width !== previous.width || data.depth !== previous.depth;
    for (let z = Math.max(0, chunk.z - 1); !dirty && z <= Math.min(data.subdivisions, chunk.z + chunk.depth + 1); z++) {
      for (let x = Math.max(0, chunk.x - 1); x <= Math.min(data.subdivisions, chunk.x + chunk.width + 1); x++) {
        const i = z * side + x;
        if (data.heights[i] !== previous.heights[i] || [0, 1, 2, 3].some((l) => data.weights[i * 4 + l] !== previous.weights[i * 4 + l])) { dirty = true; break; }
      }
    }
    if (dirty) {
      const vertex = chunkData(data, chunk);
      chunk.mesh.updateVerticesData(VertexBuffer.PositionKind, vertex.positions!, true);
      chunk.mesh.updateVerticesData(VertexBuffer.NormalKind, vertex.normals!);
      chunk.mesh.updateVerticesData(VertexBuffer.UVKind, vertex.uvs!);
      chunk.mesh.updateVerticesData(VertexBuffer.ColorKind, vertex.colors!);
      // The position update rebuilt the chunk's bounds at the origin, and Babylon moves them only with the next world
      // matrix it computes, which an unmoved landscape never has: move them here, before the Material pads them.
      chunk.mesh.refreshBoundingInfo();
    }
    const material = data.materialGuid ? assets?.resolveMaterial?.(data.materialGuid, { scene: root.getScene() }) : null;
    chunk.mesh.material = material ?? root.getScene().defaultMaterial;
    applyMaterialBounds(chunk.mesh, dirty);
    chunk.mesh.useVertexColors = Boolean(material);
    chunk.mesh.receiveShadows = true;
  }
  state.data = data;
}
