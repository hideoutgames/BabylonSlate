import { expect, test, type Page } from "@playwright/test";
import { closeProjectViaSettings } from "./close-project";
import { IPAD_TEST_TAG } from "./ipad-tag";
import { openAssetFromBrowser, openContentBrowser, openTestProject } from "./open-test-project";
import {
  assertNoPageFailures,
  attachPageFailureCollector,
  readUiHostStats,
} from "./page-failures";

const E2E_TIMEOUT_MS = 90_000;

type UiAssetType = "UserInterface" | "EditorUtilityInterface";
type AddableWidgetKind =
  | "Button"
  | "CheckBox"
  | "Slider"
  | "ScrollBox"
  | "TextInput";

async function createAsset(
  page: Page,
  type: UiAssetType,
  name: string,
): Promise<void> {
  await openContentBrowser(page);
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
  if (await content.isVisible()) {
    await page.keyboard.press("Escape");
  }
  if (await content.isVisible()) {
    await page.getByTestId("windows-menu").click();
  }
  await expect(content).toHaveCount(0);
}

function visibleUiWorkspace(page: Page) {
  return page.locator('[data-testid="document-workspace-ui"]:visible');
}

async function expectDesignerReady(page: Page): Promise<void> {
  const workspace = visibleUiWorkspace(page);
  await expect(workspace).toBeVisible();
  await expect(workspace.getByTestId("ui-design-canvas")).toBeVisible();
  await expect(workspace.getByTestId("ui-gui-preview-error")).toHaveCount(0);
}

async function expectDesignerHostStats(page: Page): Promise<void> {
  await expect
    .poll(
      async () => {
        const stats = await readUiHostStats(page);
        return stats.apply > 0 && stats.present > 0;
      },
      { timeout: 15_000 },
    )
    .toBe(true);
}

async function selectCanvasRoot(page: Page): Promise<void> {
  await visibleUiWorkspace(page)
    .getByTestId("ui-widget-canvas")
    .click({ position: { x: 8, y: 8 } });
}

async function setUiEditorMode(
  page: Page,
  mode: "designer" | "logic",
): Promise<void> {
  await visibleUiWorkspace(page)
    .getByTestId(`ui-editor-mode-${mode}`)
    .click();
}

async function addWidget(page: Page, kind: AddableWidgetKind): Promise<void> {
  const workspace = page.locator(
    '[data-testid="document-workspace-ui"]:visible',
  );
  await workspace.getByTestId("ui-add-widget").click();
  await expect(page.getByTestId("ui-widget-catalog")).toBeVisible();
  const search = page.getByTestId("ui-widget-catalog-search");
  if ((await search.count()) > 0) {
    await search.fill(kind);
  }
  await page.getByTestId(`ui-add-widget-${kind}`).click();
  await expect(page.getByTestId("ui-widget-catalog")).toHaveCount(0);
  await expect(
    workspace.locator(`[data-testid^="ui-widget-${kind.toLowerCase()}-"]`),
  ).toBeVisible();
}

async function switchToAsset(
  page: Page,
  assetPath: string,
  tabLabel: string,
): Promise<void> {
  const tab = page.locator("[data-testid='document-tab']").filter({
    hasText: tabLabel === "HUD" ? /^HUD( \*)?$/ : tabLabel,
  });
  if ((await tab.count()) === 1) {
    const select = tab.getByTestId("document-tab-select");
    if ((await select.count()) > 0 && (await select.isVisible())) {
      await select.click();
      return;
    }
  }
  await openAssetFromBrowser(page, assetPath);
}

async function discardCloseIfNeeded(page: Page): Promise<void> {
  const discard = page.getByTestId("dirty-discard");
  await expect(page.getByTestId("homepage").or(discard)).toBeVisible();
  if (await discard.isVisible()) {
    await discard.click();
  }
  await expect(page.getByTestId("homepage")).toBeVisible();
}

test.describe("P12 UI and EUI authoring editors", { tag: IPAD_TEST_TAG }, () => {
  test("UserInterface designer paints on Dockview without Preview Unavailable", async ({
    page,
  }) => {
    test.setTimeout(E2E_TIMEOUT_MS);
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
    test.setTimeout(E2E_TIMEOUT_MS);
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
    test.setTimeout(E2E_TIMEOUT_MS);
    await openTestProject(page);
    await createAsset(page, "UserInterface", "HUD");
    await page.locator('[data-asset-path="assets/HUD.ui.babasset"]').dblclick();
    await expect(page.getByTestId("ui-editor-mode-bar")).toBeVisible();
    await expect(page.getByTestId("ui-editor-mode-designer")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(page.getByTestId("ui-design-panel")).toBeVisible();
    await expect(page.getByTestId("ui-dock-surface-designer")).toHaveAttribute(
      "data-active",
      "true",
    );
    await expect(page.getByTestId("ui-dock-surface-logic")).toHaveAttribute(
      "data-active",
      "false",
    );

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
    await expect(page.getByTestId("ui-dock-surface-logic")).toHaveAttribute(
      "data-active",
      "true",
    );
    await expect(page.getByTestId("ui-dock-surface-designer")).toHaveAttribute(
      "data-active",
      "false",
    );
    await expect(page.getByTestId("graph-panel")).toBeVisible();
    await expect(page.getByTestId("my-class-panel")).toBeVisible();

    await openWindowsMenu(page);
    await expect(page.getByTestId("windows-menu-graph")).toBeVisible();
    await expect(page.getByTestId("windows-menu-my-class")).toBeVisible();
    await expect(page.getByTestId("windows-menu-ui-design")).toHaveCount(0);
    await closeWindowsMenu(page);
  });

  test("EditorUtilityInterface Settings stay on Designer", async ({ page }) => {
    test.setTimeout(E2E_TIMEOUT_MS);
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
    await expect(page.getByTestId("ui-dock-surface-designer")).toHaveAttribute(
      "data-active",
      "false",
    );
    await expect(page.getByTestId("ui-dock-surface-logic")).toHaveAttribute(
      "data-active",
      "true",
    );
    await openWindowsMenu(page);
    await expect(page.getByTestId("windows-menu-ui-settings")).toHaveCount(0);
    await expect(page.getByTestId("windows-menu-graph")).toBeVisible();
    await closeWindowsMenu(page);
  });

  test("two UserInterface and two EditorUtilityInterface documents switch Designer and Logic without page failures", async ({
    page,
  }) => {
    test.setTimeout(E2E_TIMEOUT_MS);
    const collector = attachPageFailureCollector(page);
    await openTestProject(page);
    await collector.listenForUnhandledRejections();

    await createAsset(page, "UserInterface", "HUD");
    await createAsset(page, "UserInterface", "HUD2");
    await createAsset(page, "EditorUtilityInterface", "SceneTools");
    await createAsset(page, "EditorUtilityInterface", "ClassTools");

    await openAssetFromBrowser(page, "assets/HUD.ui.babasset");
    await expectDesignerReady(page);
    await addWidget(page, "Button");
    await expectDesignerHostStats(page);

    await setUiEditorMode(page, "logic");
    await expect(visibleUiWorkspace(page).getByTestId("graph-panel")).toBeVisible();

    await switchToAsset(page, "assets/HUD2.ui.babasset", "HUD2");
    await expectDesignerReady(page);
    await addWidget(page, "Slider");
    await setUiEditorMode(page, "logic");
    await expect(visibleUiWorkspace(page).getByTestId("graph-panel")).toBeVisible();

    await switchToAsset(page, "assets/SceneTools.eui.babasset", "SceneTools");
    await expectDesignerReady(page);
    await expect(
      visibleUiWorkspace(page).getByTestId("ui-settings-panel"),
    ).toBeVisible();
    await addWidget(page, "CheckBox");
    await setUiEditorMode(page, "logic");
    await expect(visibleUiWorkspace(page).getByTestId("graph-panel")).toBeVisible();

    await switchToAsset(page, "assets/ClassTools.eui.babasset", "ClassTools");
    await expectDesignerReady(page);
    await addWidget(page, "TextInput");

    await switchToAsset(page, "assets/HUD.ui.babasset", "HUD");
    await expect(
      visibleUiWorkspace(page).getByTestId("ui-editor-mode-designer"),
    ).toHaveAttribute("aria-pressed", "true");
    await expectDesignerReady(page);
    await expect(
      visibleUiWorkspace(page).locator('[data-testid^="ui-widget-button-"]'),
    ).toBeVisible();

    await switchToAsset(page, "assets/HUD2.ui.babasset", "HUD2");
    await expect(
      visibleUiWorkspace(page).getByTestId("ui-editor-mode-logic"),
    ).toHaveAttribute("aria-pressed", "true");
    await setUiEditorMode(page, "designer");
    await expectDesignerReady(page);

    await assertNoPageFailures(collector);
  });

  test("UserInterface designer exposes Button CheckBox Slider ScrollBox TextInput hit targets", async ({
    page,
  }) => {
    test.setTimeout(E2E_TIMEOUT_MS);
    const collector = attachPageFailureCollector(page);
    await openTestProject(page);
    await collector.listenForUnhandledRejections();
    await createAsset(page, "UserInterface", "HUD");
    await openAssetFromBrowser(page, "assets/HUD.ui.babasset");
    await expectDesignerReady(page);

    const kinds: AddableWidgetKind[] = [
      "Button",
      "CheckBox",
      "Slider",
      "ScrollBox",
      "TextInput",
    ];
    for (const kind of kinds) {
      await selectCanvasRoot(page);
      await addWidget(page, kind);
    }

    await expect(page.locator('[data-testid^="ui-widget-button-"]')).toBeVisible();
    await expect(page.locator('[data-testid^="ui-widget-checkbox-"]')).toBeVisible();
    await expect(page.locator('[data-testid^="ui-widget-slider-"]')).toBeVisible();
    await expect(page.locator('[data-testid^="ui-widget-scrollbox-"]')).toBeVisible();
    await expect(page.locator('[data-testid^="ui-widget-textinput-"]')).toBeVisible();
    await expectDesignerHostStats(page);
    await assertNoPageFailures(collector);
  });

  test("switch projects with identical asset paths", async ({ page }) => {
    test.setTimeout(E2E_TIMEOUT_MS);
    const collector = attachPageFailureCollector(page);
    await openTestProject(page);
    await collector.listenForUnhandledRejections();

    await createAsset(page, "UserInterface", "HUD");
    await openAssetFromBrowser(page, "assets/HUD.ui.babasset");
    await expectDesignerReady(page);
    await addWidget(page, "Button");

    await closeProjectViaSettings(page);
    await discardCloseIfNeeded(page);

    await page.getByTestId("create-project").click();
    await expect(page.getByTestId("create-project-dialog")).toBeVisible();
    await page.getByTestId("create-project-name").fill("TestProject2");
    await page.getByTestId("create-project-submit").click();
    await expect(page.getByTestId("editor-chrome-bar")).toBeVisible();
    await expect(page.getByTestId("project-name")).toContainText("TestProject2");
    await collector.listenForUnhandledRejections();

    await createAsset(page, "UserInterface", "HUD");
    await openAssetFromBrowser(page, "assets/HUD.ui.babasset");
    await expectDesignerReady(page);
    await expectDesignerHostStats(page);
    await assertNoPageFailures(collector);
  });
});
