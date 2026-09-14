import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeCelShadingSettings, normalizeShadowSettings, normalizeEnvironmentLightingSettings } from "@babylonslate/core";
import {
  isSceneViewportRemountLoad,
  runSceneViewportBlockingLoad,
  sceneViewportRenderSettingsKey,
  sceneViewportRenderSettings,
} from "./scene-viewport-load";

it("keeps the viewport when only a pipeline preference changes without changing its effective renderer", () => {
  const original = sceneViewportRenderSettingsKey({});
  expect(sceneViewportRenderSettingsKey({ renderPath: "auto", gpuBackend: "auto" })).toBe(original);
  expect(sceneViewportRenderSettingsKey({ renderPath: "clusteredForward", gpuBackend: "webgpu" })).toBe(original);
  expect(sceneViewportRenderSettingsKey({}, undefined, undefined, { renderPath: "clusteredForward" })).toBe(original);
});

it("reloads effective CEL changes while ignoring inactive and inherited-equivalent edits", () => {
  const project = { mode: "cel" as const, cel: normalizeCelShadingSettings({}) };
  const initial = sceneViewportRenderSettingsKey(project);
  expect(sceneViewportRenderSettingsKey(project, { shadowBands: 3 })).toBe(initial);
  expect(sceneViewportRenderSettingsKey(project, { specularEnabled: false })).not.toBe(initial);
  expect(sceneViewportRenderSettingsKey({ ...project, mode: "pbr" })).not.toBe(initial);
  expect(sceneViewportRenderSettingsKey({ mode: "pbr", cel: project.cel }, { shadowBands: 6 }))
    .toBe(sceneViewportRenderSettingsKey({ mode: "pbr" }));
});

it("keeps environment scalar edits live while loading newly admitted resources before presentation", () => {
  const environmentLighting = normalizeEnvironmentLightingSettings({ intensity: 3, rotationYDegrees: 90 });
  const project = { environmentLighting };
  const initial = sceneViewportRenderSettingsKey(project, {}, {}, {}, {}, "cube-a");
  const latest = { ...environmentLighting, intensity: 4, rotationYDegrees: -90, celStrength: 0.5 };
  expect(sceneViewportRenderSettingsKey({ environmentLighting: latest }, {}, {}, { renderPath: "auto" }, { intensity: 2 }, "cube-a")).toBe(initial);
  expect(sceneViewportRenderSettingsKey(project, {}, {}, {}, { enabled: false }, "cube-a")).not.toBe(initial);
  expect(sceneViewportRenderSettingsKey(project, {}, {}, {}, {}, "cube-b")).not.toBe(initial);
  const settings = sceneViewportRenderSettings(initial, latest);
  expect(settings.environmentLighting).toEqual(latest);
  expect(settings).not.toHaveProperty("environmentSource");
});

it("reloads effective shadow changes in PBR and CEL and restores inherited values", () => {
  for (const mode of ["pbr", "cel"] as const) {
    const project = { mode, shadows: normalizeShadowSettings({ distance: 200 }) };
    const initial = sceneViewportRenderSettingsKey(project);
    expect(sceneViewportRenderSettingsKey(project, {}, { distance: 200 })).toBe(initial);
    expect(sceneViewportRenderSettingsKey(project, {}, { distance: 80 })).not.toBe(initial);
    expect(sceneViewportRenderSettingsKey(project, {}, {})).toBe(initial);
  }
});

describe("isSceneViewportRemountLoad", () => {
  it("is true until that engine generation has finished its first load", () => {
    expect(isSceneViewportRemountLoad(1, -1)).toBe(true);
    expect(isSceneViewportRemountLoad(2, 1)).toBe(true);
    expect(isSceneViewportRemountLoad(1, 1)).toBe(false);
  });
});

describe("runSceneViewportBlockingLoad", () => {
  let frames: FrameRequestCallback[];
  beforeEach(() => {
    frames = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
  });
  afterEach(() => vi.unstubAllGlobals());
  const paint = () => {
    frames.shift()?.(0);
    frames.shift()?.(16);
  };

  it("yields for modal paint before realization and stays loading through the first frame", async () => {
    const progress: Array<{ value: number; phase: string }> = [];
    const realize = vi.fn();
    const collect = vi.fn(async () => undefined);
    const whenModelsReady = vi.fn(async () => undefined);
    const warmShaders = vi.fn(async () => undefined);
    let present!: () => void;
    const presentFirstFrame = vi.fn(() => new Promise<void>((resolve) => { present = resolve; }));
    const task = runSceneViewportBlockingLoad({
      signal: new AbortController().signal,
      realize,
      collect,
      whenModelsReady,
      warmShaders,
      presentFirstFrame,
      onProgress: (value, phase) => progress.push({ value, phase }),
    });
    expect(realize).not.toHaveBeenCalled();
    expect(collect).not.toHaveBeenCalled();
    paint();
    await vi.waitFor(() => expect(progress.at(-1)?.value).toBe(90));
    expect(progress.at(-1)).toEqual({ value: 90, phase: "Presenting First Frame" });
    expect(presentFirstFrame).not.toHaveBeenCalled();
    paint();
    await vi.waitFor(() => expect(presentFirstFrame).toHaveBeenCalledOnce());
    present();
    await task;
    expect(progress).toEqual([
      { value: 0, phase: "Preparing Scene" },
      { value: 10, phase: "Collecting Assets" },
      { value: 20, phase: "Realizing Scene" },
      { value: 45, phase: "Loading Models" },
      { value: 70, phase: "Warming Shaders" },
      { value: 90, phase: "Presenting First Frame" },
      { value: 100, phase: "Presenting First Frame" },
    ]);
  });

  it("waits for chunked realization after collection before inspecting model readiness", async () => {
    let finish!: () => void;
    const order: string[] = [];
    const whenModelsReady = vi.fn(async () => {});
    const task = runSceneViewportBlockingLoad({
      signal: new AbortController().signal,
      collect: async () => { order.push("collect"); },
      realize: () => { order.push("realize"); return new Promise<void>((resolve) => { finish = resolve; }); },
      whenModelsReady,
      warmShaders: async () => {},
      presentFirstFrame: async () => {},
      onProgress: () => {},
    });
    paint();
    await vi.waitFor(() => expect(order).toEqual(["collect", "realize"]));
    expect(whenModelsReady).not.toHaveBeenCalled();
    finish();
    await vi.waitFor(() => expect(frames).toHaveLength(1));
    paint();
    await task;
    expect(whenModelsReady).toHaveBeenCalledOnce();
  });

  it.each(["realize", "collect", "whenModelsReady", "warmShaders", "presentFirstFrame"] as const)(
    "rejects %s failures without reporting ready", async (stage) => {
      const failure = new Error("Scene resource failed");
      const onProgress = vi.fn();
      const options = {
        signal: new AbortController().signal,
        realize: () => {},
        collect: async () => {},
        whenModelsReady: async () => {},
        warmShaders: async () => {},
        presentFirstFrame: async () => {},
        onProgress,
        [stage]: () => { throw failure; },
      };
      const task = runSceneViewportBlockingLoad(options);
      const result = expect(task).rejects.toBe(failure);
      paint();
      if (stage === "presentFirstFrame") {
        await vi.waitFor(() => expect(frames).toHaveLength(1));
        paint();
      }
      await result;
      expect(onProgress.mock.calls.some(([value]) => value === 100)).toBe(false);
    },
  );

  it("does not warm, present, or report progress after an obsolete asset batch resolves", async () => {
    const controller = new AbortController();
    let finishCollection!: () => void;
    const collect = vi.fn(() => new Promise<void>((resolve) => { finishCollection = resolve; }));
    const whenModelsReady = vi.fn(async () => {});
    const warmShaders = vi.fn(async () => {});
    const presentFirstFrame = vi.fn(async () => {});
    const onProgress = vi.fn();
    const task = runSceneViewportBlockingLoad({
      signal: controller.signal, realize: () => {}, collect, whenModelsReady,
      warmShaders, presentFirstFrame, onProgress,
    });
    const result = expect(task).rejects.toMatchObject({ name: "AbortError" });
    paint();
    await vi.waitFor(() => expect(collect).toHaveBeenCalledOnce());
    controller.abort();
    const progressCount = onProgress.mock.calls.length;
    finishCollection();
    await result;
    expect(whenModelsReady).not.toHaveBeenCalled();
    expect(warmShaders).not.toHaveBeenCalled();
    expect(presentFirstFrame).not.toHaveBeenCalled();
    expect(onProgress).toHaveBeenCalledTimes(progressCount);
  });
});
