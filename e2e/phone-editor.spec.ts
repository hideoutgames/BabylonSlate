import { expect, test, type Page } from "@playwright/test";
import {
  openTestProject,
  waitForSceneViewportReady,
} from "./open-test-project";

// Polls because dock panels re-lay out a frame after viewport or inset changes.
async function expectWithinViewport(page: Page, testId: string) {
  const viewport = page.viewportSize()!;
  await expect
    .poll(async () => {
      const box = await page.getByTestId(testId).boundingBox();
      return box
        ? {
            left: box.x >= 0,
            top: box.y >= 0,
            right: box.x + box.width <= viewport.width + 1,
            bottom: box.y + box.height <= viewport.height + 1,
          }
        : null;
    })
    .toEqual({ left: true, top: true, right: true, bottom: true });
}

test.describe("Phone Editor", () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });

  test("shows one scene window, switches windows, and restores the tablet arrangement", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1194, height: 834 });
    await openTestProject(page);
    await page
      .locator('[data-asset-path="assets/main.scene.babasset"]')
      .dblclick();
    await waitForSceneViewportReady(page);
    await expect(page.getByTestId("scene-outliner-panel")).toBeVisible();
    await page.screenshot({
      path: "test-results/ipad-editor.png",
      animations: "disabled",
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByTestId("phone-window-switcher")).toBeVisible();
    await expect(page.getByTestId("viewport-panel")).toBeVisible();
    await expect(page.getByTestId("scene-outliner-panel")).toBeHidden();
    await page.getByTestId("phone-window-switcher").tap();
    await page.getByRole("option", { name: "Outliner", exact: true }).tap();
    await expect(page.getByTestId("scene-outliner-panel")).toBeVisible();
    await expect(page.getByTestId("viewport-panel")).toBeHidden();
    await page.screenshot({
      path: "test-results/phone-outliner.png",
      animations: "disabled",
    });
    await page.setViewportSize({ width: 844, height: 390 });
    await expect(page.getByTestId("phone-window-switcher")).toBeVisible();
    await expectWithinViewport(page, "phone-window-switcher");
    await expect(page.getByTestId("viewport-panel")).toBeHidden();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.addStyleTag({
      content: ":root { --safe-top: 59px; --safe-bottom: 34px; }",
    });
    await expect(page.getByTestId("scene-outliner-panel")).toBeVisible();
    await expectWithinViewport(page, "scene-outliner-panel");
    await expect
      .poll(async () => {
        const box = await page.getByTestId("phone-window-switcher").boundingBox();
        return box ? box.y + box.height : Infinity;
      })
      .toBeLessThanOrEqual(810);
    await page.getByTestId("phone-window-switcher").tap();
    await page.getByRole("option", { name: "Viewport", exact: true }).tap();
    await expect(page.getByTestId("viewport-panel")).toBeVisible();
    await expectWithinViewport(page, "viewport-panel");
    await page.addStyleTag({
      content: ":root { --safe-top: 0px; --safe-bottom: 0px; }",
    });
    await page.setViewportSize({ width: 1194, height: 834 });
    await expect(page.getByTestId("phone-window-switcher")).toHaveCount(0);
    await expect(page.getByTestId("scene-outliner-panel")).toBeVisible();
    await expect(page.getByTestId("viewport-panel")).toBeVisible();
  });
});
