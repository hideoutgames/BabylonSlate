import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { IPAD_TEST_TAG } from "./ipad-tag";
import { openMainScene, submitCreateOrOpenListed } from "./open-test-project";
import { clickPlayAndWaitForOverlay } from "./play";
import { pickCatalogItem } from "./pick-catalog-item";
import { saveAllIfEnabled } from "./save-all";
import { guidForPath } from "./material-graph";

async function openTwoDProject(page: Page): Promise<void> {
  await page.goto("/?test=1");
  await expect(page.getByTestId("homepage")).toBeVisible();
  await page.getByTestId("create-project").click();
  await expect(page.getByTestId("create-project-dialog")).toBeVisible();
  await page.getByTestId("create-project-2d").click();
  await expect(page.getByTestId("create-project-details")).toBeVisible();
  await submitCreateOrOpenListed(page);
  await expect(page.getByTestId("editor-chrome-bar")).toBeVisible();
}

async function showContentBrowser(page: Page): Promise<void> {
  await page
    .locator('[data-testid="document-tab"][data-document-kind="content-browser"]')
    .click();
  await expect(page.getByTestId("document-workspace-content-browser")).toBeVisible();
}

async function createAsset(
  page: Page,
  type: "Tileset" | "Tilemap" | "Sprite" | "AnimationGraph2D",
  name: string,
): Promise<void> {
  await showContentBrowser(page);
  await page.getByTestId("content-browser-new-asset").click();
  await expect(page.getByTestId("new-asset-type-menu")).toBeVisible();
  await page.getByTestId(`search-item-${type}`).click();
  await page.getByTestId("new-asset-name").fill(name);
  await page.getByTestId("content-browser-new-asset-create").click();
  await expect(page.getByTestId("content-browser-new-asset-dialog")).toHaveCount(0);
}

async function tileAt(page: Page, gx: number, gy: number): Promise<number | null> {
  return page.evaluate(
    ([x, y]) => {
      const host = globalThis as {
        __hapticTest?: {
          activeTilemapTile: (gx: number, gy: number) => number | null;
        };
      };
      return host.__hapticTest?.activeTilemapTile(x, y) ?? null;
    },
    [gx, gy] as const,
  );
}

async function pickSelectedAsset(
  page: Page,
  componentName: string,
  guid: string,
  property: "assetGuid" | "graphGuid" = "assetGuid",
) {
  const card = page.locator("[data-testid^='component-card-']").filter({
    has: page.getByRole("button", { name: new RegExp(`^${componentName}(?: \\(|$)`) }),
  });
  await expect(card).toBeVisible();
  await card.locator(`button[data-testid$="-${property}"]`).click();
  const picker = page.getByTestId("details-asset-picker");
  await expect(picker).toBeVisible();
  const item = page.getByTestId(`search-item-${guid}`);
  await expect(item).toBeVisible();
  await item.click();
  await expect(picker).toBeHidden();
}

async function pinchPaintCanvas(
  canvas: ReturnType<Page["getByTestId"]>,
  fromSpread: number,
  toSpread: number,
): Promise<void> {
  await canvas.evaluate(
    (node, spreads) => {
      const box = node.getBoundingClientRect();
      const cx = box.left + box.width / 2;
      const cy = box.top + box.height / 2;
      const fire = (
        type: string,
        pointerId: number,
        x: number,
        y: number,
      ) => {
        node.dispatchEvent(
          new PointerEvent(type, {
            pointerId,
            pointerType: "touch",
            clientX: x,
            clientY: y,
            bubbles: true,
            cancelable: true,
          }),
        );
      };
      fire("pointerdown", 1, cx - spreads.from, cy);
      fire("pointerdown", 2, cx + spreads.from, cy);
      fire("pointermove", 1, cx - spreads.to, cy);
      fire("pointermove", 2, cx + spreads.to, cy);
      fire("pointerup", 1, cx - spreads.to, cy);
      fire("pointerup", 2, cx + spreads.to, cy);
    },
    { from: fromSpread, to: toSpread },
  );
}

/**
 * Touch pointer events on the Paint canvas at map cells (32 px cells unless
 * zoomed; cell 0, 0 at the bottom-left of a bounded map's unpanned view), one
 * event per step so React renders between them.
 */
async function touchPaintCanvas(
  canvas: ReturnType<Page["getByTestId"]>,
  steps: ReadonlyArray<readonly ["pointerdown" | "pointermove" | "pointerup", number, number, number]>,
): Promise<void> {
  const cell = Number(await canvas.getAttribute("data-cell-size"));
  for (const [type, pointerId, x, y] of steps) {
    await canvas.evaluate(
      (node, event) => {
        const box = node.getBoundingClientRect();
        node.dispatchEvent(new PointerEvent(event.type, {
          pointerId: event.pointerId,
          pointerType: "touch",
          isPrimary: event.pointerId === 1,
          clientX: box.left + (event.x + 0.5) * event.cell,
          clientY: box.bottom - (event.y + 0.5) * event.cell,
          bubbles: true,
          cancelable: true,
        }));
      },
      { type, pointerId, x, y, cell },
    );
  }
}

/** A 2D project with a Tileset of the albedo fixture and an open Tilemap painting with its first tile. */
async function openPaintableTilemap(page: Page, name: string): Promise<void> {
  await openTwoDProject(page);
  await showContentBrowser(page);
  await page
    .getByTestId("content-browser-import-input")
    .setInputFiles([path.join(process.cwd(), "e2e/fixtures/albedo.png")]);
  await expect(page.locator('[data-asset-path="assets/albedo.hasset"]')).toBeVisible({ timeout: 15_000 });
  await createAsset(page, "Tileset", "Ground");
  await page.locator('[data-asset-path="assets/Ground.tileset.hasset"]').dblclick();
  await expect(page.getByTestId("tileset-editor")).toBeVisible();
  await page.getByTestId("property-texture").click();
  await page.getByTestId(`search-item-${await guidForPath(page, "assets/albedo.hasset")}`).click();
  await expect(page.getByTestId("property-texture-open")).toBeVisible();
  await saveAllIfEnabled(page);
  await page.locator('[data-testid="document-tab"][data-document-kind="tileset"]').getByTestId("document-tab-close").click();
  await createAsset(page, "Tilemap", name);
  await page.locator(`[data-asset-path="assets/${name}.tilemap.hasset"]`).dblclick();
  await expect(page.getByTestId("tilemap-details")).toBeVisible();
  await page.getByTestId("tilemap-tilesets-add").click();
  await page.getByTestId(`search-item-${await guidForPath(page, "assets/Ground.tileset.hasset")}`).click();
  await page.getByTestId("tilemap-palette-tile-1").click();
}

test.describe("P10 tilemaps", () => {
  test("an unbounded Tilemap opens on its pivot, paints left of and below it, and moves the pivot with one drag", async ({ page }) => {
    test.setTimeout(120_000);
    await openPaintableTilemap(page, "Island");
    await page.getByTestId("property-unbounded").click();
    await expect(page.getByTestId("property-vector3-pivot")).toBeVisible();
    await expect(page.getByTestId("property-mapWidth")).toHaveCount(0);
    await expect(page.getByTestId("property-paintedArea")).toHaveText("None");

    // The view puts the pivot, map point 0, 0, at the centre of the laid-out canvas.
    const canvas = page.getByTestId("tilemap-paint-canvas");
    const box = (await canvas.boundingBox())!;
    const cell = Number(await canvas.getAttribute("data-cell-size"));
    await expect.poll(async () => Number(await canvas.getAttribute("data-pan-x"))).toBeCloseTo(box.width / 2, 0);
    await expect.poll(async () => Number(await canvas.getAttribute("data-pan-y"))).toBeCloseTo(box.height / 2, 0);

    // Cell -1, -1 lies left of and below the pivot.
    await page.getByTestId("tilemap-tool-brush").click();
    await canvas.click({ position: { x: box.width / 2 - cell / 2, y: box.height / 2 + cell / 2 } });
    await expect.poll(async () => tileAt(page, -1, -1)).toBe(1);
    await expect(page.getByTestId("property-paintedArea")).toHaveText("1 × 1");

    // A mouse drag from the marker two cells right moves the pivot without painting, in one undo step.
    const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    await page.mouse.move(centre.x, centre.y);
    await page.mouse.down();
    await page.mouse.move(centre.x + cell, centre.y, { steps: 4 });
    await page.mouse.move(centre.x + 2 * cell, centre.y, { steps: 4 });
    await page.mouse.up();
    await expect(page.getByTestId("property-pivot-x")).toHaveValue("2");
    expect(await tileAt(page, 0, 0)).toBe(0);
    expect(await tileAt(page, 1, 0)).toBe(0);
    await page.getByTestId("undo-document").click();
    await expect(page.getByTestId("property-pivot-x")).toHaveValue("0");
    expect(await tileAt(page, -1, -1)).toBe(1);
  });


  test("the Select tool moves painted tiles with one finger in one undo step, and a second finger cancels the drag", {
    tag: IPAD_TEST_TAG,
  }, async ({ page }) => {
    test.setTimeout(120_000);
    await openPaintableTilemap(page, "Moved");
    const canvas = page.getByTestId("tilemap-paint-canvas");
    await page.getByTestId("tilemap-tool-brush").click();
    for (const x of [0, 1]) await touchPaintCanvas(canvas, [["pointerdown", 1, x, 0], ["pointerup", 1, x, 0]]);
    await expect.poll(async () => tileAt(page, 1, 0)).toBe(1);

    // One finger drags a rectangle over both tiles.
    await page.getByTestId("tilemap-tool-select").click();
    await expect(canvas).toHaveAttribute("data-tool", "select");
    await touchPaintCanvas(canvas, [["pointerdown", 1, 0, 0], ["pointermove", 1, 1, 0], ["pointerup", 1, 1, 0]]);
    await expect(page.getByTestId("tilemap-select-size")).toHaveText("2 × 1");

    // A second finger landing mid-drag drops it: nothing moves.
    await touchPaintCanvas(canvas, [["pointerdown", 1, 0, 0], ["pointermove", 1, 2, 2], ["pointerdown", 2, 6, 6], ["pointerup", 1, 2, 2], ["pointerup", 2, 6, 6]]);
    expect(await tileAt(page, 0, 0)).toBe(1);
    expect(await tileAt(page, 2, 2)).toBe(0);

    // A drag from inside the selection moves its tiles when the finger lifts.
    await touchPaintCanvas(canvas, [["pointerdown", 1, 0, 0], ["pointermove", 1, 1, 1], ["pointermove", 1, 3, 2], ["pointerup", 1, 3, 2]]);
    await expect.poll(async () => tileAt(page, 3, 2)).toBe(1);
    expect(await tileAt(page, 4, 2)).toBe(1);
    expect(await tileAt(page, 0, 0)).toBe(0);
    await expect(page.getByTestId("tilemap-select-size")).toHaveText("2 × 1");

    // One undo step puts them back.
    await page.getByTestId("undo-document").click();
    await expect.poll(async () => tileAt(page, 0, 0)).toBe(1);
    expect(await tileAt(page, 1, 0)).toBe(1);
    expect(await tileAt(page, 3, 2)).toBe(0);
  });

  // Sprite Animation frame playback is unit-covered (packages/render/src/anim-apply.test.ts).
  test("2D project paints tiles, binds a sprite and animation graph, and reports physics", {
    tag: IPAD_TEST_TAG,
  }, async ({ page }) => {
    test.setTimeout(180_000);
    await openTwoDProject(page);

    await showContentBrowser(page);
    await page
      .getByTestId("content-browser-import-input")
      .setInputFiles([path.join(process.cwd(), "e2e/fixtures/albedo.png")]);
    await expect(
      page.locator('[data-asset-path="assets/albedo.hasset"]'),
    ).toBeVisible({ timeout: 15_000 });

    await createAsset(page, "Tileset", "Ground");
    await page.locator('[data-asset-path="assets/Ground.tileset.hasset"]').dblclick();
    await expect(page.getByTestId("document-workspace-tileset")).toBeVisible();
    await expect(page.getByTestId("tileset-preview")).toBeVisible();
    await expect(page.getByTestId("tileset-editor")).toBeVisible();
    await expect(page.getByTestId("property-texture-open")).toHaveCount(0);
    await page.getByTestId("property-texture").click();
    const textureGuid = await guidForPath(page, "assets/albedo.hasset");
    expect(textureGuid.length).toBeGreaterThan(0);
    await expect(page.getByTestId(`search-item-${textureGuid}`)).toBeVisible();
    await page.getByTestId(`search-item-${textureGuid}`).click();
    await expect(page.getByTestId("property-texture-open")).toBeVisible();
    const pickerBox = await page.getByTestId("property-texture").boundingBox();
    const openBox = await page.getByTestId("property-texture-open").boundingBox();
    expect(pickerBox).toBeTruthy();
    expect(openBox).toBeTruthy();
    expect(Math.abs((openBox?.width ?? 0) - (openBox?.height ?? 0))).toBeLessThan(2);
    expect(Math.abs((openBox?.height ?? 0) - (pickerBox?.height ?? 0))).toBeLessThan(2);
    await page.getByTestId("property-texture-open").click();
    await expect(
      page.locator(
        '[data-testid="document-tab"][data-document-kind="texture"]',
      ),
    ).toBeVisible();
    await page
      .locator('[data-testid="document-tab"][data-document-kind="tileset"]')
      .click();
    await expect(page.getByTestId("tileset-preview-cell-1")).toBeVisible();
    await expect(page.locator('[data-testid^="tileset-preview-cell-"]')).toHaveCount(
      1,
    );
    await page.getByTestId("tileset-preview-cell-1").click();
    await page.getByTestId("tileset-collision-full").click();
    await saveAllIfEnabled(page);
    await page
      .locator('[data-testid="document-tab"][data-document-kind="tileset"]')
      .getByTestId("document-tab-close")
      .click();
    await expect(page.getByTestId("dirty-close-dialog")).toHaveCount(0);
    await expect(page.getByTestId("document-workspace-tileset")).toHaveCount(0);

    await createAsset(page, "Tilemap", "Overworld");
    await page
      .locator('[data-asset-path="assets/Overworld.tilemap.hasset"]')
      .dblclick();
    await expect(page.getByTestId("document-workspace-tilemap")).toBeVisible();
    await expect(page.getByTestId("tilemap-details")).toBeVisible();
    await expect(page.getByTestId("tilemap-editor")).toBeVisible();
    await expect(page.getByTestId("tilemap-palette")).toBeVisible();
    await page.getByTestId("tilemap-tilesets-add").click();
    const tilesetGuid = await guidForPath(page, "assets/Ground.tileset.hasset");
    expect(tilesetGuid.length).toBeGreaterThan(0);
    await expect(page.getByTestId(`search-item-${tilesetGuid}`)).toBeVisible();
    await page.getByTestId(`search-item-${tilesetGuid}`).click();
    await expect(page.getByTestId("tilemap-palette-tile-1")).toBeVisible();
    const paletteSearch = page.getByTestId("tilemap-palette-search");
    await paletteSearch.fill("Tile 1");
    const searchBounds = await paletteSearch.boundingBox();
    const clearBounds = await page.getByTestId("tilemap-palette-search-clear").boundingBox();
    const paletteBounds = await page.getByTestId("tilemap-palette").boundingBox();
    expect(searchBounds).toBeTruthy();
    expect(clearBounds).toBeTruthy();
    expect(paletteBounds).toBeTruthy();
    expect(clearBounds!.y + clearBounds!.height / 2).toBeGreaterThanOrEqual(searchBounds!.y);
    expect(clearBounds!.y + clearBounds!.height / 2).toBeLessThanOrEqual(searchBounds!.y + searchBounds!.height);
    const tileBounds = await page.getByTestId("tilemap-palette-tile-1").boundingBox();
    expect(tileBounds!.y - paletteBounds!.y).toBeLessThan(110);
    await page.getByTestId("tilemap-palette-search-clear").click();
    await expect(paletteSearch).toHaveValue("");
    await page.getByTestId("tilemap-palette-tile-1").click();

    const canvas = page.getByTestId("tilemap-paint-canvas");
    await expect(canvas).toBeVisible();
    await expect(canvas).toHaveAttribute("data-tool", "move");
    await page.getByTestId("tilemap-tool-brush").click();
    await expect(canvas).toHaveAttribute("data-tool", "brush");
    await expect(canvas).toHaveAttribute("data-gid", "1");
    await expect
      .poll(async () => canvas.getAttribute("data-paint-source"), { timeout: 15_000 })
      .toBe("atlas");
    const cellSize = Number(await canvas.getAttribute("data-cell-size"));
    expect(cellSize).toBeGreaterThan(0);
    const box = await canvas.boundingBox();
    expect(box).toBeTruthy();
    for (let i = 0; i < 8; i++) {
      await canvas.click({
        position: {
          x: i * cellSize + cellSize / 2,
          y: (box?.height ?? 0) - cellSize / 2,
        },
      });
    }
    await expect.poll(async () => tileAt(page, 0, 0)).toBe(1);
    await expect.poll(async () => tileAt(page, 7, 0)).toBe(1);

    const sizeBefore = Number(await canvas.getAttribute("data-cell-size"));
    await pinchPaintCanvas(canvas, 40, 80);
    await expect
      .poll(async () => Number(await canvas.getAttribute("data-cell-size")))
      .not.toBe(sizeBefore);

    await createAsset(page, "Sprite", "Hero");
    await page.locator('[data-asset-path="assets/Hero.sprite.hasset"]').dblclick();
    await expect(page.getByTestId("sprite-editor")).toBeVisible();
    await createAsset(page, "AnimationGraph2D", "Loco");

    await showContentBrowser(page);
    await openMainScene(page);
    await expect(page.getByTestId("viewport-mode-2d")).toHaveAttribute("data-active", "true");

    await page.getByTestId("outliner-add-actor").click();
    await expect(page.getByTestId("place-actors-catalog")).toBeVisible();
    await page.getByTestId("place-actors-catalog-category-Rendering").click();
    await page.getByTestId("place-actors-item-tilemap").click();
    const tilemapGuid = await guidForPath(
      page,
      "assets/Overworld.tilemap.hasset",
    );
    await pickSelectedAsset(page, "Tilemap", tilemapGuid);

    await page.getByTestId("outliner-add-actor").click();
    await expect(page.getByTestId("place-actors-catalog")).toBeVisible();
    // Place Actors reopens on the category it was left in (Rendering).
    await page.getByTestId("place-actors-catalog-category-Empty").click();
    await page.getByTestId("place-actors-item-empty").click();
    await page.getByTestId("details-add-component").click();
    await pickCatalogItem(page, "add-component-catalog", "SpriteComponent", "2D sprite quad");
    await page.getByTestId("details-add-component").click();
    await pickCatalogItem(page, "add-component-catalog", "AnimationGraphComponent", "Animation Graph");
    await page.getByTestId("details-add-component").click();
    await pickCatalogItem(page, "add-component-catalog", "RigidBodyComponent", "Rigid Body");
    await page.getByTestId("details-add-component").click();
    await pickCatalogItem(page, "add-component-catalog", "ColliderComponent", "Physics collider");

    const spriteGuid = await guidForPath(page, "assets/Hero.sprite.hasset");
    await pickSelectedAsset(page, "Sprite", spriteGuid);
    const graphGuid = await guidForPath(page, "assets/Loco.anim2d.hasset");
    await pickSelectedAsset(
      page,
      "Animation Graph",
      graphGuid,
      "graphGuid",
    );
    // Place Actors spawns at the view center, so put the hero over the painted
    // tiles explicitly before dropping it.
    await page.getByTestId("property-actor-position-x").fill("0");
    await page.getByTestId("property-actor-position-y").fill("3");

    await clickPlayAndWaitForOverlay(page);
    await page.getByTestId("play-stats-toggle").click();
    await expect
      .poll(async () => {
        const attr = await page
          .getByTestId("play-physics-ms")
          .getAttribute("data-ms");
        return Number(attr ?? "0");
      }, { timeout: 15_000 })
      .toBeGreaterThan(0);
    await expect
      .poll(async () => {
        const fps = await page.getByTestId("play-fps").getAttribute("data-fps");
        return Number(fps ?? "0");
      }, { timeout: 15_000 })
      .toBeGreaterThan(0);
    await expect
      .poll(async () => {
        const ys = (await page.getByTestId("play-actor-y").getAttribute("data-ys")) ?? "";
        return ys
          .split(",")
          .map((value) => Number(value))
          .some((y) => Number.isFinite(y) && y > 0.2 && y < 2.5);
      }, { timeout: 15_000 })
      .toBe(true);
    await page.getByTestId("play-overlay-close").click();
  });
});
