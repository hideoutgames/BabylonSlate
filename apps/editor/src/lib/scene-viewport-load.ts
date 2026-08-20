export const SCENE_LOAD_PHASES = [
  "Collecting Assets",
  "Loading Models",
  "Warming Shaders",
] as const;

export type SceneViewportLoadPhase = (typeof SCENE_LOAD_PHASES)[number];

/** First open / viewport remount for this engine generation — not gizmo apply. */
export function isSceneViewportRemountLoad(
  engineGeneration: number,
  completedGeneration: number,
): boolean {
  return engineGeneration !== completedGeneration;
}

export async function runSceneViewportBlockingLoad(options: {
  collect: () => Promise<void>;
  whenModelsReady: () => Promise<void>;
  warmShaders: () => Promise<void>;
  onProgress: (value: number, phase: SceneViewportLoadPhase) => void;
}): Promise<void> {
  options.onProgress(0, "Collecting Assets");
  await options.collect();
  options.onProgress(34, "Loading Models");
  await options.whenModelsReady();
  options.onProgress(67, "Warming Shaders");
  await options.warmShaders();
  options.onProgress(100, "Warming Shaders");
}
