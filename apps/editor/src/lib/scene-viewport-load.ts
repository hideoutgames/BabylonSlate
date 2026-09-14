import {
  resolveRenderingPipeline,
  type RenderPathOverrides,
  resolveShadowSettings,
  type ShadowOverrides,
  resolveCelShadingSettings,
  type CelShadingOverrides,
  type RenderProjectSettings,
  resolveEnvironmentLightingSettings,
  normalizeEnvironmentLightingSettings,
  type EnvironmentLightingOverrides,
  type EnvironmentLightingSettings,
} from "@babylonslate/core";

/** Only effective rendering changes rebuild GPU scene resources. */
export function sceneViewportRenderSettingsKey(
  project: Partial<RenderProjectSettings> = {},
  overrides?: CelShadingOverrides,
  shadowOverrides?: ShadowOverrides,
  pipelineOverrides?: RenderPathOverrides,
  environmentOverrides?: EnvironmentLightingOverrides,
  environmentSource: string | null = null,
): string {
  return JSON.stringify({
    ...project,
    ...resolveRenderingPipeline(project, pipelineOverrides).effective,
    mode: project.mode ?? "pbr",
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

/** Yield across a paint before starting synchronous GPU work. Abort cancels the wait. */
export function waitForSceneLoadingPaint(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    let frame = 0;
    const cancel = () => {
      cancelAnimationFrame(frame);
      reject(signal.reason);
    };
    signal.addEventListener("abort", cancel, { once: true });
    frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        signal.removeEventListener("abort", cancel);
        resolve();
      });
    });
  });
}

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
