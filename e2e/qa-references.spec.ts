import { expect, test } from "@playwright/test";
import { createActor, createDefaultScene, type SerializedScene } from "../packages/core/src/index.ts";
import { openContentBrowser, openMainScene, openTestProject, selectContentBrowserAssetsFolder } from "./open-test-project";
import { saveAllIfEnabled } from "./save-all";

test("H17: referenced Class deletion confirms twice and clears open scene usages", async ({
  page,
}) => {
  await openTestProject(page);
  await openMainScene(page);
  await page.evaluate(async (scene) => {
    await (globalThis as unknown as { __babylonslateTest: { setActiveSceneContent(value: SerializedScene): Promise<boolean> } })
      .__babylonslateTest.setActiveSceneContent(scene);
  }, { ...createDefaultScene(), actors: [createActor("one", "First", { classId: "Mannequin" }), createActor("two", "Second", { classId: "Mannequin" })] });
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
  await expect(page.getByTestId("content-browser-delete-confirm")).toBeEnabled();
  await page.getByTestId("content-browser-delete-confirm").click();
  const confirmation = page.getByTestId("content-browser-delete-references-confirmation");
  await expect(confirmation).toContainText("Mannequin → None");
  await confirmation.getByRole("button", { name: "Back", exact: true }).click();
  await expect(dialog).toBeVisible();
  await expect(tile).toBeVisible();
  await page.getByTestId("content-browser-delete-confirm").click();
  await page.getByTestId("content-browser-delete-references-confirm").click();
  await expect(page.getByRole("dialog", { name: "Deleting Assets", exact: true })).toHaveCount(0, { timeout: 30_000 });
  await expect(tile).toHaveCount(0);
  await saveAllIfEnabled(page);
  const actors = await page.evaluate(async () => {
    const bytes = await (globalThis as unknown as { __babylonslateTest: { readAssetChunk(path: string, chunk: string): Promise<Uint8Array> } })
      .__babylonslateTest.readAssetChunk("assets/main.scene.babasset", "document");
    return (JSON.parse(new TextDecoder().decode(bytes)) as SerializedScene).actors;
  });
  expect(actors.map((actor) => [actor.id, actor.classId])).toEqual([["one", "Actor"], ["two", "Actor"]]);
});
