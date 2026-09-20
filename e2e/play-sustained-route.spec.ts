import { expect, test, type Frame, type Page } from "@playwright/test";
import {
  QUALITY_LEVELS,
  RENDER_QUALITY_PROFILES,
  type QualityLevel,
} from "../packages/core/src/index.ts";
import { openMinimalTestProject } from "./minimal-project";
import { openMainScene } from "./open-test-project";
import { clickPlayAndWaitForOverlay, waitForPreviewBuildBoot } from "./play";
import { setPreviewScene } from "./preview-parity";
import {
  distribution,
  graphicsAdapter,
  playPerformanceRoom,
  projectFilesWithQuality,
} from "./play-performance-fixture";

/**
 * Sustained renderer qualification route. Opt-in: set BL_PERF_SUSTAINED=1.
 * Runs the shared performance room through overlay Play and then through a
 * Preview Build (the packed player host), sampling every BL_PERF_SAMPLE_MS
 * window after a 60 s warm-up for BL_PERF_SUSTAINED_MINUTES minutes. Each
 * window records rAF cadence (fps, interval median/p95/p99, stalls over
 * 33 ms), long-task time, canvas/backbuffer dimensions and the render
 * diagnostics snapshot (draw calls, scene resource counts, accounted GPU
 * reservations, hardware-scaling level, pressure sample, adapter identity).
 * It asserts only that the route ran; it never asserts a frame rate.
 *
 * Env: BL_PERF_SUSTAINED_MINUTES (default 20),
 *      BL_PERF_SUSTAINED_WARMUP_MS (default 60000, applied per host),
 *      BL_PERF_SAMPLE_MS (default 30000),
 *      BL_PERF_QUALITY (low|medium|high|ultra, default low),
 *      BL_PERF_RENDER_MODE (cel) sets project.settings.render.mode,
 *      BL_PERF_BACKEND (webgl2|webgpu) sets project.settings.render.gpuBackend.
 */
const ROUTE_ENABLED = process.env.BL_PERF_SUSTAINED === "1";
const QUALITY = (QUALITY_LEVELS as readonly string[]).includes(process.env.BL_PERF_QUALITY ?? "")
  ? (process.env.BL_PERF_QUALITY as QualityLevel)
  : "low";
const MINUTES = Number(process.env.BL_PERF_SUSTAINED_MINUTES ?? 20);
const WARMUP_MS = Number(process.env.BL_PERF_SUSTAINED_WARMUP_MS ?? 60_000);
const SAMPLE_MS = Number(process.env.BL_PERF_SUSTAINED_SAMPLE_MS ?? 30_000);
const BACKEND =
  process.env.BL_PERF_BACKEND === "webgl2" || process.env.BL_PERF_BACKEND === "webgpu"
    ? process.env.BL_PERF_BACKEND
    : null;

type Diagnostics = Record<string, unknown> | null;

type WindowSample = {
  elapsedMs: number;
  intervals: number[];
  longTasks: number[];
  diagnostics: Diagnostics;
  ticks: number | null;
  canvas: { width: number; height: number; cssWidth: number; cssHeight: number } | null;
  visibility: string;
  devicePixelRatio: number;
};

/**
 * One sampling window inside whichever host owns the frame (the editor page
 * for overlay Play, the preview iframe for Preview Build). Reads whichever
 * test hook the host exposes; diagnostics come from `renderDiagnostics()` so
 * draw calls, resource counts, GPU reservations, scaling level and pressure
 * ride the same object on both hosts.
 */
async function sampleWindow(
  host: Page | Frame,
  durationMs: number,
  canvasTestId: string,
): Promise<WindowSample> {
  return host.evaluate(
    async ({ durationMs, canvasTestId }) => {
      const global = globalThis as unknown as {
        __babylonslatePlayTest?: {
          rendering?: () => unknown;
          tickIndex?: () => number;
        };
        __babylonslatePlayerTest?: { rendering?: () => unknown };
      };
      const hooks =
        global.__babylonslatePlayTest ?? global.__babylonslatePlayerTest ?? null;
      const rendering = () => {
        try {
          return (hooks?.rendering?.() ?? null) as Record<string, unknown> | null;
        } catch {
          return null;
        }
      };
      const tickIndex = () =>
        (hooks as { tickIndex?: () => number | null } | null)?.tickIndex?.() ??
        null;
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
      const frame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve));
      const tickStart = tickIndex();
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
      const tickEnd = tickIndex();
      const canvas = document.querySelector(
        `[data-testid="${canvasTestId}"]`,
      ) as HTMLCanvasElement | null;
      return {
        elapsedMs: previous - first,
        intervals,
        longTasks,
        diagnostics: rendering(),
        ticks: tickStart !== null && tickEnd !== null ? tickEnd - tickStart : null,
        canvas: canvas
          ? {
              width: canvas.width,
              height: canvas.height,
              cssWidth: canvas.clientWidth,
              cssHeight: canvas.clientHeight,
            }
          : null,
        visibility: document.visibilityState,
        devicePixelRatio,
      };
    },
    { durationMs, canvasTestId },
  );
}

function summarizeWindow(sample: WindowSample) {
  const intervals = distribution(sample.intervals);
  const stalls = (thresholdMs: number) =>
    sample.intervals.filter((value) => value > thresholdMs).length;
  return {
    elapsedMs: sample.elapsedMs,
    averageFps:
      intervals.samples && sample.elapsedMs > 0
        ? (intervals.samples * 1000) / sample.elapsedMs
        : null,
    intervals,
    stallsOver33Ms: stalls(33.4),
    stallsOver50Ms: stalls(50),
    stallsOver100Ms: stalls(100),
    longTasks: {
      count: sample.longTasks.length,
      totalMs: sample.longTasks.reduce((sum, value) => sum + value, 0),
    },
    diagnostics: sample.diagnostics,
    ticks: sample.ticks,
    tickHz:
      sample.ticks !== null && sample.elapsedMs > 0
        ? (sample.ticks * 1000) / sample.elapsedMs
        : null,
    canvas: sample.canvas,
    visibility: sample.visibility,
    devicePixelRatio: sample.devicePixelRatio,
  };
}

function summaryLine(host: string, index: number, window: ReturnType<typeof summarizeWindow>) {
  const diagnostics = (window.diagnostics ?? {}) as Record<string, unknown>;
  const gpuReservations = (diagnostics.gpuReservations ?? {}) as Record<string, unknown>;
  const resources = (diagnostics.resources ?? {}) as Record<string, unknown>;
  const finite = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) ? value : null;
  const fixed = (value: unknown, digits = 1) =>
    finite(value) === null ? "-" : finite(value)!.toFixed(digits);
  const reservedBytes = finite(gpuReservations.reservedBytes);
  return (
    `${host} w${index}` +
    ` fps=${fixed(window.averageFps)}` +
    ` med=${fixed(window.intervals.medianMs)}ms` +
    ` p95=${fixed(window.intervals.p95Ms)}ms` +
    ` p99=${fixed(window.intervals.p99Ms)}ms` +
    ` stalls33=${window.stallsOver33Ms}` +
    ` longTasks=${window.longTasks.count}/${Math.round(window.longTasks.totalMs)}ms` +
    ` draws=${diagnostics.drawCalls ?? "-"}` +
    ` cpu=${fixed(diagnostics.cpuMs)}ms` +
    ` gpu=${fixed(diagnostics.gpuMs)}ms` +
    ` scale=${fixed(diagnostics.scalingLevel, 2)}` +
    ` meshes=${resources.meshes ?? "-"}` +
    ` tex=${resources.textures ?? "-"}/${resources.cachedTextures ?? "-"}` +
    ` gpuReserved=${reservedBytes === null ? "-" : `${Math.round(reservedBytes / 1048576)}MB`}` +
    ` backbuffer=${diagnostics.width ?? "?"}x${diagnostics.height ?? "?"}`
  );
}

test.skip(!ROUTE_ENABLED, "Sustained qualification route; set BL_PERF_SUSTAINED=1 to run it.");

test(`sustained route (${QUALITY}, ${MINUTES}min, play + preview build)`, async ({ page }, testInfo) => {
  const durationMs = Math.max(SAMPLE_MS, MINUTES * 60_000);
  const windows = Math.max(1, Math.ceil(durationMs / SAMPLE_MS));
  test.setTimeout(2 * WARMUP_MS + 2 * durationMs + 300_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await openMinimalTestProject(page, await projectFilesWithQuality(QUALITY));
  await openMainScene(page);
  const setupStarted = Date.now();
  await setPreviewScene(page, playPerformanceRoom(), 120_000);
  await expect(page.getByTestId("viewport-panel")).toHaveAttribute("data-scene-ready", "true", {
    timeout: 120_000,
  });
  const sceneSetupMs = Date.now() - setupStarted;
  const probeAdapter = await graphicsAdapter(page);

  const collect = async (
    host: Page | Frame,
    name: string,
    canvasTestId: string,
  ) => {
    const summaries = [];
    for (let index = 0; index < windows; index += 1) {
      const sample = await sampleWindow(host, SAMPLE_MS, canvasTestId);
      await testInfo.attach(`sustained-${name}-window-${index}`, {
        body: JSON.stringify(sample),
        contentType: "application/json",
      });
      summaries.push(summarizeWindow(sample));
    }
    return summaries;
  };

  const hosts: { name: string; windows: ReturnType<typeof summarizeWindow>[] }[] = [];

  // Host 1: overlay Play on the editor's shared Engine.
  const playStarted = Date.now();
  await clickPlayAndWaitForOverlay(page);
  await expect(page.getByTestId("scene-loading-dialog")).toBeHidden({ timeout: 120_000 });
  await expect(page.getByTestId("play-canvas")).toBeVisible({ timeout: 60_000 });
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            (
              globalThis as unknown as {
                __babylonslatePlayTest?: { tickIndex: () => number | null };
              }
            ).__babylonslatePlayTest?.tickIndex() ?? -1,
        ),
      { timeout: 120_000 },
    )
    .toBeGreaterThan(30);
  const playBootMs = Date.now() - playStarted;
  await page.waitForTimeout(WARMUP_MS);
  const playWindows = await collect(page, "play", "play-canvas");
  await page.getByTestId("play-canvas").screenshot({ path: testInfo.outputPath("play.png") });
  await page.getByTestId("play-overlay-close").click();
  hosts.push({ name: "play", windows: playWindows });

  // Host 2: Preview Build runs the packed player inside an iframe on its own Engine.
  const previewStarted = Date.now();
  await page.getByTestId("debug-menu").click();
  await page.getByTestId("preview-build-toggle").click();
  await page.getByTestId("play-preview").click();
  await waitForPreviewBuildBoot(page);
  const playerCanvas = page
    .frameLocator('[data-testid="preview-build-iframe"]')
    .getByTestId("player-canvas");
  await expect(playerCanvas).toBeVisible({ timeout: 60_000 });
  const previewFrame = await page.getByTestId("preview-build-iframe").contentFrame();
  if (!previewFrame) throw new Error("Preview Build iframe did not expose a Frame.");
  const previewBootMs = Date.now() - previewStarted;
  await page.waitForTimeout(WARMUP_MS);
  const previewWindows = await collect(previewFrame, "preview-build", "player-canvas");
  await playerCanvas.screenshot({ path: testInfo.outputPath("preview-build.png") });
  await page.getByTestId("preview-build-close").click();
  hosts.push({ name: "previewBuild", windows: previewWindows });

  const report = {
    qualification:
      "Sustained local browser observation of requestAnimationFrame cadence and render diagnostics across overlay Play and Preview Build; a presentation proxy on this machine's adapter, not device, Safari, thermal, or A16 qualification. No frame-rate assertion.",
    label: process.env.BL_PERF_LABEL ?? null,
    quality: QUALITY,
    qualityProfile: RENDER_QUALITY_PROFILES[QUALITY],
    renderMode: process.env.BL_PERF_RENDER_MODE === "cel" ? "cel" : "pbr",
    requestedBackend: BACKEND,
    warmupMs: WARMUP_MS,
    sampleMs: SAMPLE_MS,
    durationMinutes: MINUTES,
    browserProject: testInfo.project.name,
    browserVersion: page.context().browser()?.version() ?? null,
    headless: testInfo.project.use.headless ?? true,
    viewportCss: page.viewportSize(),
    probeAdapter,
    engineAdapters: hosts.map((host) => ({
      host: host.name,
      adapter:
        (host.windows.at(-1)?.diagnostics as Record<string, unknown> | null)?.adapter ?? null,
    })),
    sceneSetupMs,
    playBootMs,
    previewBootMs,
    pageErrors: errors,
    hosts,
  };
  await testInfo.attach("play-sustained-route", {
    body: JSON.stringify(report, null, 2),
    contentType: "application/json",
  });
  const lines = [
    `sustained route ${QUALITY}/${report.renderMode} backend=${BACKEND ?? "project"}`,
    ...hosts.flatMap((host) =>
      host.windows.map((window, index) => summaryLine(host.name, index, window)),
    ),
  ];
  await testInfo.attach("play-sustained-summary", {
    body: lines.join("\n"),
    contentType: "text/plain",
  });
  console.log(`[play-sustained-route]\n${lines.join("\n")}`);
  for (const host of hosts) {
    for (const window of host.windows) {
      expect(window.intervals.samples).toBeGreaterThan(1);
      expect(window.visibility).toBe("visible");
    }
  }
  expect(errors).toEqual([]);
});
