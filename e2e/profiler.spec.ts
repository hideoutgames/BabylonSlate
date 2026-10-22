import { expect, test, type Page } from "@playwright/test";
import { openMainScene, openTestProject } from "./open-test-project";
import { clickPlayAndWaitForOverlay, showOverlayButtons } from "./play";

type PlayHost = { __hapticPlayTest?: { tickIndex(): number } };
const tick = (page: Page) => page.evaluate(() => (globalThis as unknown as PlayHost).__hapticPlayTest?.tickIndex() ?? -1);

test("Profiler records a session and captures a frame without losing the recording", async ({ page }) => {
  test.setTimeout(120_000);
  await openTestProject(page);
  await showOverlayButtons(page, ["profiler"]);
  await openMainScene(page);
  await clickPlayAndWaitForOverlay(page);

  await page.getByTestId("play-profiler-open").click();
  const dialog = page.getByRole("dialog", { name: "Profiler and Frame Debugger" });
  const results = dialog.getByTestId("session-diagnostic-results");
  await dialog.getByRole("button", { name: "Record Performance" }).first().click();
  const started = await tick(page);
  await expect.poll(() => tick(page), { timeout: 30_000 }).toBeGreaterThan(started + 30);
  await dialog.getByRole("button", { name: "Stop Recording" }).click();
  await expect(results).toContainText(/\d+ completed frame samples · \d+ runtime tick samples/);

  await dialog.getByRole("button", { name: "Timeline" }).click();
  await expect(results.getByRole("table", { name: "Samples" })).toBeVisible();
  await results.getByRole("button", { name: "Runtime Ticks" }).click();
  await expect(results.getByRole("columnheader", { name: "Script MS" })).toBeVisible();

  await dialog.getByRole("button", { name: "Capture Frame" }).click();
  await expect(results).toContainText(/Frame \d+ · Tick \d+/, { timeout: 30_000 });
  await expect(results.getByRole("list", { name: "Executed frame stages" }).getByRole("button").first()).toBeVisible();

  // The capture sits beside the recording instead of replacing it.
  await dialog.getByRole("button", { name: "Summary" }).click();
  await expect(results).toContainText(/\d+ completed frame samples/);

  await dialog.getByRole("button", { name: "Close" }).click();
  await page.getByTestId("play-overlay-close").click();
});
