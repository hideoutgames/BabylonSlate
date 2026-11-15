import { expect, test } from "@playwright/test";
import { createFeatureTestProject, seedEngineSettings } from "./feature-test-project";
import { openAssetFromBrowser } from "./open-test-project";

test.describe("Animation Events", () => {
  test("the robot graph's Preview flashes its frame and state events as they fire", async ({ page }) => {
    test.setTimeout(240_000);
    await seedEngineSettings(page);
    await createFeatureTestProject(page);
    await openAssetFromBrowser(page, "assets/FeatureTest/TwoD/FT_2DRobotGraph.anim2d.hasset");
    await expect(page.getByTestId("anim-preview-2d")).toBeVisible({ timeout: 30_000 });
    // The walk's contact frames fire Step; Jump fires Jump Started as it begins. Each name shows for a moment.
    const flashed = page.getByTestId("anim-preview-events-name");
    await expect(flashed.filter({ hasText: /^Step$/ }).first()).toBeVisible({ timeout: 30_000 });
    await expect(flashed.filter({ hasText: /^Jump Started$/ }).first()).toBeVisible({ timeout: 30_000 });
  });
});
