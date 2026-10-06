import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  openTestProject,
  waitForSceneViewportReady,
} from "./open-test-project";

async function expectWithinPhoneViewport(page: Page, locator: Locator) {
  await expect(locator).toBeVisible();
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  const viewport = page.viewportSize()!;
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height + 1);
}

test.describe("Phone Content Browser", () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });

  test("browses Assets in the drawer and opens a scene from its selection action", async ({
    page,
  }) => {
    await openTestProject(page);
    await expect(page.getByTestId("content-browser-folder-tree")).toHaveCount(
      0,
    );
    await page.getByTestId("content-browser-browse-folders").tap();

    const drawer = page.getByRole("dialog", { name: "Folders", exact: true });
    await expectWithinPhoneViewport(page, drawer);
    const assetsFolder = drawer.getByTestId("tree-row-assets");
    await expectWithinPhoneViewport(page, assetsFolder);
    const disclosure = drawer.getByTestId("tree-disclosure-assets");
    const disclosureBox = await disclosure.boundingBox();
    expect(disclosureBox).not.toBeNull();
    expect(disclosureBox!.width).toBeGreaterThanOrEqual(44);
    expect(disclosureBox!.height).toBeGreaterThanOrEqual(44);
    await expect(assetsFolder).toHaveAttribute("aria-expanded", "true");
    await disclosure.tap();
    await expect(drawer).toBeVisible();
    await expect(assetsFolder).toHaveAttribute("aria-expanded", "false");
    await disclosure.tap();
    await expect(assetsFolder).toHaveAttribute("aria-expanded", "true");
    await page.screenshot({
      path: "test-results/phone-content-browser-folders.png",
    });

    await assetsFolder.tap();
    await expect(drawer).toHaveCount(0);
    await page.getByTestId("content-browser-search").fill("main.scene");
    const scene = page.locator(
      '[data-asset-path="assets/main.scene.babasset"]',
    );
    await expectWithinPhoneViewport(page, scene);
    await scene.tap();
    await expect(scene).toHaveAttribute("data-selected", "true");
    await expect(page.getByTestId("document-workspace-scene")).toBeHidden();
    const open = page.getByRole("button", { name: "Open Selected Item" });
    await expectWithinPhoneViewport(page, open);
    await open.tap();

    await waitForSceneViewportReady(page);
    await expectWithinPhoneViewport(
      page,
      page.getByTestId("phone-window-switcher"),
    );
    await expect(page.getByTestId("viewport-panel")).toBeVisible();
    await expect(page.getByTestId("scene-outliner-panel")).toBeHidden();
  });
});
