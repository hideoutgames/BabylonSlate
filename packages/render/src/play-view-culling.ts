import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { InstancedMesh } from "@babylonjs/core/Meshes/instancedMesh";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { Scene } from "@babylonjs/core/scene";
import { isSkyboxMesh } from "./skybox";

/**
 * View culling for Play's world Scene. Babylon's Intermediate performance priority (Play's) marks every mesh it
 * constructs `alwaysSelectAsActiveMesh`, so the camera's cull would submit every enabled, visible mesh each frame,
 * behind the camera included. Play clears that mark on the meshes whose bounds the cull can trust, once each, before
 * the next cull (`settlePlayViewCulling`, from the forward graph's cull task): Babylon sets it after the mesh is
 * announced, and the engine's own always-drawn meshes (`drawWhateverTheView`) set it after construction too.
 *
 * Kept always drawn: those the engine marks (particle emitters, whose particles draw while the emitter is off screen;
 * debug overlays), meshes without geometry (they draw nothing), skyboxes and infinite-distance meshes, meshes whose
 * vertices a pose moves and no bounds follow (skinning, morph targets, baked vertex animation) and thin instances
 * whose bounds hold the source mesh alone (Babylon's, unless refreshed); a regular instance as its source.
 *
 * Culled like any mesh, as the editor's view culls them: those whose bounds are made to hold what their vertex stage
 * does. A Material's padded bounds (`applyMaterialBounds`), a lattice's cage (`setMaterialBoundsExpansion`), water's
 * wave reach (`updateDynamicMaterialBounds`) and foliage cells, whose bounds hold every instance
 * (`markBoundsHoldInstances`).
 */

const alwaysDrawn = new WeakSet<AbstractMesh>();
const instanceBounds = new WeakSet<AbstractMesh>();

/** Marks `mesh` drawn whatever the camera's view, in every Scene (the culling below never clears it). */
export function drawWhateverTheView(mesh: AbstractMesh): void {
  alwaysDrawn.add(mesh);
  mesh.alwaysSelectAsActiveMesh = true;
}

/**
 * Marks a mesh whose bounds were refreshed to hold every one of its thin instances
 * (`thinInstanceRefreshBoundingInfo`), which change no more: the cull can trust them.
 */
export function markBoundsHoldInstances(mesh: AbstractMesh): void {
  instanceBounds.add(mesh);
}

/**
 * Whether the cull must draw `mesh` whatever the view. A regular instance is culled by its own bounds (its source's
 * geometry through its world matrix) unless its source's vertices can leave them.
 */
export function keepsDrawingOutsideView(mesh: AbstractMesh): boolean {
  if (alwaysDrawn.has(mesh) || mesh.infiniteDistance || isSkyboxMesh(mesh)) return true;
  const source = mesh instanceof InstancedMesh ? mesh.sourceMesh : mesh;
  if (!(source instanceof Mesh) || source.getTotalVertices() === 0) return true;
  if (source.hasThinInstances && !instanceBounds.has(source)) return true;
  // A pose moves these vertices on the GPU, and nothing moves their bounds with it.
  return !!source.skeleton || !!source.morphTargetManager || !!source.bakedVertexAnimationManager;
}

/** Per culled Scene, the meshes already settled (each is settled once). */
const cullings = new WeakMap<Scene, WeakSet<AbstractMesh>>();

/** Culls `scene`'s meshes by view from its next cull on; returns the release. */
export function installPlayViewCulling(scene: Scene): () => void {
  const settled = new WeakSet<AbstractMesh>();
  cullings.set(scene, settled);
  return () => {
    if (cullings.get(scene) === settled) cullings.delete(scene);
  };
}

/**
 * Clears Intermediate's always-drawn mark on `scene`'s meshes not settled yet; a no-op elsewhere. Babylon announces
 * some new meshes only on a later task, so this walks the Scene's list, as the cull does after it.
 */
export function settlePlayViewCulling(scene: Scene): void {
  const settled = cullings.get(scene);
  if (!settled) return;
  for (const mesh of scene.meshes) {
    if (settled.has(mesh)) continue;
    settled.add(mesh);
    if (mesh.alwaysSelectAsActiveMesh && !keepsDrawingOutsideView(mesh)) mesh.alwaysSelectAsActiveMesh = false;
  }
}
