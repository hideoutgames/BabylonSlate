import { describe, expect, it } from "vitest";
import type { SessionReportEntry } from "@haptic/runtime";
import {
  breakdownDelta, drawStats, FEATURE_TEST_BENCHMARK_PROFILES, FEATURE_TEST_BREAKDOWN_STEPS, frameStats, runFeatureTestCheck,
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
      sampled.push({ now, after: commands.at(-1) ?? null });
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
    const editor = fakeEditor({}, undefined, () => ({ drawn: 1, held: 0 }));
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

  it("measures each breakdown step on its own, undoing it before the next, between two baselines", async () => {
    const editor = fakeEditor({});
    const report = await runFeatureTestCheck({
      mode: "breakdown", scenes: [scene("FT_World")], deps: editor.deps, signal: new AbortController().signal,
    });
    const samples = report.scenes[0]!.play.benchmark;
    expect(samples.map((sample) => sample.label)).toEqual(FEATURE_TEST_BREAKDOWN_STEPS.map((step) => step.label));
    expect(samples[0]!.label).toBe("baseline");
    expect(samples.at(-1)!.label).toBe("baseline again");
    // Each step is sampled after its own commands only: the previous step was undone first.
    const commands = editor.commands;
    const at = (line: string) => commands.indexOf(line);
    expect(at("quality shadows enabled off")).toBeLessThan(at("quality shadows medium"));
    expect(commands.slice(at("quality shadows enabled off") + 1, at("quality shadows medium"))).toEqual(["quality reset"]);
    expect(commands.slice(at("postprocessing off") + 1, at("rendertargets off"))).toEqual(["quality reset", "postprocessing on"]);
    expect(commands.slice(at("rendertargets off") + 1, at("quality resolution scale 0.5"))).toEqual(["quality reset", "rendertargets on"]);
    expect(editor.sampled.find((sample) => sample.after === "postprocessing off")).toBeDefined();
    expect(commands.slice(0, 2)).toEqual(["framecap", "framecap 240"]);
    expect(commands.slice(-2)).toEqual(["quality reset", "framecap 30"]);
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

  it("records Play's draw calls per frame over the sample window, not one frame's", async () => {
    const editor = fakeEditor({});
    const report = await runFeatureTestCheck({
      mode: "quick", scenes: [scene("FT_World")], deps: alternating(editor.deps), signal: new AbortController().signal,
    });
    const draws = report.scenes[0].play.draws!;
    expect(draws.min).toBe(544);
    expect(draws.max).toBe(605);
    expect(draws.samples).toBeGreaterThanOrEqual(2);
    expect(draws.mean).toBeGreaterThan(544);
    expect(draws.mean).toBeLessThan(605);
  });

  it("gives each benchmark step its mean draw calls and their range", async () => {
    const editor = fakeEditor({}, undefined, () => ({ drawn: 1, held: 0 }));
    const report = await runFeatureTestCheck({
      mode: "benchmark", scenes: [scene("FT_World")], deps: alternating(editor.deps), signal: new AbortController().signal,
    });
    for (const sample of report.scenes[0].play.benchmark) {
      expect(sample.draws).toMatchObject({ min: 544, max: 605 });
      expect(sample.drawCalls).toBe(Math.round(sample.draws!.mean));
    }
  });

  it("summarises the samples, and nothing without one", () => {
    expect(drawStats([544, 605, 544, 605])).toEqual({ mean: 574.5, min: 544, max: 605, samples: 4 });
    expect(drawStats([])).toBeNull();
  });
});

describe("breakdownDelta", () => {
  const sample = (label: string, medianMs?: number): FeatureTestBenchmarkSample => ({
    label, frames: medianMs === undefined ? null : { frames: 100, durationMs: 4000, fps: 25, medianMs, p95Ms: 46, maxMs: 50, stalls: 0 },
    runtimeFps: null, cpuMs: null, gpuMs: null, drawCalls: 0, resolution: null, failed: [],
  });

  it("measures a step against the mean of both baselines, so drift between them is shared", () => {
    const samples = [sample("baseline", 38), sample("shadows off", 30), sample("baseline again", 42)];
    expect(breakdownDelta(samples, samples[1]!)).toEqual({ ms: -10, percent: -25 });
    expect(breakdownDelta(samples, samples[2]!)).toEqual({ ms: 2, percent: 5 });
  });

  it("uses the baseline that was measured, and reports nothing without one or without frames", () => {
    expect(breakdownDelta([sample("baseline", 40), sample("post off", 30)], sample("post off", 30))).toEqual({ ms: -10, percent: -25 });
    expect(breakdownDelta([sample("baseline"), sample("post off", 30)], sample("post off", 30))).toBeNull();
    expect(breakdownDelta([sample("baseline", 40)], sample("post off"))).toBeNull();
  });
});

describe("frameStats", () => {
  it("reports the median interval of an odd and an even count", () => {
    expect(frameStats([10, 30, 20])!.medianMs).toBe(20);
    expect(frameStats([10, 40, 20, 30])!.medianMs).toBe(25);
  });
});
