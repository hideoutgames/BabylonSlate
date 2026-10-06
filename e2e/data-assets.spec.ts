import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  openAssetFromBrowser,
  openContentBrowser,
  openTestProject,
  selectContentBrowserAssetsFolder,
} from "./open-test-project";
import { saveAllIfEnabled } from "./save-all";

test.use({ actionTimeout: 15_000 });

function activeSheet(page: Page): Locator {
  return page.locator('[data-testid="document-workspace-data-sheet"]:visible');
}

async function createDataAsset(page: Page, type: "DataDefinition" | "DataSheet", name: string, definitionGuid?: string): Promise<void> {
  await openContentBrowser(page);
  await selectContentBrowserAssetsFolder(page);
  await page.getByTestId("content-browser-new-asset").click();
  await page.getByTestId("new-asset-type-search").fill(type === "DataDefinition" ? "Data Definition" : "Data Sheet");
  await page.getByTestId(`new-asset-type-${type}`).click();
  await page.getByTestId("new-asset-name").fill(name);
  if (definitionGuid) {
    await page.getByTestId("new-asset-definition").click();
    await page.getByTestId("asset-picker-query").fill("ItemStats");
    await page.getByTestId("asset-picker").getByTestId(`search-item-${definitionGuid}`).click();
  }
  await page.getByTestId("content-browser-new-asset-create").click();
  await expect(page.getByTestId("content-browser-new-asset-dialog")).toHaveCount(0);
  await expect(page.locator(`[data-testid="document-workspace-${type === "DataDefinition" ? "data-definition" : "data-sheet"}"]:visible`)).toBeVisible();
}

async function assetGuidFromBrowser(page: Page, path: string, name: string): Promise<string> {
  await openContentBrowser(page);
  await selectContentBrowserAssetsFolder(page);
  await page.getByTestId("content-browser-search").fill(name);
  const tile = page.locator(`[data-asset-path="${path}"]`);
  await expect(tile).toBeVisible();
  const guid = await tile.getAttribute("data-asset-guid");
  expect(guid).toBeTruthy();
  return guid!;
}

async function addDefinitionField(page: Page, name: string, type: "int" | "string", defaultValue: string): Promise<void> {
  const panel = page.getByTestId("data-definition-fields-panel");
  await panel.getByTestId("definition-field-add-name").fill(name);
  await panel.getByTestId("definition-field-add").click();
  const row = panel.locator('[data-testid^="definition-field-row-"]').last();
  await row.getByRole("button", { name: "Pin type", exact: true }).click();
  await page.getByTestId(`search-item-${type}`).click();
  const value = panel.getByRole("textbox", { name: "Default Value", exact: true });
  await value.fill(defaultValue);
  await value.press("Enter");
  await expect(value).toHaveValue(defaultValue);
}

async function addNamedRow(page: Page, name: string): Promise<string> {
  const panel = activeSheet(page).getByTestId("data-sheet-rows-panel");
  await panel.getByRole("button", { name: "New Row", exact: true }).click();
  const row = panel.locator('[data-testid^="data-sheet-row-"]').last();
  await expect(row).toContainText("New Entry");
  const testId = await row.getAttribute("data-testid");
  expect(testId).toBeTruthy();
  await panel.getByRole("button", { name: "Rename", exact: true }).click();
  await page.getByTestId("name-prompt-input").fill(name);
  await page.getByTestId("name-prompt-confirm").click();
  await expect(page.getByTestId("name-prompt-dialog")).toHaveCount(0);
  await expect(row).toContainText(name);
  return testId!.slice("data-sheet-row-".length);
}

test("independent Data Definitions drive owned sheet rows, Undo, persistence, and typed graph inputs", async ({ page }, testInfo) => {
  test.setTimeout(150_000);
  await openTestProject(page);

  // Author the independent schema through its field editor.
  await createDataAsset(page, "DataDefinition", "ItemStats");
  const definitionPath = "assets/ItemStats.datadefinition.babasset";
  await addDefinitionField(page, "Damage", "int", "12");
  await addDefinitionField(page, "DisplayName", "string", "Training Sword");
  await saveAllIfEnabled(page);
  await page.getByTestId("document-workspace-data-definition").screenshot({ path: testInfo.outputPath("data-definition-fields.png") });
  const definitionGuid = await assetGuidFromBrowser(page, definitionPath, "ItemStats");

  await createDataAsset(page, "DataSheet", "Equipment", definitionGuid);
  const sheetPath = "assets/Equipment.datasheet.babasset";
  const sheet = activeSheet(page);
  const rowId = await addNamedRow(page, "Iron Sword");
  const row = sheet.getByTestId(`data-sheet-row-${rowId}`);
  const damage = row.getByRole("textbox", { name: "Iron Sword Damage", exact: true });
  await expect(damage).toHaveValue("12");
  await expect(row.getByRole("textbox", { name: "Iron Sword DisplayName", exact: true })).toHaveValue("Training Sword");
  await expect(sheet.getByRole("grid", { name: "Data Rows", exact: true })).toHaveAttribute("aria-rowcount", "2");
  await damage.fill("37");
  await damage.press("Enter");
  await expect(sheet.getByTestId("data-sheet-values-panel").getByRole("textbox", { name: "Damage", exact: true })).toHaveValue("37");

  // Sheet values participate in the document's normal Undo history.
  await page.getByTestId("undo-document").click();
  await expect(damage).toHaveValue("12");
  await expect(row).toContainText("Iron Sword");
  await page.getByTestId("redo-document").click();
  await expect(damage).toHaveValue("37");
  await saveAllIfEnabled(page);
  const sheetGuid = await assetGuidFromBrowser(page, sheetPath, "Equipment");

  // A second sheet owns separate values even when its entry has the same name.
  await createDataAsset(page, "DataSheet", "SpareEquipment", definitionGuid);
  const sparePath = "assets/SpareEquipment.datasheet.babasset";
  const spareRowId = await addNamedRow(page, "Iron Sword");
  expect(spareRowId).not.toBe(rowId);
  await expect(sheet.getByTestId(`data-sheet-row-${spareRowId}`).getByRole("textbox", { name: "Iron Sword Damage", exact: true })).toHaveValue("12");
  await saveAllIfEnabled(page);
  await openAssetFromBrowser(page, sheetPath);
  await expect(damage).toHaveValue("37");
  await sheet.screenshot({ path: testInfo.outputPath("data-sheet-owned-rows.png") });

  await page.reload();
  await openTestProject(page);
  await openAssetFromBrowser(page, sheetPath);
  await expect(row).toBeVisible();
  await expect(damage).toHaveValue("37");
  await expect(row.getByRole("textbox", { name: "Iron Sword DisplayName", exact: true })).toHaveValue("Training Sword");
  await openAssetFromBrowser(page, sparePath);
  await expect(sheet.getByTestId(`data-sheet-row-${spareRowId}`).getByRole("textbox", { name: "Iron Sword Damage", exact: true })).toHaveValue("12");

  // Picking the sheet infers its Definition; the Row picker stores stable identity.
  await openAssetFromBrowser(page, "assets/Mannequin.class.babasset");
  await page.getByTestId("graph-add-node").click();
  await page.getByTestId("node-palette-search").fill("Read Data Row");
  await page.getByTestId("node-palette-item-data.readRow").click();
  const graph = page.getByTestId("graph-panel");
  await graph.getByRole("button", { name: "Size Graph To Fit" }).click();
  const readNode = graph.locator('.react-flow__node[data-id^="data.readRow-"]');
  await readNode.getByText("Read Data Row", { exact: true }).click();
  await readNode.getByRole("button", { name: "Sheet", exact: true }).click();
  await page.getByTestId("graph-pin-asset-picker").getByTestId(`search-item-${sheetGuid}`).click();
  const properties = page.getByTestId("inspector-data-properties");
  await expect(properties.getByTestId("property-definitionGuid")).toContainText("ItemStats");
  await properties.getByTestId("property-default:rowId").click();
  await page.getByRole("option", { name: "Iron Sword", exact: true }).click();
  await expect(properties.getByTestId("property-default:rowId")).toContainText("Iron Sword");
  await expect(readNode.locator('[data-handleid="value"]')).toHaveAttribute("data-pin-type", "structRef");
  await expect(readNode).toContainText("Read ItemStats Data");
  await expect(readNode.getByRole("button", { name: /^\d+ errors?$/ })).toHaveCount(0);
  await expect(readNode.getByRole("button", { name: "Open Asset", exact: true })).toHaveCount(0);
  const openSheetDefault = page.getByTestId("inspector-pin-defaults").getByRole("button", { name: "Open Asset", exact: true });
  await expect(openSheetDefault).toBeVisible();
  await saveAllIfEnabled(page);
  await page.getByTestId("document-workspace-graph").screenshot({ path: testInfo.outputPath("typed-data-row-node.png") });

  // Inspector defaults retain Open Asset; only the inline node control omits it.
  await openSheetDefault.click();
  await expect(row).toBeVisible();
  // Renaming an entry updates its picker label without changing the graph reference.
  await row.click();
  await sheet.getByRole("button", { name: "Rename", exact: true }).click();
  await page.getByTestId("name-prompt-input").fill("Iron Sword Renamed");
  await page.getByTestId("name-prompt-confirm").click();
  await expect(row).toContainText("Iron Sword Renamed");
  await openAssetFromBrowser(page, "assets/Mannequin.class.babasset");
  await readNode.getByText("Read ItemStats Data", { exact: true }).click();
  await expect(properties.getByTestId("property-default:rowId")).toContainText("Iron Sword Renamed");
  await expect(readNode.getByRole("button", { name: /^\d+ errors?$/ })).toHaveCount(0);
  await saveAllIfEnabled(page);
});
