import { expect, test, type Page } from "@playwright/test";
import { closeProjectViaSettings } from "./close-project";
import { IPAD_TEST_TAG } from "./ipad-tag";
import {
  createContentBrowserAsset,
  openContentBrowser,
  openTestProject,
} from "./open-test-project";
import { saveAllIfEnabled } from "./save-all";

async function paintSelectContentTiles(
  page: Page,
  first: ReturnType<Page["locator"]>,
  second: ReturnType<Page["locator"]>,
): Promise<void> {
  await expect(first).toBeVisible();
  await expect(second).toBeVisible();
  const fromBox = await first.boundingBox();
  const toBox = await second.boundingBox();
  expect(fromBox).not.toBeNull();
  expect(toBox).not.toBeNull();
  await page.mouse.move(
    fromBox!.x + fromBox!.width / 2,
    fromBox!.y + fromBox!.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    toBox!.x + toBox!.width / 2,
    toBox!.y + toBox!.height / 2,
    { steps: 16 },
  );
  await page.mouse.up();
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
      page.locator('[data-asset-path="assets/Mannequin.class.babasset"]'),
    ).toHaveCount(0);
    await expect(
      page.locator('[data-asset-path="assets/main.scene.babasset"]'),
    ).toBeVisible();
  });

  test("Content Browser Sort menu orders asset tiles", async ({ page }) => {
    await openTestProject(page);
    const grid = page.getByTestId("content-browser-asset-grid");
    const classPath = "assets/Mannequin.class.babasset";
    const scenePath = "assets/main.scene.babasset";
    await expect(grid.locator(`[data-asset-path="${classPath}"]`)).toBeVisible();
    await expect(grid.locator(`[data-asset-path="${scenePath}"]`)).toBeVisible();

    async function assetPaths(): Promise<string[]> {
      return grid.locator("[data-asset-path]").evaluateAll((tiles) =>
        tiles.map((tile) => tile.getAttribute("data-asset-path") ?? ""),
      );
    }

    async function folderTilesStayFirst(): Promise<void> {
      const kinds = await grid
        .locator("[data-asset-path], [data-folder-path]")
        .evaluateAll((tiles) =>
          tiles.map((tile) =>
            tile.hasAttribute("data-folder-path") ? "folder" : "asset",
          ),
        );
      const firstAsset = kinds.indexOf("asset");
      const lastFolder = kinds.lastIndexOf("folder");
      if (firstAsset >= 0 && lastFolder >= 0) {
        expect(lastFolder).toBeLessThan(firstAsset);
      }
    }

    async function chooseSort(mode: string): Promise<void> {
      const menu = page.getByTestId("content-browser-sort-menu");
      if (!(await menu.isVisible())) {
        await page.getByTestId("content-browser-sort").click();
        await expect(menu).toBeVisible();
      }
      await page.getByTestId(`content-browser-sort-${mode}`).click();
    }

    await chooseSort("type-asc");
    await expect
      .poll(async () => {
        const order = await assetPaths();
        return order.indexOf(scenePath) - order.indexOf(classPath);
      })
      .toBeGreaterThan(0);
    await folderTilesStayFirst();

    await chooseSort("type-desc");
    await expect
      .poll(async () => {
        const order = await assetPaths();
        return order.indexOf(classPath) - order.indexOf(scenePath);
      })
      .toBeGreaterThan(0);
    await folderTilesStayFirst();
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
      .locator('[data-asset-path="assets/Mannequin.class.babasset"]')
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
      .locator('[data-asset-path="assets/Mannequin.class.babasset"]')
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

    const listed = page.getByTestId("open-listed-project-TestProject");
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

  test("homepage project row X confirms Delete for OPFS", async ({ page }) => {
    await openTestProject(page);
    await saveAllIfEnabled(page);
    await closeProjectViaSettings(page);
    await expect(page.getByTestId("homepage")).toBeVisible();

    const listed = page.getByTestId("open-listed-project-TestProject");
    await expect(listed).toBeVisible();
    await page.getByTestId("remove-listed-project-TestProject").click();
    await expect(page.getByTestId("homepage-remove-dialog")).toBeVisible();
    await expect(page.getByTestId("homepage-remove-dialog")).toContainText(
      "Delete Project?",
    );
    await page.getByTestId("homepage-remove-cancel").click();
    await expect(listed).toBeVisible();

    await page.getByTestId("remove-listed-project-TestProject").click();
    await page.getByTestId("homepage-remove-confirm").click();
    await expect(listed).toHaveCount(0);
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
    await expect(joystick).toHaveAttribute("aria-checked", "true");
    await joystick.click();
    await expect(joystick).toHaveAttribute("aria-checked", "false");
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

  test("Content Browser click replaces the selection and Deselect All clears it", async ({
    page,
  }) => {
    await openTestProject(page);
    const sceneTile = page.locator(
      '[data-asset-path="assets/main.scene.babasset"]',
    );
    const classTile = page.locator(
      '[data-asset-path="assets/Mannequin.class.babasset"]',
    );
    await sceneTile.click();
    await classTile.click();
    await expect(sceneTile).toHaveAttribute("data-selected", "false");
    await expect(classTile).toHaveAttribute("data-selected", "true");
    await expect(page.getByTestId("content-browser-delete-selected")).toHaveText(
      /Delete \(1\)/,
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
      '[data-asset-path="assets/Mannequin.class.babasset"]',
    );
    await paintSelectContentTiles(page, sceneTile, classTile);

    const deleteSelected = page.getByTestId("content-browser-delete-selected");
    await expect(deleteSelected).toHaveText(/Delete \(2\)/);
    await expect(page.getByTestId("content-browser-deselect-all")).toBeVisible();
    await expect(deleteSelected).not.toHaveClass(/bg-destructive/);

    await deleteSelected.click();
    await expect(page.getByTestId("content-browser-delete-dialog")).toBeVisible();
    await expect(sceneTile).toBeVisible();
    await expect(classTile).toBeVisible();

    const dialog = page.getByTestId("content-browser-delete-dialog");
    const confirm = page.getByTestId("content-browser-delete-confirm");
    const cancel = page.getByTestId("content-browser-delete-cancel");
    await expect(dialog).toHaveAttribute("data-variant", "destructive");
    await expect(page.getByTestId("content-browser-delete-media")).toBeVisible();
    await expect(confirm).toHaveClass(/bg-destructive/);
    await expect(confirm).not.toHaveClass(/bg-destructive\/10/);
    await expect(confirm).toHaveClass(/text-destructive-foreground/);
    await expect(confirm).toHaveCSS("min-height", "44px");
    await expect(cancel).toHaveCSS("min-height", "44px");
    await expect(confirm).toHaveCSS("height", "44px");
    await expect(cancel).toHaveCSS("height", "44px");

    await cancel.click();
    await expect(page.getByTestId("content-browser-delete-dialog")).toHaveCount(0);
    await expect(sceneTile).toHaveAttribute("data-selected", "true");
    await expect(classTile).toHaveAttribute("data-selected", "true");
  });

  test("Delete confirm lists selected folder path and asset name", {
    tag: IPAD_TEST_TAG,
  }, async ({ page }) => {
    await openTestProject(page);
    await page.getByTestId("content-browser-new-folder").click();
    await expect(page.getByTestId("content-browser-name-dialog")).toBeVisible();
    await page.getByTestId("content-browser-name-input").fill("qa-folder");
    await page.getByTestId("content-browser-name-confirm").click();
    await page.getByTestId("tree-row-assets").click();
    const folderTile = page.getByTestId("content-folder-assets/qa-folder");
    const sceneTile = page.locator(
      '[data-asset-path="assets/main.scene.babasset"]',
    );
    await expect(folderTile).toBeVisible({ timeout: 15_000 });
    await folderTile.click();
    await sceneTile.click({ button: "right" });
    await expect(page.getByTestId("context-menu-panel")).toBeVisible();
    await page.getByTestId("context-menu-backdrop").dispatchEvent("click");
    await expect(page.getByTestId("context-menu-panel")).toHaveCount(0);
    const deleteSelected = page.getByTestId("content-browser-delete-selected");
    await expect(deleteSelected).toHaveText(/Delete \(2\)/);
    await deleteSelected.click();
    const list = page.getByTestId("content-browser-delete-list");
    await expect(list).toBeVisible();
    await expect(list).toContainText("assets/qa-folder");
    await expect(list.locator("li")).toHaveCount(2);
    await page.getByTestId("content-browser-delete-cancel").click();
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
    await expect(page.getByTestId("context-menu-item-copy-asset-reference")).toBeVisible();
    await expect(page.getByTestId("context-menu-item-retry-encoding")).toHaveCount(
      0,
    );
  });

  test("Content Browser Copy Asset Reference copies the asset guid", async ({
    page,
    context,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await openTestProject(page);
    const sceneTile = page.locator(
      '[data-asset-path="assets/main.scene.babasset"]',
    );
    await expect(sceneTile).toBeVisible();
    const guid = await sceneTile.getAttribute("data-asset-guid");
    expect(guid).toBeTruthy();
    await sceneTile.click({ button: "right" });
    await page.getByTestId("context-menu-item-copy-asset-reference").click();
    await expect.poll(async () => page.evaluate(() => navigator.clipboard.readText())).toBe(
      guid,
    );
  });
    tag: IPAD_TEST_TAG,
  }, async ({ page }) => {
    await openTestProject(page);
    const grid = page.getByTestId("content-browser-asset-grid");
    await grid.dblclick({ position: { x: 4, y: 4 } });
    await expect(
      page.getByTestId("content-browser-new-asset-dialog"),
    ).toBeVisible();
    await expect(page.getByTestId("new-asset-type-Scene")).toHaveAttribute(
      "data-selected",
      "true",
    );
    await expect(page.getByTestId("new-asset-name")).toHaveValue("");
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

    await paintSelectContentTiles(
      page,
      page.locator('[data-asset-path="assets/Alpha.babasset"]'),
      page.locator('[data-asset-path="assets/Beta.babasset"]'),
    );
    await page
      .locator('[data-asset-path="assets/Beta.babasset"]')
      .click({ button: "right" });
    await expect(page.getByTestId("context-menu-item-show-references")).toHaveCount(
      0,
    );
    await expect(
      page.getByTestId("context-menu-item-copy-asset-reference"),
    ).toHaveCount(0);
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
    await paintSelectContentTiles(
      page,
      page.getByTestId("content-folder-assets/fx"),
      page.locator('[data-asset-path="assets/Alpha.babasset"]'),
    );
    await page.getByTestId("content-folder-assets/fx").click({ button: "right" });
    await expect(page.getByTestId("context-menu-item-duplicate")).toBeVisible();
    await expect(page.getByTestId("context-menu-item-show-references")).toHaveCount(
      0,
    );
    await expect(
      page.getByTestId("context-menu-item-copy-asset-reference"),
    ).toHaveCount(0);
  });

  test("Material Focus hides Preview and restores it on exit", async ({
    page,
  }) => {
    await openTestProject(page);
    await createContentBrowserAsset(page, "Material", "Rock");
    await page
      .locator('[data-asset-path="assets/Rock.material.babasset"]')
      .dblclick();
    await expect(page.getByTestId("document-workspace-material")).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByTestId("material-graph-editor")).toBeVisible();
    await expect(page.getByTestId("material-preview-panel")).toBeVisible();

    const focus = page.getByTestId("focus-layout");
    await expect(focus).toBeEnabled();
    await focus.click();
    await expect(focus).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("material-graph-editor")).toBeVisible();
    await expect(page.getByTestId("material-preview-panel")).not.toBeVisible();

    await focus.click();
    await expect(focus).toHaveAttribute("aria-pressed", "false");
    await expect(page.getByTestId("material-preview-panel")).toBeVisible();
  });

  test("UserInterface Designer Focus hides Hierarchy", async ({ page }) => {
    await openTestProject(page);
    await createContentBrowserAsset(page, "UserInterface", "HUD");
    await page.locator('[data-asset-path="assets/HUD.ui.babasset"]').dblclick();
    await expect(page.getByTestId("document-workspace-ui")).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByTestId("ui-design-panel")).toBeVisible();
    await expect(page.getByTestId("ui-hierarchy-panel")).toBeVisible();

    const focus = page.getByTestId("focus-layout");
    await expect(focus).toBeEnabled();
    await focus.click();
    await expect(focus).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("ui-design-panel")).toBeVisible();
    await expect(page.getByTestId("ui-hierarchy-panel")).not.toBeVisible();

    await focus.click();
    await expect(focus).toHaveAttribute("aria-pressed", "false");
    await expect(page.getByTestId("ui-hierarchy-panel")).toBeVisible();
  });

  test("ScriptInterface Focus hides Methods", async ({ page }) => {
    await openTestProject(page);
    await createContentBrowserAsset(page, "ScriptInterface", "IHit");
    await page.locator('[data-asset-path="assets/IHit.babasset"]').dblclick();
    await expect(
      page.getByTestId("document-workspace-script-interface"),
    ).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("interface-preview-panel")).toBeVisible();
    await expect(page.getByTestId("interface-methods-panel")).toBeVisible();

    const focus = page.getByTestId("focus-layout");
    await expect(focus).toBeEnabled();
    await focus.click();
    await expect(focus).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("interface-preview-panel")).toBeVisible();
    await expect(page.getByTestId("interface-methods-panel")).not.toBeVisible();

    await focus.click();
    await expect(focus).toHaveAttribute("aria-pressed", "false");
    await expect(page.getByTestId("interface-methods-panel")).toBeVisible();
  });

  test("Animation Graph Focus hides Details", async ({ page }) => {
    await openTestProject(page);
    await createContentBrowserAsset(page, "AnimationGraph", "Loco");
    await page.locator('[data-asset-path="assets/Loco.anim.babasset"]').dblclick();
    await expect(page.getByTestId("document-workspace-anim-graph")).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByTestId("anim-graph-editor")).toBeVisible();
    await expect(page.getByTestId("anim-graph-details-empty")).toBeVisible();
    await expect(page.getByTestId("windows-menu")).toBeEnabled();

    const focus = page.getByTestId("focus-layout");
    await expect(focus).toBeEnabled();
    await focus.click();
    await expect(focus).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("anim-graph-editor")).toBeVisible();
    await expect(page.getByTestId("anim-graph-details-empty")).not.toBeVisible();

    await focus.click();
    await expect(focus).toHaveAttribute("aria-pressed", "false");
    await expect(page.getByTestId("anim-graph-details-empty")).toBeVisible();
  });

  test("Behaviour Tree Focus hides Details", async ({ page }) => {
    await openTestProject(page);
    await createContentBrowserAsset(page, "BehaviourTree", "Patrol");
    await page.locator('[data-asset-path="assets/Patrol.bt.babasset"]').dblclick();
    await expect(
      page.getByTestId("document-workspace-behaviour-tree"),
    ).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("behaviour-tree-editor")).toBeVisible();
    await expect(page.getByTestId("bt-details")).toBeVisible();

    const focus = page.getByTestId("focus-layout");
    await expect(focus).toBeEnabled();
    await focus.click();
    await expect(focus).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("behaviour-tree-editor")).toBeVisible();
    await expect(page.getByTestId("bt-details")).not.toBeVisible();

    await focus.click();
    await expect(focus).toHaveAttribute("aria-pressed", "false");
    await expect(page.getByTestId("bt-details")).toBeVisible();

    await openContentBrowser(page);
    await expect(page.getByTestId("focus-layout")).toBeDisabled();
  });
});
