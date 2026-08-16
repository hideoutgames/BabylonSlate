import { expect, test, type Page } from "@playwright/test";
import { IPAD_TEST_TAG } from "./ipad-tag";
import { openTestProject } from "./open-test-project";

async function showContentBrowser(page: Page): Promise<void> {
  await page
    .locator('[data-testid="document-tab"][data-document-kind="content-browser"]')
    .click();
  await expect(page.getByTestId("document-workspace-content-browser")).toBeVisible();
}

async function createAsset(
  page: Page,
  type: "UserInterface" | "EditorUtilityInterface",
  name: string,
): Promise<void> {
  await showContentBrowser(page);
  await page.getByTestId("content-browser-new-asset").click();
  await expect(page.getByTestId("content-browser-new-asset-dialog")).toBeVisible();
  await page.getByTestId("new-asset-type").click();
  await page.getByTestId(`new-asset-type-${type}`).click();
  await page.getByTestId("new-asset-name").fill(name);
  await page.getByTestId("content-browser-new-asset-create").click();
  await expect(page.getByTestId("content-browser-new-asset-dialog")).toHaveCount(0);
}

async function openWindowsMenu(page: Page): Promise<void> {
  const content = page.getByTestId("windows-menu-content");
  if (await content.isVisible()) return;
  await page.getByTestId("windows-menu").click();
  await expect(content).toBeVisible();
}

async function closeWindowsMenu(page: Page): Promise<void> {
  const content = page.getByTestId("windows-menu-content");
  if (!(await content.isVisible())) return;
  await page.keyboard.press("Escape");
  await expect(content).toHaveCount(0);
}

test.describe("P12 UI and EUI authoring editors", { tag: IPAD_TEST_TAG }, () => {
  test("UserInterface designer paints on Dockview without Preview Unavailable", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await openTestProject(page);
    await createAsset(page, "UserInterface", "HUD");
    await page.locator('[data-asset-path="assets/HUD.ui.babasset"]').dblclick();
    await expect(page.getByTestId("document-workspace-ui")).toBeVisible();
    await expect(page.getByTestId("ui-design-panel")).toBeVisible();
    await expect(page.getByTestId("ui-design-canvas")).toBeVisible();
    await expect(page.getByTestId("ui-gui-preview-error")).toHaveCount(0);
    await expect(page.getByTestId("windows-menu")).toBeEnabled();
    await page.getByTestId("ui-add-widget").click();
    await page.getByTestId("ui-add-widget-Button").click();
    await expect(page.locator('[data-testid^="ui-widget-button-"]')).toBeVisible();
    await expect(page.getByTestId("ui-hierarchy-panel")).toBeVisible();
    await expect(page.getByTestId("ui-details-panel")).toBeVisible();
  });

  test("EditorUtilityInterface authoring round-trips dockKind and paints GUI", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await openTestProject(page);
    await createAsset(page, "EditorUtilityInterface", "SceneTools");
    await page
      .locator('[data-asset-path="assets/SceneTools.eui.babasset"]')
      .dblclick();
    await expect(page.getByTestId("document-workspace-ui")).toBeVisible();
    await expect(page.getByTestId("ui-design-canvas")).toBeVisible();
    await expect(page.getByTestId("ui-gui-preview-error")).toHaveCount(0);
    await expect(page.getByTestId("ui-settings-panel")).toBeVisible();
    await expect(page.getByTestId("ui-dock-kind-scene")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await page.getByTestId("ui-dock-kind-class").click();
    await expect(page.getByTestId("ui-dock-kind-class")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await page
      .locator('[data-testid="document-tab"][data-document-kind="content-browser"]')
      .click();
    await page
      .locator('[data-asset-path="assets/SceneTools.eui.babasset"]')
      .dblclick();
    await expect(page.getByTestId("ui-dock-kind-class")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  test("Designer is the default mode and Logic switches Windows to Class docks", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await openTestProject(page);
    await createAsset(page, "UserInterface", "HUD");
    await page.locator('[data-asset-path="assets/HUD.ui.babasset"]').dblclick();
    await expect(page.getByTestId("ui-editor-mode-bar")).toBeVisible();
    await expect(page.getByTestId("ui-editor-mode-designer")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(page.getByTestId("ui-design-panel")).toBeVisible();
    await expect(page.getByTestId("graph-panel")).toBeHidden();

    await openWindowsMenu(page);
    await expect(page.getByTestId("windows-menu-ui-design")).toBeVisible();
    await expect(page.getByTestId("windows-menu-graph")).toHaveCount(0);
    await expect(page.getByTestId("windows-menu-my-class")).toHaveCount(0);
    await closeWindowsMenu(page);

    await page.getByTestId("ui-editor-mode-logic").click();
    await expect(page.getByTestId("ui-editor-mode-logic")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(page.getByTestId("graph-panel")).toBeVisible();
    await expect(page.getByTestId("my-class-panel")).toBeVisible();
    await expect(page.getByTestId("ui-design-panel")).toBeHidden();

    await openWindowsMenu(page);
    await expect(page.getByTestId("windows-menu-graph")).toBeVisible();
    await expect(page.getByTestId("windows-menu-my-class")).toBeVisible();
    await expect(page.getByTestId("windows-menu-ui-design")).toHaveCount(0);
    await closeWindowsMenu(page);
  });

  test("EditorUtilityInterface Settings stay on Designer", async ({ page }) => {
    test.setTimeout(60_000);
    await openTestProject(page);
    await createAsset(page, "EditorUtilityInterface", "SceneTools");
    await page
      .locator('[data-asset-path="assets/SceneTools.eui.babasset"]')
      .dblclick();
    await expect(page.getByTestId("ui-settings-panel")).toBeVisible();
    await openWindowsMenu(page);
    await expect(page.getByTestId("windows-menu-ui-settings")).toBeVisible();
    await closeWindowsMenu(page);

    await page.getByTestId("ui-editor-mode-logic").click();
    await expect(page.getByTestId("graph-panel")).toBeVisible();
    await expect(page.getByTestId("ui-settings-panel")).toBeHidden();
    await openWindowsMenu(page);
    await expect(page.getByTestId("windows-menu-ui-settings")).toHaveCount(0);
    await expect(page.getByTestId("windows-menu-graph")).toBeVisible();
    await closeWindowsMenu(page);
  });
});
