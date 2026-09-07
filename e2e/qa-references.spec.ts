import { expect, test } from "@playwright/test";
import { encodeAssetDocument } from "../packages/assets/src/asset-document";
import {
  createActor,
  createDefaultScene,
  createMeshComponent,
  type SerializedScene,
} from "../packages/core/src/index.ts";
import {
  createContentBrowserAsset,
  openContentBrowser,
  openMainScene,
  openTestProject,
  selectContentBrowserAssetsFolder,
} from "./open-test-project";

test("H9: a long References list keeps Close inside the viewport", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await openTestProject(page);
  await openContentBrowser(page);
  await selectContentBrowserAssetsFolder(page);
  const target = page.locator('[data-asset-path="assets/Mannequin.class.babasset"]');
  const guid = await target.getAttribute("data-asset-guid");
  expect(guid).toBeTruthy();
  const files = await Promise.all(Array.from({ length: 24 }, async (_, index) => ({
    name: `referrer-${index}.scene.babasset`,
    bytes: Array.from(await encodeAssetDocument({
      type: "Scene",
      guid: `qa-referrer-${index}`,
      name: `Referrer ${index} ${"Long Asset Name ".repeat(8)}`,
      version: 1,
      payload: { ...createDefaultScene(), actors: [createActor(`actor-${index}`, "Placed Class", { classId: "Mannequin" })] },
    }, { dependencies: [guid!] })),
  })));
  await page.evaluate(async (assets) => {
    const root = await navigator.storage.getDirectory();
    const project = await root.getDirectoryHandle("opfs:TestProject");
    const folder = await project.getDirectoryHandle("assets");
    for (const asset of assets) {
      const stream = await (await folder.getFileHandle(asset.name, { create: true })).createWritable();
      await stream.write(new Uint8Array(asset.bytes));
      await stream.close();
    }
    await (globalThis as unknown as { __babylonslateTest: { runForegroundRescan: () => Promise<void> } })
      .__babylonslateTest.runForegroundRescan();
  }, files);
  await page.getByTestId("external-change-reload-project-cancel").click();
  await expect(page.getByTestId("external-change-reload-project")).toHaveCount(0);
  await page.getByTestId("content-browser-search").fill("Mannequin");
  await target.click({ button: "right" });
  await page.getByTestId("context-menu-item-show-references").click();
  const dialog = page.getByTestId("content-browser-refs-dialog");
  await expect(dialog).toContainText("Referrer 23");
  const close = dialog.getByRole("button", { name: "Close", exact: true });
  for (const viewport of [{ width: 1280, height: 720 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await expect(async () => {
      const bounds = await close.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.y).toBeGreaterThanOrEqual(0);
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height);
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width);
    }).toPass();
  }
  await close.click();
  await expect(dialog).toHaveCount(0);
});

test("H17: Delete names the open scene that uses a placed class", async ({
  page,
}) => {
  await openTestProject(page);
  await openMainScene(page);
  await openContentBrowser(page);
  await selectContentBrowserAssetsFolder(page);
  const tile = page.locator(
    '[data-asset-path="assets/Mannequin.class.babasset"]',
  );
  await tile.click();
  await page.getByTestId("content-browser-delete-selected").click();
  const dialog = page.getByTestId("content-browser-delete-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/^main$/i)).toBeVisible();
  await expect(dialog.getByText("No inbound references.")).toHaveCount(0);
  await page.getByTestId("content-browser-delete-cancel").click();
  await expect(tile).toBeVisible();
});

test("H17: Delete includes a material assignment before Save", async ({
  page,
}) => {
  await openTestProject(page);
  await createContentBrowserAsset(page, "Material", "QAReference");
  const tile = page.locator('[data-asset-path*="QAReference."]');
  const guid = await tile.getAttribute("data-asset-guid");
  expect(guid).toBeTruthy();
  await openMainScene(page);
  const mesh = createMeshComponent("mesh", "sphere");
  mesh.properties.materialGuid = guid;
  const scene = {
    ...createDefaultScene(),
    actors: [createActor("sphere", "Sphere", { components: [mesh] })],
  };
  expect(
    await page.evaluate(async (next) => {
      return (
        globalThis as unknown as {
          __babylonslateTest: {
            setActiveSceneContent: (value: SerializedScene) => Promise<boolean>;
          };
        }
      ).__babylonslateTest.setActiveSceneContent(next);
    }, scene),
  ).toBe(true);
  await expect(page.getByTestId("save-all-project")).toBeEnabled();
  await openContentBrowser(page);
  await page.getByTestId("content-browser-search").fill("QAReference");
  await tile.click();
  await page.getByTestId("content-browser-delete-selected").click();
  const dialog = page.getByTestId("content-browser-delete-dialog");
  await expect(dialog.getByText(/^main$/i)).toBeVisible();
  await expect(dialog.getByText("No inbound references.")).toHaveCount(0);
  await page.getByTestId("content-browser-delete-cancel").click();
  await expect(tile).toBeVisible();
});
