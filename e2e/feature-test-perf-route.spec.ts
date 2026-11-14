import { writeFileSync } from "node:fs";
import { expect, test, type CDPSession, type Page } from "@playwright/test";
import { clickPlayAndWaitForOverlay, runConsoleCommand } from "./play";
import { distribution, graphicsAdapter } from "./play-performance-fixture";
import {
  createFeatureTestProject,
  FEATURE_TEST_SCENES,
  openFeatureTestScene,
  reopenFeatureTestProject,
  seedEngineSettings,
  waitForTextureEncodes,
  type FeatureTestSceneName,
} from "./feature-test-project";

/**
 * Local FeatureTest performance route for agents. Opt-in: HAPTIC_PERF_FEATURE_TEST=1.
 * Creates the Feature Test starter through the real Create dialog, then for
 * each selected scene measures editor viewport frames and overlay Play
 * frames. It records one JSON report and asserts only that the route ran
 * cleanly; it never asserts a frame rate.
 *
 * Env: HAPTIC_PERF_SCENES (comma list of main|stress|world|lights|2d, default main,stress),
 *      HAPTIC_PERF_SAMPLE_MS (default 15000), HAPTIC_PERF_SAMPLES (default 2),
 *      HAPTIC_PERF_WARMUP_MS (default 10000), HAPTIC_PERF_SETTLE_MS (default 5000),
 *      HAPTIC_PERF_QUALITY (low|medium|high|ultra, applied with the Play console),
 *      HAPTIC_PERF_FRAMECAP (Play console `framecap`), HAPTIC_PERF_VIEWPORT_CAP (Engine Settings),
 *      HAPTIC_PERF_COMMANDS (further Play console commands after the quality, separated by `;`),
 *      HAPTIC_PERF_PLAYS (default 1: Plays per scene, each after the editor's view is ready again),
 *      HAPTIC_PERF_REOPEN (default 1: also time reload + reopen), HAPTIC_PERF_LABEL,
 *      HAPTIC_PERF_OUT (absolute path that also receives the JSON report).
 *
 * Each Play window reports the view's own frames (`view`, `drawnFps`: animation frames keep their cadence while the
 * view holds its picture), and from half-second readings its frame's main-thread time, draws, and both by pass
 * (`frameCpu`, `frameDraws`, `drawsPerPass`, `cpuMsPerPass`). `settingsHoldMs` is how long the view took to draw again
 * after the console commands; `rendering.rendererWork.readinessBlockers` names what a failed readiness check waited for.
 *
 * Each Play also reports the WebGL programs linked from its click to its close (`programs`), keyed by their
 * shader sources: how many, how many while it loaded, how many distinct sources, and how many of those the
 * page had linked before that Play started (a repeat Play that keeps its programs links almost none of them).
 */
const ENABLED = process.env.HAPTIC_PERF_FEATURE_TEST === "1";
const number = (name: string, fallback: number, min = 0) => {
  const value = Number(process.env[name]);
  return process.env[name] !== undefined && Number.isFinite(value) && value >= min ? value : fallback;
};
const SAMPLE_MS = number("HAPTIC_PERF_SAMPLE_MS", 15_000, 1_000);
const SAMPLES = number("HAPTIC_PERF_SAMPLES", 2, 1);
const WARMUP_MS = number("HAPTIC_PERF_WARMUP_MS", 10_000);
const SETTLE_MS = number("HAPTIC_PERF_SETTLE_MS", 5_000);
const QUALITY = process.env.HAPTIC_PERF_QUALITY ?? null;
const FRAMECAP = process.env.HAPTIC_PERF_FRAMECAP ?? null;
const COMMANDS = (process.env.HAPTIC_PERF_COMMANDS ?? "").split(";").map((command) => command.trim()).filter(Boolean);
const REOPEN = process.env.HAPTIC_PERF_REOPEN !== "0";
const PLAYS = number("HAPTIC_PERF_PLAYS", 1, 1);
const SCENES = (process.env.HAPTIC_PERF_SCENES ?? "main,stress")
  .split(",")
  .map((scene) => scene.trim())
  .filter((scene): scene is FeatureTestSceneName => scene in FEATURE_TEST_SCENES);

type PlayHost = {
  __hapticPlayTest?: {
    tickIndex: () => number | null;
    rendering: () => (Record<string, unknown> & {
      presentation?: { attempted: number; drawn: number; held: number; heldReasons: Record<string, number> };
    }) | null;
    scalability: () => { revision: number; status: string; message?: string } | undefined;
    liveObjectCounts: () => Record<string, number>;
    spawnableWarm: () => { materials: number; models: number; ms: number } | null;
  };
};

/** Install long-task observation before the editor boots. */
async function recordLongTasks(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const tasks: number[][] = [];
    (globalThis as unknown as { __ftLongTasks: number[][] }).__ftLongTasks = tasks;
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) tasks.push([entry.startTime, entry.duration]);
      }).observe({ type: "longtask", buffered: true });
    } catch {
      /* Not supported: counts stay empty. */
    }
  });
}

/**
 * Record every WebGL program link with a hash of its shader sources, before the editor boots. Babylon's
 * `SHADER_NAME` line names the Effect (a NodeMaterial's build id), not the code, so it is left out.
 */
async function recordProgramLinks(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const links: Array<[number, string]> = [];
    (globalThis as unknown as { __ftProgramLinks: Array<[number, string]> }).__ftProgramLinks = links;
    const SHADER_NAME = /^\s*(?:\/\/)?\s*#define\s+SHADER_NAME\b[^\n]*\n?/gm;
    const hash = (source: string) => {
      const text = source.replace(SHADER_NAME, "");
      let h = 0x811c9dc5;
      for (let index = 0; index < text.length; index++) h = Math.imul(h ^ text.charCodeAt(index), 0x01000193);
      return `${(h >>> 0).toString(36)}-${text.length}`;
    };
    for (const context of [globalThis.WebGL2RenderingContext, globalThis.WebGLRenderingContext]) {
      if (!context) continue;
      const link = context.prototype.linkProgram;
      context.prototype.linkProgram = function (this: WebGL2RenderingContext, program: WebGLProgram) {
        try {
          const sources = (this.getAttachedShaders(program) ?? []).map((shader) => this.getShaderSource(shader) ?? "");
          links.push([performance.now(), hash(sources.join("\u0000"))]);
        } catch {
          /* A lost context: the link is not counted. */
        }
        return link.call(this, program);
      };
    }
  });
}

/** TEMP DIAG: every program link and delete, with the deleting stack and whether the program had finished linking. */
async function recordProgramChurn(page: Page): Promise<void> {
  await page.addInitScript(() => {
    type Event = { at: number; kind: "link" | "delete"; name: string; id: number; ageMs?: number; complete?: boolean | null; stack?: string };
    const events: Event[] = [];
    (globalThis as unknown as { __ftProgramChurn: Event[] }).__ftProgramChurn = events;
    const info = new WeakMap<WebGLProgram, { name: string; id: number; at: number }>();
    let next = 1;
    const stack = () => (new Error().stack ?? "").split("\n").slice(2, 16).map((line) => line.trim().replace(/https?:\/\/[^/]+\/assets\//, "").replace(/^at /, "")).join(" | ");
    const context = globalThis.WebGL2RenderingContext;
    if (!context) return;
    const link = context.prototype.linkProgram;
    context.prototype.linkProgram = function (this: WebGL2RenderingContext, program: WebGLProgram) {
      let name = "?";
      try {
        const source = (this.getAttachedShaders(program) ?? []).map((shader) => this.getShaderSource(shader) ?? "").join("\n");
        name = /#define\s+SHADER_NAME\s+(\S+)/.exec(source)?.[1] ?? "?";
      } catch { /* lost context */ }
      const entry = { name, id: next++, at: performance.now() };
      info.set(program, entry);
      events.push({ at: entry.at, kind: "link", name, id: entry.id });
      const result = link.call(this, program);
      // Time the link itself: poll its completion apart from the engine.
      try {
        const gl = this;
        const extension = gl.getExtension("KHR_parallel_shader_compile");
        const shaders = gl.getAttachedShaders(program) ?? [];
        const sources = shaders.map((shader) => gl.getShaderSource(shader) ?? "");
        const defines = sources.map((source) => (source.match(/^\s*#define\s+\S+.*$/gm) ?? []).map((line) => line.replace(/^\s*#define\s+/, "").trim()));
        if (extension) {
          const timer = setInterval(() => {
            let done = false;
            try { done = !gl.isProgram(program) || Boolean(gl.getProgramParameter(program, extension.COMPLETION_STATUS_KHR)); } catch { done = true; }
            if (!done) return;
            clearInterval(timer);
            (events as unknown as Array<Record<string, unknown>>).push({ at: performance.now(), kind: "done", name, id: entry.id, ageMs: Math.round(performance.now() - entry.at), lengths: sources.map((source) => source.length), defines, sources });
          }, 100);
        }
      } catch { /* lost context */ }
      return result;
    };
    const remove = context.prototype.deleteProgram;
    context.prototype.deleteProgram = function (this: WebGL2RenderingContext, program: WebGLProgram | null) {
      const entry = program ? info.get(program) : undefined;
      if (program && entry) {
        let complete: boolean | null = null;
        try {
          const extension = this.getExtension("KHR_parallel_shader_compile");
          if (extension) complete = Boolean(this.getProgramParameter(program, extension.COMPLETION_STATUS_KHR));
        } catch { /* lost context */ }
        events.push({ at: performance.now(), kind: "delete", name: entry.name, id: entry.id, ageMs: Math.round(performance.now() - entry.at), complete, stack: stack() });
      }
      return remove.call(this, program);
    };
  });
}

/** The programs linked from `since` to `until`, and how many of their sources the page linked before `since`. */
async function programLinks(page: Page, since: number, loadedAt: number, until: number) {
  return page.evaluate(([from, loaded, to]) => {
    const links = (globalThis as unknown as { __ftProgramLinks?: Array<[number, string]> }).__ftProgramLinks ?? [];
    const earlier = new Set(links.filter(([at]) => at < from!).map(([, key]) => key));
    const window = links.filter(([at]) => at >= from! && at <= to!);
    const distinct = new Set(window.map(([, key]) => key));
    return {
      linked: window.length,
      duringLoad: window.filter(([at]) => at < loaded!).length,
      afterLoad: window.filter(([at]) => at >= loaded!).length,
      distinct: distinct.size,
      linkedEarlier: [...distinct].filter((key) => earlier.has(key)).length,
    };
  }, [since, loadedAt, until]);
}

async function longTasksSince(page: Page, since: number) {
  return page.evaluate((from) => {
    const tasks = ((globalThis as unknown as { __ftLongTasks?: number[][] }).__ftLongTasks ?? []).filter(
      ([start]) => start! >= from,
    );
    return { count: tasks.length, totalMs: tasks.reduce((sum, [, duration]) => sum + duration!, 0) };
  }, since);
}

async function pageNow(page: Page): Promise<number> {
  return page.evaluate(() => performance.now());
}

/** Main-thread busy fraction from CDP task time over wall time. */
async function busyFraction<T>(cdp: CDPSession, work: () => Promise<T>): Promise<{ result: T; busy: number | null }> {
  const metrics = async () => {
    const { metrics } = await cdp.send("Performance.getMetrics");
    return Object.fromEntries(metrics.map((metric) => [metric.name, metric.value])) as Record<string, number>;
  };
  const before = await metrics();
  const result = await work();
  const after = await metrics();
  const wall = (after.Timestamp ?? 0) - (before.Timestamp ?? 0);
  const task = (after.TaskDuration ?? 0) - (before.TaskDuration ?? 0);
  return { result, busy: wall > 0 ? task / wall : null };
}

type ViewportMeasurement = {
  elapsedMs: number;
  frameSamples: Array<{ intervalMs: number | null; cpuMs: number; documentVisible: boolean }>;
  resourceSamples: Array<{ sceneMeshes: number; estimatedTextureBytes: number; estimatedGeometryBytes: number }>;
};

async function measureViewport(page: Page, durationMs: number) {
  const measurement = await page.evaluate(
    (ms) =>
      (globalThis as unknown as {
        __hapticViewportTest: { measureRenderingBaseline: (ms: number) => Promise<unknown> };
      }).__hapticViewportTest.measureRenderingBaseline(ms),
    Math.min(durationMs, 30_000),
  ) as ViewportMeasurement;
  const frames = measurement.frameSamples;
  const resources = measurement.resourceSamples;
  const peak = (value: (sample: ViewportMeasurement["resourceSamples"][number]) => number) =>
    resources.length ? Math.max(...resources.map(value)) : null;
  return {
    elapsedMs: measurement.elapsedMs,
    hiddenFrameSamples: frames.filter((frame) => !frame.documentVisible).length,
    presentedIntervals: distribution(frames.flatMap((frame) => (frame.intervalMs === null ? [] : [frame.intervalMs]))),
    viewportRenderCpu: distribution(frames.map((frame) => frame.cpuMs)),
    peakViewportMeshes: peak((sample) => sample.sceneMeshes),
    peakEstimatedTextureBytes: peak((sample) => sample.estimatedTextureBytes),
    peakEstimatedGeometryBytes: peak((sample) => sample.estimatedGeometryBytes),
  };
}

/** Each pass's median over the readings (`RenderDiagnostics.drawPasses` or `drawPassMs`), passes that stayed at zero left out. */
function passMedians(readings: unknown[]): Record<string, number> | null {
  const byPass = new Map<string, number[]>();
  for (const reading of readings) {
    if (!reading || typeof reading !== "object") continue;
    for (const [pass, value] of Object.entries(reading))
      if (typeof value === "number") byPass.set(pass, [...(byPass.get(pass) ?? []), value]);
  }
  if (!byPass.size) return null;
  const medians: Record<string, number> = {};
  for (const [pass, values] of byPass) {
    const median = Math.round((distribution(values).medianMs ?? 0) * 100) / 100;
    if (median > 0) medians[pass] = median;
  }
  return medians;
}

/** requestAnimationFrame cadence and worker ticks during overlay Play. */
async function samplePlay(page: Page, durationMs: number) {
  const sample = await page.evaluate(async (ms) => {
    const host = globalThis as unknown as PlayHost;
    const frame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve));
    const tickStart = host.__hapticPlayTest?.tickIndex() ?? null;
    // The first reading starts the per-pass timing, so every later one holds a timed frame.
    const presentedAtStart = host.__hapticPlayTest?.rendering()?.presentation ?? null;
    const first = await frame();
    let previous = first;
    let read = first;
    const intervals: number[] = [];
    const readings: Array<Record<string, unknown>> = [];
    for (;;) {
      const now = await frame();
      intervals.push(now - previous);
      previous = now;
      if (now - read >= 500) {
        read = now;
        const rendering = host.__hapticPlayTest?.rendering();
        if (rendering) readings.push({ drawCalls: rendering.drawCalls, cpuMs: rendering.cpuMs, drawPasses: rendering.drawPasses, drawPassMs: rendering.drawPassMs });
      }
      if (now - first >= ms) break;
    }
    const tickEnd = host.__hapticPlayTest?.tickIndex() ?? null;
    const presentedAtEnd = host.__hapticPlayTest?.rendering()?.presentation ?? null;
    return {
      elapsedMs: previous - first,
      intervals,
      readings,
      // The view's own frames: animation frames keep their cadence while the view holds or skips its draws.
      view: presentedAtStart && presentedAtEnd
        ? {
            attempted: presentedAtEnd.attempted - presentedAtStart.attempted,
            drawn: presentedAtEnd.drawn - presentedAtStart.drawn,
            held: presentedAtEnd.held - presentedAtStart.held,
            heldReasons: presentedAtEnd.heldReasons,
          }
        : null,
      ticks: tickStart !== null && tickEnd !== null ? tickEnd - tickStart : null,
      scalability: host.__hapticPlayTest?.scalability() ?? null,
      visibility: document.visibilityState,
      rendering: host.__hapticPlayTest?.rendering() ?? null,
    };
  }, durationMs);
  const intervals = distribution(sample.intervals);
  const stalls = (thresholdMs: number) => sample.intervals.filter((value) => value > thresholdMs).length;
  const rendering = (sample.rendering ?? {}) as Record<string, unknown>;
  const draws = distribution(sample.readings.flatMap((reading) => (typeof reading.drawCalls === "number" ? [reading.drawCalls] : [])));
  return {
    elapsedMs: sample.elapsedMs,
    averageFps: intervals.samples && sample.elapsedMs > 0 ? (intervals.samples * 1000) / sample.elapsedMs : null,
    drawnFps: sample.view && sample.elapsedMs > 0 ? (sample.view.drawn * 1000) / sample.elapsedMs : null,
    view: sample.view,
    // The last quality change's acknowledgement: a failed one names what its preparation waited for.
    scalability: sample.scalability ? { revision: sample.scalability.revision, status: sample.scalability.status, message: sample.scalability.message } : null,
    intervals,
    stallsOver33Ms: stalls(33.4),
    stallsOver100Ms: stalls(100),
    tickHz: sample.ticks !== null && sample.elapsedMs > 0 ? (sample.ticks * 1000) / sample.elapsedMs : null,
    visibility: sample.visibility,
    // Half-second readings over the window: one frame's value says little where passes draw on alternate frames.
    frameCpu: distribution(sample.readings.flatMap((reading) => (typeof reading.cpuMs === "number" ? [reading.cpuMs] : []))),
    frameDraws: { median: draws.medianMs, max: draws.longestMs },
    drawsPerPass: passMedians(sample.readings.map((reading) => reading.drawPasses)),
    cpuMsPerPass: passMedians(sample.readings.map((reading) => reading.drawPassMs)),
    rendering: {
      drawCalls: rendering.drawCalls ?? null,
      cpuMs: rendering.cpuMs ?? null,
      gpuMs: rendering.gpuMs ?? null,
      settings: rendering.settings ?? null,
      rendererWork: rendering.rendererWork ?? null,
      layerBatches: rendering.layerBatches ?? null,
      shadowRetained: rendering.shadowRetained ?? null,
      shadowPasses: rendering.shadowPasses ?? null,
      occlusion: rendering.occlusion ?? null,
      instancePool: rendering.instancePool ?? null,
      width: rendering.width ?? null,
      height: rendering.height ?? null,
      scalingLevel: rendering.scalingLevel ?? null,
      resources: rendering.resources ?? null,
      pipeline: rendering.pipeline ?? null,
    },
  };
}

async function measurePlay(page: Page, cdp: CDPSession) {
  const started = Date.now();
  const linksSince = await pageNow(page);
  await clickPlayAndWaitForOverlay(page);
  await expect(page.getByTestId("play-blocked-dialog")).toHaveCount(0);
  await expect(page.getByTestId("scene-loading-dialog")).toBeHidden({ timeout: 180_000 });
  const loadedAt = await pageNow(page);
  await expect(page.getByTestId("play-canvas")).toBeVisible({ timeout: 60_000 });
  await expect
    .poll(
      () => page.evaluate(() => (globalThis as unknown as PlayHost).__hapticPlayTest?.tickIndex() ?? -1),
      { timeout: 180_000 },
    )
    .toBeGreaterThan(30);
  const playBootMs = Date.now() - started;
  // The share of the boot spent compiling what Play may spawn, before the first frame.
  const spawnableWarm = await page.evaluate(() => (globalThis as unknown as PlayHost).__hapticPlayTest?.spawnableWarm() ?? null);
  const holdFrom = await pageNow(page);
  if (QUALITY) {
    await runConsoleCommand(page, `quality ${QUALITY}`);
    // Presets below ultra enable dynamic resolution; keep the project's fixed scale.
    await runConsoleCommand(page, "quality resolution reset");
  }
  if (FRAMECAP) await runConsoleCommand(page, `framecap ${FRAMECAP}`);
  for (const command of COMMANDS) await runConsoleCommand(page, command);
  // A quality change holds the last frame until its Material variants have compiled: the windows measure what follows.
  const settingsHoldMs = await waitForViewDrawing(page);
  const churn = await page.evaluate((from) => {
    type Event = { at: number; kind: string; name: string; id: number; ageMs?: number; complete?: boolean | null; stack?: string };
    const events = ((globalThis as unknown as { __ftProgramChurn?: Event[] }).__ftProgramChurn ?? []).filter((event) => event.at >= from);
    const links = events.filter((event) => event.kind === "link");
    const deletes = events.filter((event) => event.kind === "delete");
    const byStack = new Map<string, { count: number; incomplete: number; names: Set<string>; ages: number[] }>();
    for (const event of deletes) {
      const group = byStack.get(event.stack ?? "") ?? { count: 0, incomplete: 0, names: new Set<string>(), ages: [] };
      group.count += 1;
      if (event.complete === false) group.incomplete += 1;
      group.names.add(event.name.replace(/\d+/g, "#"));
      group.ages.push(event.ageMs ?? 0);
      byStack.set(event.stack ?? "", group);
    }
    const linkNames = new Map<string, number>();
    for (const event of links) linkNames.set(event.name, (linkNames.get(event.name) ?? 0) + 1);
    return {
      links: links.length,
      deletes: deletes.length,
      deletedIncomplete: deletes.filter((event) => event.complete === false).length,
      slowest: (() => {
        type Done = { at: number; kind: string; name: string; id: number; ageMs: number; lengths: number[]; defines: string[][] };
        const all = ((globalThis as unknown as { __ftProgramChurn?: Done[] }).__ftProgramChurn ?? []).filter((event) => event.kind === "done");
        const slow = all.filter((event) => event.at >= from && /nodeMaterial/.test(event.name)).sort((a, b) => b.ageMs - a.ageMs).slice(0, 3);
        return slow.map((event) => {
          const now = new Set(event.defines[1] ?? []);
          const earlier = all.filter((other) => other.name === event.name && other.id < event.id && other.at < from);
          return {
            id: event.id, name: event.name, linkMs: event.ageMs, lengths: event.lengths, sources: (event as unknown as { sources: string[] }).sources,
            earlier: earlier.map((other) => {
              const then = new Set(other.defines[1] ?? []);
              return {
                id: other.id, linkMs: other.ageMs, lengths: other.lengths,
                onlyEarlier: [...then].filter((line) => !now.has(line)).slice(0, 40),
                onlyNow: [...now].filter((line) => !then.has(line)).slice(0, 40),
              };
            }),
          };
        });
      })(),
      relinked: [...linkNames.entries()].filter(([, count]) => count > 1).sort((a, b) => b[1] - a[1]).slice(0, 12),
      timeline: events.map((event) => `${Math.round(event.at - from)}:${event.kind[0]}${event.id}${event.kind === "delete" ? (event.complete === false ? "!" : "") : ""}`).join(" "),
      groups: [...byStack.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 6).map(([stack, group]) => ({
        count: group.count, incomplete: group.incomplete, names: [...group.names].slice(0, 6), medianAgeMs: group.ages.sort((a, b) => a - b)[Math.floor(group.ages.length / 2)], stack,
      })),
    };
  }, holdFrom);
  if (process.env.HAPTIC_PERF_OUT) (churn.slowest as Array<{ sources: string[] }>).slice(0, 1).forEach((entry) => entry.sources.forEach((source, index) => writeFileSync(`${process.env.HAPTIC_PERF_OUT}.slow-${index === 0 ? "vertex" : "fragment"}.glsl`, source)));
  for (const entry of churn.slowest as Array<{ sources?: string[] }>) delete entry.sources;
  console.log(`[feature-test-perf] program churn during the hold (${settingsHoldMs} ms): ${JSON.stringify(churn, null, 1)}`);
  await page.waitForTimeout(WARMUP_MS);
  const windows = [];
  for (let index = 0; index < SAMPLES; index += 1) {
    const since = await pageNow(page);
    const { result, busy } = await busyFraction(cdp, () => samplePlay(page, SAMPLE_MS));
    windows.push({ ...result, mainThreadBusy: busy, longTasks: await longTasksSince(page, since) });
  }
  const liveObjects = await page.evaluate(
    () => (globalThis as unknown as PlayHost).__hapticPlayTest?.liveObjectCounts() ?? null,
  );
  const programs = await programLinks(page, linksSince, loadedAt, await pageNow(page));
  await page.getByTestId("play-overlay-close").click();
  await expect(page.getByTestId("play-overlay")).toHaveCount(0, { timeout: 60_000 });
  await expect(page.getByTestId("preview-session-report")).toHaveCount(0);
  return { playBootMs, settingsHoldMs, spawnableWarm, programs, windows, liveObjects };
}

/** Waits until Play's view draws frames again, and returns how long that took. */
async function waitForViewDrawing(page: Page): Promise<number> {
  const started = Date.now();
  let last = -1;
  await expect
    .poll(async () => {
      const drawn = await page.evaluate(() => (globalThis as unknown as PlayHost).__hapticPlayTest?.rendering()?.presentation?.drawn ?? 0);
      const drawing = last >= 0 && drawn - last >= 5;
      last = drawn;
      return drawing;
    }, { timeout: 360_000, intervals: [500] })
    .toBe(true);
  return Date.now() - started;
}

/** After Play closes, the editor's scene view loads again. */
async function waitForSceneView(page: Page): Promise<void> {
  const panel = page.getByTestId("viewport-panel");
  await expect(panel).toHaveAttribute("data-scene-ready", "true", { timeout: 180_000 });
  await expect(panel).toHaveAttribute("aria-busy", "false", { timeout: 180_000 });
}

test.skip(!ENABLED, "FeatureTest performance route; set HAPTIC_PERF_FEATURE_TEST=1 to run it.");

test("FeatureTest performance route", async ({ page }, testInfo) => {
  test.setTimeout(20 * 60_000 + SCENES.length * PLAYS * (SAMPLES * SAMPLE_MS * 2 + WARMUP_MS + SETTLE_MS + 5 * 60_000));
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  // A failed load reports itself on the console, not as a page error: keep the last ones for the failure message.
  const consoleProblems: string[] = [];
  page.on("console", (message) => {
    if (message.type() !== "error" && message.type() !== "warning") return;
    // SwiftShader's read-back performance notes say nothing about a failure.
    if (message.text().includes("GL Driver Message")) return;
    consoleProblems.push(`${message.type()}: ${message.text().slice(0, 500)}`);
    if (consoleProblems.length > 60) consoleProblems.shift();
  });
  // Babylon fetches a shader it does not find in its shader store: the shader name is in the URL.
  page.on("request", (request) => {
    if (/\.fx(?:$|\?)/.test(request.url())) consoleProblems.push(`shader fetched: ${request.url()}`);
  });
  await recordLongTasks(page);
  await recordProgramLinks(page);
  await recordProgramChurn(page);
  await seedEngineSettings(page, (settings) => {
    settings.debuggerDefaults.overlayConsole = true;
    if (process.env.HAPTIC_PERF_VIEWPORT_CAP) settings.viewportFrameCap = number("HAPTIC_PERF_VIEWPORT_CAP", 60, 10);
  });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");

  const createToInteractiveMs = await createFeatureTestProject(page);
  // The editor document starts at Homepage boot, so this covers boot plus creation.
  const bootAndCreateLongTasks = await longTasksSince(page, 0);
  const encodeWaitMs = await waitForTextureEncodes(page);
  const adapter = await graphicsAdapter(page);

  const scenes: Record<string, unknown> = {};
  for (const scene of SCENES) {
    let step = "opening it";
    try {
      const { readyMs: sceneReadyMs, loadRetries } = await openFeatureTestScene(page, scene);
      await page.waitForTimeout(SETTLE_MS);
      const viewport = [];
      for (let index = 0; index < SAMPLES; index += 1) {
        const { result, busy } = await busyFraction(cdp, () => measureViewport(page, SAMPLE_MS));
        viewport.push({ ...result, mainThreadBusy: busy });
      }
      await page.getByTestId("viewport-canvas").screenshot({ path: testInfo.outputPath(`${scene}-viewport.png`) });
      const plays = [];
      for (let index = 0; index < PLAYS; index += 1) {
        if (index > 0) {
          step = `the editor's reload before Play ${index + 1}`;
          await waitForSceneView(page);
          await page.waitForTimeout(SETTLE_MS);
        }
        step = `Play ${index + 1}`;
        plays.push(await measurePlay(page, cdp));
      }
      // The next scene opens over the editor's reloaded view.
      step = "the editor's reload after the last Play";
      await waitForSceneView(page);
      scenes[scene] = { sceneReadyMs, loadRetries, viewport, play: plays[0], ...(PLAYS > 1 ? { repeatPlays: plays.slice(1) } : {}) };
    } catch (error) {
      console.log(`[feature-test-perf] ${scene}: ${step} failed; last console problems:\n${consoleProblems.join("\n")}`);
      throw error;
    }
  }

  const reopenToInteractiveMs = REOPEN ? await reopenFeatureTestProject(page) : null;
  const report = {
    qualification:
      "Local browser observation of the Feature Test starter on this machine's adapter; compare runs on the same machine and build only. Not device, Safari, thermal or A16 qualification. No frame-rate assertion.",
    label: process.env.HAPTIC_PERF_LABEL ?? null,
    browserProject: testInfo.project.name,
    browserVersion: page.context().browser()?.version() ?? null,
    viewportCss: page.viewportSize(),
    adapter,
    env: { SCENES, SAMPLE_MS, SAMPLES, WARMUP_MS, SETTLE_MS, QUALITY, FRAMECAP, PLAYS },
    phases: { createToInteractiveMs, bootAndCreateLongTasks, encodeWaitMs, reopenToInteractiveMs },
    scenes,
    pageErrors,
    consoleProblems,
  };
  const body = JSON.stringify(report, null, 2);
  writeFileSync(testInfo.outputPath("feature-test-perf.json"), body);
  if (process.env.HAPTIC_PERF_OUT) writeFileSync(process.env.HAPTIC_PERF_OUT, body);
  await testInfo.attach("feature-test-perf", { body, contentType: "application/json" });
  console.log(`[feature-test-perf] ${JSON.stringify(report)}`);

  expect(SCENES.length).toBeGreaterThan(0);
  expect(pageErrors).toEqual([]);
});
