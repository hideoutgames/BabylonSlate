import { LinesMesh, type AbstractMesh } from "@babylonjs/core";
import { isEditorHelperMesh } from "./helper-mesh";
import { isSkyboxMesh } from "./skybox";
import { hasMeshLatticeDeformer } from "./lattice-deformer-binding";
export type ShadowParticipation = {
  castShadows?: boolean;
  receiveShadows?: boolean;
};
export function authoredShadowParticipation(
  mesh: AbstractMesh,
): ShadowParticipation {
  for (
    let node = mesh as import("@babylonjs/core").Node | null;
    node;
    node = node.parent
  ) {
    if (node.metadata?.slateShadowParticipation)
      return node.metadata.slateShadowParticipation as ShadowParticipation;
  }
  return {};
}
/** Visible geometry-less particle emitters would otherwise refresh shadow maps every frame. */
const PARTICLE_EMITTER_PREFIX = "particleEmitter:";

export function participatesInShadows(mesh: AbstractMesh): boolean {
  // A LOD level is drawn by its master's shadow-map entry.
  if (mesh.isBlocked) return false;
  if (mesh.name.startsWith("__")) return false;
  if (isSkyboxMesh(mesh)) return false;
  if (mesh instanceof LinesMesh) return false;
  if (mesh.name.startsWith(PARTICLE_EMITTER_PREFIX)) return false;
  return !isEditorHelperMesh(mesh);
}

/** Bind-pose bounds cannot certify where GPU-deformed vertices will be. */
export function hasDeformingShadowBounds(mesh: AbstractMesh): boolean {
  return (
    hasMeshLatticeDeformer(mesh) ||
    !!mesh.skeleton ||
    !!mesh.morphTargetManager ||
    Number(mesh.material?.metadata?.boundsPadding ?? 0) > 0
  );
}
