import { LinesMesh, type AbstractMesh } from "@babylonjs/core";
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
const SHADOW_SKIP_NAME_PREFIXES = [
  "debugLight:",
  "debugCamera",
  "navmeshDebug",
  "playConsoleViz:",
] as const;
function shadowSkipMetadata(mesh: AbstractMesh): boolean {
  const meta = mesh.metadata as {
    editorActorOrigin?: boolean;
    editorPickProxy?: boolean;
    editorBillboard?: string;
    editorVolume?: boolean;
    editorColliderVisual?: boolean;
    playHelperVisual?: boolean;
    playActorOrigin?: boolean;
    playDebugOverlay?: boolean;
  } | null;
  if (!meta) return false;
  return Boolean(
    meta.editorActorOrigin ||
    meta.editorPickProxy ||
    meta.editorBillboard ||
    meta.editorVolume ||
    meta.editorColliderVisual ||
    meta.playHelperVisual ||
    meta.playActorOrigin ||
    meta.playDebugOverlay,
  );
}

export function participatesInShadows(mesh: AbstractMesh): boolean {
  if (mesh.name.startsWith("__")) return false;
  if (isSkyboxMesh(mesh)) return false;
  if (mesh instanceof LinesMesh) return false;
  if (
    SHADOW_SKIP_NAME_PREFIXES.some((prefix) => mesh.name.startsWith(prefix))
  ) {
    return false;
  }
  return !shadowSkipMetadata(mesh);
}

/** Bind-pose bounds cannot certify where GPU-deformed vertices will be. */
export function hasDeformingShadowBounds(mesh: AbstractMesh): boolean {
  return (
    !!mesh.skeleton ||
    !!mesh.morphTargetManager ||
    Number(mesh.material?.metadata?.boundsPadding ?? 0) > 0
  );
}
