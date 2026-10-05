import type { AbstractMesh, Camera, Scene } from "@babylonjs/core";

/** This frame's frustum: Scene.render recomputes camera matrices only after before-render observers run. */
function sees(camera: Camera, mesh: AbstractMesh): boolean {
  camera.getViewMatrix(); camera.getProjectionMatrix();
  return camera.isInFrustum(mesh);
}

/**
 * True when an active camera of the scene sees the mesh's bounds this frame; a scene without a camera counts as
 * seeing it. Safe to call from before-render observers and allocation-free.
 */
export function inActiveView(scene: Scene, mesh: AbstractMesh): boolean {
  const cameras = scene.activeCameras;
  if (cameras && cameras.length > 0) {
    for (let i = 0; i < cameras.length; i++) if (sees(cameras[i]!, mesh)) return true;
    return false;
  }
  const camera = scene.activeCamera;
  return !camera || sees(camera, mesh);
}
