import type { AbstractMesh, InstancedMesh, Material, Mesh, Scene } from "@babylonjs/core";
import { materialIneligibility, sceneInstancePool } from "./instance-pool";

/**
 * Visuals drawn through the instance pool: a slot root or named part stays a `Mesh` without geometry, and its drawn
 * leaf is a pool member at identity under it. What is written to the root for every mesh it draws (its Material)
 * goes through here, so the leaf moves to the group that draws it, or leaves the pool when no group can.
 */

const leaves = new WeakMap<AbstractMesh, InstancedMesh>();

/** Records `leaf` as the pooled drawn leaf of `root`. */
export function attachPooledLeaf(root: Mesh, leaf: InstancedMesh): void {
  leaves.set(root, leaf);
  leaf.onDisposeObservable.addOnce(() => {
    if (leaves.get(root) === leaf) leaves.delete(root);
  });
}

/** The pooled drawn leaf of `root`, if it has one. */
export function pooledLeafOf(root: AbstractMesh): InstancedMesh | undefined {
  const leaf = leaves.get(root);
  return leaf && !leaf.isDisposed() ? leaf : undefined;
}

const ejectListeners = new WeakMap<Scene, Set<(root: AbstractMesh) => void>>();

/**
 * Calls `listener` with the root whose pooled leaf was replaced by a mesh of its own (`ejectPooledLeaf`), so what was
 * keyed by the leaf (outlines, deformers, probes) follows the new mesh; returns the removal.
 */
export function onPooledLeafEjected(scene: Scene, listener: (root: AbstractMesh) => void): () => void {
  let listeners = ejectListeners.get(scene);
  if (!listeners) ejectListeners.set(scene, (listeners = new Set()));
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Replaces `root`'s pooled leaf with a mesh of its own; returns it, or undefined when `root` has none. */
export function ejectPooledLeaf(root: AbstractMesh): Mesh | undefined {
  const leaf = pooledLeafOf(root);
  if (!leaf) return undefined;
  leaves.delete(root);
  const mesh = sceneInstancePool(root.getScene()).eject(leaf);
  for (const listener of [...ejectListeners.get(root.getScene()) ?? []]) listener(root);
  return mesh;
}

/**
 * Assigns `material` to the visual `mesh` draws: the mesh itself, and a pooled leaf by moving it to the group drawn
 * with `material`, or, when no group can draw it (a blended or World Position Offset Material), by replacing the leaf
 * with a mesh of its own, which it returns (the eject listeners refresh what keyed the old leaf).
 */
export function setActorMeshMaterial(mesh: AbstractMesh, material: Material | null): Mesh | undefined {
  mesh.material = material;
  const leaf = pooledLeafOf(mesh);
  if (!leaf) return undefined;
  if (materialIneligibility(leaf.sourceMesh, material ?? mesh.getScene().defaultMaterial)) {
    const own = sceneInstancePool(mesh.getScene()).eject(leaf);
    leaves.delete(mesh);
    own.material = material;
    for (const listener of [...ejectListeners.get(mesh.getScene()) ?? []]) listener(mesh);
    return own;
  }
  sceneInstancePool(mesh.getScene()).update(leaf, { material });
  return undefined;
}

/**
 * Gives `root`'s pooled leaf the visibility and picking written to `root`, which draws nothing itself: Babylon
 * inherits neither flag, and the leaf is what draws and what a pick meets.
 */
export function syncPooledLeafFlags(root: AbstractMesh): void {
  const leaf = pooledLeafOf(root);
  if (!leaf) return;
  leaf.isVisible = root.isVisible;
  leaf.isPickable = root.isPickable;
}

/**
 * Sorts `root`'s pooled leaf as an explicit sorting layer and order sort `root` (`applyComponentSorting`): the leaf,
 * whose submeshes the sorted passes compare, carries the same `alphaIndex` and sorting group, and draws in the group
 * of that order and rendering group.
 */
export function sortPooledLeaf(root: AbstractMesh): void {
  const leaf = pooledLeafOf(root);
  if (!leaf) return;
  const metadata = root.metadata as { sortingGroupId?: string; sortingLayerKey?: number } | null;
  leaf.alphaIndex = root.alphaIndex;
  leaf.metadata = { ...(leaf.metadata as object | null), sortingGroupId: metadata?.sortingGroupId, sortingLayerKey: metadata?.sortingLayerKey ?? 0 };
  sceneInstancePool(root.getScene()).update(leaf, {
    renderingGroupId: root.renderingGroupId,
    sortKey: `${root.alphaIndex}|${metadata?.sortingGroupId ?? ""}|${metadata?.sortingLayerKey ?? 0}`,
  });
}
