import { expect, test, type Page } from "@playwright/test";
import { closeProjectViaSettings } from "./close-project";
import { IPAD_TEST_TAG } from "./ipad-tag";
import { openTestProject } from "./open-test-project";
import { saveAllIfEnabled } from "./save-all";

async function showContentBrowser(page: Page): Promise<void> {
  await page
    .locator('[data-testid="document-tab"][data-document-kind="content-browser"]')
    .click();
  await expect(page.getByTestId("document-workspace-content-browser")).toBeVisible();
}

async function createContentBrowserAsset(
  page: Page,
  type: "Enum" | "Scene",
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
  await showContentBrowser(page);
}

test.describe("Editor density and IA", () => {
  test("chrome is compact, has no Add tab, and Focus is disabled on Content Browser", {
    tag: IPAD_TEST_TAG,
  }, async ({
    page,
  }) => {
    await openTestProject(page);

    await expect(page.getByTestId("document-tab-add")).toHaveCount(0);
    await expect(page.getByTestId("project-name")).toContainText("TestProject");
    await expect(page.getByTestId("project-name")).not.toContainText(".babproject");
    await expect(page.getByTestId("focus-layout")).toBeDisabled();

    const undo = page.getByTestId("undo-document");
    await expect(undo).toBeVisible();
    const undoBox = await undo.boundingBox();
    expect(undoBox).not.toBeNull();
    expect(undoBox!.height).toBeGreaterThanOrEqual(28);
  });

  test("Content Browser click selects and double-click opens a scene", async ({
    page,
  }) => {
    await openTestProject(page);

    const sceneTile = page.locator(
      '[data-asset-path="assets/main.scene.babasset"]',
    );
    await expect(sceneTile).toBeVisible();
    await sceneTile.click();
    await expect(sceneTile).toHaveAttribute("data-selected", "true");
    await expect(page.getByTestId("document-workspace-scene")).toHaveCount(0);

    await sceneTile.dblclick();
    await expect(page.getByTestId("document-workspace-scene")).toBeVisible();
    await expect(page.getByTestId("viewport-panel")).toBeVisible();
  });

  test("Content Browser Filter menu toggles asset types", async ({ page }) => {
    await openTestProject(page);
    await page.getByTestId("content-browser-filter").click();
    await expect(page.getByTestId("content-browser-filter-menu")).toBeVisible();
    await page.getByTestId("content-browser-filter-Scene").click();
    await expect(
      page.locator('[data-asset-path="assets/main.class.babasset"]'),
    ).toHaveCount(0);
    await expect(
      page.locator('[data-asset-path="assets/main.scene.babasset"]'),
    ).toBeVisible();
  });

  test("Focus hides the Outliner; Place Actors catalog does not focus search", {
    tag: IPAD_TEST_TAG,
  }, async ({
    page,
  }) => {
    await openTestProject(page);
    await page
      .locator('[data-asset-path="assets/main.scene.babasset"]')
      .dblclick();
    await expect(page.getByTestId("scene-outliner-panel")).toBeVisible({
      timeout: 15_000,
    });

    const dockTab = page.locator(".dockview-theme-babylonslate .dv-tab").first();
    await expect(dockTab).toBeVisible();
    const dockBox = await dockTab.boundingBox();
    expect(dockBox).not.toBeNull();
    const coarse = await page.evaluate(() =>
      window.matchMedia("(pointer: coarse)").matches,
    );
    expect(dockBox!.height).toBeGreaterThanOrEqual(coarse ? 26 : 18);

    const focus = page.getByTestId("focus-layout");
    await expect(focus).toBeEnabled();
    await focus.click();
    await expect(focus).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("scene-outliner-panel")).not.toBeVisible();

    await focus.click();
    await expect(focus).toHaveAttribute("aria-pressed", "false");
    await expect(page.getByTestId("scene-outliner-panel")).toBeVisible();

    await page.getByTestId("outliner-add-actor").click();
    await expect(page.getByTestId("place-actors-catalog")).toBeVisible();
    await expect(page.getByTestId("place-actors-catalog-search")).not.toBeFocused();
    await expect(page.getByTestId("place-actors-catalog-body")).toBeVisible();
  });

  test("Class Focus hides Inspector and Class, keeping Graph", async ({
    page,
  }) => {
    await openTestProject(page);
    await page
      .locator('[data-asset-path="assets/main.class.babasset"]')
      .dblclick();
    await expect(page.getByTestId("graph-panel")).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByTestId("inspector-panel")).toBeVisible();
    await expect(page.getByTestId("my-class-panel")).toBeVisible();

    const focus = page.getByTestId("focus-layout");
    await expect(focus).toBeEnabled();
    await focus.click();
    await expect(focus).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("graph-panel")).toBeVisible();
    await expect(page.getByTestId("inspector-panel")).not.toBeVisible();
    await expect(page.getByTestId("my-class-panel")).not.toBeVisible();

    await focus.click();
    await expect(focus).toHaveAttribute("aria-pressed", "false");
    await expect(page.getByTestId("inspector-panel")).toBeVisible();
    await expect(page.getByTestId("my-class-panel")).toBeVisible();
  });

  test("Add Node catalog does not focus search", async ({ page }) => {
    await openTestProject(page);
    await page
      .locator('[data-asset-path="assets/main.class.babasset"]')
      .dblclick();
    await expect(page.getByTestId("graph-panel")).toBeVisible({
      timeout: 15_000,
    });

    const pane = page.locator(".react-flow__pane");
    await pane.click();
    await pane.click();
    await expect(page.getByTestId("node-palette")).toBeVisible();
    await expect(page.getByTestId("node-palette-search")).not.toBeFocused();
    await expect(page.getByTestId("node-palette-body")).toBeVisible();
  });

  test("homepage project rows expose Open, Rename, and Remove from list", async ({
    page,
  }) => {
    await openTestProject(page);
    await saveAllIfEnabled(page);
    await closeProjectViaSettings(page);
    await expect(page.getByTestId("homepage")).toBeVisible();

    const listed = page.getByTestId("open-listed-project-TestProject.babproject");
    await expect(listed).toContainText("TestProject");
    await listed.click({ button: "right" });
    await expect(page.getByTestId("homepage-project-menu")).toBeVisible();
    await expect(page.getByTestId("homepage-project-open")).toBeVisible();
    await expect(page.getByTestId("homepage-project-rename")).toBeVisible();
    await expect(page.getByTestId("homepage-project-remove")).toBeVisible();

    await page.getByTestId("homepage-project-rename").click();
    await expect(page.getByTestId("homepage-rename-dialog")).toBeVisible();
    await page.getByTestId("homepage-rename-input").fill("Renamed Game");
    await page.getByTestId("homepage-rename-confirm").click();
    await expect(listed).toContainText("Renamed Game");
  });

  test("Save All is disabled when clean and shows a dirty dot after an edit", async ({
    page,
  }) => {
    await openTestProject(page);

    const saveAll = page.getByTestId("save-all-project");
    await expect(saveAll).toBeDisabled();
    await expect(page.getByTestId("save-all-dirty")).toHaveCount(0);

    await page
      .locator('[data-asset-path="assets/main.scene.babasset"]')
      .dblclick();
    await expect(page.getByTestId("scene-outliner-panel")).toBeVisible({
      timeout: 15_000,
    });
    await page.getByTestId("outliner-add-actor").click();
    await expect(page.getByTestId("place-actors-catalog")).toBeVisible();
    await page.getByTestId("place-actors-item-shape-box").click();

    await expect(page.getByTestId("undo-document")).toBeEnabled();
    await expect(saveAll).toBeEnabled();
    await expect(page.getByTestId("save-all-dirty")).toBeVisible();
    await expect(saveAll).toHaveAttribute(
      "aria-label",
      "Save All (unsaved changes)",
    );
  });

  test("gizmo tools look pressed and the joystick toggle is in viewport settings", {
    tag: IPAD_TEST_TAG,
  }, async ({
    page,
  }) => {
    await openTestProject(page);
    await page
      .locator('[data-asset-path="assets/main.scene.babasset"]')
      .dblclick();
    await expect(page.getByTestId("viewport-panel")).toBeVisible({
      timeout: 15_000,
    });

    const translate = page.getByTestId("gizmo-tool-translate");
    await expect(translate).toHaveAttribute("aria-pressed", "true");
    await expect(translate).toHaveClass(/aria-pressed:bg-accent/);

    const focus = page.getByTestId("focus-layout");
    await expect(focus).toBeEnabled();
    await expect(focus).toHaveAttribute("aria-pressed", "false");
    await expect(focus).toHaveClass(/aria-pressed:bg-accent/);

    await page.getByTestId("viewport-settings").click();
    const joystick = page.getByTestId("gizmo-joystick-toggle");
    await expect(joystick).toBeVisible();
    await expect(joystick).toHaveAttribute("aria-checked", "false");
    await joystick.click();
    await expect(joystick).toHaveAttribute("aria-checked", "true");
  });

  test("tapping empty Content Browser grid clears the tile selection", async ({
    page,
  }) => {
    await openTestProject(page);
    const sceneTile = page.locator(
      '[data-asset-path="assets/main.scene.babasset"]',
    );
    await sceneTile.click();
    await expect(sceneTile).toHaveAttribute("data-selected", "true");
    await expect(page.getByTestId("content-browser-delete-selected")).toBeVisible();

    const grid = page.getByTestId("content-browser-asset-grid");
    const box = await grid.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.click(box!.x + 4, box!.y + 4);

    await expect(sceneTile).toHaveAttribute("data-selected", "false");
    await expect(page.getByTestId("content-browser-delete-selected")).toHaveCount(
      0,
    );
  });

  test("Content Browser click adds to the selection and Deselect All clears it", async ({
    page,
  }) => {
    await openTestProject(page);
    const sceneTile = page.locator(
      '[data-asset-path="assets/main.scene.babasset"]',
    );
    const classTile = page.locator(
      '[data-asset-path="assets/main.class.babasset"]',
    );
    await sceneTile.click();
    await classTile.click();
    await expect(sceneTile).toHaveAttribute("data-selected", "true");
    await expect(classTile).toHaveAttribute("data-selected", "true");
    await expect(page.getByTestId("content-browser-delete-selected")).toHaveText(
      /Delete \(2\)/,
    );
    await expect(page.getByTestId("content-browser-deselect-all")).toBeVisible();
    await expect(page.getByTestId("content-browser-delete-selected")).not.toHaveClass(
      /bg-destructive/,
    );

    await page.getByTestId("content-browser-deselect-all").click();
    await expect(sceneTile).toHaveAttribute("data-selected", "false");
    await expect(classTile).toHaveAttribute("data-selected", "false");
    await expect(page.getByTestId("content-browser-delete-selected")).toHaveCount(
      0,
    );
    await expect(page.getByTestId("content-browser-deselect-all")).toHaveCount(0);
  });

  test("Content Browser toolbar Delete stays outline until the confirm dialog", {
    tag: IPAD_TEST_TAG,
  }, async ({ page }) => {
    await openTestProject(page);
    const sceneTile = page.locator(
      '[data-asset-path="assets/main.scene.babasset"]',
    );
    const classTile = page.locator(
      '[data-asset-path="assets/main.class.babasset"]',
    );
    await sceneTile.click();
    await classTile.click();

    const deleteSelected = page.getByTestId("content-browser-delete-selected");
    await expect(deleteSelected).toHaveText(/Delete \(2\)/);
    await expect(page.getByTestId("content-browser-deselect-all")).toBeVisible();
    await expect(deleteSelected).not.toHaveClass(/bg-destructive/);

    await deleteSelected.click();
    await expect(page.getByTestId("content-browser-delete-dialog")).toBeVisible();
    await expect(sceneTile).toBeVisible();
    await expect(classTile).toBeVisible();

    const confirm = page.getByTestId("content-browser-delete-confirm");
    const cancel = page.getByTestId("content-browser-delete-cancel");
    await expect(confirm).toHaveClass(/bg-destructive/);
    await expect(confirm).toHaveCSS("min-height", "44px");
    await expect(cancel).toHaveCSS("min-height", "44px");
    await expect(confirm).toHaveCSS("height", "44px");
    await expect(cancel).toHaveCSS("height", "44px");

    await cancel.click();
    await expect(page.getByTestId("content-browser-delete-dialog")).toHaveCount(0);
    await expect(sceneTile).toHaveAttribute("data-selected", "true");
    await expect(classTile).toHaveAttribute("data-selected", "true");
  });

  test("Content Browser folder tree and asset grid scroll vertically", async ({
    page,
  }) => {
    await openTestProject(page);
    await expect(page.getByTestId("content-browser-asset-grid")).toHaveCSS(
      "overflow-y",
      "auto",
    );
    const tree = page.getByTestId("content-browser-folder-tree");
    await expect(tree).toHaveCSS("overflow-y", "auto");

    await page.setViewportSize({ width: 1280, height: 400 });
    for (let index = 0; index < 8; index += 1) {
      await page.getByTestId("tree-row-assets").click();
      await page.getByTestId("content-browser-new-folder").click();
      await expect(page.getByTestId("content-browser-name-dialog")).toBeVisible();
      await page
        .getByTestId("content-browser-name-input")
        .fill(`ScrollFolder${index}`);
      await page.getByTestId("content-browser-name-confirm").click();
      await expect(page.getByTestId("content-browser-name-dialog")).toHaveCount(0);
    }

    const before = await tree.evaluate((el) => ({
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      overflowY: getComputedStyle(el).overflowY,
    }));
    expect(before.overflowY).toBe("auto");
    expect(before.clientHeight).toBeGreaterThan(40);
    expect(before.scrollHeight).toBeGreaterThan(before.clientHeight);

    const box = await tree.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + Math.min(40, box!.height / 2));
    await page.mouse.wheel(0, 120);
    await expect
      .poll(async () => tree.evaluate((el) => el.scrollTop))
      .toBeGreaterThan(0);
  });

  test("Content Browser folder tree pans vertically on touch before reparent hold", {
    tag: IPAD_TEST_TAG,
  }, async ({ page }) => {
    await openTestProject(page);
    await page.setViewportSize({ width: 1194, height: 400 });
    for (let index = 0; index < 8; index += 1) {
      await page.getByTestId("tree-row-assets").click();
      await page.getByTestId("content-browser-new-folder").click();
      await expect(page.getByTestId("content-browser-name-dialog")).toBeVisible();
      await page
        .getByTestId("content-browser-name-input")
        .fill(`TouchFolder${index}`);
      await page.getByTestId("content-browser-name-confirm").click();
      await expect(page.getByTestId("content-browser-name-dialog")).toHaveCount(0);
    }

    const tree = page.getByTestId("content-browser-folder-tree");
    await expect(tree).toBeVisible();
    const box = await tree.boundingBox();
    expect(box).not.toBeNull();
    expect(
      await tree.evaluate((el) => el.scrollHeight > el.clientHeight),
    ).toBe(true);

    const session = await page.context().newCDPSession(page);
    const startX = box!.x + box!.width / 2;
    const startY = box!.y + Math.min(80, box!.height - 8);
    const endY = box!.y + 16;
    await session.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: startX, y: startY }],
    });
    await session.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: startX, y: endY }],
    });
    await session.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    expect(await tree.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  });

  test("New Asset refuses a name that already exists; Duplicate uses stem_N", async ({
    page,
  }) => {
    await openTestProject(page);
    await page.getByTestId("content-browser-new-asset").click();
    await expect(page.getByTestId("content-browser-new-asset-dialog")).toBeVisible();
    await expect(page.getByTestId("new-asset-name")).toHaveValue("");
    await expect(page.getByTestId("content-browser-new-asset-create")).toBeDisabled();
    await page.getByTestId("new-asset-type").click();
    await page.getByTestId("new-asset-type-Scene").click();
    await page.getByTestId("new-asset-name").fill("main");
    await expect(page.getByTestId("new-asset-name-taken")).toBeVisible();
    await expect(page.getByTestId("content-browser-new-asset-create")).toBeDisabled();
    await page.getByRole("button", { name: "Cancel" }).click();

    const sceneTile = page.locator(
      '[data-asset-path="assets/main.scene.babasset"]',
    );
    await sceneTile.click({ button: "right" });
    await page.getByTestId("context-menu-item-duplicate").click();
    await expect(
      page.locator('[data-asset-path="assets/main_1.scene.babasset"]'),
    ).toBeVisible();
  });

  test("Content Browser tree lists assets and folder tiles precede assets", async ({
    page,
  }) => {
    await openTestProject(page);
    await expect(
      page.getByTestId("tree-row-assets/main.scene.babasset"),
    ).toBeVisible();

    await page.getByTestId("content-browser-new-folder").click();
    await expect(page.getByTestId("content-browser-name-dialog")).toBeVisible();
    await page.getByTestId("content-browser-name-input").fill("fx");
    await page.getByTestId("content-browser-name-confirm").click();
    await page.getByTestId("tree-row-assets").click();

    const folderTile = page.getByTestId("content-folder-assets/fx");
    await expect(folderTile).toBeVisible();
    const sceneTile = page.locator(
      '[data-asset-path="assets/main.scene.babasset"]',
    );
    await expect(sceneTile).toBeVisible();
    const folderFollowedByScene = await folderTile.evaluate((folder, sceneSelector) => {
      const scene = document.querySelector(sceneSelector);
      if (!scene) return false;
      return (folder.compareDocumentPosition(scene) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    }, '[data-asset-path="assets/main.scene.babasset"]');
    expect(folderFollowedByScene).toBe(true);
  });

  test("Content Browser empty-grid menu items; asset menu has no Retry Encoding", async ({
    page,
  }) => {
    await openTestProject(page);
    const grid = page.getByTestId("content-browser-asset-grid");
    await grid.click({ button: "right", position: { x: 4, y: 4 } });
    await expect(page.getByTestId("context-menu-item-new-folder")).toBeVisible();
    await expect(page.getByTestId("context-menu-item-new-asset")).toBeVisible();
    await expect(page.getByTestId("context-menu-item-import")).toBeVisible();
    await page.getByTestId("context-menu-backdrop").click();
    await expect(page.getByTestId("context-menu-panel")).toHaveCount(0);

    const sceneTile = page.locator(
      '[data-asset-path="assets/main.scene.babasset"]',
    );
    await sceneTile.click({ button: "right" });
    await expect(page.getByTestId("context-menu-item-duplicate")).toBeVisible();
    await expect(page.getByTestId("context-menu-item-retry-encoding")).toHaveCount(
      0,
    );
  });

  test("multi-select Duplicate copies every asset; mixed menu hides Show References", async ({
    page,
  }) => {
    await openTestProject(page);

    await createContentBrowserAsset(page, "Enum", "Alpha");
    await expect(
      page.locator('[data-asset-path="assets/Alpha.babasset"]'),
    ).toBeVisible();

    await createContentBrowserAsset(page, "Enum", "Beta");
    await expect(
      page.locator('[data-asset-path="assets/Beta.babasset"]'),
    ).toBeVisible();

    await page.locator('[data-asset-path="assets/Alpha.babasset"]').click();
    await page.locator('[data-asset-path="assets/Beta.babasset"]').click();
    await page
      .locator('[data-asset-path="assets/Beta.babasset"]')
      .click({ button: "right" });
    await expect(page.getByTestId("context-menu-item-show-references")).toHaveCount(
      0,
    );
    await page.getByTestId("context-menu-item-duplicate").click();
    await expect(
      page.locator('[data-asset-path="assets/Alpha_1.babasset"]'),
    ).toBeVisible();
    await expect(
      page.locator('[data-asset-path="assets/Beta_1.babasset"]'),
    ).toBeVisible();

    await page.getByTestId("content-browser-new-folder").click();
    await expect(page.getByTestId("content-browser-name-dialog")).toBeVisible();
    await page.getByTestId("content-browser-name-input").fill("fx");
    await page.getByTestId("content-browser-name-confirm").click();
    await page.getByTestId("tree-row-assets").click();
    await expect(page.getByTestId("content-folder-assets/fx")).toBeVisible({
      timeout: 15_000,
    });
    await page.getByTestId("content-folder-assets/fx").click();
    await page.locator('[data-asset-path="assets/Alpha.babasset"]').click();
    await page.getByTestId("content-folder-assets/fx").click({ button: "right" });
    await expect(page.getByTestId("context-menu-item-duplicate")).toBeVisible();
    await expect(page.getByTestId("context-menu-item-show-references")).toHaveCount(
      0,
    );
  });
});
