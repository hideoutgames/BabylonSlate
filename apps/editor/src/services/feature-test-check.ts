import type { RenderDiagnostics } from "@haptic/render";
import type { PlaySessionResult } from "./play-session";
import type { PlayProbe, ViewportProbe } from "./runtime-probes";
import { describeError } from "../lib/diagnostic-info";

/** Scenes a Full check walks, in order; the heaviest runs last. */
export const FEATURE_TEST_CHECK_SCENES = [
  { name: "main", path: "assets/main.scene.hasset" },
  { name: "FT_World", path: "assets/FeatureTest/Scenes/FT_World.scene.hasset" },
  { name: "FT_Lights", path: "assets/FeatureTest/Scenes/FT_Lights.scene.hasset" },
  { name: "FT_Occlusion", path: "assets/FeatureTest/Scenes/FT_Occlusion.scene.hasset" },
  { name: "FT_2D", path: "assets/FeatureTest/Scenes/FT_2D.scene.hasset" },
  { name: "FT_Stress", path: "assets/FeatureTest/Scenes/FT_Stress.scene.hasset" },
] as const;

/** Console commands each scene runs in Play; the main scene exercises the full set. */
export function featureTestCheckCommands(sceneName: string, mode: FeatureTestCheckMode): string[] {
  if (sceneName === "main" && mode === "full") return ["ft_stats", "ft_spawn 10", "ft_stats", "ft_stream", "ft_cel", "ft_pbr"];
  // Occlusion Culling is off on every tier: the yardstick turns it on.
  if (sceneName === "FT_Occlusion") return ["ft_stats", "ft_occlusion"];
  return ["ft_stats"];
}

export type FeatureTestCheckMode = "quick" | "full" | "benchmark" | "breakdown";

/** Scenes a Breakdown measures unless every scene is asked for: the GPU-heaviest. */
export const FEATURE_TEST_BREAKDOWN_SCENES = FEATURE_TEST_CHECK_SCENES.filter((scene) => scene.name === "FT_World");

/** A Breakdown step: its commands, what undoes them besides `quality reset`, and the render settings it may change. */
export interface FeatureTestBreakdownStep {
  label: string;
  commands: readonly string[];
  restore?: readonly string[];
  /** A baseline: the project quality, nothing changed. */
  baseline?: boolean;
  /** Render-settings fingerprint fields (`RenderDiagnostics.settings`) the step may change; any other change is flagged. */
  fields?: readonly string[];
}

const POST_FIELDS = ["post.scale", "post.ambientOcclusion", "post.reflections", "post.volumetricLighting"] as const;
const baseline = (n: number): FeatureTestBreakdownStep => ({ label: `baseline ${n}`, commands: [], baseline: true });

/**
 * What a Breakdown measures per scene, each on top of the project quality: one feature off (or one cost lowered) at a
 * time, so its change against the baselines around it is that feature's share of the frame. After each step
 * `quality reset` and its `restore` commands undo it. The run alternates baselines and steps (`breakdownSequence`).
 */
export const FEATURE_TEST_BREAKDOWN_STEPS: readonly FeatureTestBreakdownStep[] = [
  { label: "shadows off", commands: ["quality shadows enabled off"], fields: ["shadows"] },
  { label: "shadows medium", commands: ["quality shadows medium"], fields: ["shadows"] },
  { label: "water refraction off", commands: ["quality water refraction off"], fields: ["water.refraction"] },
  { label: "water reflections sky", commands: ["quality water reflections sky"], fields: ["water.reflections"] },
  { label: "water detail low", commands: ["quality water shadingDetail low"], fields: ["water.shadingDetail"] },
  { label: "water detail medium", commands: ["quality water shadingDetail medium"], fields: ["water.shadingDetail"] },
  { label: "post low", commands: ["quality postprocessing low"], fields: POST_FIELDS },
  { label: "AO off", commands: ["quality postprocessing ambientOcclusion off"], fields: ["post.ambientOcclusion"] },
  { label: "SSR off", commands: ["quality postprocessing reflections off"], fields: ["post.reflections"] },
  { label: "volumetrics off", commands: ["quality postprocessing volumetricLighting off"], fields: ["post.volumetricLighting"] },
  { label: "post off", commands: ["postprocessing off"], restore: ["postprocessing on"], fields: ["post.enabled"] },
  { label: "captures off", commands: ["rendertargets off"], restore: ["rendertargets on"], fields: ["captures"] },
  { label: "resolution 0.5", commands: ["quality resolution scale 0.5"], fields: ["resolution.scale"] },
];

/**
 * The order a Breakdown measures in: a baseline before every step and one after the last (A B A C A …), so each step is
 * compared with the two baselines immediately around it and slow drift (thermal throttling, background work) cancels.
 */
export function breakdownSequence(steps: readonly FeatureTestBreakdownStep[] = FEATURE_TEST_BREAKDOWN_STEPS): FeatureTestBreakdownStep[] {
  const sequence: FeatureTestBreakdownStep[] = [];
  steps.forEach((step, index) => sequence.push(baseline(index + 1), step));
  sequence.push(baseline(steps.length + 1));
  return sequence;
}

/** Whether a sample is a Breakdown baseline (reports saved before `baseline` name theirs "baseline" and "baseline again"). */
export function isBreakdownBaseline(sample: FeatureTestBenchmarkSample): boolean {
  if (sample.warmup) return false;
  return sample.baseline ?? (sample.label === "baseline" || sample.label === "baseline again");
}

/**
 * What a Breakdown compares: the median GPU-busy time per frame (`gpuBusy`, from fences, unaffected by display pacing)
 * when both sides measured it, else the mean frame interval.
 */
function breakdownValue(sample: FeatureTestBenchmarkSample, gpu: boolean): number | null {
  return gpu ? sample.gpuBusy?.medianMs ?? null : meanFrameMs(sample.frames);
}

/**
 * A sample's mean frame interval: the window over its frames. The median snaps to a multiple of the display's refresh
 * interval (a vsync-paced frame lasts 16.7, 33.3 or 50 ms, nothing between), so a few frames moving between two of
 * them jump it by a whole interval; the mean moves in proportion. Reports saved before `meanMs` fall back to it here.
 */
export function meanFrameMs(frames: FrameStats | null): number | null {
  if (!frames) return null;
  return frames.meanMs ?? (frames.frames > 0 ? frames.durationMs / frames.frames : frames.medianMs ?? null);
}

/**
 * A Breakdown step's change against the baselines around it (the mean of the nearest before and after), or null when
 * unmeasured: in median GPU-busy time per frame when the step and those baselines measured it (`basis: "gpu"`), else in
 * mean frame interval (`"frame"`). A baseline is measured against the first baseline: its change is the drift.
 */
export function breakdownDelta(
  samples: readonly FeatureTestBenchmarkSample[],
  sample: FeatureTestBenchmarkSample,
): { ms: number; percent: number; basis: "gpu" | "frame" } | null {
  const index = samples.indexOf(sample);
  if (index < 0 || sample.warmup) return null;
  const references = (gpu: boolean) => {
    const measured = (entry: FeatureTestBenchmarkSample) => isBreakdownBaseline(entry) && breakdownValue(entry, gpu) !== null;
    if (isBreakdownBaseline(sample)) {
      const first = samples.find(measured);
      return first ? [first] : [];
    }
    const before = samples.slice(0, index).reverse().find(measured);
    const after = samples.slice(index + 1).find(measured);
    return [before, after].filter((entry): entry is FeatureTestBenchmarkSample => entry !== undefined);
  };
  for (const gpu of [true, false]) {
    const value = breakdownValue(sample, gpu);
    const around = references(gpu);
    if (value === null || !around.length) continue;
    const base = around.reduce((total, entry) => total + breakdownValue(entry, gpu)!, 0) / around.length;
    const ms = value - base;
    return { ms, percent: (ms / base) * 100, basis: gpu ? "gpu" : "frame" };
  }
  return null;
}

/** The display interval a Breakdown's 60 fps cap paces frames to. */
export const VSYNC_MS = 1000 / 60;

/**
 * What limits a sample's frames: `vsync` when the mean frame interval is within 15% of the 60 Hz interval (the cap,
 * not the device), `gpu` when it is more than half again the CPU frame cost (the CPU waits on the GPU), otherwise
 * `cpu`; null without frames or CPU cost.
 */
export function frameBound(frames: FrameStats | null, cpuMs: number | null): "vsync" | "gpu" | "cpu" | null {
  const mean = meanFrameMs(frames);
  if (mean === null || cpuMs === null) return null;
  if (mean <= VSYNC_MS * 1.15) return "vsync";
  return mean > cpuMs * 1.5 ? "gpu" : "cpu";
}

/** Render-settings fingerprint fields that differ between two snapshots, as `field=value` of `after`. */
export function settingsChanges(
  before: Readonly<Record<string, string>> | undefined,
  after: Readonly<Record<string, string>> | undefined,
): string[] {
  if (!before || !after) return [];
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
  return keys.filter((key) => before[key] !== after[key]).map((key) => `${key}=${after[key] ?? "-"}`);
}

/**
 * Performance profiles a Benchmark sweeps per scene: each quality tier. A
 * profile's commands can rebuild shaders and render targets, so sampling waits
 * for the view to draw again.
 */
export const FEATURE_TEST_BENCHMARK_PROFILES: readonly { label: string; commands: readonly string[] }[] = [
  { label: "low", commands: ["quality low"] },
  { label: "medium", commands: ["quality medium"] },
  { label: "high", commands: ["quality high"] },
  { label: "ultra", commands: ["quality ultra"] },
];

/** Above any display refresh, so a Benchmark measures the device rather than the project frame cap. */
const BENCHMARK_FRAME_CAP = 240;
/**
 * A Breakdown samples at the normal 60 fps cap. iOS Safari paces requestAnimationFrame to the display, so a lifted cap
 * gains no frames there; it only lets submitted frames queue behind a busy GPU, which made frames slower than capped
 * Play and drift during the run.
 */
const BREAKDOWN_FRAME_CAP = 60;

export interface FeatureTestBenchmarkSample {
  label: string;
  frames: FrameStats | null;
  runtimeFps: number | null;
  /** Median CPU and GPU frame cost while sampling (the mean in reports saved before `cpu`); GPU is null where timer queries are unavailable. */
  cpuMs: number | null;
  gpuMs: number | null;
  /** Median draw calls per frame while sampling (the frame at the end of the sample in reports saved before `draws`). */
  drawCalls: number;
  /** The per-frame counters while sampling; absent in reports saved before they were recorded. */
  draws?: CounterStats;
  cpu?: CounterStats | null;
  gpu?: CounterStats | null;
  resolution: string | null;
  failed: string[];
  /** A Breakdown baseline; absent in reports saved before interleaved baselines. */
  baseline?: boolean;
  /** A Breakdown warm-up window at the baseline, before the steps (never a reference). */
  warmup?: boolean;
  /** GPU-busy time per frame from fences while sampled (`gpubusy`); absent where unmeasured or in older reports. */
  gpuBusy?: NonNullable<RenderDiagnostics["gpuBusy"]>;
  /** The step's render-settings fingerprint (`RenderDiagnostics.settings`) while sampled. */
  settings?: Record<string, string>;
  /** Shaders first drawn and Effects compiling during the sample (both should be 0), and how long settling took. */
  unsettled?: { firstDraws: number; compiling: number; settleMs: number };
}

/**
 * A per-frame counter (draw calls, CPU or GPU frame cost) over a sample window, read every half second. One frame's
 * value is not representative: a pass that draws on alternate frames (a static view's planar reflection) moves the draw
 * count by its whole draw count.
 */
export interface CounterStats {
  median: number;
  min: number;
  max: number;
  samples: number;
}

/** Play's per-frame counters while it was sampled. */
export interface PlayCounters {
  draws: CounterStats | null;
  cpuMs: CounterStats | null;
  gpuMs: CounterStats | null;
}

export interface FrameStats {
  frames: number;
  durationMs: number;
  fps: number;
  /** Median frame interval; absent in reports saved before it was recorded. */
  medianMs?: number;
  /** Mean frame interval (durationMs / frames); absent in reports saved before it was recorded. */
  meanMs?: number;
  /** Shares of frames lasting about 1, 2, 3 and 4 or more 60 Hz intervals; absent in reports saved before it was recorded. */
  vsync?: [number, number, number, number];
  p95Ms: number;
  maxMs: number;
  /** Frame intervals longer than 100 ms. */
  stalls: number;
}

export interface FeatureTestCheckCommandResult {
  line: string;
  success: boolean;
  output: string;
  ms: number;
}

export interface FeatureTestCheckSceneResult {
  name: string;
  path: string;
  editor: {
    status: "ready" | "failed" | "timeout" | "not-opened";
    ms: number;
    phase: string | null;
    frames: FrameStats | null;
    /** The viewport's load failure, one line per message, frame and cause. */
    error: string[] | null;
    gpu: ReturnType<ViewportProbe["gpu"]>;
  };
  play: {
    status: "loaded" | "timeout" | "closed" | "not-started" | "skipped";
    ms: number;
    phase: string | null;
    frames: FrameStats | null;
    runtimeFps: number | null;
    snapshot: ReturnType<PlayProbe["snapshot"]> | null;
    /** Play's per-frame counters while it was sampled; absent in reports saved before they were recorded. */
    counters?: PlayCounters | null;
    /** Shaders first drawn after the scene presented, read when its commands finished (WebGL2 only). */
    firstDraws: NonNullable<RenderDiagnostics["firstDraws"]> | null;
    commands: FeatureTestCheckCommandResult[];
    benchmark: FeatureTestBenchmarkSample[];
    logs: Array<{ severity: string; message: string }>;
  };
  session: {
    diagnostics: PlaySessionResult["diagnostics"];
    droppedDiagnostics: number;
    runtimeMode: PlaySessionResult["runtimeMode"] | null;
    textures: { before: number; after: number | null; leak: boolean; quarantined: boolean } | null;
  } | null;
  passed: boolean;
  problems: string[];
}

/** What the editor held at one moment of a check: shader programs, textures and memory. */
export interface FeatureTestCheckResources {
  /** Milliseconds since the check started. */
  atMs: number;
  step: string;
  /** Babylon Effects (shader programs) every Engine holds, and how many of them are still compiling. */
  effects: number;
  compiling: number;
  /**
   * Frames the Play view drew and held (kept its last image, waiting for shaders or settings), and the graphics
   * context losses it saw, since Play started.
   */
  playFrames: { drawn: number; held: number; contextLosses: number } | null;
  textures: number;
  /** Estimated GPU bytes of those textures, render targets included (`estimateTextureMemory`). */
  textureBytes: number;
  /** Where the browser reports them: the JS heap (Chromium) and the native shell's footprint. */
  jsHeapBytes: number | null;
  appFootprintBytes: number | null;
}

export interface FeatureTestCheckReport {
  mode: FeatureTestCheckMode;
  startedAt: number;
  durationMs: number;
  cancelled: boolean;
  scenes: FeatureTestCheckSceneResult[];
  pageErrors: string[];
  /** A check the app stopped during (a crash or reload): its last step and resource samples, oldest first. */
  unfinished?: { step: string; resources: FeatureTestCheckResources[] };
}

export interface FeatureTestCheckDeps {
  /** Opens the scene document; resolves once the editor accepted the request. */
  openScene: (path: string) => Promise<void>;
  activeDocumentId: () => string | null;
  viewport: (documentId: string) => ViewportProbe | null;
  /** Starts Play from the active scene without the unsaved-changes prompt. */
  startPlay: () => Promise<void>;
  play: () => PlayProbe | null;
  /** True when no game session is preparing, running or stopping. */
  sessionIdle: () => boolean;
  onSessionClosed: (listener: (result: PlaySessionResult) => void) => () => void;
  sampleFrames: (durationMs: number, signal: AbortSignal) => Promise<FrameStats | null>;
  /** Shader programs still compiling across every Engine; absent where unknown. */
  compiling?: () => number;
  now: () => number;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  onProgress?: (message: string) => void;
}

export interface FeatureTestCheckTimeouts {
  sceneOpenMs: number;
  playLoadMs: number;
  playCloseMs: number;
  commandMs: number;
  releaseMs: number;
  /** Quiet time, with no shader first drawn and none compiling, a profile waits for before it samples. */
  profileSettleMs: number;
  /** Most a profile waits for the view to draw again without held frames, before the settle; past it, the sweep stops. */
  profileCompileMs: number;
  editorSampleMs: number;
  playSampleMs: number;
  /** A Breakdown's warm-up window: it ends once two consecutive windows differ by under 3%. */
  breakdownWarmupWindowMs: number;
  /** Most a Breakdown warms up before its first step, stable or not. */
  breakdownWarmupMs: number;
}

export const DEFAULT_FEATURE_TEST_CHECK_TIMEOUTS: FeatureTestCheckTimeouts = {
  sceneOpenMs: 120_000,
  playLoadMs: 120_000,
  playCloseMs: 30_000,
  commandMs: 60_000,
  releaseMs: 10_000,
  profileSettleMs: 3_000,
  profileCompileMs: 90_000,
  editorSampleMs: 3_000,
  playSampleMs: 5_000,
  breakdownWarmupWindowMs: 10_000,
  breakdownWarmupMs: 90_000,
};

/** Consecutive warm-up windows within this share of each other end a Breakdown's warm-up. */
const WARMUP_STABLE = 0.03;

const POLL_MS = 250;

/** Frame statistics from rAF intervals in milliseconds. */
export function frameStats(intervals: readonly number[]): FrameStats | null {
  if (!intervals.length) return null;
  const sorted = [...intervals].sort((a, b) => a - b);
  const durationMs = intervals.reduce((total, value) => total + value, 0);
  return {
    frames: intervals.length,
    durationMs,
    fps: durationMs > 0 ? (intervals.length * 1000) / durationMs : 0,
    medianMs: sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2,
    meanMs: durationMs / intervals.length,
    vsync: vsyncShares(intervals),
    p95Ms: sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)],
    maxMs: sorted[sorted.length - 1],
    stalls: intervals.filter((value) => value > 100).length,
  };
}

/** Shares of `intervals` lasting about 1, 2, 3 and 4 or more 60 Hz display intervals. */
export function vsyncShares(intervals: readonly number[]): [number, number, number, number] {
  const counts: [number, number, number, number] = [0, 0, 0, 0];
  for (const interval of intervals) counts[Math.min(3, Math.max(0, Math.round(interval / VSYNC_MS) - 1))] += 1;
  return counts.map((count) => (intervals.length ? count / intervals.length : 0)) as [number, number, number, number];
}

function timeout<T>(promise: Promise<T>, ms: number, deps: FeatureTestCheckDeps, signal: AbortSignal): Promise<T | "timeout"> {
  return Promise.race([promise, deps.sleep(ms, signal).then(() => "timeout" as const)]);
}

/** Polls `done` until it returns a value, the deadline passes, or the run is cancelled. */
async function waitFor<T>(deps: FeatureTestCheckDeps, signal: AbortSignal, ms: number, done: () => T | null | undefined): Promise<T | null> {
  const deadline = deps.now() + ms;
  for (;;) {
    signal.throwIfAborted();
    const value = done();
    if (value !== null && value !== undefined) return value;
    if (deps.now() >= deadline) return null;
    await deps.sleep(POLL_MS, signal);
  }
}

/**
 * Walks Feature Test scenes in the editor and in Play and records what a
 * developer needs to debug a device remotely. Never throws for a scene
 * failure; cancellation stops Play and returns the partial report.
 */
export async function runFeatureTestCheck(options: {
  mode: FeatureTestCheckMode;
  /** Scene paths to check; Quick passes the current scene. */
  scenes: ReadonlyArray<{ name: string; path: string }>;
  deps: FeatureTestCheckDeps;
  signal: AbortSignal;
  timeouts?: Partial<FeatureTestCheckTimeouts>;
  pageErrors?: () => string[];
  /** Each progress step with the report so far, which a crash would otherwise lose. */
  onStep?: (step: string, report: FeatureTestCheckReport) => void;
}): Promise<FeatureTestCheckReport> {
  const { signal, mode } = options;
  const limits = { ...DEFAULT_FEATURE_TEST_CHECK_TIMEOUTS, ...options.timeouts };
  const startedAt = options.deps.now();
  const wallClock = Date.now();
  const scenes: FeatureTestCheckSceneResult[] = [];
  const partial = (): FeatureTestCheckReport => ({
    mode, startedAt: wallClock, durationMs: options.deps.now() - startedAt, cancelled: false, scenes, pageErrors: options.pageErrors?.() ?? [],
  });
  const deps: FeatureTestCheckDeps = {
    ...options.deps,
    onProgress: (message) => {
      options.deps.onProgress?.(message);
      options.onStep?.(message, partial());
    },
  };
  let cancelled = false;
  for (const scene of options.scenes) {
    if (signal.aborted) { cancelled = true; break; }
    const result = emptySceneResult(scene);
    scenes.push(result);
    try {
      await checkScene(result, mode, deps, signal, limits);
    } catch (error) {
      if (!signal.aborted) throw error;
      cancelled = true;
      result.problems.push("Cancelled while checking this scene.");
      deps.play()?.stop();
      break;
    }
  }
  return { mode, startedAt: wallClock, durationMs: deps.now() - startedAt, cancelled, scenes, pageErrors: options.pageErrors?.() ?? [] };
}

function emptySceneResult(scene: { name: string; path: string }): FeatureTestCheckSceneResult {
  return {
    name: scene.name, path: scene.path,
    editor: { status: "not-opened", ms: 0, phase: null, frames: null, error: null, gpu: null },
    play: { status: "not-started", ms: 0, phase: null, frames: null, runtimeFps: null, snapshot: null, firstDraws: null, commands: [], benchmark: [], logs: [] },
    session: null, passed: false, problems: [],
  };
}

/** Fills `result` in place, so a cancelled run still reports how far the scene got. */
async function checkScene(
  result: FeatureTestCheckSceneResult,
  mode: FeatureTestCheckMode,
  deps: FeatureTestCheckDeps,
  signal: AbortSignal,
  limits: FeatureTestCheckTimeouts,
): Promise<void> {
  const scene = result;
  const documentId = `scene:${scene.path}`;
  deps.onProgress?.(`${scene.name}: opening in the editor`);
  let started = deps.now();
  await deps.openScene(scene.path);
  const opened = await waitFor(deps, signal, limits.sceneOpenMs, () => {
    if (deps.activeDocumentId() !== documentId) return null;
    const viewport = deps.viewport(documentId);
    if (viewport?.failed()) return "failed" as const;
    return viewport?.ready() ? "ready" as const : null;
  });
  result.editor.ms = deps.now() - started;
  const viewport = deps.viewport(documentId);
  result.editor.gpu = viewport?.gpu() ?? null;
  const error = viewport?.error();
  if (error !== undefined && error !== null) result.editor.error = describeError(error);
  if (opened === null) {
    const active = deps.activeDocumentId() === documentId;
    result.editor.status = active ? "timeout" : "not-opened";
    result.editor.phase = deps.viewport(documentId)?.phase() ?? null;
    result.problems.push(active
      ? `Editor viewport did not finish loading in ${seconds(limits.sceneOpenMs)}${result.editor.phase ? ` (stuck at ${result.editor.phase})` : ""}.`
      : "Scene did not open; an unsaved-changes prompt or another dialog may have blocked it.");
    return;
  }
  result.editor.status = opened;
  if (opened === "failed") {
    result.editor.phase = deps.viewport(documentId)?.phase() ?? null;
    result.problems.push(`Editor viewport reported Scene Loading Failed${result.editor.phase ? ` at ${result.editor.phase}` : ""}.`);
    return;
  }
  deps.onProgress?.(`${scene.name}: measuring the editor viewport`);
  result.editor.frames = await deps.sampleFrames(limits.editorSampleMs, signal);

  deps.onProgress?.(`${scene.name}: starting Play`);
  const closed = new Promise<PlaySessionResult>((resolve) => {
    const stop = deps.onSessionClosed((session) => { stop(); resolve(session); });
    signal.addEventListener("abort", stop, { once: true });
  });
  started = deps.now();
  await deps.startPlay();
  let closedEarly: PlaySessionResult | null = null;
  void closed.then((session) => { closedEarly = session; });
  const loaded = await waitFor(deps, signal, limits.playLoadMs, () => {
    if (closedEarly) return "closed" as const;
    const play = deps.play();
    return play && play.loadingPhase() === null && play.tickIndex() > 0 ? "loaded" as const : null;
  });
  result.play.ms = deps.now() - started;
  const play = deps.play();
  if (loaded === "loaded" && play) {
    result.play.status = "loaded";
    deps.onProgress?.(`${scene.name}: measuring Play`);
    const sampled = await sampleWithCounters(play, deps.sampleFrames(limits.playSampleMs, signal), deps, signal);
    result.play.frames = sampled.frames;
    result.play.counters = { draws: sampled.draws, cpuMs: sampled.cpu, gpuMs: sampled.gpu };
    result.play.runtimeFps = play.runtimeFps();
    result.play.snapshot = play.snapshot();
    const run = (line: string) => runCommand(play, line, deps, signal, limits);
    if (mode === "benchmark" || mode === "breakdown") {
      await benchmarkProfiles(scene.name, mode, play, run, deps, signal, limits, result.play.benchmark);
      for (const sample of result.play.benchmark) {
        for (const failure of sample.failed) result.problems.push(`${sample.label}: ${failure}`);
      }
    } else {
      for (const line of featureTestCheckCommands(scene.name, mode)) {
        deps.onProgress?.(`${scene.name}: running ${line}`);
        const command = await run(line);
        result.play.commands.push(command);
        if (!command.success) result.problems.push(`Command ${line} failed: ${sentence(command.output || "no output")}`);
      }
    }
    result.play.firstDraws = play.snapshot().rendering?.firstDraws ?? null;
  } else if (loaded === "closed") {
    result.play.status = "closed";
    result.problems.push("Play closed before the scene finished loading.");
  } else if (loaded === null) {
    result.play.status = "timeout";
    const phase = play?.loadingPhase();
    result.play.phase = phase ? `${phase.phase} ${Math.round(phase.progress)}%` : null;
    result.problems.push(`Play did not finish loading in ${seconds(limits.playLoadMs)}${result.play.phase ? ` (stuck at ${result.play.phase})` : ""}.`);
  }
  if (play) result.play.logs = play.problemLogs();

  deps.onProgress?.(`${scene.name}: stopping Play`);
  if (!closedEarly) deps.play()?.stop();
  const session = await timeout(closed, limits.playCloseMs, deps, signal);
  if (session === "timeout") {
    result.problems.push(`Play did not close in ${seconds(limits.playCloseMs)}.`);
  } else {
    const released = await timeout(session.released, limits.releaseMs, deps, signal);
    result.session = {
      diagnostics: session.diagnostics,
      droppedDiagnostics: session.droppedDiagnostics,
      runtimeMode: session.runtimeMode,
      textures: {
        before: session.textureCountBefore,
        after: released === "timeout" ? null : released.textureCountAfter,
        leak: released !== "timeout" && released.textureLeak,
        quarantined: released !== "timeout" && released.quarantined,
      },
    };
    const errors = session.diagnostics.filter((entry) => entry.severity === "error");
    if (errors.length) result.problems.push(`Session report has ${errors.length} error${errors.length === 1 ? "" : "s"}.`);
    if (result.session.textures?.quarantined) result.problems.push("Game resources did not confirm release.");
  }
  await waitFor(deps, signal, limits.playCloseMs, () => deps.sessionIdle() || null);
  result.passed = result.problems.length === 0;
}

async function runCommand(
  play: PlayProbe,
  line: string,
  deps: FeatureTestCheckDeps,
  signal: AbortSignal,
  limits: FeatureTestCheckTimeouts,
): Promise<FeatureTestCheckCommandResult> {
  const started = deps.now();
  const outcome = await timeout(play.executeConsoleCommand(line), limits.commandMs, deps, signal)
    .catch((error: unknown) => ({ success: false, output: error instanceof Error ? error.message : String(error) }));
  const ms = deps.now() - started;
  return outcome === "timeout"
    ? { line, success: false, output: `No reply in ${seconds(limits.commandMs)}`, ms }
    : { line, success: outcome.success, output: outcome.output, ms };
}

/** Polls of new draws without a held one before a recompiling profile samples (one second at POLL_MS). */
const STEADY_POLLS = 4;

/**
 * Waits, bounded by `ms`, until the Play view draws without holding frames
 * (shaders and WebGPU pipelines a profile asked for are ready). True when it
 * did, or when the view reports no presentation counts to watch.
 */
async function viewDrawsSteadily(play: PlayProbe, deps: FeatureTestCheckDeps, signal: AbortSignal, ms: number): Promise<boolean> {
  let last: { drawn: number; held: number } | null = null;
  let steady = 0;
  const done = await waitFor(deps, signal, ms, () => {
    const presentation = play.snapshot().rendering?.presentation;
    if (!presentation) return true;
    steady = last && presentation.held === last.held && presentation.drawn > last.drawn ? steady + 1 : 0;
    last = { drawn: presentation.drawn, held: presentation.held };
    return steady >= STEADY_POLLS ? true : null;
  });
  return done === true;
}

/**
 * Waits, bounded by `ms`, until no shader has been first drawn and none compiled for `quietMs`, so a sample measures
 * the step and not the variants it asked for. Shaders first drawn are read from `RenderDiagnostics.firstDraws` (WebGL2
 * only) and compiling Effects from `deps.compiling`; with neither, it waits `quietMs`. Returns how long it waited and
 * whether it went quiet.
 */
async function settleView(
  play: PlayProbe, deps: FeatureTestCheckDeps, signal: AbortSignal, quietMs: number, ms: number,
): Promise<{ quiet: boolean; ms: number }> {
  const started = deps.now();
  let last: number | null = null;
  let quietSince = started;
  const quiet = await waitFor(deps, signal, ms, () => {
    const draws = play.snapshot().rendering?.firstDraws?.draws ?? 0;
    const busy = (deps.compiling?.() ?? 0) > 0 || (last !== null && draws !== last);
    last = draws;
    if (busy) quietSince = deps.now();
    return deps.now() - quietSince >= quietMs ? true : null;
  });
  return { quiet: quiet === true, ms: deps.now() - started };
}

/**
 * Sweeps FEATURE_TEST_BENCHMARK_PROFILES (a Benchmark, frame cap lifted) or FEATURE_TEST_BREAKDOWN_STEPS (a Breakdown at
 * the normal cap, undoing each step after it) on the running scene into `samples`, one as each finishes, then
 * restores the session's quality, render path and cap.
 */
async function benchmarkProfiles(
  sceneName: string,
  mode: "benchmark" | "breakdown",
  play: PlayProbe,
  run: (line: string) => Promise<FeatureTestCheckCommandResult>,
  deps: FeatureTestCheckDeps,
  signal: AbortSignal,
  limits: FeatureTestCheckTimeouts,
  samples: FeatureTestBenchmarkSample[],
): Promise<void> {
  const breakdown = mode === "breakdown";
  const cap = /(\d+)/.exec((await run("framecap")).output)?.[1];
  await run(`framecap ${breakdown ? BREAKDOWN_FRAME_CAP : BENCHMARK_FRAME_CAP}`);
  const steps: readonly FeatureTestBreakdownStep[] = breakdown ? breakdownSequence() : FEATURE_TEST_BENCHMARK_PROFILES;
  const pendingRestore: string[] = [];
  const restore = async () => {
    if (!breakdown) return;
    await run("quality reset");
    for (const line of pendingRestore.splice(0)) await run(line);
  };
  // A Breakdown times each frame's GPU work with fences, which display pacing does not quantise; restarted per sample.
  let gpuBusy = false;
  /** Samples the view as it is now into a sample labelled `label`; `failed` collects what went wrong. */
  const measure = async (label: string, failed: string[], sampleMs: number, settled: { quiet: boolean; ms: number }) => {
    const firstDrawsBefore = play.snapshot().rendering?.firstDraws?.draws ?? 0;
    if (breakdown) gpuBusy = (await run("gpubusy on")).success;
    const sampled = await sampleWithCounters(play, deps.sampleFrames(sampleMs, signal), deps, signal);
    const snapshot = play.snapshot();
    const rendering = snapshot.rendering;
    const sample: FeatureTestBenchmarkSample = {
      label,
      frames: sampled.frames,
      runtimeFps: play.runtimeFps(),
      cpuMs: sampled.cpu?.median ?? null,
      gpuMs: sampled.gpu?.median ?? null,
      drawCalls: sampled.draws?.median ?? snapshot.drawCalls,
      draws: sampled.draws ?? undefined,
      cpu: sampled.cpu,
      gpu: sampled.gpu,
      resolution: rendering ? `${rendering.width}x${rendering.height}@${rendering.scalingLevel.toFixed(2)}` : null,
      failed,
      ...(breakdown ? {
        ...(gpuBusy && rendering?.gpuBusy ? { gpuBusy: { ...rendering.gpuBusy } } : {}),
        ...(rendering?.settings ? { settings: { ...rendering.settings } } : {}),
        unsettled: { firstDraws: (rendering?.firstDraws?.draws ?? 0) - firstDrawsBefore, compiling: sampled.compiling, settleMs: settled.ms },
      } : {}),
    };
    return sample;
  };
  try {
    if (breakdown) await warmUp(sceneName, play, deps, signal, limits, measure, samples);
    for (const profile of steps) {
      deps.onProgress?.(`${sceneName}: ${breakdown ? "measuring" : "benchmarking"} ${profile.label}`);
      const failed: string[] = [];
      if (profile.restore) pendingRestore.push(...profile.restore);
      for (const line of profile.commands) {
        const command = await run(line);
        if (!command.success) failed.push(`${line} failed: ${sentence(command.output || "no output")}`);
      }
      // A view that does not draw again (shaders, render targets or a lost graphics context) ends this scene's
      // sweep: more changes on top would only pile up work and memory.
      const steady = await viewDrawsSteadily(play, deps, signal, limits.profileCompileMs);
      if (!steady) failed.push(`The view did not draw steadily within ${seconds(limits.profileCompileMs)}; the remaining profiles were skipped.`);
      // The view draws again, but the variants a step asked for may still be first drawing or compiling: sampling
      // them would measure their compiles, not the step.
      const settled = steady
        ? await settleView(play, deps, signal, limits.profileSettleMs, limits.profileCompileMs)
        : { quiet: true, ms: 0 };
      if (!settled.quiet) failed.push(`Shaders were still first drawn or compiling after ${seconds(limits.profileCompileMs)}; this step's frames include them.`);
      const sample = await measure(profile.label, failed, limits.playSampleMs, settled);
      if (breakdown) sample.baseline = profile.baseline === true;
      samples.push(sample);
      if (!steady) break;
      await restore();
    }
  } finally {
    if (!signal.aborted) {
      if (gpuBusy) await run("gpubusy off");
      await run("quality reset");
      for (const line of pendingRestore.splice(0)) await run(line);
      await run(`framecap ${cap ?? 60}`);
    }
  }
}

/**
 * Before a Breakdown's first step: samples the baseline in `breakdownWarmupWindowMs` windows until two consecutive
 * windows differ by under 3% (GPU-busy median where measured, else mean frame interval), bounded by
 * `breakdownWarmupMs`, so a device that heats up during the run starts the steps near its steady state. Each window is
 * kept as a `warmup` sample.
 */
async function warmUp(
  sceneName: string,
  play: PlayProbe,
  deps: FeatureTestCheckDeps,
  signal: AbortSignal,
  limits: FeatureTestCheckTimeouts,
  measure: (label: string, failed: string[], sampleMs: number, settled: { quiet: boolean; ms: number }) => Promise<FeatureTestBenchmarkSample>,
  samples: FeatureTestBenchmarkSample[],
): Promise<void> {
  const started = deps.now();
  let previous: number | null = null;
  for (let window = 1; ; window++) {
    deps.onProgress?.(`${sceneName}: warming up (${window})`);
    const steady = await viewDrawsSteadily(play, deps, signal, limits.profileCompileMs);
    const settled = steady ? await settleView(play, deps, signal, limits.profileSettleMs, limits.profileCompileMs) : { quiet: true, ms: 0 };
    const failed = settled.quiet ? [] : [`Shaders were still first drawn or compiling after ${seconds(limits.profileCompileMs)}; this window's frames include them.`];
    const sample = await measure(`warm-up ${window}`, failed, limits.breakdownWarmupWindowMs, settled);
    sample.warmup = true;
    samples.push(sample);
    const value = sample.gpuBusy?.medianMs ?? meanFrameMs(sample.frames);
    const stable = value !== null && previous !== null && Math.abs(value - previous) <= previous * WARMUP_STABLE;
    if (!steady || stable || value === null || deps.now() - started >= limits.breakdownWarmupMs) return;
    previous = value;
  }
}

/** Reads the per-frame counters every half second while `frames` samples the frame intervals. */
async function sampleWithCounters(
  play: PlayProbe, frames: Promise<FrameStats | null>, deps: FeatureTestCheckDeps, signal: AbortSignal,
): Promise<{ frames: FrameStats | null; draws: CounterStats | null; cpu: CounterStats | null; gpu: CounterStats | null; compiling: number }> {
  let compiling = 0;
  const cpu: number[] = [];
  const gpu: number[] = [];
  const draws: number[] = [];
  let sampling = true;
  const done = frames.finally(() => { sampling = false; });
  while (sampling) {
    const snapshot = play.snapshot();
    draws.push(snapshot.drawCalls);
    compiling = Math.max(compiling, deps.compiling?.() ?? 0);
    if (snapshot.rendering) {
      cpu.push(snapshot.rendering.cpuMs);
      if (snapshot.rendering.gpuMs !== null) gpu.push(snapshot.rendering.gpuMs);
    }
    await Promise.race([done, deps.sleep(500, signal)]);
  }
  return { frames: await done, draws: counterStats(draws), cpu: counterStats(cpu), gpu: counterStats(gpu), compiling };
}

/** The median, minimum and maximum of a counter's samples, or null without one. */
export function counterStats(values: readonly number[]): CounterStats | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  const median = sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
  return { median, min: sorted[0]!, max: sorted.at(-1)!, samples: sorted.length };
}

/** Ends `text` with exactly one full stop. */
function sentence(text: string): string {
  return /[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`;
}

function seconds(ms: number): string {
  return `${Math.round(ms / 1000)} s`;
}
