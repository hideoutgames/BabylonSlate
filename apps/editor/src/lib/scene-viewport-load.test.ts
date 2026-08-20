import { describe, expect, it, vi } from "vitest";
import {
  isSceneViewportRemountLoad,
  runSceneViewportBlockingLoad,
} from "./scene-viewport-load";

describe("isSceneViewportRemountLoad", () => {
  it("is true until that engine generation has finished its first load", () => {
    expect(isSceneViewportRemountLoad(1, -1)).toBe(true);
    expect(isSceneViewportRemountLoad(2, 1)).toBe(true);
    expect(isSceneViewportRemountLoad(1, 1)).toBe(false);
  });
});

describe("runSceneViewportBlockingLoad", () => {
  it("reports collect then model-ready then shader-warm progress", async () => {
    const progress: Array<{ value: number; phase: string }> = [];
    const collect = vi.fn(async () => undefined);
    const whenModelsReady = vi.fn(async () => undefined);
    const warmShaders = vi.fn(async () => undefined);
    await runSceneViewportBlockingLoad({
      collect,
      whenModelsReady,
      warmShaders,
      onProgress: (value, phase) => progress.push({ value, phase }),
    });
    expect(collect).toHaveBeenCalledOnce();
    expect(whenModelsReady).toHaveBeenCalledOnce();
    expect(warmShaders).toHaveBeenCalledOnce();
    expect(progress).toEqual([
      { value: 0, phase: "Collecting Assets" },
      { value: 34, phase: "Loading Models" },
      { value: 67, phase: "Warming Shaders" },
      { value: 100, phase: "Warming Shaders" },
    ]);
  });
});
