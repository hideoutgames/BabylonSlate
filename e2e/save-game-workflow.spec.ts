import { expect, test, type Page } from "@playwright/test";
import { openMinimalTestProject } from "./minimal-project";
import { openAssetFromBrowser, openTestProject } from "./open-test-project";
import { saveAllIfEnabled } from "./save-all";

async function openSaveSettings(page: Page) {
  await page.getByTestId("settings-menu").click();
  await page.getByTestId("project-settings").click();
  await page.getByTestId("settings-modal-category-saveGames").click();
  const panel = page.getByTestId("settings-save-games-panel");
  await expect(panel).toBeVisible();
  return panel;
}

/** Real controls and persisted assets; no editor state injection. */
test("Save Game authoring preserves field identity and project defaults through reload", async ({ page }, testInfo) => {
  await openMinimalTestProject(page);
  await page.getByTestId("content-browser-new-asset").click();
  await page.getByTestId("new-asset-type-search").fill("Save Game");
  await page.getByTestId("new-asset-type-SaveGame").click();
  await page.getByTestId("new-asset-name").fill("PlayerProgress");
  await page.getByTestId("content-browser-new-asset-create").click();
  await expect(page.getByTestId("content-browser-new-asset-dialog")).toHaveCount(0);
  await openAssetFromBrowser(page, "assets/PlayerProgress.savegame.babasset");
  const workspace = page.getByTestId("document-workspace-save-game");
  await expect(workspace).toBeVisible();
  await expect(page.getByTestId("windows-menu")).toBeEnabled();
  const add = workspace.getByRole("button", { name: "Add Field", exact: true });
  await add.click();
  await page.getByLabel("Field Name", { exact: true }).fill("Score");
  await page.getByTestId("name-prompt-confirm").click();
  const scoreRow = workspace.getByRole("treeitem", { name: "Score Integer", exact: true });
  await expect(scoreRow).toBeVisible();
  const identity = (await scoreRow.getAttribute("data-testid"))!.replace("tree-row-", "");
  expect(identity).not.toBe("");
  const field = workspace.getByTestId(`save-field-${identity}`);
  await expect(field.getByRole("textbox", { name: "Name", exact: true })).toHaveValue("Score");
  await expect(workspace.getByRole("textbox", { name: "Field ID", exact: true })).toHaveCount(0);
  const defaultValue = field.getByTestId(`property-default-${identity}-Default Value`);
  await defaultValue.fill("25");
  await defaultValue.press("Tab");
  await expect(defaultValue).toHaveValue("25");
  await add.click();
  await page.getByLabel("Field Name", { exact: true }).fill("Level");
  await page.getByTestId("name-prompt-confirm").click();
  await expect(workspace.getByRole("textbox", { name: "Name", exact: true })).toHaveValue("Level");
  await scoreRow.click();
  await expect(defaultValue).toHaveValue("25");
  await field.getByRole("textbox", { name: "Name", exact: true }).fill("Coins");
  await expect(workspace.getByTestId(`tree-row-${identity}`)).toContainText("Coins");
  await workspace.getByRole("button", { name: "Use As Project Default" }).click();
  await expect(workspace.getByRole("button", { name: "Project Default", exact: true })).toBeDisabled();
  await workspace.getByRole("button", { name: "Advanced", exact: true }).click();
  await expect(page.getByTestId("save-game-definition-panel")).toContainText('"Coins": number');
  const coarse = await page.evaluate(() => matchMedia("(pointer: coarse)").matches);
  if (coarse) expect((await add.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await page.screenshot({ path: testInfo.outputPath("save-game-fields.png") });
  await saveAllIfEnabled(page);

  // A closed definition must still supply typed nodes from its saved document chunk.
  await page.locator('[data-testid="document-tab"][data-document-kind="save-game"]').getByTestId("document-tab-close").click();
  await openAssetFromBrowser(page, "assets/main.class.babasset");
  await page.getByTestId("graph-add-node").click();
  await page.getByTestId("node-palette-search").fill("Get Save Coins");
  const getter = page.getByTestId(`node-palette-item-saveGame.getField:${identity}`);
  await expect(getter).toBeVisible();
  await getter.click();
  await expect(page.getByTestId("graph-panel").locator(".react-flow__node").filter({ hasText: "Get Save Coins" })).toHaveCount(1);
  await page.getByTestId("graph-add-node").click();
  await page.getByTestId("node-palette-search").fill("Set Save Coins");
  await expect(page.getByTestId(`node-palette-item-saveGame.setField:${identity}`)).toBeVisible();
  await page.keyboard.press("Escape");
  await page.screenshot({ path: testInfo.outputPath("save-game-nodes.png") });
  await saveAllIfEnabled(page);

  const settings = await openSaveSettings(page);
  await expect(settings.locator("#settings-save-definition")).toContainText("PlayerProgress");
  await settings.getByLabel("Default Slot", { exact: true }).fill("checkpoint");
  await settings.getByLabel("Default Profile", { exact: true }).fill("player-one");
  await expect(settings.getByLabel("Profile", { exact: true })).toHaveValue("player-one");
  await expect(settings.getByLabel("Import Slot", { exact: true })).toHaveValue("checkpoint");
  await settings.getByRole("switch", { name: "Wipe Preview Saves On Play" }).click();
  await expect(settings.getByRole("switch", { name: "Wipe Preview Saves On Play" })).toBeChecked();
  const reset = settings.getByRole("button", { name: "Reset Preview Saves", exact: true });
  await expect(reset).toBeEnabled();
  await reset.click();
  await expect(page.getByRole("alertdialog")).toContainText("Exported game saves are separate");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("alertdialog")).toBeHidden();
  if (coarse) expect((await reset.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await page.screenshot({ path: testInfo.outputPath("save-game-settings.png") });
  expect(await settings.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
  await page.getByTestId("settings-modal").locator('[data-slot="dialog-close"]').first().click();
  await saveAllIfEnabled(page);

  await page.reload();
  await openTestProject(page);
  await openAssetFromBrowser(page, "assets/PlayerProgress.savegame.babasset");
  const restored = page.getByTestId(`save-field-${identity}`);
  await expect(restored.getByRole("textbox", { name: "Name", exact: true })).toHaveValue("Coins");
  await expect(restored.getByTestId(`property-default-${identity}-Default Value`)).toHaveValue("25");
  const restoredSettings = await openSaveSettings(page);
  await expect(restoredSettings.getByLabel("Default Slot", { exact: true })).toHaveValue("checkpoint");
  await expect(restoredSettings.getByLabel("Default Profile", { exact: true })).toHaveValue("player-one");
  await expect(restoredSettings.getByRole("switch", { name: "Wipe Preview Saves On Play" })).toBeChecked();
});
