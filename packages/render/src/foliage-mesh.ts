import "@babylonjs/core/Meshes/thinInstanceMesh";
import type { Camera } from "@babylonjs/core/Cameras/camera";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { Geometry } from "@babylonjs/core/Meshes/geometry";
import { InstancedMesh } from "@babylonjs/core/Meshes/instancedMesh";
import { SubMesh } from "@babylonjs/core/Meshes/subMesh";
import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { Observer } from "@babylonjs/core/Misc/observable";
import type { Scene } from "@babylonjs/core/scene";
import { FOLIAGE_FLOATS_PER_INSTANCE, foliageBatchInfos, foliageInstancesFingerprint, parseFoliageProperties, type FoliageBatch, type FoliageBatchInfo, type SerializedActor, type SerializedScene } from "@haptic/core";
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
import { applyWithSharedIndices, forgetLostIndexBuffer } from "./shared-index-buffer";
import { sceneRenderingSettings } from "./render-settings";
import { setShadowDistanceCulled } from "./shadow-caster-list";
import type { ModelLodSet } from "./model-lod";
import { setFoliageFadeRange } from "./foliage-fade";

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

/** A batch's authored distances, shared by its cells and rewritten in place by `applyFoliageDistances`. */
type FoliageDistances = { cullDistance: number; fadeRange: number; shadowDistance: number };

type FoliageCellRecord = {
  mesh: Mesh;
  sourceMesh: Mesh;
  distances: FoliageDistances;
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
  applyWithSharedIndices(target.geometry, cell.mesh);
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
    // No mesh draws it yet, so this uploads nothing: the first swap to the level shares its index buffer with every
    // other cell of the same source that drew the level (`applyWithSharedIndices`).
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
  // A level of detail no cell draws keeps the index buffer of the lost context, which Babylon does not rebuild.
  const engine = scene.getEngine();
  const restored = engine.onContextRestoredObservable.add(() => {
    for (const cell of state!.cells) {
      for (const lod of cell.lods) if (lod.geometry !== cell.mesh.geometry) forgetLostIndexBuffer(lod.geometry);
    }
  });
  scene.onDisposeObservable.addOnce(() => {
    if (state!.observer) {
      scene.onBeforeRenderObservable.remove(state!.observer);
      state!.observer = null;
    }
    engine.onContextRestoredObservable.remove(restored);
    state!.cells.clear();
  });
  foliageDistancesByScene.set(scene, state);
  return state;
}

const editorViews = new WeakSet<Scene>();

/**
 * Whether a cell of a batch with `distances` dither-fades, which compiles the fade into its variants: in a Play view,
 * with a Cull Distance and a Fade Range. Set as the cell is made and changed only by a distance edit, never by the
 * camera, so moving through foliage compiles nothing.
 */
function cellCanFade(distances: FoliageDistances, editorView: boolean): boolean {
  return !editorView && distances.cullDistance > 0 && distances.fadeRange > 0;
}

/**
 * Marks `scene` as an editor view (`EditorSceneSync`: the viewport and thumbnails): its foliage cells never distance-cull,
 * shadow-cull or fade, so a far overview shows every stroke and every cell can be selected. Levels of detail still swap.
 */
export function showEveryFoliageCell(scene: Scene): void {
  editorViews.add(scene);
  const state = foliageDistancesByScene.get(scene);
  if (state) state.dirty = true;
}

/**
 * Evaluate distance culling, readiness-safe shadow distance culling, Bayer dither fade bands,
 * and per-cell LOD geometry swaps for all `32x32` foliage cells in `scene`, from `camera`: the main camera of the
 * frame. Mirrors, probes and Render Target Captures draw what it chose.
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
  const showAll = editorViews.has(scene);

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
    const { cullDistance, fadeRange, shadowDistance } = cell.distances;
    const effectiveCull = cullDistance > 0 ? cullDistance * scale : 0;
    const effectiveShadow = shadowDistance > 0 ? shadowDistance * scale : effectiveCull;
    const effectiveFadeRange = fadeRange > 0 ? fadeRange * scale : 0;

    const withinCull = showAll || effectiveCull <= 0 || dist <= effectiveCull;
    if (cell.mesh.isEnabled(false) !== withinCull) {
      cell.mesh.setEnabled(withinCull);
    }

    setShadowDistanceCulled(cell.mesh, !showAll && (!withinCull || (effectiveShadow > 0 && dist > effectiveShadow)));

    // Only a cell that can fade compiles the fade (its discard); one in its band binds the range, rewritten in place.
    const fade = setFoliageFadeRange(cell.mesh, cellCanFade(cell.distances, showAll));
    if (fade) {
      const fadeStart = Math.max(0, effectiveCull - effectiveFadeRange);
      const fading = withinCull && effectiveCull > 0 && effectiveFadeRange > 0 && centerDist + radius >= fadeStart;
      fade[0] = fading ? fadeStart : 0;
      fade[1] = fading ? effectiveCull : 0;
    }

    if (withinCull && cell.lods.length > 1) {
      const targetLod = autoLod
        ? pickFoliageLodIndex(dist, effectiveCull, scale, cell.lods.length, cell.activeLod)
        : 0;
      applyCellLod(cell, targetLod);
    }
  }
}

const reportedLodFailures = new WeakMap<Scene, Set<string>>();

/** Warns once per Scene and Model that its foliage keeps full detail, as the Model cache reports a failed generation. */
function reportFoliageLodFailure(scene: Scene, modelGuid: string, error: unknown): void {
  let reported = reportedLodFailures.get(scene);
  if (!reported) reportedLodFailures.set(scene, (reported = new Set()));
  if (reported.has(modelGuid)) return;
  reported.add(modelGuid);
  console.warn(`[render] Model ${modelGuid} foliage keeps full detail; attaching its levels of detail failed: ${String(error)}`);
}

const preparations = new WeakMap<Mesh, Promise<void>>();
const batchesByRoot = new WeakMap<Mesh, Array<{ root: Mesh; batch: FoliageBatch }>>();
/** Each parsed batch's distances, by batch index, for a foliage root. */
const distancesByRoot = new WeakMap<Mesh, FoliageDistances[]>();

export function foliagePreparation(root: Mesh): Promise<void> | undefined { return preparations.get(root); }

type FoliageSummary = { json: string; models: readonly string[]; distances: readonly FoliageDistances[] };
const summaries = new WeakMap<object, FoliageSummary>();

/**
 * Fingerprint and distinct model guids, computed once per properties object.
 * The fingerprint names the instances by `foliageInstancesFingerprint` (a hash
 * of the encoded chunk or its id) and never serializes them.
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
  const batches = foliageBatchInfos(properties);
  const groupId = (properties as { groupId?: unknown } | null)?.groupId;
  const summary = {
    json: JSON.stringify({
      groupId: typeof groupId === "string" ? groupId : "",
      batches: batches.map((batch) => ({ modelGuid: batch.modelGuid, materialGuid: batch.materialGuid })),
      instances: foliageInstancesFingerprint(properties),
    }),
    models: [...new Set(batches.map((batch) => batch.modelGuid))],
    distances: batches.map(distancesOf),
  };
  if (memo) summaries.set(memo, summary);
  return summary;
}

const DISTANCE_KEYS = ["cullDistance", "fadeRange", "shadowDistance"] as const;

function distancesOf(batch: FoliageBatchInfo): FoliageDistances {
  return { cullDistance: batch.cullDistance, fadeRange: batch.fadeRange, shadowDistance: batch.shadowDistance };
}

/**
 * The authored foliage without the batches' Cull Distance, Fade Range and Shadow Distance: any other edit of the
 * authored foliage changes it and rebuilds the visual; a distance edit applies to its cells in place.
 */
export function foliagePropertiesFingerprint(properties: unknown): string {
  return foliageSummary(properties).json;
}

/**
 * Applies the batches' Cull Distance, Fade Range and Shadow Distance of `properties` to the foliage `root` built from
 * properties that differ at most in those values (`foliagePropertiesFingerprint`), including cells still preparing.
 */
export function applyFoliageDistances(root: Mesh, properties: unknown): void {
  const live = distancesByRoot.get(root);
  if (!live) return;
  const next = foliageSummary(properties).distances;
  let changed = false;
  for (let index = 0; index < live.length; index++) {
    const target = live[index]!, source = next[index];
    if (!source) continue;
    for (const key of DISTANCE_KEYS) {
      if (target[key] === source[key]) continue;
      target[key] = source[key];
      changed = true;
    }
  }
  const state = changed ? foliageDistancesByScene.get(root.getScene()) : undefined;
  if (state) state.dirty = true;
}

/**
 * True when two scenes differ at most in Foliage distances: the batches' (applied in place, `applyFoliageDistances`) and
 * the Foliage Groups' Models' (read by the next stroke). Nothing else changes, so no visual rebuilds and no shader
 * variant changes. Unchanged actors keep their identity; a changed one compares its Foliage components by
 * `foliagePropertiesFingerprint`, which each apply computes once per properties object anyway.
 */
export function isFoliageDistanceOnlySceneEdit(previous: SerializedScene | null, next: SerializedScene): boolean {
  if (!previous || previous === next || previous.actors.length !== next.actors.length) return false;
  const actorShape = (actor: SerializedActor) => JSON.stringify({
    ...actor,
    components: actor.components.map((component) => component.classId === "FoliageComponent"
      ? { ...component, properties: foliagePropertiesFingerprint(component.properties) }
      : component),
  });
  for (let index = 0; index < next.actors.length; index++) {
    const before = previous.actors[index]!, after = next.actors[index]!;
    if (before !== after && actorShape(before) !== actorShape(after)) return false;
  }
  const sceneShape = (scene: SerializedScene) => JSON.stringify({
    ...scene,
    actors: undefined,
    settings: {
      ...scene.settings,
      foliageGroups: scene.settings.foliageGroups?.map((group) => ({
        ...group,
        models: group.models.map((model) => {
          const rest: Record<string, unknown> = { ...model };
          for (const key of DISTANCE_KEYS) delete rest[key];
          return rest;
        }),
      })),
    },
  });
  return sceneShape(previous) === sceneShape(next);
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

/** Scratch for composing instance matrices from a batch's floats. */
const composeScale = new Vector3();
const composeRotation = new Quaternion();
const composePosition = new Vector3();
const composeInstance = new Matrix();

/**
 * Thin-instance attributes belong to Geometry, so every cell needs its own. It borrows the source's vertex buffers
 * and draws the index buffer every cell of the source shares.
 */
function isolateFoliageGeometry(mesh: Mesh, source: Mesh): void {
  const geometry = new Geometry(mesh.name, mesh.getScene());
  const total = source.getTotalVertices();
  for (const buffer of Object.values(source.geometry!.getVertexBuffers() ?? {})) {
    geometry.setVerticesBuffer(sharedVertexBuffer(buffer), total);
  }
  geometry.setIndices(source.getIndices() ?? [], total);
  applyWithSharedIndices(geometry, mesh);
  mesh.releaseSubMeshes();
  for (const subMesh of source.subMeshes) subMesh.clone(mesh);
}

/** One thin-instance draw per model primitive/material/spatial cell; never one actor per plant. */
export function createFoliageMesh(scene: Scene, name: string, properties: unknown, assets?: MeshAssetContext): Mesh {
  const data = parseFoliageProperties(properties);
  if (data.unreadable) console.warn(`[render] Foliage ${name} has instance data that could not be read; it draws nothing.`);
  const root = new Mesh(name, scene);
  root.isPickable = false;
  const bundle = new VisualBundle();
  const batches: Array<{ root: Mesh; batch: FoliageBatch }> = [];
  batchesByRoot.set(root, batches);
  const distances = data.batches.map(distancesOf);
  distancesByRoot.set(root, distances);
  let cancel!: (reason: Error) => void;
  const cancellation = new Promise<never>((_resolve, reject) => { cancel = reject; });
  void cancellation.catch(() => {});
  root.onDisposeObservable.addOnce(() => {
    cancel(new Error("Foliage preparation cancelled"));
    bundle.dispose();
  });
  const ready = (async () => {
    const distanceState = foliageDistanceState(scene);
    const lodPending: Array<{ modelGuid: string; loadLods: () => Promise<ModelLodSet | null>; cells: FoliageCellRecord[] }> = [];
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
      // Instance indices by 32 m spatial cell, read straight from the batch's floats.
      const transforms = batch.transforms;
      // Found by column and row, so an instance names nothing; a cell is named once, in the order cells first appear.
      const cells = new Map<string, number[]>();
      const columns = new Map<number, Map<number, number[]>>();
      for (let instance = 0, at = 0; at < transforms.length; instance++, at += FOLIAGE_FLOATS_PER_INSTANCE) {
        const cellX = Math.floor(transforms[at]! / 32), cellZ = Math.floor(transforms[at + 2]! / 32);
        let column = columns.get(cellX);
        if (!column) columns.set(cellX, (column = new Map()));
        const cell = column.get(cellZ);
        if (cell) cell.push(instance);
        else {
          const created = [instance];
          column.set(cellZ, created);
          cells.set(`${cellX}:${cellZ}`, created);
        }
      }
      const batchCellRecords: FoliageCellRecord[] = [];
      for (const sourceMesh of container.meshes) {
        const geometry = sourceMesh instanceof InstancedMesh ? sourceMesh.sourceMesh : sourceMesh;
        if (!(geometry instanceof Mesh) || !geometry.getTotalVertices()) continue;
        const modelMatrix = sourceMesh.computeWorldMatrix(true).multiply(Matrix.Scaling(scale, scale, scale));
        for (const [cell, instances] of cells) {
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
          // Fade capability from the start, so the load's warm-up compiles the variant the cell draws with.
          mesh.metadata = { foliageRoot: root, hapticFoliageFade: cellCanFade(distances[batchIndex]!, editorViews.has(scene)) ? [0, 0] : null };
          const matrices = new Float32Array(instances.length * 16);
          for (let i = 0; i < instances.length; i++) {
            const at = instances[i]! * FOLIAGE_FLOATS_PER_INSTANCE;
            composeScale.set(transforms[at + 7]!, transforms[at + 8]!, transforms[at + 9]!);
            composeRotation.set(transforms[at + 3]!, transforms[at + 4]!, transforms[at + 5]!, transforms[at + 6]!);
            composePosition.set(transforms[at]!, transforms[at + 1]!, transforms[at + 2]!);
            Matrix.ComposeToRef(composeScale, composeRotation, composePosition, composeInstance);
            modelMatrix.multiplyToArray(composeInstance, matrices, i * 16);
          }
          mesh.thinInstanceSetBuffer("matrix", matrices, 16, true);
          mesh.thinInstanceRefreshBoundingInfo(true);
          // A cell's instances are final: a view that does not see its bounds draws none of them.
          markBoundsHoldInstances(mesh);
          const record: FoliageCellRecord = {
            mesh,
            sourceMesh: geometry,
            distances: distances[batchIndex]!,
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
        lodPending.push({ modelGuid: batch.modelGuid, loadLods: () => lease.lods(), cells: batchCellRecords });
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
        }).catch((error: unknown) => {
          // Generation failures were reported by the Model's cache (`lods()` settles null); this is the cells' attach.
          if (!root.isDisposed()) reportFoliageLodFailure(scene, pending.modelGuid, error);
        });
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
