export interface SceneLoadIdentity {
  sceneAssetGuid: string;
  sceneLoadId: number;
}

export interface SceneLayerLoadIdentity {
  layerId: string;
  layerLoadId: number;
}

export type SceneLoadPhase = "Preparing Scene" | "Removing Previous Scene" | "Realizing Scene" | "Loading Models" | "Loading Textures" | "Compiling Shaders" | "Presenting First Frame";
/** How far a counted phase is: `done` of `total` (shader warm-up units). */
export interface SceneLoadCount {
  done: number;
  total: number;
}
export interface SceneLoadProgress extends SceneLoadIdentity {
  layerId?: string;
  layerLoadId?: number;
  phase: SceneLoadPhase;
  progress: number;
  count?: SceneLoadCount;
}

/** Runs `callback` in a task of its own (a posted message: no timer clamp); the result cancels it. */
function inNextTask(callback: () => void): () => void {
  const channel = new MessageChannel();
  const close = () => { channel.port1.onmessage = null; channel.port1.close(); };
  channel.port1.onmessage = () => { close(); callback(); };
  channel.port2.postMessage(undefined);
  return close;
}

/**
 * Cross a browser paint before beginning work, with one animation frame: a task first, so a loading UI update the
 * caller scheduled (React commits in a task) is in that frame's paint; then the frame; then a task after it, which runs
 * once that frame's rendering update, its paint included, has run. Cancellation stops whichever step is pending.
 */
export function waitForSceneLoadingPaint(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    let stop = () => {};
    const cancel = () => { stop(); reject(signal.reason); };
    signal.addEventListener("abort", cancel, { once: true });
    stop = inNextTask(() => {
      const frame = requestAnimationFrame(() => {
        stop = inNextTask(() => {
          signal.removeEventListener("abort", cancel);
          resolve();
        });
      });
      stop = () => cancelAnimationFrame(frame);
    });
  });
}

interface LoadingHost {
  acquire: () => () => void;
  progress: (state: SceneLoadProgress | null) => void;
  /**
   * The load's one paint barrier: a load that departs from a shown Scene or layer (`sceneLoading`, `sceneLayerLoading`)
   * waits for it before `painted` lets the runtime retire what shows, so the loading UI is on screen first. A session's
   * first Scene (`activeScene`) shows nothing to hide and waits for none.
   */
  paint: (signal: AbortSignal) => Promise<void>;
  painted: (scene: SceneLoadIdentity) => void;
  layerPainted?: (layer: SceneLayerLoadIdentity) => void;
}

interface PendingScene extends SceneLoadIdentity {
  activated: boolean;
  scheduled: boolean;
  failed: boolean;
  completed: boolean;
  layer?: SceneLayerLoadIdentity;
  progress: SceneLoadProgress;
  controller: AbortController;
  release: (() => void) | null;
}

/** Share complete-batch, warming, presentation, and loading ownership across hosts. */
export function createSceneLoadReadiness(options: {
  handle: {
    whenEditorModelsReady: (owner?: SceneLayerLoadIdentity) => Promise<void>;
    whenMaterialTexturesReady: (owner?: SceneLayerLoadIdentity) => Promise<void>;
    prewarmSceneMaterials: (owner?: SceneLayerLoadIdentity, onProgress?: (count: SceneLoadCount) => void) => Promise<void>;
    presentFirstFrame: (owner?: SceneLayerLoadIdentity) => Promise<void>;
  };
  loading?: LoadingHost;
  activate: (scene: SceneLoadIdentity) => void;
  onReady: (scene: SceneLoadIdentity) => void;
  onLayerReady?: (layer: SceneLayerLoadIdentity) => void;
  onFailed: (scene: SceneLoadIdentity, error: unknown) => void;
}) {
  let current: PendingScene | null = null;
  const layers = new Map<string, PendingScene>();
  let disposed = false;
  const isCurrent = (scene: PendingScene) => !disposed && (scene.layer ? layers.get(scene.layer.layerId) === scene : current === scene) && !scene.failed;
  const publishProgress = () => {
    const pending = [current, ...layers.values()].find((scene) => scene && !scene.completed);
    options.loading?.progress(pending?.progress ?? null);
  };
  const progress = (scene: PendingScene, value: number, phase: SceneLoadPhase, count?: SceneLoadCount) => {
    if (!isCurrent(scene)) return;
    scene.progress = { sceneAssetGuid: scene.sceneAssetGuid, sceneLoadId: scene.sceneLoadId, ...scene.layer, progress: value, phase,
      ...(count ? { count: { ...count } } : {}) };
    publishProgress();
  };
  const release = (scene: PendingScene, cancel = true) => {
    if (cancel) scene.controller.abort();
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
  const begin = (identity: SceneLoadIdentity, notifyPainted: boolean, layer?: SceneLayerLoadIdentity): PendingScene => {
    const previous = layer ? layers.get(layer.layerId) : current;
    if (previous) release(previous);
    const scene: PendingScene = { ...identity, activated: Boolean(layer), scheduled: false, failed: false, completed: false, layer,
      progress: { ...identity, ...layer, phase: "Preparing Scene", progress: 0 }, controller: new AbortController(), release: null };
    if (layer) layers.set(layer.layerId, scene);
    else current = scene;
    try {
      scene.release = options.loading?.acquire() ?? null;
      progress(scene, 0, "Preparing Scene");
      if (notifyPainted) {
        void (async () => {
          await options.loading?.paint(scene.controller.signal);
          if (!isCurrent(scene)) return;
          if (!scene.scheduled) progress(scene, 10, layer ? "Realizing Scene" : "Removing Previous Scene");
          if (layer) options.loading?.layerPainted?.(layer);
          else options.loading?.painted(scene);
        })().catch((error: unknown) => fail(scene, error));
      }
    } catch (error) { fail(scene, error); }
    return scene;
  };
  const schedule = (scene: PendingScene) => {
    if (!scene.activated || scene.scheduled || !isCurrent(scene)) return;
    scene.scheduled = true;
      void (async () => {
        progress(scene, 45, "Loading Models");
        await options.handle.whenEditorModelsReady(scene.layer);
        if (!isCurrent(scene)) return;
        progress(scene, 60, "Loading Textures");
        await options.handle.whenMaterialTexturesReady(scene.layer);
        if (!isCurrent(scene)) return;
        progress(scene, 70, "Compiling Shaders");
        await options.handle.prewarmSceneMaterials(scene.layer, (count) => progress(scene, 70, "Compiling Shaders", count));
        if (!isCurrent(scene)) return;
        // The loading UI is on screen already (painted when the load began, or shown by the host before a session's
        // first Scene), so the first frame presents without waiting for another paint, and the load acknowledges as
        // soon as it has: the presented frame is coherent whether or not the UI over it has been removed yet.
        progress(scene, 90, "Presenting First Frame");
        await options.handle.presentFirstFrame(scene.layer);
        if (!isCurrent(scene)) return;
        scene.completed = true;
        release(scene, false);
        publishProgress();
        if (scene.layer) options.onLayerReady?.(scene.layer);
        else options.onReady(scene);
      })().catch((error: unknown) => fail(scene, error));
  };
  return {
    receive(command: { type: string; sceneAssetGuid?: unknown; sceneLoadId?: unknown; layerId?: unknown; layerLoadId?: unknown; assetGuid?: unknown; message?: unknown }): void {
      if (disposed) return;
      if (command.type === "sceneLayerClear") {
        for (const layer of layers.values()) release(layer);
        layers.clear();
        publishProgress();
        return;
      }
      if (command.type === "sceneLayerRemove" && typeof command.layerId === "string") {
        const layer = layers.get(command.layerId);
        if (layer) release(layer);
        layers.delete(command.layerId);
        publishProgress();
        return;
      }
      if (command.type === "sceneLayerLoading" || command.type === "sceneLayerRealized" || command.type === "sceneLayerLoadFailed") {
        const { layerId, layerLoadId } = command;
        if (typeof layerId !== "string" || typeof layerLoadId !== "number" || !Number.isSafeInteger(layerLoadId) || layerLoadId < 1) return;
        const previous = layers.get(layerId);
        if (command.type === "sceneLayerLoading") {
          if (typeof command.assetGuid !== "string" || (previous && layerLoadId <= previous.sceneLoadId)) return;
          begin({ sceneAssetGuid: command.assetGuid, sceneLoadId: layerLoadId }, true, { layerId, layerLoadId });
        } else if (previous?.sceneLoadId === layerLoadId) {
          if (command.type === "sceneLayerLoadFailed") fail(previous, new Error(String(command.message ?? "SceneLayer loading failed.")));
          else schedule(previous);
        }
        return;
      }
      if (!["sceneLoading", "activeScene", "sceneRealized", "sceneLoadFailed"].includes(command.type)) return;
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
      schedule(scene);
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (current) release(current);
      current = null;
      for (const layer of layers.values()) release(layer);
      layers.clear();
      options.loading?.progress(null);
    },
  };
}
