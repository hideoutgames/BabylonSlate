import { HemisphericLight, Vector3, type Scene } from "@babylonjs/core";

/** Scene-owned studio lighting for isolated asset previews. */
export function createPreviewLighting(scene: Scene): void {
  const key = new HemisphericLight(
    "materialPreviewLight",
    new Vector3(0.4, 1, 0.6),
    scene,
  );
  key.intensity = 1.1;
  const fill = new HemisphericLight(
    "materialPreviewFill",
    new Vector3(-0.6, -0.4, -0.8),
    scene,
  );
  fill.intensity = 0.35;
}
