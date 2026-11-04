import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { TransformNode } from "@babylonjs/core/Meshes/transformNode";

/**
 * The pivot node of each unbounded Tilemap root (`createTilemapMeshes`): the
 * node its chunk meshes hang under, offset so the map's pivot sits on the root.
 */
const pivotNodes = new WeakMap<AbstractMesh, TransformNode>();

export function setTilemapPivotNode(root: AbstractMesh, node: TransformNode): void {
  pivotNodes.set(root, node);
}

/** Where a Tilemap root's chunk meshes hang: its pivot node (unbounded maps), else the root itself. */
export function tilemapChunkParent(root: AbstractMesh): AbstractMesh | TransformNode {
  const node = pivotNodes.get(root);
  return node && !node.isDisposed() ? node : root;
}

/** A Tilemap root's own layer draws (`metadata.tilemapLayer`): its chunk meshes, never another actor's. */
export function tilemapLayerMeshes(root: AbstractMesh): AbstractMesh[] {
  return tilemapChunkParent(root).getChildMeshes(true).filter((child) => child.metadata?.tilemapLayer);
}
