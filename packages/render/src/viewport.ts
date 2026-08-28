import { ArcRotateCamera, Color3, Scene, Vector3 } from "@babylonjs/core";

import { DEFAULT_CAMERA_RADIUS } from "./editor-camera";
import { installEngineDefaultMaterial } from "./default-material";

/**
 * Scene-only setup, kept apart from the canvas-bound engine factory so it is
 * testable under NullEngine (engineplan section 2.3).
 */
export function setupDefaultViewport(scene: Scene): void {
  installEngineDefaultMaterial(scene);
  const camera = new ArcRotateCamera(
    "camera",
    -Math.PI / 2,
    Math.PI / 2.5,
    DEFAULT_CAMERA_RADIUS,
    Vector3.Zero(),
    scene,
  );
  scene.activeCamera = camera;
}

export function setHighlightColor(scene: Scene, color: Color3): void {
  scene.ambientColor = color;
}
