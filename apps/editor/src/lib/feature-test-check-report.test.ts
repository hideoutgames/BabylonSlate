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
      breakdown: { method: "remove-one", tier: "medium", ab: false, warmMinutes: null, passes: [{ preserveDrawingBuffer: true }], notes: [] },
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
    expect(row("water reflections sky")).toMatch(/^ {4}water reflections sky 33 {3}30\.0ms {2}38ms {3}10\/80\/5\/5 {7}- {13}-10\.0ms -25%\* {5}14\.2ms {2}gpu {3}575 \(544-605\) water\.reflections=sky$/);
    expect(row("water detail low")).toContain("water.shadingDetail=low · UNEXPECTED: water.reflections=sky");
    expect(row("water detail medium")).toContain("vsync");
    expect(row("water detail medium")).toContain("UNSETTLED: 3 first drawn, 1 compiling · no setting changed");
    expect(row("baseline 2")).toContain("+4.0ms +11%*");
    expect(row("baseline 2")).toContain("NOT RESTORED: post.enabled=false");
    expect(row("baseline 1")).toMatch(/\+0\.0ms \+0%\* +14\.2ms {2}gpu {3}575 \(544-605\)$/);
    expect(lines.some((line) => line.includes("Highest tier"))).toBe(false);
    // Without fences: no GPU-busy times, and every change is in mean frame time (marked *).
    expect(lines).toContain("  Timing: no gpu busy (no fences)");
    expect(lines).toContain("  preserveDrawingBuffer: unknown (live)");
  });

  it("shows GPU-busy times and compares them, marks warm-up windows, and states the timing resolution and buffer mode", () => {
    const settings = { shadows: "high 2048", "presentation.preserve": "false" };
    const sample = (label: string, busyMs: number, extra: Partial<FeatureTestBenchmarkSample> = {}): FeatureTestBenchmarkSample => ({
      label, baseline: label.startsWith("baseline"),
      frames: { frames: 100, durationMs: 3330, fps: 30, medianMs: 33.3, meanMs: 33.3, p95Ms: 34, maxMs: 40, stalls: 0, vsync: [0, 1, 0, 0] },
      runtimeFps: null, cpuMs: 8, gpuMs: null, drawCalls: 575, resolution: "1180x788@1.00", failed: [], settings,
      gpuBusy: { frames: 150, medianMs: busyMs, p95Ms: busyMs + 3, pollMs: 4.2, skipped: 0 }, ...extra,
    });
    const report: FeatureTestCheckReport = {
      mode: "breakdown", startedAt: 0, durationMs: 300_000, cancelled: false, pageErrors: [],
      breakdown: { method: "remove-one", tier: "medium", ab: false, warmMinutes: null, passes: [{ preserveDrawingBuffer: true }], notes: [] },
      scenes: [{
        name: "FT_World", path: "assets/FeatureTest/Scenes/FT_World.scene.hasset", passed: true, problems: [],
        editor: { status: "ready", ms: 1000, phase: null, frames: null, error: null, gpu: null },
        play: { status: "loaded", ms: 2000, phase: null, frames: null, runtimeFps: null, snapshot: null, firstDraws: null, commands: [],
          benchmark: [
            sample("warm-up 1", 26, { baseline: false, warmup: true }),
            sample("baseline 1", 20),
            sample("shadows off", 14, { settings: { ...settings, shadows: "off" } }),
            sample("baseline 2", 22),
          ], logs: [] },
        session: null,
      }],
    };
    const lines = formatFeatureTestCheckReport(report, environment).split("\n");
    const row = (label: string) => lines.find((line) => line.startsWith(`    ${label} `))!;
    expect(lines).toContain("  Timing: gpu busy polled every 4.2 ms (each frame up to one poll late)");
    expect(lines).toContain("  preserveDrawingBuffer: off (live)");
    // 14 against the mean of 20 and 22, though every frame lasted two display intervals.
    expect(row("shadows off")).toMatch(/0\/100\/0\/0 {7}14\.0 \(17\) {5}-7\.0ms -33% {7}8\.0ms/);
    expect(row("baseline 2")).toContain("+2.0ms +10% ");
    expect(row("warm-up 1")).toMatch(/26\.0 \(29\) {5}- .*warm-up$/);
  });

  it("reports both passes of the preserveDrawingBuffer A/B under one header: tier, warm device, verdicts and the on/off comparison", () => {
    const restored = "preserveDrawingBuffer is stored as on again, as before the A/B; it applies when the editor next reloads or the project is reopened.";
    const settings = (preserve: string) => ({ shadows: "medium 2048", "geometry.occlusion": "false", "presentation.preserve": preserve });
    const sample = (label: string, busyMs: number | null, preserve: string, extra: Partial<FeatureTestBenchmarkSample> = {}): FeatureTestBenchmarkSample => ({
      label, baseline: label.includes("baseline"),
      frames: { frames: 100, durationMs: 3330, fps: 30, medianMs: 33.3, meanMs: 33.3, p95Ms: 34, maxMs: 40, stalls: 0, vsync: [0, 1, 0, 0] },
      runtimeFps: null, cpuMs: 8, gpuMs: null, drawCalls: 575, resolution: "1180x788@1.00", failed: [], settings: settings(preserve),
      ...(busyMs === null ? {} : { gpuBusy: { frames: 150, medianMs: busyMs, p95Ms: busyMs + 3, pollMs: 4.2, skipped: 0 } }), ...extra,
    });
    // Every baseline frame of the second pass lasted four or more display intervals.
    const saturated: Partial<FeatureTestBenchmarkSample> = {
      frames: { frames: 100, durationMs: 6670, fps: 15, medianMs: 66.7, meanMs: 66.7, p95Ms: 70, maxMs: 80, stalls: 0, vsync: [0, 0, 0, 1] },
    };
    const scene = (name: string, pass: number, benchmark: FeatureTestBenchmarkSample[]): FeatureTestCheckSceneResult => ({
      name, path: `assets/FeatureTest/Scenes/${name}.scene.hasset`, pass, passed: true, problems: [],
      editor: { status: "ready", ms: 1000, phase: null, frames: null, error: null, gpu: null },
      play: { status: "loaded", ms: 2000, phase: null, frames: null, runtimeFps: null, snapshot: null, firstDraws: null, commands: [], benchmark, logs: [] },
      session: null,
    });
    const rooms = { view: "rooms" };
    const report: FeatureTestCheckReport = {
      mode: "breakdown", startedAt: 0, durationMs: 600_000, cancelled: false, pageErrors: [],
      breakdown: { method: "remove-one", tier: "medium", ab: true, warmMinutes: 4, passes: [{ preserveDrawingBuffer: true }, { preserveDrawingBuffer: false }], notes: [restored] },
      scenes: [
        scene("FT_World", 1, [sample("baseline 1", 20, "true"), sample("shadows off", 15, "true", { settings: { ...settings("true"), shadows: "off" } }), sample("baseline 2", 22, "true")]),
        scene("FT_Occlusion", 1, [
          sample("rooms baseline 1", null, "true", rooms),
          sample("rooms occlusion on", null, "true", { ...rooms, settings: { ...settings("true"), "geometry.occlusion": "true" },
            occlusion: { tested: 480, culled: 212, triangles: 1520, ms: 0.42 } }),
          sample("rooms baseline 2", null, "true", rooms),
        ]),
        // 4 against 18.5 and 2 against 19 save 31.5 ms of an 18 ms frame.
        scene("FT_World", 2, [sample("baseline 1", 18, "false", saturated), sample("shadows off", 4, "false"), sample("baseline 2", 19, "false", saturated),
          sample("post off", 2, "false"), sample("baseline 3", 19, "false", saturated)]),
      ],
    };
    const lines = formatFeatureTestCheckReport(report, environment).split("\n");
    expect(lines.slice(1, 3)).toEqual(["Result: 3/3 scenes passed · NON-ADDITIVE · SATURATED · took 600.0 s", "WARM DEVICE: previous run ended 4 min ago"]);
    const header = lines.indexOf("Breakdown: remove-one · base medium · preserveDrawingBuffer A/B: pass 1 on, pass 2 off (stored setting; each pass's live value below)");
    expect(lines.slice(header + 1, header + 3)).toEqual([
      // On: the median of 20 and 22; off: of 18, 19 and 19.
      "preserveDrawingBuffer on vs off, median baseline gpu busy: FT_World 21.0 vs 19.0 ms (off -2.0 ms, -10%)",
      restored,
    ]);
    expect(lines.filter((line) => line.startsWith("Pass "))).toEqual(["Pass 1 of 2 · preserveDrawingBuffer on (live)", "Pass 2 of 2 · preserveDrawingBuffer off (live)"]);
    // Each scene names its own live value, with the base on the next line.
    const preserveLines = lines.flatMap((line, index) => line.startsWith("  preserveDrawingBuffer: ") ? [[line, lines[index + 1]]] : []);
    expect(preserveLines).toEqual([
      ["  preserveDrawingBuffer: on (live)", "  Base: medium"],
      ["  preserveDrawingBuffer: on (live)", "  Base: medium"],
      ["  preserveDrawingBuffer: off (live)", "  Base: medium"],
    ]);
    // Only the saturated second pass carries the verdicts.
    expect(lines.filter((line) => line.startsWith("  NON-ADDITIVE: ") || line.startsWith("  SATURATED: "))).toEqual([
      "  NON-ADDITIVE: step savings sum to 31.5 ms, past the first baseline's 18.0 ms gpu busy; the changes do not add up, so do not sum them",
      "  SATURATED: 100% of baseline frames lasted 4+ display intervals; the GPU is saturated, so a change is not that feature's own cost",
    ]);
    // The rooms camera's step against its own baselines, with what it culled.
    const occlusion = lines.find((line) => line.startsWith("    rooms occlusion on "))!;
    expect(occlusion).toContain("+0.0ms +0%*");
    expect(occlusion).toMatch(/575 {11}geometry\.occlusion=true · occlusion culled 212\/480 · 1520 tris · 0\.42 ms$/);
  });

  it("states a warm device and the verdicts only when they apply", () => {
    const report: FeatureTestCheckReport = {
      mode: "breakdown", startedAt: 0, durationMs: 1000, cancelled: false, pageErrors: [], scenes: [],
      breakdown: { method: "remove-one", tier: "medium", ab: true, warmMinutes: null, passes: [{ preserveDrawingBuffer: true }], notes: ["The preserveDrawingBuffer A/B ran one pass: the first was cancelled."] },
    };
    const lines = formatFeatureTestCheckReport(report, environment).split("\n");
    expect(lines[1]).toBe("Result: 0/0 scenes passed · took 1.0 s");
    expect(lines.some((line) => line.startsWith("WARM DEVICE"))).toBe(false);
    expect(lines).toContain("The preserveDrawingBuffer A/B ran one pass: the first was cancelled.");
    expect(lines.some((line) => line.startsWith("preserveDrawingBuffer on vs off"))).toBe(false);
  });

  it("reports an add-one Breakdown: warm-up drift, skipped steps, a step's cost beyond the step it includes, and OVER CAP", () => {
    const settings = {
      "post.enabled": "false", "post.ambientOcclusion": "false", "post.antiAliasing": "off", "post.samples": "1",
      "water.shadingDetail": "low", "water.fft": "256x3",
    };
    const sample = (label: string, busyMs: number, extra: Partial<FeatureTestBenchmarkSample> = {}): FeatureTestBenchmarkSample => ({
      label, baseline: label.startsWith("baseline"),
      frames: { frames: 100, durationMs: 1670, fps: 60, medianMs: 16.7, meanMs: 16.7, p95Ms: 17, maxMs: 20, stalls: 0, vsync: [1, 0, 0, 0] },
      runtimeFps: null, cpuMs: 6, gpuMs: null, drawCalls: 300, resolution: "590x394@2.00", failed: [], settings,
      gpuBusy: { frames: 300, medianMs: busyMs, p95Ms: busyMs + 2, pollMs: 4.2, skipped: 0 }, ...extra,
    });
    const report: FeatureTestCheckReport = {
      mode: "breakdown", startedAt: 0, durationMs: 300_000, cancelled: false, pageErrors: [],
      breakdown: { method: "add-one", tier: "low at resolution 0.5", ab: false, warmMinutes: null, passes: [{ preserveDrawingBuffer: true }], notes: [] },
      scenes: [{
        name: "FT_World", path: "assets/FeatureTest/Scenes/FT_World.scene.hasset", passed: true, problems: [],
        editor: { status: "ready", ms: 1000, phase: null, frames: null, error: null, gpu: null },
        play: { status: "loaded", ms: 2000, phase: null, frames: null, runtimeFps: null, snapshot: null, firstDraws: null, commands: [],
          benchmark: [
            sample("warm-up 1", 20, { baseline: false, warmup: true }),
            sample("warm-up 2", 12.5, { baseline: false, warmup: true }),
            sample("warm-up 3", 12.4, { baseline: false, warmup: true }),
            sample("baseline 1", 12),
            sample("post-processing", 15, { settings: { ...settings, "post.enabled": "true" } }),
            sample("baseline 2", 12),
            sample("AO", 19, { settings: { ...settings, "post.enabled": "true", "post.ambientOcclusion": "true" } }),
            sample("baseline 3", 12),
            {
              label: "water detail medium", frames: null, runtimeFps: null, cpuMs: null, gpuMs: null, drawCalls: 0, resolution: null,
              failed: [], baseline: false, skipped: "already water.shadingDetail medium",
            },
            sample("MSAA 4x", 33, { settings: { ...settings, "post.antiAliasing": "msaa4", "post.samples": "4" } }),
            sample("baseline 5", 31),
            sample("water detail high", 31, { settings: { ...settings, "water.shadingDetail": "high", "water.fft": "256x3" } }),
            sample("baseline 6", 30),
          ], logs: [] },
        session: null,
      }],
    };
    const lines = formatFeatureTestCheckReport(report, environment).split("\n");
    const row = (label: string) => lines.find((line) => line.startsWith(`    ${label} `))!;
    expect(lines[1]).toBe("Result: 1/1 scenes passed · OVER CAP · took 300.0 s");
    expect(lines).toContain("Breakdown: add-one · base low at resolution 0.5 · preserveDrawingBuffer on (stored setting; no A/B)");
    expect(lines).toContain("  Base: low at resolution 0.5");
    // The first warm-up window against the last, the steady one the steps start from.
    expect(lines).toContain("  Warm-up drift: first window 20.0 ms, steady 12.4 ms (-38%) over 3 windows (gpu busy)");
    expect(lines).toContain("  OVER CAP: baseline 5 31.0 ms past the 30 ms add-one cap; the GPU may change speed there, so changes are not costs");
    expect(lines.some((line) => line.startsWith("  NON-ADDITIVE"))).toBe(false);
    expect(row("post-processing")).toMatch(/\+3\.0ms \+25% .*post\.enabled=true$/);
    // 19 against 12 and 12 is +7; the stack alone cost +3.
    expect(row("AO")).toMatch(/\+7\.0ms \+58% .*post\.enabled=true, post\.ambientOcclusion=true · own \+4\.0ms beyond post-processing$/);
    expect(row("water detail medium")).toMatch(/^ {4}water detail medium +- +- +- +- +- +- +- +- +- +skipped \(already water\.shadingDetail medium\)$/);
    expect(row("MSAA 4x")).toContain("OVER 30 ms: the GPU may have changed speed");
    // A water detail step names the FFT grid it ran.
    expect(row("water detail high")).toMatch(/water\.shadingDetail=high · fft 256x3 · OVER 30 ms/);
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
