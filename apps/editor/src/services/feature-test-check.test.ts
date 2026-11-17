import { describe, expect, it } from "vitest";
import type { SessionReportEntry } from "@haptic/runtime";
import {
  antiAliasingSamples, QUALITY_GROUPS, qualitySettingsFingerprint, RENDER_QUALITY_PROFILES, RenderingQualitySession, SHADOW_DEBUG_PARTS, SHADOW_PROFILES, WATER_DEBUG_PARTS,
  type QualityGroup, type QualityLevel,
} from "@haptic/core";
import {
  ADD_ONE_CAP_MS, breakdownAdditivity, breakdownDelta, breakdownOverCap, breakdownSaturation, breakdownSequence, breakdownSkip,
  breakdownWarmupDrift, counterStats, FEATURE_TEST_BENCHMARK_PROFILES,
  FEATURE_TEST_BREAKDOWN_BASES, FEATURE_TEST_BREAKDOWN_METHODS, FEATURE_TEST_BREAKDOWN_STEPS, featureTestBreakdownPlan, frameBound,
  frameStats, isBreakdownBaseline, runFeatureTestCheck, SATURATED_SHARE, settingsChanges, vsyncShares, warmDeviceMinutes,
  FEATURE_TEST_PROFILE_SCENES, featureTestBreakdownScenes, featureTestProfilePlan, featureTestProfileSequence, profileComparison, profileDrift,
  profileRanking, profileResolutionPin, profileState, profileStep, PROFILE_WARMUP_WINDOWS, featureTestProfileStateSequence, PROFILE_HOLD_WINDOWS,
  profileFrameState,
  type FeatureTestBenchmarkSample, type FeatureTestBreakdownInfo, type FeatureTestCheckDeps, type FeatureTestProfileState,
} from "./feature-test-check";
import type { PlaySessionResult } from "./play-session";
import type { PlayProbe } from "./runtime-probes";
import type { RenderDiagnostics } from "@haptic/render";

type SceneBehavior = {
  open?: "ready" | "failed" | "blocked";
  /**
   * `paused` shows its first frame and never ticks; `contextLost` loses the rendering context 1 s into its first load
   * (the Engine's context returns 5 s later) and loads the second time, `contextLostTwice` loses it on both loads.
   */
  play?: "loads" | "stuck" | "paused" | "contextLost" | "contextLostTwice";
  commands?: Record<string, { success: boolean; output: string }>;
  diagnostics?: SessionReportEntry[];
  /** Each Play image sample's near-black share, in order; null answers with no sample. Unlisted samples are not black. */
  image?: Array<number | null>;
};

function diagnostic(severity: "error" | "warning", message: string): SessionReportEntry {
  return { code: "TEST", message, severity, frameId: 1, count: 1, firstFrameId: 1, lastFrameId: 1 };
}

/** A fake editor whose clock advances only when the runner sleeps. */
function fakeEditor(
  scenes: Record<string, SceneBehavior>,
  onSleep?: (now: number) => void,
  /** The Play view's presentation counts at a time, after the given commands. */
  presentation?: (now: number, commands: readonly string[]) => {
    drawn: number; held: number; contextLosses?: number; skipped?: number; heldReasons?: Record<string, number>;
    rendererWork?: RenderDiagnostics["rendererWork"];
  },
) {
  let now = 0;
  let active: string | null = null;
  let play: PlayProbe | null = null;
  let playScene: string | null = null;
  /** When the current load loses the rendering context, and until when the Engine's context stays lost. */
  let losesContextAt: number | null = null;
  let contextBackAt = 0;
  const listeners = new Set<(result: PlaySessionResult) => void>();
  const close = (diagnostics: SessionReportEntry[]) => {
    play = null;
    const result: PlaySessionResult = {
      diagnostics, droppedDiagnostics: 0, textureCountBefore: 5,
      released: Promise.resolve({ textureCountAfter: 5, textureLeak: false, quarantined: false }),
      runtimeMode: "worker", lastTrace: null,
    };
    for (const listener of [...listeners]) listener(result);
  };
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
      error: () => behavior(id).open === "failed" ? new Error("Scene construction failed.", { cause: new Error("Graphics context lost") }) : undefined,
      gpu: () => ({ vendor: "apple", renderer: "apple-a16", version: null }),
    } : null,
    startPlay: async () => {
      playScene = active;
      const scene = behavior(playScene);
      const loss = scene.play === "contextLostTwice" || (scene.play === "contextLost" && !started.includes(playScene!));
      started.push(playScene!);
      losesContextAt = loss ? now + 1000 : null;
      let images = 0;
      play = {
        loadingPhase: () => scene.play === "stuck" || losesContextAt !== null ? { phase: "Loading Models", progress: 45 } : null,
        tickIndex: () => scene.play === "paused" ? 0 : 12,
        paused: () => scene.play === "paused",
        runtimeFps: () => 60,
        snapshot: () => ({
          drawCalls: 10, meshes: 20, textures: 5, accountedBytes: 0,
          rendering: presentation
            ? ({
              ...(({ skipped, rendererWork, ...counts }) => ({
                presentation: { contextLosses: 0, heldReasons: {}, ...counts }, frameBackpressure: { mode: 2, inFlight: 0, skipped: skipped ?? 0 },
                ...(rendererWork ? { rendererWork } : {}),
              }))(presentation(now, commands)),
              cpuMs: 4, gpuMs: null, width: 100, height: 100, scalingLevel: 1,
              // One shader first drawn per command run so far.
              firstDraws: { draws: commands.length, loadCompiled: 0, frames: commands.length, stalls: 0, mostInFrame: 1, worstFrameMs: 20, longFrames: 0, longest: [] },
            } as unknown as RenderDiagnostics)
            : null,
        }),
        samplePresentedImage: async () => {
          const share = scene.image ? scene.image[images] : 0;
          images += 1;
          return share === null ? null : { blackShare: share ?? 0, meanLevel: 120, width: 64, height: 36 };
        },
        stubWebGlDraws: () => false,
        problemLogs: () => [],
        executeConsoleCommand: async (line) => {
          commands.push(line);
          if (line === "framecap") return { success: true, output: "framecap 30" };
          return scene.commands?.[line] ?? { success: true, output: `${line} ok` };
        },
        stop: () => {
          if (!play) return;
          stopped.push(playScene!);
          close(scene.diagnostics ?? []);
        },
      };
    },
    play: () => play,
    sessionIdle: () => play === null,
    renderingContextLost: () => now < contextBackAt,
    onSessionClosed: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    sampleFrames: async () => {
      // The command a sample follows, past the Breakdown's per-sample `gpubusy on`.
      sampled.push({ now, after: commands.filter((line) => line !== "gpubusy on").at(-1) ?? null });
      return { frames: 60, durationMs: 1000, fps: 60, medianMs: 1000 / 60, meanMs: 1000 / 60, vsync: [1, 0, 0, 0], p95Ms: 17, maxMs: 20, stalls: 0 };
    },
    now: () => now,
    sleep: async (ms, signal) => {
      signal.throwIfAborted();
      now += ms;
      if (losesContextAt !== null && now >= losesContextAt && play) {
        losesContextAt = null;
        contextBackAt = now + 5000;
        close([{
          ...diagnostic("error", "Scene loading failed: Rendering context was lost during scene loading (textures held: 31, about 355 MB)."),
          code: "scene.loading.contextLost",
        }]);
      }
      onSleep?.(now);
      signal.throwIfAborted();
    },
  };
  return { deps, started, stopped, commands, sampled, now: () => now };
}

const scene = (name: string) => ({ name, path: `assets/${name}.scene.hasset` });

const REMOVE_ONE: FeatureTestBreakdownInfo = { method: "remove-one", tier: "medium", ab: false, warmMinutes: null, passes: [], notes: [] };

/**
 * The render-settings fingerprint (`RenderDiagnostics.settings`) after `commands`, as a Play session derives it: quality
 * commands through the session's real `RenderingQualitySession` (on `project`'s quality, which `quality reset` returns
 * to), `postprocessing`, `rendertargets` and the Engine's `framesinflight` as the toggles they are, and MSAA samples at
 * the tier's request (no device limit).
 */
function fingerprintAfter(
  commands: readonly string[],
  options: { project?: ConstructorParameters<typeof RenderingQualitySession>[0]; framesInFlight?: string } = {},
): Record<string, string> {
  const session = new RenderingQualitySession(options.project);
  let post = true;
  let captures = true;
  let framesInFlight = options.framesInFlight ?? "2";
  let discard = false;
  let layers = true;
  let fsrOutput = "device";
  let layerClears = "on";
  let heldImage = "on";
  let backbufferDepth = "kept";
  const waterOff = new Set<string>();
  const shadowOff = new Set<string>();
  for (const line of commands) {
    const [name, first, second, third] = line.split(" ");
    if (name === "quality") {
      if (QUALITY_GROUPS.includes(first as QualityGroup)) session.execute(first as QualityGroup, second, third);
      else session.execute(undefined, first, second);
    } else if (name === "postprocessing") post = first === "on";
    else if (name === "rendertargets") captures = first === "on";
    else if (name === "framesinflight") framesInFlight = first!;
    else if (name === "discardsamples") discard = first === "on";
    else if (name === "scenelayers") layers = first === "on";
    else if (name === "fsrdebug") fsrOutput = second!;
    else if (name === "layerdebug") layerClears = second!;
    else if (name === "heldimage") heldImage = first!;
    else if (name === "backbufferdiscard") backbufferDepth = first === "on" ? "discarded" : "kept";
    else if (name === "waterdebug") { if (second === "off") waterOff.add(first!); else waterOff.delete(first!); }
    else if (name === "shadowdebug") { if (second === "off") shadowOff.add(first!); else shadowOff.delete(first!); }
  }
  const quality = session.effective();
  return {
    ...qualitySettingsFingerprint(quality),
    "post.samples": String(antiAliasingSamples(quality.postprocessing.antiAliasing)),
    "post.enabled": String(post),
    captures: captures ? "on" : "suspended",
    "water.debug": WATER_DEBUG_PARTS.filter((part) => waterOff.has(part)).join(",") || "none",
    "shadows.debug": SHADOW_DEBUG_PARTS.filter((part) => shadowOff.has(part)).join(",") || "none",
    "presentation.framesInFlight": framesInFlight,
    "msaa.discard": discard ? "on" : "off",
    layers: layers ? "shown" : "hidden",
    "upscale.output": fsrOutput,
    "layers.clears": layerClears,
    "presentation.held": heldImage,
    "backbuffer.depth": backbufferDepth,
  };
}

/** A project at a quality tier, as `RenderingQualitySession` takes it: `quality reset` returns to this tier. */
function projectAt(tier: QualityLevel): ConstructorParameters<typeof RenderingQualitySession>[0] {
  return { quality: RENDER_QUALITY_PROFILES[tier], shadows: { ...SHADOW_PROFILES[tier], profile: tier } };
}

describe("runFeatureTestCheck", () => {
  it("stops a Play that never finishes loading, records where it stuck, and checks the next scene", async () => {
    const editor = fakeEditor({ "assets/stuck.scene.hasset": { play: "stuck" }, "assets/paused.scene.hasset": { play: "paused" } });
    const progress: string[] = [];
    const report = await runFeatureTestCheck({
      mode: "full", scenes: [scene("stuck"), scene("paused"), scene("fine")], deps: editor.deps, signal: new AbortController().signal,
      onStep: (step) => progress.push(step),
    });
    const [stuck, paused, fine] = report.scenes;
    expect(stuck.passed).toBe(false);
    expect(stuck.play).toMatchObject({ status: "timeout", phase: "Loading Models 45%" });
    expect(stuck.problems).toEqual(["Play did not finish loading in 120 s (stuck at Loading Models 45%)."]);
    // A Play that shows its scene but never ticks says why, in the status while it waits and in the report.
    expect(progress).toContain("paused: starting Play (first frame shown, paused before the first tick)");
    expect(paused.problems).toEqual(["Play did not finish loading in 120 s (stuck at first frame shown, paused before the first tick)."]);
    expect(editor.stopped).toEqual(["stuck", "paused", "fine"].map((name) => `scene:assets/${name}.scene.hasset`));
    expect(fine.passed).toBe(true);
    expect(fine.play.phase).toBeNull();
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

  it("fails a scene whose Play image is black in most samples or never presented, but not for one black sample", async () => {
    const editor = fakeEditor({
      "assets/black.scene.hasset": { image: [0.97, 0.6, 0.1] },
      "assets/flicker.scene.hasset": { image: [0.97, 0.59, 0] },
      "assets/frozen.scene.hasset": { image: [null, null, null] },
    });
    const report = await runFeatureTestCheck({
      mode: "quick", scenes: [scene("black"), scene("flicker"), scene("frozen")], deps: editor.deps, signal: new AbortController().signal,
    });
    expect(report.scenes.map((entry) => [entry.name, entry.passed])).toEqual([["black", false], ["flicker", true], ["frozen", false]]);
    expect(report.scenes[0].problems).toEqual(["Play image was black in 2 of 3 samples."]);
    expect(report.scenes[1].play.presentation?.imageBlack).toEqual([0.97, 0.59, 0]);
    expect(report.scenes[2].problems).toEqual(["Play presented no frame to sample in 5 s."]);
  });

  it("fails a scene whose graphics context was lost, and records the frames presented while Play was sampled and why it held them", async () => {
    // The view drew 60 more frames, held 2 (one for each reason) and skipped 5 between the start of Play's frame sample and its end.
    let samples = 0;
    const before = { drawn: 40, held: 1, skipped: 3, contextLosses: 1, heldReasons: { "Scene is not ready to render.": 1 } };
    const after = {
      drawn: 100, held: 3, skipped: 8, contextLosses: 1, heldReasons: { "Scene is not ready to render.": 2, "FrameGraph is not ready.": 1 },
    };
    const editor = fakeEditor({}, undefined, () => samples < 2 ? before : after);
    const deps: FeatureTestCheckDeps = {
      ...editor.deps,
      // The editor viewport's sample, then Play's.
      sampleFrames: (ms, signal) => { samples += 1; return editor.deps.sampleFrames(ms, signal); },
    };
    const report = await runFeatureTestCheck({ mode: "quick", scenes: [scene("main")], deps, signal: new AbortController().signal });
    expect(report.scenes[0].passed).toBe(false);
    expect(report.scenes[0].problems).toEqual(["The graphics context was lost once during Play."]);
    expect(report.scenes[0].play.presentation).toEqual({
      frames: { drawn: 60, held: 2, skipped: 5, heldReasons: { "Scene is not ready to render.": 1, "FrameGraph is not ready.": 1 } },
      contextLosses: 1, imageBlack: [0, 0, 0],
    });
  });

  it("starts Play once more after a load that lost the rendering context, once the context is back, and measures that load", async () => {
    let restartedAt: number | null = null;
    const editor = fakeEditor({ "assets/lost.scene.hasset": { play: "contextLost" } });
    const deps: FeatureTestCheckDeps = {
      ...editor.deps,
      startPlay: async () => {
        if (editor.started.length === 1) restartedAt = editor.now();
        await editor.deps.startPlay();
      },
    };
    const report = await runFeatureTestCheck({ mode: "quick", scenes: [scene("lost"), scene("next")], deps, signal: new AbortController().signal });
    const [lost, next] = report.scenes;
    expect(editor.started).toEqual(["lost", "lost", "next"].map((name) => `scene:assets/${name}.scene.hasset`));
    // The context returned 5 s after the loss, 1 s into the first load.
    expect(restartedAt).toBeGreaterThanOrEqual(6000);
    expect(lost.play).toMatchObject({ status: "loaded", phase: null });
    expect(lost.play.commands.map((command) => command.success)).toEqual([true]);
    // Measured on the second load, and still failed: the device lost its context once.
    expect(lost.passed).toBe(false);
    expect(lost.problems).toEqual([
      "Play's first load failed after 1 s, so Play was started again: Scene loading failed: Rendering context was lost during scene loading (textures held: 31, about 355 MB).",
    ]);
    expect(lost.session?.diagnostics).toEqual([]);
    expect(next.passed).toBe(true);
  });

  it("starts Play again only once: a second load that loses the rendering context fails the scene", async () => {
    const editor = fakeEditor({ "assets/lost.scene.hasset": { play: "contextLostTwice" } });
    const report = await runFeatureTestCheck({ mode: "quick", scenes: [scene("lost")], deps: editor.deps, signal: new AbortController().signal });
    const [lost] = report.scenes;
    expect(editor.started).toEqual(["scene:assets/lost.scene.hasset", "scene:assets/lost.scene.hasset"]);
    expect(lost.play.status).toBe("closed");
    expect(lost.problems).toEqual([
      "Play's first load failed after 1 s, so Play was started again: Scene loading failed: Rendering context was lost during scene loading (textures held: 31, about 355 MB).",
      "Play closed before the scene finished loading.",
      "Session report has 1 error.",
    ]);
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
    expect(broken.error).toContain("  Error: Graphics context lost");
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
    // Cancelled while Play loaded: the report says how far its load got.
    expect(report.scenes[0].play).toMatchObject({ status: "starting", phase: "Loading Models 45%" });
    expect(editor.stopped).toEqual(["scene:assets/stuck.scene.hasset"]);
    expect(editor.started).toEqual(["scene:assets/stuck.scene.hasset"]);
  });

  it("benchmarks every profile with the frame cap lifted, and ends on the last one without another tier switch", async () => {
    const editor = fakeEditor({});
    const report = await runFeatureTestCheck({
      mode: "benchmark", scenes: [scene("main")], deps: editor.deps, signal: new AbortController().signal,
    });
    const [main] = report.scenes;
    expect(main.passed).toBe(true);
    expect(main.play.benchmark.map((sample) => sample.label)).toEqual(FEATURE_TEST_BENCHMARK_PROFILES.map((profile) => profile.label));
    expect(editor.commands.slice(0, 2)).toEqual(["framecap", "framecap 240"]);
    // Play is stopped next: a view about to be torn down is not asked to prepare the session's own tier again.
    expect(editor.commands.slice(-2)).toEqual(["quality ultra", "framecap 30"]);
    expect(editor.commands).not.toContain("quality reset");
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
    // warm-up, so the warm-up runs at the baselines' settings. The session ends on the last baseline: nothing follows
    // its sample but the cap.
    expect(commands.slice(0, 5)).toEqual(["framecap", "framecap 60", "quality medium", "quality resolution reset", "gpubusy on"]);
    expect(commands.slice(-3)).toEqual(["gpubusy on", "gpubusy off", "framecap 30"]);
  });

  it("measures each part of water off on its own from the Medium tier at half resolution, in FT_World unless every scene is asked for", async () => {
    expect(featureTestBreakdownScenes("water", false).map((entry) => entry.name)).toEqual(["FT_World"]);
    expect(featureTestBreakdownScenes("remove-one", false).map((entry) => entry.name)).toEqual(["FT_World", "FT_Occlusion"]);
    const editor = fakeEditor({});
    const report = await runFeatureTestCheck({
      mode: "breakdown", scenes: [scene("FT_World")], deps: editor.deps, signal: new AbortController().signal,
      breakdown: { ...REMOVE_ONE, method: "water" },
    });
    const measured = report.scenes[0]!.play.benchmark.filter((sample) => !sample.warmup && !sample.baseline).map((sample) => sample.label);
    expect(measured).toEqual([
      "water off", "water pre-pass off", "water lighting off", "water shadows off", "water waves off", "water foam off",
      "water reflections sky", "water refraction off", "water detail low", "water fft 1 cascade", "water fft 128", "water mesh 0.75",
    ]);
    // A part switched off is switched back on after the tier returns, before the next baseline: `quality reset` keeps it.
    const commands = editor.commands, at = (line: string) => commands.indexOf(line);
    const tier = ["quality reset", "quality medium", "quality resolution scale 0.5"];
    expect(commands.slice(at("waterdebug water off") + 1, at("waterdebug prepass off")))
      .toEqual(["gpubusy on", ...tier, "waterdebug water on", "gpubusy on", ...tier]);
    expect(commands.filter((line) => line.startsWith("waterdebug")).length).toBe(12);
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
    expect(commands.filter((line) => line.startsWith("possess"))).toEqual(['possess "Rooms Camera"']);
    // The session ends in the rooms, on the base: Play is stopped next, so neither camera nor quality is put back.
    expect(commands.slice(-3)).toEqual(["gpubusy on", "gpubusy off", "framecap 30"]);
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

  it("measures add-one by default: each feature on top of the light base, undone by the base, which the session ends on", async () => {
    const editor = fakeEditor({});
    const report = await runFeatureTestCheck({
      mode: "breakdown", scenes: [scene("FT_World")], deps: editor.deps, signal: new AbortController().signal,
    });
    const measured = report.scenes[0]!.play.benchmark.filter((sample) => !sample.warmup);
    expect(measured.filter((sample) => !sample.baseline).map((sample) => sample.label)).toEqual([
      "MSAA 2x", "MSAA 4x", "AA fxaa", "shadow filter high", "post-processing", "AO", "SSR", "water detail medium", "water detail high",
      "water refraction", "screen-space water reflection", "planar water reflection", "captures", "resolution 1.0",
    ]);
    const base = FEATURE_TEST_BREAKDOWN_BASES["add-one"].commands;
    const commands = editor.commands;
    const at = (line: string) => commands.indexOf(line);
    // The base before the warm-up; after each step `quality reset` and the base again, which turns its toggles back off.
    expect(commands.slice(0, 2 + base.length)).toEqual(["framecap", "framecap 60", ...base]);
    expect(commands.slice(at("quality postprocessing ambientOcclusion on") + 1, at("quality postprocessing reflections on") - 1))
      .toEqual(["gpubusy on", "quality reset", ...base, "gpubusy on", "quality reset", ...base]);
    // Medium's values: water refraction at Medium's copy scale, its screen-space march's steps, planar reflection at
    // Medium's planar scale.
    expect(commands).toContain("quality water refractionScale 0.5");
    expect(commands).toContain("quality water reflectionSteps 8");
    expect(commands).toContain("quality water planarScale 0.5");
    // The base's toggles stay off: the session ends with the last baseline.
    expect(commands.slice(-3)).toEqual(["gpubusy on", "gpubusy off", "framecap 30"]);
    expect(commands.lastIndexOf("postprocessing off")).toBeGreaterThan(commands.lastIndexOf("postprocessing on"));
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
      ["water detail medium", "already water.shadingDetail medium, water.fft 64x3"],
      ["volumetrics off", "already post.volumetricLighting false"],
      ["MSAA 2x", "already post.antiAliasing msaa2, post.samples 2"],
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

  it("changes nothing after a skipped last step: its baseline is not measured, and Play is stopped next", async () => {
    const editor = fakeEditor({});
    // A fingerprint that never changes: every step already holds its value.
    const settings = { "geometry.occlusion": "on" };
    const deps: FeatureTestCheckDeps = {
      ...editor.deps,
      play: () => {
        const play = editor.deps.play();
        return play && { ...play, snapshot: () => ({
          ...play.snapshot(),
          rendering: { cpuMs: 4, gpuMs: null, width: 100, height: 100, scalingLevel: 1, settings } as unknown as RenderDiagnostics,
        }) };
      },
    };
    const report = await runFeatureTestCheck({
      mode: "breakdown", scenes: [scene("FT_Occlusion")], deps, signal: new AbortController().signal,
    });
    const measured = report.scenes[0]!.play.benchmark.filter((sample) => !sample.warmup);
    expect(measured.map((sample) => [sample.label, sample.skipped !== undefined])).toEqual([
      ["baseline 1", false], ["occlusion on", true], ["rooms baseline 1", false], ["rooms occlusion on", true],
    ]);
    // The first skipped step is undone for the rooms' baseline; the last is followed by nothing but the cap.
    expect(editor.commands.filter((line) => line === "quality reset")).toHaveLength(3);
    expect(editor.commands.slice(-3)).toEqual(["quality geometry occlusion on", "gpubusy off", "framecap 30"]);
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
          return { frames: 60, durationMs, fps: 60_000 / durationMs, medianMs: durationMs / 60, meanMs: durationMs / 60, vsync: [1, 0, 0, 0], p95Ms: 17, maxMs: 20, stalls: 0 };
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

  it("changes nothing more once the sweep stops at a step", async () => {
    const controller = new AbortController();
    const editor = fakeEditor({}, undefined, (_now, commands) => commands.includes("rendertargets off")
      ? { drawn: 0, held: commands.length }
      : { drawn: commands.length * 10 + _now, held: 0 });
    await runFeatureTestCheck({
      mode: "breakdown", scenes: [scene("FT_World")], deps: editor.deps, signal: controller.signal, breakdown: REMOVE_ONE,
    });
    // `captures off` never draws steadily: the sweep stops there, and Play is stopped with the step as it is.
    expect(editor.commands).not.toContain("quality resolution scale 0.5");
    expect(editor.commands.slice(-4)).toEqual(["rendertargets off", "gpubusy on", "gpubusy off", "framecap 30"]);
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
    // Nothing more piles onto a view that stopped drawing, the session's own tier included.
    expect(benchmark.at(-1)!.label).toBe("high");
    expect(editor.commands).not.toContain("quality ultra");
    expect(editor.commands.slice(-2)).toEqual(["quality high", "framecap 30"]);
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

  it("bounds a Profile's wait for quiet shaders at 20 s, where a Breakdown waits 90 s", async () => {
    // Compiling from the first command on: the last row's settle runs to its bound.
    const last = async (mode: "profile" | "breakdown") => {
      const report = await runFeatureTestCheck({
        mode, scenes: mode === "profile" ? FEATURE_TEST_PROFILE_SCENES : [scene("FT_World")], deps: compilingFor(Number.POSITIVE_INFINITY).deps,
        signal: new AbortController().signal,
      });
      const row = report.scenes[0]!.play.benchmark.at(-1)!;
      return { failed: row.failed, settleMs: row.unsettled!.settleMs };
    };
    expect(await last("profile")).toEqual({
      failed: ["Shaders were still first drawn or compiling after 20 s; this step's frames include them."], settleMs: 20_000,
    });
    expect(await last("breakdown")).toEqual({
      failed: ["Shaders were still first drawn or compiling after 90 s; this step's frames include them."], settleMs: 90_000,
    });
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

  /** A game view whose frames cost 40 ms on the CPU, 12 of them while its draws are stubbed; `supported`: whether they can be. */
  const stubbable = (deps: FeatureTestCheckDeps, supported: boolean, onStub?: (on: boolean) => void) => {
    const calls: boolean[] = [];
    // The frame in progress when the draws are stubbed still drew: only a later one costs less.
    let stubbedAt: number | null = null;
    const wrapped: FeatureTestCheckDeps = {
      ...alternating(deps),
      play: () => {
        const play = deps.play();
        return play && {
          ...play,
          snapshot: () => ({
            ...play.snapshot(),
            rendering: { cpuMs: stubbedAt !== null && deps.now() > stubbedAt ? 12 : 40, gpuMs: null } as RenderDiagnostics,
          }),
          stubWebGlDraws: (on: boolean) => {
            calls.push(on);
            onStub?.(on);
            if (supported) stubbedAt = on ? deps.now() : null;
            return supported;
          },
        };
      },
    };
    return { deps: wrapped, calls };
  };

  it("measures a frame's CPU time without its draws right after the normal sample, and lets the view draw again", async () => {
    const editor = stubbable(fakeEditor({}).deps, true);
    const report = await runFeatureTestCheck({ mode: "quick", scenes: [scene("FT_World")], deps: editor.deps, signal: new AbortController().signal });
    const counters = report.scenes[0].play.counters!;
    expect(counters.cpuMs).toMatchObject({ median: 40, min: 40, max: 40 });
    // Four reads half a second apart, every one of a stubbed frame.
    expect(counters.cpuMsWithoutDraws).toEqual({ median: 12, min: 12, max: 12, samples: 4 });
    expect(editor.calls).toEqual([true, false]);
  });

  it("has no CPU time without draws where the view cannot stub them", async () => {
    const editor = stubbable(fakeEditor({}).deps, false);
    const report = await runFeatureTestCheck({ mode: "quick", scenes: [scene("FT_World")], deps: editor.deps, signal: new AbortController().signal });
    expect(report.scenes[0].play.counters!.cpuMsWithoutDraws).toBeNull();
    // Asked once; nothing to undo.
    expect(editor.calls).toEqual([true]);
  });

  it("lets the view draw again when the Check is cancelled while its draws are stubbed", async () => {
    const cancel = new AbortController();
    const editor = stubbable(fakeEditor({}).deps, true, (on) => { if (on) cancel.abort(); });
    await runFeatureTestCheck({ mode: "quick", scenes: [scene("FT_World")], deps: editor.deps, signal: cancel.signal }).catch(() => null);
    expect(editor.calls).toEqual([true, false]);
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

  it("gives Play and each benchmark profile the draws of each pass and the Engine's programs as it ended", async () => {
    const editor = fakeEditor({}, undefined, (now, commands) => ({ drawn: commands.length * 10 + now, held: 0 }));
    let reads = 0;
    const deps: FeatureTestCheckDeps = {
      ...editor.deps,
      play: () => {
        const play = editor.deps.play();
        return play && {
          ...play,
          snapshot: () => {
            const snapshot = play.snapshot();
            // The Engine compiles a program between any two reads.
            reads += 1;
            const rendering = {
              cpuMs: 4, gpuMs: null, ...snapshot.rendering,
              drawPasses: { objects: 124, outlines: 101, layers: 98 },
              programs: { programs: 200 + reads, neverDrawn: 80, passes: { objects: 60 }, shaders: 90, mostVariants: 4, splitBy: [] as { define: string; with: string[]; shaders: number }[] },
            } as NonNullable<typeof snapshot.rendering>;
            return { ...snapshot, rendering };
          },
        };
      },
    };
    const report = await runFeatureTestCheck({
      mode: "benchmark", scenes: [scene("FT_World")], deps, signal: new AbortController().signal,
    });
    const play = report.scenes[0].play;
    expect(play.counters!.drawPasses).toEqual({ objects: 124, outlines: 101, layers: 98 });
    expect(play.benchmark.map((sample) => sample.label)).toEqual(["low", "medium", "high", "ultra"]);
    for (const sample of play.benchmark) {
      expect(sample.drawPasses).toEqual({ objects: 124, outlines: 101, layers: 98 });
      expect(sample.programs).toMatchObject({ neverDrawn: 80, passes: { objects: 60 } });
    }
    // Each profile's inventory is read as its sample ends: a later profile's holds what the earlier ones compiled.
    const counts = play.benchmark.map((sample) => sample.programs!.programs);
    for (let index = 1; index < counts.length; index += 1) expect(counts[index]).toBeGreaterThan(counts[index - 1]!);
  });

  it("gives Play and each benchmark profile each pass's median CPU time over the reads that were timed", async () => {
    const editor = fakeEditor({}, undefined, (now, commands) => ({ drawn: commands.length * 10 + now, held: 0 }));
    const ms = (objects: number, mirrors: number) => ({ objects, mirrors, shadows: 0 });
    // Each window's reads, every half second: two before the view's first timed frame (all zero), then three timed frames.
    const window = [ms(0, 0), ms(0, 0), ms(5, 9), ms(4, 7), ms(40, 70)];
    let read = 0;
    const deps: FeatureTestCheckDeps = {
      ...editor.deps,
      play: () => {
        const play = editor.deps.play();
        return play && {
          ...play,
          snapshot: () => {
            const snapshot = play.snapshot();
            const drawPassMs = window[Math.min(read++, window.length - 1)]!;
            return { ...snapshot, rendering: { cpuMs: 4, gpuMs: null, ...snapshot.rendering, drawPassMs } as NonNullable<typeof snapshot.rendering> };
          },
        };
      },
      sampleFrames: async (durationMs, signal) => {
        read = 0;
        const frames = await editor.deps.sampleFrames(durationMs, signal);
        for (let tick = 0; tick < 4; tick += 1) await editor.deps.sleep(500, signal);
        return frames;
      },
    };
    const report = await runFeatureTestCheck({
      mode: "benchmark", scenes: [scene("FT_World")], deps, signal: new AbortController().signal,
    });
    const play = report.scenes[0].play;
    // The median of the timed reads (5, 4, 40 and 9, 7, 70), not of every read.
    expect(play.counters!.drawPassMs).toEqual(ms(5, 9));
    expect(play.benchmark).toHaveLength(4);
    for (const sample of play.benchmark) expect(sample.drawPassMs).toEqual(ms(5, 9));
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
    frames: meanMs === undefined ? null : { frames: 100, durationMs: meanMs * 100, fps: 1000 / meanMs, medianMs: 33.3, meanMs, vsync: [0, 1, 0, 0], p95Ms: 46, maxMs: 50, stalls: 0 },
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
});

describe("breakdown verdicts", () => {
  const sample = (label: string, busyMs: number, extra: Partial<FeatureTestBenchmarkSample> = {}): FeatureTestBenchmarkSample => ({
    label, baseline: label.includes("baseline"),
    frames: { frames: 100, durationMs: 3330, fps: 30, medianMs: 33.3, meanMs: 33.3, p95Ms: 34, maxMs: 40, stalls: 0, vsync: [0, 1, 0, 0] },
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
      sample("baseline 1", 10), sample("occlusion off", 11), sample("baseline 2", 10),
      rooms(sample("rooms baseline 1", 4)), rooms(sample("rooms occlusion off", 3)), rooms(sample("rooms baseline 2", 4)),
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
      sample("baseline 3", 0, { gpuBusy: undefined, frames: { frames: 100, durationMs: 3500, fps: 28, medianMs: 35, meanMs: 35, vsync: [0, 1, 0, 0], p95Ms: 40, maxMs: 50, stalls: 0 } }),
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
      sample(label, 20, { frames: { frames, durationMs: frames * 70, fps: 14, medianMs: 70, meanMs: 70, p95Ms: 80, maxMs: 90, stalls: 0, vsync: [0, 0, 1 - fourPlus, fourPlus] } });
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
    const expectedSkips = { "remove-one": ["shadows medium", "water detail medium", "volumetrics off", "MSAA 2x"], "add-one": [] as string[], water: [] as string[],
      // Medium draws neither screen-space nor reflection shadows.
      shadows: ["screen-space shadows off", "reflection shadows off"],
    };
    for (const method of FEATURE_TEST_BREAKDOWN_METHODS) {
      const base = FEATURE_TEST_BREAKDOWN_BASES[method].commands;
      const reference = fingerprintAfter(base);
      const skipped: string[] = [];
      for (const step of featureTestBreakdownPlan("FT_World", method).views[0]!.steps) {
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

describe("Profile", () => {
  const SESSION: FeatureTestProfileState = { postProcessing: true, captures: true, discard: false, layers: true, framesInFlight: 2, frameCap: 60 };

  it("measures each step at fixed camera views between two baselines of that view, revisits the control view, and keeps to today's length", () => {
    expect(FEATURE_TEST_PROFILE_SCENES).toEqual([{ name: "main", path: "assets/main.scene.hasset" }]);
    const plan = featureTestProfilePlan(SESSION);
    expect(plan.views.map((view) => [view.name, view.enter, view.steps.map((step) => step.label)])).toEqual([
      ["light", ['possess "Profile Light Camera"'], ["MSAA off", "discard samples", "scene layers hidden", "FSR to view size", "layer clears off", "held image off", "backbuffer depth discarded"]],
      ["heavy", ['possess "Profile Heavy Camera"'], [
        "shadows off", "shadow casters off", "shadow passes off", "shadow vertex clamp", "far cascades alternate", "shadows medium", "shadows medium big atlas", "shadow filter low",
        "geometry effects off", "post off", "resolution 1.0",
      ]],
      ["mirror", ['possess "Profile Mirror Camera"'], ["mirrors environment", "captures off"]],
    ]);
    const step = (view: string, label: string) => plan.views.find((entry) => entry.name === view)!.steps.find((entry) => entry.label === label)!;
    // The same Medium shadows in an atlas one size larger: its change beyond `shadows medium` is the atlas's size.
    expect(step("heavy", "shadows medium big atlas")).toMatchObject({
      commands: ["quality shadows medium", "shadowdebug atlasfit off"], restore: ["shadowdebug atlasfit on"], includes: "shadows medium", overlaps: true,
    });
    expect(step("heavy", "shadow filter low")).toMatchObject({ commands: ["quality shadows filter low"], fields: ["shadows.filter"] });
    expect(step("light", "discard samples")).toMatchObject({ commands: ["discardsamples on"], restore: ["discardsamples off"], fields: ["msaa.discard"] });
    expect(step("light", "scene layers hidden")).toMatchObject({ commands: ["scenelayers off"], restore: ["scenelayers on"], fields: ["layers"] });
    expect(step("light", "FSR to view size")).toMatchObject({ commands: ["fsrdebug output view"], restore: ["fsrdebug output device"], fields: ["upscale.output"] });
    // Maps not redrawn against casters not drawn, against shadows off: redrawing, drawing casters and sampling apart.
    expect([step("heavy", "shadow casters off"), step("heavy", "shadow passes off")].map((entry) => [entry.commands, entry.restore])).toEqual([
      [["shadowdebug casters off"], ["shadowdebug casters on"]], [["shadowdebug passes off"], ["shadowdebug passes on"]],
    ]);
    // Toggles come back to the session's own value.
    const other = featureTestProfilePlan({ postProcessing: false, captures: false, discard: true, layers: false, framesInFlight: 3, frameCap: 30 });
    expect(other.views.flatMap((view) => view.steps).filter((entry) => entry.restore && !/^((shadow|fsr|layer)debug|heldimage|backbufferdiscard)/.test(entry.restore[0]!))
      .map((entry) => entry.restore)).toEqual([["discardsamples on"], ["scenelayers off"], ["postprocessing off"], ["rendertargets off"]]);
    const sequence = featureTestProfileSequence(SESSION);
    const probe = featureTestProfileStateSequence(SESSION);
    expect(sequence.slice(0, probe.length)).toEqual(probe);
    expect(sequence.slice(probe.length, probe.length + 8).map((entry) => entry.label)).toEqual([
      "light baseline 1", "light MSAA off", "light baseline 2", "light discard samples", "light baseline 3", "light scene layers hidden",
      "light baseline 4", "heavy baseline 1",
    ]);
    // Only a view's first baseline moves the camera; every step sits between two baselines of its own view.
    expect(sequence.filter((entry) => entry.commands.some((line) => line.startsWith("possess"))).map((entry) => entry.label))
      .toEqual(["state hold 1", "light baseline 1", "heavy baseline 1", "mirror baseline 1", "heavy drift"]);
    sequence.forEach((entry, index) => {
      if (entry.baseline || entry.action) return;
      expect([sequence[index - 1], sequence[index + 1]], entry.label).toMatchObject([{ baseline: true, view: entry.view }, { baseline: true, view: entry.view }]);
    });
    // Then the control view once more, unchanged, so the drift line spans the run.
    expect(sequence.at(-1)).toEqual({ label: "heavy drift", commands: ['possess "Profile Heavy Camera"'], baseline: true, view: "heavy" });
    // Two warm-up windows, the hold's back to back 5 s windows and every other row at about 10 s: within ten minutes.
    const rows = sequence.filter((entry) => !entry.action);
    expect(PROFILE_WARMUP_WINDOWS * 10 + PROFILE_HOLD_WINDOWS * 5 + (rows.length - PROFILE_HOLD_WINDOWS) * 10).toBeLessThanOrEqual(600);
    expect(profileStep("heavy shadows off")).toMatchObject({ view: "heavy", fields: ["shadows", "shadows.filter"] });
    expect(profileStep("heavy baseline 2")).toBeUndefined();
  });

  it("reads the session's state from a baseline's fingerprint, with Play's defaults for what it lacks", () => {
    expect(profileState({ "post.enabled": "false", captures: "suspended", "msaa.discard": "on", layers: "hidden", "presentation.framesInFlight": "off" }, 30))
      .toEqual({ postProcessing: false, captures: false, discard: true, layers: false, framesInFlight: "off", frameCap: 30 });
    expect(profileState(undefined)).toEqual(SESSION);
  });

  it("probes the frame state first: a minute held unchanged, reset actions each followed by two baselines, then frames in flight and a 30 fps cap between baselines", () => {
    const probe = featureTestProfileStateSequence({ ...SESSION, framesInFlight: 3, frameCap: 50 });
    expect(probe.every((entry) => entry.view === "heavy")).toBe(true);
    expect(probe.slice(0, PROFILE_HOLD_WINDOWS).map((entry) => [entry.label, entry.hold, entry.baseline]))
      .toEqual(Array.from({ length: 12 }, (_, index) => [`state hold ${index + 1}`, true, true]));
    expect(probe[0]!.commands).toEqual(['possess "Profile Heavy Camera"']);
    expect(probe.slice(PROFILE_HOLD_WINDOWS).map((entry) => [entry.label, entry.action ? entry.commands : entry.baseline ? "baseline" : [...entry.commands, "|", ...entry.restore ?? []]])).toEqual([
      ["state graph rebuilt", ["renderreset graph"]], ["state after graph rebuilt 1", "baseline"], ["state after graph rebuilt 2", "baseline"],
      ["state shadow maps reallocated", ["renderreset shadows"]], ["state after shadow maps reallocated 1", "baseline"], ["state after shadow maps reallocated 2", "baseline"],
      ["state backbuffer resized", ["scenelayers off"]], ["state backbuffer resized back", ["scenelayers on"]],
      ["state after backbuffer resized back 1", "baseline"], ["state after backbuffer resized back 2", "baseline"],
      ["state 3 s idle", ["renderreset idle"]], ["state after 3 s idle 1", "baseline"], ["state after 3 s idle 2", "baseline"],
      ["state frames in flight off", ["framesinflight off", "|", "framesinflight 3"]], ["state baseline 1", "baseline"],
      ["state frames in flight 3", ["framesinflight 3", "|", "framesinflight 3"]], ["state baseline 2", "baseline"],
      ["state frame cap 30", ["framecap 30", "|", "framecap 50"]], ["state baseline 3", "baseline"],
    ]);
    // A session without Scene Layers resizes the other way.
    expect(featureTestProfileStateSequence({ ...SESSION, layers: false }).filter((entry) => entry.action && entry.commands[0]!.startsWith("scenelayers"))
      .map((entry) => entry.commands)).toEqual([["scenelayers on"], ["scenelayers off"]]);
  });

  it("holds Dynamic Resolution's floor where it is on, else the session's scale", () => {
    expect(profileResolutionPin({ "resolution.scale": "1", "resolution.dynamic": "on 0.75" })).toEqual({ scale: 0.75, floor: true });
    expect(profileResolutionPin({ "resolution.scale": "0.85", "resolution.dynamic": "off" })).toEqual({ scale: 0.85, floor: false });
    expect(profileResolutionPin(undefined)).toEqual({ scale: 1, floor: false });
  });

  it("changes, with every step at every tier, only its own fields, or nothing where the tier already holds its value", () => {
    // Low already has the low shadow filter and no geometry effects; Medium has Medium's shadows; Ultra is at full
    // resolution without Dynamic Resolution.
    const expectedSkips: Record<QualityLevel, string[]> = {
      low: ["shadow filter low", "geometry effects off"],
      medium: ["shadows medium"],
      high: [],
      ultra: ["resolution 1.0"],
    };
    for (const tier of ["low", "medium", "high", "ultra"] as const) {
      const project = projectAt(tier);
      // Every row holds the resolution the session started at: the base, again after every `quality reset`.
      const pin = `quality resolution scale ${profileResolutionPin(fingerprintAfter([], { project })).scale}`;
      const reference = fingerprintAfter([pin], { project });
      const skipped: string[] = [];
      const state = profileState(reference);
      const steps = [...new Map([
        ...featureTestProfilePlan(state).views.flatMap((view) => view.steps),
        ...featureTestProfileStateSequence(state).filter((step) => !step.baseline && !step.action),
      ].map((step) => [step.label, step])).values()];
      for (const step of steps) {
        const after = fingerprintAfter([pin, ...step.commands], { project });
        const changed = settingsChanges(reference, after).map((change) => change.slice(0, change.indexOf("=")));
        expect(changed.filter((field) => !(step.fields ?? []).includes(field)), `${tier} ${step.label}`).toEqual([]);
        if (breakdownSkip(step.fields, reference, after)) skipped.push(step.label);
        // Its restore and `quality reset` give the tier back.
        expect(fingerprintAfter([pin, ...step.commands, "quality reset", pin, ...step.restore ?? []], { project }), `${tier} ${step.label}`).toEqual(reference);
      }
      expect(skipped, tier).toEqual(expectedSkips[tier]);
    }
  });

  it("compares a step with the two baselines of its view around it, in gpu busy, and marks it UNSETTLED when they differ by more than its change", () => {
    const at = (label: string, gpu: number | null, cpu: number, extra: Partial<FeatureTestBenchmarkSample> = {}): FeatureTestBenchmarkSample => ({
      label, baseline: label.includes("baseline") || label.includes("drift"), view: label.split(" ")[0], runtimeFps: null, cpuMs: cpu, gpuMs: null,
      frames: { frames: 100, durationMs: 5000, fps: 20, medianMs: 50, meanMs: 50, vsync: [0, 0, 1, 0], p95Ms: 60, maxMs: 70, stalls: 0 },
      drawCalls: 100, resolution: null, failed: [], ...(gpu === null ? {} : { gpuBusy: { medianMs: gpu, p95Ms: gpu + 5, frames: 100, pollMs: 4 } }), ...extra,
    } as FeatureTestBenchmarkSample);
    const samples = [
      { ...at("warm-up 1", 44, 11), baseline: false, warmup: true, view: "heavy", atMs: 0 },
      at("light baseline 1", 20, 6, { atMs: 10_000 }),
      // Its baselines differ by 4 ms, past its own 1 ms change.
      at("light MSAA off", 19, 6),
      at("light baseline 2", 24, 6),
      at("heavy baseline 1", 40, 10, { atMs: 40_000 }),
      // 30 against (40 + 42) / 2.
      at("heavy shadows off", 30, 9),
      at("heavy baseline 2", 42, 11, { atMs: 60_000 }),
      // No gpu busy: frame time against the frame time of the same baselines.
      at("heavy post off", null, 8, { frames: { frames: 100, durationMs: 5000, fps: 25, medianMs: 40, meanMs: 40, vsync: [0, 1, 0, 0], p95Ms: 45, maxMs: 50, stalls: 0 } }),
      at("heavy baseline 3", 41, 10, { atMs: 80_000 }),
      at("mirror baseline 1", 50, 12),
      // The sweep stopped before its next baseline.
      at("mirror captures off", 45, 12),
      at("heavy drift", 46, 12, { atMs: 120_000 }),
    ];
    const comparison = (label: string) => profileComparison(samples, samples.find((sample) => sample.label === label)!);
    expect(comparison("heavy shadows off")).toMatchObject({
      basis: "gpu", before: 40, step: 30, after: 42, change: { ms: -11 }, spread: 2, unsettled: false, cpu: { ms: -1.5 }, state: "FAST", straddles: false,
    });
    expect(comparison("light MSAA off")).toMatchObject({ before: 20, step: 19, after: 24, change: { ms: -3 }, spread: 4, unsettled: true });
    expect(comparison("heavy post off")).toMatchObject({ basis: "frame", before: 50, step: 40, after: 50, change: { ms: -10 }, unsettled: false });
    expect(comparison("mirror captures off")).toMatchObject({ before: 50, step: 45, after: null, change: { ms: -5 }, spread: null, unsettled: false });
    expect(comparison("heavy baseline 2")).toBeNull();
    // Baselines within 2% of each other agree, however small the step's change.
    const still = [at("light baseline 1", 16.7, 6), at("light discard samples", 16.6, 6), at("light baseline 2", 16.6, 6)];
    expect(profileComparison(still, still[1]!)).toMatchObject({ spread: expect.closeTo(0.1), unsettled: false });
    // A view that moves between about two display intervals and four with nothing changed: its rows are FAST within
    // 1.5x its best baseline, else SLOW, and a step whose baselines sit in different states is not ranked.
    const flips = [
      at("heavy baseline 1", 34, 12), at("heavy shadows off", 30, 11), at("heavy baseline 2", 66, 12),
      at("heavy post off", 64, 9), at("heavy baseline 3", 65, 12), at("heavy captures off", 33, 12), at("heavy baseline 4", 35, 12),
    ];
    expect(flips.map((sample) => profileFrameState(flips, sample))).toEqual(["FAST", "FAST", "SLOW", "SLOW", "SLOW", "FAST", "FAST"]);
    expect(profileComparison(flips, flips[1]!)).toMatchObject({ straddles: true, state: null });
    expect(profileComparison(flips, flips[3]!)).toMatchObject({ straddles: false, state: "SLOW", change: { ms: expect.closeTo(-1.5) } });
    expect(profileRanking(flips).map((group) => group.steps.map((entry) => entry.label))).toEqual([["heavy post off"]]);
    // Per view in the order they ran, the largest saving first.
    expect(profileRanking(samples).map((group) => [group.view, group.steps.map((entry) => entry.label)])).toEqual([
      ["light", ["light MSAA off"]], ["heavy", ["heavy shadows off", "heavy post off"]], ["mirror", ["mirror captures off"]],
    ]);
    // The control view's visits, unchanged, in run order: the warm-up, its baselines and the last visit.
    expect(profileDrift(samples)).toEqual([
      { label: "warm-up 1", atMs: 0, gpuMs: 44, cpuMs: 11 },
      { label: "heavy baseline 1", atMs: 40_000, gpuMs: 40, cpuMs: 10 },
      { label: "heavy baseline 2", atMs: 60_000, gpuMs: 42, cpuMs: 11 },
      { label: "heavy baseline 3", atMs: 80_000, gpuMs: 41, cpuMs: 10 },
      { label: "heavy drift", atMs: 120_000, gpuMs: 46, cpuMs: 12 },
    ]);
  });

  /** Play of the main scene on a project at `tier` (High), which `quality reset` returns to: its fingerprint, draws and pool as the commands left them. */
  const profileEditor = (options: { tier?: QualityLevel; refused?: string[] } = {}) => {
    const refused = options.refused ?? [];
    const editor = fakeEditor({
      "assets/main.scene.hasset": { commands: Object.fromEntries(refused.map((line) => [line, { success: false, output: "Refused" }])) },
    });
    const project = projectAt(options.tier ?? "high");
    const deps: FeatureTestCheckDeps = {
      ...editor.deps,
      play: () => {
        const play = editor.deps.play();
        return play && { ...play, snapshot: () => {
          const settings = fingerprintAfter(editor.commands.filter((line) => !refused.includes(line)), { project });
          return {
            ...play.snapshot(),
            rendering: {
              cpuMs: 30, gpuMs: null, width: 100, height: 100, scalingLevel: 1, settings,
              frameBackpressure: { mode: 2, inFlight: 0, skipped: 0 },
              drawPasses: { objects: 520, shadows: settings.shadows === "off" ? 0 : 140, captures: settings.captures === "on" ? 44 : 0, post: 12 },
              instancePool: { groups: 18, retained: 2, pooled: 410, rekeys: 0 },
              shadowAtlas: { edge: settings.shadows === "off" ? 0 : 8192, maps: settings.shadows === "off" ? [] : [{ mapSize: 2048, passes: 4 }] },
            } as unknown as RenderDiagnostics,
          };
        } };
      },
    };
    return { editor, deps };
  };

  it("plays the main scene at the session's tier and frame cap, its resolution held: two warm-up windows at the control view, then every view's steps between its baselines, each undone", async () => {
    const { editor, deps } = profileEditor({ tier: "high" });
    const windows: number[] = [];
    const report = await runFeatureTestCheck({
      mode: "profile", scenes: FEATURE_TEST_PROFILE_SCENES, signal: new AbortController().signal,
      deps: { ...deps, sampleFrames: (ms, signal) => { windows.push(ms); return deps.sampleFrames(ms, signal); } },
    });
    const [main] = report.scenes;
    expect(main!.passed).toBe(true);
    const samples = main!.play.benchmark;
    // The warm-up windows are the control view's first visits.
    expect(samples.slice(0, 2).map((sample) => [sample.label, sample.warmup, sample.view])).toEqual([["warm-up 1", true, "heavy"], ["warm-up 2", true, "heavy"]]);
    // The editor viewport's 3 s, Play's 5 s, two 5 s warm-up windows, then 5 s per row.
    expect(windows.slice(0, 4)).toEqual([3_000, 5_000, 5_000, 5_000]);
    expect(windows.slice(4).every((ms) => ms === 5_000)).toBe(true);
    // At High nothing is skipped; each row keeps its view and when it began.
    const rows = samples.slice(2);
    // Reset actions are run, not sampled.
    expect(rows.map((sample) => [sample.label, sample.view])).toEqual(featureTestProfileSequence(SESSION).filter((step) => !step.action).map((step) => [step.label, step.view]));
    expect(rows.filter((sample) => sample.skipped)).toEqual([]);
    expect(samples.every((sample, index) => index === 0 || sample.atMs! > samples[index - 1]!.atMs!)).toBe(true);
    // Every row's window is recorded by the GPU probes, which come off before its restore. This Engine reports none, so
    // no serial probe is asked for.
    expect(editor.commands.filter((line) => line.startsWith("gpuprobe"))).toEqual(samples.flatMap(() => ["gpuprobe on", "gpuprobe off"]));
    expect(editor.commands.slice(editor.commands.indexOf("discardsamples on"), editor.commands.indexOf("discardsamples on") + 5))
      .toEqual(["discardsamples on", "gpuprobe on", "gpubusy on", "gpuprobe off", "quality reset"]);
    const commands = editor.commands.filter((line) => !line.startsWith("gpuprobe"));
    const at = (line: string) => commands.indexOf(line);
    // No tier and no frame cap: the session's own. High's Dynamic Resolution held at its floor, then the camera at the
    // control view, before the warm-up.
    // The cap is only read, and changed by the state probe's own step, which puts it back.
    expect(commands.filter((line) => line.startsWith("framecap") || /^quality (low|medium|high|ultra)$/.test(line))).toEqual(["framecap", "framecap 30", "framecap 30"]);
    expect(commands.slice(0, 5)).toEqual(["framecap", "quality resolution scale 0.75", 'possess "Profile Heavy Camera"', "gpubusy on", "gpubusy on"]);
    // The hold: twelve windows back to back, with no restore between them.
    expect(commands.slice(at("gpubusy on") + 2, at("gpubusy on") + 2 + 13)).toEqual(['possess "Profile Heavy Camera"', ...Array(12).fill("gpubusy on")]);
    // A reset action, then its baselines; the 30 fps cap back to the session's own (the fake's 30).
    expect(commands.slice(at("renderreset graph"), at("renderreset graph") + 2)).toEqual(["renderreset graph", "gpubusy on"]);
    expect(commands.slice(at("framecap 30"), at("framecap 30") + 5)).toEqual(["framecap 30", "gpubusy on", "quality reset", "quality resolution scale 0.75", "framecap 30"]);
    expect(samples.every((sample) => sample.settings!["resolution.scale"] === "0.75" || sample.label === "heavy resolution 1.0")).toBe(true);
    // Each step's commands, its sample, then `quality reset`, the held resolution and its own restore before the next baseline.
    expect(commands.slice(at("discardsamples on"), at("discardsamples off") + 1))
      .toEqual(["discardsamples on", "gpubusy on", "quality reset", "quality resolution scale 0.75", "discardsamples off"]);
    expect(commands.slice(at("shadowdebug atlasfit off") - 1, at("shadowdebug atlasfit on") + 1))
      .toEqual(["quality shadows medium", "shadowdebug atlasfit off", "gpubusy on", "quality reset", "quality resolution scale 0.75", "shadowdebug atlasfit on"]);
    expect(commands.filter((line) => line === "gpubusy on")).toHaveLength(samples.length);
    // Back to the session's quality, its Dynamic Resolution included, and the tour camera.
    expect(commands.slice(-3)).toEqual(["gpubusy off", "quality reset", 'possess "Main Camera"']);
    // Each row's draws per pass and shadow atlas, as the step left them.
    const row = (label: string) => rows.find((sample) => sample.label === label)!;
    expect(row("heavy shadows off").drawPasses).toEqual({ objects: 520, shadows: 0, captures: 44, post: 12 });
    expect(row("heavy shadows off").shadowAtlas).toEqual({ edge: 0, maps: [] });
    expect(row("mirror captures off").drawPasses).toEqual({ objects: 520, shadows: 140, captures: 0, post: 12 });
    expect(main!.play.profile).toEqual({
      instancePool: { groups: 18, retained: 2, pooled: 410, rekeys: 0 },
      endChanges: [],
      // This view reports no presentation counts.
      holdRate: null,
      resolution: { scale: 0.75, floor: true, levelBefore: 1 },
      frameCap: 30,
    });
  });

  /** Every fourth attempt held, as a scene that steadily holds frames does. */
  const ONE_IN_FOUR = (attempt: number) => attempt % 4 === 3;
  /** Whether the commands so far leave `shadows off` applied (`quality reset` undoes it). */
  const shadowsOff = (commands: readonly string[]) =>
    commands.lastIndexOf("quality shadows enabled off") > commands.lastIndexOf("quality reset");

  /**
   * A Play view that tries 40 frames a second and holds those `holds` names after the commands so far; each frame
   * sample takes its window on the check's clock. `waits` records, for each frame sample, the progress step it belongs
   * to and how long the check took from that step to the sample. Commands answer at once (`commandMs: 0` keeps their
   * reply allowance off the clock).
   */
  const holdingView = (holds: (attempt: number, commands: readonly string[]) => boolean = ONE_IN_FOUR) => {
    let attempts = 0;
    const counts = { drawn: 0, held: 0 };
    const editor = fakeEditor({}, undefined, (now, commands) => {
      for (; attempts < Math.floor(now / 25); attempts++) {
        if (holds(attempts, commands)) counts.held++;
        else counts.drawn++;
      }
      return { ...counts, heldReasons: { "Scene is not ready to render.": counts.held } };
    });
    let step = "";
    let stepAt = 0;
    const waits: { step: string; ms: number }[] = [];
    const deps: FeatureTestCheckDeps = {
      ...editor.deps,
      onProgress: (message) => { step = message; stepAt = editor.deps.now(); },
      sampleFrames: async (ms, signal) => {
        waits.push({ step, ms: editor.deps.now() - stepAt });
        const stats = await editor.deps.sampleFrames(ms, signal);
        await editor.deps.sleep(ms, signal);
        return stats;
      },
    };
    return { editor, deps, waits, timeouts: { commandMs: 0 } };
  };


  it("probes every Profile row's GPU work: the window's counters on each, and serialised frames after each but the warm-up and the hold windows before the last", async () => {
    const { editor, deps } = profileEditor({ tier: "high" });
    // An Engine with GPU probes: each `gpuprobe serial` reports a new result, except the one after `silent`.
    const silent = "heavy post off";
    let asked = 0;
    let answered = 0;
    let silentRow = false;
    const probing: FeatureTestCheckDeps = {
      ...deps,
      onProgress: (text) => { silentRow = text.endsWith(`measuring ${silent}`); },
      play: () => {
        const play = deps.play();
        return play && { ...play, snapshot: () => {
          const requests = editor.commands.filter((line) => line === "gpuprobe serial").length;
          if (requests > asked) {
            asked = requests;
            if (!silentRow) answered = requests;
          }
          const snapshot = play.snapshot();
          return { ...snapshot, rendering: { ...snapshot.rendering, gpuProbe: {
            recording: true,
            signature: { frames: 150, modal: "a1b2c3d4", modalShare: 1, distinct: 1, passes: 14, clears: 9, blits: 2, invalidates: 0, draws: 700, texelsCleared: 5e7, texelsCovered: 6e7, structures: [] },
            shadows: { frames: 150, maps: 5, redrawn: 2, cached: 3, continuous: 2, tiles: 5, texels: 2e7, atlasEdge: 8192, generationFirst: 1, generationLast: 1 },
            raf: { callbacks: 300, ms: 5000, perSecond: 60 },
            serial: answered > 0 ? { id: answered, frames: 8, frameMs: 21, coldMs: 30, cpuMs: 8, stages: [], syntheticMs: 2, syntheticColdMs: 3, hashes: [], splits: 0, failed: null, ms: 400 } : null,
            serialRunning: false,
          } } as unknown as RenderDiagnostics };
        } };
      },
    };
    const report = await runFeatureTestCheck({ mode: "profile", scenes: FEATURE_TEST_PROFILE_SCENES, signal: new AbortController().signal, deps: probing });
    const samples = report.scenes[0]!.play.benchmark;
    // Every row carries the window's probes.
    expect(samples.every((sample) => sample.gpuProbe?.signature?.modal === "a1b2c3d4" && sample.gpuProbe.shadows?.atlasEdge === 8192 && sample.gpuProbe.raf?.perSecond === 60)).toBe(true);
    // Serialised frames follow every row but the warm-up windows and hold windows 1 to 11, which run back to back.
    const unprobed = samples.filter((sample) => !sample.gpuProbe?.serial).map((sample) => sample.label);
    expect(unprobed).toEqual(["warm-up 1", "warm-up 2", ...Array.from({ length: 11 }, (_, index) => `state hold ${index + 1}`), silent]);
    expect(editor.commands.filter((line) => line === "gpuprobe serial")).toHaveLength(samples.length - 13);
    // Each result is its own row's: the id it was given grows row by row.
    const ids = samples.flatMap((sample) => sample.gpuProbe?.serial ? [sample.gpuProbe.serial.id] : []);
    expect(ids.every((id, index) => index === 0 || id > ids[index - 1]!)).toBe(true);
    // The serial probe runs after the window and before the recorder comes off and the row is restored.
    const post = editor.commands.indexOf("postprocessing off");
    expect(editor.commands.slice(post, post + 6)).toEqual(["postprocessing off", "gpuprobe on", "gpubusy on", "gpuprobe serial", "gpuprobe off", "quality reset"]);
    // A probe that never reports is said so on its row, and the Profile goes on.
    expect(samples.find((sample) => sample.label === silent)!.failed).toEqual(["The serial GPU probe did not report within 6 s."]);
    expect(samples.at(-1)!.label).toBe("heavy drift");
  });
  it("completes every step on a view that steadily holds a frame in four, waiting against the rate its two warm-up windows measured", async () => {
    const { deps, waits, timeouts } = holdingView();
    const report = await runFeatureTestCheck({ mode: "profile", scenes: FEATURE_TEST_PROFILE_SCENES, deps, timeouts, signal: new AbortController().signal });
    const [main] = report.scenes;
    expect(main!.problems).toEqual([]);
    const samples = main!.play.benchmark;
    expect(samples.slice(0, 2).map((sample) => sample.label)).toEqual(["warm-up 1", "warm-up 2"]);
    expect(samples.slice(2).map((sample) => sample.label)).toEqual(featureTestProfileSequence(SESSION).filter((step) => !step.action).map((step) => step.label));
    // 10 of its 40 attempts a second held.
    expect(main!.play.profile!.holdRate).toEqual({ heldPerSecond: 10, share: 0.25 });
    // Every window and row keeps the frames it drew and held while sampled, and why it held them.
    expect(samples.map((sample) => sample.presentation!.held / (sample.presentation!.drawn + sample.presentation!.held)))
      .toEqual(samples.map(() => 0.25));
    expect(samples.every((sample) => sample.presentation!.heldReasons["Scene is not ready to render."] === sample.presentation!.held)).toBe(true);
    // From each step to its sample: the first window waits 10 s with no rate yet, then 3 s of quiet shaders; every
    // later one a 2 s window within 25% + 15 points, then the 3 s.
    const profileWaits = waits.filter((wait) => /: (warming up|measuring (?!Play|the editor))/.test(wait.step));
    // The hold's windows follow each other with no wait.
    expect(profileWaits.map((wait) => wait.ms)).toEqual([13_000, ...samples.slice(1).map((sample) => /^state hold/.test(sample.label) ? 0 : 5_000)]);
  });

  it("records the world renderer's work each row did while sampled, and the native memory as it ended", async () => {
    // Two strict readiness checks and one shadow admission per attempt, three times as many while shadows are off.
    let attempts = 0;
    const work = {
      graphBuilds: 0, shadowAdmissions: 0, shadowAdmissionMs: 0, strictReadinessChecks: 0, readinessProbeMs: 0, outlineReadinessChecks: 0,
      // A check that failed before the rows were sampled: none fails while they are.
      readinessProbeReasons: {}, readinessSwapRechecks: 0, failedReadinessProbes: 0, scopedReadinessProbes: 0, scopedReadinessMismatches: 0, scopedReadinessIdleRequests: 0,
      readinessBlockers: ['mesh "loading"'],
    };
    const editor = fakeEditor({}, undefined, (now, commands) => {
      for (; attempts < Math.floor(now / 25); attempts++) {
        const scale = shadowsOff(commands) ? 3 : 1;
        work.strictReadinessChecks += 2 * scale;
        work.shadowAdmissions += scale;
      }
      return { drawn: attempts, held: 0, rendererWork: { ...work } };
    });
    const MIB = 1048576;
    const deps: FeatureTestCheckDeps = {
      ...editor.deps,
      sampleFrames: async (ms, signal) => {
        const stats = await editor.deps.sampleFrames(ms, signal);
        await editor.deps.sleep(ms, signal);
        return stats;
      },
      // The device has 1 GiB free, 2 GiB while shadows are off; the app's headroom is unreported.
      hostMemory: async () => ({ deviceAvailableBytes: (shadowsOff(editor.commands) ? 2048 : 1024) * MIB, appAvailableBytes: null }),
    };
    const report = await runFeatureTestCheck({
      mode: "profile", scenes: FEATURE_TEST_PROFILE_SCENES, deps, timeouts: { commandMs: 0 }, signal: new AbortController().signal,
    });
    const row = (label: string) => report.scenes[0]!.play.benchmark.find((sample) => sample.label === label)!;
    // Each row keeps the memory as its sample ended, before the step is undone.
    expect([row("heavy baseline 1").memory, row("heavy shadows off").memory]).toEqual([
      { deviceAvailableBytes: 1024 * MIB, appAvailableBytes: null }, { deviceAvailableBytes: 2048 * MIB, appAvailableBytes: null },
    ]);
    const perDrawn = (label: string) => {
      const { work: sampled, presentation } = row(label);
      return { readiness: sampled!.strictReadinessChecks / presentation!.drawn, admissions: sampled!.shadowAdmissions / presentation!.drawn };
    };
    expect(perDrawn("heavy baseline 1")).toEqual({ readiness: 2, admissions: 1 });
    expect(perDrawn("heavy shadows off")).toEqual({ readiness: 6, admissions: 3 });
    expect(perDrawn("heavy baseline 2")).toEqual({ readiness: 2, admissions: 1 });
    // What an earlier failure waited for is not a row's: no check failed while it was sampled.
    expect(row("heavy baseline 1").work!.readinessBlockers).toEqual([]);
  });

  it("samples a step that raises the hold rate past the margin once the wait's bound passes, says so, and goes on", async () => {
    // Shadows off holds three attempts in four.
    const { deps, waits, timeouts } = holdingView((attempt, commands) => shadowsOff(commands) ? attempt % 4 !== 0 : ONE_IN_FOUR(attempt));
    const report = await runFeatureTestCheck({ mode: "profile", scenes: FEATURE_TEST_PROFILE_SCENES, deps, timeouts, signal: new AbortController().signal });
    const samples = report.scenes[0]!.play.benchmark;
    const shadows = samples.find((sample) => sample.label === "heavy shadows off")!;
    expect(shadows.failed).toEqual([
      "The view still held 75% of its frames over the last 2 s after 90 s, past the 40% its warm-up allows (25% plus 15 points); these frames include them.",
    ]);
    // 90 s of waiting, then the 3 s settle.
    expect(waits.find((wait) => wait.step === "main: measuring heavy shadows off")!.ms).toBe(93_000);
    expect(samples.at(-1)!.label).toBe("heavy drift");
    expect(report.scenes[0]!.problems).toEqual([`heavy shadows off: ${shadows.failed[0]}`]);
  });

  it("records the readiness checks of the frames drawn while Play is measured, and what Play first drew before a sweep", async () => {
    // A frame every 25 ms, after the 100 the load drew; each runs one strict readiness check that takes 30 ms, for a
    // mesh added, and fails twice before it. The three preparation checks were all before the measured window.
    const view = (now: number) => {
      const drawn = 100 + Math.floor(now / 25);
      return {
        drawn, held: 0,
        rendererWork: {
          graphBuilds: 0, shadowAdmissions: 0, shadowAdmissionMs: 0, strictReadinessChecks: drawn, readinessProbeMs: drawn * 30, outlineReadinessChecks: 0,
          readinessProbeReasons: { meshAdded: drawn, prepare: 3 }, readinessSwapRechecks: 0, failedReadinessProbes: drawn * 2, scopedReadinessProbes: 0, scopedReadinessMismatches: 0, scopedReadinessIdleRequests: 0,
          readinessBlockers: ['mesh "crate" (Material "wood"): pbr #1 linking'],
        },
      };
    };
    const run = async (mode: "quick" | "benchmark") => {
      const editor = fakeEditor({}, undefined, view);
      const report = await runFeatureTestCheck({ mode, scenes: [scene("main")], deps: editor.deps, signal: new AbortController().signal });
      return report.scenes[0]!.play;
    };
    const quick = await run("quick");
    // The fake's frame sample returns at once, so the measured window is the runner's one 500 ms poll of the
    // counters: 20 frames drawn, 20 checks, 600 ms of them; causes that did not grow are left out. Checks failed in
    // the window, so it keeps what the last of them waited for.
    expect(quick.work).toEqual({
      drawn: 20,
      work: {
        graphBuilds: 0, shadowAdmissions: 0, shadowAdmissionMs: 0, strictReadinessChecks: 20, readinessProbeMs: 600, outlineReadinessChecks: 0,
        readinessProbeReasons: { meshAdded: 20 }, readinessSwapRechecks: 0, failedReadinessProbes: 40, scopedReadinessProbes: 0, scopedReadinessMismatches: 0, scopedReadinessIdleRequests: 0,
        readinessBlockers: ['mesh "crate" (Material "wood"): pbr #1 linking'],
      },
    });
    // The fake's tick index stands still: no game tick over Play's sample.
    expect(quick.ticksPerSecond).toBe(0);
    expect(quick.firstDrawsBeforeSweep).toBeUndefined();
    // The fake first draws one shader per command: none before the sweep, then the cap, four tiers and the cap.
    const benchmark = await run("benchmark");
    expect(benchmark.firstDrawsBeforeSweep!.draws).toBe(0);
    expect(benchmark.firstDraws!.draws).toBe(7);
  });

  it("still ends the sweep at a step after which the view draws no frame, and restores the session and the tour camera", async () => {
    const { editor, deps, waits, timeouts } = holdingView((attempt, commands) => shadowsOff(commands) || ONE_IN_FOUR(attempt));
    const report = await runFeatureTestCheck({ mode: "profile", scenes: FEATURE_TEST_PROFILE_SCENES, deps, timeouts, signal: new AbortController().signal });
    const samples = report.scenes[0]!.play.benchmark;
    const rowsUntil = featureTestProfileSequence(SESSION).filter((step) => !step.action).map((step) => step.label);
    expect(samples.map((sample) => sample.label)).toEqual(["warm-up 1", "warm-up 2", ...rowsUntil.slice(0, rowsUntil.indexOf("heavy shadows off") + 1)]);
    expect(samples.at(-1)!.failed).toEqual(["The view drew no frame in the last 2 s of 90 s; the remaining profiles were skipped."]);
    expect(waits.at(-1)).toEqual({ step: "main: measuring heavy shadows off", ms: 90_000 });
    expect(editor.commands).not.toContain("quality shadows medium");
    expect(editor.commands.slice(-3)).toEqual(["gpubusy off", "quality reset", 'possess "Main Camera"']);
  });

  it("keeps a Breakdown on its strict wait: a view that holds a frame in four ends its warm-up and its sweep", async () => {
    const { deps, timeouts } = holdingView();
    const report = await runFeatureTestCheck({ mode: "breakdown", scenes: [scene("FT_World")], deps, timeouts, signal: new AbortController().signal });
    expect(report.scenes[0]!.play.benchmark.map((sample) => [sample.label, sample.failed])).toEqual([
      ["warm-up 1", []],
      ["baseline 1", ["The view did not draw steadily within 90 s; the remaining profiles were skipped."]],
    ]);
  });

  it("samples no step whose setting the tier already holds, nor the baseline after it, and reports a setting the restore left changed", async () => {
    // At Medium; the session's post-processing cannot be turned back on.
    const { deps } = profileEditor({ tier: "medium", refused: ["postprocessing on"] });
    const report = await runFeatureTestCheck({ mode: "profile", scenes: FEATURE_TEST_PROFILE_SCENES, deps, signal: new AbortController().signal });
    const [main] = report.scenes;
    const rows = main!.play.benchmark.filter((sample) => !sample.warmup);
    expect(rows.filter((sample) => sample.skipped).map((sample) => [sample.label, sample.skipped, sample.frames])).toEqual([
      ["heavy shadows medium", "already shadows medium 2048, shadows.filter high, shadows.screen off, shadows.reflections false", null],
    ]);
    const labels = rows.map((sample) => sample.label);
    expect(labels.slice(labels.indexOf("heavy shadow passes off"), labels.indexOf("heavy shadows medium big atlas") + 2)).toEqual([
      "heavy shadow passes off", "heavy baseline 4", "heavy shadows medium", "heavy shadows medium big atlas", "heavy baseline 6",
    ]);
    // The step's undo failed: the baseline after it says so and fails the scene.
    expect(main!.problems).toEqual(["heavy baseline 9: postprocessing on failed: Refused."]);
    expect(main!.play.profile!.endChanges).toEqual(["post.enabled=false"]);
  });

  it("measures nothing in a project without the Profile cameras, says to create it again, and restores the session", async () => {
    const { editor, deps } = profileEditor({ refused: ['possess "Profile Heavy Camera"'] });
    const report = await runFeatureTestCheck({ mode: "profile", scenes: FEATURE_TEST_PROFILE_SCENES, deps, signal: new AbortController().signal });
    const [main] = report.scenes;
    expect(main!.play.benchmark.map((sample) => [sample.label, sample.frames])).toEqual([["warm-up 1", null]]);
    expect(main!.problems).toEqual([
      'warm-up 1: possess "Profile Heavy Camera" failed: Refused. This project has no Profile cameras; create the Feature Test project again, then run the Profile.',
    ]);
    expect(editor.commands).not.toContain("gpubusy on");
    expect(editor.commands.slice(-2)).toEqual(["quality reset", 'possess "Main Camera"']);
    expect(main!.play.profile!.endChanges).toEqual([]);
  });
});

describe("frameStats", () => {
  it("reports the median interval of an odd and an even count", () => {
    expect(frameStats([10, 30, 20])!.medianMs).toBe(20);
    expect(frameStats([10, 40, 20, 30])!.medianMs).toBe(25);
    // Frames by display intervals at 60 Hz: one, two, four, and five or more (a stall).
    expect(frameStats([16, 17, 33, 66, 120])!.intervals).toEqual([2, 1, 0, 1, 1]);
  });
});
