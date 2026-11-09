import path from "node:path";
import { expect, type Page } from "@playwright/test";
import {
  openContentBrowser,
  selectContentBrowserAssetsFolder,
} from "./open-test-project";

export async function guidForPath(
  page: Page,
  assetPath: string,
): Promise<string> {
  return page.evaluate((path) => {
    const host = globalThis as {
      __hapticTest?: { guidForPath: (path: string) => string | null };
    };
    return host.__hapticTest?.guidForPath(path) ?? "";
  }, assetPath);
}

export async function addMaterialPaletteNode(
  page: Page,
  search: string,
  itemId: string,
): Promise<void> {
  const graph = page.getByTestId("material-graph-editor");
  await expect(graph).toBeVisible();
  // Toolbar Add node: default Color / Output shells can cover pane-center
  // double-tap after the wider Blueprint min-width.
  await graph.getByTestId("graph-add-node").click();
  await expect(page.getByTestId("node-palette")).toBeVisible();
  await page.getByTestId("node-palette-search").fill(search);
  await page.getByTestId(`node-palette-item-${itemId}`).click();
  await expect(page.getByTestId("node-palette")).toHaveCount(0);
  await graph.locator(`.react-flow__node[data-id^="${itemId}-"]`).click();
  // A new Parameter node gets a free name on its own: Parameter, Parameter_1…
  if (itemId.startsWith("param.")) {
    await expect(page.getByTestId("property-name")).toHaveValue(
      /^Parameter(_\d+)?$/,
    );
  }
}

/** Imports `e2e/fixtures/albedo.png`, a 1×1 pure red. */
export async function importAlbedoTexture(page: Page): Promise<string> {
  const assetPath = "assets/albedo.hasset";
  await openContentBrowser(page);
  await selectContentBrowserAssetsFolder(page);
  await page
    .getByTestId("content-browser-import-input")
    .setInputFiles([path.join(process.cwd(), "e2e/fixtures/albedo.png")]);
  await expect(page.locator(`[data-asset-path="${assetPath}"]`)).toBeVisible({
    timeout: 15_000,
  });
  const albedoGuid = await guidForPath(page, assetPath);
  expect(albedoGuid.length).toBeGreaterThan(0);
  return albedoGuid;
}

export async function pickMaterialNodeTexture(
  page: Page,
  guid: string,
): Promise<void> {
  await expect(page.getByTestId("material-details-panel")).toBeVisible();
  await page.getByTestId("material-node-texture").click();
  await expect(page.getByTestId("material-node-texture-picker")).toBeVisible();
  await page.getByTestId(`search-item-${guid}`).click();
  await expect(page.getByTestId("material-node-texture-picker")).toHaveCount(0);
  await expect(page.getByTestId("material-node-texture")).toContainText(
    /albedo/i,
  );
}

/** Taps the source pin, then the target pin; the spec turns on `enableTapToConnect` before loading. */
export async function connectMaterialPins(
  page: Page,
  sourcePrefix: string,
  sourcePin: string,
  targetSelector: string,
  targetPin: string,
): Promise<void> {
  const graph = page.getByTestId("material-graph-editor");
  const source = graph.locator(
    `.react-flow__node[data-id^="${sourcePrefix}"] [data-handleid="${sourcePin}"][data-handlepos="right"]`,
  );
  const target = graph.locator(
    `.react-flow__node${targetSelector} [data-handleid="${targetPin}"][data-handlepos="left"]`,
  );
  await source.click({ force: true });
  await target.click({ force: true });
}

export async function compileMaterialPreview(page: Page): Promise<void> {
  const canvas = page.getByTestId("material-preview-canvas");
  const render = page.getByTestId("material-render");
  // Force a compile of the wired graph. Auto-compile may already be in
  // flight (Render disabled); wait it out, then click.
  await expect(render).toBeEnabled({ timeout: 15_000 });
  await render.click();
  await expect(canvas).toHaveAttribute("data-status", "ready", {
    timeout: 15_000,
  });
}
