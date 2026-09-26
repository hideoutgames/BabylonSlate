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
import type { MeshoptSimplifier as Simplifier, Flags } from "meshoptimizer/simplifier";
import { sceneRenderingSettings } from "./render-settings";

/**
 * Screen size (projected bounding-sphere diameter / viewport height) below
 * which each generated level starts, before the quality distance scale.
 */
export const AUTO_LOD_SCREEN_SIZES = [0.5, 0.25, 0.125] as const;
/** Triangle budget of each level relative to the source mesh. */
const AUTO_LOD_TRIANGLE_RATIOS = [0.5, 0.25, 0.125] as const;
/** Smaller meshes are dominated by per-draw cost; simplifying them saves nothing. */
export const AUTO_LOD_MIN_SOURCE_TRIANGLES = 1024;
const AUTO_LOD_MIN_LEVEL_TRIANGLES = 64;
/** A level must remove at least this fraction of the previous level's triangles. */
const AUTO_LOD_MIN_REDUCTION = 0.2;
/** Geometric error allowed at a level's switch point, in pixels of a 1080-pixel-high view. */
const AUTO_LOD_ERROR_PIXELS = 2;
const AUTO_LOD_REFERENCE_HEIGHT = 1080;
/** Normals keep shading while collapsing; weight 1 would trade away more position quality. */
const AUTO_LOD_NORMAL_WEIGHT = 0.5;
/** Screen-size band that keeps a mesh on its current level near a threshold. */
const AUTO_LOD_HYSTERESIS = 0.1;
/** Keep each load step short so the editor keeps presenting frames. */
const AUTO_LOD_YIELD_MS = 8;

type LodSubMesh = {
  materialIndex: number;
  verticesStart: number;
  verticesCount: number;
  indexStart: number;
  indexCount: number;
};

type LodLevelData = {
  /** Babylon screen-coverage threshold with the viewport aspect normalized to 1. */
  coverage: number;
  indices: Uint16Array | Uint32Array;
  subMeshes: LodSubMesh[];
  triangles: number;
  geometry?: Geometry;
};

/** Generated index-only levels for one decoded model container. */
export interface ModelLodSet {
  /** Levels for a container mesh; actor clones resolve through `Mesh.source`. */
  levelsFor(source: Mesh | null | undefined): readonly LodLevelData[] | undefined;
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

/** Indexed static-topology triangle meshes that Babylon renders through their own LOD list. */
function eligible(mesh: AbstractMesh): mesh is Mesh {
  if (!(mesh instanceof Mesh) || mesh.isUnIndexed || !mesh.geometry || mesh.hasThinInstances) return false;
  // Babylon selects LODs for glTF instances without the Scene selector.
  if (mesh.instances.length > 0) return false;
  // CPU skinning rewrites the position buffer that levels share.
  if (mesh.skeleton && !mesh.computeBonesUsingShaders) return false;
  if (materialsOf(mesh.material).some((material) => material.fillMode !== Material.TriangleFillMode)) return false;
  return mesh.getTotalIndices() / 3 >= AUTO_LOD_MIN_SOURCE_TRIANGLES;
}

function simplifyMesh(simplifier: typeof Simplifier, mesh: Mesh): LodLevelData[] {
  const positionData = mesh.getVerticesData(VertexBuffer.PositionKind);
  const sourceIndices = mesh.getIndices();
  const vertexCount = mesh.getTotalVertices();
  if (!positionData || !sourceIndices || vertexCount === 0 || !mesh.subMeshes?.length) return [];
  const positions = positionData instanceof Float32Array ? positionData : new Float32Array(positionData);
  const normalData = mesh.getVerticesData(VertexBuffer.NormalKind);
  const normals = normalData && normalData.length === vertexCount * 3
    ? normalData instanceof Float32Array ? normalData : new Float32Array(normalData)
    : null;
  const flags: Flags[] = ["LockBorder", "ErrorAbsolute"];
  // Deforming meshes keep better triangle shapes under skinning and morphs.
  if (mesh.skeleton || mesh.morphTargetManager) flags.push("Regularize");
  const scale = simplifier.getScale(positions, 3);
  const ranges = mesh.subMeshes.map((subMesh) => ({
    materialIndex: subMesh.materialIndex,
    verticesStart: subMesh.verticesStart,
    verticesCount: subMesh.verticesCount,
    indices: Uint32Array.from(sourceIndices.slice(subMesh.indexStart, subMesh.indexStart + subMesh.indexCount)),
  }));
  const sourceTriangles = ranges.reduce((total, range) => total + range.indices.length / 3, 0);
  const levels: LodLevelData[] = [];
  let previousTriangles = sourceTriangles;
  for (const [level, screenSize] of AUTO_LOD_SCREEN_SIZES.entries()) {
    const ratio = AUTO_LOD_TRIANGLE_RATIOS[level]!;
    const error = (AUTO_LOD_ERROR_PIXELS / (screenSize * AUTO_LOD_REFERENCE_HEIGHT)) * scale;
    const parts = ranges.map((range) => {
      const target = Math.max(3, Math.floor((range.indices.length * ratio) / 3) * 3);
      return normals
        ? simplifier.simplifyWithAttributes(range.indices, positions, 3, normals, 3,
          [AUTO_LOD_NORMAL_WEIGHT, AUTO_LOD_NORMAL_WEIGHT, AUTO_LOD_NORMAL_WEIGHT], null, target, error, flags)[0]
        : simplifier.simplify(range.indices, positions, 3, target, error, flags)[0];
    });
    const triangles = parts.reduce((total, part) => total + part.length / 3, 0);
    if (triangles < AUTO_LOD_MIN_LEVEL_TRIANGLES) break;
    // A later level has a larger error budget and may still reduce enough.
    if (triangles > previousTriangles * (1 - AUTO_LOD_MIN_REDUCTION)) continue;
    const indices = vertexCount <= 0xffff ? new Uint16Array(triangles * 3) : new Uint32Array(triangles * 3);
    const subMeshes: LodSubMesh[] = [];
    let indexStart = 0;
    for (const [index, part] of parts.entries()) {
      const range = ranges[index]!;
      indices.set(part, indexStart);
      subMeshes.push({
        materialIndex: range.materialIndex,
        verticesStart: range.verticesStart,
        verticesCount: range.verticesCount,
        indexStart,
        indexCount: part.length,
      });
      indexStart += part.length;
    }
    levels.push({ coverage: autoLodCoverage(screenSize), indices, subMeshes, triangles });
    previousTriangles = triangles;
  }
  return levels;
}

const yieldToFrames = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * Simplify every eligible mesh of a decoded model once. Levels are index
 * buffers over the source vertices, so skinning, morph targets, tangents and
 * extra UV sets stay valid.
 */
export async function generateModelLods(
  container: Pick<AssetContainer, "meshes">,
  assertCurrent: () => void = () => {},
): Promise<ModelLodSet> {
  const records = new Map<Mesh, LodLevelData[]>();
  let indexBytes = 0;
  // Low-poly models never load the simplifier.
  const candidates = container.meshes.filter(eligible);
  const simplifier = candidates.length ? await loadSimplifier() : null;
  assertCurrent();
  let sliceStart = performance.now();
  for (const mesh of candidates) {
    if (!simplifier) break;
    if (performance.now() - sliceStart > AUTO_LOD_YIELD_MS) {
      await yieldToFrames();
      assertCurrent();
      sliceStart = performance.now();
    }
    let levels: LodLevelData[] = [];
    try {
      levels = simplifyMesh(simplifier, mesh);
    } catch (error) {
      console.warn(`[render] Automatic LOD skipped mesh "${mesh.name}": ${String(error)}`);
    }
    if (!levels.length) continue;
    records.set(mesh, levels);
    for (const level of levels) indexBytes += level.indices.byteLength;
  }
  let disposed = false;
  return {
    levelsFor: (source) => (source ? records.get(source) : undefined),
    indexBytes,
    dispose() {
      if (disposed) return;
      disposed = true;
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

/** Wrap a source attribute over the same GPU buffer, as Babylon's glTF loader shares bufferViews. */
function sharedVertexBuffer(source: VertexBuffer): VertexBuffer {
  return new VertexBuffer(source.engine, source.getWrapperBuffer(), source.getKind(), {
    stride: source.byteStride,
    offset: source.byteOffset,
    size: source.getSize(),
    type: source.type,
    normalized: source.normalized,
    useBytes: true,
    instanced: source.getIsInstanced(),
    divisor: source.getInstanceDivisor(),
    takeBufferOwnership: true,
  });
}

/**
 * One Geometry per level shared by every actor. It is released with its last
 * LOD mesh and rebuilt from the retained indices by the next actor.
 */
function levelGeometry(source: Mesh, level: LodLevelData, index: number): Geometry {
  if (level.geometry && !level.geometry.isDisposed()) return level.geometry;
  const sourceGeometry = source.geometry!;
  const total = sourceGeometry.getTotalVertices();
  const geometry = new Geometry(`${source.name} LOD${index + 1}`, source.getScene(), undefined, false, null, total);
  const buffers = sourceGeometry.getVertexBuffers() ?? {};
  for (const kind of Object.keys(buffers)) geometry.setVerticesBuffer(sharedVertexBuffer(buffers[kind]!), total);
  geometry.setIndices(level.indices, total, false);
  level.geometry = geometry;
  return geometry;
}

type LodBinding = {
  master: Mesh;
  levels: { mesh: Mesh; coverage: number }[];
  /** Level last selected per camera, for hysteresis. */
  current: WeakMap<Camera, number>;
};

type SceneLods = {
  bindings: Set<LodBinding>;
  masters: WeakMap<AbstractMesh, LodBinding>;
};

const sceneLods = new WeakMap<Scene, SceneLods>();

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
  const settings = sceneRenderingSettings(binding.master.getScene());
  if (!settings.autoLod) {
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
  let lods = sceneLods.get(scene);
  if (lods) return lods;
  const state: SceneLods = { bindings: new Set(), masters: new WeakMap() };
  lods = state;
  sceneLods.set(scene, state);
  // Babylon consults the Scene selector on the classic path and in every
  // ObjectRenderer pass (FrameGraph, shadow maps, outline masks).
  scene.customLODSelector = (mesh, camera) => {
    const binding = state.masters.get(mesh);
    if (!binding) return mesh.getLOD(camera);
    const level = selectLevel(binding, camera, true);
    return level === 0 ? binding.master : binding.levels[level - 1]!.mesh;
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
    if (!levels?.length || master.geometry !== master.source!.geometry || !eligible(master)) continue;
    const scene = master.getScene();
    const state = lodsFor(scene);
    const binding: LodBinding = { master, levels: [], current: new WeakMap() };
    master.useLODScreenCoverage = true;
    for (const [index, level] of levels.entries()) {
      const lod = new Mesh(`${master.name} LOD${index + 1}`, scene);
      levelGeometry(master.source!, level, index).applyToMesh(lod);
      lod.subMeshes = [];
      for (const part of level.subMeshes)
        new SubMesh(part.materialIndex, part.verticesStart, part.verticesCount, part.indexStart, part.indexCount, lod);
      lod.parent = master;
      lod.isPickable = false;
      lod.hasVertexAlpha = master.hasVertexAlpha;
      lod.useVertexColors = master.useVertexColors;
      lod.numBoneInfluencers = master.numBoneInfluencers;
      lod.computeBonesUsingShaders = master.computeBonesUsingShaders;
      mirrorLodState(master, lod);
      if (master.skeleton?.needInitialSkinMatrix) lod.updatePoseMatrix(master.getPoseMatrix());
      master.addLODLevel(level.coverage, lod);
      binding.levels.push({ mesh: lod, coverage: level.coverage });
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
