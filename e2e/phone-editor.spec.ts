import { expect, test, type Page } from "@playwright/test";
import {
  openTestProject,
  waitForSceneViewportReady,
} from "./open-test-project";

async function expectWithinViewport(page: Page, testId: string) {
  const box = await page.getByTestId(testId).boundingBox();
  expect(box).not.toBeNull();
  const viewport = page.viewportSize()!;
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height + 1);
}

test.describe("Phone Editor", () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });

  test("keeps navigation and tools reachable without horizontal overflow", async ({
    page,
  }) => {
    await openTestProject(page);
    await page.screenshot({ path: "test-results/phone-content-browser.png" });
    await expect(page.getByTestId("document-switcher")).toBeVisible();
    await expectWithinViewport(page, "document-switcher");
    await expectWithinViewport(page, "editor-global-toolbar");
    await expectWithinViewport(page, "content-browser-search");
    await page.getByTestId("editor-more-tools").tap();
    await page.getByTestId("global-search").tap();
    await expect(page.getByRole("dialog", { name: /Search/ })).toBeVisible();
    await page.keyboard.press("Escape");
    await page.getByTestId("editor-more-tools").tap();
    await page.getByTestId("settings-menu").tap();
    await page.getByTestId("project-settings").tap();
    await expect(
      page.getByRole("combobox", { name: "Category" }),
    ).toBeVisible();
    await page.screenshot({ path: "test-results/phone-project-settings.png" });
  });

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
    await page.screenshot({ path: "test-results/ipad-editor.png" });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByTestId("phone-window-switcher")).toBeVisible();
    await expect(page.getByTestId("viewport-panel")).toBeVisible();
    await expect(page.getByTestId("scene-outliner-panel")).toBeHidden();
    await page.getByTestId("phone-window-switcher").tap();
    await page.getByRole("option", { name: "Outliner", exact: true }).tap();
    await expect(page.getByTestId("scene-outliner-panel")).toBeVisible();
    await expect(page.getByTestId("viewport-panel")).toBeHidden();
    await page.screenshot({ path: "test-results/phone-outliner.png" });
    await page.setViewportSize({ width: 844, height: 390 });
    await expect(page.getByTestId("phone-window-switcher")).toBeVisible();
    await expectWithinViewport(page, "phone-window-switcher");
    await expect(page.getByTestId("viewport-panel")).toBeHidden();
    await page.setViewportSize({ width: 1194, height: 834 });
    await expect(page.getByTestId("phone-window-switcher")).toHaveCount(0);
    await expect(page.getByTestId("scene-outliner-panel")).toBeVisible();
    await expect(page.getByTestId("viewport-panel")).toBeVisible();
  });
});
