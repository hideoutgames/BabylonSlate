import type { Mesh, Scene } from "@babylonjs/core";
import { emptySkyboxFaces } from "@haptic/core";
import { applyEnvironmentLighting } from "./environment-lighting";
import { createSkyboxMesh, resolveSkyboxCubeTexture } from "./skybox";

export const PREVIEW_SKYBOX_MESH_NAME = "previewSkybox";

/**
 * Interactive previews (Model, Animation, Skeleton, Material, opt-in
 * Particle) share the engine default skybox — the same cube the default
 * Scene's SkyboxComponent resolves through `resolveSkyboxCubeTexture`, so
 * the per-engine texture is shared rather than re-uploaded per preview.
 *
 * The sky also lights the preview, as a Scene with Environment Source Skybox
 * does: without it a metal reflects nothing and draws black. Frame readiness
 * therefore waits for the sky's upload and filtering, so reflections never
 * appear after the first frame.
 *
 * Prefab Preview opts out (black clear); thumbnail and hidden retarget
 * hosts never call this.
 */
export function installPreviewEnvironment(scene: Scene): Mesh {
  const sky = createSkyboxMesh(
    scene,
    PREVIEW_SKYBOX_MESH_NAME,
    resolveSkyboxCubeTexture(scene, emptySkyboxFaces()),
  );
  applyEnvironmentLighting(scene, null, undefined, { skybox: true });
  return sky;
}
