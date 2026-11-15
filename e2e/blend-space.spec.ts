import { expect, test } from "@playwright/test";
import { openAssetFromBrowser, openContentBrowser, openTestProject, selectContentBrowserAssetsFolder } from "./open-test-project";

test.describe("Blend Space", () => {
  test("is created on the Mannequin Skeleton, takes samples on its Grid and plays them in its Preview", async ({ page }, testInfo) => {
    await openTestProject(page);
    await openContentBrowser(page);
    await selectContentBrowserAssetsFolder(page);
    await page.getByTestId("content-browser-new-asset").click();
    await page.getByTestId("new-asset-type-menu-query").fill("Blend Space");
    await page.getByTestId("search-item-BlendSpace").click();
    await page.getByTestId("new-asset-name").fill("MannequinLocomotion");
    // New Asset asks for the Skeleton.
    await page.getByTestId("new-asset-skeleton").click();
    await page.getByRole("dialog", { name: "Choose Skeleton" }).getByText("mannequin_Skeleton", { exact: true }).click();
    await expect(page.getByTestId("new-asset-skeleton")).toHaveText("mannequin_Skeleton");
    await page.getByTestId("content-browser-new-asset-create").click();
    await expect(page.getByTestId("content-browser-new-asset-dialog")).toHaveCount(0);

    await openAssetFromBrowser(page, "assets/MannequinLocomotion.blendspace.hasset");
    await expect(page.getByTestId("document-workspace-blend-space")).toBeVisible();
    const grid = page.getByTestId("blend-space-grid");
    await expect(grid).toBeVisible();
    const animations = page.getByTestId("blend-space-animations-panel");
    // Only the Mannequin's Animations are offered.
    const idle = animations.getByRole("listitem").filter({ hasText: "mannequin_idle" });
    await expect(idle).toHaveCount(1);
    const walk = animations.getByRole("listitem").filter({ hasText: /^mannequin_walk/ });
    await expect(walk).toHaveCount(1);

    // Idle at the preview point's start (Speed 0), then Walk at Speed 2.
    await idle.getByRole("button", { name: "Add At Preview Point" }).click();
    await expect(page.getByTestId("blend-space-sample-0")).toHaveAttribute("data-x", "0");
    const box = (await grid.boundingBox())!;
    // The plot spans 48 px from the left to 20 px from the right for Speed 0 … 6.
    const atSpeed = (speed: number) => box.x + 48 + ((box.width - 68) * speed) / 6;
    await page.mouse.click(atSpeed(2), box.y + box.height / 2);
    await expect(grid).toHaveAttribute("data-point-x", /^(1\.9|2)/);
    await walk.getByRole("button", { name: "Add At Preview Point" }).click();
    await expect(page.getByTestId("blend-space-sample-1")).toHaveAttribute("data-x", "2");

    // Halfway between them both play.
    await page.mouse.click(atSpeed(1), box.y + box.height / 2);
    await expect(page.getByTestId("blend-space-weights")).toContainText("mannequin_idle0.5");
    await expect(page.getByTestId("blend-space-weights")).toContainText("mannequin_walk");

    // The Preview binds both clips to the Mannequin and plays the blend.
    const canvas = page.getByTestId("blend-space-preview-3d").getByTestId("anim-preview-canvas");
    await expect(canvas).toHaveAttribute("data-clips", "2", { timeout: 30_000 });
    const cycle = page.getByTestId("blend-space-preview-cycle");
    const first = await cycle.textContent();
    await expect.poll(() => cycle.textContent()).not.toBe(first);
    await page.getByTestId("blend-space-preview-pause").click();
    await expect(page.getByTestId("blend-space-preview-play")).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("blend-space-editor.png") });
  });
});
