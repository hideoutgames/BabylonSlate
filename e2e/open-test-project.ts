import { expect, type Page } from "@playwright/test";

/** Homepage → Create Project dialog (test-mode name TestProject) → editor chrome. */
export async function openTestProject(
  page: Page,
  path = "/?test=1",
): Promise<void> {
  await page.goto(path);
  await expect(page.getByTestId("homepage")).toBeVisible();
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

/** Create an authored asset from the Content Browser New Asset dialog. */
export async function createContentBrowserAsset(
  page: Page,
  type: string,
  name: string,
): Promise<void> {
  await openContentBrowser(page);
  await page.getByTestId("content-browser-new-asset").click();
  await expect(
    page.getByTestId("content-browser-new-asset-dialog"),
  ).toBeVisible();
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
  await page.locator(`[data-asset-path="${assetPath}"]`).dblclick();
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
