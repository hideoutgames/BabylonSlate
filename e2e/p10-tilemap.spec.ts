import { expect, test, type Page } from "@playwright/test";
import { IPAD_TEST_TAG } from "./ipad-tag";

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
  await page.getByTestId("create-project-submit").click();
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
  await page.getByTestId("new-asset-type").click();
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

async function openMainScene(page: Page): Promise<void> {
  await page.locator('[data-asset-path="assets/main.scene.babasset"]').dblclick();
  await expect(page.getByTestId("document-workspace-scene")).toBeVisible();
  await expect(
    page.getByTestId("document-workspace-scene").locator("canvas"),
  ).toBeVisible({ timeout: 15_000 });
}

async function fillSelectedAssetGuid(page: Page, classId: string, guid: string) {
  const card = page.locator("[data-testid^='component-card-']").filter({
    hasText: classId,
  });
  await expect(card).toBeVisible();
  await card.getByLabel("Asset GUID").fill(guid);
}

test.describe("P10 tilemaps", () => {
  test("2D project paints tiles, plays an animated sprite, and reports physics", {
    tag: IPAD_TEST_TAG,
  }, async ({ page }) => {
    await openTwoDProject(page);

    await createAsset(page, "Tileset", "Ground");
    await page.locator('[data-asset-path="assets/Ground.tileset.babasset"]').dblclick();
    await expect(page.getByTestId("tileset-editor")).toBeVisible();
    await page.getByTestId("property-collision").click();
    await page.getByRole("option", { name: "Full" }).click();

    await createAsset(page, "Tilemap", "Overworld");
    await page
      .locator('[data-asset-path="assets/Overworld.tilemap.babasset"]')
      .dblclick();
    await expect(page.getByTestId("tilemap-editor")).toBeVisible();
    await page.getByTestId("property-tileset").click();
    const tilesetGuid = await guidForPath(page, "assets/Ground.tileset.babasset");
    expect(tilesetGuid.length).toBeGreaterThan(0);
    await expect(page.getByTestId(`search-item-${tilesetGuid}`)).toBeVisible();
    await page.getByTestId(`search-item-${tilesetGuid}`).click();

    const canvas = page.getByTestId("tilemap-paint-canvas");
    await expect(canvas).toBeVisible();
    await expect(canvas).toHaveAttribute("data-tool", "brush");
    for (let i = 0; i < 8; i++) {
      await canvas.click({ position: { x: 8 + i * 16, y: 248 } });
    }
    expect(await tileAt(page, 0, 0)).toBe(1);
    expect(await tileAt(page, 7, 0)).toBe(1);

    await createAsset(page, "Sprite", "Hero");
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
    await fillSelectedAssetGuid(page, "TilemapComponent", tilemapGuid);

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
    await fillSelectedAssetGuid(page, "SpriteComponent", spriteGuid);
    const graphGuid = await guidForPath(page, "assets/Loco.anim.babasset");
    const graphCard = page.locator("[data-testid^='component-card-']").filter({
      hasText: "AnimationGraphComponent",
    });
    await graphCard.getByLabel("Graph GUID").fill(graphGuid);
    await page.getByTestId("property-actor-position-y").fill("3");

    await page.getByTestId("play-preview").click();
    await expect(page.getByTestId("play-overlay")).toBeVisible();
    await expect
      .poll(async () => {
        const attr = await page
          .getByTestId("play-physics-ms")
          .getAttribute("data-ms");
        return Number(attr ?? "0");
      }, { timeout: 15_000 })
      .toBeGreaterThan(0);
    await page.getByTestId("play-overlay-close").click();
  });
});
