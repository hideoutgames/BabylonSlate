import { expect, test, type Page } from "@playwright/test";
import {
  createContentBrowserAsset,
  openAssetFromBrowser,
  openContentBrowser,
  openTestProject,
  selectContentBrowserAssetsFolder,
} from "./open-test-project";
import { saveAllIfEnabled } from "./save-all";

test.use({ actionTimeout: 15_000 });

async function createDataAsset(page: Page, type: "DataObject" | "DataSheet", name: string, structureGuid: string): Promise<void> {
  await openContentBrowser(page);
  await selectContentBrowserAssetsFolder(page);
  await page.getByTestId("content-browser-new-asset").click();
  await page.getByTestId("new-asset-type-search").fill(type === "DataObject" ? "Data Object" : "Data Sheet");
  await page.getByTestId(`new-asset-type-${type}`).click();
  await page.getByTestId("new-asset-name").fill(name);
  await page.getByTestId("new-asset-structure").click();
  await page.getByTestId("asset-picker-query").fill("ItemStats");
  await page.getByTestId("asset-picker").getByTestId(`search-item-${structureGuid}`).click();
  await page.getByTestId("content-browser-new-asset-create").click();
  await expect(page.getByTestId("content-browser-new-asset-dialog")).toHaveCount(0);
  await expect(page.getByTestId(`document-workspace-${type === "DataObject" ? "data-object" : "data-sheet"}`)).toBeVisible();
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

test("standalone Data Objects share sheet edits, preserve targeted undo and reopen as typed graph inputs", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  await openTestProject(page);

  // Author the actual Structure instead of seeding its data through a test hook.
  await createContentBrowserAsset(page, "Structure", "ItemStats");
  const structurePath = "assets/ItemStats.babasset";
  const structureGuid = await assetGuidFromBrowser(page, structurePath, "ItemStats");
  await openAssetFromBrowser(page, structurePath);
  await page.getByTestId("structure-add-field").click();
  await page.getByRole("textbox", { name: "Field 1 name", exact: true }).fill("Damage");
  const details = page.getByTestId("structure-details-panel");
  await details.getByRole("textbox", { name: "Default", exact: true }).fill("12");
  await details.getByRole("textbox", { name: "Default", exact: true }).press("Enter");
  await page.getByTestId("structure-add-field").click();
  await page.getByRole("textbox", { name: "Field 2 name", exact: true }).fill("DisplayName");
  await page.getByTestId("structure-field-type").click();
  await page.getByTestId("search-item-string").click();
  await details.getByRole("textbox", { name: "Default", exact: true }).fill("Training Sword");
  await saveAllIfEnabled(page);

  // No sheet is needed to create, open, or use this object.
  await createDataAsset(page, "DataObject", "IronSword", structureGuid);
  const objectPath = "assets/IronSword.dataobject.babasset";
  const standalone = page.getByTestId("document-workspace-data-object");
  await expect(standalone.getByRole("textbox", { name: "Damage", exact: true })).toHaveValue("12");
  await expect(standalone.getByRole("textbox", { name: "DisplayName", exact: true })).toHaveValue("Training Sword");
  await expect(page.getByTestId("document-workspace-data-sheet")).toHaveCount(0);
  await standalone.screenshot({ path: testInfo.outputPath("standalone-data-object.png") });
  const objectGuid = await assetGuidFromBrowser(page, objectPath, "IronSword");
  const objectTab = page.locator('[data-testid="document-tab"][data-document-kind="data-object"]');
  await objectTab.getByTestId("document-tab-close").click();
  await expect(objectTab).toHaveCount(0);

  await createDataAsset(page, "DataSheet", "Equipment", structureGuid);
  const sheetPath = "assets/Equipment.datasheet.babasset";
  const sheet = page.getByTestId("document-workspace-data-sheet");
  await sheet.getByRole("button", { name: "Add Existing", exact: true }).click();
  await page.getByTestId("asset-picker").getByTestId(`search-item-${objectGuid}`).click();
  const row = sheet.getByTestId(`data-sheet-row-${objectGuid}`);
  const damage = row.getByRole("textbox", { name: "IronSword Damage", exact: true });
  await expect(damage).toHaveValue("12");
  await expect(sheet.getByRole("grid", { name: "Data Sheet Objects" })).toHaveAttribute("aria-rowcount", "2");
  await damage.fill("37");
  await damage.press("Enter");
  await expect(sheet.getByRole("textbox", { name: "Damage", exact: true })).toHaveValue("37");
  await expect(objectTab).toHaveCount(0);

  // Object undo is distinct from the sheet's membership undo history.
  await sheet.getByRole("button", { name: "Undo Object", exact: true }).click();
  await expect(damage).toHaveValue("12");
  await expect(row).toBeVisible();
  await sheet.getByRole("button", { name: "Redo Object", exact: true }).click();
  await expect(damage).toHaveValue("37");
  await sheet.screenshot({ path: testInfo.outputPath("data-sheet-shared-values.png") });

  await sheet.getByRole("button", { name: "Open Object", exact: true }).click();
  await expect(standalone).toBeVisible();
  await expect(standalone.getByRole("textbox", { name: "Damage", exact: true })).toHaveValue("37");
  await saveAllIfEnabled(page);
  await page.reload();
  await openTestProject(page);
  await openAssetFromBrowser(page, objectPath);
  await expect(standalone.getByRole("textbox", { name: "Damage", exact: true })).toHaveValue("37");
  await expect(standalone.getByRole("textbox", { name: "DisplayName", exact: true })).toHaveValue("Training Sword");
  await openAssetFromBrowser(page, sheetPath);
  await expect(row).toBeVisible();
  await expect(damage).toHaveValue("37");

  // Picking the object infers its Structure and exposes a typed Value output.
  await openAssetFromBrowser(page, "assets/Mannequin.class.babasset");
  await page.getByTestId("graph-add-node").click();
  await page.getByTestId("node-palette-search").fill("Read Data Object");
  await page.getByTestId("node-palette-item-data.readObject").click();
  const graph = page.getByTestId("graph-panel");
  await graph.getByRole("button", { name: "Size Graph To Fit" }).click();
  const readNode = graph.locator('.react-flow__node[data-id^="data.readObject-"]');
  await readNode.getByText("Read Data Object", { exact: true }).click();
  await readNode.getByRole("button", { name: "Object", exact: true }).click();
  await page.getByTestId("graph-pin-asset-picker").getByTestId(`search-item-${objectGuid}`).click();
  await expect(page.getByTestId("inspector-data-properties").getByTestId("property-structGuid")).toContainText("ItemStats");
  await expect(readNode.locator('[data-handleid="value"]')).toHaveAttribute("data-pin-type", "structRef");
  await expect(readNode).toContainText("Read ItemStats Data");
  await expect(readNode.getByRole("button", { name: /^\d+ errors?$/ })).toHaveCount(0);
  await graph.screenshot({ path: testInfo.outputPath("typed-data-object-node.png") });

  // Creating directly from the typed input carries its Structure and defaults.
  await page.getByTestId("inspector-pin-defaults").getByTestId("property-object").click();
  await page.getByTestId("inspector-asset-picker-query").fill("GeneratedSword");
  await page.getByTestId("inspector-asset-picker").getByTestId("search-item-__create__DataObject").click();
  await expect(page.getByTestId("inspector-asset-picker")).toHaveCount(0);
  await expect(page.getByTestId("inspector-data-properties").getByTestId("property-structGuid")).toContainText("ItemStats");
  await page.getByTestId("inspector-pin-defaults").getByTestId("property-object-open").click();
  await expect(standalone).toBeVisible();
  await expect(standalone.getByRole("textbox", { name: "Damage", exact: true })).toHaveValue("12");
  await expect(standalone.getByRole("textbox", { name: "DisplayName", exact: true })).toHaveValue("Training Sword");
  await saveAllIfEnabled(page);
});
