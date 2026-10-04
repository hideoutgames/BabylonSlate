import { LinesMesh, type AbstractMesh } from "@babylonjs/core";
import { isEditorHelperMesh } from "./helper-mesh";
import { isSkyboxMesh } from "./skybox";
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

/**
 * Water surfaces receive shadows but never cast them: they are alpha-blended and displaced in the vertex shader, so
 * they would draw nothing useful into a map, yet as casters their dynamic geometry would force every local shadow map
 * to refresh each frame and split large grids into extra draws. This holds even when authored participation casts.
 */
export function neverCastsShadows(mesh: AbstractMesh): boolean {
  return (mesh.metadata as { slateWater?: unknown } | null)?.slateWater === true;
}

/** Bind-pose bounds cannot certify where GPU-deformed vertices will be. */
export function hasDeformingShadowBounds(mesh: AbstractMesh): boolean {
  return (
    !!mesh.skeleton ||
    !!mesh.morphTargetManager ||
    Number(mesh.material?.metadata?.boundsPadding ?? 0) > 0
  );
}
