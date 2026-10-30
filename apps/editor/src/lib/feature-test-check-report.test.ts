import { describe, expect, it } from "vitest";
import type { RenderDiagnostics } from "@haptic/render";
import type { FeatureTestBenchmarkSample, FeatureTestCheckReport, FeatureTestCheckSceneResult } from "../services/feature-test-check";
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
      qualityLimits: [], pipeline: { effective: { gpuBackend: "webgl2" } },
    } as unknown as RenderDiagnostics;
    const report: FeatureTestCheckReport = {
      mode: "full", startedAt: Date.UTC(2026, 9, 10, 12), durationMs: 95_000, cancelled: false, pageErrors: ["TypeError: x is undefined"],
      scenes: [{
        name: "main", path: "assets/main.scene.hasset", passed: false,
        problems: ["Play did not finish loading in 120 s (stuck at Loading Models 45%)."],
        editor: { status: "ready", ms: 4200, phase: null, frames: { frames: 180, durationMs: 3000, fps: 60, p95Ms: 18, maxMs: 40, stalls: 0 }, error: null, gpu: null },
        play: { status: "timeout", ms: 120_000, phase: "Loading Models 45%", frames: null, runtimeFps: null, snapshot: null, firstDraws: null, commands: [], benchmark: [],
          logs: [{ severity: "error", message: "Material FT_Glass failed to compile" }] },
        session: { diagnostics: [], droppedDiagnostics: 0, runtimeMode: "worker", textures: { before: 55, after: 55, leak: false, quarantined: false } },
      }, {
        name: "FT_2D", path: "assets/FeatureTest/Scenes/FT_2D.scene.hasset", passed: true, problems: [],
        editor: { status: "ready", ms: 900, phase: null, frames: null, error: null, gpu: null },
        play: { status: "loaded", ms: 3000, phase: null, frames: { frames: 300, durationMs: 5000, fps: 60, p95Ms: 17, maxMs: 25, stalls: 0 }, runtimeFps: 60,
          snapshot: { drawCalls: 42, meshes: 80, textures: 30, accountedBytes: 8 * 1048576, rendering },
          firstDraws: { draws: 7, loadCompiled: 5, frames: 4, stalls: 2, mostInFrame: 3, worstFrameMs: 180.4, longFrames: 6, longest: [
            { ms: 240.2, engineMs: 31.5, firstDraws: 0, compiles: 0 }, { ms: 180.4, engineMs: 170.1, firstDraws: 3, compiles: 1 },
            { ms: 150, engineMs: 140, firstDraws: 1, compiles: 2 }, { ms: 130, engineMs: 20, firstDraws: 0, compiles: 0 },
            { ms: 120, engineMs: 110, firstDraws: 1, compiles: 0 },
          ] },
          commands: [{ line: "ft_stats", success: true, output: "FeatureTest score 0, spinners 4, spawned 0", ms: 1200 }], benchmark: [], logs: [] },
        session: { diagnostics: [], droppedDiagnostics: 0, runtimeMode: "worker", textures: { before: 30, after: 30, leak: false, quarantined: false } },
      }],
    };
    const lines = formatFeatureTestCheckReport(report, environment).split("\n");
    expect(lines.slice(1, 3)).toEqual([
      "Result: 1/2 scenes passed · took 95.0 s",
      "App: 1.2.3",
    ]);
    expect(lines).toContain("GPU: webgl2 · Apple Inc. · Apple GPU · webgl2");
    expect(lines).toContain("[FAIL] main");
    expect(lines).toContain("  ! Play did not finish loading in 120 s (stuck at Loading Models 45%).");
    expect(lines).toContain("  Play: timeout after 120.0 s at Loading Models 45%");
    expect(lines).toContain("    [error] Material FT_Glass failed to compile");
    expect(lines).toContain("  > ft_stats: ok in 1.2 s · FeatureTest score 0, spinners 4, spawned 0");
    expect(lines).toContain("  First draws after load: 7 (5 compiled by the load) in 4 frames · 2 over 100 ms · worst 180 ms · most 3 in a frame");
    expect(lines).toContain("  Long frames after load: 6 over 100 ms · longest 240 ms (engine 32 ms, 0 first draws, 0 compiles), 180 ms (engine 170 ms, 3 first draws, 1 compile), 150 ms (engine 140 ms, 1 first draw, 2 compiles), 130 ms (engine 20 ms, 0 first draws, 0 compiles)");
    expect(lines).toContain("  TypeError: x is undefined");
  });

  it("recommends the highest quality tier every benchmarked scene holds at 60 and 30 fps", () => {
    const sample = (label: string, fps: number, p95Ms: number): FeatureTestBenchmarkSample => ({
      label, frames: { frames: fps * 5, durationMs: 5000, fps, p95Ms, maxMs: p95Ms, stalls: 0 }, runtimeFps: fps,
      cpuMs: 4, gpuMs: null, drawCalls: 100, resolution: "1280x720@1.00", failed: [],
    });
    const scene = (name: string, benchmark: FeatureTestBenchmarkSample[]): FeatureTestCheckSceneResult => ({
      name, path: `assets/${name}.scene.hasset`, passed: true, problems: [],
      editor: { status: "ready", ms: 1000, phase: null, frames: null, error: null, gpu: null },
      play: { status: "loaded", ms: 2000, phase: null, frames: null, runtimeFps: null, snapshot: null, firstDraws: null, commands: [], benchmark, logs: [] },
      session: null,
    });
    const report: FeatureTestCheckReport = {
      mode: "benchmark", startedAt: 0, durationMs: 600_000, cancelled: false, pageErrors: [],
      scenes: [
        scene("light", [sample("low", 60, 18), sample("medium", 60, 19), sample("high", 58, 22),
          sample("ultra", 40, 30)]),
        scene("heavy", [sample("low", 59, 20), sample("medium", 35, 40), sample("high", 25, 60),
          sample("ultra", 20, 80)]),
      ],
    };
    const lines = formatFeatureTestCheckReport(report, environment).split("\n");
    expect(lines).toContain("Benchmark: highest tier every benchmarked scene holds at 60 fps: low · at 30 fps: medium (2/2 scenes benchmarked)");
    expect(lines).toContain("  Highest tier at 60 fps: high · at 30 fps: ultra");
  });

  it("tabulates a breakdown's steps: mean-based change, vsync shares, bound and setting flags", () => {
    const settings = { shadows: "high 2048", "water.reflections": "planar", "water.shadingDetail": "medium", "post.enabled": "true" };
    const sample = (label: string, meanMs: number, extra: Partial<FeatureTestBenchmarkSample> = {}): FeatureTestBenchmarkSample => ({
      label, baseline: label.startsWith("baseline"),
      frames: { frames: 100, durationMs: meanMs * 100, fps: 1000 / meanMs, medianMs: 33.3, meanMs, p95Ms: meanMs + 8, maxMs: meanMs + 10, stalls: 0, vsync: [0.1, 0.8, 0.05, 0.05] },
      runtimeFps: null, cpuMs: 14.2, gpuMs: null, drawCalls: 575, draws: { median: 575, min: 544, max: 605, samples: 10 },
      resolution: "1180x788@1.00", failed: [], settings, unsettled: { firstDraws: 0, compiling: 0, settleMs: 3000 }, ...extra,
    });
    const report: FeatureTestCheckReport = {
      mode: "breakdown", startedAt: 0, durationMs: 300_000, cancelled: false, pageErrors: [],
      scenes: [{
        name: "FT_World", path: "assets/FeatureTest/Scenes/FT_World.scene.hasset", passed: true, problems: [],
        editor: { status: "ready", ms: 1000, phase: null, frames: null, error: null, gpu: null },
        play: { status: "loaded", ms: 2000, phase: null, frames: null, runtimeFps: null, snapshot: null, firstDraws: null, commands: [],
          benchmark: [
            sample("baseline 1", 38),
            sample("water reflections sky", 30, { settings: { ...settings, "water.reflections": "sky" } }),
            sample("water detail low", 36, { settings: { ...settings, "water.shadingDetail": "low", "water.reflections": "sky" } }),
            sample("water detail medium", 16.7, { cpuMs: 10, unsettled: { firstDraws: 3, compiling: 1, settleMs: 90_000 } }),
            sample("baseline 2", 42, { settings: { ...settings, "post.enabled": "false" } }),
          ], logs: [] },
        session: null,
      }],
    };
    const lines = formatFeatureTestCheckReport(report, environment).split("\n");
    const row = (label: string) => lines.find((line) => line.startsWith(`    ${label} `))!;
    expect(lines[0]).toMatch(/^Haptic Feature Test Check \(Breakdown\)/);
    expect(lines.some((line) => line.includes("60 fps cap"))).toBe(true);
    expect(lines.filter((line) => line.startsWith("  Legend: ")).length).toBe(1);
    // Mean frame time against the baselines around the step; vsync shares; GPU-bound well past the CPU cost.
    expect(row("water reflections sky")).toMatch(/^ {4}water reflections sky 33 {3}30\.0ms {2}38ms {3}10\/80\/5\/5 {7}-10\.0ms -25% {5}14\.2ms {2}gpu {3}575 \(544-605\) water\.reflections=sky$/);
    expect(row("water detail low")).toContain("water.shadingDetail=low · UNEXPECTED: water.reflections=sky");
    expect(row("water detail medium")).toContain("vsync");
    expect(row("water detail medium")).toContain("UNSETTLED: 3 first drawn, 1 compiling · no setting changed");
    expect(row("baseline 2")).toContain("+4.0ms +11%");
    expect(row("baseline 2")).toContain("NOT RESTORED: post.enabled=false");
    expect(row("baseline 1")).toMatch(/\+0\.0ms \+0% +14\.2ms {2}gpu {3}575 \(544-605\)$/);
    expect(lines.some((line) => line.includes("Highest tier"))).toBe(false);
  });

  it("shows the counters' medians with their ranges when frames differ", () => {
    const report: FeatureTestCheckReport = {
      mode: "benchmark", startedAt: 0, durationMs: 300_000, cancelled: false, pageErrors: [],
      scenes: [{
        name: "FT_World", path: "assets/FeatureTest/Scenes/FT_World.scene.hasset", passed: true, problems: [],
        editor: { status: "ready", ms: 1000, phase: null, frames: null, error: null, gpu: null },
        play: { status: "loaded", ms: 2000, phase: null, frames: null, runtimeFps: null,
          snapshot: { drawCalls: 605, meshes: 80, textures: 30, accountedBytes: 0, rendering: null },
          counters: { draws: { median: 575, min: 544, max: 605, samples: 10 }, cpuMs: null, gpuMs: null }, firstDraws: null, commands: [],
          benchmark: [{
            label: "baseline", frames: { frames: 100, durationMs: 4000, fps: 25, medianMs: 40, p95Ms: 46, maxMs: 50, stalls: 0 },
            runtimeFps: null, cpuMs: 14.2, gpuMs: null, drawCalls: 575, draws: { median: 575, min: 544, max: 605, samples: 10 },
            cpu: { median: 14.2, min: 13.1, max: 16.0, samples: 10 },
            resolution: "1180x788@1.00", failed: [],
          }], logs: [] },
        session: null,
      }],
    };
    const lines = formatFeatureTestCheckReport(report, environment).split("\n");
    expect(lines.some((line) => line.startsWith("  Render: draws 575 (544-605) · meshes 80"))).toBe(true);
    expect(lines.some((line) => line.includes("14.2 (13.1-16.0)ms  -                   575 (544-605) 1180x788@1.00"))).toBe(true);
  });

  it("shows an editor load failure's error and the viewport's GPU when Play never ran", () => {
    const report: FeatureTestCheckReport = {
      mode: "quick", startedAt: 0, durationMs: 15_400, cancelled: false, pageErrors: [],
      scenes: [{
        name: "main", path: "assets/main.scene.hasset", passed: false,
        problems: ["Editor viewport reported Scene Loading Failed at Presenting First Frame."],
        editor: { status: "failed", ms: 15_300, phase: "Presenting First Frame", frames: null,
          error: ["Error: The scene did not present a frame before the loading deadline. Ready: true; draws: 3; rendered: true; GPU pending: true; copied: false."],
          gpu: { api: "webgpu", vendor: "apple", renderer: "apple-a16", version: null } },
        play: { status: "not-started", ms: 0, phase: null, frames: null, runtimeFps: null, snapshot: null, firstDraws: null, commands: [], benchmark: [], logs: [] },
        session: null,
      }],
    };
    const lines = formatFeatureTestCheckReport(report, environment).split("\n");
    expect(lines).toContain("GPU: webgpu · apple · apple-a16");
    expect(lines).toContain("  Editor: failed after 15.3 s at Presenting First Frame");
    expect(lines.slice(lines.indexOf("  Editor error:") + 1, lines.indexOf("  Editor error:") + 2)).toEqual([
      "    Error: The scene did not present a frame before the loading deadline. Ready: true; draws: 3; rendered: true; GPU pending: true; copied: false.",
    ]);
  });
});
