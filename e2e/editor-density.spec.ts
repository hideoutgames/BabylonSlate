import { openMinimalTestProject as openTestProject } from "./minimal-project";
import { expect, test, type Page } from "@playwright/test";
import { closeProjectViaSettings } from "./close-project";
import { createContentBrowserAsset } from "./open-test-project";
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

  test("Content Browser Sort menu orders asset tiles", async ({ page }) => {
    await openTestProject(page);
    const grid = page.getByTestId("content-browser-asset-grid");
    const classPath = "assets/main.class.babasset";
    const scenePath = "assets/main.scene.babasset";
    await expect(
      grid.locator(`[data-asset-path="${classPath}"]`),
    ).toBeVisible();
    await expect(
      grid.locator(`[data-asset-path="${scenePath}"]`),
    ).toBeVisible();

    async function assetPaths(): Promise<string[]> {
      return grid
        .locator("[data-asset-path]")
        .evaluateAll((tiles) =>
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

  test(
    "Focus hides the Outliner; Place Actors catalog does not focus search",
    async ({ page }) => {
      await openTestProject(page);
      await page
        .locator('[data-asset-path="assets/main.scene.babasset"]')
        .dblclick();
      await expect(page.getByTestId("scene-outliner-panel")).toBeVisible({
        timeout: 15_000,
      });

      const dockTab = page
        .locator(".dockview-theme-babylonslate .dv-tab")
        .first();
      await expect(dockTab).toBeVisible();
      const dockBox = await dockTab.boundingBox();
      expect(dockBox).not.toBeNull();
      const coarse = await page.evaluate(
        () => window.matchMedia("(pointer: coarse)").matches,
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
      await expect(
        page.getByTestId("place-actors-catalog-search"),
      ).not.toBeFocused();
      await expect(page.getByTestId("place-actors-catalog-body")).toBeVisible();
    },
  );

  test("homepage project cards edit their identity and keep it after reopening", async ({
    page,
  }) => {
    await openTestProject(page);
    await saveAllIfEnabled(page);
    // Settle launcher entrance motion so menu hit testing is deterministic.
    await page.addStyleTag({
      content:
        ".homepage-library-view, .homepage-gallery-item { animation: none !important; }",
    });
    await closeProjectViaSettings(page);
    await expect(page.getByTestId("homepage")).toBeVisible();

    const listed = page.getByTestId("open-listed-project-TestProject");
    await expect(listed).toContainText("TestProject");
    const listedBox = await listed.boundingBox();
    expect(listedBox).not.toBeNull();
    await listed.click({
      button: "right",
      position: { x: listedBox!.width - 64, y: listedBox!.height / 2 },
    });
    await expect(page.getByTestId("homepage-project-menu")).toBeVisible();
    await expect(page.getByTestId("homepage-project-menu")).toBeInViewport({
      ratio: 1,
    });
    await expect(page.getByTestId("homepage-project-open")).toBeVisible();
    await expect(page.getByTestId("homepage-project-rename")).toBeVisible();
    await expect(page.getByTestId("homepage-project-remove")).toBeVisible();

    await page.getByTestId("homepage-project-rename").click();
    await expect(page.getByTestId("homepage-rename-dialog")).toBeVisible();
    await expect(page.getByTestId("create-project-empty")).toHaveCount(0);
    await page.getByTestId("homepage-rename-input").fill("Renamed Game");
    await page.getByRole("button", { name: "Violet", exact: true }).click();
    await page.getByTestId("homepage-rename-confirm").click();
    await expect(listed).toContainText("Renamed Game");
    await expect(listed.locator(".homepage-project-color")).toHaveAttribute(
      "data-color",
      "violet",
    );

    const openProject = listed.getByRole("button", {
      name: "Open Project Renamed Game",
      exact: true,
    });
    await openProject.focus();
    await page.keyboard.press("Shift+F10");
    await expect(page.getByTestId("homepage-project-open")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(openProject).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("editor-chrome-bar")).toBeVisible();
    await expect(page.locator("[data-slate-home-styles]")).toHaveCount(0);
    await closeProjectViaSettings(page);
    await expect(listed).toContainText("Renamed Game");
    await expect(listed.locator(".homepage-project-color")).toHaveAttribute(
      "data-color",
      "violet",
    );
  });

  test("homepage project card trash action confirms Delete for OPFS", async ({
    page,
  }) => {
    await openTestProject(page);
    await saveAllIfEnabled(page);
    await closeProjectViaSettings(page);
    await expect(page.getByTestId("homepage")).toBeVisible();

    const listed = page.getByTestId("open-listed-project-TestProject");
    await expect(listed).toBeVisible();
    await listed
      .getByRole("button", { name: "Project Actions for TestProject" })
      .click();
    await page.getByTestId("homepage-project-remove").click();
    await expect(page.getByTestId("homepage-remove-dialog")).toBeVisible();
    await expect(page.getByTestId("homepage-remove-dialog")).toContainText(
      "Delete Project?",
    );
    await page.getByTestId("homepage-remove-cancel").click();
    await expect(listed).toBeVisible();

    await listed
      .getByRole("button", { name: "Project Actions for TestProject" })
      .click();
    await page.getByTestId("homepage-project-remove").click();
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

  test(
    "Delete confirm lists selected folder path and asset name",
    async ({ page }) => {
      await openTestProject(page);
      await page.getByTestId("content-browser-new-folder").click();
      await expect(
        page.getByTestId("content-browser-name-dialog"),
      ).toBeVisible();
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
      const deleteSelected = page.getByTestId(
        "content-browser-delete-selected",
      );
      await expect(deleteSelected).toHaveText(/Delete \(2\)/);
      await deleteSelected.click();
      const list = page.getByTestId("content-browser-delete-list");
      await expect(list).toBeVisible();
      await expect(list).toContainText("assets/qa-folder");
      await expect(list.locator("li")).toHaveCount(2);
      await page.getByTestId("content-browser-delete-cancel").click();
    },
  );

  test("New Asset refuses a name that already exists; Duplicate uses stem_N", async ({
    page,
  }) => {
    await openTestProject(page);
    await page.getByTestId("content-browser-new-asset").click();
    await expect(
      page.getByTestId("content-browser-new-asset-dialog"),
    ).toBeVisible();
    await expect(page.getByTestId("new-asset-name")).toHaveValue("");
    await expect(
      page.getByTestId("content-browser-new-asset-create"),
    ).toBeDisabled();
    await page.getByTestId("new-asset-type").click();
    await page.getByTestId("new-asset-type-Scene").click();
    await page.getByTestId("new-asset-name").fill("main");
    await expect(page.getByTestId("new-asset-name-taken")).toBeVisible();
    await expect(
      page.getByTestId("content-browser-new-asset-create"),
    ).toBeDisabled();
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
    await expect(
      page.getByTestId("context-menu-item-show-references"),
    ).toHaveCount(0);
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
    await page
      .getByTestId("content-folder-assets/fx")
      .click({ button: "right" });
    await expect(page.getByTestId("context-menu-item-duplicate")).toBeVisible();
    await expect(
      page.getByTestId("context-menu-item-show-references"),
    ).toHaveCount(0);
    await expect(
      page.getByTestId("context-menu-item-copy-asset-reference"),
    ).toHaveCount(0);
  });
});
