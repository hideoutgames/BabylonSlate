import "./gltf-loader";
import type {
  AbstractEngine,
  AbstractMesh,
  AssetContainer,
  InstantiatedEntries,
  Node,
} from "@babylonjs/core";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { LoadAssetContainerAsync } from "@babylonjs/core/Loading/sceneLoader";
import { Scene } from "@babylonjs/core/scene";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { normalizeModelImportScale, type PackedTextureSlimProof } from "@babylonslate/assets";
import { applyAnimStateToScene,
  sceneAnimHostFromBinding,
  type NamedSeekableGroup,
} from "./anim-apply";
import { gltfLoaderExtension, isGltfModelBytes, packedGltfBytes, gpuModelBytes } from "./model-mesh";
import { retargetAnimationGroupWithMeshProxy } from "./node-rig";
import type { SnapshotSceneBinding } from "./snapshot-apply";
import { RENDERING_GROUP } from "./sorting";
import { accountedGeometryBytes } from "./perf-ceilings";

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
  [MODEL_PLACEHOLDER_KEY]?: boolean;
  [MODEL_INSTANCE_KEY]?: InstantiatedEntries;
  [MODEL_LOAD_KEY]?: string;
};

type CachedGlb = {
  byteLength: number;
  accounted: number;
  load: Promise<AssetContainer>;
};

type SceneGlbCache = {
  loadCount: number;
  accountedBytes: number;
  entries: Map<string, CachedGlb>;
};

const glbCaches = new WeakMap<Scene, SceneGlbCache>();

function cacheFor(scene: Scene): SceneGlbCache {
  let cache = glbCaches.get(scene);
  if (!cache) {
    cache = { loadCount: 0, accountedBytes: 0, entries: new Map() };
    glbCaches.set(scene, cache);
    scene.onDisposeObservable.addOnce(() => {
      for (const entry of cache!.entries.values()) {
        void entry.load.then((container) => container.dispose()).catch(() => {});
      }
      cache!.entries.clear();
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

function modelLoadKey(guid: string, bytes: Uint8Array, importScale: number): string {
  return `${guid}:${bytes.byteLength}:${importScale}`;
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
    group.dispose?.();
  }
  binding.slotAnimationGroups?.delete(slotId);
}

/** Cancel in-flight GLB animation loads and dispose registered groups. */
export function invalidateSlotAnimLoad(
  binding: ModelAnimLoadBinding,
  slotId: number,
): void {
  bumpSlotAnimEpoch(binding, slotId);
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

async function loadGlbContainer(scene: Scene, bytes: Uint8Array, name: string) {
  return LoadAssetContainerAsync(packedGltfBytes(bytes), scene, {
    pluginExtension: gltfLoaderExtension(bytes),
    name,
  });
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

function getCachedGlbContainer(
  scene: Scene,
  guid: string,
  bytes: Uint8Array,
  payload?: unknown,
  packed?: PackedTextureSlimProof | null,
): Promise<AssetContainer> {
  const loadBytes = gpuModelBytes(bytes, payload, packed);
  const cache = cacheFor(scene);
  const existing = cache.entries.get(guid);
  if (existing && existing.byteLength === loadBytes.byteLength) {
    return existing.load;
  }
  if (existing) {
    cache.accountedBytes = Math.max(0, cache.accountedBytes - existing.accounted);
    void existing.load.then((container) => container.dispose()).catch(() => {});
  }
  cache.loadCount += 1;
  const load = loadGlbContainer(scene, loadBytes, `${guid}.glb`).then(
    (container) => {
      const current = cache.entries.get(guid);
      if (current && current.load === load) {
        current.accounted = accountedAssetContainerGeometry(container);
        cache.accountedBytes += current.accounted;
      }
      return container;
    },
  );
  cache.entries.set(guid, {
    byteLength: loadBytes.byteLength,
    accounted: 0,
    load,
  });
  return load;
}

function wrapGroup(
  group: {
    name: string;
    from: number;
    to: number;
    start?(loop?: boolean): void;
    play?(loop?: boolean): void;
    pause(): void;
    stop(): void;
    goToFrame(frame: number): void;
    setWeightForAllAnimatables?(weight: number): void;
    dispose(): void;
  },
  clipAssetGuid: string,
): NamedSeekableGroup & { dispose(): void } {
  // `stop()` drops animatables so later `goToFrame` is a no-op. Start (or keep
  // a loader-started group) then pause so Play can seek idle without auto-advance.
  if (typeof group.start === "function") {
    group.start(true);
  } else {
    group.play?.(true);
  }
  group.pause();
  group.setWeightForAllAnimatables?.(0);
  return {
    name: group.name,
    from: group.from,
    to: group.to,
    clipAssetGuid,
    pause: () => group.pause(),
    goToFrame: (frame) => group.goToFrame(frame),
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
  meta[MODEL_INSTANCE_KEY]?.dispose();
  meta[MODEL_INSTANCE_KEY] = undefined;
}

function keepSourceName(sourceName: string): string {
  return sourceName;
}

function instantiateUnderPlaceholder(
  placeholder: AbstractMesh,
  container: AssetContainer,
  importScale: number,
): InstantiatedEntries {
  disposePlaceholderInstance(placeholder);
  const instance = container.instantiateModelsToScene(keepSourceName, true, {
    doNotInstantiate: true,
  });
  const wrapper = applyModelImportScale(placeholder, importScale);
  for (const node of instance.rootNodes) {
    node.parent = wrapper;
  }
  const group = placeholder.renderingGroupId;
  for (const child of placeholder.getChildMeshes()) {
    child.renderingGroupId = group;
  }
  asPlaceholderMeta(placeholder)[MODEL_INSTANCE_KEY] = instance;
  hideModelPlaceholder(placeholder);
  return instance;
}

/**
 * Load the Model GLB once per Scene+guid, then instantiate under the named
 * actor root. Groups stay paused for Play seeks.
 */
export function beginSlotModelAnimLoad(
  scene: Scene,
  binding: ModelAnimLoadBinding,
  slotId: number,
  clipAssetGuid: string,
  bytes: Uint8Array,
  placeholder: AbstractMesh,
  onAdopted?: (placeholder: AbstractMesh) => void,
): Promise<void> {
  if (!isGltfModelBytes(bytes)) {
    return Promise.resolve();
  }
  const importScale = normalizeModelImportScale(
    binding.modelPayloads?.get(clipAssetGuid)?.importScale,
  );
  const key = modelLoadKey(clipAssetGuid, bytes, importScale);
  const meta = asPlaceholderMeta(placeholder);
  if (meta[MODEL_LOAD_KEY] === key && meta[MODEL_INSTANCE_KEY]) {
    return Promise.resolve();
  }
  const epoch = bumpSlotAnimEpoch(binding, slotId);
  const load = (async () => {
    try {
      const container = await getCachedGlbContainer(
        scene,
        clipAssetGuid,
        bytes,
        binding.modelPayloads?.get(clipAssetGuid),
        packedSlimProof(binding),
      );
      if (binding.slotAnimEpoch?.get(slotId) !== epoch) {
        return;
      }
      if (placeholder.isDisposed()) {
        return;
      }
      const instance = instantiateUnderPlaceholder(
        placeholder,
        container,
        importScale,
      );
      meta[MODEL_LOAD_KEY] = key;
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
      const wrapped = instance.animationGroups.map((group) =>
        wrapGroup(group, clipGuids?.get(group.name) ?? clipAssetGuid),
      );
      for (const row of retargets) {
        const sourceBytes = binding.modelBytes?.get(row.sourceModelGuid);
        if (!sourceBytes || !isGltfModelBytes(sourceBytes)) continue;
        const sourceContainer = await getCachedGlbContainer(
          scene,
          row.sourceModelGuid,
          sourceBytes,
          binding.modelPayloads?.get(row.sourceModelGuid),
          packedSlimProof(binding),
        );
        if (binding.slotAnimEpoch?.get(slotId) !== epoch) {
          return;
        }
        const sourceGroup = sourceContainer.animationGroups.find(
          (group) => group.name === row.clipName,
        );
        if (sourceGroup) {
          const retargeted = retargetAnimationGroupWithMeshProxy(
            sourceGroup,
            placeholder,
          );
          if (retargeted) {
            wrapped.push(wrapGroup(retargeted, row.animationGuid));
          }
        }
      }
      binding.slotAnimationGroups.set(slotId, [...existing, ...wrapped]);
      onAdopted?.(placeholder);
      replayPendingAnimState(scene, binding, slotId);
    } catch {
      // Loader / instantiate failures leave the empty named root in place.
    }
  })();
  if (!binding.slotAnimLoads) binding.slotAnimLoads = new Map();
  const previous = binding.slotAnimLoads.get(slotId) ?? Promise.resolve();
  const chained = previous.then(() => load);
  binding.slotAnimLoads.set(slotId, chained);
  return chained;
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
    sourceContainer = await getCachedGlbContainer(
      scene,
      "retarget-src",
      sourceBytes,
    );
    targetContainer = await getCachedGlbContainer(
      scene,
      "retarget-dst",
      targetBytes,
    );
    const instance = targetContainer.instantiateModelsToScene(
      keepSourceName,
      true,
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
  }
}
