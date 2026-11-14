import { expect, test } from "@playwright/test";
import { createFeatureTestProject, seedEngineSettings } from "./feature-test-project";
import { openAssetFromBrowser } from "./open-test-project";

test.describe("Sprite Blend Space", () => {
  test("shows the robot's Idle and Walk on its Grid and plays the nearest one's frames in its Preview", async ({ page }, testInfo) => {
    test.setTimeout(240_000);
    await seedEngineSettings(page);
    await createFeatureTestProject(page);
    await openAssetFromBrowser(page, "assets/FeatureTest/TwoD/FT_2DRobotGait.spriteblend.hasset");
    await expect(page.getByTestId("document-workspace-blend-space")).toBeVisible();
    const grid = page.getByTestId("blend-space-grid");
    await expect(page.getByTestId("blend-space-sample-0")).toHaveAttribute("data-x", "0");
    await expect(page.getByTestId("blend-space-sample-1")).toHaveAttribute("data-x", "1");
    // A Sprite Blend Space edits Hysteresis and Keep Time, not a Skeleton.
    await expect(page.getByTestId("property-row-hysteresis")).toBeVisible();
    await expect(page.getByTestId("property-row-skeleton")).toHaveCount(0);

    // The preview point starts at Speed 0: Idle's frames play.
    const frames = page.getByTestId("blend-space-preview-2d");
    const idleGuid = await page.getByTestId("blend-space-sample-0").getAttribute("data-guid");
    await expect(frames).not.toHaveAttribute("data-frame-index", "-1", { timeout: 30_000 });
    const idleClip = await frames.getAttribute("data-clip");
    expect(idleClip).toBeTruthy();
    expect(idleClip).toBe(idleGuid);
    await expect(frames.locator("img")).toBeVisible({ timeout: 30_000 });
    // From here the view never goes blank: each change it commits is checked for a frame image.
    await frames.evaluate((element) => {
      const record = window as unknown as { blankFrameCommits: number };
      record.blankFrameCommits = 0;
      new MutationObserver(() => {
        if (!element.querySelector("img")) record.blankFrameCommits += 1;
      }).observe(element, { childList: true, subtree: true, attributes: true });
    });
    // Nearer Walk (Speed 0.8 of 0–1), Walk's frames play instead, with no blank frame between.
    const box = (await grid.boundingBox())!;
    await page.mouse.click(box.x + 48 + (box.width - 68) * 0.8, box.y + box.height / 2);
    await expect(page.getByTestId("blend-space-weights")).toContainText("FT_2DRobotWalkAnim1.00");
    await expect.poll(() => frames.getAttribute("data-clip")).not.toBe(idleClip);
    await expect(frames).toHaveAttribute("data-frame-loading", "false");
    await expect(frames.locator("img")).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { blankFrameCommits: number }).blankFrameCommits)).toBe(0);
    await page.screenshot({ path: testInfo.outputPath("sprite-blend-space.png") });
  });
});
