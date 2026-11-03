import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { Scene } from "@babylonjs/core/scene";

/**
 * Scene-owned studio lighting for isolated asset previews and thumbnails: a directional key from the upper right of
 * the preview camera's default view, about square to it so the subject shows its form and one clear highlight, and a
 * weak hemispheric fill that keeps the shadow side readable. One light of each, as the lighting block draws them (it
 * holds one fill), so a preview looks the same on either lighting path.
 */
export function createPreviewLighting(scene: Scene): void {
  const key = new DirectionalLight("materialPreviewLight", new Vector3(-0.96, -1.08, -0.02).normalize(), scene);
  key.intensity = 2;
  const fill = new HemisphericLight("materialPreviewFill", Vector3.Up(), scene);
  fill.diffuse = new Color3(0.35, 0.35, 0.35);
  fill.groundColor = new Color3(0.15, 0.15, 0.15);
}
