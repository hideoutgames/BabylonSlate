import type { Mesh, Scene } from "@babylonjs/core";
import { emptySkyboxFaces } from "@babylonslate/core";
import { createSkyboxMesh, resolveSkyboxCubeTexture } from "./skybox";

export const PREVIEW_SKYBOX_MESH_NAME = "previewSkybox";

/**
 * Interactive previews (Model, Animation, Skeleton, Material, opt-in
 * Particle) share the engine default skybox — the same cube the default
 * Scene's SkyboxComponent resolves through `resolveSkyboxCubeTexture`, so
 * the per-engine texture is shared rather than re-uploaded per preview.
 *
 * Prefab Preview opts out (black clear); thumbnail and hidden retarget
 * hosts never call this. The skybox is background chrome, not the subject
 * under preview, so it stays out of preview readiness gating: it draws as
 * soon as its faces load rather than holding the first frame.
 */
export function installPreviewEnvironment(scene: Scene): Mesh {
  return createSkyboxMesh(
    scene,
    PREVIEW_SKYBOX_MESH_NAME,
    resolveSkyboxCubeTexture(scene, emptySkyboxFaces()),
  );
}
