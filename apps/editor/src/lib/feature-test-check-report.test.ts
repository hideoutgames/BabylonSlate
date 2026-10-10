import { describe, expect, it } from "vitest";
import type { RenderDiagnostics } from "@babylonslate/render";
import type { FeatureTestCheckReport } from "../services/feature-test-check";
import { formatFeatureTestCheckReport, type FeatureTestCheckEnvironment } from "./feature-test-check-report";

const environment: FeatureTestCheckEnvironment = {
  appVersion: "1.2.3", userAgent: "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)", platform: "iPad",
  touchPoints: 5, devicePixelRatio: 2, screen: "1024x1366", viewport: "1024x1290", cores: 8, memoryGb: null,
};

describe("formatFeatureTestCheckReport", () => {
  it("leads with the outcome and device, then shows why each scene failed", () => {
    const rendering = {
      adapter: { api: "webgl2", vendor: "Apple Inc.", renderer: "Apple GPU", version: "WebGL 2.0" },
      cpuMs: 4.2, gpuMs: null, gpuStatus: "unsupported", width: 2048, height: 1536, scalingLevel: 1,
      qualityLimits: [], pipeline: { effective: { renderPath: "forward", gpuBackend: "webgl2" } },
    } as unknown as RenderDiagnostics;
    const report: FeatureTestCheckReport = {
      mode: "full", startedAt: Date.UTC(2026, 9, 10, 12), durationMs: 95_000, cancelled: false, pageErrors: ["TypeError: x is undefined"],
      scenes: [{
        name: "main", path: "assets/main.scene.babasset", passed: false,
        problems: ["Play did not finish loading in 120 s (stuck at Loading Models 45%)."],
        editor: { status: "ready", ms: 4200, phase: null, frames: { frames: 180, durationMs: 3000, fps: 60, p95Ms: 18, maxMs: 40, stalls: 0 } },
        play: { status: "timeout", ms: 120_000, phase: "Loading Models 45%", frames: null, runtimeFps: null, snapshot: null, commands: [],
          logs: [{ severity: "error", message: "Material FT_Glass failed to compile" }] },
        session: { diagnostics: [], droppedDiagnostics: 0, runtimeMode: "worker", textures: { before: 55, after: 55, leak: false, quarantined: false } },
      }, {
        name: "FT_2D", path: "assets/FeatureTest/Scenes/FT_2D.scene.babasset", passed: true, problems: [],
        editor: { status: "ready", ms: 900, phase: null, frames: null },
        play: { status: "loaded", ms: 3000, phase: null, frames: { frames: 300, durationMs: 5000, fps: 60, p95Ms: 17, maxMs: 25, stalls: 0 }, runtimeFps: 60,
          snapshot: { drawCalls: 42, meshes: 80, textures: 30, accountedBytes: 8 * 1048576, rendering },
          commands: [{ line: "ft_stats", success: true, output: "FeatureTest score 0, spinners 4, spawned 0" }], logs: [] },
        session: { diagnostics: [], droppedDiagnostics: 0, runtimeMode: "worker", textures: { before: 30, after: 30, leak: false, quarantined: false } },
      }],
    };
    const lines = formatFeatureTestCheckReport(report, environment).split("\n");
    expect(lines.slice(1, 3)).toEqual([
      "Result: 1/2 scenes passed · took 95.0 s",
      "App: 1.2.3",
    ]);
    expect(lines).toContain("GPU: webgl2 · Apple Inc. · Apple GPU · webgl2 forward");
    expect(lines).toContain("[FAIL] main");
    expect(lines).toContain("  ! Play did not finish loading in 120 s (stuck at Loading Models 45%).");
    expect(lines).toContain("  Play: timeout after 120.0 s at Loading Models 45%");
    expect(lines).toContain("    [error] Material FT_Glass failed to compile");
    expect(lines).toContain("  > ft_stats: ok · FeatureTest score 0, spinners 4, spawned 0");
    expect(lines).toContain("  TypeError: x is undefined");
  });
});
