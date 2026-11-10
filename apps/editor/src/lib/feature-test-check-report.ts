import {
  ADD_ONE_CAP_MS,
  breakdownAdditivity,
  breakdownDelta,
  breakdownOverCap,
  breakdownSaturation,
  breakdownStep,
  breakdownWarmupDrift,
  FEATURE_TEST_BREAKDOWN_DEFAULT_METHOD,
  counterStats,
  FEATURE_TEST_BENCHMARK_PROFILES,
  frameBound,
  heldShare,
  isBreakdownBaseline,
  livePreserve,
  meanFrameMs,
  profileDelta,
  profileRanking,
  profileSavings,
  profileStep,
  PROFILE_HOLD_MARGIN,
  PROFILE_HOLD_WINDOW_MS,
  SATURATED_SHARE,
  settingsChanges,
  type BaselineDelta,
  type FeatureTestBreakdownInfo,
  type FeatureTestBreakdownMethod,
  type FeatureTestBenchmarkSample,
  type FeatureTestCheckReport,
  type FeatureTestCheckResources,
  type FeatureTestCheckSceneResult,
  type FeatureTestStoppedSession,
  type CounterStats,
  type FrameStats,
  type PlayCounters,
  type PlayPresentation,
} from "../services/feature-test-check";
import { DRAW_PASSES } from "@haptic/render";
import { clipText, formatDiagnosticEnvironment, type DiagnosticEnvironment } from "./diagnostic-info";

export type FeatureTestCheckEnvironment = DiagnosticEnvironment;
type FirstDraws = NonNullable<FeatureTestCheckSceneResult["play"]["firstDraws"]>;
type LongFrame = FirstDraws["longest"][number];

const MAX_LOG_LINES = 8;
const MAX_LONG_FRAMES = 4;
const MODE_LABELS = { quick: "Quick", full: "Full", benchmark: "Benchmark", breakdown: "Breakdown", profile: "Profile" } as const;

const clip = clipText;

function s(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

/** Counts by pass, most first: `shadows 12, objects 5`; empty without any. */
function firstDrawPasses(passes: FirstDraws["passes"] | null | undefined): string {
  return Object.entries(passes ?? {}).map(([pass, count]) => [pass, Math.round(count)] as const).filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1]).map(([pass, count]) => `${pass} ${count}`).join(", ");
}

type Programs = NonNullable<FeatureTestBenchmarkSample["programs"]>;

/**
 * The Engine's programs: each one cost a compile, and one never drawn cost it for nothing so far. `by first pass` says
 * which of a view's passes the drawn ones belong to.
 */
function programsText(programs: Programs): string {
  const passes = firstDrawPasses(programs.passes);
  return `${programs.programs} on the Engine · ${programs.neverDrawn} never drawn · ${programs.shaders} shaders, at most ${programs.mostVariants} programs of one${passes ? ` · by first pass: ${passes}` : ""}`;
}

/**
 * A frame's CPU time with its draws, clears and uniform uploads stubbed, against the normal frame's: how much of a
 * frame is the engine's own work and the state it sets, and, per draw call, what each side costs. Null where it was
 * not measured.
 */
function cpuWithoutDrawsText(counters: PlayCounters | null | undefined): string | null {
  const without = counters?.cpuMsWithoutDraws?.median, cpu = counters?.cpuMs?.median;
  if (without === undefined || cpu === undefined || cpu <= 0) return null;
  const draws = counters?.draws?.median ?? 0;
  const perDraw = draws > 0
    ? ` · per draw call ${Math.round(without / draws * 1000)} µs without and ${Math.round(Math.max(0, cpu - without) / draws * 1000)} µs for the draw`
    : "";
  return `${without.toFixed(1)} ms of ${cpu.toFixed(1)} ms a frame (${Math.round(without / cpu * 100)}%); draws, clears and uniform uploads take the rest${perDraw}`;
}

/** How many causes a report names; the rest are counted. */
const PROGRAM_SPLITS_SHOWN = 8;
/**
 * What a shader's further programs are for: each define that differs between programs of one shader with the shaders
 * it splits, most first (`+n`: that many other defines always differ with it). Null where every shader has one program.
 */
function programSplitsText(programs: Programs): string | null {
  if (!programs.splitBy.length) return null;
  const shown = programs.splitBy.slice(0, PROGRAM_SPLITS_SHOWN)
    .map((split) => `${split.define}${split.with.length ? ` (+${split.with.length})` : ""} ${split.shaders}`);
  const more = programs.splitBy.length - shown.length;
  return `${shown.join(" · ")}${more > 0 ? ` · ${more} more` : ""}`;
}

/** The draws-per-pass table of a sweep's samples, in the frame's pass order; `Draws per pass: unreported` without any. */
function drawPassTable(samples: readonly FeatureTestBenchmarkSample[], column: string, width: number): string[] {
  // Only the passes some row drew in.
  const passes = DRAW_PASSES.filter((pass) => samples.some((sample) => (sample.drawPasses?.[pass] ?? 0) > 0));
  if (!passes.length) return ["  Draws per pass: unreported"];
  const lines = ["  Draws per pass (median per frame):", `    ${pad(column, width)}${passes.map((pass) => pad(pass, Math.max(pass.length + 1, 7))).join("")}`.trimEnd()];
  for (const sample of samples) {
    if (!sample.drawPasses) continue;
    lines.push(`    ${pad(sample.label, width)}${passes.map((pass) => pad(String(Math.round(sample.drawPasses![pass] ?? 0)), Math.max(pass.length + 1, 7))).join("")}`.trimEnd());
  }
  return lines;
}

/** A long frame and what it held; time outside the Engine's frame is scripts, layout, garbage collection or waiting. */
function longFrame(frame: LongFrame): string {
  const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;
  const passes = firstDrawPasses(frame.passes);
  return `${frame.ms.toFixed(0)} ms (engine ${frame.engineMs.toFixed(0)} ms, ${count(frame.firstDraws, "first draw")}${passes ? `: ${passes}` : ""}, ${count(frame.compiles, "compile")})`;
}

/** The two report lines of a first-draw reading: the first draws, then the long frames, each named `when`. */
function firstDrawLines(first: FirstDraws, when: string): string[] {
  const passes = firstDrawPasses(first.passes);
  return [
    `  First draws ${when}: ${first.draws} (${first.loadCompiled} compiled by the load) in ${first.frames} frame${first.frames === 1 ? "" : "s"} · ${first.stalls} over 100 ms · worst ${first.worstFrameMs.toFixed(0)} ms · most ${first.mostInFrame} in a frame${passes ? ` · by pass: ${passes}` : ""}`,
    `  Long frames ${when}: ${first.longFrames} over 100 ms${first.longest.length ? ` · longest ${first.longest.slice(0, MAX_LONG_FRAMES).map(longFrame).join(", ")}` : ""}`,
  ];
}

/**
 * The Scene readiness probes while Play was sampled: how many of the frames the view drew ran one, and what they
 * cost. A probe walks every mesh, and runs again after anything joins or leaves the Scene.
 */
function readinessText(sampled: NonNullable<FeatureTestCheckSceneResult["play"]["work"]>): string {
  const { strictReadinessChecks: probes, readinessProbeMs: ms } = sampled.work;
  if (!probes) return `none in ${sampled.drawn} drawn frames`;
  const perFrame = sampled.drawn > 0 ? ` · ${(ms / sampled.drawn).toFixed(1)} ms per drawn frame` : "";
  return `${probes} in ${sampled.drawn} drawn frames · ${(ms / probes).toFixed(1)} ms each${perFrame}`;
}

function frames(stats: FrameStats | null): string {
  if (!stats) return "no frames sampled";
  return `${stats.fps.toFixed(0)} fps (p95 ${stats.p95Ms.toFixed(0)} ms, max ${stats.maxMs.toFixed(0)} ms, ${stats.stalls} stalls >100 ms)`;
}

/** A report's Breakdown method; reports without one ran add-one. */
function reportMethod(report: FeatureTestCheckReport): FeatureTestBreakdownMethod {
  return report.breakdown?.method ?? FEATURE_TEST_BREAKDOWN_DEFAULT_METHOD;
}

/**
 * A scene's Breakdown verdicts: NON-ADDITIVE when a remove-one view's step savings sum past its first baseline,
 * SATURATED when most baseline frames took 4+ intervals, OVER CAP when an add-one baseline passed `ADD_ONE_CAP_MS`.
 */
function breakdownVerdicts(
  scene: FeatureTestCheckSceneResult, method: FeatureTestBreakdownMethod,
): { nonAdditive: string[]; saturated: string | null; overCap: string | null } {
  const samples = scene.play.benchmark;
  const over = method === "add-one" ? breakdownOverCap(samples) : [];
  const nonAdditive = breakdownAdditivity(scene.name, samples, method).filter((entry) => entry.nonAdditive).map((entry) =>
    `${entry.view ? `${entry.view}: ` : ""}step savings sum to ${entry.savingsMs.toFixed(1)} ms, past the first baseline's ${entry.baselineMs.toFixed(1)} ms ${entry.basis === "gpu" ? "gpu busy" : "mean frame"}`);
  const share = breakdownSaturation(samples);
  return {
    nonAdditive,
    saturated: share !== null && share > SATURATED_SHARE ? `${(share * 100).toFixed(0)}% of baseline frames lasted 4+ display intervals` : null,
    overCap: over.length
      ? `${over.map((entry) => `${entry.label} ${entry.ms.toFixed(1)} ms${entry.basis === "frame" ? " mean frame" : ""}`).join(", ")} past the ${ADD_ONE_CAP_MS} ms add-one cap`
      : null,
  };
}

/**
 * Held frames by reason, the most first, as `20 Scene is not ready to render; 3 other`; past `limit` reasons, the rest
 * as `+N more`. Empty without one.
 */
function heldReasonsText(reasons: Readonly<Record<string, number>>, limit = Number.POSITIVE_INFINITY): string {
  const entries = Object.entries(reasons).filter(([, count]) => count > 0).sort(([, a], [, b]) => b - a);
  const shown = entries.slice(0, limit).map(([reason, count]) => `${count} ${reason.replace(/\.$/, "")}`);
  const rest = entries.length - shown.length;
  return [...shown, ...rest > 0 ? [`+${rest} more`] : []].join("; ");
}

/** Frames drawn, held (and why) and skipped while sampled, context losses, and each image sample's near-black share. */
function presentationText(presentation: PlayPresentation): string {
  const frames = presentation.frames;
  const reasons = frames ? heldReasonsText(frames.heldReasons) : "";
  const counts = frames
    ? `drawn ${frames.drawn} · held ${frames.held}${reasons ? ` (${reasons})` : ""} · skipped ${frames.skipped} (frames in flight)`
    : "no frame counts";
  const images = presentation.imageBlack.map((share) => share === null ? "no frame" : `${Math.round(share * 100)}%`).join(", ");
  return `${counts} · context losses ${presentation.contextLosses} · image near-black ${images || "not sampled"}`;
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
      const passes = firstDrawPasses(counters?.drawPasses ?? r?.drawPasses);
      if (passes) lines.push(`  Draws per pass: ${passes}`);
      const withoutDraws = cpuWithoutDrawsText(counters);
      if (withoutDraws) lines.push(`  CPU without draws: ${withoutDraws}`);
      if (r?.programs) {
        lines.push(`  Programs: ${programsText(r.programs)}`);
        const splits = programSplitsText(r.programs);
        if (splits) lines.push(`  Shaders split by define: ${splits}`);
      }
    }
    if (play.presentation) lines.push(`  Presentation: ${presentationText(play.presentation)}`);
    if (play.work) lines.push(`  Readiness probes: ${readinessText(play.work)}`);
    const first = play.firstDraws;
    const beforeSweep = play.firstDrawsBeforeSweep;
    // A sweep's quality changes first draw programs of their own: told apart from what Play first drew after its load.
    if (beforeSweep) lines.push(...firstDrawLines(beforeSweep, "after load, before the sweep"));
    if (first) lines.push(...firstDrawLines(first, beforeSweep ? "in the whole session, the sweep's quality changes included" : "after load"));
  } else if (play.status !== "not-started") {
    lines.push(`  Play: ${play.status} after ${s(play.ms)}${play.phase ? ` at ${play.phase}` : ""}`);
  }
  for (const command of play.commands) {
    lines.push(`  > ${command.line}: ${command.success ? "ok" : "FAILED"} in ${s(command.ms)}${command.output ? ` · ${clip(command.output, 160)}` : ""}`);
  }
  if (play.benchmark.length && mode === "breakdown") {
    const method = reportMethod(report);
    const first = play.benchmark.find(isBreakdownBaseline);
    const timed = play.benchmark.find((sample) => sample.gpuBusy);
    const verdicts = breakdownVerdicts(scene, method);
    const drift = breakdownWarmupDrift(play.benchmark);
    lines.push(
      `  Breakdown ${method} (60 fps cap; warm-up until steady, then a baseline before and after every step; each sampled once no shader is first drawn or compiling):`,
      `  preserveDrawingBuffer: ${preserveText(first?.settings?.["presentation.preserve"])} (live)`,
      `  Base: ${report.breakdown?.tier ?? "unknown"}`,
      `  Frames in flight: ${framesInFlightText(play.benchmark)}`,
      drift
        ? `  Warm-up drift: first window ${drift.firstMs.toFixed(1)} ms, steady ${drift.steadyMs.toFixed(1)} ms (${drift.percent >= 0 ? "+" : ""}${drift.percent.toFixed(0)}%) over ${drift.windows} windows${drift.basis === "frame" ? " (mean frame)" : " (gpu busy)"}`
        : "  Warm-up drift: unmeasured (fewer than two windows)",
      ...verdicts.nonAdditive.map((text) => `  NON-ADDITIVE: ${text}; the changes do not add up, so do not sum them`),
      ...(verdicts.saturated ? [`  SATURATED: ${verdicts.saturated}; the GPU is saturated, so a change is not that feature's own cost`] : []),
      ...(verdicts.overCap ? [`  OVER CAP: ${verdicts.overCap}; the GPU may change speed there, so changes are not costs`] : []),
      `  Legend: gpu busy = median (p95) GPU time per frame from fences, unaffected by display pacing · change = gpu busy against the baselines of the same camera around the step (a baseline's: against that camera's first; ${method === "add-one" ? "a step's is the feature's cost" : "a step's is what the feature saves"}), or mean frame time where gpu busy is missing (marked *) · vsync 1/2/3/4+ = % of frames lasting 1, 2, 3, 4+ display intervals · bound = gpu (frames over 1.5x the CPU cost), vsync (at the cap) or cpu · notes = settings the step changed and occlusion culled/tested · occluder tris · culling ms; UNEXPECTED, NOT RESTORED, UNSETTLED and OVER mark a sample not to trust`,
      `  Timing: ${timed?.gpuBusy ? `gpu busy polled every ${timed.gpuBusy.pollMs.toFixed(1)} ms (each frame up to one poll late)` : "no gpu busy (no fences)"}`,
      `    ${pad("Step", 22)}${pad("fps", 5)}${pad("mean", 8)}${pad("p95", 7)}${pad("vsync 1/2/3/4+", 16)}${pad("gpu busy", 14)}${pad("change", 18)}${pad("cpu", 8)}${pad("bound", 6)}${pad("draws", 14)}notes`);
    for (const sample of play.benchmark) {
      const delta = breakdownDelta(play.benchmark, sample);
      const change = delta
        ? `${delta.ms >= 0 ? "+" : ""}${delta.ms.toFixed(1)}ms ${delta.percent >= 0 ? "+" : ""}${delta.percent.toFixed(0)}%${delta.basis === "frame" ? "*" : ""}`
        : "-";
      const mean = meanFrameMs(sample.frames);
      const vsync = sample.frames?.vsync.map((share) => (share * 100).toFixed(0)).join("/") ?? "-";
      const busy = sample.gpuBusy ? `${sample.gpuBusy.medianMs.toFixed(1)} (${sample.gpuBusy.p95Ms.toFixed(0)})` : "-";
      const viewFirst = play.benchmark.find((entry) => isBreakdownBaseline(entry) && entry.view === sample.view) ?? first;
      const notes = [
        sample.warmup ? "warm-up" : "", breakdownNotes(scene.name, method, play.benchmark, sample, viewFirst), occlusionText(sample),
      ].filter(Boolean).join(" · ");
      lines.push(`    ${pad(sample.label, 22)}${pad(sample.frames ? sample.frames.fps.toFixed(0) : "-", 5)}${pad(mean !== null ? `${mean.toFixed(1)}ms` : "-", 8)}${pad(sample.frames ? `${sample.frames.p95Ms.toFixed(0)}ms` : "-", 7)}${pad(vsync, 16)}${pad(busy, 14)}${pad(change, 18)}${pad(ms(sample.cpuMs), 8)}${pad(frameBound(sample.frames, sample.cpuMs) ?? "-", 6)}${pad(sample.skipped ? "-" : sample.draws ? rangeText(sample.draws, 0) : String(sample.drawCalls), 14)}${notes}`.trimEnd());
    }
  } else if (play.benchmark.length && mode === "profile") {
    lines.push(...profileLines(scene));
  } else if (play.benchmark.length) {
    lines.push("  Benchmark (frame cap lifted):", `  Frames in flight: ${framesInFlightText(play.benchmark)}`, `    ${pad("Profile", 18)}${pad("fps", 6)}${pad("p95", 8)}${pad("cpu", 20)}${pad("gpu", 20)}${pad("draws", 14)}resolution`);
    for (const sample of play.benchmark) {
      lines.push(`    ${pad(sample.label, 18)}${pad(sample.frames ? sample.frames.fps.toFixed(0) : "-", 6)}${pad(sample.frames ? `${sample.frames.p95Ms.toFixed(0)}ms` : "-", 8)}${pad(msText(sample.cpu), 20)}${pad(msText(sample.gpu), 20)}${pad(sample.draws ? rangeText(sample.draws, 0) : String(sample.drawCalls), 14)}${sample.resolution ?? "-"}`);
    }
    lines.push(`  Highest tier at 60 fps: ${bestProfile([play.benchmark], SMOOTH) ?? "none"} · at 30 fps: ${bestProfile([play.benchmark], PLAYABLE) ?? "none"}`);
    // What each tier draws, and what it compiled: a tier that draws as much as another scales pixels only.
    lines.push(...drawPassTable(play.benchmark, "Profile", 18));
    const programs = play.benchmark.filter((sample) => sample.programs);
    if (programs.length) lines.push(`  Programs after each profile: ${programs.map((sample) => `${sample.label} ${sample.programs!.programs} (${sample.programs!.neverDrawn} never drawn)`).join(" · ")}`);
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
    ...(sample.deviceAvailableBytes != null ? [`device free ${mb(sample.deviceAvailableBytes)}`] : []),
    ...(sample.appAvailableBytes != null ? [`app headroom ${mb(sample.appAvailableBytes)}`] : []),
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
 * A measured sample's flags: shaders first drawn or compiling while it sampled, and the settings it changed against the
 * first baseline of its camera (UNEXPECTED for a field outside its step's `fields`; a baseline or warm-up window that
 * differs was NOT RESTORED), or that it changed nothing (its setting already had that value).
 */
function settingNotes(
  sample: FeatureTestBenchmarkSample, first: FeatureTestBenchmarkSample | undefined, fields: readonly string[],
): string[] {
  const notes: string[] = [];
  const unsettled = sample.unsettled;
  if (unsettled && (unsettled.firstDraws > 0 || unsettled.compiling > 0))
    notes.push(`UNSETTLED: ${unsettled.firstDraws} first drawn, ${unsettled.compiling} compiling`);
  if (first?.settings && sample.settings && sample !== first) {
    const changes = settingsChanges(first.settings, sample.settings);
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
  return notes;
}

/**
 * A Breakdown step's flags (`settingNotes`), or why it was skipped; for a water detail step the FFT grid it ran, for an
 * add-one step that includes another its cost beyond that one, and an add-one step past the cap.
 */
function breakdownNotes(
  sceneName: string,
  method: FeatureTestBreakdownMethod,
  samples: readonly FeatureTestBenchmarkSample[],
  sample: FeatureTestBenchmarkSample,
  first: FeatureTestBenchmarkSample | undefined,
): string {
  if (sample.skipped) return `skipped (${sample.skipped})`;
  const step = isBreakdownBaseline(sample) || sample.warmup ? undefined : breakdownStep(sceneName, sample.label, method);
  const notes = settingNotes(sample, first, step?.fields ?? []);
  // The FFT grid a water detail step ran: resolution-independent work the detail may change.
  if (step?.fields?.includes("water.fft") && sample.settings?.["water.fft"]) notes.push(`fft ${sample.settings["water.fft"]}`);
  if (step?.includes) {
    const label = sample.view ? `${sample.view} ${step.includes}` : step.includes;
    const included = samples.find((entry) => entry.label === label && entry.view === sample.view && !entry.skipped);
    const own = breakdownDelta(samples, sample);
    const part = included ? breakdownDelta(samples, included) : null;
    if (own && part && own.basis === part.basis) {
      const ms = own.ms - part.ms;
      notes.push(`own ${ms >= 0 ? "+" : ""}${ms.toFixed(1)}ms beyond ${step.includes}`);
    }
  }
  if (method === "add-one" && !sample.warmup && !isBreakdownBaseline(sample)) {
    const value = sample.gpuBusy?.medianMs ?? null;
    if (value !== null && value > ADD_ONE_CAP_MS) notes.push(`OVER ${ADD_ONE_CAP_MS} ms: the GPU may have changed speed`);
  }
  return notes.join(" · ");
}

/** A change against baselines as `-1.2ms -5%`, or `-`. */
function deltaText(delta: BaselineDelta | null): string {
  if (!delta) return "-";
  return `${delta.ms >= 0 ? "+" : ""}${delta.ms.toFixed(1)}ms ${delta.percent >= 0 ? "+" : ""}${delta.percent.toFixed(0)}%`;
}

/** Occlusion culling while sampled, as `stat draws` shows it. */
function occlusionText(sample: FeatureTestBenchmarkSample): string {
  return sample.occlusion
    ? `occlusion culled ${sample.occlusion.culled}/${sample.occlusion.tested} · ${sample.occlusion.triangles} tris · ${sample.occlusion.ms.toFixed(2)} ms`
    : "";
}

/**
 * A Profile row's world renderer work per drawn frame while sampled (`work`): strict readiness checks, outline-only
 * checks and shadow admissions with their time, and the graph builds in the window; the counters that grew.
 */
function workText(sample: FeatureTestBenchmarkSample): string {
  const work = sample.work;
  const drawn = sample.presentation?.drawn;
  if (!work || !drawn) return "";
  const perFrame = (value: number) => (value / drawn).toFixed(1);
  const parts = [
    work.strictReadinessChecks ? `${perFrame(work.strictReadinessChecks)} readiness checks (${perFrame(work.readinessProbeMs)} ms)` : "",
    work.outlineReadinessChecks ? `${perFrame(work.outlineReadinessChecks)} outline checks` : "",
    work.shadowAdmissions ? `${perFrame(work.shadowAdmissions)} shadow admissions (${perFrame(work.shadowAdmissionMs)} ms)` : "",
  ].filter(Boolean);
  const builds = work.graphBuilds ? `${work.graphBuilds} graph ${work.graphBuilds === 1 ? "build" : "builds"}` : "";
  return [parts.length ? `work/frame: ${parts.join(", ")}` : "", builds].filter(Boolean).join(" · ");
}

/** A Profile row's native memory counters as it ended (`memory`): the device's free memory and the app's headroom. */
function memoryText(sample: FeatureTestBenchmarkSample): string {
  const memory = sample.memory;
  if (!memory) return "";
  return [
    memory.deviceAvailableBytes !== null ? `device free ${mb(memory.deviceAvailableBytes)}` : "",
    memory.appAvailableBytes !== null ? `app headroom ${mb(memory.appAvailableBytes)}` : "",
  ].filter(Boolean).join(" · ");
}

/** Reasons a Profile row prints for its held frames. */
const PROFILE_ROW_HELD_REASONS = 2;

/**
 * A Profile row's flags (`settingNotes`), `no setting changed` for a step whose setting already had its value, overlaps,
 * and why it held frames while sampled (its top reasons).
 */
function profileNotes(sample: FeatureTestBenchmarkSample, first: FeatureTestBenchmarkSample | undefined): string {
  if (sample.skipped) return `no setting changed (${sample.skipped})`;
  const step = isBreakdownBaseline(sample) || sample.warmup ? undefined : profileStep(sample.label);
  const reasons = sample.presentation?.held ? heldReasonsText(sample.presentation.heldReasons, PROFILE_ROW_HELD_REASONS) : "";
  return [
    sample.warmup ? "warm-up" : "", ...settingNotes(sample, first, step?.fields ?? []), step?.overlaps ? "overlaps" : "",
    occlusionText(sample), workText(sample), memoryText(sample), reasons ? `held: ${reasons}` : "",
  ].filter(Boolean).join(" · ");
}

function percent(share: number): string {
  return `${Math.round(share * 100)}%`;
}

/** The share of its attempts a sample's view held while sampled, as `23%`, or `-` unmeasured. */
function heldShareText(sample: FeatureTestBenchmarkSample): string {
  const share = sample.presentation ? heldShare(sample.presentation) : null;
  return share === null ? "-" : percent(share);
}

/** The scene's own hold rate from a Profile's warm-up, and what each step's wait allows against it. */
function holdRateText(rate: NonNullable<FeatureTestCheckSceneResult["play"]["profile"]>["holdRate"]): string {
  if (!rate) return "unmeasured (no presentation counts)";
  return `the warm-up held ${rate.heldPerSecond.toFixed(1)} frames/s, ${percent(rate.share)} of attempts; each step waits for a ${PROFILE_HOLD_WINDOW_MS / 1000} s window holding at most ${percent(rate.share + PROFILE_HOLD_MARGIN)} (+${Math.round(PROFILE_HOLD_MARGIN * 100)} points)`;
}

/** The instance pool line: groups, pooled members and retained empty groups. */
function instancePoolText(pool: NonNullable<FeatureTestCheckSceneResult["play"]["profile"]>["instancePool"]): string {
  if (!pool) return "unreported";
  return `${pool.groups} groups · ${pool.pooled} pooled · ${pool.retained} retained empty`;
}

/** A Profile's section: settings, pool, restore check, the rows, their draws per pass, and the steps ranked by saving. */
function profileLines(scene: FeatureTestCheckSceneResult): string[] {
  const samples = scene.play.benchmark;
  const profile = scene.play.profile;
  const first = samples.find(isBreakdownBaseline);
  const drift = breakdownWarmupDrift(samples);
  const timed = samples.find((sample) => sample.gpuBusy);
  const lines = [
    "  Profile at the session's quality tier and frame cap (a short warm-up, then a baseline before and after every step; each sampled 5 s with gpubusy once no shader is first drawn or compiling):",
    `  Settings: ${first?.settings ? Object.entries(first.settings).map(([field, value]) => `${field} ${value}`).join(" · ") : "unknown"}`,
    `  Frames in flight: ${framesInFlightText(samples)}`,
    drift
      ? `  Warm-up drift: first window ${drift.firstMs.toFixed(1)} ms, steady ${drift.steadyMs.toFixed(1)} ms (${drift.percent >= 0 ? "+" : ""}${drift.percent.toFixed(0)}%) over ${drift.windows} windows${drift.basis === "frame" ? " (mean frame)" : " (gpu busy)"}`
      : "  Warm-up drift: unmeasured (fewer than two windows)",
    `  Instance pool: ${instancePoolText(profile?.instancePool ?? null)}`,
    `  Hold rate: ${holdRateText(profile?.holdRate ?? null)}`,
    profile?.endChanges
      ? profile.endChanges.length ? `  NOT RESTORED at the end: ${profile.endChanges.join(", ")}` : "  Restored: every setting as before the first step"
      : "  Restored: not checked",
    "  Legend: mean, p95 = frame time · cpu = median CPU frame cost · gpu busy = median (p95) GPU time per frame from fences · bound = gpu (frames over 1.5x the CPU cost), vsync (at 60 Hz) or cpu · draws = median (range) per frame · held = share of the view's attempts it held while sampled (notes: the top reasons) · work/frame = the world renderer's strict readiness checks, outline checks and shadow admissions (their ms) per drawn frame, and its graph builds while sampled · device free, app headroom = the device's free and inactive memory (it falls as the web content and GPU processes grow) and what the app process may still allocate, as the sample ended · frame, cpu change = against the baselines around the step (a baseline's: against the first) · overlaps = its saving is part of another step's; UNEXPECTED, NOT RESTORED and UNSETTLED mark a row not to trust",
    `  Timing: ${timed?.gpuBusy ? `gpu busy polled every ${timed.gpuBusy.pollMs.toFixed(1)} ms (each frame up to one poll late)` : "no gpu busy (no fences)"}`,
    `    ${pad("Step", 22)}${pad("fps", 5)}${pad("mean", 8)}${pad("p95", 7)}${pad("cpu", 8)}${pad("gpu busy", 14)}${pad("bound", 6)}${pad("draws", 14)}${pad("held", 6)}${pad("frame change", 16)}${pad("cpu change", 16)}notes`,
  ];
  for (const sample of samples) {
    const mean = meanFrameMs(sample.frames);
    const busy = sample.gpuBusy ? `${sample.gpuBusy.medianMs.toFixed(1)} (${sample.gpuBusy.p95Ms.toFixed(0)})` : "-";
    const change = profileDelta(samples, sample);
    lines.push(`    ${pad(sample.label, 22)}${pad(sample.frames ? sample.frames.fps.toFixed(0) : "-", 5)}${pad(mean !== null ? `${mean.toFixed(1)}ms` : "-", 8)}${pad(sample.frames ? `${sample.frames.p95Ms.toFixed(0)}ms` : "-", 7)}${pad(ms(sample.cpuMs), 8)}${pad(busy, 14)}${pad(frameBound(sample.frames, sample.cpuMs) ?? "-", 6)}${pad(sample.skipped ? "-" : sample.draws ? rangeText(sample.draws, 0) : String(sample.drawCalls), 14)}${pad(heldShareText(sample), 6)}${pad(deltaText(change.frame), 16)}${pad(deltaText(change.cpu), 16)}${profileNotes(sample, first)}`.trimEnd());
  }
  lines.push(...drawPassTable(samples, "Step", 22));
  const ranking = profileRanking(samples);
  lines.push("  Ranked by frame-time saving:");
  ranking.forEach((entry, index) => lines.push(
    `    ${index + 1}. ${entry.label}: frame ${deltaText(entry.frame)} · cpu ${deltaText(entry.cpu)}${entry.overlaps ? " · overlaps" : ""}`,
  ));
  if (!ranking.length) lines.push("    none measured");
  const savings = profileSavings(samples);
  if (savings) lines.push(`  Steps that overlap no other save ${savings.savingsMs.toFixed(1)} ms of the first baseline's ${savings.frameMs.toFixed(1)} ms frame`);
  return lines;
}

/** A counter's median over the sample, with its range when the samples differ. */
function rangeText(stats: CounterStats, digits: number): string {
  const text = (value: number) => value.toFixed(digits);
  return stats.min === stats.max ? text(stats.median) : `${text(stats.median)} (${text(stats.min)}-${text(stats.max)})`;
}

/** A frame cost's median and range in ms, or "-" where it was not measured. */
function msText(stats: CounterStats | null | undefined): string {
  return stats ? `${rangeText(stats, 1)}ms` : "-";
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
  if (!breakdown.ab) {
    const stored = breakdown.passes[0]?.preserveDrawingBuffer;
    return [
      `Breakdown: ${breakdown.method} · base ${breakdown.tier} · preserveDrawingBuffer ${stored === undefined ? "unknown" : stored ? "on" : "off"} (stored setting; no A/B)`,
      ...breakdown.notes,
    ];
  }
  const lines = [`Breakdown: ${breakdown.method} · base ${breakdown.tier} · preserveDrawingBuffer A/B: ${passes || "no pass"} (stored setting; each pass's live value below)`];
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
  const verdicts = report.mode === "breakdown" ? report.scenes.map((scene) => breakdownVerdicts(scene, reportMethod(report))) : [];
  const flags = [
    ...(report.scenes.some((scene) => scene.play.profile?.endChanges?.length) ? [" · NOT RESTORED"] : []),
    ...(verdicts.some((entry) => entry.nonAdditive.length) ? [" · NON-ADDITIVE"] : []),
    ...(verdicts.some((entry) => entry.saturated) ? [" · SATURATED"] : []),
    ...(verdicts.some((entry) => entry.overCap) ? [" · OVER CAP"] : []),
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
  for (const session of report.stoppedSessions ?? []) lines.push("", ...stoppedSessionLines(session));
  return lines.join("\n").trimEnd();
}

/** Stages of a stopped session's trail a report lists: its last ones. */
const MAX_TRAIL_LINES = 24;

/**
 * A session that stopped without closing: when it was last alive, and the stages it passed through last, each with
 * how long before that moment it was reached.
 */
function stoppedSessionLines(session: FeatureTestStoppedSession): string[] {
  const marks = session.marks.slice(-MAX_TRAIL_LINES);
  const omitted = session.marks.length - marks.length;
  return [
    `A session stopped without closing (a freeze, a crash or a force close), last alive ${new Date(session.lastAliveAt).toISOString()}.`,
    `Its last stages, each with how long before that it was reached${omitted ? ` (${omitted} earlier omitted)` : ""}:`,
    ...marks.map((mark) => `  ${s(Math.max(0, session.lastAliveAt - mark.at)).padStart(8)}  ${clip(mark.stage)}`),
  ];
}

/** The GPU backpressure mode the samples ran under (`framesinflight`) and the renders it skipped while they sampled. */
function framesInFlightText(samples: readonly { framesInFlight?: { mode: "off" | 2 | 3; skipped: number } }[]): string {
  const measured = samples.filter((sample) => sample.framesInFlight);
  if (!measured.length) return "not measured";
  const modes = [...new Set(measured.map((sample) => String(sample.framesInFlight!.mode)))];
  const skipped = measured.reduce((sum, sample) => sum + sample.framesInFlight!.skipped, 0);
  return `${modes.join(", ")} (${skipped} renders skipped while sampling)`;
}
