import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { editorClearColor } from "../editor-clear-color";
import { installEngineDefaultMaterial } from "../default-material";

/** A headless Engine and Scene for unit tests: the editor's dark clear colour and the engine default Material. */
export function createTestEngine(): { engine: NullEngine; scene: Scene } {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  scene.clearColor = editorClearColor("dark");
  installEngineDefaultMaterial(scene);
  return { engine, scene };
}
