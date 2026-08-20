import {
  ArcRotateCamera,
  Color3,
  HemisphericLight,
  Scene,
  Vector3,
} from "@babylonjs/core";

import { DEFAULT_CAMERA_RADIUS } from "./editor-camera";
import { installEngineDefaultMaterial } from "./default-material";

export const DEFAULT_LIGHT_INTENSITY = 0.9;

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

  const light = new HemisphericLight("light", new Vector3(0, 1, 0), scene);
  light.intensity = DEFAULT_LIGHT_INTENSITY;
}

export function setHighlightColor(scene: Scene, color: Color3): void {
  scene.ambientColor = color;
}
