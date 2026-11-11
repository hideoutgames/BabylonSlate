import { writeFileSync } from "node:fs";
import { expect, test, type CDPSession, type Page } from "@playwright/test";
import { clickPlayAndWaitForOverlay } from "./play";
import { graphicsAdapter } from "./play-performance-fixture";
import {
  createFeatureTestProject,
  FEATURE_TEST_SCENES,
  openFeatureTestScene,
  seedEngineSettings,
  waitForTextureEncodes,
  type FeatureTestSceneName,
} from "./feature-test-project";

/**
 * Local FeatureTest route for memory that grows with every frame. Opt-in: HAPTIC_PERF_HEAP=1, through
 * playwright.perf.config.ts only.
 *
 * Creates the Feature Test starter, then for each scene in HAPTIC_PERF_SCENES measures the page's live JavaScript
 * heap (read after a forced collection, so garbage does not count) over a window of the editor's viewport and a
 * window of Play, and how long Stop takes afterwards (observers a leak registers are removed one by one at Stop). A
 * heap that grows steadily while nothing changes is a leak. The report says what was allocated in each window and
 * is still alive at its end, by allocating function, from the browser's sampling heap profiler: a build that is not
 * minified names those functions.
 *
 * It asserts that the route ran cleanly, and a growth rate only when HAPTIC_PERF_HEAP_BUDGET is set.
 *
 * Env: HAPTIC_PERF_SCENES (comma list of main|stress|world|lights|occlusion|2d, default main),
 *      HAPTIC_PERF_HEAP_MS (window length, default 60000), HAPTIC_PERF_WARMUP_MS (Play before its window, default
 *      15000), HAPTIC_PERF_SETTLE_MS (editor before its window, default 8000), HAPTIC_PERF_HEAP_BUDGET (megabytes
 *      per minute either window may grow, unset: no limit), HAPTIC_PERF_LABEL, HAPTIC_PERF_OUT (extra report path).
 */
const ENABLED = process.env.HAPTIC_PERF_HEAP === "1";
const number = (name: string, fallback: number, min = 0) => {
  const value = Number(process.env[name]);
  return process.env[name] !== undefined && Number.isFinite(value) && value >= min ? value : fallback;
};
const WINDOW_MS = number("HAPTIC_PERF_HEAP_MS", 60_000, 5_000);
const WARMUP_MS = number("HAPTIC_PERF_WARMUP_MS", 15_000);
const SETTLE_MS = number("HAPTIC_PERF_SETTLE_MS", 8_000);
const BUDGET = process.env.HAPTIC_PERF_HEAP_BUDGET === undefined ? null : number("HAPTIC_PERF_HEAP_BUDGET", Infinity);
const READS = 10;
const TOP_ALLOCATORS = 12;
const SCENES = (process.env.HAPTIC_PERF_SCENES ?? "main")
  .split(",")
  .map((scene) => scene.trim())
  .filter((scene): scene is FeatureTestSceneName => scene in FEATURE_TEST_SCENES);

type PlayHost = { __hapticPlayTest?: { tickIndex: () => number | null } };
type HeapNode = {
  callFrame: { functionName: string; url: string; lineNumber: number };
  selfSize: number;
  children?: HeapNode[];
};

/** The live JavaScript heap, in megabytes, after a forced collection. */
async function liveHeapMb(cdp: CDPSession): Promise<number> {
  await cdp.send("HeapProfiler.collectGarbage");
  const { usedSize } = await cdp.send("Runtime.getHeapUsage");
  return usedSize / 1048576;
}

/** Megabytes per minute of the least-squares line through `readings`. */
function growthPerMinute(readings: Array<{ atMs: number; liveMb: number }>): number {
  const count = readings.length;
  const meanAt = readings.reduce((sum, reading) => sum + reading.atMs, 0) / count;
  const meanMb = readings.reduce((sum, reading) => sum + reading.liveMb, 0) / count;
  let covariance = 0;
  let variance = 0;
  for (const reading of readings) {
    covariance += (reading.atMs - meanAt) * (reading.liveMb - meanMb);
    variance += (reading.atMs - meanAt) ** 2;
  }
  return variance > 0 ? (covariance / variance) * 60_000 : 0;
}

/** What the window allocated that is still alive, by allocating function, most first. */
function topAllocators(head: HeapNode): Array<{ function: string; file: string; line: number; aliveMb: number }> {
  const alive = new Map<string, { function: string; file: string; line: number; bytes: number }>();
  const walk = (node: HeapNode) => {
    if (node.selfSize > 0) {
      const { functionName, url, lineNumber } = node.callFrame;
      const key = `${functionName}|${url}|${lineNumber}`;
      const entry = alive.get(key) ?? { function: functionName || "(anonymous)", file: url.replace(/^.*\//, "") || "(native)", line: lineNumber + 1, bytes: 0 };
      entry.bytes += node.selfSize;
      alive.set(key, entry);
    }
    for (const child of node.children ?? []) walk(child);
  };
  walk(head);
  return [...alive.values()]
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, TOP_ALLOCATORS)
    .map(({ bytes, ...entry }) => ({ ...entry, aliveMb: Math.round((bytes / 1048576) * 100) / 100 }));
}

async function measureHeap(cdp: CDPSession, page: Page) {
  const started = Date.now();
  const readings = [{ atMs: 0, liveMb: await liveHeapMb(cdp) }];
  await cdp.send("HeapProfiler.startSampling", { samplingInterval: 32768 });
  for (let index = 0; index < READS; index += 1) {
    await page.waitForTimeout(WINDOW_MS / READS);
    readings.push({ atMs: Date.now() - started, liveMb: await liveHeapMb(cdp) });
  }
  const { profile } = await cdp.send("HeapProfiler.stopSampling");
  const round = (value: number) => Math.round(value * 10) / 10;
  return {
    growthMbPerMinute: round(growthPerMinute(readings)),
    firstMb: round(readings[0]!.liveMb),
    lastMb: round(readings.at(-1)!.liveMb),
    readings: readings.map((reading) => ({ atMs: reading.atMs, liveMb: round(reading.liveMb) })),
    stillAlive: topAllocators(profile.head as HeapNode),
  };
}

test.skip(!ENABLED, "FeatureTest heap route; set HAPTIC_PERF_HEAP=1 to run it.");

test("FeatureTest heap route", async ({ page }, testInfo) => {
  test.setTimeout(20 * 60_000 + SCENES.length * (2 * WINDOW_MS + WARMUP_MS + SETTLE_MS + 15 * 60_000));
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await seedEngineSettings(page);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("HeapProfiler.enable");
  await createFeatureTestProject(page);
  await waitForTextureEncodes(page);
  const adapter = await graphicsAdapter(page);

  const scenes: Record<string, unknown> = {};
  const rates: Array<{ where: string; growthMbPerMinute: number }> = [];
  for (const scene of SCENES) {
    await openFeatureTestScene(page, scene);
    await page.waitForTimeout(SETTLE_MS);
    const editor = await measureHeap(cdp, page);
    await clickPlayAndWaitForOverlay(page);
    await expect(page.getByTestId("play-blocked-dialog")).toHaveCount(0);
    await expect(page.getByTestId("scene-loading-dialog")).toBeHidden({ timeout: 180_000 });
    await expect
      .poll(() => page.evaluate(() => (globalThis as unknown as PlayHost).__hapticPlayTest?.tickIndex() ?? -1), { timeout: 180_000 })
      .toBeGreaterThan(30);
    await page.waitForTimeout(WARMUP_MS);
    const play = await measureHeap(cdp, page);
    const stopStarted = Date.now();
    await page.getByTestId("play-overlay-close").click();
    await expect(page.getByTestId("play-overlay")).toHaveCount(0, { timeout: 600_000 });
    const stopMs = Date.now() - stopStarted;
    await expect(page.getByTestId("preview-session-report")).toHaveCount(0);
    // The next scene opens over the editor's reloaded view.
    const panel = page.getByTestId("viewport-panel");
    await expect(panel).toHaveAttribute("data-scene-ready", "true", { timeout: 300_000 });
    await expect(panel).toHaveAttribute("aria-busy", "false", { timeout: 300_000 });
    scenes[scene] = { editor, play, stopMs };
    rates.push({ where: `${scene} editor`, growthMbPerMinute: editor.growthMbPerMinute }, { where: `${scene} Play`, growthMbPerMinute: play.growthMbPerMinute });
  }

  const report = {
    qualification:
      "Local browser observation of the Feature Test starter on this machine; compare runs on the same machine and build only. Live heap is read after a forced collection.",
    label: process.env.HAPTIC_PERF_LABEL ?? null,
    browserProject: testInfo.project.name,
    browserVersion: page.context().browser()?.version() ?? null,
    adapter,
    env: { SCENES, WINDOW_MS, WARMUP_MS, SETTLE_MS, BUDGET },
    scenes,
    pageErrors,
  };
  const body = JSON.stringify(report, null, 2);
  writeFileSync(testInfo.outputPath("feature-test-heap.json"), body);
  if (process.env.HAPTIC_PERF_OUT) writeFileSync(process.env.HAPTIC_PERF_OUT, body);
  await testInfo.attach("feature-test-heap", { body, contentType: "application/json" });
  console.log(`[feature-test-heap] ${JSON.stringify(rates)}`);

  expect(SCENES.length).toBeGreaterThan(0);
  expect(pageErrors).toEqual([]);
  if (BUDGET !== null) expect(rates.filter((rate) => rate.growthMbPerMinute > BUDGET)).toEqual([]);
});
