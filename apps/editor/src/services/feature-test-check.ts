import type { PlaySessionResult } from "./play-session";
import type { PlayProbe, ViewportProbe } from "./runtime-probes";

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

export type FeatureTestCheckMode = "quick" | "full";

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
}

export interface FeatureTestCheckSceneResult {
  name: string;
  path: string;
  editor: { status: "ready" | "failed" | "timeout" | "not-opened"; ms: number; phase: string | null; frames: FrameStats | null };
  play: {
    status: "loaded" | "timeout" | "closed" | "not-started" | "skipped";
    ms: number;
    phase: string | null;
    frames: FrameStats | null;
    runtimeFps: number | null;
    snapshot: ReturnType<PlayProbe["snapshot"]> | null;
    commands: FeatureTestCheckCommandResult[];
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
  editorSampleMs: number;
  playSampleMs: number;
}

export const DEFAULT_FEATURE_TEST_CHECK_TIMEOUTS: FeatureTestCheckTimeouts = {
  sceneOpenMs: 120_000,
  playLoadMs: 120_000,
  playCloseMs: 30_000,
  commandMs: 15_000,
  releaseMs: 10_000,
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
  return { mode, startedAt, durationMs: deps.now() - startedAt, cancelled, scenes, pageErrors: options.pageErrors?.() ?? [] };
}

function emptySceneResult(scene: { name: string; path: string }): FeatureTestCheckSceneResult {
  return {
    name: scene.name, path: scene.path,
    editor: { status: "not-opened", ms: 0, phase: null, frames: null },
    play: { status: "not-started", ms: 0, phase: null, frames: null, runtimeFps: null, snapshot: null, commands: [], logs: [] },
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
    for (const line of featureTestCheckCommands(scene.name, mode)) {
      deps.onProgress?.(`${scene.name}: running ${line}`);
      const outcome = await timeout(play.executeConsoleCommand(line), limits.commandMs, deps, signal)
        .catch((error: unknown) => ({ success: false, output: error instanceof Error ? error.message : String(error) }));
      const command = outcome === "timeout"
        ? { line, success: false, output: `No reply in ${seconds(limits.commandMs)}.` }
        : { line, success: outcome.success, output: outcome.output };
      result.play.commands.push(command);
      if (!command.success) result.problems.push(`Command ${line} failed: ${command.output || "no output"}.`);
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

function seconds(ms: number): string {
  return `${Math.round(ms / 1000)} s`;
}
