import "@babylonjs/loaders/glTF/2.0/glTFLoader";
import type { AbstractMesh, Node, Scene, TransformNode } from "@babylonjs/core";
import { LoadAssetContainerAsync } from "@babylonjs/core/Loading/sceneLoader";
import { applyAnimStateToScene,
  sceneAnimHostFromBinding,
  type NamedSeekableGroup,
} from "./anim-apply";
import { gltfLoaderExtension, isGltfModelBytes } from "./model-mesh";
import type { SnapshotSceneBinding } from "./snapshot-apply";

function bumpSlotAnimEpoch(
  binding: SnapshotSceneBinding,
  slotId: number,
): number {
  if (!binding.slotAnimEpoch) binding.slotAnimEpoch = new Map();
  const next = (binding.slotAnimEpoch.get(slotId) ?? 0) + 1;
  binding.slotAnimEpoch.set(slotId, next);
  return next;
}

export function disposeSlotAnimationGroups(
  binding: SnapshotSceneBinding,
  slotId: number,
): void {
  for (const group of binding.slotAnimationGroups?.get(slotId) ?? []) {
    group.dispose?.();
  }
  binding.slotAnimationGroups?.delete(slotId);
}

/** Cancel in-flight GLB animation loads and dispose registered groups. */
export function invalidateSlotAnimLoad(
  binding: SnapshotSceneBinding,
  slotId: number,
): void {
  bumpSlotAnimEpoch(binding, slotId);
  disposeSlotAnimationGroups(binding, slotId);
}

function replayPendingAnimState(
  scene: Scene,
  binding: SnapshotSceneBinding,
  slotId: number,
): void {
  const pending = binding.pendingAnimState?.get(slotId);
  if (!pending) return;
  applyAnimStateToScene(
    sceneAnimHostFromBinding(binding, {
      animationGroups: scene.animationGroups,
      spritePayloads: binding.spritePayloads,
    }),
    pending,
  );
  binding.slotAnimReady?.(slotId);
}

async function loadGlbContainer(scene: Scene, bytes: Uint8Array, name: string) {
  return LoadAssetContainerAsync(bytes, scene, {
    pluginExtension: gltfLoaderExtension(bytes),
    name,
  });
}

function wrapGroup(
  group: {
    name: string;
    from: number;
    to: number;
    pause(): void;
    stop(): void;
    goToFrame(frame: number): void;
    setWeightForAllAnimatables?(weight: number): void;
    dispose(): void;
  },
  clipAssetGuid: string,
): NamedSeekableGroup & { dispose(): void } {
  group.stop();
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
  placeholder.visibility = 0;
}

/**
 * Load the full glTF container for a Play slot. Keeps the sync first-primitive
 * mesh until the container is ready, then registers paused groups and replays
 * the last animState. Runs even when the file has no clips so untextured stubs
 * are replaced by the authored hierarchy.
 */
export function beginSlotModelAnimLoad(
  scene: Scene,
  binding: SnapshotSceneBinding,
  slotId: number,
  clipAssetGuid: string,
  bytes: Uint8Array,
  placeholder: AbstractMesh,
  onAdopted?: (placeholder: AbstractMesh) => void,
): Promise<void> {
  if (!isGltfModelBytes(bytes)) {
    return Promise.resolve();
  }
  const epoch = bumpSlotAnimEpoch(binding, slotId);
  const load = (async () => {
    let container: Awaited<ReturnType<typeof loadGlbContainer>> | undefined;
    try {
      container = await loadGlbContainer(scene, bytes, `${clipAssetGuid}.glb`);
      if (binding.slotAnimEpoch?.get(slotId) !== epoch) {
        container.dispose();
        return;
      }
      if (placeholder.isDisposed()) {
        container.dispose();
        return;
      }
      container.addAllToScene();
      adoptLoadedHierarchy(placeholder, container);
      if (!binding.slotAnimationGroups) binding.slotAnimationGroups = new Map();
      const existing = (binding.slotAnimationGroups.get(slotId) ?? []).filter(
        (group) => group.clipAssetGuid !== clipAssetGuid,
      );
      const wrapped = container.animationGroups.map((group) =>
        wrapGroup(group, clipAssetGuid),
      );
      binding.slotAnimationGroups.set(slotId, [...existing, ...wrapped]);
      onAdopted?.(placeholder);
      replayPendingAnimState(scene, binding, slotId);
    } catch {
      container?.dispose();
    }
  })();
  if (!binding.slotAnimLoads) binding.slotAnimLoads = new Map();
  const previous = binding.slotAnimLoads.get(slotId) ?? Promise.resolve();
  const chained = previous.then(() => load);
  binding.slotAnimLoads.set(slotId, chained);
  return chained;
}
