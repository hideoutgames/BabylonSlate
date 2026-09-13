import { resolveShadowSettings, type ShadowOverrides, resolveCelShadingSettings, type CelShadingOverrides, type RenderProjectSettings } from "@babylonslate/core";

/** Only effective rendering changes rebuild GPU scene resources. */
export function sceneViewportRenderSettingsKey(
  project: Partial<RenderProjectSettings> = {},
  overrides?: CelShadingOverrides,
  shadowOverrides?: ShadowOverrides,
): string {
  return JSON.stringify({
    ...project,
    mode: project.mode ?? "pbr",
    shadows: resolveShadowSettings(project.shadows, shadowOverrides),
    cel: project.mode === "cel"
      ? resolveCelShadingSettings(project.cel, overrides)
      : undefined,
  });
}

export const SCENE_LOAD_PHASES = [
  "Preparing Scene",
  "Loading Document",
  "Realizing Scene",
  "Collecting Assets",
  "Loading Models",
  "Warming Shaders",
  "Presenting First Frame",
] as const;

export type SceneViewportLoadPhase = (typeof SCENE_LOAD_PHASES)[number];

/** First open / viewport remount for this engine generation — not gizmo apply. */
export function isSceneViewportRemountLoad(
  engineGeneration: number,
  completedGeneration: number,
): boolean {
  return engineGeneration !== completedGeneration;
}

export { waitForSceneLoadingPaint } from "@babylonslate/render";
import { waitForSceneLoadingPaint } from "@babylonslate/render";

export async function runSceneViewportBlockingLoad(options: {
  signal: AbortSignal;
  realize: () => void;
  collect: () => Promise<void>;
  whenModelsReady: () => Promise<void>;
  warmShaders: () => Promise<void>;
  presentFirstFrame: () => Promise<void>;
  onProgress: (value: number, phase: SceneViewportLoadPhase) => void;
}): Promise<void> {
  options.signal.throwIfAborted();
  options.onProgress(0, "Preparing Scene");
  await waitForSceneLoadingPaint(options.signal);
  options.signal.throwIfAborted();
  options.onProgress(10, "Realizing Scene");
  options.realize();
  options.signal.throwIfAborted();
  options.onProgress(20, "Collecting Assets");
  await options.collect();
  options.signal.throwIfAborted();
  options.onProgress(45, "Loading Models");
  await options.whenModelsReady();
  options.signal.throwIfAborted();
  options.onProgress(70, "Warming Shaders");
  await options.warmShaders();
  options.signal.throwIfAborted();
  options.onProgress(90, "Presenting First Frame");
  // Cached assets can finish all readiness work in one microtask batch. Give
  // the blocking phase a paint before a permitted frame can close the dialog.
  await waitForSceneLoadingPaint(options.signal);
  options.signal.throwIfAborted();
  await options.presentFirstFrame();
  options.signal.throwIfAborted();
  options.onProgress(100, "Presenting First Frame");
}
