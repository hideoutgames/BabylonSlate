import { describe, expect, it } from "vitest";
import type { RenderDiagnostics } from "@haptic/render";
import type { FeatureTestBenchmarkSample, FeatureTestCheckReport, FeatureTestCheckSceneResult, SampledGpuProbe } from "../services/feature-test-check";
import { formatFeatureTestCheckReport, type FeatureTestCheckEnvironment } from "./feature-test-check-report";
import type { LongFrameAttribution } from "../services/frame-attribution";

const environment: FeatureTestCheckEnvironment = {
  appVersion: "1.2.3", userAgent: "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)", platform: "iPad",
  touchPoints: 5, devicePixelRatio: 2, screen: "1024x1366", viewport: "1024x1290", cores: 8, memoryGb: null,
};

describe("formatFeatureTestCheckReport", () => {
  it("leads with the outcome and device, then shows why each scene failed", () => {
    const rendering = {
      adapter: { vendor: "Apple Inc.", renderer: "Apple GPU", version: "WebGL 2.0" },
      cpuMs: 4.2, gpuMs: null, gpuStatus: "unsupported", width: 2048, height: 1536, scalingLevel: 1,
      qualityLimits: [],
      // The last frame's split; the report prefers the medians sampled while Play was measured.
      drawPasses: { objects: 9, layers: 33 }, drawPassMs: { objects: 30 },
      layerBatches: { visuals: 181, draws: 60, batches: 9, batched: 130, alone: { single: 1, material: 30, transform: 4, vertexColor: 0, other: 2, unmatched: 14 } },
      programs: {
        programs: 120, neverDrawn: 35, passes: { objects: 50, layers: 15, shadows: 20 }, shaders: 70, mostVariants: 6,
        materials: { builds: 48, programs: 30, adopted: 18, sameShaderRebuilds: 2 },
        splitBy: [
          { define: "PREPASS", with: ["PREPASS_DEPTH", "SCENE_MRT_COUNT"], shaders: 30 }, { define: "INSTANCES", with: [], shaders: 4 },
          ...["A", "B", "C", "D", "E", "F", "G", "H"].map((define) => ({ define, with: [], shaders: 1 })),
        ],
      },
    } as unknown as RenderDiagnostics;
    const report: FeatureTestCheckReport = {
      mode: "full", startedAt: Date.UTC(2026, 9, 10, 12), durationMs: 95_000, cancelled: false, pageErrors: ["TypeError: x is undefined"],
      scenes: [{
        name: "main", path: "assets/main.scene.hasset", passed: false,
        problems: ["Play did not finish loading in 120 s (stuck at Loading Models 45%)."],
        editor: { status: "ready", ms: 4200, phase: null, frames: { frames: 180, durationMs: 3000, fps: 60, medianMs: 16.7, meanMs: 3000 / 180, vsync: [1, 0, 0, 0], p95Ms: 18, maxMs: 40, stalls: 0 }, error: null, gpu: null },
        play: { status: "timeout", ms: 120_000, phase: "Loading Models 45%", frames: null, runtimeFps: null, snapshot: null, presentation: null, firstDraws: null, commands: [], benchmark: [],
          logs: [{ severity: "error", message: "Material FT_Glass failed to compile" }] },
        session: { diagnostics: [], droppedDiagnostics: 0, runtimeMode: "worker", textures: { before: 55, after: 55, leak: false, quarantined: false } },
      }, {
        name: "FT_2D", path: "assets/FeatureTest/Scenes/FT_2D.scene.hasset", passed: true, problems: [],
        editor: { status: "ready", ms: 900, phase: null, frames: null, error: null, gpu: null },
        play: { status: "loaded", ms: 3000, phase: null, frames: { frames: 300, durationMs: 5000, fps: 60, medianMs: 16.7, meanMs: 5000 / 300, vsync: [1, 0, 0, 0], p95Ms: 17, maxMs: 25, stalls: 0 }, runtimeFps: 60,
          snapshot: { drawCalls: 42, meshes: 80, textures: 30, accountedBytes: 8 * 1048576, rendering },
          counters: {
            draws: { median: 400, min: 390, max: 410, samples: 10 }, cpuMs: { median: 40, min: 38, max: 44, samples: 10 }, gpuMs: null,
            drawPasses: { objects: 10, shadows: 0, post: 2, layers: 30 },
            drawPassMs: { objects: 6.26, mirrors: 8.24, shadows: 0, other: 0.04, post: 1 }, cpuMsWithoutDraws: { median: 12, min: 11, max: 13, samples: 4 },
            cpuMsWithoutFrameFence: { median: 31.5, min: 30, max: 33, samples: 4 },
            webGl: { windows: 3, frames: 41, cpuMs: 40.2, totalMs: 17.25, groups: {
              fenceSync: { ms: 6.5, calls: 1 }, getError: { ms: 0, calls: 0 }, checkFramebufferStatus: { ms: 1.25, calls: 4.5 },
              draws: { ms: 5, calls: 400 }, uniforms: { ms: 2.5, calls: 1800 }, other: { ms: 2, calls: 2600 },
            } },
          },
          presentation: {
            frames: { drawn: 280, held: 4, skipped: 16, heldReasons: { "FrameGraph is not ready.": 1, "Scene is not ready to render.": 3 } },
            contextLosses: 0, imageBlack: [0, 0.031, null],
          },
          firstDraws: { draws: 7, loadCompiled: 5, loadPrograms: 140, frames: 4, stalls: 2, mostInFrame: 3, worstFrameMs: 180.4, longFrames: 6,
            passes: { objects: 2, shadows: 4, outlines: 1 }, longest: [
              { ms: 240.2, engineMs: 31.5, firstDraws: 0, compiles: 0 },
              { ms: 180.4, engineMs: 170.1, firstDraws: 3, compiles: 1, passes: { objects: 1, shadows: 2 } },
              { ms: 150, engineMs: 140, firstDraws: 1, compiles: 2, passes: { outlines: 1 } }, { ms: 130, engineMs: 20, firstDraws: 0, compiles: 0 },
              { ms: 120, engineMs: 110, firstDraws: 1, compiles: 0, passes: { shadows: 1 } },
            ] },
          // 140 strict readiness checks over the 280 frames drawn while sampled, 4.2 s of them.
          work: { drawn: 280, work: { graphBuilds: 0, shadowAdmissions: 0, shadowAdmissionMs: 0, strictReadinessChecks: 140, readinessProbeMs: 4200, outlineReadinessChecks: 0,
            readinessProbeReasons: {}, readinessSwapRechecks: 0, failedReadinessProbes: 0, scopedReadinessProbes: 0, scopedReadinessMismatches: 0, scopedReadinessIdleRequests: 0, readinessBlockers: [] } },
          commands: [{ line: "ft_stats", success: true, output: "FeatureTest score 0, spinners 4, spawned 0", ms: 1200 }], benchmark: [], logs: [] },
        session: { diagnostics: [], droppedDiagnostics: 0, runtimeMode: "worker", textures: { before: 30, after: 30, leak: false, quarantined: false } },
      }],
    };
    const lines = formatFeatureTestCheckReport(report, environment).split("\n");
    expect(lines.slice(1, 3)).toEqual([
      "Result: 1/2 scenes passed · took 95.0 s",
      "App: 1.2.3",
    ]);
    expect(lines).toContain("GPU: Apple Inc. · Apple GPU");
    expect(lines).toContain("[FAIL] main");
    expect(lines).toContain("  ! Play did not finish loading in 120 s (stuck at Loading Models 45%).");
    expect(lines).toContain("  Play: timeout after 120.0 s at Loading Models 45%");
    expect(lines).toContain("    [error] Material FT_Glass failed to compile");
    expect(lines).toContain("  > ft_stats: ok in 1.2 s · FeatureTest score 0, spinners 4, spawned 0");
    // What drew the frame, the most first, and what the Engine compiled for it.
    expect(lines).toContain("  Draws per pass: layers 30, objects 10, post 2");
    // Its main-thread time by pass, right below: the most first, one decimal, a pass under 0.05 ms left out.
    expect(lines[lines.indexOf("  Draws per pass: layers 30, objects 10, post 2") + 1]).toBe("  CPU per pass: mirrors 8.2 ms, objects 6.3 ms, post 1.0 ms");
    // Before the view's first timed frame: nothing sampled, and the last frame's times all zero.
    const untimed = structuredClone(report);
    const untimedPlay = untimed.scenes[1]!.play;
    delete untimedPlay.counters!.drawPassMs;
    untimedPlay.snapshot!.rendering = { ...untimedPlay.snapshot!.rendering!, drawPassMs: { objects: 0, mirrors: 0 } } as RenderDiagnostics;
    expect(formatFeatureTestCheckReport(untimed, environment).split("\n").some((line) => line.startsWith("  CPU per pass"))).toBe(false);
    // The layers' visuals: 130 of the 181 drew in 9 batches; the 51 others took a draw each, by reason, the most first.
    expect(lines).toContain("  Scene Layers: 181 visuals in 60 draws · 130 in 9 batches · alone: 30 another Material, 14 nothing else drew the same, 4 mirrored, 2 other, 1 only draw of its pass");
    expect(lines).toContain("  Programs: 120 on the Engine · 35 never drawn · 70 shaders, at most 6 programs of one · by first pass: objects 50, shadows 20, layers 15 · Material builds 48 on 30 programs (18 adopted one, 2 rebuilt unchanged)");
    // What the further programs are for: the geometry pass's defines (two more with PREPASS) split 30 shaders, instancing 4.
    // 12 of a frame's 40 ms remain without its draws: 30%. Over 400 draw calls that is 30 µs each, and 70 µs for the draw.
    expect(lines).toContain("  CPU without draws: 12.0 ms of 40.0 ms a frame (30%); draws, clears and uniform uploads take the rest · per draw call 30 µs without and 70 µs for the draw");
    // With the frame-end fence off, and where the frame's main-thread time went inside WebGL: a group without a call left out.
    expect(lines).toContain("  CPU with no frame-end fence: 31.5 ms of 40.0 ms (framesinflight off for 4 reads, then restored)");
    expect(lines).toContain("  WebGL calls: 17.3 ms a frame in WebGL of 40.2 ms cpu (3 windows, 41 frames each) · fenceSync 6.50 (1.0) · checkFramebufferStatus 1.25 (4.5) · draws 5.00 (400) · uniforms 2.50 (1800) · other 2.00 (2600)");
    // The share of frames by display intervals.
    expect(lines.find((line) => line.startsWith("  Play: loaded in 3.0 s"))).toContain(" · intervals 1/2/3/4+: 100/0/0/0% ");
    // The eight that split most shaders are named and the rest counted.
    expect(lines).toContain("  Shaders split by define: PREPASS (+2) 30 · INSTANCES 4 · A 1 · B 1 · C 1 · D 1 · E 1 · F 1 · 2 more");
    // The passes that made the first draws, the most first.
    expect(lines).toContain("  First draws after load: 7 (5 compiled by the load, of 140 it compiled) in 4 frames · 2 over 100 ms · worst 180 ms · most 3 in a frame · by pass: shadows 4, objects 2, outlines 1");
    expect(lines).toContain("  Long frames after load: 6 over 100 ms · longest 240 ms (engine 32 ms, 0 first draws, 0 compiles), 180 ms (engine 170 ms, 3 first draws: shadows 2, objects 1, 1 compile), 150 ms (engine 140 ms, 1 first draw: outlines 1, 2 compiles), 130 ms (engine 20 ms, 0 first draws, 0 compiles)");
    // 4200 ms over 140 checks, and over the 280 frames drawn.
    expect(lines).toContain("  Readiness probes: 140 in 280 drawn frames · 30.0 ms each · 15.0 ms per drawn frame");
    // Holds by reason, the most first.
    expect(lines).toContain("  Presentation: drawn 280 · held 4 (3 Scene is not ready to render; 1 FrameGraph is not ready) · skipped 16 (frames in flight) · context losses 0 · image near-black 0%, 3%, no frame");
    expect(lines).toContain("  TypeError: x is undefined");
  });

  it("tells what Play first drew after its load apart from what a sweep's quality changes first drew", () => {
    const reading = (draws: number, passes: Record<string, number>) => ({
      draws, loadCompiled: 0, loadPrograms: 90, frames: draws, stalls: 0, mostInFrame: 1, worstFrameMs: 40, longFrames: 0, passes, longest: [],
    });
    const report: FeatureTestCheckReport = {
      mode: "benchmark", startedAt: Date.UTC(2026, 9, 28, 12), durationMs: 60_000, cancelled: false, pageErrors: [],
      scenes: [{
        name: "main", path: "assets/main.scene.hasset", passed: true, problems: [],
        editor: { status: "ready", ms: 900, phase: null, frames: null, error: null, gpu: null },
        play: { status: "loaded", ms: 3000, phase: null, frames: null, runtimeFps: null, snapshot: null, presentation: null,
          firstDrawsBeforeSweep: reading(3, { objects: 3 }), firstDraws: reading(40, { objects: 20, shadows: 12, post: 8 }),
          // No readiness check ran while Play was measured.
          work: { drawn: 300, work: { graphBuilds: 0, shadowAdmissions: 0, shadowAdmissionMs: 0, strictReadinessChecks: 0, readinessProbeMs: 0, outlineReadinessChecks: 0,
            readinessProbeReasons: {}, readinessSwapRechecks: 0, failedReadinessProbes: 0, scopedReadinessProbes: 0, scopedReadinessMismatches: 0, scopedReadinessIdleRequests: 0, readinessBlockers: [] } },
          commands: [], benchmark: [], logs: [] },
        session: null,
      }],
    };
    const lines = formatFeatureTestCheckReport(report, environment).split("\n");
    expect(lines).toContain("  Readiness probes: none in 300 drawn frames");
    expect(lines).toContain("  First draws after load, before the sweep: 3 (0 compiled by the load, of 90 it compiled) in 3 frames · 0 over 100 ms · worst 40 ms · most 1 in a frame · by pass: objects 3");
    expect(lines).toContain("  First draws in the whole session, the sweep's quality changes included: 40 (0 compiled by the load, of 90 it compiled) in 40 frames · 0 over 100 ms · worst 40 ms · most 1 in a frame · by pass: objects 20, shadows 12, post 8");
    expect(lines).toContain("  Long frames after load, before the sweep: 0 over 100 ms");
  });

  it("names the six most frequent causes of the readiness probes Play ran while measured", () => {
    const report: FeatureTestCheckReport = {
      mode: "full", startedAt: Date.UTC(2026, 9, 28, 12), durationMs: 60_000, cancelled: false, pageErrors: [],
      scenes: [{
        name: "main", path: "assets/main.scene.hasset", passed: true, problems: [],
        editor: { status: "ready", ms: 900, phase: null, frames: null, error: null, gpu: null },
        play: { status: "loaded", ms: 3000, phase: null, frames: null, runtimeFps: null, snapshot: null, presentation: null, firstDraws: null,
          // 40 probes: a probe counts once for each reason marked since the last that passed, so causes overlap.
          work: { drawn: 400, work: { graphBuilds: 0, shadowAdmissions: 0, shadowAdmissionMs: 0, strictReadinessChecks: 40,
            readinessProbeMs: 800, outlineReadinessChecks: 0,
            readinessProbeReasons: { meshAdded: 20, particleBind: 12, shadowMap: 5, membership: 5, streamAdmission: 4, other: 2, outline: 1 },
            readinessSwapRechecks: 9, failedReadinessProbes: 3, scopedReadinessProbes: 30, scopedReadinessMismatches: 2, scopedReadinessIdleRequests: 0,
            readinessBlockers: ['mesh "crate" (Material "wood"): pbr #4 linking', 'task "Forward objects"', 'texture "sky"', 'render target "mirror"'] } },
          commands: [], benchmark: [], logs: [] },
        session: null,
      }],
    };
    const lines = formatFeatureTestCheckReport(report, environment).split("\n");
    // Equal counts are named alphabetically; failed, other and outline fall past the sixth.
    // 30 of the probes asked only the meshes their causes named; a verification run found two of those wrong.
    // The last probe that failed names the first three things it found unready.
    expect(lines).toContain("  Readiness probes: 40 in 400 drawn frames (30 asked only the changed meshes) · 20.0 ms each · 2.0 ms per drawn frame · causes: mesh added 20, particle bind 12, swap recheck 9, membership count 5, shadow map 5, stream admission 4 · 2 of those DISAGREED with a probe of every mesh · the last failed one waited for mesh \"crate\" (Material \"wood\"): pbr #4 linking; task \"Forward objects\"; texture \"sky\"");
  });

  it("recommends the highest quality tier every benchmarked scene holds at 60 and 30 fps", () => {
    const sample = (label: string, fps: number, p95Ms: number): FeatureTestBenchmarkSample => ({
      label, frames: { frames: fps * 5, durationMs: 5000, fps, medianMs: 1000 / fps, meanMs: 1000 / fps, vsync: [1, 0, 0, 0], p95Ms, maxMs: p95Ms, stalls: 0 }, runtimeFps: fps,
      cpuMs: 4, gpuMs: null, drawCalls: 100, resolution: "1280x720@1.00", failed: [],
    });
    const scene = (name: string, benchmark: FeatureTestBenchmarkSample[]): FeatureTestCheckSceneResult => ({
      name, path: `assets/${name}.scene.hasset`, passed: true, problems: [],
      editor: { status: "ready", ms: 1000, phase: null, frames: null, error: null, gpu: null },
      play: { status: "loaded", ms: 2000, phase: null, frames: null, runtimeFps: null, snapshot: null, presentation: null, firstDraws: null, commands: [], benchmark, logs: [] },
      session: null,
    });
    const report: FeatureTestCheckReport = {
      mode: "benchmark", startedAt: 0, durationMs: 600_000, cancelled: false, pageErrors: [],
      scenes: [
        // The light scene's samples ran with two frames in flight, skipping 1, 0, 2 and 9 renders.
        // It also reports what each profile drew and what the Engine had compiled by its end.
        scene("light", [sample("low", 60, 18), sample("medium", 60, 19), sample("high", 58, 22),
          sample("ultra", 40, 30)].map((entry, index) => ({
          ...entry, framesInFlight: { mode: 2 as const, skipped: [1, 0, 2, 9][index]! },
          drawPasses: { objects: 124, geometry: [0, 0, 81, 81][index]!, outlines: 101, layers: 98 },
          drawPassMs: { objects: [3.04, 3.1, 4.48, 4.5][index]!, geometry: [0, 0, 1.2, 1.2][index]!, outlines: 0.6, layers: 0.02, other: 0.3 },
          programs: { programs: [280, 290, 310, 320][index]!, neverDrawn: [90, 92, 95, 96][index]!, passes: {}, shaders: 100, mostVariants: 9, splitBy: [], materials: { builds: 40, programs: 20, adopted: 20, sameShaderRebuilds: 0 } },
        }))),
        scene("heavy", [sample("low", 59, 20), sample("medium", 35, 40), sample("high", 25, 60),
          sample("ultra", 20, 80)]),
      ],
    };
    const lines = formatFeatureTestCheckReport(report, environment).split("\n");
    expect(lines).toContain("Benchmark: highest tier every benchmarked scene holds at 60 fps: low · at 30 fps: medium (2/2 scenes benchmarked)");
    expect(lines).toContain("  Highest tier at 60 fps: high · at 30 fps: ultra");
    // The passes some profile drew in, in the frame's order; a profile that drew none in a pass shows 0.
    const table = lines.indexOf("  Draws per pass (median per frame):");
    expect(lines.slice(table + 1, table + 12)).toEqual([
      "    Profile           objects geometry outlines layers",
      "    low               124     0        101      98",
      "    medium            124     0        101      98",
      "    high              124     81       101      98",
      "    ultra             124     81       101      98",
      // Then each profile's main-thread time by pass, over the passes some profile spent 0.05 ms or more in.
      "  CPU per pass (median ms per frame):",
      "    Profile           objects geometry outlines other",
      "    low               3.0     0.0      0.6      0.3",
      "    medium            3.1     0.0      0.6      0.3",
      "    high              4.5     1.2      0.6      0.3",
      "    ultra             4.5     1.2      0.6      0.3",
    ]);
    expect(lines).toContain("  Programs after each profile: low 280 (90 never drawn) · medium 290 (92 never drawn) · high 310 (95 never drawn) · ultra 320 (96 never drawn)");
    // The heavy scene's samples attribute no draws and report no programs.
    expect(lines.filter((line) => line === "  Draws per pass: unreported")).toHaveLength(1);
    // Nor time them: no CPU table.
    expect(lines.filter((line) => line.startsWith("  CPU per pass"))).toHaveLength(1);
    expect(lines.filter((line) => line.startsWith("  Programs after each profile"))).toHaveLength(1);
    // Each scene's header states the GPU backpressure it ran under, or that its samples did not measure it.
    expect(lines.filter((line) => line.startsWith("  Frames in flight: "))).toEqual([
      "  Frames in flight: 2 (12 renders skipped while sampling)", "  Frames in flight: not measured",
    ]);
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
        play: { status: "loaded", ms: 2000, phase: null, frames: null, runtimeFps: null, snapshot: null, presentation: null, firstDraws: null, commands: [],
          benchmark: [
            sample("baseline 1", 38),
            sample("water reflections sky", 30, { settings: { ...settings, "water.reflections": "sky" } }),
            sample("water detail low", 36, {
              settings: { ...settings, "water.shadingDetail": "low", "water.reflections": "sky" }, switched: { ms: 37_400, firstDraws: 74, stalls: 6, programs: 74 },
            }),
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
    // What its commands compiled before the window, apart from the window's own frames.
    expect(row("water detail low")).toContain("switch: 74 first drawn (6 long), programs +74, 37.4 s · water.shadingDetail=low · UNEXPECTED: water.reflections=sky");
    expect(row("water detail medium")).toContain("vsync");
    expect(row("water detail medium")).toContain("COMPILING: 3 first drawn, 1 compiling · no setting changed");
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
        play: { status: "loaded", ms: 2000, phase: null, frames: null, runtimeFps: null, snapshot: null, presentation: null, firstDraws: null, commands: [],
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
    expect(lines).toContain("  Timing: gpu busy read as each Engine frame starts, every 4.2 ms (completion read at frame granularity: a frame whose GPU work ends before the next frame starts reads at least the time to that start)");
    expect(lines).toContain("  preserveDrawingBuffer: off (live)");
    // 14 against the mean of 20 and 22, though every frame lasted two display intervals.
    expect(row("shadows off")).toMatch(/0\/100\/0\/0 {7}14\.0 \(17\) {5}-7\.0ms -33% {7}8\.0ms/);
    expect(row("baseline 2")).toContain("+2.0ms +10% ");
    expect(row("warm-up 1")).toMatch(/26\.0 \(29\) {5}- .*warm-up$/);
  });

  it("reports both passes of the preserveDrawingBuffer A/B under one header: tier, warm device, verdicts and the on/off comparison", () => {
    const restored = "preserveDrawingBuffer is stored as on again, as before the A/B; it applies when the editor next reloads or the project is reopened.";
    const settings = (preserve: string) => ({ shadows: "medium 2048", "geometry.occlusion": "true", "presentation.preserve": preserve });
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
      play: { status: "loaded", ms: 2000, phase: null, frames: null, runtimeFps: null, snapshot: null, presentation: null, firstDraws: null, commands: [], benchmark, logs: [] },
      session: null,
    });
    const rooms = { view: "rooms" };
    const report: FeatureTestCheckReport = {
      mode: "breakdown", startedAt: 0, durationMs: 600_000, cancelled: false, pageErrors: [],
      breakdown: { method: "remove-one", tier: "medium", ab: true, warmMinutes: 4, passes: [{ preserveDrawingBuffer: true }, { preserveDrawingBuffer: false }], notes: [restored] },
      scenes: [
        scene("FT_World", 1, [sample("baseline 1", 20, "true"), sample("shadows off", 15, "true", { settings: { ...settings("true"), shadows: "off" } }), sample("baseline 2", 22, "true")]),
        scene("FT_Occlusion", 1, [
          sample("rooms baseline 1", null, "true", { ...rooms, occlusion: { tested: 480, culled: 212, triangles: 1520, ms: 0.42 } }),
          sample("rooms occlusion off", null, "true", { ...rooms, settings: { ...settings("true"), "geometry.occlusion": "false" } }),
          sample("rooms baseline 2", null, "true", { ...rooms, occlusion: { tested: 280, culled: 0, triangles: 156, ms: 0, idle: 0.94 } }),
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
    // The rooms camera's step against its own baselines; the Medium baseline culls and says what.
    const occlusion = lines.find((line) => line.startsWith("    rooms occlusion off "))!;
    expect(occlusion).toContain("+0.0ms +0%*");
    expect(occlusion).toMatch(/575 {11}geometry\.occlusion=false$/);
    expect(lines.find((line) => line.startsWith("    rooms baseline 1 "))).toMatch(/occlusion culled 212\/480 · 1520 tris · 0\.42 ms$/);
    // Backing off while it culled nothing: idle on most readings.
    expect(lines.find((line) => line.startsWith("    rooms baseline 2 "))).toMatch(/occlusion culled 0\/280 · 156 tris · 0\.00 ms · idle 94%$/);
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
        play: { status: "loaded", ms: 2000, phase: null, frames: null, runtimeFps: null, snapshot: null, presentation: null, firstDraws: null, commands: [],
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

  it("reports a Profile: rows at fixed views with their gpu busy change, the drift of the control view, and per view the steps ranked with their A B A values", () => {
    const settings = { shadows: "high 2048", "shadows.screen": "medium", "resolution.scale": "1", "post.enabled": "true", "shadows.debug": "none" };
    const passes = { objects: 420, geometry: 40, shadows: 140, captures: 90, post: 12, other: 2 };
    const sample = (label: string, gpu: number, cpuMs: number, extra: Partial<FeatureTestBenchmarkSample> = {}): FeatureTestBenchmarkSample => ({
      label, baseline: / baseline | drift$/.test(` ${label}`), view: label.split(" ")[0],
      frames: { frames: 100, durationMs: 5000, fps: 20, medianMs: 50, meanMs: 50, vsync: [0, 0, 1, 0], p95Ms: 58, maxMs: 70, stalls: 0 },
      runtimeFps: null, cpuMs, gpuMs: null, drawCalls: 704, draws: { median: 704, min: 704, max: 704, samples: 10 },
      resolution: "885x591@1.33", backbuffer: "2360x1576", failed: [], settings, unsettled: { firstDraws: 0, compiling: 0, settleMs: 3000 }, drawPasses: passes,
      gpuBusy: { medianMs: gpu, p95Ms: gpu + 6, frames: 100, pollMs: 6.4 },
      presentation: { drawn: 40, held: 0, ms: 5000, heldReasons: {} },
      shadowAtlas: { edge: 8192, maps: [{ mapSize: 2048, passes: 4 }, { mapSize: 2048, passes: 6 }] }, ...extra,
    } as FeatureTestBenchmarkSample);
    const noShadows = { ...settings, shadows: "off" };
    const report: FeatureTestCheckReport = {
      mode: "profile", startedAt: 0, durationMs: 360_000, cancelled: false, pageErrors: [],
      scenes: [{
        name: "main", path: "assets/main.scene.hasset", passed: true, problems: [],
        editor: { status: "ready", ms: 1000, phase: null, frames: null, error: null, gpu: null },
        play: { status: "loaded", ms: 2000, phase: null, frames: null, runtimeFps: 22, ticksPerSecond: 60, snapshot: null, presentation: null, firstDraws: null, commands: [], logs: [],
          profile: {
            instancePool: { groups: 18, retained: 2, pooled: 410, rekeys: 0 }, endChanges: [], holdRate: { heldPerSecond: 2.36, share: 0.234 },
            resolution: { scale: 0.75, levelBefore: 1.25 },
          },
          benchmark: [
            { ...sample("heavy warm-up 1", 44, 11, { drawPasses: undefined, atMs: 0 }), label: "warm-up 1", baseline: false, warmup: true, view: "heavy" },
            { ...sample("heavy warm-up 2", 42, 10, { drawPasses: undefined, atMs: 10_000 }), label: "warm-up 2", baseline: false, warmup: true, view: "heavy" },
            sample("light baseline 1", 20, 6),
            // Its two baselines differ by 4 ms, more than its own 3 ms change.
            sample("light world hidden", 19, 6, { settings: { ...settings, "post.enabled": "false" } }),
            sample("light baseline 2", 24, 6),
            sample("heavy baseline 1", 40, 10, { atMs: 60_000 }),
            sample("heavy world drawn once", 34, 9, { settings: noShadows, shadowAtlas: { edge: 0, maps: [] } }),
            sample("heavy baseline 2", 42, 11, { atMs: 80_000 }),
            sample("heavy shadow passes off", 36, 9, { settings: { ...settings, "shadows.debug": "passes" } }),
            sample("heavy baseline 3", 40, 10, { atMs: 100_000 }),
            sample("heavy drift", 46, 12, { atMs: 300_000 }),
          ] },
        session: null,
      }],
    };
    const lines = formatFeatureTestCheckReport(report, environment).split("\n");
    const row = (label: string) => lines.find((line) => line.startsWith(`    ${label} `))!;
    expect(lines[0]).toMatch(/^Haptic Feature Test Check \(Profile\)/);
    // The render loop's own count and the game's tick rate, which the loop does not set.
    expect(lines).toContain("  Play: loaded in 2.0 s · no frames sampled · render loop 22 fps (last second) · game 60 ticks/s");
    expect(lines).toContain("  Restored: every setting as before the first step");
    expect(lines).toContain("  Resolution held: scale 0.75 (level 1.33) for every row, the session's own scale; Play was at scaling level 1.25 before");
    // The control view's visits, unchanged, at their times into the sweep, and its change over the run.
    expect(lines).toContain("  Drift (heavy view, revisited unchanged; at m:ss into the sweep, gpu busy / cpu ms): warm-up 1 0:00 44.0/11.0 · warm-up 2 0:10 42.0/10.0 · heavy baseline 1 1:00 40.0/10.0 · heavy baseline 2 1:20 42.0/11.0 · heavy baseline 3 1:40 40.0/10.0 · heavy drift 5:00 46.0/12.0");
    expect(lines).toContain("  Drift first to last visit: gpu busy +2.0ms +5% · cpu +1.0ms +9%; discount a step's change by the drift around it");
    // Against (20 + 24) / 2 in gpu busy; the baselines' spread is past the change.
    // Each row's world size and level beside the backbuffer the layers and the output draw into.
    expect(row("light world hidden")).toMatch(/-3\.0ms -14% {5}\+0\.0ms \+0% {6}885x591@1\.33 \/ 2360x1576 {2}post\.enabled=false · overlaps · UNSETTLED: its baselines differ by 4\.0 ms, more than its change/);
    // A shadow step's atlas and maps.
    expect(row("heavy world drawn once")).toMatch(/-7\.0ms -17% .*shadows=off · overlaps · no shadow atlas$/);
    expect(row("heavy shadow passes off")).toMatch(/-5\.0ms -12% .*shadows\.debug=passes · overlaps · atlas 8192 · maps 2048x4, 2048x6$/);
    // A baseline's change is against its view's first: drift.
    expect(row("heavy drift")).toMatch(/\+6\.0ms \+15% {5}\+2\.0ms \+20%/);
    const ranking = lines.findIndex((line) => line.startsWith("  Ranked by change at each view against baselines at its own GPU speed"));
    // No row has GPU probes: their sections say so once.
    expect(lines).toContain("  GPU probes: none (the Engine reports none)");
    expect(lines.some((line) => line.startsWith("  State comparison") || line.startsWith("  Frame structures"))).toBe(false);
    expect(lines).toContain("  Not ranked, straddling a state change: none");
    expect(lines.slice(ranking + 1, ranking + 6)).toEqual([
      "    light:",
      "      1. [FAST] light world hidden: -3.0ms -14% (20.0 > 19.0 > 24.0) · cpu +0.0ms +0% · overlaps · UNSETTLED",
      "    heavy:",
      "      1. [FAST] heavy world drawn once: -7.0ms -17% (40.0 > 34.0 > 42.0) · cpu -1.5ms -14% · overlaps",
      "      2. [FAST] heavy shadow passes off: -5.0ms -12% (42.0 > 36.0 > 40.0) · cpu -1.5ms -14% · overlaps",
    ]);
  });

  it("says per second how many of Play's and each Profile row's frames were long, split by what ran in them, the samplers-off row among them", () => {
    const long = (ms: number, three: LongFrameAttribution["three"], four: LongFrameAttribution["four"]): LongFrameAttribution =>
      ({ ms, frames: 180, three, four });
    const sample = (label: string, extra: Partial<FeatureTestBenchmarkSample>): FeatureTestBenchmarkSample => ({
      label, baseline: / baseline /.test(` ${label}`), view: label.split(" ")[0],
      frames: { frames: 180, durationMs: 3000, fps: 60, medianMs: 16.7, meanMs: 16.7, vsync: [0.9, 0, 0.02, 0.08], p95Ms: 67, maxMs: 90, stalls: 0 },
      runtimeFps: null, cpuMs: 8, gpuMs: null, drawCalls: 300, resolution: null, failed: [], ...extra,
    });
    const report: FeatureTestCheckReport = {
      mode: "profile", startedAt: 0, durationMs: 60_000, cancelled: false, pageErrors: [],
      scenes: [{
        name: "main", path: "assets/main.scene.hasset", passed: true, problems: [],
        editor: { status: "ready", ms: 1000, phase: null, frames: null, error: null, gpu: null },
        play: { status: "loaded", ms: 2000, phase: null, frames: null, runtimeFps: 60, snapshot: null, presentation: null, firstDraws: null, commands: [], logs: [],
          longFrames: long(5000, { render: 2 }, { none: 25, timer250: 3 }),
          benchmark: [
            sample("light baseline 1", { longFrames: long(3000, {}, { none: 15, port: 3 }) }),
            sample("light samplers off", { cpuMs: null, samplersOff: true, longFrames: long(3000, { commit: 3 }, { none: 18 }) }),
            sample("light baseline 2", {}),
          ] },
        session: null,
      }],
    };
    const lines = formatFeatureTestCheckReport(report, environment).split("\n");
    // Per second over the window: 2 frames of three intervals in 5 s, 28 of four or more.
    expect(lines).toContain("  Long frames: 3x 0.4/s (render 0.4) · 4+x 5.6/s (timer 250 0.6, none of ours 5.0)");
    expect(lines.find((line) => line.startsWith("  (long frames = "))).toMatch(/Safari's clock steps in about 1 ms/);
    const header = lines.findIndex((line) => line.startsWith("  Long frames per row ("));
    expect(lines[header]).toMatch(/samplers off = the row sampled with the GPU busy probe not polling/);
    // Only the rows that measured them.
    expect(lines.slice(header + 1, header + 3)).toEqual([
      "    light baseline 1            3x 0/s · 4+x 6.0/s (port 1.0, none of ours 5.0)",
      "    light samplers off          3x 1.0/s (DOM commit 1.0) · 4+x 6.0/s (none of ours 6.0)",
    ]);
    expect(lines[header + 3]).not.toMatch(/light baseline 2/);
  });

  it("reports a Profile's GPU probes: each row's serial stages and window counters, the distinct frame structures, and steps ranked in serial frame time", () => {
    const settings = { shadows: "high 2048", "resolution.scale": "1" };
    const USUAL = "a1b2c3d4", OTHER = "ffff0000";
    const usualPasses = ["F1 v0,0,2048x2048 d@0,0,2048x2048 x40", "D v0,0,2360x1576 cds@0,0,2360x1576 x300"];
    /** A row: its gpu busy, its serial frame split over shadows and main, its synthetic load and its usual structure. */
    const row = (
      label: string, gpu: number,
      serial: { shadows: number; main: number; synthetic: number; censored?: boolean } | null,
      window: { modal?: string; generation?: number; texels?: number } = {},
    ): FeatureTestBenchmarkSample => {
      const gpuProbe: SampledGpuProbe = {
        signature: {
          frames: 150, modal: window.modal ?? USUAL, modalShare: 0.98, distinct: 2, passes: 2, clears: 2, blits: 0, invalidates: 0, draws: 340,
          texelsCleared: 2048 ** 2 + 2360 * 1576, texelsCovered: 2048 ** 2 + 2360 * 1576,
          structures: [
            { hash: window.modal ?? USUAL, frames: 147, passes: window.modal ? [...usualPasses, "F2 v0,0,256x256 c@0,0,256x256 x1"] : usualPasses },
            ...(window.modal ? [] : [{ hash: "0000beef", frames: 3, passes: ["D v0,0,2360x1576 x1"] }]),
          ],
        },
        shadows: {
          frames: 150, maps: 5, redrawn: 2, cached: 3, continuous: 2, tiles: 5, texels: window.texels ?? 5 * 2048 ** 2, atlasEdge: 8192,
          generationFirst: 1, generationLast: window.generation ?? 1,
        },
        raf: { callbacks: 300, ms: 5000, perSecond: 60 },
        ...(serial ? { serial: {
          id: 1, frames: 8, frameMs: serial.shadows + serial.main, coldMs: serial.shadows + serial.main + 9, cpuMs: 4,
          stages: [
            { stage: "other" as const, ms: 0.4, censored: true, subMs: 0.5 },
            { stage: "shadows" as const, ms: serial.shadows, censored: serial.censored === true, subMs: serial.shadows > 1 ? 2.5 : 0 },
            { stage: "main" as const, ms: serial.main, censored: false, subMs: 1 },
          ],
          syntheticMs: serial.synthetic, syntheticColdMs: serial.synthetic + 1, hashes: [USUAL, USUAL], splits: 0, failed: null, ms: 400,
        } } : {}),
      };
      return {
        label, baseline: / baseline /.test(` ${label}`), view: label.split(" ")[0],
        frames: { frames: 100, durationMs: 5000, fps: 20, medianMs: 50, meanMs: 50, vsync: [0, 0, 1, 0], p95Ms: 58, maxMs: 70, stalls: 0 },
        runtimeFps: null, cpuMs: 10, gpuMs: null, drawCalls: 340, resolution: "885x591@1.33", backbuffer: "2360x1576", failed: [], settings,
        unsettled: { firstDraws: 0, compiling: 0, settleMs: 3000 },
        gpuBusy: { medianMs: gpu, p95Ms: gpu + 2, frames: 100, pollMs: 4, skipped: 0 },
        gpuProbe,
      } as FeatureTestBenchmarkSample;
    };
    const report = (benchmark: FeatureTestBenchmarkSample[]): FeatureTestCheckReport => ({
      mode: "profile", startedAt: 0, durationMs: 360_000, cancelled: false, pageErrors: [],
      scenes: [{
        name: "main", path: "assets/main.scene.hasset", passed: true, problems: [],
        editor: { status: "ready", ms: 1000, phase: null, frames: null, error: null, gpu: null },
        play: { status: "loaded", ms: 2000, phase: null, frames: null, runtimeFps: 22, ticksPerSecond: 60, snapshot: null, presentation: null, firstDraws: null, commands: [], logs: [],
          profile: { instancePool: null, endChanges: [], holdRate: null }, benchmark },
        session: null,
      }],
    });
    // The last two baselines run at half the GPU's speed (their synthetic load), 20 ms more in the shadows stage.
    const lines = formatFeatureTestCheckReport(report([
      row("heavy baseline 1", 33, { shadows: 6, main: 14, synthetic: 2 }),
      row("heavy world drawn once", 33, { shadows: 0.5, main: 14, synthetic: 2, censored: true }, { modal: OTHER, texels: 0 }),
      row("heavy baseline 2", 33, { shadows: 6, main: 14, synthetic: 2 }),
      // No serial probe on this step: it is ranked in gpu busy.
      row("heavy geometry effects off", 32, null),
      row("heavy baseline 3", 33, { shadows: 6, main: 14, synthetic: 2 }),
      row("heavy baseline 4", 66, { shadows: 26, main: 14, synthetic: 4.2 }, { generation: 2 }),
      row("heavy baseline 5", 66, { shadows: 26, main: 14, synthetic: 4.2 }, { generation: 2 }),
    ]), environment).split("\n");
    const line = (start: string) => lines.find((entry) => entry.startsWith(start))!;
    // The main table's serial column, and a note on the row whose frames had another structure than its view's first baseline.
    expect(line("    heavy baseline 1 ")).toMatch(/33\.0 \(35\) {5}20\.0 {4}/);
    expect(line("    heavy world drawn once ")).toContain(`STRUCTURE ${OTHER}, not its view's first baseline's ${USUAL}`);
    expect(line("    heavy baseline 2 ")).not.toContain("STRUCTURE");
    // The probes table: frame, cold, submission, frame less submission, burst, the stages (an upper bound marked),
    // synthetic, structure, counters.
    const table = lines.slice(lines.findIndex((entry) => entry.startsWith("  GPU probes. Serial")) + 2);
    expect(table[0]).toMatch(/^ {4}heavy baseline 1 +20\.0 +29\.0 +4\.0 +16\.0 +- +<=0\.4 +6\.0 +- +14\.0 +- +- +2\.0 \(3\.0\) +a1b2c3d4 98%\/2 +2 +2 +0 +340 +7\.9M +7\.9M +2\/3\/2 +21M \(5\) +8192 g1 +60$/);
    expect(table[1]).toMatch(/^ {4}heavy world drawn once +14\.5 .* <=0\.5 +- +14\.0 .* ffff0000 98%\/2 .* 0\.0M \(5\) +8192 g1 +60 +serial frames drew a1b2c3d4$/);
    expect(table[3]).toMatch(/^ {4}heavy geometry effects off +- +- +- +- +- +- +- +- +- +- +- +- +a1b2c3d4/);
    expect(table[5]).toMatch(/8192 g1>2 +60$/);
    // Each distinct structure once, with the rows it was usual in and its passes.
    const structures = lines.indexOf(line("  Frame structures"));
    expect(lines.slice(structures + 1, structures + 10)).toEqual([
      `    ${USUAL}: 882 frames, usual in 6 rows (heavy baseline 1, heavy baseline 2, heavy geometry effects off, heavy baseline 3 and 2 more)`,
      ...usualPasses.map((pass) => `      ${pass}`),
      "    0000beef: 18 frames, never the usual one",
      "      D v0,0,2360x1576 x1",
      `    ${OTHER}: 147 frames, usual in 1 rows (heavy world drawn once)`,
      ...usualPasses.map((pass) => `      ${pass}`),
      "      F2 v0,0,256x256 c@0,0,256x256 x1",
    ]);
    // Ranked in serial frame time where the step and both baselines have it: gpu busy did not move with shadows off.
    const ranking = lines.findIndex((entry) => entry.startsWith("  Ranked by change"));
    expect(lines.slice(ranking + 1, ranking + 4)).toEqual([
      "    heavy:",
      "      1. heavy world drawn once: -5.5ms -28% s (20.0 > 14.5 > 20.0) · norm -5.5ms -28% · cpu +0.0ms +0% · overlaps",
      "      2. heavy geometry effects off: -1.0ms -3% (33.0 > 32.0 > 33.0) · cpu +0.0ms +0% · overlaps",
    ]);
    // Each row's intervals, and each serial-probed row's submission by stage, in stage order.
    expect(line("    heavy baseline 1 ")).toContain(" 0/0/100/0% ");
    const submission = lines.findIndex((entry) => entry.startsWith("  Serial submission by stage"));
    expect(lines.slice(submission + 1, submission + 3)).toEqual([
      `    ${"heavy baseline 1".padEnd(28)}other 0.5 · shadows 2.5 · main 1.0`,
      `    ${"heavy world drawn once".padEnd(28)}other 0.5 · shadows 0.0 · main 1.0`,
    ]);

  });

  it("shows the counters' medians with their ranges when frames differ", () => {
    const report: FeatureTestCheckReport = {
      mode: "benchmark", startedAt: 0, durationMs: 300_000, cancelled: false, pageErrors: [],
      scenes: [{
        name: "FT_World", path: "assets/FeatureTest/Scenes/FT_World.scene.hasset", passed: true, problems: [],
        editor: { status: "ready", ms: 1000, phase: null, frames: null, error: null, gpu: null },
        play: { status: "loaded", ms: 2000, phase: null, frames: null, runtimeFps: null,
          snapshot: { drawCalls: 605, meshes: 80, textures: 30, accountedBytes: 0, rendering: null },
          counters: { draws: { median: 575, min: 544, max: 605, samples: 10 }, cpuMs: null, gpuMs: null }, presentation: null, firstDraws: null, commands: [],
          benchmark: [{
            label: "baseline", frames: { frames: 100, durationMs: 4000, fps: 25, medianMs: 40, meanMs: 40, vsync: [0, 0, 1, 0], p95Ms: 46, maxMs: 50, stalls: 0 },
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

  it("says how a frame's Scene Layers drew only where they drew, with the counts in the singular and no reasons when all batched", () => {
    const alone = { single: 0, material: 0, transform: 0, vertexColor: 0, other: 0, unmatched: 0 };
    const layers = (layerBatches: RenderDiagnostics["layerBatches"]) => {
      const rendering = {
        adapter: { vendor: null, renderer: null, version: null }, cpuMs: 1, gpuMs: null, gpuStatus: "unsupported",
        width: 100, height: 100, scalingLevel: 1, qualityLimits: [], layerBatches,
      } as unknown as RenderDiagnostics;
      const report: FeatureTestCheckReport = {
        mode: "quick", startedAt: 0, durationMs: 1000, cancelled: false, pageErrors: [],
        scenes: [{
          name: "main", path: "assets/main.scene.hasset", passed: true, problems: [],
          editor: { status: "ready", ms: 1000, phase: null, frames: null, error: null, gpu: null },
          play: { status: "loaded", ms: 2000, phase: null, frames: null, runtimeFps: null,
            snapshot: { drawCalls: 5, meshes: 5, textures: 1, accountedBytes: 0, rendering }, presentation: null, firstDraws: null, commands: [], benchmark: [], logs: [] },
          session: null,
        }],
      };
      return formatFeatureTestCheckReport(report, environment).split("\n").filter((line) => line.startsWith("  Scene Layers:"));
    };
    expect(layers({ visuals: 4, draws: 1, batches: 1, batched: 4, alone })).toEqual(["  Scene Layers: 4 visuals in 1 draw · 4 in 1 batch"]);
    expect(layers({ visuals: 1, draws: 1, batches: 0, batched: 0, alone: { ...alone, vertexColor: 1 } }))
      .toEqual(["  Scene Layers: 1 visual in 1 draw · 0 in 0 batches · alone: 1 vertex colours"]);
    // A view that reports none, or whose layers drew nothing, has no line.
    expect(layers(undefined)).toEqual([]);
    expect(layers({ visuals: 0, draws: 0, batches: 0, batched: 0, alone })).toEqual([]);
  });

  it("splits a frame's Scene Layer work into batched passes and per-Scene work, with its clears, target switches and uploads, only where layers rendered", () => {
    const work = (layerFrame: RenderDiagnostics["layerFrame"]) => {
      const rendering = {
        adapter: { vendor: null, renderer: null, version: null }, cpuMs: 1, gpuMs: null, gpuStatus: "unsupported",
        width: 100, height: 100, scalingLevel: 1, qualityLimits: [], layerFrame,
      } as unknown as RenderDiagnostics;
      const report: FeatureTestCheckReport = {
        mode: "quick", startedAt: 0, durationMs: 1000, cancelled: false, pageErrors: [],
        scenes: [{
          name: "main", path: "assets/main.scene.hasset", passed: true, problems: [],
          editor: { status: "ready", ms: 1000, phase: null, frames: null, error: null, gpu: null },
          play: { status: "loaded", ms: 2000, phase: null, frames: null, runtimeFps: null,
            snapshot: { drawCalls: 5, meshes: 5, textures: 1, accountedBytes: 0, rendering }, presentation: null, firstDraws: null, commands: [], benchmark: [], logs: [] },
          session: null,
        }],
      };
      return formatFeatureTestCheckReport(report, environment).split("\n").filter((line) => line.startsWith("  Scene Layer work:"));
    };
    expect(work({ scenes: 3, ms: 3.25, batchMs: 1.25, clears: 3, depthClears: 3, targetSwitches: 0, uploads: 0, beforeWorld: { ms: 0.5, uploads: 2, targetSwitches: 2 }, backbuffer: { clears: 3, depthClears: 3, elided: 1 } }))
      .toEqual(["  Scene Layer work: 3 scenes in 3.25 ms (1.25 in batched passes, 2.00 per-Scene work) · 3 clears (3 of depth) · 0 target switches · 0 uploads · before the world: 0.50 ms, 2 uploads, 2 target switches · backbuffer: 3 depth-stencil clears, 1 left out as already cleared"]);
    expect(work({ scenes: 1, ms: 1, batchMs: 0.5, clears: 1, depthClears: 1, targetSwitches: 1, uploads: 1, beforeWorld: { ms: 0, uploads: 0, targetSwitches: 0 }, backbuffer: { clears: 1, depthClears: 1, elided: 0 } }))
      .toEqual(["  Scene Layer work: 1 scene in 1.00 ms (0.50 in batched passes, 0.50 per-Scene work) · 1 clear (1 of depth) · 1 target switch · 1 upload · before the world: 0.00 ms, 0 uploads, 0 target switches · backbuffer: 1 depth-stencil clear, 0 left out as already cleared"]);
    // A view that reports none, or whose layers rendered nothing, has no line.
    expect(work(undefined)).toEqual([]);
    expect(work({ scenes: 0, ms: 0, batchMs: 0, clears: 0, depthClears: 0, targetSwitches: 0, uploads: 0, beforeWorld: { ms: 0, uploads: 0, targetSwitches: 0 }, backbuffer: { clears: 0, depthClears: 0, elided: 0 } })).toEqual([]);
  });

  it("says how many shadow casters the maps draw from the shared buffer, and how, only where some are", () => {
    const casters = (shadowRetained: RenderDiagnostics["shadowRetained"]) => {
      const rendering = {
        adapter: { vendor: null, renderer: null, version: null }, cpuMs: 1, gpuMs: null, gpuStatus: "unsupported",
        width: 100, height: 100, scalingLevel: 1, qualityLimits: [], shadowRetained,
      } as unknown as RenderDiagnostics;
      const report: FeatureTestCheckReport = {
        mode: "quick", startedAt: 0, durationMs: 1000, cancelled: false, pageErrors: [],
        scenes: [{
          name: "main", path: "assets/main.scene.hasset", passed: true, problems: [],
          editor: { status: "ready", ms: 1000, phase: null, frames: null, error: null, gpu: null },
          play: { status: "loaded", ms: 2000, phase: null, frames: null, runtimeFps: null,
            snapshot: { drawCalls: 5, meshes: 5, textures: 1, accountedBytes: 0, rendering }, presentation: null, firstDraws: null, commands: [], benchmark: [], logs: [] },
          session: null,
        }],
      };
      return formatFeatureTestCheckReport(report, environment).split("\n").filter((line) => line.startsWith("  Shadow casters:"));
    };
    const stats = { casters: 209, draws: 240, parts: 31, vertices: 90_000, indices: 300_000, calls: 40, drawn: 500, lateUploads: 0 };
    expect(casters(stats)).toEqual(["  Shadow casters: 209 drawn from the shared buffer in 31 parts · 12.5 caster draws a draw"]);
    // Before any map drew there is no ratio; rows uploaded inside the stage are counted.
    expect(casters({ ...stats, parts: 1, calls: 0, drawn: 0, lateUploads: 3 })).toEqual(["  Shadow casters: 209 drawn from the shared buffer in 1 part · 3 late row uploads"]);
    // A view that retains none and a Scene without such casters have no line.
    expect(casters(null)).toEqual([]);
    expect(casters({ ...stats, casters: 0 })).toEqual([]);
  });

  it("shows an editor load failure's error and the viewport's GPU when Play never ran", () => {
    const report: FeatureTestCheckReport = {
      mode: "quick", startedAt: 0, durationMs: 15_400, cancelled: false, pageErrors: [],
      scenes: [{
        name: "main", path: "assets/main.scene.hasset", passed: false,
        problems: ["Editor viewport reported Scene Loading Failed at Presenting First Frame."],
        editor: { status: "failed", ms: 15_300, phase: "Presenting First Frame", frames: null,
          error: ["Error: The scene did not present a frame before the loading deadline. Ready: true; draws: 3; rendered: true; GPU pending: true; copied: false."],
          gpu: { vendor: "apple", renderer: "apple-a16", version: null } },
        play: { status: "not-started", ms: 0, phase: null, frames: null, runtimeFps: null, snapshot: null, presentation: null, firstDraws: null, commands: [], benchmark: [], logs: [] },
        session: null,
      }],
    };
    const lines = formatFeatureTestCheckReport(report, environment).split("\n");
    expect(lines).toContain("GPU: apple · apple-a16");
    expect(lines).toContain("  Editor: failed after 15.3 s at Presenting First Frame");
    expect(lines.slice(lines.indexOf("  Editor error:") + 1, lines.indexOf("  Editor error:") + 2)).toEqual([
      "    Error: The scene did not present a frame before the loading deadline. Ready: true; draws: 3; rendered: true; GPU pending: true; copied: false.",
    ]);
  });
});
