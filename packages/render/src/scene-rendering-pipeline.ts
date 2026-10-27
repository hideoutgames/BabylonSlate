import type { Scene } from "@babylonjs/core";
import { resolveRenderingPipeline, type ResolvedRenderingPipeline } from "@haptic/core";
import { engineBackendStatus } from "./backend-status";
import { sceneRenderingSettings } from "./render-settings";

/** The backend `scene`'s Engine runs, against the project's request, and why they differ. */
export function sceneRenderingPipeline(scene: Scene): ResolvedRenderingPipeline {
  const engine = scene.getEngine();
  return resolveRenderingPipeline(sceneRenderingSettings(scene).project, {
    gpuBackend: engine.isWebGPU ? "webgpu" : "webgl2",
    reason: engineBackendStatus(engine)?.fallbackReason,
  });
}
