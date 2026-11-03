import { expect, test, type Page } from "@playwright/test";
import { encodeAssetDocument } from "../packages/assets/src/asset-document";
import { minimalProjectFiles } from "../packages/assets/src/test-support/minimal-project";
import { createDefaultTilesetPayload } from "../packages/assets/src/tileset-payload";
import { openMinimalTestProject } from "./minimal-project";
import { enableTouchLayout, openAssetFromBrowser } from "./open-test-project";

const TEXTURE_GUID = "00000000-0000-4000-8000-000000000020";
const TILESET_GUID = "00000000-0000-4000-8000-000000000021";

const N = 1;
const E = 4;
const S = 16;
const W = 64;

// A numeric solid-colour fixture, with no pictorial assets or generated artwork.
async function greyPng(page: Page, size: number): Promise<Uint8Array> {
  const bytes = await page.evaluate(async (size) => {
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "rgb(120, 120, 120)";
    context.fillRect(0, 0, size, size);
    const blob = await new Promise<Blob>((resolve) => canvas.toBlob((value) => resolve(value!)));
    return [...new Uint8Array(await blob.arrayBuffer())];
  }, size);
  return new Uint8Array(bytes);
}

/** A 4 × 4 sheet of 16 px tiles with one 4 Sides autotile and no pieces yet. */
async function autotileProject(page: Page): Promise<Map<string, Uint8Array>> {
  const files = await minimalProjectFiles();
  const pixels = await greyPng(page, 64);
  const texture = { width: 64, height: 64, usage: "pixelArt", downsample: 1, compressionState: "fallback_uncompressed" };
  files.set("assets/sheet.hasset", await encodeAssetDocument(
    { guid: TEXTURE_GUID, type: "Texture", name: "Sheet", version: 1, payload: texture },
    { headerPayload: texture, extraChunks: [{ id: "pixels", kind: "pixels", mime: "image/png", data: pixels }] },
  ));
  files.set("assets/ground.tileset.hasset", await encodeAssetDocument(
    {
      guid: TILESET_GUID,
      type: "Tileset",
      name: "Ground",
      version: 1,
      payload: {
        ...createDefaultTilesetPayload(),
        textureGuid: TEXTURE_GUID,
        atlasWidth: 64,
        atlasHeight: 64,
        tileWidth: 16,
        tileHeight: 16,
        terrains: [{ id: "ground", name: "Ground", style: "sides" }],
      },
    },
    { dependencies: [TEXTURE_GUID] },
  ));
  return files;
}

test.describe("Tileset Autotiles window on touch", () => {
  test.use({ hasTouch: true, viewport: { width: 1194, height: 834 } });
  test.beforeEach(({ page }) => enableTouchLayout(page));

  // iOS holds back the click of a tap that reveals content on hover; every control here must act on its first tap.
  test("selects a piece, assigns a sheet tile, clears it and paints the preview, one tap each", async ({ page }) => {
    await openMinimalTestProject(page, await autotileProject(page));
    await openAssetFromBrowser(page, "assets/ground.tileset.hasset");
    await page.getByTestId("tileset-edit-autotiles").tap();
    await expect(page.getByTestId("tileset-autotiles")).toBeVisible();
    await expect(page.getByTestId("tileset-autotiles-sheet-empty")).toHaveCount(0);
    const slot = (mask: number) => page.getByTestId(`tileset-autotiles-slot-${mask}`);

    await slot(S | W).tap();
    await expect(slot(S | W)).toHaveAttribute("aria-pressed", "true");
    // Touch-layout pieces keep a 44 px target.
    expect((await slot(S | W).boundingBox())!.height).toBeGreaterThanOrEqual(44);

    await page.getByTestId("tileset-autotiles-sheet-cell-6").tap();
    await expect(slot(S | W)).toHaveAttribute("data-tile-id", "6");
    // The selection moves on to the next empty piece.
    await expect(slot(S)).toHaveAttribute("aria-pressed", "true");

    await slot(S | W).tap();
    await page.getByTestId(`tileset-autotiles-slot-${S | W}-clear`).tap();
    await expect(slot(S | W)).not.toHaveAttribute("data-tile-id");

    // The sample's top strip starts at column 2; a tap left of it paints, a second tap erases.
    const cell = page.getByTestId("tileset-autotiles-preview-cell-1-5");
    await cell.tap();
    await expect(cell).toHaveAttribute("data-terrain", "ground");
    await cell.tap();
    await expect(cell).not.toHaveAttribute("data-terrain");
    await expect(slot(N | E | S | W)).toBeVisible();
  });
});
