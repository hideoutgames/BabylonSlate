import { describe, expect, it } from "vitest";
import { formatSceneLoadReport, hostMemoryLine, textureMemoryLine, worldLoadLine } from "./scene-load-report";

const environment = {
  appVersion: "1.2.3", userAgent: "Mozilla/5.0 (iPad)", platform: "iPad", touchPoints: 5,
  devicePixelRatio: 2, screen: "820x1180", viewport: "820x1100", cores: 6, memoryGb: null,
};

describe("formatSceneLoadReport", () => {
  it("names the failure, where it happened, the GPU, the error chain and recent console errors", () => {
    const error = new Error("Material FT_Glass: WebGPU pipeline creation failed", { cause: new TypeError("binding 3 is undefined") });
    const lines = formatSceneLoadReport({
      surface: "Scene Viewport", scene: "assets/main.scene.hasset", phase: "Compiling Shaders", progress: null, failed: true,
      elapsedMs: 21_400, error, gpu: { api: "webgpu", vendor: "apple", renderer: "apple-a16", version: null },
      details: ["Project rendering: path auto · backend webgpu"],
    }, environment, ["[error] 10:00:01 [viewport] failed to load scene Error: Material FT_Glass"], ["Graphics error trace (1 failing WebGL call, newest last):", "  21:06:59 drawElements(0x4, 36, 0x1403, 0) → 1282 INVALID_OPERATION"]).split("\n");

    expect(lines[1]).toBe("Status: FAILED (Scene Loading Failed) · Scene Viewport · assets/main.scene.hasset");
    expect(lines[2]).toBe("Phase: Compiling Shaders · 21.4 s since loading started");
    expect(lines).toContain("GPU: webgpu · apple · apple-a16");
    expect(lines).toContain("Project rendering: path auto · backend webgpu");
    expect(lines).toContain("  Error: Material FT_Glass: WebGPU pipeline creation failed");
    expect(lines).toContain("    TypeError: binding 3 is undefined");
    expect(lines.slice(-4)).toEqual([
      "Recent console errors and warnings (1):",
      "  [error] 10:00:01 [viewport] failed to load scene Error: Material FT_Glass",
      "Graphics error trace (1 failing WebGL call, newest last):",
      "  21:06:59 drawElements(0x4, 36, 0x1403, 0) → 1282 INVALID_OPERATION",
    ]);
  });
});

describe("worldLoadLine", () => {
  it("says what the first frame and the load rehearsal are waiting on", () => {
    expect(worldLoadLine({
      presentation: { ready: false, draws: 0, rendered: false, gpuPending: false, copied: false },
      rehearsal: { done: false, steps: 12, total: 30, timedOut: 2, omitted: 0, ms: 61_400 },
    })).toBe("World load: first frame ready false · draws 0 · rendered false · GPU pending false · copied false · rehearsal running 12/30 steps · timed out 2 · left out 0 · 61 s");
  });
});

describe("memory lines", () => {
  it("labels an iOS app's counters as the host process, apart from the web content", () => {
    expect(hostMemoryLine({ appFootprintBytes: 52_428_800, appAvailableBytes: 1_073_741_824, systemAvailableBytes: 314_572_800 }, 1_500))
      .toBe("Memory: app process (not web content) 50 MB · app may still allocate 1024 MB · device available 300 MB (sampled 1.5 s ago)");
  });
  it("lists the desktop app's processes, GPU process included", () => {
    expect(hostMemoryLine({ rendererProcessBytes: 419_430_400, gpuProcessBytes: 629_145_600, mainProcessBytes: 104_857_600,
      allProcessesBytes: 1_258_291_200, jsHeapBytes: 209_715_200 }, 0))
      .toBe("Memory: renderer process 400 MB · GPU process 600 MB · main process 100 MB · all app processes 1200 MB · JS heap 200 MB (sampled 0.0 s ago)");
  });
  it("states the texture estimate", () => {
    expect(textureMemoryLine({ bytes: 292_552_704, textures: 61 })).toBe("GPU textures (estimate): 61 textures, about 279 MB");
  });
});
