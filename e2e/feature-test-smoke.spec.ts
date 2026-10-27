import { expect, test, type Page } from "@playwright/test";
import { createFeatureTestProject, openFeatureTestScene, seedEngineSettings } from "./feature-test-project";
import { clickPlayAndWaitForOverlay } from "./play";

/**
 * Required smoke for the Feature Test starter: its main scene loads in the editor viewport and in Play on software
 * GL, Play finishes the load (world and Scene Layers) and plays on, and the Play session reports no error. The
 * starter places every engine feature, so a combination that fails to load (an outline beside a Mirror once did)
 * fails here instead of only on a device. Play draws frames well before the world load finishes: its first-frame
 * presentation comes minutes later on software GL, and a WebGL error the world raises by then fails it (a Mirror's
 * draw in the effects' geometry pass once did). A Scene Layer's load must not starve behind the world's slow frames
 * (the HUD's once took ten minutes more). The in-app Feature Test Check covers the same steps with device-sized
 * limits and frame sampling.
 */

/** Play's load on software GL compiles, rehearses and presents the whole scene on one thread (minutes). */
const PLAY_LOAD_MS = 8 * 60_000;
/** Gameplay after the load, so an error on the next ticks reaches the session report. */
const PLAY_MS = 3_000;

type PlayHost = {
  __hapticPlayTest?: {
    rendering(): { frameAdmission?: { worldLoading: boolean; pendingPresentations: number } } | null;
  };
};

/** Play's load: loading (the world presenting, or the Scene Loading dialog up for a layer), loaded, or not begun. */
async function playLoad(page: Page): Promise<"loading" | "loaded" | "closed" | null> {
  if (!(await page.getByTestId("play-overlay").count())) return "closed";
  return page.evaluate(() => {
    const admission = (globalThis as unknown as PlayHost).__hapticPlayTest?.rendering()?.frameAdmission;
    if (!admission) return null;
    const dialog = document.querySelector('[data-testid="scene-loading-dialog"]');
    return admission.worldLoading || admission.pendingPresentations > 0 || dialog ? "loading" : "loaded";
  });
}

test("the Feature Test main scene loads in the editor and in Play without session errors", async ({ page }) => {
  test.setTimeout(14 * 60_000);
  await seedEngineSettings(page);
  await createFeatureTestProject(page);
  await openFeatureTestScene(page, "main");
  await clickPlayAndWaitForOverlay(page);
  // A failed presentation ends Play by itself. "loaded" counts only after the load was seen running.
  let outcome: Awaited<ReturnType<typeof playLoad>> = null;
  let started = false;
  await expect.poll(async () => {
    outcome = await playLoad(page);
    started ||= outcome === "loading";
    return outcome === "closed" || (started && outcome === "loaded");
  }, { message: "Play finishes the load", timeout: PLAY_LOAD_MS }).toBe(true);
  if (outcome === "loaded") {
    await page.waitForTimeout(PLAY_MS);
    // Software GL draws this scene at a frame or two a second, too slow for a click's stability check.
    const close = page.getByTestId("play-overlay-close");
    if (await close.count()) await close.dispatchEvent("click");
  }
  await expect(page.getByTestId("play-overlay")).toHaveCount(0, { timeout: 60_000 });
  // A session with entries opens its report as Play closes; only errors fail the smoke, as in the Feature Test Check.
  await page.getByTestId("preview-session-report").waitFor({ state: "visible", timeout: 5_000 }).catch(() => {});
  expect(await sessionErrors(page)).toEqual([]);
  expect(outcome, "Play finishes the load before it closes").toBe("loaded");
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
