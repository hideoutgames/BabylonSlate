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

  test("creates an Enum through separate type and details screens without losing edits on Back", async ({
    page,
  }) => {
    await openTestProject(page);
    await page.getByTestId("content-browser-new-asset").tap();
    const dialog = page.getByTestId("content-browser-new-asset-dialog");
    await expectWithinPhoneViewport(page, dialog);
    await expect(dialog.getByTestId("new-asset-name")).toHaveCount(0);
    await expect(
      dialog.getByRole("button", { name: "Create", exact: true }),
    ).toHaveCount(0);

    await dialog.getByTestId("new-asset-type-search").fill("Enum");
    const enumType = dialog.getByTestId("new-asset-type-Enum");
    await expectWithinPhoneViewport(page, enumType);
    await enumType.tap();
    await dialog.getByRole("button", { name: "Next", exact: true }).tap();
    await expect(
      dialog.getByRole("radiogroup", { name: "Asset Type" }),
    ).toHaveCount(0);
    const name = dialog.getByTestId("new-asset-name");
    await expectWithinPhoneViewport(page, name);
    await name.fill("PhoneStatus");
    const create = dialog.getByTestId("content-browser-new-asset-create");
    await expect(create).toBeEnabled();
    await expectWithinPhoneViewport(page, create);
    await page.screenshot({ path: "test-results/phone-new-asset-details.png" });

    await dialog.getByRole("button", { name: "Back To Types" }).tap();
    await expect(enumType).toHaveAttribute("aria-checked", "true");
    await expect(name).toHaveCount(0);
    await dialog.getByRole("button", { name: "Next", exact: true }).tap();
    await expect(name).toHaveValue("PhoneStatus");
    await create.tap();
    await expect(dialog).toHaveCount(0);

    await page.getByTestId("content-browser-search").fill("PhoneStatus");
    const created = page.locator(
      '[data-asset-path="assets/PhoneStatus.babasset"]',
    );
    await expectWithinPhoneViewport(page, created);
    await expect(created.getByText("Enum", { exact: true })).toBeVisible();
    await created.tap();
    await page.getByRole("button", { name: "Open Selected Item" }).tap();
    await expect(page.getByTestId("document-workspace-enum")).toBeVisible();
    await expect(page.getByTestId("enum-row-0")).toBeVisible();
  });
});
