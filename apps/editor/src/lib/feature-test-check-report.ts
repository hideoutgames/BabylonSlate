import type { FeatureTestCheckReport, FeatureTestCheckSceneResult, FrameStats } from "../services/feature-test-check";

export interface FeatureTestCheckEnvironment {
  appVersion: string;
  buildLabel?: string;
  userAgent: string;
  platform: string;
  touchPoints: number;
  devicePixelRatio: number;
  screen: string;
  viewport: string;
  cores: number | null;
  memoryGb: number | null;
}

/** Device facts that help reproduce a report; never includes project content or identifiers. */
export function collectFeatureTestCheckEnvironment(appVersion: string, buildLabel?: string): FeatureTestCheckEnvironment {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string }; deviceMemory?: number };
  return {
    appVersion,
    buildLabel,
    userAgent: nav.userAgent,
    platform: nav.userAgentData?.platform || nav.platform || "unknown",
    touchPoints: nav.maxTouchPoints ?? 0,
    devicePixelRatio: window.devicePixelRatio,
    screen: `${window.screen.width}x${window.screen.height}`,
    viewport: `${window.innerWidth}x${window.innerHeight}`,
    cores: nav.hardwareConcurrency || null,
    memoryGb: nav.deviceMemory ?? null,
  };
}

const MAX_LOG_LINES = 8;
const MAX_TEXT = 240;

function clip(text: string, max = MAX_TEXT): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

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
    lines.push(`  > ${command.line}: ${command.success ? "ok" : "FAILED"}${command.output ? ` · ${clip(command.output, 160)}` : ""}`);
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

/** Plain-text report sized for pasting into a chat or issue. */
export function formatFeatureTestCheckReport(report: FeatureTestCheckReport, environment: FeatureTestCheckEnvironment): string {
  const passed = report.scenes.filter((scene) => scene.passed).length;
  const adapter = report.scenes.map((scene) => scene.play.snapshot?.rendering?.adapter).find(Boolean);
  const pipeline = report.scenes.map((scene) => scene.play.snapshot?.rendering?.pipeline.effective).find(Boolean);
  const lines = [
    `BabylonSlate Feature Test Check (${report.mode === "full" ? "Full" : "Quick"}) · ${new Date(report.startedAt).toISOString()}`,
    `Result: ${passed}/${report.scenes.length} scenes passed${report.cancelled ? " · CANCELLED" : ""} · took ${s(report.durationMs)}`,
    `App: ${environment.appVersion || "dev"}${environment.buildLabel ? ` (${environment.buildLabel})` : ""}`,
    `Device: ${environment.platform} · touch ${environment.touchPoints} · DPR ${environment.devicePixelRatio} · screen ${environment.screen} · viewport ${environment.viewport} · cores ${environment.cores ?? "?"} · memory ${environment.memoryGb === null ? "?" : `${environment.memoryGb} GB`}`,
    `Browser: ${clip(environment.userAgent, 300)}`,
    `GPU: ${adapter ? `${adapter.api} · ${adapter.vendor ?? "?"} · ${adapter.renderer ?? "?"}` : "unknown (Play did not start)"}${pipeline ? ` · ${pipeline.gpuBackend} ${pipeline.renderPath}` : ""}`,
    "",
  ];
  for (const scene of report.scenes) lines.push(...sceneLines(scene), "");
  if (report.pageErrors.length) {
    lines.push(`Page errors (${report.pageErrors.length}):`);
    for (const error of report.pageErrors.slice(0, MAX_LOG_LINES)) lines.push(`  ${clip(error)}`);
  }
  return lines.join("\n").trimEnd();
}
