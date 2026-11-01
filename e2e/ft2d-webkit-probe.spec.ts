import { WEBKIT_SMOKE_TAG } from "./ipad-tag";
import { createFeatureTestProject, openFeatureTestScene, seedEngineSettings } from "./feature-test-project";
import { acceptUnsavedPlayPrompts } from "./unsaved-play";
import { expect, test } from "./profile-context";
import type { Page } from "@playwright/test";

// Temporary investigation probe, not for merge: plays FT_2D in WebKit and records the game worker's start.

type Outcome = { loaded: boolean; report: string[]; ms: number };

async function playOnce(page: Page, add: (line: string) => void): Promise<Outcome> {
  const started = Date.now();
  await acceptUnsavedPlayPrompts(page);
  await page.getByTestId("play-preview").click();
  const report = page.getByTestId("preview-session-report");
  const deadline = started + 240_000;
  let loaded = false;
  while (Date.now() < deadline) {
    if (await report.isVisible().catch(() => false)) break;
    const tick = await page.evaluate(() =>
      (globalThis as unknown as { __hapticPlayTest?: { tickIndex: () => number | null } }).__hapticPlayTest?.tickIndex() ?? -1,
    ).catch(() => -1);
    const loading = await page.getByTestId("scene-loading-dialog").isVisible().catch(() => false);
    if (tick > 30 && !loading) { loaded = true; break; }
    await page.waitForTimeout(250);
  }
  const rows: string[] = [];
  if (await report.isVisible().catch(() => false)) {
    for (const toggle of await page.getByTestId("session-report-group-toggle").all()) await toggle.click().catch(() => {});
    for (const row of await page.getByTestId("session-report-row").all()) rows.push(await row.innerText());
  }
  add(`play outcome: loaded=${loaded} after ${Date.now() - started} ms; report rows: ${JSON.stringify(rows)}`);
  return { loaded, report: rows, ms: Date.now() - started };
}

async function stopPlay(page: Page): Promise<void> {
  const close = page.getByTestId("play-overlay-close");
  if (await close.isVisible().catch(() => false)) await close.click();
  await expect(page.getByTestId("play-overlay")).toHaveCount(0, { timeout: 60_000 });
  const report = page.getByTestId("preview-session-report");
  if (await report.isVisible().catch(() => false)) await page.keyboard.press("Escape");
}

test("FT_2D Play probe in WebKit", { tag: WEBKIT_SMOKE_TAG }, async ({ page }, testInfo) => {
  test.setTimeout(900_000);
  const t0 = Date.now();
  const log: string[] = [];
  const add = (line: string) => log.push(`${((Date.now() - t0) / 1000).toFixed(1)}s ${line}`);
  page.on("console", (message) => add(`console.${message.type()}: ${message.text()}`));
  page.on("pageerror", (error) => add(`pageerror: ${error.message} ${error.stack ?? ""}`));
  page.on("worker", (worker) => {
    add(`worker created: ${worker.url()}`);
    worker.on("close", () => add(`worker closed: ${worker.url()}`));
  });
  page.context().on("requestfailed", (request) => add(`requestfailed: ${request.url()} ${request.failure()?.errorText ?? ""}`));
  page.context().on("response", (response) => {
    if (response.status() >= 400) add(`response ${response.status()}: ${response.url()}`);
  });
  await page.addInitScript(() => {
    navigator.serviceWorker?.addEventListener("message", (event: MessageEvent) => {
      if (event.data?.coiProbe) console.log(`COI-PROBE ${JSON.stringify(event.data)}`);
    });
    navigator.serviceWorker?.startMessages?.();
  });
  const outcomes: Outcome[] = [];
  try {
    await seedEngineSettings(page);
    await createFeatureTestProject(page);
    add("project created");
    await openFeatureTestScene(page, "2d");
    add("FT_2D open");
    outcomes.push(await playOnce(page, add));
    await stopPlay(page);
    outcomes.push(await playOnce(page, add));
    await stopPlay(page);
  } finally {
    const body = log.join("\n");
    await testInfo.attach("ft2d-webkit-probe-log", { body, contentType: "text/plain" });
    console.log(`FT2D-PROBE-LOG-BEGIN\n${body}\nFT2D-PROBE-LOG-END`);
  }
  expect(outcomes.map((outcome) => outcome.loaded)).toEqual([true, true]);
});
