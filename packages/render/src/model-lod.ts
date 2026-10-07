import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { Camera } from "@babylonjs/core/Cameras/camera";
import { Material } from "@babylonjs/core/Materials/material";
import { MultiMaterial } from "@babylonjs/core/Materials/multiMaterial";
import type { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { Geometry } from "@babylonjs/core/Meshes/geometry";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { SubMesh } from "@babylonjs/core/Meshes/subMesh";
import type { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Scene } from "@babylonjs/core/scene";
import type { AssetContainer } from "@babylonjs/core/assetContainer";
import type { MeshoptSimplifier as Simplifier } from "meshoptimizer/simplifier";
import { simplifyLevels, type LodLevelIndices, type LodSimplifyInput } from "./model-lod-simplify";
import type { ModelLodWorkerReply, ModelLodWorkerRequest } from "./model-lod.worker";
import { renderSettingsOwner, sceneRenderingSettings } from "./render-settings";
import { sharedVertexBuffer } from "./shared-vertex-buffer";

export { AUTO_LOD_SCREEN_SIZES } from "./model-lod-simplify";

/** Smaller meshes are dominated by per-draw cost; simplifying them saves nothing. */
export const AUTO_LOD_MIN_SOURCE_TRIANGLES = 1024;
/** Screen-size band that keeps a mesh on its current level near a threshold. */
const AUTO_LOD_HYSTERESIS = 0.1;
/** Keep each main-thread fallback step short so views keep presenting frames. */
const AUTO_LOD_YIELD_MS = 8;
/** A stuck worker falls back to the main thread instead of holding model loads. */
const AUTO_LOD_WORKER_TIMEOUT_MS = 30_000;
/**
 * Generated levels are shared by every Scene (editor, Play, previews). Models
 * a Scene still uses stay cached, plus this many recently released ones.
 */
const AUTO_LOD_CACHED_MODELS = 32;

type LodSubMesh = {
  materialIndex: number;
  verticesStart: number;
  verticesCount: number;
  indexStart: number;
  indexCount: number;
};

/** CPU level data; identical for every Scene that loads the same model bytes. */
type LodLevelData = {
  /** Babylon screen-coverage threshold with the viewport aspect normalized to 1. */
  coverage: number;
  indices: Uint16Array | Uint32Array;
  subMeshes: LodSubMesh[];
  triangles: number;
};
type MeshLevels = { vertexCount: number; indexCount: number; levels: LodLevelData[] };
type ModelLevels = Map<number, MeshLevels>;

/** A level as used by one Scene: shared CPU data plus that Scene's Geometry. */
type SceneLevel = { data: LodLevelData; geometry?: Geometry };

/** Generated index-only levels for one decoded model container in one Scene. */
export interface ModelLodSet {
  /** Levels for a container mesh; actor clones resolve through `Mesh.source`. */
  levelsFor(source: Mesh | null | undefined): readonly SceneLevel[] | undefined;
  /** Index bytes held by every generated level, for geometry accounting. */
  readonly indexBytes: number;
  dispose(): void;
}

/** Babylon's screen coverage for a projected screen size on a square viewport. */
export function autoLodCoverage(screenSize: number): number {
  return (Math.PI / 4) * screenSize * screenSize;
}

let simplifierLoad: Promise<typeof Simplifier | null> | undefined;

function loadSimplifier(): Promise<typeof Simplifier | null> {
  simplifierLoad ??= import("meshoptimizer/simplifier")
    .then(async ({ MeshoptSimplifier }) => {
      if (!MeshoptSimplifier.supported) throw new Error("WebAssembly is unavailable");
      await MeshoptSimplifier.ready;
      return MeshoptSimplifier;
    })
    .catch((error: unknown) => {
      console.warn(`[render] Automatic LOD is unavailable; models render at full detail: ${String(error)}`);
      return null;
    });
  return simplifierLoad;
}

function materialsOf(material: Material | null): Material[] {
  if (!material) return [];
  if (material instanceof MultiMaterial) return material.subMaterials.filter((entry): entry is Material => entry !== null);
  return [material];
}

/** Indexed meshes that Babylon draws through their own LOD list. */
function drawsOwnLevels(mesh: AbstractMesh): mesh is Mesh {
  if (!(mesh instanceof Mesh) || mesh.isUnIndexed || !mesh.geometry || mesh.hasThinInstances) return false;
  // Babylon selects LODs for glTF instances without the Scene selector.
  if (mesh.instances.length > 0) return false;
  // CPU skinning rewrites the position buffer that levels share.
  return !(mesh.skeleton && !mesh.computeBonesUsingShaders);
}

/** Dense triangle-list model meshes worth simplifying. */
function eligible(mesh: AbstractMesh): mesh is Mesh {
  if (!drawsOwnLevels(mesh)) return false;
  if (materialsOf(mesh.material).some((material) => material.fillMode !== Material.TriangleFillMode)) return false;
  return mesh.getTotalIndices() / 3 >= AUTO_LOD_MIN_SOURCE_TRIANGLES;
}

type PreparedMesh = {
  index: number;
  input: LodSimplifyInput;
  vertexCount: number;
  indexCount: number;
  wideIndices: boolean;
  subMeshes: Omit<LodSubMesh, "indexStart" | "indexCount">[];
};

/** Copy one mesh's vertex streams and submesh index ranges out of Babylon. */
function prepareMesh(mesh: Mesh, index: number): PreparedMesh | null {
  const positions = mesh.getVerticesData(VertexBuffer.PositionKind);
  const indices = mesh.getIndices();
  const vertexCount = mesh.getTotalVertices();
  if (!positions || !indices || vertexCount === 0 || !mesh.subMeshes?.length) return null;
  const normals = mesh.getVerticesData(VertexBuffer.NormalKind);
  const uvs = mesh.getVerticesData(VertexBuffer.UVKind);
  return {
    index,
    vertexCount,
    indexCount: mesh.getTotalIndices(),
    // Matching the source index width keeps material defines identical.
    wideIndices: vertexCount > 0xffff || mesh.geometry!.getIndexBuffer()?.is32Bits === true,
    subMeshes: mesh.subMeshes.map((subMesh) => ({
      materialIndex: subMesh.materialIndex,
      verticesStart: subMesh.verticesStart,
      verticesCount: subMesh.verticesCount,
    })),
    input: {
      positions: new Float32Array(positions),
      normals: normals ? new Float32Array(normals) : null,
      uvs: uvs ? new Float32Array(uvs) : null,
      ranges: mesh.subMeshes.map((subMesh) =>
        Uint32Array.from(indices.slice(subMesh.indexStart, subMesh.indexStart + subMesh.indexCount))),
      deforming: Boolean(mesh.skeleton || mesh.morphTargetManager),
    },
  };
}

/** Concatenate a level's submesh ranges into one index buffer. */
function levelData(prepared: PreparedMesh, level: LodLevelIndices): LodLevelData {
  const count = level.ranges.reduce((total, range) => total + range.length, 0);
  const indices = prepared.wideIndices ? new Uint32Array(count) : new Uint16Array(count);
  const subMeshes: LodSubMesh[] = [];
  let indexStart = 0;
  for (const [part, range] of level.ranges.entries()) {
    indices.set(range, indexStart);
    subMeshes.push({ ...prepared.subMeshes[part]!, indexStart, indexCount: range.length });
    indexStart += range.length;
  }
  return { coverage: autoLodCoverage(level.screenSize), indices, subMeshes, triangles: level.triangles };
}

let workerQueue: Promise<unknown> = Promise.resolve();
let queuedJobs = 0;
let lodWorker: Worker | null = null;

function releaseWorker(): void {
  lodWorker?.terminate();
  lodWorker = null;
}

/**
 * Models simplify one at a time in a shared worker. It exits when the queue
 * drains, returning the simplifier's heap, or after any failure.
 */
function simplifyInWorker(meshes: LodSimplifyInput[]): Promise<LodLevelIndices[][]> {
  queuedJobs++;
  const job = workerQueue.then(() => new Promise<LodLevelIndices[][]>((resolve, reject) => {
    const worker = lodWorker ??= new Worker(new URL("./model-lod.worker.ts", import.meta.url), { type: "module" });
    const finish = (settle: () => void, failed: boolean) => {
      clearTimeout(timeout);
      worker.onmessage = worker.onerror = worker.onmessageerror = null;
      if (failed) releaseWorker();
      settle();
    };
    const fail = (message: string) => finish(() => reject(new Error(message)), true);
    const timeout = setTimeout(() => fail("timed out"), AUTO_LOD_WORKER_TIMEOUT_MS);
    worker.onmessage = (event: MessageEvent<ModelLodWorkerReply>) => {
      const reply = event.data;
      if ("error" in reply) fail(reply.error);
      else finish(() => resolve(reply.levels), false);
    };
    worker.onerror = (event) => fail(event.message || "worker failed");
    worker.onmessageerror = () => fail("invalid worker reply");
    // Structured cloning leaves these inputs intact for the main-thread fallback.
    worker.postMessage({ meshes } satisfies ModelLodWorkerRequest);
  })).finally(() => {
    if (--queuedJobs === 0) releaseWorker();
  });
  workerQueue = job.catch(() => {});
  return job;
}

const yieldToFrames = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function simplifyMeshes(meshes: LodSimplifyInput[]): Promise<LodLevelIndices[][]> {
  if (typeof Worker !== "undefined") {
    try {
      return await simplifyInWorker(meshes);
    } catch (error) {
      console.warn(`[render] Automatic LOD worker failed; simplifying on the main thread: ${String(error)}`);
    }
  }
  const simplifier = await loadSimplifier();
  if (!simplifier) return meshes.map(() => []);
  const results: LodLevelIndices[][] = [];
  let sliceStart = performance.now();
  for (const mesh of meshes) {
    if (performance.now() - sliceStart > AUTO_LOD_YIELD_MS) {
      await yieldToFrames();
      sliceStart = performance.now();
    }
    try {
      results.push(simplifyLevels(simplifier, mesh));
    } catch (error) {
      console.warn(`[render] Automatic LOD skipped a mesh: ${String(error)}`);
      results.push([]);
    }
  }
  return results;
}

async function generateLevels(prepared: PreparedMesh[]): Promise<ModelLevels> {
  const results = await simplifyMeshes(prepared.map((mesh) => mesh.input));
  const models: ModelLevels = new Map();
  for (const [position, mesh] of prepared.entries()) {
    const levels = results[position] ?? [];
    if (levels.length) models.set(mesh.index, {
      vertexCount: mesh.vertexCount,
      indexCount: mesh.indexCount,
      levels: levels.map((level) => levelData(mesh, level)),
    });
  }
  return models;
}

type CachedModel = { key: string; levels: Promise<ModelLevels>; users: number };
/** Least recently used first. */
const generatedModels = new Map<string, CachedModel>();

function touchModel(cached: CachedModel): void {
  if (generatedModels.get(cached.key) !== cached) return;
  generatedModels.delete(cached.key);
  generatedModels.set(cached.key, cached);
}

function acquireModel(key: string, generate: () => Promise<ModelLevels>): CachedModel {
  let cached = generatedModels.get(key);
  if (!cached) {
    const created: CachedModel = { key, levels: generate(), users: 0 };
    created.levels.catch(() => {
      if (generatedModels.get(key) === created) generatedModels.delete(key);
    });
    generatedModels.set(key, created);
    cached = created;
  }
  cached.users++;
  touchModel(cached);
  return cached;
}

function releaseModel(cached: CachedModel): void {
  if (--cached.users > 0) return;
  touchModel(cached);
  let unused = 0;
  for (const entry of generatedModels.values()) if (!entry.users) unused++;
  for (const [key, entry] of generatedModels) {
    if (unused <= AUTO_LOD_CACHED_MODELS) break;
    if (entry.users) continue;
    generatedModels.delete(key);
    unused--;
  }
}

/**
 * Simplify every eligible mesh of a decoded model. Levels are index buffers
 * over the source vertices, so skinning, morph targets, tangents and extra UV
 * sets stay valid. `cacheKey` identifies the model bytes, so other Scenes that
 * load the same model reuse the generated indices.
 */
export async function generateModelLods(
  container: Pick<AssetContainer, "meshes">,
  assertCurrent: () => void = () => {},
  cacheKey?: string,
): Promise<ModelLodSet> {
  const candidates = container.meshes.flatMap((mesh, index) => eligible(mesh) ? [{ mesh, index }] : []);
  let models: ModelLevels = new Map();
  let cached: CachedModel | undefined;
  if (candidates.length) {
    // Low-poly models never load the simplifier.
    const generate = () => generateLevels(candidates.flatMap(({ mesh, index }) => prepareMesh(mesh, index) ?? []));
    if (cacheKey) cached = acquireModel(cacheKey, generate);
    try {
      models = await (cached?.levels ?? generate());
      assertCurrent();
    } catch (error) {
      if (cached) releaseModel(cached);
      throw error;
    }
  }
  const records = new Map<Mesh, SceneLevel[]>();
  let indexBytes = 0;
  for (const { mesh, index } of candidates) {
    const model = models.get(index);
    // A cached entry must describe this mesh's actual loaded buffers.
    if (!model || model.vertexCount !== mesh.getTotalVertices() || model.indexCount !== mesh.getTotalIndices()) continue;
    records.set(mesh, model.levels.map((data) => ({ data })));
    for (const level of model.levels) indexBytes += level.indices.byteLength;
  }
  let disposed = false;
  return {
    levelsFor: (source) => (source ? records.get(source) : undefined),
    indexBytes,
    dispose() {
      if (disposed) return;
      disposed = true;
      if (cached) releaseModel(cached);
      for (const levels of records.values()) {
        for (const level of levels) {
          if (level.geometry && !level.geometry.isDisposed()) level.geometry.dispose();
          level.geometry = undefined;
        }
      }
      records.clear();
    },
  };
}

/**
 * One Geometry per level shared by every actor in the Scene. It is released
 * with its last LOD mesh and rebuilt from the retained indices by the next.
 */
function levelGeometry(source: Mesh, level: SceneLevel, index: number): Geometry {
  if (level.geometry && !level.geometry.isDisposed()) return level.geometry;
  const sourceGeometry = source.geometry!;
  const total = sourceGeometry.getTotalVertices();
  const geometry = new Geometry(`${source.name} LOD${index + 1}`, source.getScene(), undefined, false, null, total);
  const buffers = sourceGeometry.getVertexBuffers() ?? {};
  for (const kind of Object.keys(buffers)) geometry.setVerticesBuffer(sharedVertexBuffer(buffers[kind]!), total);
  geometry.setIndices(level.data.indices, total, false);
  level.geometry = geometry;
  return geometry;
}

type LodBinding = {
  master: Mesh;
  levels: { mesh: Mesh; coverage: number; triangles: number }[];
  /** Level last selected per camera, for hysteresis. */
  current: WeakMap<Camera, number>;
};

type SceneLods = {
  bindings: Set<LodBinding>;
  masters: WeakMap<AbstractMesh, LodBinding>;
};

const sceneLods = new WeakMap<Scene, SceneLods>();
/** Frozen active-mesh queues keep full detail, as they did before automatic LOD. */
const pinnedScenes = new WeakSet<Scene>();

/** Render state Babylon reads from the drawn LOD mesh rather than its master. */
function mirrorLodState(master: Mesh, lod: Mesh): void {
  if (lod.material !== master.material) lod.material = master.material;
  if (lod.receiveShadows !== master.receiveShadows) lod.receiveShadows = master.receiveShadows;
  if (lod.renderingGroupId !== master.renderingGroupId) lod.renderingGroupId = master.renderingGroupId;
  if (lod.alphaIndex !== master.alphaIndex) lod.alphaIndex = master.alphaIndex;
  if (lod.visibility !== master.visibility) lod.visibility = master.visibility;
  if (lod.layerMask !== master.layerMask) lod.layerMask = master.layerMask;
  if (lod.sideOrientation !== master.sideOrientation) lod.sideOrientation = master.sideOrientation;
  if (lod.skeleton !== master.skeleton) lod.skeleton = master.skeleton;
  if (lod.morphTargetManager !== master.morphTargetManager) lod.morphTargetManager = master.morphTargetManager;
  // Blocked meshes skip world-matrix evaluation; the NONUNIFORMSCALING define
  // follows the master through the level's parent link.
  if (lod.nonUniformScaling !== master.nonUniformScaling) lod.computeWorldMatrix(true);
}

/** Babylon screen coverage of a bounding sphere, independent of the bound render target. */
export function autoLodScreenCoverage(radius: number, center: Vector3, camera: Camera): number {
  if (radius <= 0) return 0;
  if (camera.mode === Camera.ORTHOGRAPHIC_CAMERA) {
    const half = camera.getEngine().getRenderHeight(true) / 2;
    const height = (camera.orthoTop ?? half) - (camera.orthoBottom ?? -half);
    return height > 0 ? (Math.PI * radius * radius) / (height * height) : Infinity;
  }
  const distance = center.subtract(camera.globalPosition).length();
  if (distance <= radius) return Infinity;
  const tangent = Math.tan(camera.fov / 2);
  return (Math.PI * radius * radius) / (4 * distance * distance * tangent * tangent);
}

function levelForCoverage(binding: LodBinding, coverage: number, previous: number | undefined): number {
  const levels = binding.levels;
  if (previous === undefined) {
    let level = 0;
    while (level < levels.length && coverage < levels[level]!.coverage) level++;
    return level;
  }
  const coarser = (1 - AUTO_LOD_HYSTERESIS) ** 2;
  const finer = (1 + AUTO_LOD_HYSTERESIS) ** 2;
  let level = Math.min(previous, levels.length);
  while (level < levels.length && coverage < levels[level]!.coverage * coarser) level++;
  while (level > 0 && coverage > levels[level - 1]!.coverage * finer) level--;
  return level;
}

function selectLevel(binding: LodBinding, camera: Camera, commit: boolean): number {
  const scene = binding.master.getScene();
  // SceneLayers resolve Geometry quality through the Scene they follow.
  const settings = sceneRenderingSettings(renderSettingsOwner(scene));
  if (!settings.autoLod || pinnedScenes.has(scene)) {
    if (commit) binding.current.delete(camera);
    return 0;
  }
  const sphere = binding.master.getBoundingInfo().boundingSphere;
  const scale = settings.lodDistanceScale;
  const coverage = autoLodScreenCoverage(sphere.radiusWorld, sphere.centerWorld, camera) * scale * scale;
  const level = levelForCoverage(binding, coverage, binding.current.get(camera));
  if (commit) binding.current.set(camera, level);
  return level;
}

function lodsFor(scene: Scene): SceneLods {
  const lods = sceneLods.get(scene);
  if (lods) return lods;
  const state: SceneLods = { bindings: new Set(), masters: new WeakMap() };
  sceneLods.set(scene, state);
  // Babylon consults the Scene selector on the classic path and in every
  // ObjectRenderer pass (FrameGraph, shadow maps, outline masks).
  scene.customLODSelector = (mesh, camera) => {
    const binding = state.masters.get(mesh);
    if (!binding) return mesh.getLOD(camera);
    const level = selectLevel(binding, camera, true);
    if (level === 0) return binding.master;
    const lod = binding.levels[level - 1]!.mesh;
    // Mesh.getLOD refreshes a level's submesh bounds for submesh culling.
    if (lod.subMeshes.length > 1) {
      const world = binding.master.getWorldMatrix();
      for (const subMesh of lod.subMeshes) subMesh.updateBoundingInfo(world);
    }
    return lod;
  };
  const mirror = scene.onBeforeRenderObservable.add(() => {
    for (const binding of state.bindings) {
      for (const level of binding.levels) mirrorLodState(binding.master, level.mesh);
    }
  });
  scene.onDisposeObservable.addOnce(() => {
    scene.onBeforeRenderObservable.remove(mirror);
    state.bindings.clear();
    sceneLods.delete(scene);
  });
  return state;
}

/** Keep full detail while a Scene's active-mesh queue is frozen (editor brush tools). */
export function setAutoLodPinned(scene: Scene, pinned: boolean): void {
  if (pinned) pinnedScenes.add(scene);
  else pinnedScenes.delete(scene);
}

/** Master meshes whose levels were attached by automatic LOD. */
export function isAutoLodMaster(mesh: AbstractMesh): boolean {
  return sceneLods.get(mesh.getScene())?.masters.has(mesh) ?? false;
}

/**
 * The level the Scene selector will draw for this camera, without advancing
 * its hysteresis. 0 is the master; undefined for meshes without automatic LOD.
 */
export function peekAutoLodLevel(mesh: AbstractMesh, camera: Camera | null): number | undefined {
  const binding = sceneLods.get(mesh.getScene())?.masters.get(mesh);
  if (!binding) return undefined;
  return camera ? selectLevel(binding, camera, false) : 0;
}

/** Scene meshes other than automatic LOD levels, which draw in place of their master. */
export function liveMeshCount(scene: Scene): number {
  let count = 0;
  for (const mesh of scene.meshes) if (!mesh.isBlocked) count++;
  return count;
}

/** Automatic LOD summary for this Scene's active camera. */
export function autoLodDiagnostics(scene: Scene): { meshes: number; reduced: number; trianglesSaved: number } {
  const lods = sceneLods.get(scene);
  let meshes = 0;
  let reduced = 0;
  let trianglesSaved = 0;
  if (!lods) return { meshes, reduced, trianglesSaved };
  for (const binding of lods.bindings) {
    if (!binding.master.isEnabled() || !binding.master.isVisible) continue;
    meshes++;
    const level = peekAutoLodLevel(binding.master, scene.activeCamera) ?? 0;
    if (level === 0) continue;
    reduced++;
    trianglesSaved += binding.master.getTotalIndices() / 3 - binding.levels[level - 1]!.triangles;
  }
  return { meshes, reduced, trianglesSaved };
}

/**
 * Attach generated levels to one actor's cloned meshes. LOD meshes are
 * children of their master, so actor disposal releases them, and they never
 * render on their own: Babylon skips meshes that are another mesh's level.
 */
export function attachModelLods(root: TransformNode, lods: ModelLodSet): number {
  let attached = 0;
  for (const master of root.getChildMeshes()) {
    if (!(master instanceof Mesh) || master.isBlocked || master.hasLODLevels) continue;
    const levels = lods.levelsFor(master.source);
    // Levels are triangle lists over the source; a wireframe or point material
    // on this actor draws them through Babylon's own topology conversion.
    if (!levels?.length || master.geometry !== master.source!.geometry || !drawsOwnLevels(master)) continue;
    const scene = master.getScene();
    const state = lodsFor(scene);
    const binding: LodBinding = { master, levels: [], current: new WeakMap() };
    master.useLODScreenCoverage = true;
    for (const [index, level] of levels.entries()) {
      const lod = new Mesh(`${master.name} LOD${index + 1}`, scene);
      levelGeometry(master.source!, level, index).applyToMesh(lod);
      lod.subMeshes = [];
      for (const part of level.data.subMeshes)
        new SubMesh(part.materialIndex, part.verticesStart, part.verticesCount, part.indexStart, part.indexCount, lod);
      lod.parent = master;
      lod.isPickable = false;
      lod.hasVertexAlpha = master.hasVertexAlpha;
      lod.useVertexColors = master.useVertexColors;
      lod.numBoneInfluencers = master.numBoneInfluencers;
      lod.computeBonesUsingShaders = master.computeBonesUsingShaders;
      lod.computeWorldMatrix(true);
      mirrorLodState(master, lod);
      if (master.skeleton?.needInitialSkinMatrix) lod.updatePoseMatrix(master.getPoseMatrix());
      master.addLODLevel(level.data.coverage, lod);
      binding.levels.push({ mesh: lod, coverage: level.data.coverage, triangles: level.data.triangles });
    }
    // Material swaps reach every level before the next readiness probe.
    master.onMaterialChangedObservable.add(() => {
      for (const level of binding.levels) level.mesh.material = master.material;
    });
    master.onDisposeObservable.addOnce(() => {
      state.bindings.delete(binding);
      state.masters.delete(master);
      for (const level of binding.levels) if (!level.mesh.isDisposed()) level.mesh.dispose();
    });
    state.bindings.add(binding);
    state.masters.set(master, binding);
    attached++;
  }
  return attached;
}
