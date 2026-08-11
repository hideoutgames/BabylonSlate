import { Color4, NullEngine, Scene } from "@babylonjs/core";

export function createTestEngine(): { engine: NullEngine; scene: Scene } {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  // Match dark shell --background (Minimal Neutral oklch(0.145 0 0) ≈ #252525).
  scene.clearColor = new Color4(37 / 255, 37 / 255, 37 / 255, 1);
  return { engine, scene };
}
