import { Color4, NullEngine, Scene } from "@babylonjs/core";

export function createTestEngine(): { engine: NullEngine; scene: Scene } {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  // Match dark shell --background (#141414).
  scene.clearColor = new Color4(20 / 255, 20 / 255, 20 / 255, 1);
  return { engine, scene };
}
