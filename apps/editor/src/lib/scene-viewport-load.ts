import {
  resolveRenderingPipeline,
  resolveShadowSettings,
  type ShadowOverrides,
  resolveCelShadingSettings,
  type CelShadingOverrides,
  type RenderProjectSettings,
  resolveEnvironmentLightingSettings,
  normalizeEnvironmentLightingSettings,
  type EnvironmentLightingOverrides,
  type EnvironmentLightingSettings,
  resolveRenderEffectsSettings,
  type RenderEffectsOverrides,
} from "@haptic/core";
import { holdEncodeQueuePause } from "../services/encode-queue-pause";

/** Requested path changes enter the same shader/presentation barrier as other structural settings. */
export function sceneViewportRenderSettingsKey(
  project: Partial<RenderProjectSettings> = {},
  overrides?: CelShadingOverrides,
  shadowOverrides?: ShadowOverrides,
  environmentOverrides?: EnvironmentLightingOverrides,
  environmentSource: string | null = null,
  effectsOverrides?: RenderEffectsOverrides,
): string {
  return JSON.stringify({
    ...project,
    ...resolveRenderingPipeline(project).requested,
    mode: project.mode ?? "pbr",
    // The Scene's Post Processing overrides change the plan as the project's effects do.
    effects: resolveRenderEffectsSettings(project.effects, effectsOverrides),
    environmentLighting: {
      enabled: resolveEnvironmentLightingSettings(
        project.environmentLighting,
        environmentOverrides,
      ).enabled,
    },
    environmentSource,
    shadows: resolveShadowSettings(project.shadows, shadowOverrides),
    cel:
      project.mode === "cel"
        ? resolveCelShadingSettings(project.cel, overrides)
        : undefined,
  });
}

/** Resource identity stays in the key; live environment scalars use latest defaults. */
export function sceneViewportRenderSettings(
  key: string,
  environmentLighting?: EnvironmentLightingSettings,
): Partial<RenderProjectSettings> {
  const settings = JSON.parse(key) as Partial<RenderProjectSettings> & {
    environmentSource?: string | null;
  };
  delete settings.environmentSource;
  return {
    ...settings,
    environmentLighting:
      normalizeEnvironmentLightingSettings(environmentLighting),
  };
}

export type SceneViewportLoadPhase =
  | "Preparing Scene"
  | "Loading Document"
  | "Collecting Assets"
  | "Realizing Scene"
  | "Loading Models"
  | "Compiling Shaders"
  | "Presenting First Frame";

/** First open / viewport remount for this engine generation — not gizmo apply. */
export function isSceneViewportRemountLoad(
  engineGeneration: number,
  completedGeneration: number,
): boolean {
  return engineGeneration !== completedGeneration;
}

export { waitForSceneLoadingPaint } from "@haptic/render/scene-load-readiness";
import { waitForSceneLoadingPaint, type SceneLoadCount } from "@haptic/render/scene-load-readiness";

/** Two frame intervals at 60 Hz: a load that ran this long after its dialog painted has given the page paints. */
const PAINTED_LOAD_MS = 34;

export async function runSceneViewportBlockingLoad(options: {
  signal: AbortSignal;
  realize: () => void | Promise<void>;
  collect: () => Promise<void>;
  whenModelsReady: () => Promise<void>;
  /** `onCount` counts the warm-up's units as they compile. */
  warmShaders: (onCount: (count: SceneLoadCount) => void) => Promise<void>;
  presentFirstFrame: () => Promise<void>;
  onProgress: (value: number, phase: SceneViewportLoadPhase, count?: SceneLoadCount) => void;
}): Promise<void> {
  options.signal.throwIfAborted();
  // Texture encodes compete with model parsing, texture decode and shader
  // compiles on few-core devices, so none starts while the dialog blocks.
  // Cancelling releases at once, even while a stage is still winding down.
  const releaseEncodes = holdEncodeQueuePause("scene-load");
  options.signal.addEventListener("abort", releaseEncodes, { once: true });
  try {
    await runBlockingLoadPhases(options);
  } finally {
    options.signal.removeEventListener("abort", releaseEncodes);
    releaseEncodes();
  }
}

async function runBlockingLoadPhases(options: Parameters<typeof runSceneViewportBlockingLoad>[0]): Promise<void> {
  options.onProgress(0, "Preparing Scene");
  await waitForSceneLoadingPaint(options.signal);
  options.signal.throwIfAborted();
  const painted = performance.now();
  options.onProgress(10, "Collecting Assets");
  await options.collect();
  options.signal.throwIfAborted();
  options.onProgress(20, "Realizing Scene");
  await options.realize();
  options.signal.throwIfAborted();
  options.onProgress(45, "Loading Models");
  await options.whenModelsReady();
  options.signal.throwIfAborted();
  options.onProgress(70, "Compiling Shaders");
  await options.warmShaders((count) => options.onProgress(70, "Compiling Shaders", count));
  options.signal.throwIfAborted();
  options.onProgress(90, "Presenting First Frame");
  // Cached assets can finish all readiness work in one microtask batch. Give
  // the blocking phase a paint before a permitted frame can close the dialog;
  // a load that has run for frames since the dialog painted already had them.
  if (performance.now() - painted < PAINTED_LOAD_MS) {
    await waitForSceneLoadingPaint(options.signal);
    options.signal.throwIfAborted();
  }
  await options.presentFirstFrame();
  options.signal.throwIfAborted();
  options.onProgress(100, "Presenting First Frame");
}
