import type { Node } from "@babylonjs/core/node";

/**
 * The meshes Play builds as 3D visuals (`finishPlayWorldMesh` in `snapshot-visual-factory.ts`: MeshComponent
 * primitives and models, Text3D, cables, colliders and helpers), as opposed to 2D layer content (2D components,
 * sprites, tilemaps), which sorts by Z-Order. A Scene Layer Material (compiled `overlay`) whose blend mode is Opaque or
 * Masked draws such a mesh as the world would: in its rendering group's opaque or alpha-tested list, with depth writes,
 * so 3D meshes in a layer occlude each other (`material-compiler.ts`). Marked on the visual's root; a model's parts,
 * which load after it, are found through their parents.
 */
const visuals = new WeakSet<Node>();

export function markLayerDepthVisual(root: Node): void {
  visuals.add(root);
}

/** Whether `mesh` is, or belongs to, a 3D visual (`markLayerDepthVisual`). */
export function isLayerDepthVisual(mesh: Node): boolean {
  for (let node: Node | null = mesh; node; node = node.parent) {
    if (visuals.has(node)) return true;
  }
  return false;
}
