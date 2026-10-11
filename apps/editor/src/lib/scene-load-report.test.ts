import { describe, expect, it } from "vitest";
import { formatSceneLoadReport } from "./scene-load-report";

const environment = {
  appVersion: "1.2.3", userAgent: "Mozilla/5.0 (iPad)", platform: "iPad", touchPoints: 5,
  devicePixelRatio: 2, screen: "820x1180", viewport: "820x1100", cores: 6, memoryGb: null,
};

describe("formatSceneLoadReport", () => {
  it("names the failure, where it happened, the GPU, the error chain and recent console errors", () => {
    const error = new Error("Material FT_Glass: WebGPU pipeline creation failed", { cause: new TypeError("binding 3 is undefined") });
    const lines = formatSceneLoadReport({
      surface: "Scene Viewport", scene: "assets/main.scene.babasset", phase: "Warming Shaders", progress: null, failed: true,
      elapsedMs: 21_400, error, gpu: { api: "webgpu", vendor: "apple", renderer: "apple-a16", version: null },
      details: ["Project rendering: path auto · backend webgpu"],
    }, environment, ["[error] 10:00:01 [viewport] failed to load scene Error: Material FT_Glass"], ["Graphics error trace (1 failing WebGL call, newest last):", "  21:06:59 drawElements(0x4, 36, 0x1403, 0) → 1282 INVALID_OPERATION"]).split("\n");

    expect(lines[1]).toBe("Status: FAILED (Scene Loading Failed) · Scene Viewport · assets/main.scene.babasset");
    expect(lines[2]).toBe("Phase: Warming Shaders · 21.4 s since loading started");
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
