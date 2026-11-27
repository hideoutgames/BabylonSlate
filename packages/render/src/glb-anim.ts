import "./gltf-loader";
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import type { Material } from "@babylonjs/core/Materials/material";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { AssetContainer, InstantiatedEntries } from "@babylonjs/core/assetContainer";
import type { Node } from "@babylonjs/core/node";
import { MultiMaterial } from "@babylonjs/core/Materials/multiMaterial";
import { NodeMaterial } from "@babylonjs/core/Materials/Node/nodeMaterial";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { InstancedMesh } from "@babylonjs/core/Meshes/instancedMesh";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { loadModelContainer, parentContainerRoots } from "./model-container";
import { hasEngineGlbBlueprint, materializeEngineGlbBlueprint, rememberEngineGlbBlueprint } from "./glb-geometry-handover";
import { Scene } from "@babylonjs/core/scene";
import { installedAssetIdentity, normalizeModelImportScale } from "@haptic/assets";
import { applyAnimStateToScene, sceneAnimHostFromBinding } from "./anim-apply";
import { bindPoseClip, type PoseClip, type PoseClipSource } from "./anim-pose";
import { isGltfModelBytes } from "./model-mesh";
import {
  bindAnimationGroupByName,
  buildAnimationTargetLookup,
  retargetAnimationGroupWithMeshProxy,
  type AnimationTargetLookup,
} from "./node-rig";
import type { SnapshotSceneBinding } from "./snapshot-apply";
import { RENDERING_GROUP } from "./sorting";
import { accountedGeometryBytes } from "./perf-ceilings";
import { poolModelLeaves } from "./pooled-model-leaves";
import { VisualBundle } from "./visual-bundle";
import { registerModelOccluder } from "./view-occlusion";
import { ownedMaterialPreparation } from "./material-library";
import { prewarmMaterial } from "./material-compiler";
import { createHeldThreadBudget, createStallDeadline, SCENE_SHADER_WARM_TIMEOUT_MS } from "./stall-deadline";
import { DriverCompileWatch } from "./driver-compile";
import { drawnMaterialVariants } from "./drawn-variants";
import { attachModelLods, generateModelLods, type ModelLodSet } from "./model-lod";
import { nativePreparationForEngine, type NativePreparationPriority } from "./native-preparation";

/**
 * Fields `beginSlotModelAnimLoad` mutates. Play passes the full snapshot
 * binding; the editor scene-loader can pass a stub without lights/cameras.
 */
export type ModelAnimLoadBinding = Pick<
  SnapshotSceneBinding,
  | "slotAnimEpoch"
  | "slotPoseClips"
  | "slotAnimLoads"
  | "pendingAnimState"
  | "slotAnimReady"
  | "modelBytes"
  | "modelSources"
  | "modelPayloads"
  | "modelClipAnimationGuids"
  | "retargetAnimationLoads"
  | "spritePayloads"
>;

const MODEL_PLACEHOLDER_KEY = "editorModelPlaceholder";
const MODEL_INSTANCE_KEY = "hapticModelInstance";
const MODEL_LOAD_KEY = "hapticModelLoadKey";
export const MODEL_IMPORT_SCALE_NODE_NAME = "__importScale";

type ModelPlaceholderMeta = {
  disposeModelOnDespawn?: boolean;
  [MODEL_PLACEHOLDER_KEY]?: boolean;
  [MODEL_INSTANCE_KEY]?: PreparedModelInstance;
  [MODEL_LOAD_KEY]?: string;
};

type CachedGlb = {
  /** Model bytes identity; generated LOD indices are shared across Scenes by it. */
  key: string;
  guid: string;
  references: number;
  retired: boolean;
  accounted: number;
  container?: AssetContainer;
  load: Promise<AssetContainer>;
  controller: AbortController;
  /** Automatic LOD levels, generated once when an Auto LOD actor first needs them. */
  lods?: Promise<ModelLodSet | null>;
  lodSet?: ModelLodSet;
};

type SceneGlbCache = {
  loadCount: number;
  accountedBytes: number;
  entries: Map<string, CachedGlb>;
  requested: Map<string, string>;
  current: Map<string, CachedGlb>;
  disposed: boolean;
};

const glbCaches = new WeakMap<Scene, SceneGlbCache>();
const pendingModelLoads = new WeakMap<AbstractMesh, {
  key: string;
  promise: Promise<void>;
  isCurrent: () => boolean;
  cancel: () => void;
}>();
const slotLoadCancellations = new WeakMap<ModelAnimLoadBinding, Map<number, () => void>>();
const bundleOwnedClips = new WeakSet<PoseClip>();

function cacheFor(scene: Scene): SceneGlbCache {
  let cache = glbCaches.get(scene);
  if (!cache) {
    cache = { loadCount: 0, accountedBytes: 0, entries: new Map(), requested: new Map(), current: new Map(), disposed: false };
    glbCaches.set(scene, cache);
    scene.onDisposeObservable.addOnce(() => {
      cache!.disposed = true;
      for (const entry of cache!.entries.values()) retireSource(cache!, entry);
      cache!.entries.clear();
      cache!.requested.clear();
      cache!.current.clear();
      cache!.accountedBytes = 0;
    });
  }
  return cache;
}

function accountedAssetContainerGeometry(container: AssetContainer): number {
  let total = 0;
  // Unique buffers: glTF InstancedMesh parts share their source geometry.
  for (const geometry of container.geometries) {
    total += accountedGeometryBytes(geometry.getTotalVertices(), geometry.getTotalIndices());
  }
  return total;
}

/** Accounted GPU vertex+index bytes for GLB containers cached on this Scene. */
export function accountedGeometryBytesForScene(scene: Scene): number {
  return glbCaches.get(scene)?.accountedBytes ?? 0;
}

/** Count of `LoadAssetContainerAsync` calls for this Scene (cache misses). Test seam: production code does not call it. */
export function glbContainerLoadCount(scene: Scene): number {
  return glbCaches.get(scene)?.loadCount ?? 0;
}

function modelSourceKey(guid: string, source: Blob): string {
  return `${guid}:${installedAssetIdentity(source)}`;
}

/** Child of the actor placeholder so scene TRS and import scale stay independent. */
function applyModelImportScale(
  placeholder: AbstractMesh,
  scale: number,
): TransformNode {
  let wrapper = placeholder
    .getChildTransformNodes(true)
    .find((node) => node.name === MODEL_IMPORT_SCALE_NODE_NAME);
  if (!wrapper) {
    wrapper = new TransformNode(MODEL_IMPORT_SCALE_NODE_NAME, placeholder.getScene());
    wrapper.parent = placeholder;
  }
  const next = normalizeModelImportScale(scale);
  wrapper.scaling.set(next, next, next);
  return wrapper;
}

function asPlaceholderMeta(mesh: AbstractMesh): ModelPlaceholderMeta {
  const current =
    mesh.metadata && typeof mesh.metadata === "object"
      ? (mesh.metadata as ModelPlaceholderMeta)
      : {};
  mesh.metadata = current;
  return current;
}

export function isEditorModelPlaceholder(mesh: AbstractMesh): boolean {
  return Boolean(
    (mesh.metadata as ModelPlaceholderMeta | null)?.[MODEL_PLACEHOLDER_KEY],
  );
}

export function hideModelPlaceholder(placeholder: AbstractMesh): void {
  placeholder.visibility = 0;
  placeholder.isVisible = false;
  placeholder.isPickable = false;
}

/** Empty named transform root. Snapshot TRS and gizmos attach here; glTF parts instantiate under it. */
export function createModelActorRoot(scene: Scene, name: string): Mesh {
  const mesh = new Mesh(name, scene);
  asPlaceholderMeta(mesh)[MODEL_PLACEHOLDER_KEY] = true;
  hideModelPlaceholder(mesh);
  mesh.renderingGroupId = RENDERING_GROUP.world;
  return mesh;
}

function bumpSlotAnimEpoch(
  binding: ModelAnimLoadBinding,
  slotId: number,
): number {
  slotLoadCancellations.get(binding)?.get(slotId)?.();
  if (!binding.slotAnimEpoch) binding.slotAnimEpoch = new Map();
  const next = (binding.slotAnimEpoch.get(slotId) ?? 0) + 1;
  binding.slotAnimEpoch.set(slotId, next);
  return next;
}

function disposeSlotPoseClips(
  binding: ModelAnimLoadBinding,
  slotId: number,
): void {
  for (const clip of binding.slotPoseClips?.get(slotId) ?? []) {
    if (!bundleOwnedClips.has(clip)) clip.dispose?.();
  }
  binding.slotPoseClips?.delete(slotId);
}

/** Cancel in-flight GLB animation loads and dispose the slot's registered clips. */
export function invalidateSlotAnimLoad(
  binding: ModelAnimLoadBinding,
  slotId: number,
): void {
  bumpSlotAnimEpoch(binding, slotId);
  binding.slotAnimLoads?.delete(slotId);
  disposeSlotPoseClips(binding, slotId);
}

function replayPendingAnimState(
  binding: ModelAnimLoadBinding,
  slotId: number,
): void {
  const pending = binding.pendingAnimState?.get(slotId);
  if (!pending) return;
  applyAnimStateToScene(
    sceneAnimHostFromBinding(binding as SnapshotSceneBinding, {
      spritePayloads: binding.spritePayloads,
    }),
    pending,
  );
  binding.slotAnimReady?.(slotId);
}

/** Output Log / console warning when a Model GLB cannot instantiate. */
export function reportGlbLoadFailure(guid: string, error: unknown): void {
  const detail = error instanceof Error ? error.message : String(error);
  console.warn(`[render] Model ${guid} failed to load: ${detail}`);
}


function retireSource(cache: SceneGlbCache, entry: CachedGlb): void {
  if (entry.retired) return;
  entry.retired = true;
  entry.controller.abort(new Error(`Model ${entry.guid}: preparation was retired.`));
  if (cache.entries.get(entry.key) === entry) cache.entries.delete(entry.key);
  if (cache.current.get(entry.guid) === entry) cache.current.delete(entry.guid);
  if (cache.requested.get(entry.guid) === entry.key) cache.requested.delete(entry.guid);
  cache.accountedBytes = Math.max(0, cache.accountedBytes - entry.accounted);
  entry.accounted = 0;
  entry.lodSet?.dispose();
  entry.lodSet = undefined;
  entry.container?.dispose();
  entry.container = undefined;
}

/** Drop unowned source generations while preserving containers used by live visuals. */
export function releaseUnownedGlbSources(scene: Scene, ownedGuids: ReadonlySet<string>): void {
  const cache = glbCaches.get(scene);
  if (!cache) return;
  for (const [guid, entry] of cache.current) {
    if (ownedGuids.has(guid)) continue;
    cache.current.delete(guid);
    cache.requested.delete(guid);
    releaseUnusedSource(cache, entry);
  }
  for (const entry of cache.entries.values()) {
    if (!ownedGuids.has(entry.guid) && !entry.references) retireSource(cache, entry);
  }
}

/** Shared generation; a failure leaves this model at full detail. */
function modelLods(cache: SceneGlbCache, entry: CachedGlb): Promise<ModelLodSet | null> {
  entry.lods ??= entry.load.then(async (container) => {
    const current = () => {
      if (cache.disposed || entry.retired) throw new Error("Model preparation cancelled");
    };
    const preparation = nativePreparationForEngine(container.scene.getEngine());
    // Levels never gate publishing, so their admission ranks after gameplay and preload work, and
    // is taken only for the model's own turn in the LOD worker, never while it waits for one.
    const lods = await generateModelLods(container, current, entry.key, (work) => preparation.schedule({
      label: `Model ${entry.guid} LOD`, temporaryBytes: Math.max(1024, entry.accounted * 2), signal: entry.controller.signal,
      priority: "background",
    }, work));
    if (cache.disposed || entry.retired) {
      lods.dispose();
      throw new Error("Model preparation cancelled");
    }
    entry.lodSet = lods;
    entry.accounted += lods.indexBytes;
    cache.accountedBytes += lods.indexBytes;
    return lods;
  }).catch((error: unknown) => {
    if (!cache.disposed && !entry.retired)
      console.warn(`[render] Model ${entry.guid} keeps full detail; automatic LOD failed: ${String(error)}`);
    return null;
  });
  return entry.lods;
}

function releaseUnusedSource(cache: SceneGlbCache, entry: CachedGlb): void {
  if (!entry.references && cache.current.get(entry.guid) !== entry) retireSource(cache, entry);
}

export function acquireGlbContainer(
  scene: Scene,
  guid: string,
  source: Blob,
  priority?: NativePreparationPriority,
): { key: string; load: Promise<AssetContainer>; lods(): Promise<ModelLodSet | null>; release(): void } {
  const cache = cacheFor(scene);
  if (cache.disposed || scene.isDisposed) throw new Error("Model scene is disposed");
  const key = modelSourceKey(guid, source);
  cache.requested.set(guid, key);
  let entry = cache.entries.get(key);
  if (!entry) {
    entry = {
      key, guid, references: 0, retired: false, accounted: 0,
      controller: new AbortController(),
      load: Promise.resolve(null as unknown as AssetContainer),
    };
    cache.entries.set(key, entry);
    const created = entry;
    cache.loadCount += 1;
    const finishContainer = (container: AssetContainer): AssetContainer => {
      created.container = container;
      created.accounted = accountedAssetContainerGeometry(container);
      cache.accountedBytes += created.accounted;
      if (cache.requested.get(guid) === key) {
        const previous = cache.current.get(guid);
        cache.current.set(guid, created);
        if (previous && previous !== created) releaseUnusedSource(cache, previous);
      }
      return container;
    };
    // Static GLB CPU blueprints already decoded on this Engine require zero decode memory or
    // WASM work: materialize directly without contending for cold nativePreparation slots.
    const materialized = hasEngineGlbBlueprint(scene.getEngine(), key)
      ? materializeEngineGlbBlueprint(scene, key)
      : null;
    if (materialized) {
      created.load = Promise.resolve(finishContainer(materialized));
    } else {
      created.load = nativePreparationForEngine(scene.getEngine()).schedule({
        label: `Model ${guid}`, temporaryBytes: Math.max(1024, source.size * 4), signal: created.controller.signal,
        priority,
      }, async () => {
        if (cache.disposed || created.retired) throw new Error("Model preparation cancelled");
        // Reuse a static GLB's decoded CPU blueprint on the same Engine (e.g. Editor <-> Play)
        // to skip GLB parsing and Draco/Meshopt decoding while holding zero GPU memory between Scenes.
        let container = materializeEngineGlbBlueprint(scene, key);
        if (!container) {
          const bytes = new Uint8Array(await source.arrayBuffer());
          if (!isGltfModelBytes(bytes)) throw new Error("Unsupported model content");
          if (cache.disposed || created.retired) throw new Error("Model preparation cancelled");
          container = await loadModelContainer(scene, bytes, `${guid}.glb`);
          if (cache.disposed || created.retired) {
            container.dispose();
            throw new Error("Model preparation cancelled");
          }
          rememberEngineGlbBlueprint(scene.getEngine(), key, container);
        }
        return finishContainer(container);
      }).catch((error) => {
        retireSource(cache, created);
        throw error;
      });
    }
  }
  entry.references += 1;
  const held = entry;
  let released = false;
  return {
    key,
    load: held.load,
    lods: () => modelLods(cache, held),
    release() {
      if (released) return;
      released = true;
      held.references -= 1;
      releaseUnusedSource(cache, held);
    },
  };
}

/**
 * An AnimationGroup as Play poses it (`applyAnimStateToScene`): a pose clip tagged with the Animation asset it plays,
 * its channels' rest values read now. The group is never started; `dispose` disposes it. Editor previews bind their
 * groups the same way so they pose an Animation Graph's clip layers as Play does.
 */
export function bindGameplayAnimationGroup(
  group: PoseClipSource & { dispose(): void },
  clipAssetGuid: string,
): PoseClip & { dispose(): void } {
  return bindPoseClip(group, clipAssetGuid, { dispose: () => group.dispose() });
}

export function adoptLoadedHierarchy(
  placeholder: AbstractMesh,
  container: {
    rootNodes?: readonly Node[];
    transformNodes: readonly TransformNode[];
    meshes: readonly AbstractMesh[];
  },
): void {
  parentContainerRoots(placeholder, container);
  hideModelPlaceholder(placeholder);
}

function disposePlaceholderInstance(placeholder: AbstractMesh): void {
  const meta = asPlaceholderMeta(placeholder);
  const instance = meta[MODEL_INSTANCE_KEY];
  meta[MODEL_INSTANCE_KEY] = undefined;
  meta[MODEL_LOAD_KEY] = undefined;
  instance?.bundle.dispose();
}

function keepSourceName(sourceName: string): string {
  return sourceName;
}

const instanceCompileHolds = new WeakMap<Scene, () => boolean>();

/**
 * Lets a Scene's host hold model and foliage instance compiles while a load
 * realizes the Scene. Until that load's warm-up, its lights, their Forward
 * admission, shadow maps, fog and each instance's receiver flags are not final,
 * so a compile then builds variants the first frame never draws. While `held`
 * returns true, `prepareInstanceMaterials` admits textures only and the load's
 * warm-up and readiness probes compile what draws.
 */
export function holdSceneInstanceCompiles(scene: Scene, held: () => boolean): void {
  instanceCompileHolds.set(scene, held);
}

/**
 * Prepare only this unpublished instance's actual material/mesh variants. A
 * stall deadline that fires a held gap late (a synchronous shader link kept the
 * material from progressing) starts a fresh window, and so does one that
 * expires while shaders keep finishing on the Engine (short synchronous links
 * earn no held credit). All the meshes of one call share one
 * `SCENE_THREAD_HELD_BUDGET_MS` and one compile watch, so a stuck material
 * still fails. While the Scene's load holds instance compiles
 * (`holdSceneInstanceCompiles`), only the textures are prepared.
 */
export async function prepareInstanceMaterials(
  root: Mesh,
  assertCurrent: () => void,
  cancellation: Promise<never>,
): Promise<void> {
  const budget = createHeldThreadBudget();
  const compiles = new DriverCompileWatch(root.getEngine());
  let finished = false;
  const check = () => {
    if (finished) throw new Error("Model material preparation was cancelled");
    assertCurrent();
  };
  const materialsOf = (material: Material): Material[] => material instanceof MultiMaterial
    ? [...new Set(material.subMaterials.flatMap((child) => child ? materialsOf(child) : []))]
    : [material];
  try {
    // An instance draws in its source's batch, which may stand outside `root`: each source compiles once.
    const batches = new Set(root.getChildMeshes().map((mesh) => mesh instanceof InstancedMesh ? mesh.sourceMesh : mesh));
    for (const mesh of batches) {
      if (!(mesh instanceof Mesh) || !mesh.getTotalVertices()) continue;
      for (;;) {
        check();
        const assigned = mesh.material ?? mesh.getScene().defaultMaterial;
        const materials = materialsOf(assigned);
        // Capture before awaiting: a later request cannot substitute its generation.
        const preparations = materials.map(ownedMaterialPreparation);
        for (const preparation of preparations) {
          if (!preparation) continue;
          // Texture leases own their longer admission deadline. The shader stall
          // budget starts only after those preparations complete.
          const diagnostics = await Promise.race([preparation, cancellation]);
          check();
          if (diagnostics.length) throw new Error(diagnostics.map((entry) => entry.message).join("; "));
        }
        const stillAssigned = () => {
          const current = mesh.material ?? mesh.getScene().defaultMaterial;
          if (current !== assigned) return false;
          const leaves = materialsOf(current);
          return leaves.length === materials.length && leaves.every((material, index) => material === materials[index]);
        };
        if (!stillAssigned()) continue;
        // A held load compiles this mesh in its own warm-up, once lighting is final.
        if (instanceCompileHolds.get(mesh.getScene())?.()) break;
        // Each mesh's deadline renews only for what compiles in its own windows.
        compiles.restart();
        const deadline = createStallDeadline((unit) => `Model material preparation stalled${unit ? ` at ${unit}` : ""}`, SCENE_SHADER_WARM_TIMEOUT_MS, () => compiles.renew(), budget);
        // The variants Babylon draws this mesh with: a thin-instanced mesh (foliage) never draws plain.
        const drawn = drawnMaterialVariants(mesh);
        await deadline.race(Promise.race([(async () => {
          for (const material of materials) {
            check();
            if (!mesh.getScene().materials.includes(material)) throw new Error(`Model material "${material.name}" was retired during preparation`);
            const hotSwap = material.allowShaderHotSwapping;
            try {
              if (drawn.plain) {
                deadline.advance(`material "${material.name}" for "${mesh.name}"`);
                if (material instanceof NodeMaterial) await prewarmMaterial(material, mesh);
                else await material.forceCompilationAsync(mesh);
                check();
              }
              if (drawn.instanced) {
                deadline.advance(`material "${material.name}" for instances of "${mesh.name}"`);
                await material.forceCompilationAsync(mesh, { useInstances: true });
                check();
              }
            } finally { material.allowShaderHotSwapping = hotSwap; }
          }
        })(), cancellation]));
        if (stillAssigned()) break;
      }
    }
  } finally { finished = true; }
}

type PreparedModelInstance = {
  bundle: VisualBundle;
  staging: Mesh;
  wrapper: TransformNode;
  instance: InstantiatedEntries;
  clips: Array<PoseClip & { dispose?(): void }>;
};

/** Native clone semantics retained, with wrapper ownership. */
function prepareModelInstance(
  placeholder: AbstractMesh,
  container: AssetContainer,
  importScale: number,
): PreparedModelInstance {
  const bundle = new VisualBundle();
  try {
    const staging = new Mesh(placeholder.name, placeholder.getScene());
    bundle.ownRenderUser({ dispose: () => { if (!staging.isDisposed()) staging.dispose(true); } });
    staging.setEnabled(false);
    hideModelPlaceholder(staging);
    const wrapper = applyModelImportScale(staging, importScale);
    bundle.ownRenderUser({ dispose: () => { if (!wrapper.isDisposed()) wrapper.dispose(true); } });
    // The load skips the file's materials; the instance's slots assign its Materials.
    const instance = bundle.ownRenderUser(container.instantiateModelsToScene(keepSourceName, false, { doNotInstantiate: true }));
    for (const node of instance.rootNodes) node.parent = wrapper;
    for (const child of staging.getChildMeshes()) child.renderingGroupId = placeholder.renderingGroupId;
    return { bundle, staging, wrapper, instance, clips: [] };
  } catch (error) {
    bundle.dispose();
    throw error;
  }
}

/** The identity a model load installs under: source, import scale, LOD and animations. */
function slotModelLoadKey(binding: ModelAnimLoadBinding, clipAssetGuid: string, bytes: Blob) {
  const payload = binding.modelPayloads?.get(clipAssetGuid);
  const importScale = normalizeModelImportScale(payload?.importScale);
  const autoLod = payload?.autoLod !== false;
  const animations = JSON.stringify({
    clips: [...(binding.modelClipAnimationGuids?.get(clipAssetGuid) ?? [])],
    retargets: (binding.retargetAnimationLoads?.get(clipAssetGuid) ?? []).map((row) => {
      const source = binding.modelSources?.get(row.sourceModelGuid);
      return [row, source ? installedAssetIdentity(source) : null];
    }),
  });
  const settings = `:scale=${importScale}:lod=${autoLod}:${animations}`;
  return { importScale, autoLod, key: `${modelSourceKey(clipAssetGuid, bytes)}${settings}` };
}

/** The placeholder already holds an instance of this load. */
function installedLoadSatisfies(meta: ModelPlaceholderMeta, key: string): boolean {
  return Boolean(meta[MODEL_INSTANCE_KEY]) && meta[MODEL_LOAD_KEY] === key;
}

/** Whether `beginSlotModelAnimLoad` would find this model already installed on `placeholder` and adopt nothing. */
export function isSlotModelInstalled(binding: ModelAnimLoadBinding, clipAssetGuid: string, bytes: Blob, placeholder: AbstractMesh): boolean {
  const meta = placeholder.metadata as ModelPlaceholderMeta | null | undefined;
  if (!meta) return false;
  return installedLoadSatisfies(meta, slotModelLoadKey(binding, clipAssetGuid, bytes).key);
}

/**
 * Acquire a scene-local installed source generation, stage independent nodes,
 * materials and animation bindings, then publish to the winning actor epoch.
 */
export function beginSlotModelAnimLoad(
  scene: Scene,
  binding: ModelAnimLoadBinding,
  slotId: number,
  clipAssetGuid: string,
  bytes: Blob,
  placeholder: AbstractMesh,
  onAdopted?: (placeholder: AbstractMesh) => void,
  ownsLoad?: () => boolean,
  prepareInstance?: (root: Mesh) => void | Promise<void>,
  priority?: NativePreparationPriority,
): Promise<void> {
  const { importScale, autoLod, key } = slotModelLoadKey(binding, clipAssetGuid, bytes);
  const meta = asPlaceholderMeta(placeholder);
  if (installedLoadSatisfies(meta, key)) return Promise.resolve();
  const pending = pendingModelLoads.get(placeholder);
  if (pending?.key === key && pending.isCurrent()) {
    const adopted = pending.promise.then(() => {
      if (!placeholder.isDisposed() && ownsLoad?.() !== false &&
        meta[MODEL_LOAD_KEY] === key && meta[MODEL_INSTANCE_KEY]) onAdopted?.(placeholder);
    });
    void adopted.catch(() => {});
    return adopted;
  }
  pending?.cancel();
  const epoch = bumpSlotAnimEpoch(binding, slotId);
  let cancelled = false;
  let rejectCancellation!: (error: Error) => void;
  const cancellation = new Promise<never>((_resolve, reject) => { rejectCancellation = reject; });
  void cancellation.catch(() => {});
  const cancel = () => {
    if (cancelled) return;
    cancelled = true;
    rejectCancellation(new Error("Model preparation was cancelled"));
  };
  const wait = <T>(work: Promise<T>): Promise<T> => Promise.race([work, cancellation]);
  const cancellations = slotLoadCancellations.get(binding) ?? new Map<number, () => void>();
  slotLoadCancellations.set(binding, cancellations);
  cancellations.set(slotId, cancel);
  const sceneDisposed = scene.onDisposeObservable.addOnce(cancel);
  const placeholderDisposed = placeholder.onDisposeObservable.addOnce(cancel);
  const request = {
    key,
    promise: Promise.resolve(),
    cancel,
    isCurrent: (): boolean => !cancelled && !scene.isDisposed && !placeholder.isDisposed() &&
      binding.slotAnimEpoch?.get(slotId) === epoch &&
      pendingModelLoads.get(placeholder) === request && ownsLoad?.() !== false,
  };
  pendingModelLoads.set(placeholder, request);
  const load = (async () => {
    let prepared: PreparedModelInstance | undefined;
    const lease = acquireGlbContainer(scene, clipAssetGuid, bytes, priority);
    // Generation overlaps preparation; the instance publishes at full detail
    // and its levels attach once they are ready.
    const lods = autoLod ? lease.lods() : null;
    let published = false;
    try {
      const container = await wait(lease.load);
      if (!request.isCurrent()) return;
      prepared = prepareModelInstance(placeholder, container, importScale);
      prepared.bundle.releaseWith(() => lease.release());
      const { instance } = prepared;
      if (!binding.slotPoseClips) binding.slotPoseClips = new Map();
      const clipGuids = binding.modelClipAnimationGuids?.get(clipAssetGuid);
      const retargets = binding.retargetAnimationLoads?.get(clipAssetGuid) ?? [];
      const nativeGuids = new Set<string>([clipAssetGuid]);
      if (clipGuids) {
        for (const guid of clipGuids.values()) nativeGuids.add(guid);
      }
      for (const row of retargets) nativeGuids.add(row.animationGuid);
      const existing = (binding.slotPoseClips.get(slotId) ?? []).filter(
        (clip) => !nativeGuids.has(clip.clipAssetGuid ?? ""),
      );
      // Rest values are read now, before instance pooling or any pose moves the nodes.
      const wrapped: Array<PoseClip & { dispose(): void }> = instance.animationGroups.map((group) =>
        bindGameplayAnimationGroup(group, clipGuids?.get(group.name) ?? clipAssetGuid),
      );
      const retargetLoads: Array<{ row: (typeof retargets)[number]; load: Promise<AssetContainer> }> = [];
      for (const row of retargets) {
        const sourceBytes = binding.modelSources?.get(row.sourceModelGuid);
        if (!sourceBytes) continue;
        const sourceLease = acquireGlbContainer(scene, row.sourceModelGuid, sourceBytes, priority);
        prepared.bundle.releaseWith(() => sourceLease.release());
        retargetLoads.push({ row, load: sourceLease.load });
      }
      if (retargetLoads.length > 0) {
        const sourceContainers = await wait(Promise.all(retargetLoads.map((item) => item.load)));
        if (!request.isCurrent()) return;
        let targetLookup: AnimationTargetLookup | undefined;
        for (let index = 0; index < retargetLoads.length; index += 1) {
          const { row } = retargetLoads[index]!;
          const sourceContainer = sourceContainers[index]!;
          const sourceGroup = sourceContainer.animationGroups.find(
            (group) => group.name === row.clipName,
          );
          if (sourceGroup) {
            // Another Model's clip on the same Skeleton binds as it is; a clip from another rig is retargeted.
            const retargeted = row.bindByName
              ? bindAnimationGroupByName(sourceGroup, prepared.staging, targetLookup ??= buildAnimationTargetLookup(prepared.staging))
              : retargetAnimationGroupWithMeshProxy(sourceGroup, prepared.staging);
            if (retargeted) {
              prepared.bundle.ownRenderUser(retargeted);
              wrapped.push(bindGameplayAnimationGroup(retargeted, row.animationGuid));
            }
          }
        }
      }
      await wait(Promise.resolve(prepareInstance?.(prepared.staging)));
      if (!request.isCurrent()) return;
      // A model's rigid meshes, with their slot Materials assigned, draw in the Scene's instance pool, the channels of
      // its own clips moving the members; the preparation below then compiles their groups' instanced variants. A
      // retargeted clip binds through a skeleton linked to the instance's nodes, so such an instance keeps its meshes.
      if (wrapped.length === instance.animationGroups.length) {
        poolModelLeaves(prepared.staging, container, {
          retain: () => {
            const hold = acquireGlbContainer(scene, clipAssetGuid, bytes, priority);
            return () => hold.release();
          },
          animationGroups: instance.animationGroups,
        });
      }
      await wait(prepareInstanceMaterials(prepared.staging, () => {
        if (!request.isCurrent()) throw new Error("Model preparation was cancelled");
      }, cancellation));
      if (!request.isCurrent()) return;
      const previousInstance = meta[MODEL_INSTANCE_KEY];
      const previousClips = new Set(previousInstance?.clips ?? []);
      prepared.clips = wrapped;
      for (const clip of wrapped) bundleOwnedClips.add(clip);
      prepared.wrapper.parent = placeholder;
      prepared.staging.dispose(true);
      registerModelOccluder(placeholder, binding.modelPayloads?.get(clipAssetGuid)?.occluder);
      meta[MODEL_INSTANCE_KEY] = prepared;
      if (!meta.disposeModelOnDespawn) {
        meta.disposeModelOnDespawn = true;
        placeholder.onDisposeObservable.addOnce(() => disposePlaceholderInstance(placeholder));
      }
      binding.slotPoseClips.set(slotId, [...existing.filter((clip) => !previousClips.has(clip)), ...wrapped]);
      // Playback borrows these clips; releasing a visual must also drop its
      // lookup references, including editor generations with fresh slot IDs.
      prepared.bundle.releaseWith(() => {
        // The bundle disposes these clips' AnimationGroups.
        const current = binding.slotPoseClips?.get(slotId);
        if (!current) return;
        const remaining = current.filter((clip) => !wrapped.some((own) => own === clip));
        if (remaining.length) binding.slotPoseClips!.set(slotId, remaining);
        else binding.slotPoseClips!.delete(slotId);
      });
      // An instantiated hierarchy is not ready until all retarget sources and
      // groups are installed. A replacement must own that remaining work.
      meta[MODEL_LOAD_KEY] = key;
      published = true;
      hideModelPlaceholder(placeholder);
      previousInstance?.bundle.dispose();
      onAdopted?.(placeholder);
      replayPendingAnimState(binding, slotId);
      const current = prepared;
      // Levels share the master's buffers and materials, so their effects are
      // already compiled. A replaced or despawned instance keeps none.
      void lods?.then((set) => {
        if (set && meta[MODEL_INSTANCE_KEY] === current && !current.wrapper.isDisposed())
          attachModelLods(current.wrapper, set);
      });
    } catch (error) {
      // A superseded or disposed actor no longer owns this failure. Current
      // failures must reach the scene readiness waiter, even when command
      // delivery starts the load without awaiting it.
      if (!request.isCurrent()) return;
      reportGlbLoadFailure(clipAssetGuid, error);
      throw error;
    } finally {
      if (!published) {
        prepared?.bundle.dispose();
        lease.release();
      }
    }
  })();
  // Loads run immediately, possibly before the prior slot load settles.
  void load.catch(() => {});
  if (!binding.slotAnimLoads) binding.slotAnimLoads = new Map();
  const chained = load.finally(() => {
    scene.onDisposeObservable.remove(sceneDisposed);
    placeholder.onDisposeObservable.remove(placeholderDisposed);
    if (cancellations.get(slotId) === cancel) cancellations.delete(slotId);
    if (pendingModelLoads.get(placeholder) === request) pendingModelLoads.delete(placeholder);
  });
  request.promise = chained;
  binding.slotAnimLoads.set(slotId, chained);
  // Observe fire-and-forget command delivery without converting the stored
  // promise to success: a later readiness wait must still reject.
  void chained.catch(() => {});
  return chained;
}

/** Publish already prepared multipart model animations with the whole visual.
 * Parts prepare against isolated animation maps; the live slot changes only here. */
export function publishModelHierarchyAnimations(
  binding: ModelAnimLoadBinding,
  slotId: number,
  root: AbstractMesh,
): void {
  const instances = [root, ...root.getChildMeshes()].flatMap((mesh) => {
    const instance = (mesh.metadata as ModelPlaceholderMeta | null)?.[MODEL_INSTANCE_KEY];
    return instance ? [instance] : [];
  });
  const clips = instances.flatMap((instance) => instance.clips);
  binding.slotPoseClips ??= new Map();
  binding.slotPoseClips.set(slotId, clips);
  for (const instance of instances) {
    instance.bundle.releaseWith(() => {
      const current = binding.slotPoseClips?.get(slotId);
      if (!current) return;
      const remaining = current.filter((clip) => !instance.clips.includes(clip));
      if (remaining.length) binding.slotPoseClips!.set(slotId, remaining);
      else binding.slotPoseClips!.delete(slotId);
    });
  }
  replayPendingAnimState(binding, slotId);
}

/** Clip names whose name-match retarget onto the target keeps at least one
 * channel. Both GLBs load once for the whole batch. */
export async function animationRetargetMatchingClips(
  engine: AbstractEngine,
  sourceBytes: Uint8Array,
  targetBytes: Uint8Array,
  clipNames: readonly string[],
): Promise<Set<string>> {
  const matching = new Set<string>();
  if (!isGltfModelBytes(sourceBytes) || !isGltfModelBytes(targetBytes)) {
    return matching;
  }
  const scene = new Scene(engine);
  let sourceContainer: AssetContainer | undefined;
  let targetContainer: AssetContainer | undefined;
  try {
    sourceContainer = await loadModelContainer(scene, sourceBytes, "retarget-src.glb");
    targetContainer = await loadModelContainer(scene, targetBytes, "retarget-dst.glb");
    for (const clipName of new Set(clipNames)) {
      if (retargetKeepsChannels(sourceContainer, targetContainer, clipName)) {
        matching.add(clipName);
      }
    }
  } catch {
    // A GLB that fails to load matches no clip.
  } finally {
    sourceContainer?.dispose();
    targetContainer?.dispose();
    scene.dispose();
  }
  return matching;
}

/** Probes one clip against a fresh target instance, as an isolated retarget would. */
function retargetKeepsChannels(
  sourceContainer: AssetContainer,
  targetContainer: AssetContainer,
  clipName: string,
): boolean {
  let instance: ReturnType<typeof targetContainer.instantiateModelsToScene> | undefined;
  try {
    instance = targetContainer.instantiateModelsToScene(
      keepSourceName,
      false,
      { doNotInstantiate: true },
    );
    const sourceGroup = sourceContainer.animationGroups.find(
      (group) => group.name === clipName,
    );
    const root =
      (instance.rootNodes[0] as TransformNode | undefined) ??
      targetContainer.transformNodes[0] ??
      targetContainer.meshes[0];
    if (!sourceGroup || !root) return false;
    const retargeted = retargetAnimationGroupWithMeshProxy(sourceGroup, root);
    retargeted?.dispose();
    return retargeted != null;
  } catch {
    return false;
  } finally {
    instance?.dispose();
  }
}
