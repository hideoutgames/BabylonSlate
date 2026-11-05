import type { Camera } from "@babylonjs/core/Cameras/camera";

/**
 * Cameras of planar reflection passes (Mirrors, planar water: `PlanarMirrorCamera`). The light block draws such a
 * camera's sun shadow only from cascades of its own (`SceneShadowController.attachView`, Reflection Shadows): the scene
 * view's are fitted to the scene camera and chosen by its view depth, so they would miss, or misplace, what only the
 * reflection shows.
 */
const reflectionCameras = new WeakSet<Camera>();

export function markReflectionCamera(camera: Camera): void {
  reflectionCameras.add(camera);
}

export function isReflectionCamera(camera: Camera | null | undefined): boolean {
  return !!camera && reflectionCameras.has(camera);
}
