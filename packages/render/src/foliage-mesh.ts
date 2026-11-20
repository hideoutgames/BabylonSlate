import "@babylonjs/core/Meshes/thinInstanceMesh";
import type { Camera } from "@babylonjs/core/Cameras/camera";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { Geometry } from "@babylonjs/core/Meshes/geometry";
import { InstancedMesh } from "@babylonjs/core/Meshes/instancedMesh";
import { SubMesh } from "@babylonjs/core/Meshes/subMesh";
import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { Observer } from "@babylonjs/core/Misc/observable";
import type { Scene } from "@babylonjs/core/scene";
import { parseFoliageProperties, type FoliageBatch } from "@haptic/core";
import type { MeshAssetContext } from "./mesh-assets";
import { acquireGlbContainer, prepareInstanceMaterials } from "./glb-anim";
import { installAssetBytes } from "@haptic/assets";
import { applyModelMaterialSlots } from "./model-preview";
import { RENDERING_GROUP } from "./sorting";
import { assetByteFingerprint } from "./asset-byte-fingerprint";
import { VisualBundle } from "./visual-bundle";
import { applyMaterialBounds } from "./material-bounds";
import { markBoundsHoldInstances } from "./play-view-culling";
import { sharedVertexBuffer } from "./shared-vertex-buffer";
import { sceneRenderingSettings } from "./render-settings";
import type { ModelLodSet } from "./model-lod";
import "./foliage-fade";

type SubMeshSpec = {
  materialIndex: number;
  verticesStart: number;
  verticesCount: number;
  indexStart: number;
  indexCount: number;
};

type FoliageCellLod = {
  geometry: Geometry;
  subMeshes: SubMeshSpec[];
};

type FoliageCellRecord = {
  mesh: Mesh;
  sourceMesh: Mesh;
  cullDistance: number;
  fadeRange: number;
  shadowDistance: number;
  lods: FoliageCellLod[];
  activeLod: number;
};

type FoliageDistanceState = {
  cells: Set<FoliageCellRecord>;
  observer: Observer<Scene> | null;
  lastCamX: number;
  lastCamY: number;
  lastCamZ: number;
  lastScale: number;
  lastAutoLod: boolean;
  dirty: boolean;
};

const foliageDistancesByScene = new WeakMap<Scene, FoliageDistanceState>();
const CAMERA_MOVE_THRESHOLD_SQ = 0.25; // 0.5 m
const LOD_HYSTERESIS = 0.05;

function snapshotSubMeshes(mesh: Mesh): SubMeshSpec[] {
  return mesh.subMeshes.map((sub) => ({
    materialIndex: sub.materialIndex,
    verticesStart: sub.verticesStart,
    verticesCount: sub.verticesCount,
    indexStart: sub.indexStart,
    indexCount: sub.indexCount,
  }));
}

function applyCellLod(cell: FoliageCellRecord, levelIndex: number): void {
  if (levelIndex === cell.activeLod || cell.mesh.isDisposed()) return;
  const target = cell.lods[levelIndex];
  if (!target) return;
  const savedBounds = cell.mesh.getBoundingInfo();
  target.geometry.applyToMesh(cell.mesh);
  cell.mesh.releaseSubMeshes();
  for (const spec of target.subMeshes) {
    new SubMesh(spec.materialIndex, spec.verticesStart, spec.verticesCount, spec.indexStart, spec.indexCount, cell.mesh);
  }
  // Keep the full-instance bounding box/sphere computed when the cell's thin instances were uploaded.
  cell.mesh.setBoundingInfo(savedBounds);
  cell.activeLod = levelIndex;
}

function attachCellLods(cell: FoliageCellRecord, lodSet: ModelLodSet): void {
  if (cell.mesh.isDisposed() || cell.lods.length > 1) return;
  const levels = lodSet.levelsFor(cell.sourceMesh);
  if (!levels?.length) return;
  const baseGeometry = cell.lods[0]!.geometry;
  const scene = cell.mesh.getScene();
  const totalVertices = baseGeometry.getTotalVertices();
  const baseBuffers = Object.values(baseGeometry.getVertexBuffers() ?? {});
  for (let i = 0; i < levels.length; i += 1) {
    const level = levels[i]!;
    const geometry = new Geometry(`${cell.mesh.name}:lod${i + 1}`, scene);
    for (const buffer of baseBuffers) {
      geometry.setVerticesBuffer(sharedVertexBuffer(buffer), totalVertices);
    }
    geometry.setIndices(level.data.indices, totalVertices);
    cell.lods.push({
      geometry,
      subMeshes: level.data.subMeshes.map((sub) => ({
        materialIndex: sub.materialIndex,
        verticesStart: sub.verticesStart,
        verticesCount: sub.verticesCount,
        indexStart: sub.indexStart,
        indexCount: sub.indexCount,
      })),
    });
  }
}

/** Attach a resolved `ModelLodSet` to every registered foliage cell matching its source meshes. */
export function attachFoliageLodSet(scene: Scene, lodSet: ModelLodSet): void {
  const state = foliageDistancesByScene.get(scene);
  if (!state) return;
  for (const cell of state.cells) attachCellLods(cell, lodSet);
  state.dirty = true;
  updateFoliageDistances(scene, scene.activeCamera, true);
}

function pickFoliageLodIndex(
  dist: number,
  effectiveCull: number,
  lodDistanceScale: number,
  lodCount: number,
  previous: number,
): number {
  if (lodCount <= 1) return 0;
  const span = effectiveCull > 0 ? effectiveCull : 120 * lodDistanceScale;
  const thresholds = lodCount === 2
    ? [span * 0.45]
    : [span * 0.35, span * 0.65];
  let level = 0;
  for (let i = 0; i < thresholds.length && i + 1 < lodCount; i += 1) {
    const base = thresholds[i]!;
    const threshold = previous > i ? base * (1 - LOD_HYSTERESIS) : base * (1 + LOD_HYSTERESIS);
    if (dist >= threshold) level = i + 1;
  }
  return level;
}

function foliageDistanceState(scene: Scene): FoliageDistanceState {
  let state = foliageDistancesByScene.get(scene);
  if (state) return state;
  state = {
    cells: new Set(),
    observer: null,
    lastCamX: Number.NaN,
    lastCamY: Number.NaN,
    lastCamZ: Number.NaN,
    lastScale: Number.NaN,
    lastAutoLod: true,
    dirty: true,
  };
  state.observer = scene.onBeforeRenderObservable.add(() => {
    updateFoliageDistances(scene);
  });
  scene.onDisposeObservable.addOnce(() => {
    if (state!.observer) {
      scene.onBeforeRenderObservable.remove(state!.observer);
      state!.observer = null;
    }
    state!.cells.clear();
  });
  foliageDistancesByScene.set(scene, state);
  return state;
}

/**
 * Evaluate distance culling, readiness-safe shadow distance culling, Bayer dither fade bands,
 * and per-cell LOD geometry swaps for all `32x32` foliage cells in `scene`.
 */
export function updateFoliageDistances(
  scene: Scene,
  camera: Camera | null = scene.activeCamera,
  force = false,
): void {
  const state = foliageDistancesByScene.get(scene);
  if (!state || state.cells.size === 0 || !camera) return;
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

  for (const cell of state.cells) {
    if (cell.mesh.isDisposed()) {
      state.cells.delete(cell);
      continue;
    }
    const sphere = cell.mesh.getBoundingInfo().boundingSphere;
    const center = sphere.centerWorld;
    const radius = sphere.radiusWorld;
    const centerDist = Vector3.Distance(cam, center);
    const dist = Math.max(0, centerDist - radius);
    const effectiveCull = cell.cullDistance > 0 ? cell.cullDistance * scale : 0;
    const effectiveShadow = cell.shadowDistance > 0 ? cell.shadowDistance * scale : effectiveCull;
    const effectiveFadeRange = cell.fadeRange > 0 ? cell.fadeRange * scale : 0;

    const withinCull = effectiveCull <= 0 || dist <= effectiveCull;
    if (cell.mesh.isEnabled(false) !== withinCull) {
      cell.mesh.setEnabled(withinCull);
    }

    const shadowCulled = !withinCull || (effectiveShadow > 0 && dist > effectiveShadow);
    const metadata = (cell.mesh.metadata ?? (cell.mesh.metadata = {})) as Record<string, unknown>;
    if (metadata.hapticShadowDistanceCulled !== shadowCulled) {
      metadata.hapticShadowDistanceCulled = shadowCulled;
    }

    if (withinCull && effectiveCull > 0 && effectiveFadeRange > 0) {
      const fadeStart = Math.max(0, effectiveCull - effectiveFadeRange);
      if (centerDist + radius >= fadeStart) {
        metadata.hapticFoliageFade = [fadeStart, effectiveCull];
      } else if (metadata.hapticFoliageFade !== null) {
        metadata.hapticFoliageFade = null;
      }
    } else if (metadata.hapticFoliageFade !== null) {
      metadata.hapticFoliageFade = null;
    }

    if (withinCull && cell.lods.length > 1) {
      const targetLod = autoLod
        ? pickFoliageLodIndex(dist, effectiveCull, scale, cell.lods.length, cell.activeLod)
        : 0;
      applyCellLod(cell, targetLod);
    }
  }
}

const preparations = new WeakMap<Mesh, Promise<void>>();
const batchesByRoot = new WeakMap<Mesh, Array<{ root: Mesh; batch: FoliageBatch }>>();

export function foliagePreparation(root: Mesh): Promise<void> | undefined { return preparations.get(root); }

type FoliageSummary = { json: string; models: readonly string[] };
const summaries = new WeakMap<object, FoliageSummary>();

/**
 * Serialized properties and distinct model guids, computed once per properties
 * object, so an unchanged component does not re-serialize up to
 * MAX_FOLIAGE_INSTANCES transforms on every apply.
 *
 * Contract: the memo is keyed on object identity, so hosts must replace a
 * Foliage component's properties (and the batches inside) rather than mutate
 * them in place; an in-place edit would keep the old summary and the visual
 * would not rebuild. The existing hosts do: the scene property command spreads
 * (`withProperty`), `appendFoliageInstance` and the erase brush return new
 * objects, and overlay layout copies every component's properties.
 */
function foliageSummary(properties: unknown): FoliageSummary {
  const memo = properties !== null && typeof properties === "object" ? properties : null;
  const cached = memo ? summaries.get(memo) : undefined;
  if (cached) return cached;
  const summary = {
    json: JSON.stringify(properties),
    models: [...new Set(parseFoliageProperties(properties).batches.map((batch) => batch.modelGuid))],
  };
  if (memo) summaries.set(memo, summary);
  return summary;
}

/** Equals `JSON.stringify(properties)`: any edit of the authored foliage changes it. */
export function foliagePropertiesFingerprint(properties: unknown): string {
  return foliageSummary(properties).json;
}

export function foliageSourceFingerprint(properties: unknown, assets?: MeshAssetContext): string {
  return foliageSummary(properties).models.map((guid) => {
    const source = assets?.modelSources?.get(guid) ?? assets?.modelBytes?.get(guid);
    return `${guid}:${source ? assetByteFingerprint(source) : "missing"}:${assets?.modelPayloads?.get(guid)?.importScale ?? 1}`;
  }).join("|");
}

export function refreshFoliageMaterials(root: Mesh, assets?: MeshAssetContext): void {
  for (const entry of batchesByRoot.get(root) ?? []) {
    const payload = assets?.modelPayloads?.get(entry.batch.modelGuid);
    const resolve = (guid: string) => assets?.resolveMaterial?.(guid, { scene: root.getScene() }) ?? null;
    applyModelMaterialSlots(entry.root, payload?.materialSlots ?? [], resolve);
    const override = entry.batch.materialGuid ? resolve(entry.batch.materialGuid) : null;
    if (override) for (const mesh of entry.root.getChildMeshes()) {
      mesh.material = override;
      applyMaterialBounds(mesh);
    }
  }
}

/** Thin-instance attributes belong to Geometry, so every cell needs its own. */
function isolateFoliageGeometry(mesh: Mesh, source: Mesh): void {
  const geometry = new Geometry(mesh.name, mesh.getScene());
  const total = source.getTotalVertices();
  for (const buffer of Object.values(source.geometry!.getVertexBuffers() ?? {})) {
    geometry.setVerticesBuffer(sharedVertexBuffer(buffer), total);
  }
  geometry.setIndices(source.getIndices() ?? [], total);
  geometry.applyToMesh(mesh);
  mesh.releaseSubMeshes();
  for (const subMesh of source.subMeshes) subMesh.clone(mesh);
}

/** One thin-instance draw per model primitive/material/spatial cell; never one actor per plant. */
export function createFoliageMesh(scene: Scene, name: string, properties: unknown, assets?: MeshAssetContext): Mesh {
  const data = parseFoliageProperties(properties);
  const root = new Mesh(name, scene);
  root.isPickable = false;
  const bundle = new VisualBundle();
  const batches: Array<{ root: Mesh; batch: FoliageBatch }> = [];
  batchesByRoot.set(root, batches);
  let cancel!: (reason: Error) => void;
  const cancellation = new Promise<never>((_resolve, reject) => { cancel = reject; });
  void cancellation.catch(() => {});
  root.onDisposeObservable.addOnce(() => {
    cancel(new Error("Foliage preparation cancelled"));
    bundle.dispose();
  });
  const ready = (async () => {
    const distanceState = foliageDistanceState(scene);
    const lodPending: Array<{ loadLods: () => Promise<ModelLodSet | null>; cells: FoliageCellRecord[] }> = [];
    for (const [batchIndex, batch] of data.batches.entries()) {
      if (root.isDisposed()) return;
      const bytes = assets?.modelBytes?.get(batch.modelGuid);
      const source = assets?.modelSources?.get(batch.modelGuid) ?? (bytes ? installAssetBytes(bytes, "model/gltf-binary") : undefined);
      if (!source) continue;
      const lease = acquireGlbContainer(scene, batch.modelGuid, source);
      bundle.releaseWith(() => lease.release());
      const container = await lease.load;
      if (root.isDisposed()) return;
      const batchRoot = new Mesh(`${name}:batch:${batchIndex}`, scene);
      batchRoot.parent = root;
      batchRoot.setEnabled(false);
      batchRoot.isPickable = false;
      batches.push({ root: batchRoot, batch });
      const scale = assets?.modelPayloads?.get(batch.modelGuid)?.importScale ?? 1;
      const cells = new Map<string, typeof batch.transforms>();
      for (const transform of batch.transforms) {
        const key = `${Math.floor(transform.position[0] / 32)}:${Math.floor(transform.position[2] / 32)}`;
        const cell = cells.get(key) ?? [];
        cell.push(transform); cells.set(key, cell);
      }
      const batchCellRecords: FoliageCellRecord[] = [];
      for (const sourceMesh of container.meshes) {
        const geometry = sourceMesh instanceof InstancedMesh ? sourceMesh.sourceMesh : sourceMesh;
        if (!(geometry instanceof Mesh) || !geometry.getTotalVertices()) continue;
        const modelMatrix = sourceMesh.computeWorldMatrix(true).multiply(Matrix.Scaling(scale, scale, scale));
        for (const [cell, transforms] of cells) {
          const mesh = geometry.clone(`${name}:foliage:${batchIndex}:${sourceMesh.uniqueId}:${cell}`, batchRoot, true);
          bundle.ownRenderUser(mesh);
          isolateFoliageGeometry(mesh, geometry);
          mesh.position.setAll(0); mesh.rotation.setAll(0); mesh.rotationQuaternion = Quaternion.Identity(); mesh.scaling.setAll(1);
          mesh.skeleton = null; mesh.morphTargetManager = null;
          mesh.setEnabled(true); mesh.isVisible = true; mesh.visibility = 1;
          mesh.renderingGroupId = RENDERING_GROUP.world;
          mesh.receiveShadows = true;
          mesh.isPickable = true;
          mesh.thinInstanceEnablePicking = true;
          mesh.metadata = { foliageRoot: root, hapticShadowDistanceCulled: false, hapticFoliageFade: null };
          const matrices = new Float32Array(transforms.length * 16);
          transforms.forEach((transform, i) => {
            modelMatrix.multiply(Matrix.Compose(Vector3.FromArray(transform.scale), Quaternion.FromArray(transform.rotation), Vector3.FromArray(transform.position))).copyToArray(matrices, i * 16);
          });
          mesh.thinInstanceSetBuffer("matrix", matrices, 16, true);
          mesh.thinInstanceRefreshBoundingInfo(true);
          // A cell's instances are final: a view that does not see its bounds draws none of them.
          markBoundsHoldInstances(mesh);
          const record: FoliageCellRecord = {
            mesh,
            sourceMesh: geometry,
            cullDistance: batch.cullDistance,
            fadeRange: batch.fadeRange,
            shadowDistance: batch.shadowDistance,
            lods: [{ geometry: mesh.geometry!, subMeshes: snapshotSubMeshes(mesh) }],
            activeLod: 0,
          };
          distanceState.cells.add(record);
          distanceState.dirty = true;
          batchCellRecords.push(record);
          mesh.onDisposeObservable.addOnce(() => {
            distanceState.cells.delete(record);
            for (const entry of record.lods) {
              if (entry.geometry !== mesh.geometry && !entry.geometry.isDisposed()) {
                entry.geometry.dispose();
              }
            }
          });
        }
      }
      if (batchCellRecords.length > 0) {
        lodPending.push({ loadLods: () => lease.lods(), cells: batchCellRecords });
      }
    }
    if (root.isDisposed()) return;
    refreshFoliageMaterials(root, assets);
    await prepareInstanceMaterials(root, () => {
      if (root.isDisposed()) throw new Error("Foliage preparation cancelled");
    }, cancellation);
    if (!root.isDisposed()) {
      for (const entry of batches) entry.root.setEnabled(true);
      updateFoliageDistances(scene, scene.activeCamera, true);
      // Automatic LOD levels attach asynchronously without blocking initial foliage publishing.
      for (const pending of lodPending) {
        void pending.loadLods().then((lodSet) => {
          if (!lodSet || root.isDisposed()) return;
          for (const cell of pending.cells) attachCellLods(cell, lodSet);
          distanceState.dirty = true;
          updateFoliageDistances(scene, scene.activeCamera, true);
        }).catch(() => {});
      }
    }
  })().catch((error: unknown) => {
    // Releasing the last lease during deletion can retire an in-flight decode.
    if (!root.isDisposed()) throw error;
  });
  preparations.set(root, ready);
  void ready.catch(() => {});
  return root;
}
