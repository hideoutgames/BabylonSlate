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
    // Nearer Walk (Speed 0.8 of 0–1), Walk's frames play instead.
    const box = (await grid.boundingBox())!;
    await page.mouse.click(box.x + 48 + (box.width - 68) * 0.8, box.y + box.height / 2);
    await expect(page.getByTestId("blend-space-weights")).toContainText("FT_2DRobotWalkAnim1.00");
    await expect.poll(() => frames.getAttribute("data-clip")).not.toBe(idleClip);
    // The frame's Texture draws.
    await expect(frames.locator("img")).toBeVisible({ timeout: 30_000 });
    await page.screenshot({ path: testInfo.outputPath("sprite-blend-space.png") });
  });
});
