import "./gltf-loader";
import { Animation } from "@babylonjs/core/Animations/animation";
import type {
  AbstractEngine,
  AbstractMesh,
  AssetContainer,
  InstantiatedEntries,
  Material,
  Node,
} from "@babylonjs/core";
import { MultiMaterial } from "@babylonjs/core/Materials/multiMaterial";
import { NodeMaterial } from "@babylonjs/core/Materials/Node/nodeMaterial";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { loadModelContainer } from "./model-container";
import { Scene } from "@babylonjs/core/scene";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { installedAssetIdentity, normalizeModelImportScale, shouldSlimModelEmbeddedTextures, type PackedTextureSlimProof } from "@babylonslate/assets";
import { applyAnimStateToScene,
  sceneAnimHostFromBinding,
  type NamedSeekableGroup,
} from "./anim-apply";
import { isGltfModelBytes, gpuModelBytes } from "./model-mesh";
import { retargetAnimationGroupWithMeshProxy } from "./node-rig";
import type { SnapshotSceneBinding } from "./snapshot-apply";
import { RENDERING_GROUP } from "./sorting";
import { accountedGeometryBytes } from "./perf-ceilings";
import { VisualBundle } from "./visual-bundle";
import { ownedMaterialPreparation } from "./material-library";
import { prewarmMaterial } from "./material-compiler";
import { createStallDeadline, SCENE_SHADER_WARM_TIMEOUT_MS } from "./scene-perf";

/**
 * Fields `beginSlotModelAnimLoad` mutates. Play passes the full snapshot
 * binding; the editor scene-loader can pass a stub without lights/cameras.
 */
export type ModelAnimLoadBinding = Pick<
  SnapshotSceneBinding,
  | "slotAnimEpoch"
  | "slotAnimationGroups"
  | "slotAnimLoads"
  | "pendingAnimState"
  | "slotAnimReady"
  | "modelBytes"
  | "modelSources"
  | "modelPayloads"
  | "modelClipAnimationGuids"
  | "retargetAnimationLoads"
  | "spritePayloads"
  | "textureBytes"
  | "materialTextureGuids"
  | "compiledMaterialGuids"
>;

const MODEL_PLACEHOLDER_KEY = "editorModelPlaceholder";
const MODEL_INSTANCE_KEY = "babylonslateModelInstance";
const MODEL_LOAD_KEY = "babylonslateModelLoadKey";
export const MODEL_IMPORT_SCALE_NODE_NAME = "__importScale";

type ModelPlaceholderMeta = {
  disposeModelOnDespawn?: boolean;
  [MODEL_PLACEHOLDER_KEY]?: boolean;
  [MODEL_INSTANCE_KEY]?: PreparedModelInstance;
  [MODEL_LOAD_KEY]?: string;
};

type CachedGlb = {
  key: string;
  guid: string;
  references: number;
  retired: boolean;
  accounted: number;
  container?: AssetContainer;
  load: Promise<AssetContainer>;
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
const bundleOwnedGroups = new WeakSet<NamedSeekableGroup>();

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
  for (const mesh of container.meshes) {
    const positions = mesh.getVerticesData?.(VertexBuffer.PositionKind);
    const vertexCount = positions
      ? positions.length / 3
      : (mesh.getTotalVertices?.() ?? 0);
    const indices = mesh.getIndices?.();
    const indexCount = indices ? indices.length : 0;
    if (vertexCount <= 0 && indexCount <= 0) continue;
    total += accountedGeometryBytes(vertexCount, indexCount);
  }
  return total;
}

/** Accounted GPU vertex+index bytes for GLB containers cached on this Scene. */
export function accountedGeometryBytesForScene(scene: Scene): number {
  return glbCaches.get(scene)?.accountedBytes ?? 0;
}

/** Count of `LoadAssetContainerAsync` calls for this Scene (cache misses). */
export function glbContainerLoadCount(scene: Scene): number {
  return glbCaches.get(scene)?.loadCount ?? 0;
}

function modelSourceKey(guid: string, source: Blob, payload?: unknown, packed?: PackedTextureSlimProof | null): string {
  return `${guid}:${installedAssetIdentity(source)}:slim=${Boolean(payload && shouldSlimModelEmbeddedTextures(payload, packed))}`;
}

/** Child of the actor placeholder so scene TRS and import scale stay independent. */
export function applyModelImportScale(
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

export function disposeSlotAnimationGroups(
  binding: ModelAnimLoadBinding,
  slotId: number,
): void {
  for (const group of binding.slotAnimationGroups?.get(slotId) ?? []) {
    if (!bundleOwnedGroups.has(group)) group.dispose?.();
  }
  binding.slotAnimationGroups?.delete(slotId);
}

/** Cancel in-flight GLB animation loads and dispose registered groups. */
export function invalidateSlotAnimLoad(
  binding: ModelAnimLoadBinding,
  slotId: number,
): void {
  bumpSlotAnimEpoch(binding, slotId);
  binding.slotAnimLoads?.delete(slotId);
  disposeSlotAnimationGroups(binding, slotId);
}

function replayPendingAnimState(
  scene: Scene,
  binding: ModelAnimLoadBinding,
  slotId: number,
): void {
  const pending = binding.pendingAnimState?.get(slotId);
  if (!pending) return;
  applyAnimStateToScene(
    sceneAnimHostFromBinding(binding as SnapshotSceneBinding, {
      animationGroups: scene.animationGroups,
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

async function loadGlbContainer(scene: Scene, bytes: Uint8Array, name: string) {
  return loadModelContainer(scene, bytes, name);
}

function packedSlimProof(
  binding: Pick<
    ModelAnimLoadBinding,
    "textureBytes" | "materialTextureGuids" | "compiledMaterialGuids"
  >,
): PackedTextureSlimProof | undefined {
  if (!binding.textureBytes || !binding.materialTextureGuids) return undefined;
  return {
    packedTextureGuids: new Set(binding.textureBytes.keys()),
    texturesByMaterialGuid: binding.materialTextureGuids,
    compiledMaterialGuids: binding.compiledMaterialGuids ?? new Set(),
  };
}

function retireSource(cache: SceneGlbCache, entry: CachedGlb): void {
  if (entry.retired) return;
  entry.retired = true;
  if (cache.entries.get(entry.key) === entry) cache.entries.delete(entry.key);
  cache.accountedBytes = Math.max(0, cache.accountedBytes - entry.accounted);
  entry.accounted = 0;
  entry.container?.dispose();
  entry.container = undefined;
}

function releaseUnusedSource(cache: SceneGlbCache, entry: CachedGlb): void {
  if (!entry.references && cache.current.get(entry.guid) !== entry) retireSource(cache, entry);
}

function acquireGlbContainer(
  scene: Scene,
  guid: string,
  source: Blob,
  payload?: unknown,
  packed?: PackedTextureSlimProof | null,
): { key: string; load: Promise<AssetContainer>; release(): void } {
  const cache = cacheFor(scene);
  if (cache.disposed || scene.isDisposed) throw new Error("Model scene is disposed");
  const key = modelSourceKey(guid, source, payload, packed);
  cache.requested.set(guid, key);
  let entry = cache.entries.get(key);
  if (!entry) {
    entry = { key, guid, references: 0, retired: false, accounted: 0, load: Promise.resolve(null as unknown as AssetContainer) };
    cache.entries.set(key, entry);
    const created = entry;
    cache.loadCount += 1;
    created.load = (async () => {
      const bytes = new Uint8Array(await source.arrayBuffer());
      if (!isGltfModelBytes(bytes)) throw new Error("Unsupported model content");
      if (cache.disposed || created.retired) throw new Error("Model preparation cancelled");
      // The descriptor lookup precedes byte unpacking/slimming and native decode.
      const container = await loadGlbContainer(scene, gpuModelBytes(bytes, payload, packed), `${guid}.glb`);
      if (cache.disposed || created.retired) {
        container.dispose();
        throw new Error("Model preparation cancelled");
      }
      created.container = container;
      created.accounted = accountedAssetContainerGeometry(container);
      cache.accountedBytes += created.accounted;
      if (cache.requested.get(guid) === key) {
        const previous = cache.current.get(guid);
        cache.current.set(guid, created);
        if (previous && previous !== created) releaseUnusedSource(cache, previous);
      }
      return container;
    })().catch((error) => {
      retireSource(cache, created);
      throw error;
    });
  }
  entry.references += 1;
  const held = entry;
  let released = false;
  return {
    key,
    load: held.load,
    release() {
      if (released) return;
      released = true;
      held.references -= 1;
      releaseUnusedSource(cache, held);
    },
  };
}

function wrapGroup(
  group: {
    name: string;
    from: number;
    to: number;
    start?(loop?: boolean): void;
    play?(loop?: boolean): void;
    pause(): void;
    reset(): void;
    stop(): void;
    goToFrame(frame: number): void;
    setWeightForAllAnimatables?(weight: number): void;
    dispose(): void;
  },
  clipAssetGuid: string,
): NamedSeekableGroup & { dispose(): void } {
  let initialized = false;
  const initialize = () => {
    if (initialized) return;
    initialized = true;
    // A lazily started blend must inherit the other clip's rest values, not
    // capture its currently animated pose as the value to restore on reset.
    const inheritOriginal = Animation.InheritOriginalValueFromActiveAnimations;
    Animation.InheritOriginalValueFromActiveAnimations = true;
    try {
      if (typeof group.start === "function") group.start(true);
      else group.play?.(true);
    } finally {
      Animation.InheritOriginalValueFromActiveAnimations = inheritOriginal;
    }
    group.pause();
    group.setWeightForAllAnimatables?.(0);
  };
  let active = false;
  return {
    name: group.name,
    from: group.from,
    to: group.to,
    clipAssetGuid,
    pause: () => group.pause(),
    reset: () => {
      if (!active) return;
      group.reset();
      group.setWeightForAllAnimatables?.(0);
      active = false;
    },
    goToFrame: (frame) => {
      initialize();
      active = true;
      group.goToFrame(frame);
    },
    setWeightForAllAnimatables: (weight) =>
      group.setWeightForAllAnimatables?.(weight),
    dispose: () => group.dispose(),
  };
}

export function adoptLoadedHierarchy(
  placeholder: AbstractMesh,
  container: {
    rootNodes?: readonly Node[];
    transformNodes: readonly TransformNode[];
    meshes: readonly AbstractMesh[];
  },
): void {
  const candidates = [
    ...(container.rootNodes ?? []),
    ...container.transformNodes,
    ...container.meshes,
  ];
  const seen = new Set<Node>();
  for (const node of candidates) {
    if (seen.has(node) || node === placeholder) continue;
    seen.add(node);
    if (!node.parent) node.parent = placeholder;
  }
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

/** Prepare only this unpublished instance's actual material/mesh variants. */
async function prepareInstanceMaterials(
  root: Mesh,
  assertCurrent: () => void,
  cancellation: Promise<never>,
): Promise<void> {
  let finished = false;
  const check = () => {
    if (finished) throw new Error("Model material preparation was cancelled");
    assertCurrent();
  };
  const materialsOf = (material: Material): Material[] => material instanceof MultiMaterial
    ? [...new Set(material.subMaterials.flatMap((child) => child ? materialsOf(child) : []))]
    : [material];
  try {
    for (const mesh of root.getChildMeshes()) {
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
        const deadline = createStallDeadline((unit) => `Model material preparation stalled${unit ? ` at ${unit}` : ""}`, SCENE_SHADER_WARM_TIMEOUT_MS);
        await deadline.race(Promise.race([(async () => {
          for (const material of materials) {
            check();
            if (!mesh.getScene().materials.includes(material)) throw new Error(`Model material "${material.name}" was retired during preparation`);
            deadline.advance(`material "${material.name}" for "${mesh.name}"`);
            const hotSwap = material.allowShaderHotSwapping;
            try {
              if (material instanceof NodeMaterial) await prewarmMaterial(material, mesh);
              else await material.forceCompilationAsync(mesh);
              check();
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
  groups: NamedSeekableGroup[];
};

/** Native clone semantics retained, with explicit materials and wrapper ownership. */
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
    const instance = bundle.ownRenderUser(container.instantiateModelsToScene(keepSourceName, false, { doNotInstantiate: true }));
    for (const node of instance.rootNodes) node.parent = wrapper;
    const copies = new Map<unknown, unknown>();
    const textureCopies = new Map<unknown, Set<unknown>>();
    const cloneMaterial = (source: Material): Material => {
      const previous = copies.get(source) as Material | undefined;
      if (previous) return previous;
      const clone = source instanceof MultiMaterial
        ? new MultiMaterial(source.name, placeholder.getScene())
        : source.clone(source.name);
      if (!clone) throw new Error(`Cannot clone model material ${source.name}`);
      bundle.ownMaterial(clone);
      copies.set(source, clone);
      if (source instanceof MultiMaterial && clone instanceof MultiMaterial) {
        clone.subMaterials = source.subMaterials.map((material) => material ? cloneMaterial(material) : null);
      } else {
        const borrowed = source.getActiveTextures();
        for (const [index, texture] of clone.getActiveTextures().entries()) {
          if (!borrowed.includes(texture)) bundle.ownTexture(texture);
          const original = borrowed[index];
          if (original) {
            const variants = textureCopies.get(original) ?? new Set<unknown>();
            variants.add(texture);
            textureCopies.set(original, variants);
          }
        }
      }
      return clone;
    };
    for (const child of staging.getChildMeshes()) {
      child.renderingGroupId = placeholder.renderingGroupId;
      if (child.material) child.material = cloneMaterial(child.material);
    }
    // With Babylon material cloning disabled, material/texture animation targets
    // still reference the source. Redirect them to this generation's clones.
    for (const group of instance.animationGroups) {
      for (const targeted of [...group.targetedAnimations]) {
        const textures = textureCopies.get(targeted.target);
        if (textures?.size) {
          const [first, ...rest] = textures;
          targeted.target = first;
          for (const target of rest) group.addTargetedAnimation(targeted.animation.clone(), target);
        } else {
          targeted.target = copies.get(targeted.target) ?? targeted.target;
        }
      }
    }
    return { bundle, staging, wrapper, instance, groups: [] };
  } catch (error) {
    bundle.dispose();
    throw error;
  }
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
): Promise<void> {
  const importScale = normalizeModelImportScale(
    binding.modelPayloads?.get(clipAssetGuid)?.importScale,
  );
  const packed = packedSlimProof(binding);
  const animations = JSON.stringify({
    clips: [...(binding.modelClipAnimationGuids?.get(clipAssetGuid) ?? [])],
    retargets: (binding.retargetAnimationLoads?.get(clipAssetGuid) ?? []).map((row) => {
      const source = binding.modelSources?.get(row.sourceModelGuid);
      return [row, source ? installedAssetIdentity(source) : null];
    }),
  });
  const key = `${modelSourceKey(clipAssetGuid, bytes, binding.modelPayloads?.get(clipAssetGuid), packed)}:scale=${importScale}:${animations}`;
  const meta = asPlaceholderMeta(placeholder);
  if (meta[MODEL_LOAD_KEY] === key && meta[MODEL_INSTANCE_KEY]) {
    return Promise.resolve();
  }
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
    const lease = acquireGlbContainer(scene, clipAssetGuid, bytes, binding.modelPayloads?.get(clipAssetGuid), packed);
    let published = false;
    try {
      const container = await wait(lease.load);
      if (!request.isCurrent()) return;
      prepared = prepareModelInstance(placeholder, container, importScale);
      prepared.bundle.releaseWith(() => lease.release());
      const { instance } = prepared;
      if (!binding.slotAnimationGroups) binding.slotAnimationGroups = new Map();
      const clipGuids = binding.modelClipAnimationGuids?.get(clipAssetGuid);
      const retargets = binding.retargetAnimationLoads?.get(clipAssetGuid) ?? [];
      const nativeGuids = new Set<string>([clipAssetGuid]);
      if (clipGuids) {
        for (const guid of clipGuids.values()) nativeGuids.add(guid);
      }
      for (const row of retargets) nativeGuids.add(row.animationGuid);
      const existing = (binding.slotAnimationGroups.get(slotId) ?? []).filter(
        (group) => !nativeGuids.has(group.clipAssetGuid ?? ""),
      );
      const wrapped: NamedSeekableGroup[] = instance.animationGroups.map((group) =>
        wrapGroup(group, clipGuids?.get(group.name) ?? clipAssetGuid),
      );
      for (const row of retargets) {
        const sourceBytes = binding.modelSources?.get(row.sourceModelGuid);
        if (!sourceBytes) continue;
        const sourceLease = acquireGlbContainer(
          scene,
          row.sourceModelGuid,
          sourceBytes,
          binding.modelPayloads?.get(row.sourceModelGuid),
          packedSlimProof(binding),
        );
        prepared.bundle.releaseWith(() => sourceLease.release());
        const sourceContainer = await wait(sourceLease.load);
        if (!request.isCurrent()) return;
        const sourceGroup = sourceContainer.animationGroups.find(
          (group) => group.name === row.clipName,
        );
        if (sourceGroup) {
          const retargeted = retargetAnimationGroupWithMeshProxy(
            sourceGroup,
            prepared.staging,
          );
          if (retargeted) {
            prepared.bundle.ownRenderUser(retargeted);
            wrapped.push(wrapGroup(retargeted, row.animationGuid));
          }
        }
      }
      await wait(Promise.resolve(prepareInstance?.(prepared.staging)));
      if (!request.isCurrent()) return;
      await wait(prepareInstanceMaterials(prepared.staging, () => {
        if (!request.isCurrent()) throw new Error("Model preparation was cancelled");
      }, cancellation));
      if (!request.isCurrent()) return;
      const previousInstance = meta[MODEL_INSTANCE_KEY];
      const previousGroups = new Set(previousInstance?.groups ?? []);
      prepared.groups = wrapped;
      for (const group of wrapped) bundleOwnedGroups.add(group);
      prepared.wrapper.parent = placeholder;
      prepared.staging.dispose(true);
      meta[MODEL_INSTANCE_KEY] = prepared;
      if (!meta.disposeModelOnDespawn) {
        meta.disposeModelOnDespawn = true;
        placeholder.onDisposeObservable.addOnce(() => disposePlaceholderInstance(placeholder));
      }
      binding.slotAnimationGroups.set(slotId, [...existing.filter((group) => !previousGroups.has(group)), ...wrapped]);
      // Playback borrows these groups; releasing a visual must also drop its
      // lookup references, including editor generations with fresh slot IDs.
      prepared.bundle.releaseWith(() => {
        const current = binding.slotAnimationGroups?.get(slotId);
        if (!current) return;
        const remaining = current.filter((group) => !wrapped.includes(group));
        if (remaining.length) binding.slotAnimationGroups!.set(slotId, remaining);
        else binding.slotAnimationGroups!.delete(slotId);
      });
      // An instantiated hierarchy is not ready until all retarget sources and
      // groups are installed. A replacement must own that remaining work.
      meta[MODEL_LOAD_KEY] = key;
      published = true;
      hideModelPlaceholder(placeholder);
      previousInstance?.bundle.dispose();
      onAdopted?.(placeholder);
      replayPendingAnimState(scene, binding, slotId);
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
  scene: Scene,
  binding: ModelAnimLoadBinding,
  slotId: number,
  root: AbstractMesh,
): void {
  const instances = [root, ...root.getChildMeshes()].flatMap((mesh) => {
    const instance = (mesh.metadata as ModelPlaceholderMeta | null)?.[MODEL_INSTANCE_KEY];
    return instance ? [instance] : [];
  });
  const groups = instances.flatMap((instance) => instance.groups);
  binding.slotAnimationGroups ??= new Map();
  binding.slotAnimationGroups.set(slotId, groups);
  for (const instance of instances) {
    instance.bundle.releaseWith(() => {
      const current = binding.slotAnimationGroups?.get(slotId);
      if (!current) return;
      const remaining = current.filter((group) => !instance.groups.includes(group));
      if (remaining.length) binding.slotAnimationGroups!.set(slotId, remaining);
      else binding.slotAnimationGroups!.delete(slotId);
    });
  }
  replayPendingAnimState(scene, binding, slotId);
}

/** True when name-match retarget keeps at least one channel. */
export async function animationRetargetHasMatches(
  engine: AbstractEngine,
  sourceBytes: Uint8Array,
  targetBytes: Uint8Array,
  clipName: string,
): Promise<boolean> {
  const scene = new Scene(engine);
  try {
    return await animationRetargetHasMatchesOnScene(
      scene,
      sourceBytes,
      targetBytes,
      clipName,
    );
  } finally {
    scene.dispose();
  }
}

async function animationRetargetHasMatchesOnScene(
  scene: Scene,
  sourceBytes: Uint8Array,
  targetBytes: Uint8Array,
  clipName: string,
): Promise<boolean> {
  if (!isGltfModelBytes(sourceBytes) || !isGltfModelBytes(targetBytes)) {
    return false;
  }
  let sourceContainer: Awaited<ReturnType<typeof loadGlbContainer>> | undefined;
  let targetContainer: Awaited<ReturnType<typeof loadGlbContainer>> | undefined;
  try {
    sourceContainer = await loadGlbContainer(scene, sourceBytes, "retarget-src.glb");
    targetContainer = await loadGlbContainer(scene, targetBytes, "retarget-dst.glb");
    const instance = targetContainer.instantiateModelsToScene(
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
    if (!sourceGroup || !root) {
      instance.dispose();
      return false;
    }
    const retargeted = retargetAnimationGroupWithMeshProxy(sourceGroup, root);
    const matched = retargeted != null;
    retargeted?.dispose();
    instance.dispose();
    return matched;
  } catch {
    return false;
  } finally {
    sourceContainer?.dispose();
    targetContainer?.dispose();
  }
}
