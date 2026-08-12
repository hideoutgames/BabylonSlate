import { NullEngine, Scene } from "@babylonjs/core";
import { EDITOR_CLEAR_COLOR } from "./editor-clear-color";

export function createTestEngine(): { engine: NullEngine; scene: Scene } {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  scene.clearColor = EDITOR_CLEAR_COLOR.clone();
  return { engine, scene };
}
