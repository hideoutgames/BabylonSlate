import {
  FEATURE_TEST_BENCHMARK_PROFILES,
  type FeatureTestBenchmarkSample,
  type FeatureTestCheckReport,
  type FeatureTestCheckSceneResult,
  type FrameStats,
} from "../services/feature-test-check";
import { clipText, formatDiagnosticEnvironment, type DiagnosticEnvironment } from "./diagnostic-info";

export type FeatureTestCheckEnvironment = DiagnosticEnvironment;

const MAX_LOG_LINES = 8;
const MODE_LABELS = { quick: "Quick", full: "Full", benchmark: "Benchmark" } as const;

const clip = clipText;

function s(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

function frames(stats: FrameStats | null): string {
  if (!stats) return "no frames sampled";
  return `${stats.fps.toFixed(0)} fps (p95 ${stats.p95Ms.toFixed(0)} ms, max ${stats.maxMs.toFixed(0)} ms, ${stats.stalls} stalls >100 ms)`;
}

function sceneLines(scene: FeatureTestCheckSceneResult): string[] {
  const lines = [`[${scene.passed ? "PASS" : "FAIL"}] ${scene.name}`];
  for (const problem of scene.problems) lines.push(`  ! ${problem}`);
  const editor = scene.editor;
  lines.push(editor.status === "ready"
    ? `  Editor: ready in ${s(editor.ms)} · ${frames(editor.frames)}`
    : `  Editor: ${editor.status} after ${s(editor.ms)}${editor.phase ? ` at ${editor.phase}` : ""}`);
  const play = scene.play;
  if (play.status === "loaded") {
    lines.push(`  Play: loaded in ${s(play.ms)} · ${frames(play.frames)}${play.runtimeFps !== null ? ` · runtime ${play.runtimeFps.toFixed(0)} fps` : ""}`);
    const snap = play.snapshot;
    if (snap) {
      const r = snap.rendering;
      lines.push(`  Render: draws ${snap.drawCalls} · meshes ${snap.meshes} · textures ${snap.textures} · memory ${Math.round(snap.accountedBytes / 1048576)} MB${r ? ` · cpu ${r.cpuMs.toFixed(1)} ms · gpu ${r.gpuMs === null ? r.gpuStatus : `${r.gpuMs.toFixed(1)} ms`} · ${r.width}x${r.height} @${r.scalingLevel.toFixed(2)} · ${r.pipeline.effective.renderPath}` : ""}`);
      if (r?.qualityLimits.length) lines.push(`  Quality limits: ${clip(r.qualityLimits.join("; "))}`);
    }
  } else if (play.status !== "not-started") {
    lines.push(`  Play: ${play.status} after ${s(play.ms)}${play.phase ? ` at ${play.phase}` : ""}`);
  }
  for (const command of play.commands) {
    lines.push(`  > ${command.line}: ${command.success ? "ok" : "FAILED"} in ${s(command.ms)}${command.output ? ` · ${clip(command.output, 160)}` : ""}`);
  }
  if (play.benchmark.length) {
    lines.push("  Benchmark (frame cap lifted):", `    ${pad("Profile", 18)}${pad("fps", 6)}${pad("p95", 8)}${pad("cpu", 8)}${pad("gpu", 8)}${pad("draws", 7)}resolution`);
    for (const sample of play.benchmark) {
      lines.push(`    ${pad(sample.label, 18)}${pad(sample.frames ? sample.frames.fps.toFixed(0) : "-", 6)}${pad(sample.frames ? `${sample.frames.p95Ms.toFixed(0)}ms` : "-", 8)}${pad(ms(sample.cpuMs), 8)}${pad(ms(sample.gpuMs), 8)}${pad(String(sample.drawCalls), 7)}${sample.resolution ?? "-"}${ranInstead(sample)}`);
    }
    lines.push(`  Highest tier at 60 fps: ${bestProfile([play.benchmark], SMOOTH) ?? "none"} · at 30 fps: ${bestProfile([play.benchmark], PLAYABLE) ?? "none"}`);
  }
  const session = scene.session;
  if (session) {
    const textures = session.textures;
    lines.push(`  Session: ${session.runtimeMode ?? "unknown"} runtime · ${session.diagnostics.length} report entr${session.diagnostics.length === 1 ? "y" : "ies"}${session.droppedDiagnostics ? ` (+${session.droppedDiagnostics} dropped)` : ""}${textures ? ` · textures ${textures.before}→${textures.after ?? "?"}${textures.leak ? " LEAK" : ""}` : ""}`);
    for (const entry of session.diagnostics.slice(0, MAX_LOG_LINES)) {
      lines.push(`    [${entry.severity}] ${entry.code} x${entry.count}: ${clip(entry.message)}${entry.assetGuid ? ` @${entry.assetGuid}` : ""}${entry.nodeId ? `/${entry.nodeId}` : ""}`);
    }
  }
  const logs = play.logs.slice(-MAX_LOG_LINES);
  if (logs.length) {
    lines.push(`  Play log (last ${logs.length} of ${play.logs.length} errors/warnings):`);
    for (const entry of logs) lines.push(`    [${entry.severity}] ${clip(entry.message)}`);
  }
  return lines;
}

/** Notes when the engine fell back from the requested render path. */
function ranInstead(sample: FeatureTestBenchmarkSample): string {
  const requested = sample.label.endsWith("clustered") ? "clusteredForward" : "forward";
  return sample.renderPath && sample.renderPath !== requested ? ` (ran ${sample.renderPath})` : "";
}

function pad(text: string, width: number): string {
  return text.length >= width ? `${text} ` : text.padEnd(width);
}

function ms(value: number | null): string {
  return value === null ? "-" : `${value.toFixed(1)}ms`;
}

type FrameTarget = { fps: number; p95Ms: number };
/** 60 fps with headroom for vsync jitter, and a steady 30 fps. */
const SMOOTH: FrameTarget = { fps: 55, p95Ms: 25 };
const PLAYABLE: FrameTarget = { fps: 28, p95Ms: 45 };

function meets(sample: FeatureTestBenchmarkSample | undefined, target: FrameTarget): boolean {
  return Boolean(sample?.frames && !sample.failed.length && sample.frames.fps >= target.fps && sample.frames.p95Ms <= target.p95Ms);
}

/** Highest forward quality tier that meets `target` in every sweep, or null. */
function bestProfile(sweeps: ReadonlyArray<readonly FeatureTestBenchmarkSample[]>, target: FrameTarget): string | null {
  let best: string | null = null;
  for (const { label } of FEATURE_TEST_BENCHMARK_PROFILES.filter((profile) => profile.label.endsWith("forward"))) {
    if (sweeps.every((sweep) => meets(sweep.find((sample) => sample.label === label), target))) best = label;
  }
  return best;
}

/** Plain-text report sized for pasting into a chat or issue. */
export function formatFeatureTestCheckReport(report: FeatureTestCheckReport, environment: FeatureTestCheckEnvironment): string {
  const passed = report.scenes.filter((scene) => scene.passed).length;
  const adapter = report.scenes.map((scene) => scene.play.snapshot?.rendering?.adapter).find(Boolean);
  const pipeline = report.scenes.map((scene) => scene.play.snapshot?.rendering?.pipeline.effective).find(Boolean);
  const lines = [
    `BabylonSlate Feature Test Check (${MODE_LABELS[report.mode]}) · ${new Date(report.startedAt).toISOString()}`,
    `Result: ${passed}/${report.scenes.length} scenes passed${report.cancelled ? " · CANCELLED" : ""} · took ${s(report.durationMs)}`,
    ...formatDiagnosticEnvironment(environment),
    `GPU: ${adapter ? `${adapter.api} · ${adapter.vendor ?? "?"} · ${adapter.renderer ?? "?"}` : "unknown (Play did not start)"}${pipeline ? ` · ${pipeline.gpuBackend} ${pipeline.renderPath}` : ""}`,
  ];
  const sweeps = report.scenes.map((scene) => scene.play.benchmark).filter((sweep) => sweep.length);
  if (report.mode === "benchmark") {
    lines.push(sweeps.length
      ? `Benchmark: highest tier every benchmarked scene holds at 60 fps: ${bestProfile(sweeps, SMOOTH) ?? "none"} · at 30 fps: ${bestProfile(sweeps, PLAYABLE) ?? "none"} (${sweeps.length}/${report.scenes.length} scenes benchmarked)`
      : "Benchmark: no scene reached Play");
  }
  lines.push("");
  for (const scene of report.scenes) lines.push(...sceneLines(scene), "");
  if (report.pageErrors.length) {
    lines.push(`Page errors (${report.pageErrors.length}):`);
    for (const error of report.pageErrors.slice(0, MAX_LOG_LINES)) lines.push(`  ${clip(error)}`);
  }
  return lines.join("\n").trimEnd();
}
