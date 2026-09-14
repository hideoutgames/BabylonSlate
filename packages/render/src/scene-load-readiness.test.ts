import { describe, expect, it, vi } from "vitest";
import { createSceneLoadReadiness, type SceneLoadProgress } from "./scene-load-readiness";
import { RenderScheduler } from "./render-scheduler";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function fixture() {
  const handle = {
    whenEditorModelsReady: vi.fn(async () => {}),
    whenMaterialTexturesReady: vi.fn(async () => {}),
    prewarmSceneMaterials: vi.fn(async () => {}),
    presentFirstFrame: vi.fn(async () => {}),
  };
  const activate = vi.fn();
  const onReady = vi.fn();
  const onFailed = vi.fn();
  const readiness = createSceneLoadReadiness({ handle, activate, onReady, onFailed });
  const command = (type: string, sceneLoadId = 1) => ({ type, sceneAssetGuid: "scene", sceneLoadId });
  return { handle, activate, onReady, onFailed, readiness, command };
}

describe("runtime scene readiness", () => {
  it("waits for the complete assignment batch, textures, shaders and first frame before acknowledgement", async () => {
    const { handle, readiness, onReady, command } = fixture();
    const textures = deferred();
    const presentation = deferred();
    handle.whenMaterialTexturesReady.mockReturnValueOnce(textures.promise);
    handle.presentFirstFrame.mockReturnValueOnce(presentation.promise);
    readiness.receive(command("activeScene"));
    readiness.receive(command("assignMesh"));
    await Promise.resolve();
    expect(handle.whenEditorModelsReady).not.toHaveBeenCalled();
    readiness.receive(command("sceneRealized"));
    readiness.receive(command("sceneRealized"));
    await vi.waitFor(() => expect(handle.whenMaterialTexturesReady).toHaveBeenCalledOnce());
    expect(handle.prewarmSceneMaterials).not.toHaveBeenCalled();
    textures.resolve();
    await vi.waitFor(() => expect(handle.presentFirstFrame).toHaveBeenCalledOnce());
    expect(onReady).not.toHaveBeenCalled();
    presentation.resolve();
    await vi.waitFor(() => expect(onReady).toHaveBeenCalledOnce());
    expect(onReady).toHaveBeenCalledWith(expect.objectContaining({ sceneAssetGuid: "scene", sceneLoadId: 1 }));
    expect(handle.whenEditorModelsReady).toHaveBeenCalledOnce();
  });

  it("ignores the previous same-scene batch while the replacement finishes", async () => {
    const { handle, readiness, onReady, activate, command } = fixture();
    const oldTextures = deferred();
    handle.whenMaterialTexturesReady.mockReturnValueOnce(oldTextures.promise);
    readiness.receive(command("activeScene"));
    readiness.receive(command("sceneRealized"));
    await vi.waitFor(() => expect(handle.whenMaterialTexturesReady).toHaveBeenCalledOnce());
    readiness.receive(command("activeScene", 2));
    readiness.receive(command("activeScene", 1));
    readiness.receive(command("sceneRealized", 1));
    readiness.receive(command("sceneRealized", 2));
    await vi.waitFor(() => expect(onReady).toHaveBeenCalledOnce());
    oldTextures.resolve();
    await oldTextures.promise;
    expect(onReady).toHaveBeenCalledWith(expect.objectContaining({ sceneLoadId: 2 }));
    expect(handle.prewarmSceneMaterials).toHaveBeenCalledOnce();
    expect(activate).toHaveBeenCalledTimes(2);
  });

  it.each(["activate", "models", "textures", "shaders", "frame"] as const)(
    "reports %s failure without successful acknowledgement", async (stage) => {
      const { handle, readiness, onReady, onFailed, activate, command } = fixture();
      const failure = new Error("Scene resource unavailable");
      if (stage === "activate") activate.mockImplementationOnce(() => { throw failure; });
      if (stage === "models") handle.whenEditorModelsReady.mockRejectedValueOnce(failure);
      if (stage === "textures") handle.whenMaterialTexturesReady.mockRejectedValueOnce(failure);
      if (stage === "shaders") handle.prewarmSceneMaterials.mockRejectedValueOnce(failure);
      if (stage === "frame") handle.presentFirstFrame.mockRejectedValueOnce(failure);
      readiness.receive(command("activeScene"));
      readiness.receive(command("sceneRealized"));
      await vi.waitFor(() => expect(onFailed).toHaveBeenCalledWith(expect.objectContaining({ sceneLoadId: 1 }), failure));
      expect(onReady).not.toHaveBeenCalled();
    },
  );

  it("disposal suppresses pending warming failures and prevents late presentation", async () => {
    const { handle, readiness, onReady, onFailed, command } = fixture();
    const shaders = deferred();
    handle.prewarmSceneMaterials.mockReturnValueOnce(shaders.promise);
    readiness.receive(command("activeScene"));
    readiness.receive(command("sceneRealized"));
    await vi.waitFor(() => expect(handle.prewarmSceneMaterials).toHaveBeenCalledOnce());
    readiness.dispose();
    shaders.reject(new Error("Obsolete scene was disposed"));
    await Promise.resolve();
    expect(handle.presentFirstFrame).not.toHaveBeenCalled();
    expect(onReady).not.toHaveBeenCalled();
    expect(onFailed).not.toHaveBeenCalled();
  });
});


describe("blocking runtime loading host", () => {
  it("acquires before paint, activates after teardown, and holds normal drawing through the permitted first frame", async () => {
    const scheduler = new RenderScheduler();
    scheduler.setAlwaysRender(true);
    const paint = deferred();
    const frame = deferred();
    const painted = vi.fn();
    const progress = vi.fn();
    const activate = vi.fn();
    const onReady = vi.fn();
    const readiness = createSceneLoadReadiness({
      handle: { whenEditorModelsReady: async () => {}, whenMaterialTexturesReady: async () => {}, prewarmSceneMaterials: async () => {}, presentFirstFrame: () => frame.promise },
      loading: { acquire: () => scheduler.acquireObstruction(), progress, paint: vi.fn().mockReturnValueOnce(paint.promise).mockResolvedValue(undefined), painted },
      activate, onReady, onFailed: vi.fn(),
    });
    const identity = { sceneAssetGuid: "scene", sceneLoadId: 1 };
    readiness.receive({ type: "sceneLoading", ...identity });
    expect(progress).toHaveBeenCalledWith({ ...identity, phase: "Preparing Scene", progress: 0 });
    expect(scheduler.shouldRender()).toBe(false);
    expect(activate).not.toHaveBeenCalled();
    expect(painted).not.toHaveBeenCalled();
    paint.resolve();
    await vi.waitFor(() => expect(painted).toHaveBeenCalledOnce());
    readiness.receive({ type: "activeScene", ...identity });
    readiness.receive({ type: "activeScene", ...identity });
    readiness.receive({ type: "sceneRealized", ...identity });
    await vi.waitFor(() => expect(progress).toHaveBeenCalledWith({ ...identity, phase: "Presenting First Frame", progress: 90 }));
    expect(activate).toHaveBeenCalledOnce();
    expect(scheduler.shouldRender()).toBe(false);
    expect(scheduler.canPresentLoadingFrame()).toBe(true);
    const siblingBlocker = scheduler.acquireObstruction();
    frame.resolve();
    await vi.waitFor(() => expect(onReady).toHaveBeenCalledOnce());
    expect(progress).toHaveBeenLastCalledWith(null);
    expect(scheduler.shouldRender()).toBe(false);
    readiness.dispose();
    siblingBlocker();
    expect(scheduler.shouldRender()).toBe(true);
    scheduler.setObstructed(true);
    const next = scheduler.acquireObstruction();
    next();
    next();
    expect(scheduler.shouldRender()).toBe(false);
  });

  it("cancels an obsolete paint without acknowledging it or clearing its replacement's UI", async () => {
    const paints = [deferred(), deferred()];
    const signals: AbortSignal[] = [];
    const states: Array<SceneLoadProgress | null> = [];
    const painted = vi.fn();
    const failed = vi.fn();
    const release = vi.fn();
    const readiness = createSceneLoadReadiness({
      handle: { whenEditorModelsReady: async () => {}, whenMaterialTexturesReady: async () => {}, prewarmSceneMaterials: async () => {}, presentFirstFrame: async () => {} },
      loading: { acquire: () => release, progress: (state) => states.push(state), paint: (signal) => { signals.push(signal); return paints[signals.length - 1]!.promise; }, painted },
      activate: vi.fn(), onReady: vi.fn(), onFailed: failed,
    });
    readiness.receive({ type: "sceneLoading", sceneAssetGuid: "same", sceneLoadId: 1 });
    readiness.receive({ type: "sceneLoading", sceneAssetGuid: "same", sceneLoadId: 2 });
    expect(signals[0]!.aborted).toBe(true);
    paints[0]!.resolve();
    await Promise.resolve();
    expect(painted).not.toHaveBeenCalled();
    expect(states).not.toContain(null);
    paints[1]!.resolve();
    await vi.waitFor(() => expect(painted).toHaveBeenCalledWith(expect.objectContaining({ sceneLoadId: 2 })));
    readiness.dispose();
    expect(release).toHaveBeenCalledTimes(2);
    expect(states.at(-1)).toBeNull();
    expect(failed).not.toHaveBeenCalled();
  });

  it("routes the current runtime deadline failure to Stop while retaining the blocker and suppressing late paint", async () => {
    const paint = deferred();
    const release = vi.fn();
    const painted = vi.fn();
    const failed = vi.fn();
    const activate = vi.fn();
    const readiness = createSceneLoadReadiness({
      handle: { whenEditorModelsReady: async () => {}, whenMaterialTexturesReady: async () => {}, prewarmSceneMaterials: async () => {}, presentFirstFrame: async () => {} },
      loading: { acquire: () => release, progress: vi.fn(), paint: () => paint.promise, painted },
      activate, onReady: vi.fn(), onFailed: failed,
    });
    const identity = { sceneAssetGuid: "same", sceneLoadId: 2 };
    readiness.receive({ type: "sceneLoading", ...identity });
    readiness.receive({ type: "sceneLoadFailed", sceneAssetGuid: "same", sceneLoadId: 1, message: "Obsolete" });
    expect(failed).not.toHaveBeenCalled();
    readiness.receive({ type: "sceneLoadFailed", ...identity, message: "Loading deadline" });
    expect(failed).toHaveBeenCalledWith(expect.objectContaining(identity), expect.objectContaining({ message: "Loading deadline" }));
    expect(release).not.toHaveBeenCalled();
    paint.resolve();
    await Promise.resolve();
    readiness.receive({ type: "activeScene", ...identity });
    expect(painted).not.toHaveBeenCalled();
    expect(activate).not.toHaveBeenCalled();
    readiness.dispose();
    expect(release).toHaveBeenCalledOnce();
  });
});


describe("independent scene owners", () => {
  it("acknowledges only the current layer's painted loading state and reports its failure before removal", async () => {
    const paints = [deferred(), deferred()];
    const layerPainted = vi.fn();
    const layerReady = vi.fn();
    const failure = vi.fn();
    const release = vi.fn();
    let paintIndex = 0;
    const readiness = createSceneLoadReadiness({
      handle: { whenEditorModelsReady: async () => {}, whenMaterialTexturesReady: async () => {},
        prewarmSceneMaterials: async () => {}, presentFirstFrame: async () => {} },
      loading: { acquire: () => release, progress: vi.fn(), painted: vi.fn(), layerPainted,
        paint: () => paints[paintIndex++]!.promise },
      activate: vi.fn(), onReady: vi.fn(), onLayerReady: layerReady, onFailed: failure,
    });
    try {
      readiness.receive({ type: "sceneLayerLoading", layerId: "layer", layerLoadId: 1, assetGuid: "overlay" });
      expect(layerPainted).not.toHaveBeenCalled();
      readiness.receive({ type: "sceneLayerLoading", layerId: "layer", layerLoadId: 2, assetGuid: "overlay" });
      paints[0]!.resolve();
      await Promise.resolve();
      expect(layerPainted).not.toHaveBeenCalled();
      readiness.receive({ type: "sceneLayerLoadFailed", layerId: "layer", layerLoadId: 1, message: "Old deadline" });
      expect(failure).not.toHaveBeenCalled();
      readiness.receive({ type: "sceneLayerLoadFailed", layerId: "layer", layerLoadId: 2, message: "Current deadline" });
      expect(failure).toHaveBeenCalledWith(expect.objectContaining({ layer: { layerId: "layer", layerLoadId: 2 } }),
        expect.objectContaining({ message: "Current deadline" }));
      expect(release).toHaveBeenCalledOnce();
      readiness.receive({ type: "sceneLayerRemove", layerId: "layer" });
      expect(release).toHaveBeenCalledTimes(2);
      paints[1]!.resolve();
      readiness.receive({ type: "sceneLayerRealized", layerId: "layer", layerLoadId: 2 });
      await Promise.resolve();
      expect(layerPainted).not.toHaveBeenCalled();
      expect(layerReady).not.toHaveBeenCalled();
    } finally { readiness.dispose(); }
  });

  it("acknowledges a ready layer while the world waits, then waits for the dismissed blocker to paint before world logic", async () => {
    const models = deferred();
    const dismissedPaint = deferred();
    let loading = true;
    const states: Array<SceneLoadProgress | null> = [];
    const ready: string[] = [];
    const owners: Array<string | undefined> = [];
    const readiness = createSceneLoadReadiness({
      handle: {
        whenEditorModelsReady: (owner) => { owners.push(owner?.layerId); return owner ? Promise.resolve() : models.promise; },
        whenMaterialTexturesReady: async () => {}, prewarmSceneMaterials: async () => {}, presentFirstFrame: async () => {},
      },
      loading: {
        acquire: () => () => {}, painted: () => {},
        progress: (state) => { states.push(state); loading = state !== null; },
        paint: () => loading ? Promise.resolve() : dismissedPaint.promise,
      },
      activate: () => {}, onReady: () => ready.push("world"), onLayerReady: (layer) => ready.push(layer.layerId),
      onFailed: (_owner, error) => { throw error; },
    });
    readiness.receive({ type: "activeScene", sceneAssetGuid: "world", sceneLoadId: 1 });
    readiness.receive({ type: "sceneRealized", sceneAssetGuid: "world", sceneLoadId: 1 });
    readiness.receive({ type: "sceneLayerLoading", layerId: "global", layerLoadId: 2, assetGuid: "overlay" });
    readiness.receive({ type: "sceneLayerRealized", layerId: "global", layerLoadId: 2 });
    await vi.waitFor(() => expect(ready).toEqual(["global"]));
    expect(owners).toEqual([undefined, "global"]);
    expect(states.at(-1)?.sceneAssetGuid).toBe("world");
    expect(states).not.toContain(null);
    models.resolve();
    await vi.waitFor(() => expect(states.at(-1)).toBeNull());
    expect(ready).toEqual(["global"]);
    dismissedPaint.resolve();
    await vi.waitFor(() => expect(ready).toEqual(["global", "world"]));
    readiness.dispose();
  });

  it("does not acknowledge a removed layer's delayed frame or a world stopped during dismissal paint", async () => {
    const frame = deferred();
    const dismissedPaint = deferred();
    const layerReady = vi.fn();
    const worldReady = vi.fn();
    const failure = vi.fn();
    let loading = true;
    const readiness = createSceneLoadReadiness({
      handle: { whenEditorModelsReady: async () => {}, whenMaterialTexturesReady: async () => {}, prewarmSceneMaterials: async () => {},
        presentFirstFrame: (owner) => owner ? frame.promise : Promise.resolve() },
      loading: { acquire: () => () => {}, painted: () => {}, progress: (state) => { loading = state !== null; },
        paint: () => loading ? Promise.resolve() : dismissedPaint.promise },
      activate: () => {}, onReady: worldReady, onLayerReady: layerReady, onFailed: failure,
    });
    readiness.receive({ type: "sceneLayerLoading", layerId: "old", layerLoadId: 1, assetGuid: "overlay" });
    readiness.receive({ type: "sceneLayerRealized", layerId: "old", layerLoadId: 1 });
    await vi.waitFor(() => expect(loading).toBe(true));
    readiness.receive({ type: "sceneLayerRemove", layerId: "old" });
    frame.resolve();
    readiness.receive({ type: "activeScene", sceneAssetGuid: "world", sceneLoadId: 1 });
    readiness.receive({ type: "sceneRealized", sceneAssetGuid: "world", sceneLoadId: 1 });
    await vi.waitFor(() => expect(loading).toBe(false));
    readiness.dispose();
    dismissedPaint.resolve();
    await Promise.resolve();
    expect(layerReady).not.toHaveBeenCalled();
    expect(worldReady).not.toHaveBeenCalled();
    expect(failure).not.toHaveBeenCalled();
  });
});
