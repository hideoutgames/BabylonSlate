export interface SceneLoadIdentity {
  sceneAssetGuid: string;
  sceneLoadId: number;
}

export type SceneLoadPhase = "Preparing Scene" | "Removing Previous Scene" | "Realizing Scene" | "Loading Models" | "Loading Textures" | "Warming Shaders" | "Presenting First Frame";
export interface SceneLoadProgress extends SceneLoadIdentity {
  phase: SceneLoadPhase;
  progress: number;
}

/** Cross a browser paint before beginning work; cancellation removes both frames. */
export function waitForSceneLoadingPaint(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    let frame = 0;
    const cancel = () => { cancelAnimationFrame(frame); reject(signal.reason); };
    signal.addEventListener("abort", cancel, { once: true });
    frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        signal.removeEventListener("abort", cancel);
        resolve();
      });
    });
  });
}

interface LoadingHost {
  acquire: () => () => void;
  progress: (state: SceneLoadProgress | null) => void;
  paint: (signal: AbortSignal) => Promise<void>;
  painted: (scene: SceneLoadIdentity) => void;
}

interface PendingScene extends SceneLoadIdentity {
  activated: boolean;
  scheduled: boolean;
  failed: boolean;
  controller: AbortController;
  release: (() => void) | null;
}

/** Share complete-batch, warming, presentation, and loading ownership across hosts. */
export function createSceneLoadReadiness(options: {
  handle: {
    whenEditorModelsReady: () => Promise<void>;
    whenMaterialTexturesReady: () => Promise<void>;
    prewarmSceneMaterials: () => Promise<void>;
    presentFirstFrame: () => Promise<void>;
  };
  loading?: LoadingHost;
  activate: (scene: SceneLoadIdentity) => void;
  onReady: (scene: SceneLoadIdentity) => void;
  onFailed: (scene: SceneLoadIdentity, error: unknown) => void;
}) {
  let current: PendingScene | null = null;
  let disposed = false;
  const isCurrent = (scene: PendingScene) => !disposed && current === scene && !scene.failed;
  const progress = (scene: PendingScene, value: number, phase: SceneLoadPhase) => {
    if (isCurrent(scene)) options.loading?.progress({ sceneAssetGuid: scene.sceneAssetGuid, sceneLoadId: scene.sceneLoadId, progress: value, phase });
  };
  const release = (scene: PendingScene) => {
    scene.controller.abort();
    const done = scene.release;
    scene.release = null;
    done?.();
  };
  const fail = (scene: PendingScene, error: unknown) => {
    if (!isCurrent(scene)) return;
    scene.failed = true;
    scene.controller.abort();
    // The failed scene stays blocked until its host stops/disposes or replaces it.
    options.onFailed(scene, error);
  };
  const begin = (identity: SceneLoadIdentity, notifyPainted: boolean): PendingScene => {
    if (current) release(current);
    const scene: PendingScene = { ...identity, activated: false, scheduled: false, failed: false, controller: new AbortController(), release: null };
    current = scene;
    try {
      scene.release = options.loading?.acquire() ?? null;
      progress(scene, 0, "Preparing Scene");
      if (notifyPainted) {
        void (async () => {
          await options.loading?.paint(scene.controller.signal);
          if (!isCurrent(scene)) return;
          progress(scene, 10, "Removing Previous Scene");
          options.loading?.painted(scene);
        })().catch((error: unknown) => fail(scene, error));
      }
    } catch (error) { fail(scene, error); }
    return scene;
  };
  return {
    receive(command: { type: string; sceneAssetGuid?: unknown; sceneLoadId?: unknown; message?: unknown }): void {
      if (disposed || !["sceneLoading", "activeScene", "sceneRealized", "sceneLoadFailed"].includes(command.type)) return;
      const { sceneAssetGuid, sceneLoadId } = command;
      if (typeof sceneAssetGuid !== "string" || typeof sceneLoadId !== "number" || !Number.isSafeInteger(sceneLoadId) || sceneLoadId < 1) return;
      if (command.type === "sceneLoading") {
        if (current && sceneLoadId <= current.sceneLoadId) return;
        begin({ sceneAssetGuid, sceneLoadId }, true);
        return;
      }
      if (command.type === "activeScene") {
        if (current && sceneLoadId < current.sceneLoadId) return;
        const scene = !current || sceneLoadId > current.sceneLoadId ? begin({ sceneAssetGuid, sceneLoadId }, false) : current;
        if (scene.sceneAssetGuid !== sceneAssetGuid || scene.activated || !isCurrent(scene)) return;
        scene.activated = true;
        try { progress(scene, 20, "Realizing Scene"); options.activate(scene); }
        catch (error) { fail(scene, error); }
        return;
      }
      const scene = current;
      if (!scene || scene.sceneAssetGuid !== sceneAssetGuid || scene.sceneLoadId !== sceneLoadId || !isCurrent(scene)) return;
      if (command.type === "sceneLoadFailed") { fail(scene, new Error(String(command.message ?? "Scene loading failed."))); return; }
      if (!scene.activated || scene.scheduled) return;
      scene.scheduled = true;
      void (async () => {
        progress(scene, 45, "Loading Models");
        await options.handle.whenEditorModelsReady();
        if (!isCurrent(scene)) return;
        progress(scene, 60, "Loading Textures");
        await options.handle.whenMaterialTexturesReady();
        if (!isCurrent(scene)) return;
        progress(scene, 70, "Warming Shaders");
        await options.handle.prewarmSceneMaterials();
        if (!isCurrent(scene)) return;
        progress(scene, 90, "Presenting First Frame");
        await options.loading?.paint(scene.controller.signal);
        if (!isCurrent(scene)) return;
        await options.handle.presentFirstFrame();
        if (!isCurrent(scene)) return;
        release(scene);
        options.loading?.progress(null);
        options.onReady(scene);
      })().catch((error: unknown) => fail(scene, error));
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (current) release(current);
      current = null;
      options.loading?.progress(null);
    },
  };
}
