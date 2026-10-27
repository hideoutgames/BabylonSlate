import { expect, test, type Page } from "@playwright/test";
import { createFeatureTestProject, openFeatureTestScene, seedEngineSettings } from "./feature-test-project";
import { clickPlayAndWaitForOverlay } from "./play";

/**
 * Required smoke for the Feature Test starter: its main scene loads in the editor viewport and presents in Play on
 * software GL, plays for a few seconds, and the Play session reports no error. The starter places every engine
 * feature, so a combination that fails to load (an outline beside a Mirror once did) fails here instead of only on a
 * device. The in-app Feature Test Check covers the same steps with device-sized limits and frame sampling.
 */

/** Play's load on software GL compiles and rehearses the whole scene on one thread (seconds locally; the limit leaves a slow runner room). */
const PLAY_LOAD_MS = 4 * 60_000;
/** Gameplay before Play closes, so a script error on its first ticks reaches the session report. */
const PLAY_MS = 3_000;

type PlayHost = {
  __hapticPlayTest?: { tickIndex(): number; rendering(): { presentation?: { copied: number } } | null };
};

async function presented(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const host = (globalThis as unknown as PlayHost).__hapticPlayTest;
    return (host?.rendering()?.presentation?.copied ?? 0) > 0 && (host?.tickIndex() ?? 0) > 0;
  });
}

test("the Feature Test main scene loads in the editor and in Play without session errors", async ({ page }) => {
  test.setTimeout(8 * 60_000);
  await seedEngineSettings(page);
  await createFeatureTestProject(page);
  await openFeatureTestScene(page, "main");
  await clickPlayAndWaitForOverlay(page);
  await expect.poll(() => presented(page), { message: "Play presents the main scene", timeout: PLAY_LOAD_MS }).toBe(true);
  await page.waitForTimeout(PLAY_MS);
  // Software GL draws this scene at a frame or two a second, too slow for a click's stability check.
  await page.getByTestId("play-overlay-close").dispatchEvent("click");
  await expect(page.getByTestId("play-overlay")).toHaveCount(0, { timeout: 60_000 });
  // A session with entries opens its report as Play closes; only errors fail the smoke, as in the Feature Test Check.
  await page.getByTestId("preview-session-report").waitFor({ state: "visible", timeout: 5_000 }).catch(() => {});
  expect(await sessionErrors(page)).toEqual([]);
});

/** The open session report's error rows, each group with errors expanded to show them. */
async function sessionErrors(page: Page): Promise<string[]> {
  const groups = page.getByTestId("session-report-group");
  const errors: string[] = [];
  for (let index = 0; index < (await groups.count()); index++) {
    const group = groups.nth(index);
    if (!/\bErrors?\b/.test(await group.getByTestId("session-report-group-counts").innerText())) continue;
    await group.getByTestId("session-report-group-toggle").dispatchEvent("click");
    for (const row of await group.getByTestId("session-report-row").all()) {
      const text = (await row.innerText()).replace(/\s+/g, " ").trim();
      if (!/^Warning\b/.test(text)) errors.push(text);
    }
  }
  return errors;
}
