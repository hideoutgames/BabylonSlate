import {
  breakdownAdditivity,
  breakdownDelta,
  breakdownSaturation,
  breakdownStep,
  counterStats,
  FEATURE_TEST_BENCHMARK_PROFILES,
  frameBound,
  isBreakdownBaseline,
  livePreserve,
  meanFrameMs,
  SATURATED_SHARE,
  settingsChanges,
  type FeatureTestBreakdownInfo,
  type FeatureTestBenchmarkSample,
  type FeatureTestCheckReport,
  type FeatureTestCheckResources,
  type FeatureTestCheckSceneResult,
  type CounterStats,
  type FrameStats,
} from "../services/feature-test-check";
import { clipText, formatDiagnosticEnvironment, type DiagnosticEnvironment } from "./diagnostic-info";

export type FeatureTestCheckEnvironment = DiagnosticEnvironment;
type LongFrame = NonNullable<FeatureTestCheckSceneResult["play"]["firstDraws"]>["longest"][number];

const MAX_LOG_LINES = 8;
const MAX_LONG_FRAMES = 4;
const MODE_LABELS = { quick: "Quick", full: "Full", benchmark: "Benchmark", breakdown: "Breakdown" } as const;

const clip = clipText;

function s(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

/** A long frame and what it held; time outside the Engine's frame is scripts, layout, garbage collection or waiting. */
function longFrame(frame: LongFrame): string {
  const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;
  return `${frame.ms.toFixed(0)} ms (engine ${frame.engineMs.toFixed(0)} ms, ${count(frame.firstDraws, "first draw")}, ${count(frame.compiles, "compile")})`;
}

function frames(stats: FrameStats | null): string {
  if (!stats) return "no frames sampled";
  return `${stats.fps.toFixed(0)} fps (p95 ${stats.p95Ms.toFixed(0)} ms, max ${stats.maxMs.toFixed(0)} ms, ${stats.stalls} stalls >100 ms)`;
}

/** A scene's Breakdown verdicts: NON-ADDITIVE when a view's step savings sum past its first baseline, SATURATED when most baseline frames took 4+ intervals. */
function breakdownVerdicts(scene: FeatureTestCheckSceneResult): { nonAdditive: string[]; saturated: string | null } {
  const samples = scene.play.benchmark;
  const nonAdditive = breakdownAdditivity(scene.name, samples).filter((entry) => entry.nonAdditive).map((entry) =>
    `${entry.view ? `${entry.view}: ` : ""}step savings sum to ${entry.savingsMs.toFixed(1)} ms, past the first baseline's ${entry.baselineMs.toFixed(1)} ms ${entry.basis === "gpu" ? "gpu busy" : "mean frame"}`);
  const share = breakdownSaturation(samples);
  return {
    nonAdditive,
    saturated: share !== null && share > SATURATED_SHARE ? `${(share * 100).toFixed(0)}% of baseline frames lasted 4+ display intervals` : null,
  };
}

function sceneLines(scene: FeatureTestCheckSceneResult, report: FeatureTestCheckReport): string[] {
  const mode = report.mode;
  const lines = [`[${scene.passed ? "PASS" : "FAIL"}] ${scene.name}`];
  for (const problem of scene.problems) lines.push(`  ! ${problem}`);
  const editor = scene.editor;
  lines.push(editor.status === "ready"
    ? `  Editor: ready in ${s(editor.ms)} · ${frames(editor.frames)}`
    : `  Editor: ${editor.status} after ${s(editor.ms)}${editor.phase ? ` at ${editor.phase}` : ""}`);
  if (editor.error) lines.push("  Editor error:", ...editor.error.map((line) => `    ${line}`));
  const play = scene.play;
  if (play.status === "loaded") {
    lines.push(`  Play: loaded in ${s(play.ms)} · ${frames(play.frames)}${play.runtimeFps !== null ? ` · runtime ${play.runtimeFps.toFixed(0)} fps` : ""}`);
    const snap = play.snapshot;
    if (snap) {
      const r = snap.rendering;
      const counters = play.counters;
      const cpu = counters?.cpuMs ? `${rangeText(counters.cpuMs, 1)} ms` : r ? `${r.cpuMs.toFixed(1)} ms` : null;
      const gpu = counters?.gpuMs ? `${rangeText(counters.gpuMs, 1)} ms` : r ? r.gpuMs === null ? r.gpuStatus : `${r.gpuMs.toFixed(1)} ms` : null;
      lines.push(`  Render: draws ${counters?.draws ? rangeText(counters.draws, 0) : snap.drawCalls} · meshes ${snap.meshes} · textures ${snap.textures} · memory ${Math.round(snap.accountedBytes / 1048576)} MB${r ? ` · cpu ${cpu} · gpu ${gpu} · ${r.width}x${r.height} @${r.scalingLevel.toFixed(2)}` : ""}`);
      if (r?.qualityLimits.length) lines.push(`  Quality limits: ${clip(r.qualityLimits.join("; "))}`);
    }
    const first = play.firstDraws;
    if (first) {
      lines.push(`  First draws after load: ${first.draws} (${first.loadCompiled} compiled by the load) in ${first.frames} frame${first.frames === 1 ? "" : "s"} · ${first.stalls} over 100 ms · worst ${first.worstFrameMs.toFixed(0)} ms · most ${first.mostInFrame} in a frame`);
      lines.push(`  Long frames after load: ${first.longFrames} over 100 ms${first.longest.length ? ` · longest ${first.longest.slice(0, MAX_LONG_FRAMES).map(longFrame).join(", ")}` : ""}`);
    }
  } else if (play.status !== "not-started") {
    lines.push(`  Play: ${play.status} after ${s(play.ms)}${play.phase ? ` at ${play.phase}` : ""}`);
  }
  for (const command of play.commands) {
    lines.push(`  > ${command.line}: ${command.success ? "ok" : "FAILED"} in ${s(command.ms)}${command.output ? ` · ${clip(command.output, 160)}` : ""}`);
  }
  if (play.benchmark.length && mode === "breakdown") {
    const first = play.benchmark.find(isBreakdownBaseline);
    const timed = play.benchmark.find((sample) => sample.gpuBusy);
    const verdicts = breakdownVerdicts(scene);
    lines.push(
      "  Breakdown (60 fps cap; warm-up until steady, then a baseline before and after every step; each sampled once no shader is first drawn or compiling):",
      `  preserveDrawingBuffer: ${preserveText(first?.settings?.["presentation.preserve"])} (live)`,
      `  Tier: ${report.breakdown?.tier ?? "unknown"} (resolution kept at the project's fixed scale)`,
      ...verdicts.nonAdditive.map((text) => `  NON-ADDITIVE: ${text}; the changes do not add up, so do not sum them`),
      ...(verdicts.saturated ? [`  SATURATED: ${verdicts.saturated}; the GPU is saturated, so a change is not that feature's own cost`] : []),
      "  Legend: gpu busy = median (p95) GPU time per frame from fences, unaffected by display pacing · change = gpu busy against the baselines of the same camera around the step (a baseline's: against that camera's first), or mean frame time where gpu busy is missing (marked *) · vsync 1/2/3/4+ = % of frames lasting 1, 2, 3, 4+ display intervals · bound = gpu (frames over 1.5x the CPU cost), vsync (at the cap) or cpu · notes = settings the step changed and occlusion culled/tested · occluder tris · culling ms; UNEXPECTED, NOT RESTORED and UNSETTLED mark a sample not to trust",
      `  Timing: ${timed?.gpuBusy ? `gpu busy polled every ${timed.gpuBusy.pollMs.toFixed(1)} ms (each frame up to one poll late)` : "no gpu busy (no fences)"}`,
      `    ${pad("Step", 22)}${pad("fps", 5)}${pad("mean", 8)}${pad("p95", 7)}${pad("vsync 1/2/3/4+", 16)}${pad("gpu busy", 14)}${pad("change", 18)}${pad("cpu", 8)}${pad("bound", 6)}${pad("draws", 14)}notes`);
    for (const sample of play.benchmark) {
      const delta = breakdownDelta(play.benchmark, sample);
      const change = delta
        ? `${delta.ms >= 0 ? "+" : ""}${delta.ms.toFixed(1)}ms ${delta.percent >= 0 ? "+" : ""}${delta.percent.toFixed(0)}%${delta.basis === "frame" ? "*" : ""}`
        : "-";
      const mean = meanFrameMs(sample.frames);
      const vsync = sample.frames?.vsync?.map((share) => (share * 100).toFixed(0)).join("/") ?? "-";
      const busy = sample.gpuBusy ? `${sample.gpuBusy.medianMs.toFixed(1)} (${sample.gpuBusy.p95Ms.toFixed(0)})` : "-";
      const viewFirst = play.benchmark.find((entry) => isBreakdownBaseline(entry) && entry.view === sample.view) ?? first;
      const occlusion = sample.occlusion
        ? `occlusion culled ${sample.occlusion.culled}/${sample.occlusion.tested} · ${sample.occlusion.triangles} tris · ${sample.occlusion.ms.toFixed(2)} ms`
        : "";
      const notes = [sample.warmup ? "warm-up" : "", breakdownNotes(scene.name, sample, viewFirst), occlusion].filter(Boolean).join(" · ");
      lines.push(`    ${pad(sample.label, 22)}${pad(sample.frames ? sample.frames.fps.toFixed(0) : "-", 5)}${pad(mean !== null ? `${mean.toFixed(1)}ms` : "-", 8)}${pad(sample.frames ? `${sample.frames.p95Ms.toFixed(0)}ms` : "-", 7)}${pad(vsync, 16)}${pad(busy, 14)}${pad(change, 18)}${pad(ms(sample.cpuMs), 8)}${pad(frameBound(sample.frames, sample.cpuMs) ?? "-", 6)}${pad(sample.draws ? rangeText(sample.draws, 0) : String(sample.drawCalls), 14)}${notes}`.trimEnd());
    }
  } else if (play.benchmark.length) {
    lines.push("  Benchmark (frame cap lifted):", `    ${pad("Profile", 18)}${pad("fps", 6)}${pad("p95", 8)}${pad("cpu", 20)}${pad("gpu", 20)}${pad("draws", 14)}resolution`);
    for (const sample of play.benchmark) {
      lines.push(`    ${pad(sample.label, 18)}${pad(sample.frames ? sample.frames.fps.toFixed(0) : "-", 6)}${pad(sample.frames ? `${sample.frames.p95Ms.toFixed(0)}ms` : "-", 8)}${pad(msText(sample.cpu, sample.cpuMs), 20)}${pad(msText(sample.gpu, sample.gpuMs), 20)}${pad(sample.draws ? rangeText(sample.draws, 0) : String(sample.drawCalls), 14)}${sample.resolution ?? "-"}`);
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

function mb(bytes: number | null): string | null {
  return bytes === null ? null : `${Math.round(bytes / 1048576)} MB`;
}

/** One resource sample: time into the check, what the Engines held, and the step it was at. */
function resourceLine(sample: FeatureTestCheckResources): string {
  const memory = [
    `${sample.effects} shaders${sample.compiling ? ` (${sample.compiling} compiling)` : ""}`,
    ...(sample.playFrames ? [`Play drawn ${sample.playFrames.drawn}, held ${sample.playFrames.held}${sample.playFrames.contextLosses ? `, CONTEXT LOST ${sample.playFrames.contextLosses}x` : ""}`] : []),
    `${sample.textures} textures (${mb(sample.textureBytes)})`,
    ...(sample.jsHeapBytes !== null ? [`JS heap ${mb(sample.jsHeapBytes)}`] : []),
    ...(sample.appFootprintBytes !== null ? [`app ${mb(sample.appFootprintBytes)}`] : []),
  ];
  return `  ${pad(s(sample.atMs), 9)}${memory.join(" · ")} · ${clip(sample.step, 80)}`;
}

function pad(text: string, width: number): string {
  return text.length >= width ? `${text} ` : text.padEnd(width);
}

/** A live preserveDrawingBuffer value (`presentation.preserve`) as on, off, n/a (WebGPU) or unknown. */
function preserveText(value: string | undefined): string {
  if (value === undefined) return "unknown";
  if (value === "n/a") return "n/a (WebGPU)";
  return value === "true" ? "on" : value === "false" ? "off" : value;
}

/**
 * A Breakdown step's flags: shaders first drawn or compiling while it sampled, the settings it changed against the
 * first baseline of its camera (UNEXPECTED for a field outside its own; a baseline that differs was NOT RESTORED), or
 * that it changed nothing (its setting already had that value).
 */
function breakdownNotes(sceneName: string, sample: FeatureTestBenchmarkSample, first: FeatureTestBenchmarkSample | undefined): string {
  const notes: string[] = [];
  const unsettled = sample.unsettled;
  if (unsettled && (unsettled.firstDraws > 0 || unsettled.compiling > 0))
    notes.push(`UNSETTLED: ${unsettled.firstDraws} first drawn, ${unsettled.compiling} compiling`);
  if (first?.settings && sample.settings && sample !== first) {
    const changes = settingsChanges(first.settings, sample.settings);
    const fields = breakdownStep(sceneName, sample.label)?.fields ?? [];
    const field = (change: string) => change.slice(0, change.indexOf("="));
    if (isBreakdownBaseline(sample) || sample.warmup) {
      if (changes.length) notes.push(`NOT RESTORED: ${changes.join(", ")}`);
    } else {
      const own = changes.filter((change) => fields.includes(field(change)));
      const other = changes.filter((change) => !fields.includes(field(change)));
      if (own.length) notes.push(own.join(", "));
      else notes.push("no setting changed");
      if (other.length) notes.push(`UNEXPECTED: ${other.join(", ")}`);
    }
  }
  return notes.join(" · ");
}

/** A counter's median over the sample, with its range when the samples differ. */
function rangeText(stats: CounterStats, digits: number): string {
  const text = (value: number) => value.toFixed(digits);
  return stats.min === stats.max ? text(stats.median) : `${text(stats.median)} (${text(stats.min)}-${text(stats.max)})`;
}

/** A frame cost's median and range in ms, or the one value in reports saved before the range. */
function msText(stats: CounterStats | null | undefined, value: number | null): string {
  return stats ? `${rangeText(stats, 1)}ms` : ms(value);
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

/** Highest quality tier that meets `target` in every sweep, or null. */
function bestProfile(sweeps: ReadonlyArray<readonly FeatureTestBenchmarkSample[]>, target: FrameTarget): string | null {
  let best: string | null = null;
  for (const { label } of FEATURE_TEST_BENCHMARK_PROFILES) {
    if (sweeps.every((sweep) => meets(sweep.find((sample) => sample.label === label), target))) best = label;
  }
  return best;
}

/**
 * The preserveDrawingBuffer A/B's comparison: per scene and camera, the median of the baselines' GPU-busy medians in
 * the scenes measured with it on (live) against those measured with it off; null unless both were measured.
 */
function preserveComparison(scenes: readonly FeatureTestCheckSceneResult[]): string | null {
  const groups = new Map<string, { on: number[]; off: number[] }>();
  const seen = { on: false, off: false };
  for (const scene of scenes) {
    const live = livePreserve([scene]);
    if (live !== "true" && live !== "false") continue;
    const side = live === "true" ? "on" : "off";
    seen[side] = true;
    for (const sample of scene.play.benchmark) {
      if (!isBreakdownBaseline(sample) || !sample.gpuBusy) continue;
      const key = sample.view ? `${scene.name} ${sample.view}` : scene.name;
      const group = groups.get(key) ?? { on: [], off: [] };
      group[side].push(sample.gpuBusy.medianMs);
      groups.set(key, group);
    }
  }
  if (!seen.on || !seen.off) return null;
  const median = (values: number[]) => counterStats(values)?.median ?? null;
  const entries = [...groups].map(([key, group]) => {
    const on = median(group.on);
    const off = median(group.off);
    if (on === null || off === null) return `${key} ${on?.toFixed(1) ?? "-"} vs ${off?.toFixed(1) ?? "-"} ms`;
    const diff = off - on;
    const sign = diff >= 0 ? "+" : "";
    return `${key} ${on.toFixed(1)} vs ${off.toFixed(1)} ms (off ${sign}${diff.toFixed(1)} ms, ${sign}${((diff / on) * 100).toFixed(0)}%)`;
  });
  return `preserveDrawingBuffer on vs off, median baseline gpu busy: ${entries.length ? entries.join(" · ") : "no gpu busy (no fences)"}`;
}

/** A Breakdown's header lines: its tier and the A/B's passes, the on/off comparison, and how the A/B ended. */
function breakdownHeader(report: FeatureTestCheckReport, breakdown: FeatureTestBreakdownInfo): string[] {
  const passes = breakdown.passes.map((entry, index) => `pass ${index + 1} ${entry.preserveDrawingBuffer ? "on" : "off"}`).join(", ");
  const lines = [`Breakdown: tier ${breakdown.tier} · preserveDrawingBuffer A/B: ${passes || "no pass"} (stored setting; each pass's live value below)`];
  const comparison = preserveComparison(report.scenes);
  if (comparison) lines.push(comparison);
  else if (breakdown.passes.length > 1) {
    const live = livePreserve(report.scenes);
    if (live !== undefined) lines.push(`preserveDrawingBuffer on vs off: no comparison, every measured pass ran with it ${preserveText(live)} (live)`);
  }
  lines.push(...breakdown.notes);
  return lines;
}

/** Plain-text report sized for pasting into a chat or issue. */
export function formatFeatureTestCheckReport(report: FeatureTestCheckReport, environment: FeatureTestCheckEnvironment): string {
  const passed = report.scenes.filter((scene) => scene.passed).length;
  // Play reports its adapter; an editor-only failure still names the viewport's.
  const adapter = report.scenes.map((scene) => scene.play.snapshot?.rendering?.adapter).find(Boolean)
    ?? report.scenes.map((scene) => scene.editor.gpu).find(Boolean);
  const pipeline = report.scenes.map((scene) => scene.play.snapshot?.rendering?.pipeline.effective).find(Boolean);
  const breakdown = report.mode === "breakdown" ? report.breakdown : undefined;
  const verdicts = report.mode === "breakdown" ? report.scenes.map(breakdownVerdicts) : [];
  const flags = [
    ...(verdicts.some((entry) => entry.nonAdditive.length) ? [" · NON-ADDITIVE"] : []),
    ...(verdicts.some((entry) => entry.saturated) ? [" · SATURATED"] : []),
  ].join("");
  const lines = [
    `Haptic Feature Test Check (${MODE_LABELS[report.mode]}) · ${new Date(report.startedAt).toISOString()}`,
    `Result: ${passed}/${report.scenes.length} scenes passed${report.cancelled ? " · CANCELLED" : ""}${report.unfinished ? " · DID NOT FINISH" : ""}${flags} · took ${s(report.durationMs)}`,
    ...(report.unfinished ? [`Did not finish: the app stopped (a crash or reload) while ${report.unfinished.step}.`] : []),
    ...(breakdown?.warmMinutes !== null && breakdown?.warmMinutes !== undefined
      ? [`WARM DEVICE: previous run ended ${breakdown.warmMinutes} min ago`] : []),
    ...formatDiagnosticEnvironment(environment),
    `GPU: ${adapter ? `${adapter.api} · ${adapter.vendor ?? "?"} · ${adapter.renderer ?? "?"}` : "unknown (no viewport or Play engine reported one)"}${pipeline ? ` · ${pipeline.gpuBackend}` : ""}`,
  ];
  const sweeps = report.scenes.map((scene) => scene.play.benchmark).filter((sweep) => sweep.length);
  if (report.mode === "benchmark") {
    lines.push(sweeps.length
      ? `Benchmark: highest tier every benchmarked scene holds at 60 fps: ${bestProfile(sweeps, SMOOTH) ?? "none"} · at 30 fps: ${bestProfile(sweeps, PLAYABLE) ?? "none"} (${sweeps.length}/${report.scenes.length} scenes benchmarked)`
      : "Benchmark: no scene reached Play");
  }
  if (breakdown) lines.push(...breakdownHeader(report, breakdown));
  lines.push("");
  const passes = breakdown?.passes.length ?? 0;
  let pass: number | undefined;
  for (const scene of report.scenes) {
    if (passes > 1 && scene.pass !== undefined && scene.pass !== pass) {
      pass = scene.pass;
      const live = livePreserve(report.scenes.filter((entry) => entry.pass === pass));
      const stored = breakdown!.passes[pass - 1]?.preserveDrawingBuffer;
      lines.push(`Pass ${pass} of ${passes} · preserveDrawingBuffer ${live !== undefined ? `${preserveText(live)} (live)` : stored !== undefined ? `${stored ? "on" : "off"} (stored)` : "unknown"}`, "");
    }
    lines.push(...sceneLines(scene, report), "");
  }
  if (report.pageErrors.length) {
    lines.push(`Page errors (${report.pageErrors.length}):`);
    for (const error of report.pageErrors.slice(0, MAX_LOG_LINES)) lines.push(`  ${clip(error)}`);
  }
  if (report.unfinished?.resources.length) {
    lines.push("", `Resources before it stopped (last ${report.unfinished.resources.length} samples, oldest first):`);
    for (const sample of report.unfinished.resources) lines.push(resourceLine(sample));
  }
  return lines.join("\n").trimEnd();
}
