import { expect, test, type Locator, type Page } from "@playwright/test";
import { encodeAssetDocument } from "../packages/assets/src/asset-document";
import { minimalProjectFiles } from "../packages/assets/src/test-support/minimal-project";
import { createDefaultTilesetPayload } from "../packages/assets/src/tileset-payload";
import { openMinimalTestProject } from "./minimal-project";
import { openContentBrowser, selectContentBrowserAssetsFolder } from "./open-test-project";

const TEXTURE_GUID = "00000000-0000-4000-8000-000000000030";
const TILESET_GUID = "00000000-0000-4000-8000-000000000031";
const TILEMAP_GUID = "00000000-0000-4000-8000-000000000032";
const TEXTURE_PATH = "assets/Sheet.hasset";
const TILESET_PATH = "assets/Ground.tileset.hasset";
const TILEMAP_PATH = "assets/Level.tilemap.hasset";

// A numeric solid-colour fixture, with no pictorial assets or generated artwork:
// a 32 × 16 sheet whose left tile is red and right tile blue.
async function redBluePng(page: Page): Promise<Uint8Array> {
  const bytes = await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 32;
    canvas.height = 16;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "rgb(255, 0, 0)";
    context.fillRect(0, 0, 16, 16);
    context.fillStyle = "rgb(0, 0, 255)";
    context.fillRect(16, 0, 16, 16);
    const blob = await new Promise<Blob>((resolve) => canvas.toBlob((value) => resolve(value!)));
    return [...new Uint8Array(await blob.arrayBuffer())];
  });
  return new Uint8Array(bytes);
}

/** The sheet, a Tileset of its two tiles, and a 2 × 1 Tilemap painting blue then red. */
async function tileProject(page: Page): Promise<Map<string, Uint8Array>> {
  const files = await minimalProjectFiles();
  const texture = { width: 32, height: 16, usage: "pixelArt", downsample: 1 };
  files.set(TEXTURE_PATH, await encodeAssetDocument(
    { guid: TEXTURE_GUID, type: "Texture", name: "Sheet", version: 1, payload: texture },
    { headerPayload: texture, extraChunks: [{ id: "pixels", kind: "pixels", mime: "image/png", data: await redBluePng(page) }] },
  ));
  files.set(TILESET_PATH, await encodeAssetDocument(
    {
      guid: TILESET_GUID, type: "Tileset", name: "Ground", version: 1,
      payload: { ...createDefaultTilesetPayload(), textureGuid: TEXTURE_GUID, atlasWidth: 32, atlasHeight: 16, tileWidth: 16, tileHeight: 16 },
    },
    { dependencies: [TEXTURE_GUID] },
  ));
  const tiles = new Array(16).fill(0);
  tiles[0] = 2;
  tiles[1] = 1;
  files.set(TILEMAP_PATH, await encodeAssetDocument(
    {
      guid: TILEMAP_GUID, type: "Tilemap", name: "Level", version: 1,
      payload: {
        tilesets: [{ guid: TILESET_GUID, firstGid: 1, tileCount: 2 }],
        tileWidth: 16, tileHeight: 16, chunkSize: 4, width: 2, height: 1,
        layers: [{
          id: "ground", name: "Ground", visible: true, collision: false, sortingLayer: "Default", orderInLayer: 0,
          parallax: { x: 1, y: 1 }, chunks: [{ cx: 0, cy: 0, tiles }],
        }],
      },
    },
    { dependencies: [TILESET_GUID] },
  ));
  return files;
}

/** The decoded thumbnail's size and the colour at the middle of its left and right halves. */
async function halves(image: Locator) {
  return image.evaluate(async (element: HTMLImageElement) => {
    await element.decode();
    const canvas = document.createElement("canvas");
    canvas.width = element.naturalWidth;
    canvas.height = element.naturalHeight;
    const context = canvas.getContext("2d")!;
    context.drawImage(element, 0, 0);
    const colour = (x: number) => {
      const [r, g, b] = context.getImageData(Math.floor(x), Math.floor(canvas.height / 2), 1, 1).data;
      return r! > 200 && g! < 60 && b! < 60 ? "red" : b! > 200 && r! < 60 && g! < 60 ? "blue" : `rgb(${r}, ${g}, ${b})`;
    };
    return { width: canvas.width, height: canvas.height, left: colour(canvas.width / 4), right: colour((canvas.width * 3) / 4) };
  });
}

const tile = (page: Page, path: string) => page.locator(`[data-asset-path="${path}"]`);

test("Content Browser draws a Tileset's sheet and a Tilemap's tiles, and a Tileset made from a Texture", async ({ page }) => {
  test.setTimeout(120_000);
  await openMinimalTestProject(page, await tileProject(page));
  await openContentBrowser(page);
  await selectContentBrowserAssetsFolder(page);
  // Opening a project draws nothing: thumbnails come from Save, Create and Generate Thumbnail.
  await expect(tile(page, TILESET_PATH)).toBeVisible();
  await expect(tile(page, TILESET_PATH).locator("img")).toHaveCount(0);

  await tile(page, TILESET_PATH).click();
  await tile(page, TILEMAP_PATH).click({ modifiers: ["ControlOrMeta"] });
  await tile(page, TILEMAP_PATH).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Generate Thumbnails", exact: true }).click();
  const tileset = tile(page, TILESET_PATH).locator("img");
  const tilemap = tile(page, TILEMAP_PATH).locator("img");
  await expect(tileset).toBeVisible({ timeout: 30_000 });
  await expect(tilemap).toBeVisible({ timeout: 30_000 });
  expect(await halves(tileset)).toEqual({ width: 128, height: 64, left: "red", right: "blue" });
  expect(await halves(tilemap)).toEqual({ width: 128, height: 64, left: "blue", right: "red" });

  await tile(page, TEXTURE_PATH).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Create Tileset", exact: true }).click();
  // The new Tileset opens in its own tab; come back once it has.
  await expect(page.locator('[data-testid="document-tab"][data-document-kind="tileset"]')).toBeVisible();
  await openContentBrowser(page);
  const created = page.locator(`[data-asset-path$=".tileset.hasset"]:not([data-asset-path="${TILESET_PATH}"]) img`);
  await expect(created).toBeVisible({ timeout: 30_000 });
  expect(await halves(created)).toEqual({ width: 128, height: 64, left: "red", right: "blue" });
});
