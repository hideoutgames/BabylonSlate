import type { PlaySessionResult } from "./play-session";
import type { PlayProbe, ViewportProbe } from "./runtime-probes";
import { describeError } from "../lib/diagnostic-info";

/** Scenes a Full check walks, in order; the heaviest runs last. */
export const FEATURE_TEST_CHECK_SCENES = [
  { name: "main", path: "assets/main.scene.babasset" },
  { name: "FT_World", path: "assets/FeatureTest/Scenes/FT_World.scene.babasset" },
  { name: "FT_Clustered", path: "assets/FeatureTest/Scenes/FT_Clustered.scene.babasset" },
  { name: "FT_2D", path: "assets/FeatureTest/Scenes/FT_2D.scene.babasset" },
  { name: "FT_Stress", path: "assets/FeatureTest/Scenes/FT_Stress.scene.babasset" },
] as const;

/** Console commands each scene runs in Play; the main scene exercises the full set. */
export function featureTestCheckCommands(sceneName: string, mode: FeatureTestCheckMode): string[] {
  if (sceneName === "main" && mode === "full") return ["ft_stats", "ft_spawn 10", "ft_stats", "ft_stream", "ft_cel", "ft_pbr"];
  return ["ft_stats"];
}

export type FeatureTestCheckMode = "quick" | "full" | "benchmark";

/** Performance profiles a Benchmark sweeps per scene: each quality tier, then Clustered Forward at High. */
export const FEATURE_TEST_BENCHMARK_PROFILES = [
  { label: "low · forward", commands: ["renderpath forward", "quality low"] },
  { label: "medium · forward", commands: ["renderpath forward", "quality medium"] },
  { label: "high · forward", commands: ["renderpath forward", "quality high"] },
  { label: "ultra · forward", commands: ["renderpath forward", "quality ultra"] },
  { label: "high · clustered", commands: ["renderpath clusteredForward", "quality high"] },
] as const;

/** Above any display refresh, so a Benchmark measures the device rather than the project frame cap. */
const BENCHMARK_FRAME_CAP = 240;

export interface FeatureTestBenchmarkSample {
  label: string;
  frames: FrameStats | null;
  runtimeFps: number | null;
  /** Mean CPU and GPU frame cost while sampling; GPU is null where timer queries are unavailable. */
  cpuMs: number | null;
  gpuMs: number | null;
  drawCalls: number;
  resolution: string | null;
  renderPath: string | null;
  failed: string[];
}

export interface FrameStats {
  frames: number;
  durationMs: number;
  fps: number;
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

export interface FeatureTestCheckReport {
  mode: FeatureTestCheckMode;
  startedAt: number;
  durationMs: number;
  cancelled: boolean;
  scenes: FeatureTestCheckSceneResult[];
  pageErrors: string[];
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
  /** Wait after a profile change for shaders and render targets to settle. */
  profileSettleMs: number;
  editorSampleMs: number;
  playSampleMs: number;
}

export const DEFAULT_FEATURE_TEST_CHECK_TIMEOUTS: FeatureTestCheckTimeouts = {
  sceneOpenMs: 120_000,
  playLoadMs: 120_000,
  playCloseMs: 30_000,
  commandMs: 60_000,
  releaseMs: 10_000,
  profileSettleMs: 3_000,
  editorSampleMs: 3_000,
  playSampleMs: 5_000,
};

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
    p95Ms: sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)],
    maxMs: sorted[sorted.length - 1],
    stalls: intervals.filter((value) => value > 100).length,
  };
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
}): Promise<FeatureTestCheckReport> {
  const { deps, signal, mode } = options;
  const limits = { ...DEFAULT_FEATURE_TEST_CHECK_TIMEOUTS, ...options.timeouts };
  const startedAt = deps.now();
  const wallClock = Date.now();
  const scenes: FeatureTestCheckSceneResult[] = [];
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
    play: { status: "not-started", ms: 0, phase: null, frames: null, runtimeFps: null, snapshot: null, commands: [], benchmark: [], logs: [] },
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
    result.play.frames = await deps.sampleFrames(limits.playSampleMs, signal);
    result.play.runtimeFps = play.runtimeFps();
    result.play.snapshot = play.snapshot();
    const run = (line: string) => runCommand(play, line, deps, signal, limits);
    if (mode === "benchmark") {
      result.play.benchmark = await benchmarkProfiles(scene.name, play, run, deps, signal, limits);
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

/**
 * Sweeps FEATURE_TEST_BENCHMARK_PROFILES on the running scene with the frame
 * cap lifted, then restores the session's quality, render path and cap.
 */
async function benchmarkProfiles(
  sceneName: string,
  play: PlayProbe,
  run: (line: string) => Promise<FeatureTestCheckCommandResult>,
  deps: FeatureTestCheckDeps,
  signal: AbortSignal,
  limits: FeatureTestCheckTimeouts,
): Promise<FeatureTestBenchmarkSample[]> {
  const samples: FeatureTestBenchmarkSample[] = [];
  const cap = /(\d+)/.exec((await run("framecap")).output)?.[1];
  await run(`framecap ${BENCHMARK_FRAME_CAP}`);
  try {
    for (const profile of FEATURE_TEST_BENCHMARK_PROFILES) {
      deps.onProgress?.(`${sceneName}: benchmarking ${profile.label}`);
      const failed: string[] = [];
      for (const line of profile.commands) {
        const command = await run(line);
        if (!command.success) failed.push(`${line} failed: ${sentence(command.output || "no output")}`);
      }
      await deps.sleep(limits.profileSettleMs, signal);
      const cpu: number[] = [];
      const gpu: number[] = [];
      let sampling = true;
      const frames = deps.sampleFrames(limits.playSampleMs, signal).finally(() => { sampling = false; });
      while (sampling) {
        const rendering = play.snapshot().rendering;
        if (rendering) {
          cpu.push(rendering.cpuMs);
          if (rendering.gpuMs !== null) gpu.push(rendering.gpuMs);
        }
        await Promise.race([frames, deps.sleep(500, signal)]);
      }
      const snapshot = play.snapshot();
      const rendering = snapshot.rendering;
      samples.push({
        label: profile.label,
        frames: await frames,
        runtimeFps: play.runtimeFps(),
        cpuMs: mean(cpu),
        gpuMs: mean(gpu),
        drawCalls: snapshot.drawCalls,
        resolution: rendering ? `${rendering.width}x${rendering.height}@${rendering.scalingLevel.toFixed(2)}` : null,
        renderPath: rendering?.pipeline.effective.renderPath ?? null,
        failed,
      });
    }
  } finally {
    if (!signal.aborted) {
      await run("quality reset");
      await run("renderpath reset");
      await run(`framecap ${cap ?? 60}`);
    }
  }
  return samples;
}

function mean(values: readonly number[]): number | null {
  return values.length ? values.reduce((total, value) => total + value, 0) / values.length : null;
}

/** Ends `text` with exactly one full stop. */
function sentence(text: string): string {
  return /[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`;
}

function seconds(ms: number): string {
  return `${Math.round(ms / 1000)} s`;
}
