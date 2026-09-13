export interface SceneLoadIdentity {
  sceneAssetGuid: string;
  sceneLoadId: number;
}

/** Acknowledges a runtime scene only after its full assignment batch and first frame. */
export function createSceneLoadReadiness(options: {
  handle: {
    whenEditorModelsReady: () => Promise<void>;
    whenMaterialTexturesReady: () => Promise<void>;
    prewarmSceneMaterials: () => Promise<void>;
    presentFirstFrame: () => Promise<void>;
  };
  activate: (scene: SceneLoadIdentity) => void;
  onReady: (scene: SceneLoadIdentity) => void;
  onFailed: (scene: SceneLoadIdentity, error: unknown) => void;
}) {
  let current: (SceneLoadIdentity & { scheduled: boolean; failed: boolean }) | null = null;
  let disposed = false;
  const isCurrent = (scene: SceneLoadIdentity) => !disposed && current === scene;
  return {
    receive(command: { type: string; sceneAssetGuid?: unknown; sceneLoadId?: unknown }): void {
      if (disposed || (command.type !== "activeScene" && command.type !== "sceneRealized")) return;
      if (typeof command.sceneAssetGuid !== "string" ||
        typeof command.sceneLoadId !== "number" || !Number.isSafeInteger(command.sceneLoadId) || command.sceneLoadId < 1) return;
      if (command.type === "activeScene") {
        if (current && command.sceneLoadId <= current.sceneLoadId) return;
        const scene = { sceneAssetGuid: command.sceneAssetGuid, sceneLoadId: command.sceneLoadId, scheduled: false, failed: false };
        current = scene;
        try {
          options.activate(scene);
        } catch (error) {
          scene.failed = true;
          options.onFailed(scene, error);
        }
        return;
      }
      const scene = current;
      if (!scene || scene.failed || scene.scheduled || scene.sceneLoadId !== command.sceneLoadId || scene.sceneAssetGuid !== command.sceneAssetGuid) return;
      scene.scheduled = true;
      void (async () => {
        try {
          await options.handle.whenEditorModelsReady();
          if (!isCurrent(scene)) return;
          await options.handle.whenMaterialTexturesReady();
          if (!isCurrent(scene)) return;
          await options.handle.prewarmSceneMaterials();
          if (!isCurrent(scene)) return;
          await options.handle.presentFirstFrame();
          if (isCurrent(scene)) options.onReady(scene);
        } catch (error) {
          if (!isCurrent(scene)) return;
          scene.failed = true;
          options.onFailed(scene, error);
        }
      })();
    },
    dispose(): void {
      disposed = true;
      current = null;
    },
  };
}
