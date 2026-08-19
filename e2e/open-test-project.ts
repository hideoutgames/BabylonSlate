import { expect, type Page } from "@playwright/test";

/** Click the Homepage TestProject row (name with or without `.babproject`). */
export async function clickListedTestProject(page: Page): Promise<void> {
  const listed = page.getByTestId("open-listed-project-TestProject");
  const listedLegacy = page.getByTestId(
    "open-listed-project-TestProject.babproject",
  );
  if ((await listed.count()) > 0) {
    await listed.click();
    return;
  }
  await listedLegacy.click();
}

/** Homepage → Create Project dialog (test-mode name TestProject) → editor chrome.
 *  If TestProject is already listed (shared OPFS), open it instead of Create.
 */
export async function openTestProject(
  page: Page,
  path = "/?test=1",
): Promise<void> {
  await page.goto(path);
  await expect(page.getByTestId("homepage")).toBeVisible();
  const listed = page.getByTestId("open-listed-project-TestProject");
  const listedLegacy = page.getByTestId(
    "open-listed-project-TestProject.babproject",
  );
  if ((await listed.count()) > 0) {
    await listed.click();
    await expect(page.getByTestId("editor-chrome-bar")).toBeVisible();
    return;
  }
  if ((await listedLegacy.count()) > 0) {
    await listedLegacy.click();
    await expect(page.getByTestId("editor-chrome-bar")).toBeVisible();
    return;
  }
  await page.getByTestId("create-project").click();
  await expect(page.getByTestId("create-project-dialog")).toBeVisible();
  await expect(page.getByTestId("create-project-name")).toHaveValue(
    "TestProject",
  );
  await expect(page.getByTestId("create-project-empty")).toHaveAttribute(
    "data-selected",
    "true",
  );
  await page.getByTestId("create-project-submit").click();
  await expect(page.getByTestId("editor-chrome-bar")).toBeVisible();
}

/** Click the homepage TestProject row after Close / reload, then wait for chrome. */
export async function openListedTestProject(page: Page): Promise<void> {
  await clickListedTestProject(page);
  await expect(page.getByTestId("editor-chrome-bar")).toBeVisible();
}

/** Submit Create when the name is free; otherwise dismiss and open the listed project. */
export async function submitCreateOrOpenListed(
  page: Page,
  listedName = "TestProject",
): Promise<void> {
  const submit = page.getByTestId("create-project-submit");
  if (await submit.isEnabled()) {
    await submit.click();
    return;
  }
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("create-project-dialog")).toHaveCount(0);
  const listed = page.getByTestId(`open-listed-project-${listedName}`);
  if ((await listed.count()) > 0) {
    await listed.click();
    return;
  }
  await page.getByTestId(`open-listed-project-${listedName}.babproject`).click();
}

export async function openContentBrowser(page: Page): Promise<void> {
  const tab = page.locator(
    '[data-testid="document-tab"][data-document-kind="content-browser"]',
  );
  const select = tab.getByTestId("document-tab-select");
  if ((await select.count()) > 0) {
    await select.click();
  }
  await expect(
    page.getByTestId("document-workspace-content-browser"),
  ).toBeVisible();
}

/** Grid search is the current folder only; click the project assets root. */
export async function selectContentBrowserAssetsFolder(
  page: Page,
): Promise<void> {
  const tree = page.getByTestId("content-browser-folder-tree");
  await expect(tree).toBeVisible();
  await tree.evaluate((element) => {
    element.scrollTop = 0;
  });
  const assetsRow = page.getByTestId("tree-row-assets");
  await expect(assetsRow).toBeVisible();
  await assetsRow.click();
}

/** Create an authored asset from the Content Browser New Asset dialog. */
export async function createContentBrowserAsset(
  page: Page,
  type: string,
  name: string,
): Promise<void> {
  await openContentBrowser(page);
  await selectContentBrowserAssetsFolder(page);
  await page.getByTestId("content-browser-new-asset").click();
  await expect(
    page.getByTestId("content-browser-new-asset-dialog"),
  ).toBeVisible();
  await page.getByTestId("new-asset-type-search").fill(type);
  await page.getByTestId(`new-asset-type-${type}`).click();
  await page.getByTestId("new-asset-name").fill(name);
  await page.getByTestId("content-browser-new-asset-create").click();
  await expect(
    page.getByTestId("content-browser-new-asset-dialog"),
  ).toHaveCount(0);
  await openContentBrowser(page);
}

/** Open an asset from Content Browser, activating the browser tab if it is hidden. */
export async function openAssetFromBrowser(
  page: Page,
  assetPath: string,
): Promise<void> {
  await openContentBrowser(page);
  await selectContentBrowserAssetsFolder(page);
  const segments = assetPath.split("/");
  for (let index = 1; index < segments.length - 1; index += 1) {
    const folderPath = segments.slice(0, index + 1).join("/");
    const folderTile = page.getByTestId(`content-folder-${folderPath}`);
    if ((await folderTile.count()) > 0) {
      await folderTile.dblclick();
    }
  }
  const tile = page.locator(`[data-asset-path="${assetPath}"]`);
  if (!(await tile.isVisible())) {
    const fileName = assetPath.split("/").pop() ?? assetPath;
    const searchNeedle = fileName.replace(/\.babasset$/, "").split(".")[0];
    await page.getByTestId("content-browser-search").fill(searchNeedle);
  }
  await expect(tile).toBeVisible({ timeout: 15_000 });
  await tile.dblclick();
}

export async function openMainScene(page: Page): Promise<void> {
  const sceneTab = page.locator(
    '[data-testid="document-tab"][data-document-kind="scene"]',
  );
  if ((await sceneTab.count()) > 0) {
    const select = sceneTab.getByTestId("document-tab-select");
    if ((await select.count()) > 0) {
      await select.click();
    }
  } else {
    await openAssetFromBrowser(page, "assets/main.scene.babasset");
  }
  await expect(page.getByTestId("document-workspace-scene")).toBeVisible();
  await expect(page.getByTestId("viewport-canvas")).toBeVisible({
    timeout: 15_000,
  });
}
