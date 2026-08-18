import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { IPAD_TEST_TAG } from "./ipad-tag";
import { openMainScene, submitCreateOrOpenListed } from "./open-test-project";
import { clickPlayAndWaitForOverlay } from "./play";

async function openTwoDProject(page: Page): Promise<void> {
  await page.goto("/?test=1");
  await expect(page.getByTestId("homepage")).toBeVisible();
  await page.getByTestId("create-project").click();
  await expect(page.getByTestId("create-project-dialog")).toBeVisible();
  await page.getByTestId("create-project-2d").click();
  await expect(page.getByTestId("create-project-2d")).toHaveAttribute(
    "data-selected",
    "true",
  );
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
  type: "Tileset" | "Tilemap" | "Sprite" | "AnimationGraph",
  name: string,
): Promise<void> {
  await showContentBrowser(page);
  await page.getByTestId("content-browser-new-asset").click();
  await expect(page.getByTestId("content-browser-new-asset-dialog")).toBeVisible();
  await page.getByTestId(`new-asset-type-${type}`).click();
  await page.getByTestId("new-asset-name").fill(name);
  await page.getByTestId("content-browser-new-asset-create").click();
  await expect(page.getByTestId("content-browser-new-asset-dialog")).toHaveCount(0);
}

async function guidForPath(page: Page, path: string): Promise<string> {
  return page.evaluate((assetPath) => {
    const host = globalThis as {
      __babylonslateTest?: { guidForPath: (path: string) => string | null };
    };
    return host.__babylonslateTest?.guidForPath(assetPath) ?? "";
  }, path);
}

async function tileAt(page: Page, gx: number, gy: number): Promise<number | null> {
  return page.evaluate(
    ([x, y]) => {
      const host = globalThis as {
        __babylonslateTest?: {
          activeTilemapTile: (gx: number, gy: number) => number | null;
        };
      };
      return host.__babylonslateTest?.activeTilemapTile(x, y) ?? null;
    },
    [gx, gy] as const,
  );
}

async function pickSelectedAsset(
  page: Page,
  classId: string,
  guid: string,
  property: "assetGuid" | "graphGuid" = "assetGuid",
) {
  const card = page.locator("[data-testid^='component-card-']").filter({
    hasText: classId,
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

test.describe("P10 tilemaps", () => {
  test("2D project paints tiles, plays an animated sprite, and reports physics", {
    tag: IPAD_TEST_TAG,
  }, async ({ page }) => {
    test.setTimeout(180_000);
    await openTwoDProject(page);

    await showContentBrowser(page);
    await page
      .getByTestId("content-browser-import-input")
      .setInputFiles([path.join(process.cwd(), "e2e/fixtures/albedo.png")]);
    await expect(
      page.locator('[data-asset-path="assets/albedo.babasset"]'),
    ).toBeVisible({ timeout: 15_000 });

    await createAsset(page, "Tileset", "Ground");
    await page.locator('[data-asset-path="assets/Ground.tileset.babasset"]').dblclick();
    await expect(page.getByTestId("document-workspace-tileset")).toBeVisible();
    await expect(page.getByTestId("tileset-preview")).toBeVisible();
    await expect(page.getByTestId("tileset-editor")).toBeVisible();
    await page.getByTestId("property-texture").click();
    const textureGuid = await guidForPath(page, "assets/albedo.babasset");
    expect(textureGuid.length).toBeGreaterThan(0);
    await expect(page.getByTestId(`search-item-${textureGuid}`)).toBeVisible();
    await page.getByTestId(`search-item-${textureGuid}`).click();
    await expect(page.getByTestId("tileset-preview-cell-1")).toBeVisible();
    await page.getByTestId("tileset-preview-cell-1").click();
    await page.getByTestId("tileset-collision-full").click();
    await page
      .locator('[data-testid="document-tab"][data-document-kind="tileset"] [data-testid="document-tab-close"]')
      .click();
    await expect(page.getByTestId("document-workspace-tileset")).toHaveCount(0);

    await createAsset(page, "Tilemap", "Overworld");
    await page
      .locator('[data-asset-path="assets/Overworld.tilemap.babasset"]')
      .dblclick();
    await expect(page.getByTestId("document-workspace-tilemap")).toBeVisible();
    await expect(page.getByTestId("tilemap-details")).toBeVisible();
    await expect(page.getByTestId("tilemap-editor")).toBeVisible();
    await expect(page.getByTestId("tilemap-palette")).toBeVisible();
    await page.getByTestId("tilemap-tilesets-add").click();
    const tilesetGuid = await guidForPath(page, "assets/Ground.tileset.babasset");
    expect(tilesetGuid.length).toBeGreaterThan(0);
    await expect(page.getByTestId(`search-item-${tilesetGuid}`)).toBeVisible();
    await page.getByTestId(`search-item-${tilesetGuid}`).click();
    await expect(page.getByTestId("tilemap-palette-tile-1")).toBeVisible();
    await page.getByTestId("tilemap-palette-tile-1").click();

    const canvas = page.getByTestId("tilemap-paint-canvas");
    await expect(canvas).toBeVisible();
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
    await page.locator('[data-asset-path="assets/Hero.sprite.babasset"]').dblclick();
    await expect(page.getByTestId("sprite-editor")).toBeVisible();
    await expect(page.getByTestId("property-clip-name")).toHaveValue("Idle");
    await createAsset(page, "AnimationGraph", "Loco");

    await showContentBrowser(page);
    await openMainScene(page);
    await expect(page.getByTestId("viewport-mode-2d")).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await page.getByTestId("outliner-add-actor").click();
    await expect(page.getByTestId("place-actors-catalog")).toBeVisible();
    await page.getByTestId("place-actors-item-empty").click();
    await page.getByTestId("details-add-component").click();
    await page.getByTestId("add-component-catalog-item-TilemapComponent").click();
    const tilemapGuid = await guidForPath(
      page,
      "assets/Overworld.tilemap.babasset",
    );
    await pickSelectedAsset(page, "TilemapComponent", tilemapGuid);

    await page.getByTestId("outliner-add-actor").click();
    await expect(page.getByTestId("place-actors-catalog")).toBeVisible();
    await page.getByTestId("place-actors-item-empty").click();
    await page.getByTestId("details-add-component").click();
    await page.getByTestId("add-component-catalog-item-SpriteComponent").click();
    await page.getByTestId("details-add-component").click();
    await page.getByTestId("add-component-catalog-item-AnimationGraphComponent").click();
    await page.getByTestId("details-add-component").click();
    await page.getByTestId("add-component-catalog-item-RigidBodyComponent").click();
    await page.getByTestId("details-add-component").click();
    await page.getByTestId("add-component-catalog-item-ColliderComponent").click();

    const spriteGuid = await guidForPath(page, "assets/Hero.sprite.babasset");
    await pickSelectedAsset(page, "SpriteComponent", spriteGuid);
    const graphGuid = await guidForPath(page, "assets/Loco.anim.babasset");
    await pickSelectedAsset(
      page,
      "AnimationGraphComponent",
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
