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
  it("reports collect then model-ready progress", async () => {
    const progress: Array<{ value: number; phase: string }> = [];
    const collect = vi.fn(async () => undefined);
    const whenModelsReady = vi.fn(async () => undefined);
    await runSceneViewportBlockingLoad({
      collect,
      whenModelsReady,
      onProgress: (value, phase) => progress.push({ value, phase }),
    });
    expect(collect).toHaveBeenCalledOnce();
    expect(whenModelsReady).toHaveBeenCalledOnce();
    expect(progress).toEqual([
      { value: 0, phase: "Collecting Assets" },
      { value: 50, phase: "Loading Models" },
      { value: 100, phase: "Loading Models" },
    ]);
  });
});
