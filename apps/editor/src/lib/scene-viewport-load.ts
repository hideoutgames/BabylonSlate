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
  await options.presentFirstFrame();
  options.signal.throwIfAborted();
  options.onProgress(100, "Presenting First Frame");
}
