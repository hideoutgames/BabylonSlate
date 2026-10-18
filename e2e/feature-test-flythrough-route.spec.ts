import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type CDPSession, type Page } from "@playwright/test";
import type { FlyFrame, FlyThroughOptions, FlyThroughResult, FlyVec3 } from "../apps/editor/src/testing/flythrough-probe";
import {
  createFeatureTestProject,
  FEATURE_TEST_SCENES,
  openFeatureTestScene,
  seedEngineSettings,
  waitForTextureEncodes,
  type FeatureTestSceneName,
} from "./feature-test-project";
import { SOFTWARE_WEBGPU_ARGS } from "./software-webgpu";

/**
 * FeatureTest fly-through route for camera-motion stutter. Opt-in:
 * BL_PERF_FLYTHROUGH=1, through playwright.perf.config.ts only.
 *
 * Creates the Feature Test starter, optionally switches the project backend,
 * then for each scene flies the editor camera along a fixed path at fly speed
 * (static warm-up, then the same path BL_FLY_PASSES times) and records every
 * rendered frame's discrete events: new Effects, shader programs or WebGPU
 * pipelines, bind groups, buffers, texture uploads, material and define
 * invalidations, readiness probes, held frames, shadow-map churn,
 * enabled-light changes and visible-set churn. The report ranks spike frames
 * and the events they coincide with. Counts are hardware-independent; times
 * on software adapters are not device performance. Never asserts frame rates.
 *
 * Env: BL_PERF_SCENES (comma list of main|world|clustered|stress|2d; default main,world),
 *      BL_PERF_BACKEND (webgl2|webgpu; default: the project's WebGL2),
 *      BL_RENDER_NATIVE_GPU=1 keeps the project's launch arguments (perf-gpu); otherwise
 *        WebGPU runs use the software adapter and every run adds --enable-precise-memory-info,
 *      BL_FLY_SPEED (m/s, default 8, the editor's default fly speed), BL_FLY_PASSES (default 2),
 *      BL_FLY_WARMUP_MS (static hold before the first pass, default 5000), BL_PERF_SETTLE_MS (default 5000),
 *      BL_FLY_PATH (JSON array of [x, y, z] eye waypoints, applied to every selected scene),
 *      BL_FLY_PROFILE=1 (CDP CPU profile of the passes; spike frames list their hottest functions),
 *      BL_PERF_VIEWPORT_CAP (Engine Settings viewport frame cap; default 30),
 *      BL_PERF_SCALING (Engine Settings hardware scaling level, e.g. 2 to cut software fill cost),
 *      BL_PERF_LABEL, BL_PERF_OUT (absolute path that also receives the JSON report).
 */
const ENABLED = process.env.BL_PERF_FLYTHROUGH === "1";
const number = (name: string, fallback: number, min = 0) => {
  const value = Number(process.env[name]);
  return process.env[name] !== undefined && Number.isFinite(value) && value >= min ? value : fallback;
};
const BACKEND = process.env.BL_PERF_BACKEND === "webgpu" ? "webgpu" : process.env.BL_PERF_BACKEND === "webgl2" ? "webgl2" : null;
const NATIVE_GPU = process.env.BL_RENDER_NATIVE_GPU === "1";
const SPEED = number("BL_FLY_SPEED", 8, 0.5);
const PASSES = number("BL_FLY_PASSES", 2, 1);
const WARMUP_MS = number("BL_FLY_WARMUP_MS", 5_000);
const SETTLE_MS = number("BL_PERF_SETTLE_MS", 5_000);
const PROFILE = process.env.BL_FLY_PROFILE === "1";
const SCENES = (process.env.BL_PERF_SCENES ?? "main,world")
  .split(",")
  .map((scene) => scene.trim())
  .filter((scene): scene is FeatureTestSceneName => scene in FEATURE_TEST_SCENES);

/**
 * Eye paths at about 4 to 13 m over the ground, each 25 to 30 s at 8 m/s.
 * Main: east through every zone of the first row (Effects, Meshes And
 * Materials, hub, Lights And Shadows, Render Targets), then north-west into
 * Animation. World: south-west shore, hill, puddle, lake, up the river,
 * across the island to the moorings, the Ocean presents and the dry dock.
 * Clustered: two loops around the 48-light grid.
 */
const DEFAULT_PATHS: Partial<Record<FeatureTestSceneName, FlyVec3[]>> = {
  main: [[-84, 4, -3], [84, 4, -3], [84, 5, 18], [40, 5, 30]],
  world: [[-60, 8, -40], [-36, 9, -22], [-28, 6, -8], [-10, 5, 14], [-30, 13, 26], [0, 8, 20], [30, 5, 6], [44, 5, -14], [20, 5, -26]],
  clustered: [[-16, 3, -6], [16, 3, -6], [16, 3, 20], [-16, 3, 20], [-16, 3, -6], [16, 3, -6], [16, 3, 20], [-16, 3, 20], [-16, 3, -6]],
};

function pathFor(scene: FeatureTestSceneName): FlyVec3[] | null {
  if (process.env.BL_FLY_PATH) return JSON.parse(process.env.BL_FLY_PATH) as FlyVec3[];
  return DEFAULT_PATHS[scene] ?? null;
}

if (!NATIVE_GPU)
  test.use({
    launchOptions: {
      args: [...(BACKEND === "webgpu" ? SOFTWARE_WEBGPU_ARGS : []), "--enable-precise-memory-info"],
    },
  });

type ViewportHost = {
  __babylonslateViewportTest: {
    flyThrough: (options: FlyThroughOptions) => Promise<FlyThroughResult>;
    renderingBaseline: () => { backend: string } | null;
  };
};

async function selectBackend(page: Page, backend: "webgl2" | "webgpu"): Promise<void> {
  await page.getByTestId("settings-menu").click();
  await page.getByTestId("project-settings").click();
  await page.getByTestId("settings-modal-category-rendering").click();
  await page.getByTestId("project-gpu-backend").click();
  await page.getByRole("option", { name: backend === "webgpu" ? "WebGPU" : "WebGL2", exact: true }).click();
  await page.getByRole("button", { name: "Done", exact: true }).click();
}

async function viewportBackend(page: Page): Promise<string | null> {
  return page.evaluate(() => (globalThis as unknown as Partial<ViewportHost>).__babylonslateViewportTest?.renderingBaseline()?.backend ?? null);
}

// ---------------------------------------------------------------------------
// Analysis (Node side, so changing it never rebuilds the editor bundle)

type Distribution = { samples: number; median: number | null; p95: number | null; max: number | null; mean: number | null };

function distribution(values: number[]): Distribution {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  const at = (fraction: number) => sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? null;
  const round = (value: number | null) => (value === null ? null : Math.round(value * 10) / 10);
  return {
    samples: sorted.length,
    median: round(at(0.5)),
    p95: round(at(0.95)),
    max: round(sorted.at(-1) ?? null),
    mean: round(sorted.length ? sorted.reduce((sum, value) => sum + value, 0) / sorted.length : null),
  };
}

type AnnotatedFrame = FlyFrame & { longTaskMs: number; heapDropMb: number };

function annotate(result: FlyThroughResult): AnnotatedFrame[] {
  let previousHeap: number | null = null;
  return result.frames.map((frame) => {
    let longTaskMs = 0;
    for (const [start, duration] of result.longTasks) {
      const overlap = Math.min(frame.end, start + duration) - Math.max(frame.begin, start);
      if (overlap > 0) longTaskMs += overlap;
    }
    const heapDropMb = previousHeap !== null && frame.heapMb !== null && frame.heapMb < previousHeap - 0.5 ? previousHeap - frame.heapMb : 0;
    if (frame.heapMb !== null) previousHeap = frame.heapMb;
    const counters = { ...frame.c };
    if (heapDropMb > 0) counters["heap.drop"] = 1;
    if (frame.activeAdded + frame.activeRemoved > 0) counters["visible.churn"] = frame.activeAdded + frame.activeRemoved;
    return { ...frame, c: counters, longTaskMs: Math.round(longTaskMs), heapDropMb: Math.round(heapDropMb * 10) / 10 };
  });
}

/** Counters that mark discrete work, as opposed to steady per-frame traffic. */
const EVENT_KEYS = [
  "effect.new", "gl.link", "gl.compile", "gpu.pipeline", "gpu.pipelineAsync", "gpu.shaderModule", "babylon.pipelineMiss",
  "gpu.bindGroupLayout", "gpu.pipelineLayout", "gpu.texture", "gl.createTexture", "gpu.writeTexture", "gpu.copyExternalImage",
  "gl.texUpload", "gpu.buffer", "gl.createBuffer", "mat.dirty.light", "mat.dirty.texture", "mat.dirty.attributes", "mat.dirty.misc",
  "mat.markDirty", "defines.processed", "defines.light", "ready.false", "graph.strictChecks", "graph.builds", "view.held",
  "shadow.init", "shadow.dispose", "shadow.moved", "shadow.attached", "shadow.detached", "lights.changed", "heap.drop",
];

function summarizePhase(frames: AnnotatedFrame[]) {
  const totals: Record<string, number> = {};
  const framesWith: Record<string, number> = {};
  for (const frame of frames)
    for (const [key, value] of Object.entries(frame.c)) {
      totals[key] = Math.round(((totals[key] ?? 0) + value) * 10) / 10;
      framesWith[key] = (framesWith[key] ?? 0) + 1;
    }
  const seconds = frames.length > 1 ? (frames.at(-1)!.end - frames[0]!.begin) / 1000 : 0;
  return {
    frames: frames.length,
    seconds: Math.round(seconds * 10) / 10,
    fps: seconds > 0 ? Math.round((frames.length / seconds) * 10) / 10 : null,
    intervalMs: distribution(frames.flatMap((frame) => (frame.intervalMs === null ? [] : [frame.intervalMs]))),
    cpuMs: distribution(frames.map((frame) => frame.cpuMs)),
    copyMs: distribution(frames.map((frame) => frame.c["view.copyMs"] ?? 0)),
    longTaskMs: Math.round(frames.reduce((sum, frame) => sum + frame.longTaskMs, 0)),
    activeMeshes: distribution(frames.map((frame) => frame.activeMeshes)),
    drawCalls: distribution(frames.map((frame) => frame.drawCalls)),
    heapMb: distribution(frames.flatMap((frame) => (frame.heapMb === null ? [] : [frame.heapMb]))),
    totals,
    framesWith,
  };
}

/** Frames whose main-thread cost stands out from the phase median. */
function spikeFrames(frames: AnnotatedFrame[], limit = 15) {
  const median = distribution(frames.map((frame) => frame.cpuMs)).median ?? 0;
  const threshold = Math.max(median * 1.75, median + 25);
  return {
    medianCpuMs: median,
    thresholdMs: Math.round(threshold),
    count: frames.filter((frame) => frame.cpuMs > threshold).length,
    top: frames
      .filter((frame) => frame.cpuMs > threshold)
      .sort((a, b) => b.cpuMs - a.cpuMs)
      .slice(0, limit)
      .map((frame) => ({
        i: frame.i, phase: frame.phase, cpuMs: frame.cpuMs, intervalMs: frame.intervalMs, pos: frame.pos,
        longTaskMs: frame.longTaskMs, heapDropMb: frame.heapDropMb, activeMeshes: frame.activeMeshes,
        events: Object.fromEntries(Object.entries(frame.c).filter(([key]) => EVENT_KEYS.includes(key) || key.startsWith("view.") || key.startsWith("graph."))),
      })),
  };
}

/** For each event kind: frames carrying it, their mean cost against frames without it, and its share of spikes. */
function correlate(frames: AnnotatedFrame[]) {
  const median = distribution(frames.map((frame) => frame.cpuMs)).median ?? 0;
  const threshold = Math.max(median * 1.75, median + 25);
  const spikes = frames.filter((frame) => frame.cpuMs > threshold);
  const mean = (list: AnnotatedFrame[]) => (list.length ? Math.round(list.reduce((sum, frame) => sum + frame.cpuMs, 0) / list.length) : null);
  const rows: Record<string, { frames: number; meanCpuWith: number | null; meanCpuWithout: number | null; spikesWith: number }> = {};
  for (const key of EVENT_KEYS) {
    const withKey = frames.filter((frame) => (frame.c[key] ?? 0) > 0);
    if (!withKey.length) continue;
    rows[key] = {
      frames: withKey.length,
      meanCpuWith: mean(withKey),
      meanCpuWithout: mean(frames.filter((frame) => !(frame.c[key] ?? 0))),
      spikesWith: spikes.filter((frame) => (frame.c[key] ?? 0) > 0).length,
    };
  }
  return { spikes: spikes.length, quietSpikes: spikes.filter((frame) => !EVENT_KEYS.some((key) => (frame.c[key] ?? 0) > 0)).length, rows };
}

/** Group log entries by kind and detail, so repeated churn reads as one line with a count and its frames. */
function groupLog(result: FlyThroughResult, frames: AnnotatedFrame[]) {
  const phaseOf = new Map(frames.map((frame) => [frame.i, frame.phase] as const));
  const groups = new Map<string, { kind: string; detail: string; count: number; phases: Record<string, number>; frames: number[]; stack?: string }>();
  for (const entry of result.log) {
    const key = `${entry.kind}\u0000${entry.detail}`;
    let group = groups.get(key);
    if (!group) groups.set(key, (group = { kind: entry.kind, detail: entry.detail.slice(0, 600), count: 0, phases: {}, frames: [] }));
    group.count += 1;
    const phase = phaseOf.get(entry.frame) ?? "outside";
    group.phases[phase] = (group.phases[phase] ?? 0) + 1;
    if (group.frames.length < 12) group.frames.push(entry.frame);
    if (!group.stack && entry.stack) group.stack = entry.stack;
  }
  return [...groups.values()].sort((a, b) => b.count - a.count);
}

// ---------------------------------------------------------------------------
// Optional CPU profile, aligned to page time with a named marker.

type CpuProfile = {
  nodes: Array<{ id: number; callFrame: { functionName: string; url: string; lineNumber: number; columnNumber: number }; children?: number[] }>;
  startTime: number;
  samples: number[];
  timeDeltas: number[];
};

async function profileMarker(page: Page): Promise<number> {
  return page.evaluate(() => {
    const started = performance.now();
    function haptic_flythrough_profile_marker() {
      let sink = 0;
      while (performance.now() - started < 40) sink += Math.sqrt(sink + 1);
      return sink;
    }
    haptic_flythrough_profile_marker();
    return started;
  });
}

function profileHotspots(profile: CpuProfile, markerPageMs: number, windows: Array<{ i: number; begin: number; end: number }>) {
  const nodes = new Map(profile.nodes.map((node) => [node.id, node] as const));
  const parent = new Map<number, number>();
  for (const node of profile.nodes) for (const child of node.children ?? []) parent.set(child, node.id);
  const times: number[] = [];
  let time = profile.startTime;
  for (const delta of profile.timeDeltas) times.push((time += delta));
  const label = (id: number) => {
    const frame = nodes.get(id)!.callFrame;
    const file = frame.url ? frame.url.replace(/^.*\//, "") : "";
    return `${frame.functionName || "(anonymous)"}${file ? ` ${file}:${frame.lineNumber + 1}:${frame.columnNumber + 1}` : ""}`;
  };
  const markerSample = profile.samples.findIndex((id) => {
    for (let current: number | undefined = id; current !== undefined; current = parent.get(current))
      if (nodes.get(current)?.callFrame.functionName === "haptic_flythrough_profile_marker") return true;
    return false;
  });
  if (markerSample < 0) return { aligned: false, frames: [] };
  // Profile microseconds → page milliseconds.
  const offset = times[markerSample]! / 1000 - markerPageMs;
  const frames = windows.map((window) => {
    const self = new Map<string, number>();
    const inclusive = new Map<string, number>();
    let total = 0;
    for (let index = 0; index < profile.samples.length; index += 1) {
      const at = times[index]! / 1000 - offset;
      if (at < window.begin || at > window.end) continue;
      const weight = (profile.timeDeltas[index + 1] ?? profile.timeDeltas[index] ?? 0) / 1000;
      total += weight;
      const leaf = profile.samples[index]!;
      self.set(label(leaf), (self.get(label(leaf)) ?? 0) + weight);
      const seen = new Set<string>();
      for (let current: number | undefined = leaf; current !== undefined; current = parent.get(current)) {
        const name = label(current);
        if (seen.has(name) || name.startsWith("(root)")) continue;
        seen.add(name);
        inclusive.set(name, (inclusive.get(name) ?? 0) + weight);
      }
    }
    const top = (map: Map<string, number>, count: number) =>
      [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, count).map(([name, ms]) => `${Math.round(ms)}ms ${name}`);
    return { i: window.i, sampledMs: Math.round(total), self: top(self, 12), inclusive: top(inclusive, 25) };
  });
  return { aligned: true, frames };
}

// ---------------------------------------------------------------------------

async function flyScene(page: Page, cdp: CDPSession, scene: FeatureTestSceneName) {
  const waypoints = pathFor(scene);
  if (!waypoints) throw new Error(`No fly-through path for ${scene}; set BL_FLY_PATH.`);
  const options: FlyThroughOptions = { waypoints, speed: SPEED, passes: PASSES, warmupMs: WARMUP_MS };
  let markerPageMs = 0;
  if (PROFILE) {
    await cdp.send("Profiler.enable");
    await cdp.send("Profiler.setSamplingInterval", { interval: 1000 });
    await cdp.send("Profiler.start");
    markerPageMs = await profileMarker(page);
  }
  const result = await page.evaluate(
    (flight) => (globalThis as unknown as ViewportHost).__babylonslateViewportTest.flyThrough(flight),
    options,
  );
  const profile = PROFILE ? ((await cdp.send("Profiler.stop")).profile as unknown as CpuProfile) : null;
  if (PROFILE) await cdp.send("Profiler.disable");
  const frames = annotate(result);
  const phases = [...new Set(frames.map((frame) => frame.phase))];
  const passFrames = frames.filter((frame) => frame.phase.startsWith("pass"));
  const spikes = spikeFrames(passFrames);
  return {
    result,
    frames,
    summary: {
      backend: result.backend,
      adapter: result.adapter,
      caps: result.caps,
      pipeline: result.pipeline,
      pathLength: result.pathLength,
      speed: result.speed,
      lights: result.lights,
      qualityLimitsBefore: result.qualityLimitsBefore,
      qualityLimitsAfter: result.qualityLimitsAfter,
      phases: Object.fromEntries(phases.map((phase) => [phase, summarizePhase(frames.filter((frame) => frame.phase === phase))])),
      spikes,
      correlation: correlate(passFrames),
      events: groupLog(result, frames).slice(0, 80),
      profile: profile
        ? profileHotspots(profile, markerPageMs, spikes.top.map((spike) => frames.find((frame) => frame.i === spike.i)!))
        : null,
      instrumented: result.instrumented,
    },
  };
}

test.skip(!ENABLED, "FeatureTest fly-through route; set BL_PERF_FLYTHROUGH=1 to run it.");

test("FeatureTest fly-through route", async ({ page }, testInfo) => {
  test.setTimeout(30 * 60_000 + SCENES.length * (PASSES * 60_000 + WARMUP_MS + SETTLE_MS + 300_000));
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await seedEngineSettings(page, (settings) => {
    if (process.env.BL_PERF_VIEWPORT_CAP) settings.viewportFrameCap = number("BL_PERF_VIEWPORT_CAP", 30, 10);
    if (process.env.BL_PERF_SCALING) settings.hardwareScalingLevel = number("BL_PERF_SCALING", 1, 0.25);
  });
  const cdp = await page.context().newCDPSession(page);
  const createToInteractiveMs = await createFeatureTestProject(page);
  await waitForTextureEncodes(page);
  if (BACKEND) await selectBackend(page, BACKEND);

  const scenes: Record<string, unknown> = {};
  const raw: Record<string, unknown> = {};
  for (const scene of SCENES) {
    const { readyMs, loadRetries } = await openFeatureTestScene(page, scene);
    if (BACKEND) await expect.poll(() => viewportBackend(page), { timeout: 120_000 }).toBe(BACKEND);
    await page.waitForTimeout(SETTLE_MS);
    const { frames, summary, result } = await flyScene(page, cdp, scene);
    scenes[scene] = { sceneReadyMs: readyMs, loadRetries, ...summary };
    raw[scene] = { frames, log: result.log, longTasks: result.longTasks, totals: result.totals };
    await page.getByTestId("viewport-canvas").screenshot({ path: testInfo.outputPath(`${scene}-flythrough-end.png`) });
  }

  const report = {
    qualification:
      "Per-frame event counts during a scripted editor fly-through. Counts are hardware-independent; times on software adapters are not device performance. Compare runs on the same machine, backend and build only. No frame-rate assertion.",
    label: process.env.BL_PERF_LABEL ?? null,
    browserProject: testInfo.project.name,
    browserVersion: page.context().browser()?.version() ?? null,
    env: { SCENES, BACKEND, NATIVE_GPU, SPEED, PASSES, WARMUP_MS, SETTLE_MS, PROFILE,
      VIEWPORT_CAP: process.env.BL_PERF_VIEWPORT_CAP ?? null, SCALING: process.env.BL_PERF_SCALING ?? null },
    createToInteractiveMs,
    scenes,
    pageErrors,
  };
  const body = JSON.stringify({ ...report, raw }, null, 1);
  writeFileSync(testInfo.outputPath("feature-test-flythrough.json"), body);
  if (process.env.BL_PERF_OUT) {
    mkdirSync(path.dirname(process.env.BL_PERF_OUT), { recursive: true });
    writeFileSync(process.env.BL_PERF_OUT, body);
  }
  await testInfo.attach("feature-test-flythrough", { body: JSON.stringify(report, null, 1), contentType: "application/json" });
  console.log(`[feature-test-flythrough] ${JSON.stringify(report)}`);

  expect(SCENES.length).toBeGreaterThan(0);
  expect(pageErrors).toEqual([]);
});
