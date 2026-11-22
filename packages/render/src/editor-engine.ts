import { createSceneEngine, type CreateEngineOptions, type EngineHandle } from "./create-engine";
import { editorEngineFeatures } from "./editor-engine-features";

/**
 * Creates an editor or Play view in the editor, with the editor-only subsystems available (`editorEngineFeatures`).
 * The exported game creates its view with `createGameEngine`, which shares the same setup without them.
 */
export function createEngine(canvas: HTMLCanvasElement, options: CreateEngineOptions = {}): EngineHandle {
  return createSceneEngine(canvas, options, editorEngineFeatures);
}
