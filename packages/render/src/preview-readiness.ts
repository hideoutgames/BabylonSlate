import type { AbstractMesh } from "@babylonjs/core";
import { SCENE_SHADER_WARM_TIMEOUT_MS } from "./scene-perf";
import { visualMeshes } from "./visual-meshes";

/** Compile only drawn preview parts, excluding hidden placeholders and other Scenes. */
export function previewMeshesReady(root: AbstractMesh): boolean {
  if (root.isDisposed()) return false;
  return visualMeshes(root)
    .filter((mesh) => mesh.isEnabled() && mesh.isVisible && mesh.visibility > 0)
    .every((mesh) => mesh.isReady(true));
}

/** One-shot captures need shader/texture readiness without a later interaction. */
export async function waitForPreviewMeshesReady(
  root: AbstractMesh,
): Promise<boolean> {
  const deadline = Date.now() + SCENE_SHADER_WARM_TIMEOUT_MS;
  while (!root.isDisposed()) {
    if (previewMeshesReady(root)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise<void>((resolve) => setTimeout(resolve, 16));
  }
  return false;
}
