import { NullEngine, Scene } from "@babylonjs/core";
import {
  editorClearColor,
  type EditorColorScheme,
} from "./editor-clear-color";

export function createTestEngine(
  scheme: EditorColorScheme = "dark",
): { engine: NullEngine; scene: Scene } {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  scene.clearColor = editorClearColor(scheme);
  return { engine, scene };
}
