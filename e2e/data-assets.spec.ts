import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  openAssetFromBrowser,
  openContentBrowser,
  openTestProject,
  selectContentBrowserAssetsFolder,
} from "./open-test-project";
import { saveAllIfEnabled } from "./save-all";

test.use({ actionTimeout: 15_000 });

function activeTree(page: Page): Locator {
  return page.locator('[data-testid="document-workspace-data-tree"]:visible');
}

async function createDataAsset(page: Page, type: "DataDefinition" | "DataTree", name: string, definitionGuid?: string, definitionName = "ItemStats"): Promise<void> {
  await openContentBrowser(page);
  await selectContentBrowserAssetsFolder(page);
  await page.getByTestId("content-browser-new-asset").click();
  await page.getByTestId("new-asset-type-search").fill(type === "DataDefinition" ? "Data Definition" : "Data Tree");
  await page.getByTestId(`new-asset-type-${type}`).click();
  await page.getByTestId("new-asset-name").fill(name);
  if (definitionGuid) {
    await page.getByTestId("new-asset-definition").click();
    await page.getByTestId("asset-picker-query").fill(definitionName);
    await page.getByTestId("asset-picker").getByTestId(`search-item-${definitionGuid}`).click();
  }
  await page.getByTestId("content-browser-new-asset-create").click();
  await expect(page.getByTestId("content-browser-new-asset-dialog")).toHaveCount(0);
  await expect(page.locator(`[data-testid="document-workspace-${type === "DataDefinition" ? "data-definition" : "data-tree"}"]:visible`)).toBeVisible();
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
  const panel = page.locator('[data-testid="document-workspace-data-definition"]:visible').getByTestId("data-definition-fields-panel");
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

async function addNamedEntry(page: Page, name: string, child = false): Promise<string> {
  const hierarchy = activeTree(page).getByTestId("data-tree-hierarchy-panel");
  await hierarchy.getByRole("button", { name: child ? "Add Child" : "Add Root", exact: true }).click();
  const selected = hierarchy.locator('[role="treeitem"][aria-selected="true"]');
  await expect(selected).toContainText("New Entry");
  const testId = await selected.getAttribute("data-testid");
  expect(testId).toBeTruthy();
  await selected.getByRole("button", { name: "Entry Menu For New Entry", exact: true }).click();
  await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
  await page.getByTestId("name-prompt-input").fill(name);
  await page.getByTestId("name-prompt-confirm").click();
  await expect(selected).toContainText(name);
  return testId!.slice("tree-row-".length);
}

async function selectPath(page: Page, picker: Locator, path: string): Promise<void> {
  await picker.click();
  await page.getByTestId(`search-item-${path}`).click();
}

async function placeNodeTitle(page: Page, title: Locator, x: number, y: number): Promise<void> {
  const box = await title.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  await page.mouse.move(x, y, { steps: 12 });
  await page.mouse.up();
}

test("Data Trees own hierarchical values and infer mixed Definition graph types", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  await openTestProject(page);
  await createDataAsset(page, "DataDefinition", "ItemStats");
  const definitionPath = "assets/ItemStats.datadefinition.babasset";
  await addDefinitionField(page, "Damage", "int", "12");
  await addDefinitionField(page, "DisplayName", "string", "Training Sword");
  await saveAllIfEnabled(page);
  await page.getByTestId("document-workspace-data-definition").screenshot({ path: testInfo.outputPath("data-definition-fields.png") });
  const definitionGuid = await assetGuidFromBrowser(page, definitionPath, "ItemStats");

  await createDataAsset(page, "DataDefinition", "ArmorStats");
  await addDefinitionField(page, "Defense", "int", "8");
  await saveAllIfEnabled(page);
  const armorGuid = await assetGuidFromBrowser(page, "assets/ArmorStats.datadefinition.babasset", "ArmorStats");

  await createDataAsset(page, "DataTree", "Equipment");
  const treePath = "assets/Equipment.datatree.babasset";
  const tree = activeTree(page);
  const weaponsId = await addNamedEntry(page, "Weapons");
  const values = tree.getByTestId("data-tree-values-panel");
  await values.getByRole("button", { name: "Entry Definition", exact: true }).click();
  await page.getByTestId("asset-picker").getByTestId(`search-item-${definitionGuid}`).click();
  await values.getByRole("button", { name: "Review Changes", exact: true }).click();
  await page.getByRole("button", { name: "Apply Changes", exact: true }).click();
  const swordId = await addNamedEntry(page, "Iron Sword", true);
  const sword = tree.getByTestId(`data-tree-entry-${swordId}`);
  const damage = sword.getByRole("textbox", { name: "Iron Sword Damage", exact: true });
  await expect(damage).toHaveValue("12");
  await damage.fill("37");
  await damage.press("Enter");
  await expect(tree.getByTestId("data-tree-values-panel").getByRole("textbox", { name: "Damage", exact: true })).toHaveValue("37");
  await page.getByTestId("undo-document").click();
  await expect(damage).toHaveValue("12");
  await page.getByTestId("redo-document").click();
  await expect(damage).toHaveValue("37");

  // Children start from Definition defaults and keep independent authored values.
  await tree.getByTestId(`tree-row-${weaponsId}`).click();
  const axeId = await addNamedEntry(page, "Iron Axe", true);
  await expect(tree.getByTestId(`data-tree-entry-${axeId}`).getByRole("textbox", { name: "Iron Axe Damage", exact: true })).toHaveValue("12");
  const armorId = await addNamedEntry(page, "Armor");
  await values.getByRole("button", { name: "Entry Definition", exact: true }).click();
  await page.getByTestId("asset-picker").getByTestId(`search-item-${armorGuid}`).click();
  await values.getByRole("button", { name: "Review Changes", exact: true }).click();
  await page.getByRole("button", { name: "Apply Changes", exact: true }).click();
  await expect(values.getByRole("textbox", { name: "Defense", exact: true })).toHaveValue("8");
  const helmetId = await addNamedEntry(page, "Iron Helmet", true);
  await expect(tree.getByTestId(`data-tree-entry-${helmetId}`).getByRole("textbox", { name: "Iron Helmet Defense", exact: true })).toHaveValue("8");
  await saveAllIfEnabled(page);
  const treeGuid = await assetGuidFromBrowser(page, treePath, "Equipment");
  await openAssetFromBrowser(page, treePath);
  await tree.getByTestId(`tree-row-${swordId}`).click();
  await expect(damage).toHaveValue("37");
  await tree.screenshot({ path: testInfo.outputPath("data-tree-hierarchy.png") });

  await page.reload();
  await openTestProject(page);
  await openAssetFromBrowser(page, treePath);
  await tree.getByTestId(`tree-row-${swordId}`).click();
  await expect(damage).toHaveValue("37");
  await expect(tree.getByTestId(`tree-row-${armorId}`)).toContainText("Armor");

  // Known paths infer the entry's effective Definition, including branch overrides.
  await openAssetFromBrowser(page, "assets/Mannequin.class.babasset");
  await page.getByTestId("graph-add-node").click();
  await page.getByTestId("node-palette-search").fill("Read Data Entry");
  await page.getByTestId("node-palette-item-data.readEntry").click();
  const graph = page.getByTestId("graph-panel");
  await graph.getByRole("button", { name: "Size Graph To Fit" }).click();
  const readNode = graph.locator('.react-flow__node[data-id^="data.readEntry-"]');
  await readNode.getByText("Read Data Entry", { exact: true }).click();
  const inspector = page.getByTestId("inspector-panel");
  await readNode.getByRole("textbox", { name: "Entry Path", exact: true }).fill("Manual Entry");
  await readNode.getByRole("textbox", { name: "Entry Path", exact: true }).press("Enter");
  await expect(inspector.getByRole("textbox", { name: "Entry Path", exact: true })).toHaveValue("Manual Entry");
  await readNode.getByRole("button", { name: "Tree", exact: true }).click();
  await page.getByTestId("graph-pin-asset-picker").getByTestId(`search-item-${treeGuid}`).click();
  const inlinePath = readNode.getByRole("combobox", { name: "Entry Path", exact: true });
  const defaultPath = inspector.getByRole("combobox", { name: "Entry Path", exact: true });
  await selectPath(page, inlinePath, "Weapons/Iron Sword");
  await expect(defaultPath).toContainText("Weapons/Iron Sword");
  const properties = page.getByTestId("inspector-data-properties");
  await expect(properties.getByTestId("property-definitionGuid")).toContainText("ItemStats");
  await selectPath(page, defaultPath, "Armor/Iron Helmet");
  await expect(inlinePath).toContainText("Armor/Iron Helmet");
  await expect(properties.getByTestId("property-definitionGuid")).toContainText("ArmorStats");
  await selectPath(page, inlinePath, "Weapons/Iron Sword");
  await expect(readNode.locator('[data-handleid="value"]')).toHaveAttribute("data-pin-type", "structRef");
  await expect(readNode.getByRole("button", { name: /^\d+ errors?$/ })).toHaveCount(0);
  await expect(readNode.getByRole("button", { name: "Open Asset", exact: true })).toHaveCount(0);
  await page.getByTestId("graph-add-node").click();
  await page.getByTestId("node-palette-search").fill("Break ItemStats Data");
  await page.getByTestId(`node-palette-item-struct.break:${definitionGuid}`).click();
  const breakNode = graph.locator('.react-flow__node[data-id^="struct.break:"]');
  await graph.getByRole("button", { name: "Size Graph To Fit" }).click();
  await expect(breakNode.locator('[data-handleid="Damage"]')).toHaveAttribute("data-pin-type", "int");
  await expect(breakNode.locator('[data-handleid="DisplayName"]')).toHaveAttribute("data-pin-type", "string");
  const pane = await graph.locator(".react-flow__pane").boundingBox();
  expect(pane).not.toBeNull();
  await placeNodeTitle(page, readNode.getByText("Read ItemStats Data", { exact: true }), pane!.x + 150, pane!.y + pane!.height - 115);
  await placeNodeTitle(page, breakNode.getByText("Break ItemStats Data", { exact: true }), pane!.x + 510, pane!.y + pane!.height - 115);
  const edgesBefore = await graph.locator(".react-flow__edge").count();
  await readNode.locator('[data-handleid="value"]').click({ force: true });
  await breakNode.locator('[data-handleid="in"]').click({ force: true });
  await expect(graph.locator(".react-flow__edge")).toHaveCount(edgesBefore + 1);
  await readNode.getByText("Read ItemStats Data", { exact: true }).click();
  const openTree = page.getByTestId("inspector-pin-defaults").getByRole("button", { name: "Open Asset", exact: true });
  await expect(openTree).toBeVisible();
  await saveAllIfEnabled(page);
  await page.getByTestId("document-workspace-graph").screenshot({ path: testInfo.outputPath("typed-data-tree-node.png") });

  // No selected tree restores text controls, preserving the authored path.
  await readNode.getByRole("button", { name: "Tree", exact: true }).click();
  await page.getByTestId("graph-pin-asset-picker").getByTestId("search-item-__none__").click();
  await expect(readNode.getByRole("textbox", { name: "Entry Path", exact: true })).toHaveValue("Weapons/Iron Sword");
  await readNode.getByRole("button", { name: "Tree", exact: true }).click();
  await page.getByTestId("graph-pin-asset-picker").getByTestId(`search-item-${treeGuid}`).click();
  await openTree.click();
  await tree.getByTestId(`tree-row-${swordId}`).getByRole("button", { name: "Entry Menu For Iron Sword", exact: true }).click();
  await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
  await page.getByTestId("name-prompt-input").fill("Iron Sword Renamed");
  await page.getByTestId("name-prompt-confirm").click();
  await openAssetFromBrowser(page, "assets/Mannequin.class.babasset");
  await readNode.getByText("Read ItemStats Data", { exact: true }).click();
  await expect(inlinePath).toContainText("Missing Entry (Weapons/Iron Sword)");
  await expect(defaultPath).toContainText("Missing Entry (Weapons/Iron Sword)");
  await selectPath(page, inlinePath, "Weapons/Iron Sword Renamed");
  await expect(readNode.getByRole("button", { name: /^\d+ errors?$/ })).toHaveCount(0);
  await saveAllIfEnabled(page);
});
