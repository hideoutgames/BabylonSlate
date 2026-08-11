import { Color4, NullEngine, Scene } from "@babylonjs/core";

export function createTestEngine(): { engine: NullEngine; scene: Scene } {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  scene.clearColor = new Color4(0.08, 0.09, 0.11, 1);
  return { engine, scene };
}
