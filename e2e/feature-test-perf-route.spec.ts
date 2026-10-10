import { writeFileSync } from "node:fs";
import { expect, test, type CDPSession, type Page } from "@playwright/test";
import { clickPlayAndWaitForOverlay } from "./play";
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
 * Local FeatureTest performance route for agents. Opt-in: BL_PERF_FEATURE_TEST=1.
 * Creates the Feature Test starter through the real Create dialog, then for
 * each selected scene measures editor viewport frames and overlay Play
 * frames. It records one JSON report and asserts only that the route ran
 * cleanly; it never asserts a frame rate.
 *
 * Env: BL_PERF_SCENES (comma list of main|stress|world|clustered|2d, default main,stress),
 *      BL_PERF_SAMPLE_MS (default 15000), BL_PERF_SAMPLES (default 2),
 *      BL_PERF_WARMUP_MS (default 10000), BL_PERF_SETTLE_MS (default 5000),
 *      BL_PERF_QUALITY (low|medium|high|ultra, applied with the Play console),
 *      BL_PERF_FRAMECAP (Play console `framecap`), BL_PERF_VIEWPORT_CAP (Engine Settings),
 *      BL_PERF_REOPEN (default 1: also time reload + reopen), BL_PERF_LABEL,
 *      BL_PERF_OUT (absolute path that also receives the JSON report).
 */
const ENABLED = process.env.BL_PERF_FEATURE_TEST === "1";
const number = (name: string, fallback: number, min = 0) => {
  const value = Number(process.env[name]);
  return process.env[name] !== undefined && Number.isFinite(value) && value >= min ? value : fallback;
};
const SAMPLE_MS = number("BL_PERF_SAMPLE_MS", 15_000, 1_000);
const SAMPLES = number("BL_PERF_SAMPLES", 2, 1);
const WARMUP_MS = number("BL_PERF_WARMUP_MS", 10_000);
const SETTLE_MS = number("BL_PERF_SETTLE_MS", 5_000);
const QUALITY = process.env.BL_PERF_QUALITY ?? null;
const FRAMECAP = process.env.BL_PERF_FRAMECAP ?? null;
const REOPEN = process.env.BL_PERF_REOPEN !== "0";
const SCENES = (process.env.BL_PERF_SCENES ?? "main,stress")
  .split(",")
  .map((scene) => scene.trim())
  .filter((scene): scene is FeatureTestSceneName => scene in FEATURE_TEST_SCENES);

type PlayHost = {
  __babylonslatePlayTest?: {
    tickIndex: () => number | null;
    rendering: () => Record<string, unknown>;
    liveObjectCounts: () => Record<string, number>;
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
        __babylonslateViewportTest: { measureRenderingBaseline: (ms: number) => Promise<unknown> };
      }).__babylonslateViewportTest.measureRenderingBaseline(ms),
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

/** requestAnimationFrame cadence and worker ticks during overlay Play. */
async function samplePlay(page: Page, durationMs: number) {
  const sample = await page.evaluate(async (ms) => {
    const host = globalThis as unknown as PlayHost;
    const frame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve));
    const tickStart = host.__babylonslatePlayTest?.tickIndex() ?? null;
    const first = await frame();
    let previous = first;
    const intervals: number[] = [];
    for (;;) {
      const now = await frame();
      intervals.push(now - previous);
      previous = now;
      if (now - first >= ms) break;
    }
    const tickEnd = host.__babylonslatePlayTest?.tickIndex() ?? null;
    return {
      elapsedMs: previous - first,
      intervals,
      ticks: tickStart !== null && tickEnd !== null ? tickEnd - tickStart : null,
      visibility: document.visibilityState,
      rendering: host.__babylonslatePlayTest?.rendering() ?? null,
    };
  }, durationMs);
  const intervals = distribution(sample.intervals);
  const stalls = (thresholdMs: number) => sample.intervals.filter((value) => value > thresholdMs).length;
  const rendering = (sample.rendering ?? {}) as Record<string, unknown>;
  return {
    elapsedMs: sample.elapsedMs,
    averageFps: intervals.samples && sample.elapsedMs > 0 ? (intervals.samples * 1000) / sample.elapsedMs : null,
    intervals,
    stallsOver33Ms: stalls(33.4),
    stallsOver100Ms: stalls(100),
    tickHz: sample.ticks !== null && sample.elapsedMs > 0 ? (sample.ticks * 1000) / sample.elapsedMs : null,
    visibility: sample.visibility,
    rendering: {
      drawCalls: rendering.drawCalls ?? null,
      cpuMs: rendering.cpuMs ?? null,
      gpuMs: rendering.gpuMs ?? null,
      width: rendering.width ?? null,
      height: rendering.height ?? null,
      scalingLevel: rendering.scalingLevel ?? null,
      resources: rendering.resources ?? null,
      pipeline: rendering.pipeline ?? null,
    },
  };
}

async function runConsoleCommand(page: Page, command: string): Promise<void> {
  await page.getByTestId("play-console-open").click();
  await page.getByTestId("debug-console-input").fill(command);
  await page.getByTestId("debug-console-submit").click();
  await page.keyboard.press("Escape");
}

async function measurePlay(page: Page, cdp: CDPSession) {
  const started = Date.now();
  await clickPlayAndWaitForOverlay(page);
  await expect(page.getByTestId("play-blocked-dialog")).toHaveCount(0);
  await expect(page.getByTestId("scene-loading-dialog")).toBeHidden({ timeout: 180_000 });
  await expect(page.getByTestId("play-canvas")).toBeVisible({ timeout: 60_000 });
  await expect
    .poll(
      () => page.evaluate(() => (globalThis as unknown as PlayHost).__babylonslatePlayTest?.tickIndex() ?? -1),
      { timeout: 180_000 },
    )
    .toBeGreaterThan(30);
  const playBootMs = Date.now() - started;
  if (QUALITY) {
    await runConsoleCommand(page, `quality ${QUALITY}`);
    // Presets below ultra enable dynamic resolution; keep the project's fixed scale.
    await runConsoleCommand(page, "quality resolution reset");
  }
  if (FRAMECAP) await runConsoleCommand(page, `framecap ${FRAMECAP}`);
  await page.waitForTimeout(WARMUP_MS);
  const windows = [];
  for (let index = 0; index < SAMPLES; index += 1) {
    const since = await pageNow(page);
    const { result, busy } = await busyFraction(cdp, () => samplePlay(page, SAMPLE_MS));
    windows.push({ ...result, mainThreadBusy: busy, longTasks: await longTasksSince(page, since) });
  }
  const liveObjects = await page.evaluate(
    () => (globalThis as unknown as PlayHost).__babylonslatePlayTest?.liveObjectCounts() ?? null,
  );
  await page.getByTestId("play-overlay-close").click();
  await expect(page.getByTestId("play-overlay")).toHaveCount(0, { timeout: 60_000 });
  await expect(page.getByTestId("preview-session-report")).toHaveCount(0);
  return { playBootMs, windows, liveObjects };
}

test.skip(!ENABLED, "FeatureTest performance route; set BL_PERF_FEATURE_TEST=1 to run it.");

test("FeatureTest performance route", async ({ page }, testInfo) => {
  test.setTimeout(20 * 60_000 + SCENES.length * (SAMPLES * SAMPLE_MS * 2 + WARMUP_MS + SETTLE_MS));
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await recordLongTasks(page);
  await seedEngineSettings(page, (settings) => {
    settings.debuggerDefaults.overlayConsole = true;
    if (process.env.BL_PERF_VIEWPORT_CAP) settings.viewportFrameCap = number("BL_PERF_VIEWPORT_CAP", 30, 10);
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
    const sceneReadyMs = await openFeatureTestScene(page, scene);
    await page.waitForTimeout(SETTLE_MS);
    const viewport = [];
    for (let index = 0; index < SAMPLES; index += 1) {
      const { result, busy } = await busyFraction(cdp, () => measureViewport(page, SAMPLE_MS));
      viewport.push({ ...result, mainThreadBusy: busy });
    }
    await page.getByTestId("viewport-canvas").screenshot({ path: testInfo.outputPath(`${scene}-viewport.png`) });
    scenes[scene] = { sceneReadyMs, viewport, play: await measurePlay(page, cdp) };
  }

  const reopenToInteractiveMs = REOPEN ? await reopenFeatureTestProject(page) : null;
  const report = {
    qualification:
      "Local browser observation of the Feature Test starter on this machine's adapter; compare runs on the same machine and build only. Not device, Safari, thermal or A16 qualification. No frame-rate assertion.",
    label: process.env.BL_PERF_LABEL ?? null,
    browserProject: testInfo.project.name,
    browserVersion: page.context().browser()?.version() ?? null,
    viewportCss: page.viewportSize(),
    adapter,
    env: { SCENES, SAMPLE_MS, SAMPLES, WARMUP_MS, SETTLE_MS, QUALITY, FRAMECAP },
    phases: { createToInteractiveMs, bootAndCreateLongTasks, encodeWaitMs, reopenToInteractiveMs },
    scenes,
    pageErrors,
  };
  const body = JSON.stringify(report, null, 2);
  writeFileSync(testInfo.outputPath("feature-test-perf.json"), body);
  if (process.env.BL_PERF_OUT) writeFileSync(process.env.BL_PERF_OUT, body);
  await testInfo.attach("feature-test-perf", { body, contentType: "application/json" });
  console.log(`[feature-test-perf] ${JSON.stringify(report)}`);

  expect(SCENES.length).toBeGreaterThan(0);
  expect(pageErrors).toEqual([]);
});
