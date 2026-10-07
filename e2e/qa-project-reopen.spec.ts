import { expect, test, type Page } from "@playwright/test";
import { createActor, createDefaultScene, type SerializedScene } from "../packages/core/src/index.ts";
import {
  createContentBrowserAsset,
  openAssetFromBrowser,
  openContentBrowser,
  openListedTestProject,
  openMainScene,
  openTestProject,
  selectContentBrowserAssetsFolder,
} from "./open-test-project";
import { saveAllIfEnabled } from "./save-all";

async function renameAsset(page: Page, path: string, name: string) {
  await openContentBrowser(page);
  await selectContentBrowserAssetsFolder(page);
  await page.getByTestId("content-browser-search").fill(path.split("/").pop()!.split(".")[0]!);
  await page.locator(`[data-asset-path="${path}"]`).click({ button: "right" });
  await page.getByTestId("context-menu-item-rename").click();
  await page.getByTestId("content-browser-name-input").fill(name);
  await page.getByTestId("content-browser-name-confirm").click();
  await expect(page.getByTestId("content-browser-name-dialog")).toHaveCount(0);
}

async function moveAsset(page: Page, path: string) {
  await openContentBrowser(page);
  await selectContentBrowserAssetsFolder(page);
  await page.getByTestId("content-browser-search").fill(path.split("/").pop()!.split(".")[0]!);
  await page.locator(`[data-asset-path="${path}"]`).click({ button: "right" });
  await page.getByTestId("context-menu-item-move").click();
  await page.getByTestId("content-browser-move-dialog").getByTestId("tree-row-assets/Relocated").click();
  await page.getByTestId("content-browser-move-confirm").click();
  await expect(page.getByTestId("content-browser-move-dialog")).toHaveCount(0);
}

for (const operation of ["rename", "move"] as const) {
  test(`saved open Scene and Class tabs survive a ${operation} and cold project reopen`, async ({ page }) => {
    await openTestProject(page);
    await createContentBrowserAsset(page, "Class", "ReopenHero");
    await createContentBrowserAsset(page, "Scene", "ReopenProbe");
    if (operation === "move") {
      await page.getByTestId("content-browser-new-folder").click();
      await page.getByTestId("content-browser-name-input").fill("Relocated");
      await page.getByTestId("content-browser-name-confirm").click();
      await expect(page.getByTestId("content-browser-name-dialog")).toHaveCount(0);
    }
    await openAssetFromBrowser(page, "assets/ReopenProbe.scene.babasset");
    const scene: SerializedScene = {
      ...createDefaultScene(),
      actors: [createActor("rename-hero", "Hero Instance", { classId: "ReopenHero" })],
    };
    expect(await page.evaluate(async (content) => (
      globalThis as unknown as { __babylonslateTest: { setActiveSceneContent: (scene: SerializedScene) => Promise<boolean> } }
    ).__babylonslateTest.setActiveSceneContent(content), scene)).toBe(true);
    await openAssetFromBrowser(page, "assets/ReopenHero.class.babasset");
    await expect(page.getByTestId("document-workspace-graph")).toBeVisible();
    await saveAllIfEnabled(page);

    if (operation === "rename") {
      await renameAsset(page, "assets/ReopenProbe.scene.babasset", "Arena");
      await renameAsset(page, "assets/ReopenHero.class.babasset", "Champion");
    } else {
      await moveAsset(page, "assets/ReopenProbe.scene.babasset");
      await moveAsset(page, "assets/ReopenHero.class.babasset");
    }

    // No Save All after moving: the previous saved layout still names old paths.
    await page.reload();
    await expect(page.getByTestId("homepage")).toBeVisible();
    await openListedTestProject(page);
    await expect(page.locator('[data-testid="document-tab"][data-document-kind="scene"]')).toContainText(operation === "rename" ? "Arena" : "ReopenProbe");
    await expect(page.locator('[data-testid="document-tab"][data-document-kind="graph"]')).toContainText(operation === "rename" ? "Champion" : "ReopenHero");
    await openMainScene(page);
    await expect(page.getByTestId("tree-row-actor:rename-hero")).toBeVisible();
    expect(await page.evaluate(() => (
      globalThis as unknown as { __babylonslateTest: { activeSceneContent: () => SerializedScene | null } }
    ).__babylonslateTest.activeSceneContent()?.actors.find(actor => actor.id === "rename-hero")?.classId)).toBe(operation === "rename" ? "Champion" : "ReopenHero");
  });
}
