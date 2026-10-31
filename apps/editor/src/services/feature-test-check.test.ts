import { describe, expect, it } from "vitest";
import type { SessionReportEntry } from "@haptic/runtime";
import {
  antiAliasingSamples, QUALITY_GROUPS, qualitySettingsFingerprint, RenderingQualitySession, type QualityGroup,
} from "@haptic/core";
import {
  ADD_ONE_CAP_MS, breakdownAdditivity, breakdownDelta, breakdownOverCap, breakdownSaturation, breakdownSequence, breakdownSkip,
  breakdownWarmupDrift, counterStats, FEATURE_TEST_BENCHMARK_PROFILES, FEATURE_TEST_BREAKDOWN_ADD_ONE_STEPS,
  FEATURE_TEST_BREAKDOWN_BASES, FEATURE_TEST_BREAKDOWN_METHODS, FEATURE_TEST_BREAKDOWN_STEPS, featureTestBreakdownPlan, frameBound,
  frameStats, isBreakdownBaseline, runFeatureTestCheck, SATURATED_SHARE, settingsChanges, vsyncShares, warmDeviceMinutes,
  type FeatureTestBenchmarkSample, type FeatureTestBreakdownInfo, type FeatureTestCheckDeps,
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

const REMOVE_ONE: FeatureTestBreakdownInfo = { method: "remove-one", tier: "medium", ab: false, warmMinutes: null, passes: [], notes: [] };

/**
 * The render-settings fingerprint (`RenderDiagnostics.settings`) after `commands`, as a Play session derives it: quality
 * commands through the session's real `RenderingQualitySession`, `postprocessing` and `rendertargets` as the toggles
 * they are, and MSAA samples at the tier's request (no device limit).
 */
function fingerprintAfter(commands: readonly string[]): Record<string, string> {
  const session = new RenderingQualitySession();
  let post = true;
  let captures = true;
  for (const line of commands) {
    const [name, first, second, third] = line.split(" ");
    if (name === "quality") {
      if (QUALITY_GROUPS.includes(first as QualityGroup)) session.execute(first as QualityGroup, second, third);
      else session.execute(undefined, first, second);
    } else if (name === "postprocessing") post = first === "on";
    else if (name === "rendertargets") captures = first === "on";
  }
  const quality = session.effective();
  return {
    ...qualitySettingsFingerprint(quality),
    "post.samples": String(antiAliasingSamples(quality.postprocessing.antiAliasing)),
    "post.enabled": String(post),
    captures: captures ? "on" : "suspended",
  };
}

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

  it("warms up, then measures each remove-one step on its own at the 60 fps cap between baselines, undoing it before the next", async () => {
    const editor = fakeEditor({});
    const report = await runFeatureTestCheck({
      mode: "breakdown", scenes: [scene("FT_World")], deps: editor.deps, signal: new AbortController().signal, breakdown: REMOVE_ONE,
    });
    const samples = report.scenes[0]!.play.benchmark;
    // The fake's frames never change: the second warm-up window matches the first, which ends the warm-up.
    expect(samples.filter((sample) => sample.warmup).map((sample) => sample.label)).toEqual(["warm-up 1", "warm-up 2"]);
    expect(samples.slice(2).map((sample) => sample.label))
      .toEqual(breakdownSequence(featureTestBreakdownPlan("FT_World", "remove-one").views).map((step) => step.label));
    // A baseline before every step and one after the last.
    const measured = samples.slice(2);
    expect(measured.filter((_, index) => index % 2 === 0).every((sample) => sample.baseline)).toBe(true);
    expect(measured.filter((_, index) => index % 2 === 1).map((sample) => sample.label))
      .toEqual(FEATURE_TEST_BREAKDOWN_STEPS.map((step) => step.label));
    expect(measured.at(-1)!.label).toBe(`baseline ${FEATURE_TEST_BREAKDOWN_STEPS.length + 1}`);
    // Each step is sampled after its own commands only: the previous step was undone (back to the Medium tier at the
    // project's fixed resolution) first, and a baseline changes nothing.
    const commands = editor.commands;
    const at = (line: string) => commands.indexOf(line);
    const tier = ["quality reset", "quality medium", "quality resolution reset"];
    expect(commands.slice(at("quality shadows enabled off") + 1, at("quality shadows medium"))).toEqual(["gpubusy on", ...tier, "gpubusy on", ...tier]);
    expect(commands.slice(at("postprocessing off") + 1, at("rendertargets off"))).toEqual(["gpubusy on", ...tier, "postprocessing on", "gpubusy on", ...tier]);
    // GPU-busy time is restarted for every sample and stopped at the end.
    expect(commands.filter((line) => line === "gpubusy on")).toHaveLength(samples.length);
    // iOS paces frames to the display: a lifted cap only queues frames behind the GPU. The tier applies before the
    // warm-up, so the warm-up runs at the baselines' settings; the session's own quality returns at the end.
    expect(commands.slice(0, 5)).toEqual(["framecap", "framecap 60", "quality medium", "quality resolution reset", "gpubusy on"]);
    expect(commands.slice(-3)).toEqual(["gpubusy off", "quality reset", "framecap 30"]);
  });

  it("reports a base command the session refused on the first sample, which it would skew", async () => {
    const editor = fakeEditor({ "assets/FT_World.scene.hasset": { commands: { "quality low": { success: false, output: "Invalid quality setting or value" } } } });
    const report = await runFeatureTestCheck({
      mode: "breakdown", scenes: [scene("FT_World")], deps: editor.deps, signal: new AbortController().signal,
    });
    const [world] = report.scenes;
    expect(world!.play.benchmark[0]!.failed).toEqual(["quality low failed: Invalid quality setting or value."]);
    expect(world!.problems[0]).toBe("warm-up 1: quality low failed: Invalid quality setting or value.");
    expect(world!.passed).toBe(false);
  });

  it("measures FT_Occlusion's culling against its off baselines from the street camera, then from the possessed Rooms Camera", async () => {
    const editor = fakeEditor({});
    // Culling reports counts only while the session turned it on.
    const deps: FeatureTestCheckDeps = {
      ...editor.deps,
      play: () => {
        const play = editor.deps.play();
        return play && { ...play, snapshot: () => {
          const last = editor.commands.filter((line) => line.startsWith("quality")).at(-1);
          const occlusion = last === "quality geometry occlusion on" ? { tested: 480, culled: 212, occluders: 30, triangles: 1520, ms: 0.42 } : null;
          return { ...play.snapshot(), rendering: { cpuMs: 4, gpuMs: null, width: 100, height: 100, scalingLevel: 1, occlusion } as unknown as RenderDiagnostics };
        } };
      },
    };
    const report = await runFeatureTestCheck({
      mode: "breakdown", scenes: [scene("FT_Occlusion")], deps, signal: new AbortController().signal,
    });
    const samples = report.scenes[0]!.play.benchmark.filter((sample) => !sample.warmup);
    expect(samples.map((sample) => [sample.label, sample.view ?? null, sample.baseline])).toEqual([
      ["baseline 1", null, true], ["occlusion on", null, false], ["baseline 2", null, true],
      ["rooms baseline 1", "rooms", true], ["rooms occlusion on", "rooms", false], ["rooms baseline 2", "rooms", true],
    ]);
    expect(samples.find((sample) => sample.label === "rooms occlusion on")!.occlusion).toEqual({ tested: 480, culled: 212, triangles: 1520, ms: 0.42 });
    expect(samples.find((sample) => sample.label === "rooms baseline 2")!.occlusion).toBeUndefined();
    const commands = editor.commands;
    const at = (line: string) => commands.indexOf(line);
    // The rooms camera is possessed before its first baseline is sampled, and kept for its step.
    expect(commands.slice(at('possess "Rooms Camera"') + 1, at('possess "Rooms Camera"') + 2)).toEqual(["gpubusy on"]);
    expect(commands.filter((line) => line.startsWith("possess"))).toEqual(['possess "Rooms Camera"', 'possess "Camera"']);
    // Back to the scene's own camera at the end, after its quality and the add-one base's toggles.
    expect(commands.slice(-6)).toEqual(["gpubusy off", "quality reset", "postprocessing on", "rendertargets on", 'possess "Camera"', "framecap 30"]);
  });

  it("alternates baselines and steps per camera, so every step sits between two baselines of its own camera", () => {
    const steps = [{ label: "a", commands: ["x"] }, { label: "b", commands: ["y"] }];
    expect(breakdownSequence([{ steps }]).map((step) => [step.label, step.baseline === true]))
      .toEqual([["baseline 1", true], ["a", false], ["baseline 2", true], ["b", false], ["baseline 3", true]]);
    const views = breakdownSequence([{ steps: [steps[0]!] }, { name: "far", enter: ["possess far"], steps: [steps[1]!] }]);
    expect(views.map((step) => [step.label, step.view ?? null, step.commands])).toEqual([
      ["baseline 1", null, []], ["a", null, ["x"]], ["baseline 2", null, []],
      ["far baseline 1", "far", ["possess far"]], ["far b", "far", ["y"]], ["far baseline 2", "far", []],
    ]);
  });

  it("measures add-one by default: each feature on top of the light base, undone by the base, which Play leaves at the end", async () => {
    const editor = fakeEditor({});
    const report = await runFeatureTestCheck({
      mode: "breakdown", scenes: [scene("FT_World")], deps: editor.deps, signal: new AbortController().signal,
    });
    const measured = report.scenes[0]!.play.benchmark.filter((sample) => !sample.warmup);
    expect(measured.filter((sample) => !sample.baseline).map((sample) => sample.label)).toEqual([
      "MSAA 2x", "MSAA 4x", "AA fxaa", "shadow filter high", "post-processing", "AO", "SSR", "water detail medium", "water detail high",
      "water refraction", "planar water reflection", "captures", "resolution 1.0",
    ]);
    const base = FEATURE_TEST_BREAKDOWN_BASES["add-one"].commands;
    const commands = editor.commands;
    const at = (line: string) => commands.indexOf(line);
    // The base before the warm-up; after each step `quality reset` and the base again, which turns its toggles back off.
    expect(commands.slice(0, 2 + base.length)).toEqual(["framecap", "framecap 60", ...base]);
    expect(commands.slice(at("quality postprocessing ambientOcclusion on") + 1, at("quality postprocessing reflections on") - 1))
      .toEqual(["gpubusy on", "quality reset", ...base, "gpubusy on", "quality reset", ...base]);
    // Medium's values: water refraction at Medium's copy scale, planar reflection at Medium's planar scale.
    expect(commands).toContain("quality water refractionScale 0.75");
    expect(commands).toContain("quality water planarScale 0.5");
    // Play gets its post-processing and captures back.
    expect(commands.slice(-5)).toEqual(["gpubusy off", "quality reset", "postprocessing on", "rendertargets on", "framecap 30"]);
  });

  it("skips a step whose setting already holds its value, and the baseline after it, without sampling either", async () => {
    const editor = fakeEditor({});
    const deps: FeatureTestCheckDeps = {
      ...editor.deps,
      play: () => {
        const play = editor.deps.play();
        return play && { ...play, snapshot: () => ({
          ...play.snapshot(),
          rendering: { cpuMs: 4, gpuMs: null, width: 100, height: 100, scalingLevel: 1, settings: fingerprintAfter(editor.commands) } as unknown as RenderDiagnostics,
        }) };
      },
    };
    const report = await runFeatureTestCheck({
      mode: "breakdown", scenes: [scene("FT_World")], deps, signal: new AbortController().signal, breakdown: REMOVE_ONE,
    });
    const measured = report.scenes[0]!.play.benchmark.filter((sample) => !sample.warmup);
    const skipped = measured.filter((sample) => sample.skipped);
    expect(skipped.map((sample) => [sample.label, sample.skipped])).toEqual([
      ["shadows medium", "already shadows medium 2048, shadows.filter high"],
      ["water detail medium", "already water.shadingDetail medium, water.fft 256x3"],
      ["volumetrics off", "already post.volumetricLighting false"],
    ]);
    expect(skipped.every((sample) => sample.frames === null)).toBe(true);
    // The filter step changes the fingerprint now, so it is measured.
    expect(measured.find((sample) => sample.label === "shadow filter medium")).toMatchObject({ settings: { "shadows.filter": "medium" } });
    expect(measured.find((sample) => sample.label === "shadow filter medium")!.skipped).toBeUndefined();
    // shadows off, its baseline, the skipped step, then straight to the next step: the baseline before it is adjacent.
    const labels = measured.map((sample) => sample.label);
    expect(labels.slice(labels.indexOf("shadows off"), labels.indexOf("shadows off") + 5))
      .toEqual(["shadows off", "baseline 2", "shadows medium", "shadow filter medium", "baseline 4"]);
    expect(editor.sampled.length).toBe(report.scenes[0]!.play.benchmark.filter((sample) => !sample.skipped).length + 2);
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
    expect(samples.find((sample) => sample.label === "MSAA 2x")!.gpuBusy).toEqual(gpuBusy);
    expect(breakdownDelta(samples, samples.find((sample) => sample.label === "MSAA 2x")!)).toMatchObject({ ms: 0, basis: "gpu" });
  });

  it("restores a step's toggle when the sweep stops at it", async () => {
    const controller = new AbortController();
    const editor = fakeEditor({}, undefined, (_now, commands) => commands.includes("rendertargets off")
      ? { drawn: 0, held: commands.length }
      : { drawn: commands.length * 10 + _now, held: 0 });
    await runFeatureTestCheck({
      mode: "breakdown", scenes: [scene("FT_World")], deps: editor.deps, signal: controller.signal, breakdown: REMOVE_ONE,
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
    const sampledAt = editor.sampled.find((sample) => sample.after === "quality shadows filter high")!.now;
    // 12 s of first draws and compiles, then the 3 s quiet time.
    expect(sampledAt - issued.get("quality shadows filter high")!).toBeGreaterThanOrEqual(15_000);
    const shadows = report.scenes[0]!.play.benchmark.find((sample) => sample.label === "shadow filter high")!;
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

  it("compares a camera's steps and baselines only with that camera's baselines", () => {
    const view = (entry: FeatureTestBenchmarkSample, name: string): FeatureTestBenchmarkSample => ({ ...entry, view: name });
    const samples = [
      sample("baseline 1", 40), sample("occlusion on", 36), sample("baseline 2", 40),
      view(sample("rooms baseline 1", 20, true), "rooms"), view(sample("rooms occlusion on", 15), "rooms"), view(sample("rooms baseline 2", 21, true), "rooms"),
    ];
    expect(breakdownDelta(samples, samples[4]!)).toEqual({ ms: -5.5, percent: (-5.5 / 20.5) * 100, basis: "frame" });
    // The rooms camera's first baseline is its own reference: the camera change is not drift.
    expect(breakdownDelta(samples, samples[3]!)!.ms).toBe(0);
    expect(breakdownDelta(samples, samples[5]!)!.ms).toBe(1);
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

describe("breakdown verdicts", () => {
  const sample = (label: string, busyMs: number, extra: Partial<FeatureTestBenchmarkSample> = {}): FeatureTestBenchmarkSample => ({
    label, baseline: label.includes("baseline"),
    frames: { frames: 100, durationMs: 3330, fps: 30, meanMs: 33.3, p95Ms: 34, maxMs: 40, stalls: 0, vsync: [0, 1, 0, 0] },
    runtimeFps: null, cpuMs: 8, gpuMs: null, drawCalls: 0, resolution: null, failed: [],
    gpuBusy: { frames: 100, medianMs: busyMs, p95Ms: busyMs + 2, pollMs: 4, skipped: 0 }, ...extra,
  });

  it("is NON-ADDITIVE when the savings of steps that overlap no other sum past the first baseline", () => {
    // Against baselines of 20 ms: shadows off saves 9, post off 8, captures off 5 (22 > 20); post low (overlapping post off) is left out.
    const run = [
      sample("baseline 1", 20), sample("shadows off", 11), sample("baseline 2", 20), sample("post low", 2), sample("baseline 3", 20),
      sample("post off", 12), sample("baseline 4", 20), sample("captures off", 15), sample("baseline 5", 20),
    ];
    expect(breakdownAdditivity("FT_World", run, "remove-one")).toEqual([{ view: undefined, savingsMs: 22, baselineMs: 20, basis: "gpu", nonAdditive: true }]);
    // Without captures off the sum is 17, which a 20 ms frame can hold; post low's 18 ms is not counted.
    expect(breakdownAdditivity("FT_World", run.slice(0, 7), "remove-one")).toMatchObject([{ savingsMs: 17, nonAdditive: false }]);
  });

  it("checks each camera's savings against its own first baseline, and only steps that saved", () => {
    const rooms = (entry: FeatureTestBenchmarkSample): FeatureTestBenchmarkSample => ({ ...entry, view: "rooms" });
    const run = [
      sample("baseline 1", 10), sample("occlusion on", 11), sample("baseline 2", 10),
      rooms(sample("rooms baseline 1", 4)), rooms(sample("rooms occlusion on", 3)), rooms(sample("rooms baseline 2", 4)),
    ];
    expect(breakdownAdditivity("FT_Occlusion", run, "remove-one")).toEqual([
      { view: undefined, savingsMs: 0, baselineMs: 10, basis: "gpu", nonAdditive: false },
      { view: "rooms", savingsMs: 1, baselineMs: 4, basis: "gpu", nonAdditive: false },
    ]);
  });

  it("leaves add-one out of the additivity check: its changes are costs on a base, not shares of one frame", () => {
    const run = [sample("baseline 1", 10), sample("MSAA 4x", 30), sample("baseline 2", 10)];
    expect(breakdownAdditivity("FT_World", run, "add-one")).toEqual([]);
  });

  it("is OVER CAP when an add-one baseline passes the cap, in GPU-busy time where measured, else mean frame time", () => {
    const run = [
      sample("baseline 1", ADD_ONE_CAP_MS), sample("MSAA 4x", 45), sample("baseline 2", 31),
      sample("baseline 3", 0, { gpuBusy: undefined, frames: { frames: 100, durationMs: 3500, fps: 28, meanMs: 35, p95Ms: 40, maxMs: 50, stalls: 0 } }),
      sample("warm-up 1", 40, { baseline: false, warmup: true }),
    ];
    // At the cap is not over it; the step and the warm-up window are not baselines.
    expect(breakdownOverCap(run)).toEqual([{ label: "baseline 2", ms: 31, basis: "gpu" }, { label: "baseline 3", ms: 35, basis: "frame" }]);
  });

  it("measures the warm-up drift from the first window to the last, steady one", () => {
    const warm = (label: string, busyMs: number) => sample(label, busyMs, { baseline: false, warmup: true });
    expect(breakdownWarmupDrift([warm("warm-up 1", 40), warm("warm-up 2", 21), warm("warm-up 3", 20), sample("baseline 1", 70)]))
      .toEqual({ firstMs: 40, steadyMs: 20, percent: -50, windows: 3, basis: "gpu" });
    expect(breakdownWarmupDrift([warm("warm-up 1", 40), sample("baseline 1", 20)])).toBeNull();
  });

  it("is SATURATED when most baseline frames lasted four or more display intervals, weighted by frames", () => {
    const paced = (label: string, frames: number, fourPlus: number) =>
      sample(label, 20, { frames: { frames, durationMs: frames * 70, fps: 14, p95Ms: 80, maxMs: 90, stalls: 0, vsync: [0, 0, 1 - fourPlus, fourPlus] } });
    // (100 x 0.8 + 50 x 0.2) / 150 = 0.6; the step's own frames do not count.
    const run = [paced("baseline 1", 100, 0.8), paced("shadows off", 100, 0), paced("baseline 2", 50, 0.2)];
    expect(breakdownSaturation(run)).toBeCloseTo(0.6);
    expect(breakdownSaturation(run)! > SATURATED_SHARE).toBe(true);
    expect(breakdownSaturation([paced("baseline 1", 100, 0.5)])! > SATURATED_SHARE).toBe(false);
    expect(breakdownSaturation([sample("baseline 1", 20, { frames: null })])).toBeNull();
  });

  it("notes a warm device only when the previous check ended under ten minutes before", () => {
    const start = 1_790_000_000_000;
    expect(warmDeviceMinutes(start, start - 4 * 60_000 - 30_000)).toBe(4);
    expect(warmDeviceMinutes(start, start - 20_000)).toBe(0);
    expect(warmDeviceMinutes(start, start - 10 * 60_000)).toBeNull();
    expect(warmDeviceMinutes(start, null)).toBeNull();
    // A clock set back since: unknown, not warm.
    expect(warmDeviceMinutes(start, start + 60_000)).toBeNull();
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

  it("changes, with every Breakdown step, only that step's fingerprint fields, or skips it where the base already holds its value", () => {
    // At Medium, Medium's shadows, water detail and volumetrics already hold; the add-one base turns every feature off.
    const expectedSkips = { "remove-one": ["shadows medium", "water detail medium", "volumetrics off"], "add-one": [] as string[] };
    for (const method of FEATURE_TEST_BREAKDOWN_METHODS) {
      const base = FEATURE_TEST_BREAKDOWN_BASES[method].commands;
      const reference = fingerprintAfter(base);
      const skipped: string[] = [];
      for (const step of method === "add-one" ? FEATURE_TEST_BREAKDOWN_ADD_ONE_STEPS : FEATURE_TEST_BREAKDOWN_STEPS) {
        const after = fingerprintAfter([...base, ...step.commands]);
        const changed = settingsChanges(reference, after).map((change) => change.slice(0, change.indexOf("=")));
        expect(changed.filter((field) => !step.fields!.includes(field)), `${method} ${step.label}`).toEqual([]);
        if (breakdownSkip(step.fields, reference, after)) skipped.push(step.label);
        else expect(changed.length, `${method} ${step.label}`).toBeGreaterThan(0);
      }
      expect(skipped, method).toEqual(expectedSkips[method]);
    }
  });

  it("skips a step only when none of its fields changed, naming what they already hold", () => {
    const before = { shadows: "medium 2048", "shadows.filter": "high" };
    expect(breakdownSkip(["shadows.filter"], before, { ...before, "shadows.filter": "medium" })).toBeNull();
    expect(breakdownSkip(["shadows", "shadows.filter"], before, before)).toBe("already shadows medium 2048, shadows.filter high");
    // Without fields or a fingerprint there is nothing to compare: measure it.
    expect(breakdownSkip(undefined, before, before)).toBeNull();
    expect(breakdownSkip(["shadows"], before, undefined)).toBeNull();
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
