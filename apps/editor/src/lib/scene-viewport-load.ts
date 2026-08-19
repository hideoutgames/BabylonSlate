export const SCENE_LOAD_PHASES = ["Collecting Assets", "Loading Models"] as const;

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
  onProgress: (value: number, phase: SceneViewportLoadPhase) => void;
}): Promise<void> {
  options.onProgress(0, "Collecting Assets");
  await options.collect();
  options.onProgress(50, "Loading Models");
  await options.whenModelsReady();
  options.onProgress(100, "Loading Models");
}
