import { expect, test } from "@playwright/test";
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
