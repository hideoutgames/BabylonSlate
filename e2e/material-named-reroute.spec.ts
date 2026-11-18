import { expect, test, type Page } from "@playwright/test";
import { encodeAssetDocument } from "../packages/assets/src/asset-document";
import { MATERIAL_PAYLOAD_VERSION } from "../packages/assets/src/migration";
import { minimalProjectFiles } from "../packages/assets/src/test-support/minimal-project";
import { createDefaultMaterialDocument } from "../packages/shader-graph/src/document";
import { connectMaterialPins } from "./material-graph";
import { openMinimalTestProject } from "./minimal-project";
import { enableTapToConnect, openAssetFromBrowser } from "./open-test-project";

// Node headers are checked by eye in these shots, so they are taken at the iPad's pixel ratio.
test.use({ deviceScaleFactor: 2 });

/** Where the review screenshots go besides the test's own output, when the run names a folder. */
const SHOT_DIR = process.env.HAPTIC_E2E_SHOT_DIR;

async function shot(page: Page, name: string, testInfo: import("@playwright/test").TestInfo) {
  const graph = page.getByTestId("material-graph-editor");
  await graph.screenshot({ path: testInfo.outputPath(`${name}.png`), animations: "disabled" });
  if (SHOT_DIR) await graph.screenshot({ path: `${SHOT_DIR}/${name}.png`, animations: "disabled" });
}

async function addFromPalette(page: Page, search: string, item: string): Promise<void> {
  const graph = page.getByTestId("material-graph-editor");
  await graph.getByTestId("graph-add-node").click();
  await expect(page.getByTestId("node-palette")).toBeVisible();
  await page.getByTestId("node-palette-search").fill(search);
  await page.locator(`[data-testid^="node-palette-item-${item}"]`).first().click();
  await expect(page.getByTestId("node-palette")).toHaveCount(0);
}

test("a Named Reroute is created and named from Add Node, read through a usage found by its name, and reports a usage feeding itself", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  await enableTapToConnect(page);
  const files = await minimalProjectFiles();
  const material = createDefaultMaterialDocument("Routes");
  // Room on the left for the reroutes.
  material.nodes = material.nodes.map((node) => node.id === "baseColor" ? { ...node, position: { x: -700, y: 0 } } : node);
  files.set("assets/Routes.material.hasset", await encodeAssetDocument({
    guid: "00000000-0000-4000-8000-000000000041", type: "Material", name: "Routes",
    version: MATERIAL_PAYLOAD_VERSION, payload: material as unknown as Record<string, unknown>,
  }));
  await openMinimalTestProject(page, files);
  await openAssetFromBrowser(page, "assets/Routes.material.hasset");
  const graph = page.getByTestId("material-graph-editor");
  await expect(graph.locator('.react-flow__node[data-id="output"]')).toBeVisible({ timeout: 15_000 });

  // Create: the new declaration's title opens for its name.
  await addFromPalette(page, "Create Named Reroute", "reroute.declaration");
  const declaration = graph.locator('.react-flow__node[data-id^="reroute.declaration-"]');
  const rename = declaration.getByTestId("graph-node-rename");
  await expect(rename).toBeFocused();
  await expect(rename).toHaveValue("Reroute");
  await shot(page, "material-named-reroute-rename", testInfo);
  await rename.fill("Base Tint");
  await rename.press("Enter");
  await expect(declaration.locator("[data-node-title]")).toHaveText("Base Tint");

  // A usage is listed under the declaration's name and takes its title and header colour.
  await addFromPalette(page, "Base Tint", "reroute.usage:");
  const usage = graph.locator('.react-flow__node[data-id^="reroute.usage:"]');
  await expect(usage.locator("[data-node-title]")).toHaveText("Base Tint");
  const header = await declaration.locator("[data-node-title]").evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(await usage.locator("[data-node-title]").evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(header);

  // Color → declaration, usage → Base Color: the Material compiles cleanly.
  await connectMaterialPins(page, "baseColor", "out", '[data-id^="reroute.declaration-"]', "in");
  await connectMaterialPins(page, "reroute.usage:", "out", '[data-id="output"]', "baseColor");
  await expect(graph.locator(".react-flow__edge")).toHaveCount(2);
  await expect(graph.getByRole("button", { name: /\d+ Errors?/ })).toHaveCount(0);
  await shot(page, "material-named-reroute", testInfo);

  // A second usage wired into the declaration's own input reads itself.
  await addFromPalette(page, "Base Tint", "reroute.usage:");
  const usages = graph.locator('.react-flow__node[data-id^="reroute.usage:"]');
  await expect(usages).toHaveCount(2);
  const second = await usages.nth(1).getAttribute("data-id");
  await connectMaterialPins(page, second!, "out", '[data-id^="reroute.declaration-"]', "in");
  await expect(declaration.getByRole("button", { name: "1 Error" })).toBeVisible();
  await shot(page, "material-named-reroute-self-use", testInfo);
  const result = page.getByTestId("material-diagnostic-material.reroute.selfUse");
  if (!(await result.isVisible())) await page.locator(".dv-tab", { hasText: "Compiler Results" }).first().click();
  await expect(result).toContainText('Named Reroute "Base Tint" uses itself');
  // Choosing the result selects the declaration it names.
  await result.click();
  await expect(graph.locator('.react-flow__node.selected[data-id^="reroute.declaration-"]')).toHaveCount(1);
});
