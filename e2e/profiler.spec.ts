import { expect, test, type Page } from "@playwright/test";
import { openMainScene, openTestProject } from "./open-test-project";
import { clickPlayAndWaitForOverlay, showOverlayButtons } from "./play";

type PlayHost = { __hapticPlayTest?: { tickIndex(): number } };
const tick = (page: Page) => page.evaluate(() => (globalThis as unknown as PlayHost).__hapticPlayTest?.tickIndex() ?? -1);

test("Profiler records a session and captures a frame without losing the recording", async ({ page }) => {
  test.setTimeout(150_000);
  await openTestProject(page);
  await showOverlayButtons(page, ["profiler", "console"]);
  await openMainScene(page);
  await clickPlayAndWaitForOverlay(page);

  await page.getByTestId("play-profiler-open").click();
  const dialog = page.getByRole("dialog", { name: "Profiler and Frame Debugger" });
  const results = dialog.getByTestId("session-diagnostic-results");
  await dialog.getByRole("button", { name: "Record Performance" }).first().click();
  const started = await tick(page);
  // The window floats over the game: tapping the game gives it the keyboard back and leaves the window open.
  const canvas = page.getByTestId("play-canvas");
  const box = (await canvas.boundingBox())!;
  await canvas.click({ position: { x: 8, y: box.height - 8 } });
  await expect(dialog).toBeVisible();
  expect(await page.evaluate(() => document.activeElement?.getAttribute("data-testid"))).toBe("play-canvas");
  await expect.poll(() => tick(page), { timeout: 30_000 }).toBeGreaterThan(started + 30);
  // Closed, the window leaves the recording running, and the toolbar shows it until it is stopped there.
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByTestId("play-profiler-recording-stop").click();
  await expect(results).toContainText(/\d+ completed frame samples · \d+ runtime tick samples/);
  await expect(page.getByTestId("play-profiler-recording")).toHaveCount(0);

  await dialog.getByRole("button", { name: "Timeline" }).click();
  await expect(results.getByRole("table", { name: "Samples" })).toBeVisible();
  await results.getByRole("button", { name: "Runtime Ticks" }).click();
  await expect(results.getByRole("columnheader", { name: "Script MS" })).toBeVisible();

  // Frames and ticks share one chart: a frame picked on it shows the tick it presents.
  const chart = results.getByRole("group", { name: /^Performance timeline: \d+ frames, \d+ ticks/ });
  const area = (await chart.boundingBox())!;
  const tip = chart.getByRole("tooltip");
  for (let x = area.width / 2; x < area.width - 4 && !(await tip.count()); x += 2) {
    await page.mouse.move(area.x + x, area.y + 28);
  }
  await expect(tip).toContainText(/^Frames · /);
  await page.mouse.down();
  await page.mouse.up();
  await expect(results).toContainText(/Presented By This Frame|The tick this frame presents was not recorded/);
  // A drag across it summarizes the frames and ticks in that range.
  await page.mouse.move(area.x + area.width * 0.3, area.y + 28);
  await page.mouse.down();
  await page.mouse.move(area.x + area.width * 0.7, area.y + 28, { steps: 8 });
  await page.mouse.up();
  const rangeSummary = results.getByRole("status", { name: "Range Summary" });
  await expect(rangeSummary).toContainText(/Frames \d+ · Median/);
  await expect(rangeSummary).toContainText(/Ticks \d+ · Median/);
  await rangeSummary.getByRole("button", { name: "Clear Range" }).click();
  await expect(rangeSummary).toHaveCount(0);

  await dialog.getByRole("button", { name: "Capture Frame" }).click();
  await expect(results).toContainText(/Frame \d+ · Tick \d+/, { timeout: 30_000 });
  await expect(results.getByRole("list", { name: "Executed frame stages" }).getByRole("button").first()).toBeVisible();

  // The capture sits beside the recording instead of replacing it.
  await dialog.getByRole("button", { name: "Summary" }).click();
  await expect(results).toContainText(/\d+ completed frame samples/);

  await dialog.getByRole("button", { name: "Close" }).click();

  // The console records and stops through the same Profiler.
  await page.getByTestId("play-console-open").click();
  const input = page.getByTestId("debug-console-input");
  await input.fill("profile start");
  await page.getByTestId("debug-console-submit").click();
  await expect(page.getByTestId("play-profiler-recording")).toBeVisible();
  await input.fill("profile stop");
  await page.getByTestId("debug-console-submit").click();
  await expect(page.getByTestId("play-profiler-recording")).toHaveCount(0);
  await expect(results).toContainText(/\d+ completed frame samples/);

  // Both recordings stay, and the Summary compares the new one with the first.
  await expect(dialog.getByRole("combobox", { name: "Recording" })).toContainText(/^Recording 2 /);
  await dialog.getByRole("combobox", { name: "Compare With" }).click();
  await page.getByRole("option", { name: /^Compare With Recording 1 / }).click();
  await expect(results).toContainText(/compared with Recording 1 /);
  await expect(results.getByTestId("profile-compare-row").first()).toContainText("→");
  await page.getByTestId("play-overlay-close").click();
});
