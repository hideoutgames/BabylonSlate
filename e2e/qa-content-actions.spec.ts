import { expect, test } from "@playwright/test";
import { createContentBrowserAsset, openAssetFromBrowser, openContentBrowser, openTestProject } from "./open-test-project";
import { saveAllIfEnabled } from "./save-all";

test("M29/L2/L5: multiword Add Node search inserts one node at a distinct position per activation", async ({ page }) => {
  await openTestProject(page);
  await openAssetFromBrowser(page, "assets/Mannequin.class.babasset");
  const nodes = page.locator('.react-flow__node[data-id^="literal.makeFloat-"]');
  for (let index = 0; index < 3; index++) {
    await page.getByTestId("graph-add-node").click();
    await page.getByTestId("node-palette-search").fill("Make Float");
    await page.getByTestId("node-palette-item-literal.makeFloat").click();
    await expect(page.getByTestId("node-palette")).toHaveCount(0);
    await expect(nodes).toHaveCount(index + 1);
  }
  expect(new Set(await nodes.evaluateAll((elements) => elements.map((node) => (node as HTMLElement).style.transform))).size).toBe(3);
  await saveAllIfEnabled(page);
  await page.reload();
  await openTestProject(page);
  await openAssetFromBrowser(page, "assets/Mannequin.class.babasset");
  await expect(nodes).toHaveCount(3);
  expect(new Set(await nodes.evaluateAll((elements) => elements.map((node) => (node as HTMLElement).style.transform))).size).toBe(3);
});

test("H18/L15: first Create retains Script Interface type and saved methods", async ({ page }) => {
  await openTestProject(page);
  await createContentBrowserAsset(page, "ScriptInterface", "QAPing");
  const asset = page.locator('[data-asset-path="assets/QAPing.babasset"]');
  await expect(asset).toContainText("ScriptInterface");
  const guid = await asset.getAttribute("data-asset-guid");
  await openAssetFromBrowser(page, "assets/QAPing.babasset");
  await expect(page.getByTestId("document-workspace-script-interface")).toBeVisible();
  await page.getByTestId("interface-add-method").click();
  await expect(page.getByTestId("interface-method-0")).toBeVisible();
  await saveAllIfEnabled(page);
  await page.reload();
  await openTestProject(page);
  await openAssetFromBrowser(page, "assets/QAPing.babasset");
  await expect(page.getByTestId("interface-method-0")).toBeVisible();
  await openContentBrowser(page);
  await expect(asset).toHaveAttribute("data-asset-guid", guid!);
});

test("H9/M20: plain click replaces multi-selection and Delete lists exactly that asset", async ({ page }) => {
  await openTestProject(page);
  await createContentBrowserAsset(page, "Enum", "QAAlpha");
  await createContentBrowserAsset(page, "Enum", "QABeta");
  const first = page.locator('[data-asset-path="assets/QAAlpha.babasset"]');
  const second = page.locator('[data-asset-path="assets/QABeta.babasset"]');
  await first.click();
  await second.click({ modifiers: ["Control"] });
  await expect(first).toHaveAttribute("data-selected", "true");
  await expect(second).toHaveAttribute("data-selected", "true");
  await first.click();
  await expect(second).toHaveAttribute("data-selected", "false");
  await page.getByTestId("content-browser-delete-selected").click();
  const list = page.getByTestId("content-browser-delete-list");
  await expect(list).toContainText("QAAlpha");
  await expect(list).not.toContainText("QABeta");
  await page.getByTestId("content-browser-delete-cancel").click();
  await expect(first).toBeVisible();
  await expect(second).toBeVisible();
});

test("H9: double-clicking an asset title or thumbnail opens its editor", async ({ page }) => {
  await openTestProject(page);
  await createContentBrowserAsset(page, "Enum", "QAOpen");
  const tile = page.locator('[data-asset-path="assets/QAOpen.babasset"]');
  await tile.getByText("QAOpen", { exact: true }).dblclick();
  await expect(page.getByTestId("document-workspace-enum")).toBeVisible();
  await openContentBrowser(page);
  await tile.locator("svg").first().dblclick();
  await expect(page.getByTestId("document-workspace-enum")).toBeVisible();
  await expect(page.locator('[data-testid="document-tab"][data-document-kind="enum"]')).toHaveCount(1);
});
