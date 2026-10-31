import { describe, expect, it } from "vitest";
import type { SessionReportEntry } from "@haptic/runtime";
import {
  breakdownDelta, breakdownSequence, counterStats, FEATURE_TEST_BENCHMARK_PROFILES, FEATURE_TEST_BREAKDOWN_STEPS, frameBound,
  frameStats, isBreakdownBaseline, runFeatureTestCheck, settingsChanges, vsyncShares,
  type FeatureTestBenchmarkSample, type FeatureTestCheckDeps,
} from "./feature-test-check";
import type { PlaySessionResult } from "./play-session";
import type { PlayProbe } from "./runtime-probes";
import type { RenderDiagnostics } from "@haptic/render";

type SceneBehavior = {
  open?: "ready" | "failed" | "blocked";
  play?: "loads" | "stuck";
  commands?: Record<string, { success: boolean; output: string }>;
  diagnostics?: SessionReportEntry[];
};

function diagnostic(severity: "error" | "warning", message: string): SessionReportEntry {
  return { code: "TEST", message, severity, frameId: 1, count: 1, firstFrameId: 1, lastFrameId: 1 };
}

/** A fake editor whose clock advances only when the runner sleeps. */
function fakeEditor(
  scenes: Record<string, SceneBehavior>,
  onSleep?: (now: number) => void,
  /** The Play view's presentation counts at a time, after the given commands. */
  presentation?: (now: number, commands: readonly string[]) => { drawn: number; held: number },
) {
  let now = 0;
  let active: string | null = null;
  let play: PlayProbe | null = null;
  let playScene: string | null = null;
  const listeners = new Set<(result: PlaySessionResult) => void>();
  const started: string[] = [];
  const stopped: string[] = [];
  const commands: string[] = [];
  const sampled: { now: number; after: string | null }[] = [];
  const behavior =(path: string | null) => scenes[(path ?? "").replace(/^scene:/, "")] ?? {};
  const deps: FeatureTestCheckDeps = {
    openScene: async (path) => { if (behavior(path).open !== "blocked") active = `scene:${path}`; },
    activeDocumentId: () => active,
    viewport: (id) => id === active ? {
      ready: () => (behavior(id).open ?? "ready") === "ready",
      failed: () => behavior(id).open === "failed",
      phase: () => behavior(id).open === "failed" ? "Loading Models" : null,
      error: () => behavior(id).open === "failed" ? new Error("Scene construction failed.", { cause: new Error("WebGPU device lost") }) : undefined,
      gpu: () => ({ api: "webgpu", vendor: "apple", renderer: "apple-a16", version: null }),
    } : null,
    startPlay: async () => {
      playScene = active;
      started.push(playScene!);
      const scene = behavior(playScene);
      play = {
        loadingPhase: () => scene.play === "stuck" ? { phase: "Loading Models", progress: 45 } : null,
        tickIndex: () => 12,
        runtimeFps: () => 60,
        snapshot: () => ({
          drawCalls: 10, meshes: 20, textures: 5, accountedBytes: 0,
          rendering: presentation
            ? ({
              presentation: presentation(now, commands), cpuMs: 4, gpuMs: null, width: 100, height: 100, scalingLevel: 1,
              pipeline: { effective: { gpuBackend: "webgl2" } },
              // One shader first drawn per command run so far.
              firstDraws: { draws: commands.length, loadCompiled: 0, frames: commands.length, stalls: 0, mostInFrame: 1, worstFrameMs: 20, longFrames: 0, longest: [] },
            } as unknown as RenderDiagnostics)
            : null,
        }),
        problemLogs: () => [],
        executeConsoleCommand: async (line) => {
          commands.push(line);
          if (line === "framecap") return { success: true, output: "framecap 30" };
          return scene.commands?.[line] ?? { success: true, output: `${line} ok` };
        },
        stop: () => {
          if (!play) return;
          stopped.push(playScene!);
          play = null;
          const result: PlaySessionResult = {
            diagnostics: scene.diagnostics ?? [], droppedDiagnostics: 0, textureCountBefore: 5,
            released: Promise.resolve({ textureCountAfter: 5, textureLeak: false, quarantined: false }),
            runtimeMode: "worker", lastTrace: null,
          };
          for (const listener of [...listeners]) listener(result);
        },
      };
    },
    play: () => play,
    sessionIdle: () => play === null,
    onSessionClosed: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    sampleFrames: async () => {
      // The command a sample follows, past the Breakdown's per-sample `gpubusy on`.
      sampled.push({ now, after: commands.filter((line) => line !== "gpubusy on").at(-1) ?? null });
      return { frames: 60, durationMs: 1000, fps: 60, p95Ms: 17, maxMs: 20, stalls: 0 };
    },
    now: () => now,
    sleep: async (ms, signal) => {
      signal.throwIfAborted();
      now += ms;
      onSleep?.(now);
      signal.throwIfAborted();
    },
  };
  return { deps, started, stopped, commands, sampled };
}

const scene = (name: string) => ({ name, path: `assets/${name}.scene.hasset` });

describe("runFeatureTestCheck", () => {
  it("stops a Play that never finishes loading, records where it stuck, and checks the next scene", async () => {
    const editor = fakeEditor({ "assets/stuck.scene.hasset": { play: "stuck" } });
    const report = await runFeatureTestCheck({
      mode: "full", scenes: [scene("stuck"), scene("fine")], deps: editor.deps, signal: new AbortController().signal,
    });
    const [stuck, fine] = report.scenes;
    expect(stuck.passed).toBe(false);
    expect(stuck.play).toMatchObject({ status: "timeout", phase: "Loading Models 45%" });
    expect(stuck.problems.join(" ")).toContain("did not finish loading");
    expect(editor.stopped).toEqual(["scene:assets/stuck.scene.hasset", "scene:assets/fine.scene.hasset"]);
    expect(fine.passed).toBe(true);
    expect(fine.play.commands).toMatchObject([{ line: "ft_stats", success: true, output: "ft_stats ok" }]);
    expect(report.cancelled).toBe(false);
  });

  it("reads the shaders first drawn after a scene's commands ran, so Full mode's spawns count", async () => {
    const editor = fakeEditor({}, undefined, (now, commands) => ({ drawn: commands.length * 10 + now, held: 0 }));
    const report = await runFeatureTestCheck({
      mode: "full", scenes: [scene("main")], deps: editor.deps, signal: new AbortController().signal,
    });
    const main = report.scenes[0];
    expect(main.play.commands.map((command) => command.line)).toContain("ft_spawn 10");
    expect(main.play.firstDraws?.draws).toBe(main.play.commands.length);
  });

  it("fails a scene on a failed command or a session error, but not on warnings", async () => {
    const editor = fakeEditor({
      "assets/command.scene.hasset": { commands: { ft_stats: { success: false, output: "Unknown command" } } },
      "assets/error.scene.hasset": { diagnostics: [diagnostic("error", "Boom")] },
      "assets/warning.scene.hasset": { diagnostics: [diagnostic("warning", "Slow")] },
    });
    const report = await runFeatureTestCheck({
      mode: "quick", scenes: [scene("command"), scene("error"), scene("warning")], deps: editor.deps, signal: new AbortController().signal,
    });
    expect(report.scenes.map((entry) => [entry.name, entry.passed])).toEqual([["command", false], ["error", false], ["warning", true]]);
    expect(report.scenes[0].problems).toEqual(["Command ft_stats failed: Unknown command."]);
    expect(report.scenes[1].session?.diagnostics).toHaveLength(1);
  });

  it("reports a scene the editor never opened without starting Play", async () => {
    const editor = fakeEditor({ "assets/blocked.scene.hasset": { open: "blocked" }, "assets/broken.scene.hasset": { open: "failed" } });
    const report = await runFeatureTestCheck({
      mode: "full", scenes: [scene("blocked"), scene("broken")], deps: editor.deps, signal: new AbortController().signal,
    });
    expect(report.scenes.map((entry) => entry.editor.status)).toEqual(["not-opened", "failed"]);
    const broken = report.scenes[1].editor;
    expect(broken.gpu?.renderer).toBe("apple-a16");
    expect(broken.error?.[0]).toBe("Error: Scene construction failed.");
    expect(broken.error).toContain("  Error: WebGPU device lost");
    expect(report.scenes.map((entry) => entry.play.status)).toEqual(["not-started", "not-started"]);
    expect(editor.started).toEqual([]);
  });

  it("hands each step the report so far, with every benchmark profile that finished", async () => {
    const controller = new AbortController();
    const editor = fakeEditor({}, () => { if (editor.commands.includes("quality high")) controller.abort(); });
    const steps: { step: string; profiles: string[]; scenes: number }[] = [];
    const report = await runFeatureTestCheck({
      mode: "benchmark", scenes: [scene("main"), scene("never")], deps: editor.deps, signal: controller.signal,
      onStep: (step, partial) => steps.push({ step, profiles: partial.scenes[0]?.play.benchmark.map((sample) => sample.label) ?? [], scenes: partial.scenes.length }),
    });
    expect(steps[0]).toEqual({ step: "main: opening in the editor", profiles: [], scenes: 1 });
    expect(steps.find((entry) => entry.step === "main: benchmarking high")?.profiles).toEqual(["low", "medium"]);
    // Cancelled during `high`: the finished profiles stay in the report.
    expect(report.cancelled).toBe(true);
    expect(report.scenes[0].play.benchmark.map((sample) => sample.label)).toEqual(["low", "medium"]);
  });

  it("stops Play and returns the partial report when cancelled", async () => {
    const controller = new AbortController();
    const editor = fakeEditor({ "assets/stuck.scene.hasset": { play: "stuck" } }, (now) => { if (now >= 10_000) controller.abort(); });
    const report = await runFeatureTestCheck({
      mode: "full", scenes: [scene("stuck"), scene("never")], deps: editor.deps, signal: controller.signal,
    });
    expect(report.cancelled).toBe(true);
    expect(report.scenes.map((entry) => [entry.name, entry.passed, entry.problems])).toEqual([
      ["stuck", false, ["Cancelled while checking this scene."]],
    ]);
    expect(editor.stopped).toEqual(["scene:assets/stuck.scene.hasset"]);
    expect(editor.started).toEqual(["scene:assets/stuck.scene.hasset"]);
  });

  it("benchmarks every profile with the frame cap lifted, then restores the session settings", async () => {
    const editor = fakeEditor({});
    const report = await runFeatureTestCheck({
      mode: "benchmark", scenes: [scene("main")], deps: editor.deps, signal: new AbortController().signal,
    });
    const [main] = report.scenes;
    expect(main.passed).toBe(true);
    expect(main.play.benchmark.map((sample) => sample.label)).toEqual(FEATURE_TEST_BENCHMARK_PROFILES.map((profile) => profile.label));
    expect(editor.commands.slice(0, 2)).toEqual(["framecap", "framecap 240"]);
    expect(editor.commands.slice(-2)).toEqual(["quality reset", "framecap 30"]);
    expect(editor.commands).toContain("quality ultra");
    expect(editor.commands).not.toContain("ft_stats");
  });

  it("warms up, then measures each breakdown step on its own at the 60 fps cap between baselines, undoing it before the next", async () => {
    const editor = fakeEditor({});
    const report = await runFeatureTestCheck({
      mode: "breakdown", scenes: [scene("FT_World")], deps: editor.deps, signal: new AbortController().signal,
    });
    const samples = report.scenes[0]!.play.benchmark;
    // The fake's frames never change: the second warm-up window matches the first, which ends the warm-up.
    expect(samples.filter((sample) => sample.warmup).map((sample) => sample.label)).toEqual(["warm-up 1", "warm-up 2"]);
    expect(samples.slice(2).map((sample) => sample.label)).toEqual(breakdownSequence().map((step) => step.label));
    // A baseline before every step and one after the last.
    const measured = samples.slice(2);
    expect(measured.filter((_, index) => index % 2 === 0).every((sample) => sample.baseline)).toBe(true);
    expect(measured.filter((_, index) => index % 2 === 1).map((sample) => sample.label))
      .toEqual(FEATURE_TEST_BREAKDOWN_STEPS.map((step) => step.label));
    expect(measured.at(-1)!.label).toBe(`baseline ${FEATURE_TEST_BREAKDOWN_STEPS.length + 1}`);
    // Each step is sampled after its own commands only: the previous step was undone first, and a baseline changes nothing.
    const commands = editor.commands;
    const at = (line: string) => commands.indexOf(line);
    expect(commands.slice(at("quality shadows enabled off") + 1, at("quality shadows medium"))).toEqual(["gpubusy on", "quality reset", "gpubusy on", "quality reset"]);
    expect(commands.slice(at("postprocessing off") + 1, at("rendertargets off"))).toEqual(["gpubusy on", "quality reset", "postprocessing on", "gpubusy on", "quality reset"]);
    // GPU-busy time is restarted for every sample and stopped at the end.
    expect(commands.filter((line) => line === "gpubusy on")).toHaveLength(samples.length);
    // iOS paces frames to the display: a lifted cap only queues frames behind the GPU.
    expect(commands.slice(0, 2)).toEqual(["framecap", "framecap 60"]);
    expect(commands.slice(-3)).toEqual(["gpubusy off", "quality reset", "framecap 30"]);
  });

  it("alternates baselines and steps, so every step sits between two baselines", () => {
    const steps = [{ label: "a", commands: ["x"] }, { label: "b", commands: ["y"] }];
    expect(breakdownSequence(steps).map((step) => [step.label, step.baseline === true]))
      .toEqual([["baseline 1", true], ["a", false], ["baseline 2", true], ["b", false], ["baseline 3", true]]);
  });

  it("warms up until two windows agree within 3%, and no longer than its bound when they never do", async () => {
    const run = async (durations: (window: number) => number, breakdownWarmupMs: number) => {
      const editor = fakeEditor({});
      let window = 0;
      const deps: FeatureTestCheckDeps = {
        ...editor.deps,
        sampleFrames: async () => {
          // Only the Breakdown's own samples, after its frame cap.
          const durationMs = editor.commands.includes("framecap 60") ? durations(window++) : 1000;
          return { frames: 60, durationMs, fps: 60_000 / durationMs, p95Ms: 17, maxMs: 20, stalls: 0 };
        },
      };
      const report = await runFeatureTestCheck({
        mode: "breakdown", scenes: [scene("FT_World")], deps, signal: new AbortController().signal,
        timeouts: { breakdownWarmupMs },
      });
      return report.scenes[0]!.play.benchmark.filter((sample) => sample.warmup);
    };
    // Cooling from 1300 to 1000 ms per 60 frames: stable once a window moves less than 3% from the one before.
    const cooling = await run((window) => [1300, 1200, 1100, 1020, 1010][window] ?? 1000, 3_600_000);
    expect(cooling.map((sample) => sample.label)).toEqual(["warm-up 1", "warm-up 2", "warm-up 3", "warm-up 4", "warm-up 5"]);
    // Alternating 10% apart never settles: the bound ends it, after at least one window past it.
    const never = await run((window) => (window % 2 ? 1100 : 1000), 200_000);
    expect(never.length).toBeGreaterThan(1);
    expect(never.length).toBeLessThan(20);
    expect(never.every((sample) => !isBreakdownBaseline(sample) && breakdownDelta(never, sample) === null)).toBe(true);
  });

  it("keeps each sample's GPU-busy time when the probe answered", async () => {
    const editor = fakeEditor({}, undefined, (now, commands) => ({ drawn: commands.length * 10 + now, held: 0 }));
    const gpuBusy = { frames: 290, medianMs: 21.5, p95Ms: 26, pollMs: 4.1, skipped: 0 };
    const deps: FeatureTestCheckDeps = {
      ...editor.deps,
      play: () => {
        const play = editor.deps.play();
        return play && { ...play, snapshot: () => { const snapshot = play.snapshot(); return { ...snapshot, rendering: { ...snapshot.rendering!, gpuBusy } }; } };
      },
    };
    const report = await runFeatureTestCheck({
      mode: "breakdown", scenes: [scene("FT_World")], deps, signal: new AbortController().signal,
    });
    const samples = report.scenes[0]!.play.benchmark;
    expect(samples.find((sample) => sample.label === "shadows off")!.gpuBusy).toEqual(gpuBusy);
    expect(breakdownDelta(samples, samples.find((sample) => sample.label === "shadows off")!)).toMatchObject({ ms: 0, basis: "gpu" });
  });

  it("restores a step's toggle when the sweep stops at it", async () => {
    const controller = new AbortController();
    const editor = fakeEditor({}, undefined, (_now, commands) => commands.includes("rendertargets off")
      ? { drawn: 0, held: commands.length }
      : { drawn: commands.length * 10 + _now, held: 0 });
    await runFeatureTestCheck({
      mode: "breakdown", scenes: [scene("FT_World")], deps: editor.deps, signal: controller.signal,
    });
    // `captures off` never draws steadily: the sweep stops there and still turns captures back on.
    expect(editor.commands).not.toContain("quality resolution scale 0.5");
    expect(editor.commands.slice(-3)).toEqual(["quality reset", "rendertargets on", "framecap 30"]);
  });

  it("samples a recompiling profile only once the view draws without held frames, within a bound", async () => {
    // `quality medium` holds the view for 20 s of new shaders; `quality high` never stops holding.
    const counts = { drawn: 0, held: 0 };
    const issuedAt = new Map<string, number>();
    let heldUntil = -1;
    const editor = fakeEditor({}, undefined, (now, commands) => {
      const last = commands.at(-1) ?? "";
      if (!issuedAt.has(last) && (last === "quality medium" || last === "quality high")) {
        issuedAt.set(last, now);
        heldUntil = last === "quality medium" ? now + 20_000 : Number.POSITIVE_INFINITY;
      }
      if (now < heldUntil) counts.held++;
      else counts.drawn++;
      return { ...counts };
    });
    const report = await runFeatureTestCheck({
      mode: "benchmark", scenes: [scene("main")], deps: editor.deps, signal: new AbortController().signal,
    });
    const sampledAt = editor.sampled.find((sample) => sample.after === "quality medium")!.now;
    // Held 20 s, then steady draws and the 3 s settle.
    expect(sampledAt - issuedAt.get("quality medium")!).toBeGreaterThanOrEqual(23_000);
    const benchmark = report.scenes[0]!.play.benchmark;
    expect(benchmark.find((sample) => sample.label === "medium")!.failed).toEqual([]);
    expect(benchmark.find((sample) => sample.label === "high")!.failed)
      .toEqual(["The view did not draw steadily within 90 s; the remaining profiles were skipped."]);
    // Nothing more piles onto a view that stopped drawing; the session settings are still restored.
    expect(benchmark.at(-1)!.label).toBe("high");
    expect(editor.commands).not.toContain("quality ultra");
    expect(editor.commands.slice(-2)).toEqual(["quality reset", "framecap 30"]);
  });
});

describe("breakdown settling", () => {
  /** A Play whose shaders keep being first drawn (and compiling) until `quietAt` after each command. */
  const compilingFor = (ms: number) => {
    let firstDraws = 0;
    let busyUntil = 0;
    let commandsSeen = 0;
    const editor = fakeEditor({}, (now) => {
      // Timing GPU work (`gpubusy`) compiles nothing.
      const changing = editor ? editor.commands.filter((line) => !line.startsWith("gpubusy")).length : 0;
      if (changing !== commandsSeen) { commandsSeen = changing; busyUntil = now + ms; }
      if (now < busyUntil) firstDraws += 1;
    });
    const deps: FeatureTestCheckDeps = {
      ...editor.deps,
      compiling: () => (editor.deps.now() < busyUntil ? 2 : 0),
      play: () => {
        const play = editor.deps.play();
        return play && {
          ...play,
          snapshot: () => ({ ...play.snapshot(), rendering: { firstDraws: { draws: firstDraws }, cpuMs: 10, gpuMs: null, width: 100, height: 100, scalingLevel: 1 } as unknown as RenderDiagnostics }),
        };
      },
    };
    return { editor, deps };
  };

  it("samples a step only after shaders stopped being first drawn and compiling for the quiet time", async () => {
    const { editor, deps } = compilingFor(12_000);
    const issued = new Map<string, number>();
    const tracked = { ...deps, sleep: async (ms: number, signal: AbortSignal) => {
      const last = editor.commands.at(-1);
      if (last && !issued.has(last)) issued.set(last, deps.now());
      await deps.sleep(ms, signal);
    } };
    const report = await runFeatureTestCheck({ mode: "breakdown", scenes: [scene("FT_World")], deps: tracked, signal: new AbortController().signal });
    const sampledAt = editor.sampled.find((sample) => sample.after === "quality shadows enabled off")!.now;
    // 12 s of first draws and compiles, then the 3 s quiet time.
    expect(sampledAt - issued.get("quality shadows enabled off")!).toBeGreaterThanOrEqual(15_000);
    const shadows = report.scenes[0]!.play.benchmark.find((sample) => sample.label === "shadows off")!;
    expect(shadows.unsettled).toMatchObject({ firstDraws: 0, compiling: 0 });
    // 12 s busy, then the 3 s quiet time, within one 250 ms poll.
    expect(shadows.unsettled!.settleMs).toBeGreaterThanOrEqual(14_750);
    expect(shadows.failed).toEqual([]);
  });

  it("flags a step whose shaders never settle within the bound, and still samples it", async () => {
    const { deps } = compilingFor(Number.POSITIVE_INFINITY);
    const report = await runFeatureTestCheck({
      mode: "breakdown", scenes: [scene("FT_World")], deps, signal: new AbortController().signal, timeouts: { profileCompileMs: 10_000 },
    });
    const benchmark = report.scenes[0]!.play.benchmark;
    expect(benchmark[0]!.failed).toEqual(["Shaders were still first drawn or compiling after 10 s; this window's frames include them."]);
    const first = benchmark.find((sample) => !sample.warmup)!;
    expect(first.failed).toEqual(["Shaders were still first drawn or compiling after 10 s; this step's frames include them."]);
    expect(first.unsettled!.compiling).toBeGreaterThan(0);
  });
});

describe("draw sampling", () => {
  // A static view's planar reflection draws on alternate frames: one frame's count is off by its whole draw count.
  const alternating = (deps: FeatureTestCheckDeps): FeatureTestCheckDeps => {
    let reads = 0;
    return {
      ...deps,
      play: () => {
        const play = deps.play();
        return play && { ...play, snapshot: () => ({ ...play.snapshot(), drawCalls: reads++ % 2 ? 605 : 544 }) };
      },
      sampleFrames: async (durationMs, signal) => {
        const frames = await deps.sampleFrames(durationMs, signal);
        await deps.sleep(durationMs, signal);
        return frames;
      },
    };
  };

  it("records Play's per-frame counters over the sample window, not one frame's", async () => {
    const editor = fakeEditor({});
    const report = await runFeatureTestCheck({
      mode: "quick", scenes: [scene("FT_World")], deps: alternating(editor.deps), signal: new AbortController().signal,
    });
    const counters = report.scenes[0].play.counters!;
    expect(counters.draws).toMatchObject({ min: 544, max: 605 });
    expect(counters.draws!.samples).toBeGreaterThanOrEqual(2);
    // This fake reports no rendering diagnostics in Quick mode, so there is no frame cost to sample.
    expect(counters.cpuMs).toBeNull();
  });

  it("gives each benchmark step its median counters and their range", async () => {
    const editor = fakeEditor({}, undefined, (now, commands) => ({ drawn: commands.length * 10 + now, held: 0 }));
    const report = await runFeatureTestCheck({
      mode: "benchmark", scenes: [scene("FT_World")], deps: alternating(editor.deps), signal: new AbortController().signal,
    });
    for (const sample of report.scenes[0].play.benchmark) {
      expect(sample.draws).toMatchObject({ min: 544, max: 605 });
      expect(sample.drawCalls).toBe(sample.draws!.median);
      expect(sample.cpuMs).toBe(4);
      expect(sample.cpu).toMatchObject({ median: 4 });
    }
  });

  it("summarises the samples by their median and range, and nothing without one", () => {
    expect(counterStats([605, 544, 605, 544])).toEqual({ median: 574.5, min: 544, max: 605, samples: 4 });
    expect(counterStats([544, 605, 544])).toEqual({ median: 544, min: 544, max: 605, samples: 3 });
    expect(counterStats([])).toBeNull();
  });
});

describe("breakdownDelta", () => {
  const sample = (label: string, meanMs?: number, baseline = label.startsWith("baseline")): FeatureTestBenchmarkSample => ({
    label, baseline,
    frames: meanMs === undefined ? null : { frames: 100, durationMs: meanMs * 100, fps: 1000 / meanMs, medianMs: 33.3, meanMs, p95Ms: 46, maxMs: 50, stalls: 0 },
    runtimeFps: null, cpuMs: null, gpuMs: null, drawCalls: 0, resolution: null, failed: [],
  });

  it("measures a step's mean frame time against the baselines around it, so drift is shared", () => {
    const samples = [sample("baseline 1", 38), sample("shadows off", 30), sample("baseline 2", 42), sample("post off", 30), sample("baseline 3", 46)];
    expect(breakdownDelta(samples, samples[1]!)).toEqual({ ms: -10, percent: -25, basis: "frame" });
    // Against baselines 2 and 3, not the first: drift since the start is not counted as the step's.
    expect(breakdownDelta(samples, samples[3]!)).toEqual({ ms: -14, percent: -31.818181818181817, basis: "frame" });
    // A baseline's change is its drift against the first.
    expect(breakdownDelta(samples, samples[4]!)!.ms).toBe(8);
    expect(breakdownDelta(samples, samples[0]!)!.ms).toBe(0);
  });

  it("uses the baselines that were measured, and reports nothing without one or without frames", () => {
    const one = [sample("baseline 1", 40), sample("post off", 30), sample("baseline 2")];
    expect(breakdownDelta(one, one[1]!)).toEqual({ ms: -10, percent: -25, basis: "frame" });
    const none = [sample("baseline 1"), sample("post off", 30)];
    expect(breakdownDelta(none, none[1]!)).toBeNull();
    const unmeasured = [sample("baseline 1", 40), sample("post off")];
    expect(breakdownDelta(unmeasured, unmeasured[1]!)).toBeNull();
  });

  it("compares median GPU-busy time when the step and its baselines measured it, else mean frame time", () => {
    const busy = (entry: FeatureTestBenchmarkSample, medianMs: number): FeatureTestBenchmarkSample =>
      ({ ...entry, gpuBusy: { frames: 300, medianMs, p95Ms: medianMs + 4, pollMs: 4, skipped: 0 } });
    // Frame times are vsync-bound (all 33.3 ms) and say nothing; GPU-busy time drops 6 ms against 20 and 22.
    const samples = [busy(sample("baseline 1", 33.3), 20), busy(sample("SSR off", 33.3), 15), busy(sample("baseline 2", 33.3), 22)];
    expect(breakdownDelta(samples, samples[1]!)).toEqual({ ms: -6, percent: (-6 / 21) * 100, basis: "gpu" });
    // A step whose probe did not answer falls back to frame times on both sides.
    const mixed = [samples[0]!, sample("SSR off", 30), samples[2]!];
    expect(breakdownDelta(mixed, mixed[1]!)).toMatchObject({ basis: "frame" });
    // Warm-up windows are never references, and have no change of their own.
    const warm = { ...busy(sample("warm-up 1", 50), 40), baseline: false, warmup: true };
    const warmed = [warm, ...samples];
    expect(breakdownDelta(warmed, warmed[2]!)!.ms).toBe(-6);
    expect(breakdownDelta(warmed, warmed[3]!)!.ms).toBe(2);
    expect(breakdownDelta(warmed, warm)).toBeNull();
  });

  it("reads reports saved before interleaved baselines and mean frame times", () => {
    const old = (label: string, medianMs: number): FeatureTestBenchmarkSample => ({
      label, frames: { frames: 0, durationMs: 0, fps: 0, medianMs, p95Ms: 46, maxMs: 50, stalls: 0 },
      runtimeFps: null, cpuMs: null, gpuMs: null, drawCalls: 0, resolution: null, failed: [],
    });
    const samples = [old("baseline", 38), old("shadows off", 30), old("baseline again", 42)];
    expect(breakdownDelta(samples, samples[1]!)).toEqual({ ms: -10, percent: -25, basis: "frame" });
  });
});

describe("frame pacing", () => {
  it("shares frames by how many 60 Hz display intervals they lasted", () => {
    expect(vsyncShares([16.7, 33.3, 33.4, 50, 66.7, 120, 15, 34])).toEqual([0.25, 0.375, 0.125, 0.25]);
    expect(vsyncShares([])).toEqual([0, 0, 0, 0]);
    expect(frameStats([16.7, 33.3, 33.3, 66.7])).toMatchObject({ meanMs: 37.5, vsync: [0.25, 0.5, 0, 0.25] });
  });

  it("calls a frame vsync-bound at the cap, GPU-bound well past the CPU cost, CPU-bound otherwise", () => {
    const at = (meanMs: number) => frameStats(Array.from({ length: 10 }, () => meanMs));
    expect(frameBound(at(16.7), 10)).toBe("vsync");
    expect(frameBound(at(40), 14)).toBe("gpu");
    expect(frameBound(at(40), 30)).toBe("cpu");
    expect(frameBound(at(40), null)).toBeNull();
    expect(frameBound(null, 14)).toBeNull();
  });

  it("lists the render settings two fingerprints differ in", () => {
    const base = { shadows: "high 2048", "water.reflections": "planar", "post.enabled": "true" };
    expect(settingsChanges(base, { ...base, "water.reflections": "sky" })).toEqual(["water.reflections=sky"]);
    expect(settingsChanges(base, base)).toEqual([]);
    expect(settingsChanges(undefined, base)).toEqual([]);
  });
});

describe("frameStats", () => {
  it("reports the median interval of an odd and an even count", () => {
    expect(frameStats([10, 30, 20])!.medianMs).toBe(20);
    expect(frameStats([10, 40, 20, 30])!.medianMs).toBe(25);
  });
});
