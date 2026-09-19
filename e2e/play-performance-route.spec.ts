import { expect, test, type Page } from "@playwright/test";
import {
  createActor,
  createDefaultScene,
  createMeshComponent,
  identitySerializedTransform,
  PROJECT_FILE,
  QUALITY_LEVELS,
  RENDER_QUALITY_PROFILES,
  type QualityLevel,
  type SerializedScene,
} from "../packages/core/src/index.ts";
import { minimalProjectFiles } from "../packages/assets/src/test-support/minimal-project";
import { openMinimalTestProject } from "./minimal-project";
import { openMainScene } from "./open-test-project";
import { clickPlayAndWaitForOverlay } from "./play";
import { setPreviewScene } from "./preview-parity";

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
 *      BL_PERF_RENDER_MODE (cel) sets project.settings.render.mode for a CEL run.
 */
const ROUTE_ENABLED = process.env.BL_PERF_ROUTE === "1";
const QUALITY = (QUALITY_LEVELS as readonly string[]).includes(process.env.BL_PERF_QUALITY ?? "")
  ? (process.env.BL_PERF_QUALITY as QualityLevel)
  : "low";
const WARMUP_MS = Number(process.env.BL_PERF_WARMUP_MS ?? 10_000);
const SAMPLE_MS = Number(process.env.BL_PERF_SAMPLE_MS ?? 30_000);
const SAMPLES = Number(process.env.BL_PERF_SAMPLES ?? 2);

/** Runtime primitives only: a lit room with static casters and settling dynamic spheres. */
export function playPerformanceRoom(): SerializedScene {
  const scene = { ...createDefaultScene(), name: "Play Performance Route" };
  const box = (
    id: string,
    position: [number, number, number],
    scale: [number, number, number],
  ) =>
    createActor(id, id, {
      transform: { ...identitySerializedTransform(), position, scale },
      components: [createMeshComponent(`${id}-mesh`, "box")],
    });
  scene.actors.push(box("Floor", [0, -1.25, 0], [44, 0.5, 44]));
  scene.actors.push(box("Back Wall", [0, 3, 22], [44, 8, 0.5]));
  scene.actors.push(box("Left Wall", [-22, 3, 0], [0.5, 8, 44]));
  scene.actors.push(box("Right Wall", [22, 3, 0], [0.5, 8, 44]));
  // 12 x 8 caster grid with deterministic height variation.
  for (let row = 0; row < 8; row += 1) {
    for (let column = 0; column < 12; column += 1) {
      const index = row * 12 + column;
      const height = 1 + ((index * 7) % 5) * 0.5;
      scene.actors.push(
        box(
          `Caster ${index}`,
          [column * 3.2 - 17.6, height / 2 - 1, row * 3.2 - 11.2],
          [0.8, height, 0.8],
        ),
      );
    }
  }
  // Dynamic spheres exercise the worker tick and snapshot application.
  for (let index = 0; index < 16; index += 1) {
    scene.actors.push(
      createActor(`Sphere ${index}`, `Sphere ${index}`, {
        transform: {
          ...identitySerializedTransform(),
          position: [(index % 4) * 4 - 6, 6 + (index % 3) * 2, Math.floor(index / 4) * 4 - 6],
        },
        components: [
          createMeshComponent(`sphere-${index}-mesh`, "sphere"),
          {
            id: `sphere-${index}-body`,
            classId: "RigidBodyComponent",
            properties: { motionType: "dynamic", mass: 1, gravityScale: 1 },
          },
        ],
      }),
    );
  }
  const light = (
    id: string,
    kind: "point" | "spot",
    position: [number, number, number],
  ) =>
    createActor(id, id, {
      transform: {
        ...identitySerializedTransform(),
        position,
        rotation: [Math.SQRT1_2, 0, 0, Math.SQRT1_2],
      },
      components: [
        {
          id: `${id}-light`,
          classId: "LightComponent",
          properties: {
            lightKind: kind,
            color: [1, 0.95, 0.85],
            intensity: 2,
            range: 16,
            innerAngle: 35,
            outerAngle: 70,
            enabled: true,
            castShadows: true,
          },
        },
      ],
    });
  scene.actors.push(light("Spot 0", "spot", [-8, 7, 0]), light("Spot 1", "spot", [8, 7, 0]));
  for (let index = 0; index < 6; index += 1)
    scene.actors.push(light(`Point ${index}`, "point", [(index % 3) * 12 - 12, 4, Math.floor(index / 3) * 12 - 6]));
  const camera = scene.actors.find((actor) => actor.id === scene.settings.mainCameraActorId);
  if (camera) {
    // Behind the room, pitched ~20 degrees down so walls, casters and spheres are all in frame.
    camera.transform = {
      ...identitySerializedTransform(),
      position: [0, 9, -30],
      rotation: [Math.sin(Math.PI / 18), 0, 0, Math.cos(Math.PI / 18)],
    };
  }
  return scene;
}

async function projectFilesWithQuality(level: QualityLevel) {
  const files = new Map(await minimalProjectFiles());
  const projectBytes = files.get(PROJECT_FILE);
  if (!projectBytes) throw new Error(`Minimal project has no ${PROJECT_FILE}`);
  const project = JSON.parse(new TextDecoder().decode(projectBytes)) as {
    settings: Record<string, unknown>;
  };
  project.settings.quality = RENDER_QUALITY_PROFILES[level];
  if (process.env.BL_PERF_RENDER_MODE === "cel") {
    project.settings.render = {
      ...(project.settings.render as Record<string, unknown> | undefined),
      mode: "cel",
    };
  }
  files.set(PROJECT_FILE, new TextEncoder().encode(JSON.stringify(project)));
  return files;
}

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

async function graphicsAdapter(page: Page) {
  return page.evaluate(() => {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
    if (!gl) return { api: null, renderer: null, vendor: null };
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    const result = {
      api: gl instanceof WebGL2RenderingContext ? "webgl2" : "webgl",
      renderer: info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER)),
      vendor: info ? String(gl.getParameter(info.UNMASKED_VENDOR_WEBGL)) : String(gl.getParameter(gl.VENDOR)),
    };
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return result;
  });
}

function distribution(values: number[]) {
  const sorted = values.filter((value) => Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
  const percentile = (fraction: number) => sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? null;
  const mean = sorted.length ? sorted.reduce((sum, value) => sum + value, 0) / sorted.length : null;
  return {
    samples: sorted.length,
    meanMs: mean,
    medianMs: percentile(0.5),
    p95Ms: percentile(0.95),
    p99Ms: percentile(0.99),
    longestMs: sorted.at(-1) ?? null,
  };
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
