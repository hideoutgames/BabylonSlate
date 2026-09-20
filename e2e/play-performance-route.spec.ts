import { expect, test, type Page } from "@playwright/test";
import {
  QUALITY_LEVELS,
  RENDER_QUALITY_PROFILES,
  type QualityLevel,
} from "../packages/core/src/index.ts";
import { openMinimalTestProject } from "./minimal-project";
import { openMainScene } from "./open-test-project";
import { clickPlayAndWaitForOverlay } from "./play";
import { setPreviewScene } from "./preview-parity";
import {
  distribution,
  graphicsAdapter,
  playPerformanceRoom,
  projectFilesWithQuality,
} from "./play-performance-fixture";

/**
 * Local Play performance route. Opt-in: set BL_PERF_ROUTE=1. It measures the
 * page's requestAnimationFrame cadence while overlay Play runs a deterministic
 * primitive room, so results are comparable across repository revisions that
 * share the Play chrome and test-project helpers. It asserts only that the
 * route ran; it never asserts a frame rate.
 *
 * Env: BL_PERF_QUALITY (low|medium|high|ultra, default low),
 *      BL_PERF_WARMUP_MS (default 10000), BL_PERF_SAMPLE_MS (default 30000),
 *      BL_PERF_SAMPLES (default 2), BL_PERF_LABEL (free text recorded in output),
 *      BL_PERF_RENDER_MODE (cel) sets project.settings.render.mode for a CEL run,
 *      BL_PERF_BACKEND (webgl2|webgpu) sets project.settings.render.gpuBackend.
 */
const ROUTE_ENABLED = process.env.BL_PERF_ROUTE === "1";
const QUALITY = (QUALITY_LEVELS as readonly string[]).includes(process.env.BL_PERF_QUALITY ?? "")
  ? (process.env.BL_PERF_QUALITY as QualityLevel)
  : "low";
const WARMUP_MS = Number(process.env.BL_PERF_WARMUP_MS ?? 10_000);
const SAMPLE_MS = Number(process.env.BL_PERF_SAMPLE_MS ?? 30_000);
const SAMPLES = Number(process.env.BL_PERF_SAMPLES ?? 2);

type Sample = {
  elapsedMs: number;
  intervals: number[];
  longTasks: number[];
  ticks: number | null;
  heapBytes: { start: number | null; end: number | null };
  canvas: { width: number; height: number; cssWidth: number; cssHeight: number } | null;
  visibility: string;
  devicePixelRatio: number;
};

async function samplePlay(page: Page, durationMs: number): Promise<Sample> {
  return page.evaluate(async (durationMs) => {
    const host = globalThis as unknown as {
      __babylonslatePlayTest?: { tickIndex: () => number | null };
    };
    const heap = () =>
      (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? null;
    const longTasks: number[] = [];
    let observer: PerformanceObserver | null = null;
    try {
      observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) longTasks.push(entry.duration);
      });
      observer.observe({ type: "longtask", buffered: false });
    } catch {
      observer = null;
    }
    const heapStart = heap();
    const tickStart = host.__babylonslatePlayTest?.tickIndex() ?? null;
    const frame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve));
    const first = await frame();
    let previous = first;
    const intervals: number[] = [];
    for (;;) {
      const now = await frame();
      intervals.push(now - previous);
      previous = now;
      if (now - first >= durationMs) break;
    }
    observer?.disconnect();
    const tickEnd = host.__babylonslatePlayTest?.tickIndex() ?? null;
    const canvas = document.querySelector('[data-testid="play-canvas"]') as HTMLCanvasElement | null;
    return {
      elapsedMs: previous - first,
      intervals,
      longTasks,
      ticks: tickStart !== null && tickEnd !== null ? tickEnd - tickStart : null,
      heapBytes: { start: heapStart, end: heap() },
      canvas: canvas
        ? { width: canvas.width, height: canvas.height, cssWidth: canvas.clientWidth, cssHeight: canvas.clientHeight }
        : null,
      visibility: document.visibilityState,
      devicePixelRatio: devicePixelRatio,
    };
  }, durationMs);
}

function summarize(sample: Sample) {
  const intervals = distribution(sample.intervals);
  const stalls = (thresholdMs: number) => sample.intervals.filter((value) => value > thresholdMs).length;
  return {
    elapsedMs: sample.elapsedMs,
    averageFps: intervals.samples && sample.elapsedMs > 0 ? (intervals.samples * 1000) / sample.elapsedMs : null,
    intervals,
    stallsOver33Ms: stalls(33.4),
    stallsOver50Ms: stalls(50),
    stallsOver100Ms: stalls(100),
    longTasks: { count: sample.longTasks.length, totalMs: sample.longTasks.reduce((sum, value) => sum + value, 0) },
    ticks: sample.ticks,
    tickHz: sample.ticks !== null && sample.elapsedMs > 0 ? (sample.ticks * 1000) / sample.elapsedMs : null,
    heapBytes: sample.heapBytes,
    canvas: sample.canvas,
    visibility: sample.visibility,
    devicePixelRatio: sample.devicePixelRatio,
  };
}

test.skip(!ROUTE_ENABLED, "Local Play performance route; set BL_PERF_ROUTE=1 to run it.");

test(`Play performance route (${QUALITY})`, async ({ page }, testInfo) => {
  test.setTimeout(WARMUP_MS + SAMPLE_MS * SAMPLES + 300_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await openMinimalTestProject(page, await projectFilesWithQuality(QUALITY));
  await openMainScene(page);
  const setupStarted = Date.now();
  await setPreviewScene(page, playPerformanceRoom(), 120_000);
  await expect(page.getByTestId("viewport-panel")).toHaveAttribute("data-scene-ready", "true", { timeout: 120_000 });
  const sceneSetupMs = Date.now() - setupStarted;
  const adapter = await graphicsAdapter(page);

  const playStarted = Date.now();
  await clickPlayAndWaitForOverlay(page);
  await expect(page.getByTestId("scene-loading-dialog")).toBeHidden({ timeout: 120_000 });
  await expect(page.getByTestId("play-canvas")).toBeVisible({ timeout: 60_000 });
  // The runtime must be ticking before warm-up starts; models/shaders settle during warm-up.
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            (globalThis as unknown as { __babylonslatePlayTest?: { tickIndex: () => number | null } })
              .__babylonslatePlayTest?.tickIndex() ?? -1,
        ),
      { timeout: 120_000 },
    )
    .toBeGreaterThan(30);
  const playBootMs = Date.now() - playStarted;
  await page.waitForTimeout(WARMUP_MS);

  // Optional main-thread CPU profile of steady-state Play (BL_PERF_PROFILE=1, BL_PERF_PROFILE_MS default 10000).
  let profilePath: string | null = null;
  if (process.env.BL_PERF_PROFILE === "1") {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Profiler.enable");
    await cdp.send("Profiler.setSamplingInterval", { interval: 250 });
    await cdp.send("Profiler.start");
    await page.waitForTimeout(Number(process.env.BL_PERF_PROFILE_MS ?? 10_000));
    const { profile } = await cdp.send("Profiler.stop");
    await cdp.detach();
    profilePath = testInfo.outputPath("play.cpuprofile");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(profilePath, JSON.stringify(profile));
    console.log(`[play-performance-route] cpuprofile ${profilePath}`);
  }

  const samples = [];
  for (let index = 0; index < SAMPLES; index += 1) {
    const sample = await samplePlay(page, SAMPLE_MS);
    await testInfo.attach(`play-performance-sample-${index}`, {
      body: JSON.stringify(sample),
      contentType: "application/json",
    });
    samples.push(summarize(sample));
  }
  await page.getByTestId("play-canvas").screenshot({ path: testInfo.outputPath("play.png") });
  await page.getByTestId("play-overlay-close").click();

  const report = {
    qualification:
      "Local browser observation of requestAnimationFrame cadence during overlay Play; a presentation proxy on this machine's adapter, not device, Safari, thermal, or A16 qualification. No frame-rate assertion.",
    label: process.env.BL_PERF_LABEL ?? null,
    quality: QUALITY,
    qualityProfile: RENDER_QUALITY_PROFILES[QUALITY],
    warmupMs: WARMUP_MS,
    sampleMs: SAMPLE_MS,
    browserProject: testInfo.project.name,
    browserVersion: page.context().browser()?.version() ?? null,
    headless: testInfo.project.use.headless ?? true,
    viewportCss: page.viewportSize(),
    adapter,
    sceneSetupMs,
    playBootMs,
    pageErrors: errors,
    profilePath,
    samples,
  };
  await testInfo.attach("play-performance-route", {
    body: JSON.stringify(report, null, 2),
    contentType: "application/json",
  });
  console.log(`[play-performance-route] ${JSON.stringify(report)}`);
  for (const sample of samples) {
    expect(sample.intervals.samples).toBeGreaterThan(1);
    expect(sample.visibility).toBe("visible");
  }
  expect(errors).toEqual([]);
});
