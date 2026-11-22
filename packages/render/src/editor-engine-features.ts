import type { Scene } from "@babylonjs/core/scene";
import { EditorSceneSync, type EditorSceneSyncOptions } from "./editor-scene-sync";
import { createEditorViewportTools, type EditorViewportToolsContext } from "./editor-viewport-tools";
import type { RenderScheduler } from "./render-scheduler";
import { createRuntimeTransformTools } from "./runtime-transform-tools";
import { ViewportShadingOverlay } from "./viewport-shading-mode";

/**
 * The editor-only subsystems a scene view constructs: document sync, viewport shading, the viewport's camera, gizmos
 * and gestures, and Play's runtime transform tools. `createSceneEngine` reaches them only through this object, so the
 * exported game (`createGameEngine`, which passes none) never bundles them.
 */
export interface EditorEngineFeatures {
  createSceneSync(scene: Scene, scheduler: Pick<RenderScheduler, "invalidate">, options: EditorSceneSyncOptions): EditorSceneSync;
  createViewportShading(scene: Scene): ViewportShadingOverlay;
  createViewportTools(context: EditorViewportToolsContext): ReturnType<typeof createEditorViewportTools>;
  createRuntimeTransformTools: typeof createRuntimeTransformTools;
}

export const editorEngineFeatures: EditorEngineFeatures = {
  createSceneSync: (scene, scheduler, options) => new EditorSceneSync(scene, scheduler, options),
  createViewportShading: (scene) => new ViewportShadingOverlay(scene),
  createViewportTools: createEditorViewportTools,
  createRuntimeTransformTools,
};
