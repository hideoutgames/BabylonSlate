import { expect, test, type Page } from "@playwright/test";
import { IPAD_TEST_TAG } from "./ipad-tag";
import {
  openAssetFromBrowser,
  openContentBrowser,
  openMainScene,
  openTestProject,
} from "./open-test-project";
import {
  assertNoPageFailures,
  attachPageFailureCollector,
} from "./page-failures";

const E2E_TIMEOUT_MS = 90_000;

type AddableWidgetKind =
  | "Button"
  | "CheckBox"
  | "Slider"
  | "ScrollBox"
  | "TextInput";

async function openWindowsMenu(page: Page) {
  const content = page.getByTestId("windows-menu-content");
  if (await content.isVisible()) return;
  await page.getByTestId("windows-menu").click();
  await expect(content).toBeVisible();
}

async function closeWindowsMenu(page: Page) {
  const content = page.getByTestId("windows-menu-content");
  if (!(await content.isVisible())) return;
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  if (await content.isVisible()) {
    await page.mouse.click(12, 12);
  }
  await expect(content).toHaveCount(0);
}

async function createEditorUtility(page: Page, name: string): Promise<void> {
  await openContentBrowser(page);
  await expect(page.getByTestId("document-workspace-content-browser")).toBeVisible();
  await page.getByTestId("content-browser-new-asset").click();
  await expect(page.getByTestId("content-browser-new-asset-dialog")).toBeVisible();
  await page.getByTestId("new-asset-type").click();
  await page.getByTestId("new-asset-type-EditorUtilityInterface").click();
  await page.getByTestId("new-asset-name").fill(name);
  await page.getByTestId("content-browser-new-asset-create").click();
  await expect(page.getByTestId("content-browser-new-asset-dialog")).toHaveCount(0);
}

async function selectCanvasRoot(page: Page): Promise<void> {
  await page.getByTestId("ui-widget-canvas").click({ position: { x: 8, y: 8 } });
}

async function addWidget(page: Page, kind: AddableWidgetKind): Promise<void> {
  await page.getByTestId("ui-add-widget").click();
  await expect(page.getByTestId("ui-widget-catalog")).toBeVisible();
  const search = page.getByTestId("ui-widget-catalog-search");
  if ((await search.count()) > 0) {
    await search.fill(kind);
  }
  await page.getByTestId(`ui-add-widget-${kind}`).click();
  await expect(page.getByTestId("ui-widget-catalog")).toHaveCount(0);
  await expect(
    page.locator(`[data-testid^="ui-widget-${kind.toLowerCase()}-"]`),
  ).toBeVisible();
}

async function openLiveUtility(page: Page): Promise<void> {
  await expect(page.getByTestId("windows-menu")).toBeEnabled({ timeout: 15_000 });
  await openWindowsMenu(page);
  await page.getByTestId("windows-editor-utilities").click({ force: true });
  await expect(page.getByTestId("windows-editor-utilities-empty")).toHaveCount(0);
  const utilityItem = page.locator('[data-testid^="windows-menu-eui-"]');
  await utilityItem.click({ force: true });
  await expect(page.getByTestId("editor-utility-panel")).toBeVisible({
    timeout: 15_000,
  });
  await closeWindowsMenu(page);
}

async function interactWithUtilityCanvas(page: Page): Promise<void> {
  const canvas = page.getByTestId("editor-utility-canvas");
  await expect(canvas).toBeVisible();
  await canvas.click({ position: { x: 24, y: 24 } });
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  const startX = box!.x + box!.width / 2;
  const startY = box!.y + box!.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 40, startY, { steps: 6 });
  await page.mouse.up();
  await expect(page.getByTestId("editor-utility-panel")).toBeVisible();
  await expect(page.getByTestId("ui-gui-preview-error")).toHaveCount(0);
}

test.describe("Windows menu", { tag: IPAD_TEST_TAG }, () => {
  test("sits left of Focus and is disabled on Content Browser", async ({
    page,
  }) => {
    await openTestProject(page);

    const windows = page.getByTestId("windows-menu");
    const focus = page.getByTestId("focus-layout");
    await expect(windows).toBeVisible();
    await expect(windows).toBeDisabled();
    await expect(focus).toBeDisabled();

    const windowsBox = await windows.boundingBox();
    const focusBox = await focus.boundingBox();
    expect(windowsBox).not.toBeNull();
    expect(focusBox).not.toBeNull();
    expect(windowsBox!.x + windowsBox!.width).toBeLessThanOrEqual(
      focusBox!.x + 1,
    );
  });

  test("restores Outliner and Output Log to their default dock positions", async ({
    page,
  }) => {
    test.setTimeout(E2E_TIMEOUT_MS);
    await openTestProject(page);
    await page
      .locator('[data-asset-path="assets/main.scene.babasset"]')
      .dblclick();
    await expect(page.getByTestId("scene-outliner-panel")).toBeVisible({
      timeout: 15_000,
    });

    await expect(page.getByTestId("windows-menu")).toBeEnabled();
    await openWindowsMenu(page);
    const outlinerItem = page.getByTestId("windows-menu-scene-outliner");
    await expect(outlinerItem).toHaveAttribute("aria-checked", "true");
    await outlinerItem.click({ force: true });
    await expect(page.getByTestId("scene-outliner-panel")).toHaveCount(0);
    await expect(page.getByTestId("windows-menu-content")).toBeVisible();
    await expect(outlinerItem).toHaveAttribute("aria-checked", "false");
    await outlinerItem.click({ force: true });
    await expect(page.getByTestId("scene-outliner-panel")).toBeVisible({
      timeout: 10_000,
    });
    const outlinerBox = await page.getByTestId("scene-outliner-panel").boundingBox();
    const viewportBox = await page.getByTestId("viewport-panel").boundingBox();
    expect(outlinerBox).not.toBeNull();
    expect(viewportBox).not.toBeNull();
    expect(outlinerBox!.x + outlinerBox!.width).toBeLessThanOrEqual(
      viewportBox!.x + 8,
    );
    await expect(page.getByTestId("windows-menu-content")).toBeVisible();

    const outputItem = page.getByTestId("windows-menu-output-log");
    await expect(outputItem).toHaveAttribute("aria-checked", "true");
    await outputItem.click({ force: true });
    await expect(page.getByTestId("output-log-panel")).toHaveCount(0);
    await outputItem.click({ force: true });
    await expect(page.getByTestId("output-log-panel")).toBeVisible({
      timeout: 10_000,
    });
    const outputBox = await page.getByTestId("output-log-panel").boundingBox();
    const viewportAfter = await page.getByTestId("viewport-panel").boundingBox();
    expect(outputBox).not.toBeNull();
    expect(viewportAfter).not.toBeNull();
    expect(outputBox!.y).toBeGreaterThanOrEqual(
      viewportAfter!.y + viewportAfter!.height - 8,
    );

    await page.getByTestId("windows-editor-utilities").click({ force: true });
    await expect(page.getByTestId("windows-editor-utilities-empty")).toBeVisible();
  });

  test("opens the Editor Utilities submenu on tap", async ({ page }) => {
    await openTestProject(page);
    await page
      .locator('[data-asset-path="assets/main.scene.babasset"]')
      .dblclick();
    await expect(page.getByTestId("windows-menu")).toBeEnabled({
      timeout: 15_000,
    });
    await openWindowsMenu(page);
    await page.getByTestId("windows-editor-utilities").click({ force: true });
    await expect(page.getByTestId("windows-editor-utilities-menu")).toBeVisible();
    await expect(page.getByTestId("windows-editor-utilities-empty")).toBeVisible();
  });

  test("opens an EditorUtilityInterface from Windows and restores its dock tab", async ({
    page,
  }) => {
    test.setTimeout(E2E_TIMEOUT_MS);
    await openTestProject(page);
    await createEditorUtility(page, "SceneTools");

    await page
      .locator('[data-asset-path="assets/main.scene.babasset"]')
      .dblclick();
    await expect(page.getByTestId("viewport-panel")).toBeVisible({
      timeout: 15_000,
    });
    await openWindowsMenu(page);
    await page.getByTestId("windows-editor-utilities").click({ force: true });
    await expect(page.getByTestId("windows-editor-utilities-empty")).toHaveCount(0);
    const utilityItem = page.locator(
      '[data-testid^="windows-menu-eui-"]',
    );
    await expect(utilityItem).toHaveAttribute("aria-checked", "false");
    await utilityItem.click({ force: true });
    await expect(page.getByTestId("editor-utility-panel")).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByTestId("editor-utility-canvas")).toBeVisible();
    await expect(page.getByTestId("ui-gui-preview-error")).toHaveCount(0);

    await expect(utilityItem).toHaveAttribute("aria-checked", "true");
    await utilityItem.click({ force: true });
    await expect(page.getByTestId("editor-utility-panel")).toHaveCount(0);
    await utilityItem.click({ force: true });
    await expect(page.getByTestId("editor-utility-panel")).toBeVisible({
      timeout: 10_000,
    });
  });

  test("live Editor Utility stays open through pointer interaction and Focus", async ({
    page,
  }) => {
    test.setTimeout(E2E_TIMEOUT_MS);
    const collector = attachPageFailureCollector(page);
    await openTestProject(page);
    await collector.listenForUnhandledRejections();
    await createEditorUtility(page, "SceneTools");
    await openAssetFromBrowser(page, "assets/SceneTools.eui.babasset");
    await expect(page.getByTestId("ui-design-canvas")).toBeVisible();
    await expect(page.getByTestId("ui-gui-preview-error")).toHaveCount(0);

    for (const kind of [
      "Button",
      "CheckBox",
      "Slider",
      "TextInput",
      "ScrollBox",
    ] as const) {
      await selectCanvasRoot(page);
      await addWidget(page, kind);
    }

    await openMainScene(page);
    await expect(page.getByTestId("viewport-panel")).toBeVisible({
      timeout: 15_000,
    });
    await openLiveUtility(page);
    await interactWithUtilityCanvas(page);

    await page.getByTestId("focus-layout").click();
    await expect(page.getByTestId("editor-utility-panel")).toBeVisible();
    await assertNoPageFailures(collector);
  });

  test("opens an EditorUtilityInterface from a UI authoring tab onto the Scene dock", async ({
    page,
  }) => {
    test.setTimeout(E2E_TIMEOUT_MS);
    await openTestProject(page);
    await createEditorUtility(page, "SceneTools");
    await openAssetFromBrowser(page, "assets/SceneTools.eui.babasset");
    await expect(page.getByTestId("ui-design-canvas")).toBeVisible();
    await expect(page.getByTestId("windows-menu")).toBeEnabled({
      timeout: 15_000,
    });
    await openWindowsMenu(page);
    await page.getByTestId("windows-editor-utilities").click({ force: true });
    await expect(page.getByTestId("windows-editor-utilities-empty")).toHaveCount(0);
    const utilityItem = page.locator('[data-testid^="windows-menu-eui-"]');
    await utilityItem.click({ force: true });
    await expect(page.getByTestId("editor-utility-panel")).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByTestId("viewport-panel")).toBeVisible();
    await expect(page.getByTestId("ui-gui-preview-error")).toHaveCount(0);
    await closeWindowsMenu(page);
  });

  test("opens a live Editor Utility from Designer Open Live", async ({
    page,
  }) => {
    test.setTimeout(E2E_TIMEOUT_MS);
    await openTestProject(page);
    await createEditorUtility(page, "SceneTools");
    await openAssetFromBrowser(page, "assets/SceneTools.eui.babasset");
    await expect(page.getByTestId("ui-design-canvas")).toBeVisible();
    await page.getByTestId("ui-open-live").click();
    await expect(page.getByTestId("editor-utility-panel")).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByTestId("viewport-panel")).toBeVisible();
    await expect(page.getByTestId("ui-gui-preview-error")).toHaveCount(0);
  });

  test("Class-dock Editor Utility stays open on the Class document", async ({
    page,
  }) => {
    test.setTimeout(E2E_TIMEOUT_MS);
    const collector = attachPageFailureCollector(page);
    await openTestProject(page);
    await collector.listenForUnhandledRejections();
    await createEditorUtility(page, "ClassTools");
    await openAssetFromBrowser(page, "assets/ClassTools.eui.babasset");
    await expect(page.getByTestId("document-workspace-ui")).toBeVisible();
    await expect(page.getByTestId("ui-design-canvas")).toBeVisible();
    await page.getByTestId("ui-dock-kind-class").click();
    await expect(page.getByTestId("ui-dock-kind-class")).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await openAssetFromBrowser(page, "assets/main.class.babasset");
    await expect(page.getByTestId("document-workspace-graph")).toBeVisible();
    await openLiveUtility(page);
    await expect(page.getByTestId("editor-utility-canvas")).toBeVisible();
    await page.getByTestId("editor-utility-canvas").click({
      position: { x: 24, y: 24 },
    });
    await expect(page.getByTestId("editor-utility-panel")).toBeVisible();
    await expect(page.getByTestId("ui-gui-preview-error")).toHaveCount(0);
    await assertNoPageFailures(collector);
  });
});
