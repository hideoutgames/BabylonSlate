import { expect, test, type Locator, type Page } from "@playwright/test";
import { encodeAssetDocument } from "../packages/assets/src/asset-document";
import { minimalProjectFiles } from "../packages/assets/src/test-support/minimal-project";
import { createDefaultTilemapPayload, setTile, type TilemapPayload } from "../packages/assets/src/tilemap-payload";
import { normalizeTilesetPayload } from "../packages/assets/src/tileset-payload";
import { createDefaultSpritePayload } from "../packages/assets/src/sprite-payload";
import { createActor, createDefaultScene, MAIN_SCENE_FILE, PROJECT_FILE } from "../packages/core/src/index";
import { openMinimalTestProject } from "./minimal-project";
import { openMainScene } from "./open-test-project";
import { clickPlayAndWaitForOverlay, waitForPreviewBuildBoot } from "./play";

const guid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const texture = guid(10), atlas = guid(11), blueTexture = guid(12), blueAtlas = guid(13);

async function fixture(page: Page, animated: boolean) {
  const files = await minimalProjectFiles();
  const project = JSON.parse(new TextDecoder().decode(files.get(PROJECT_FILE)!));
  project.settings.twoD.pixelsPerUnit = 16;
  project.settings.twoD.pixelPerfect = false;
  project.settings.twoD.sortingLayers = ["Default", "Decals", "Props"];
  files.set(PROJECT_FILE, new TextEncoder().encode(JSON.stringify(project)));
  const png = async (colors: string[]) => new Uint8Array(await page.evaluate(async (colors) => {
    const canvas = document.createElement("canvas"); canvas.width = colors.length * 16; canvas.height = 16;
    const ctx = canvas.getContext("2d")!;
    colors.forEach((color, i) => { ctx.fillStyle = color; ctx.fillRect(i * 16, 0, 16, 16); });
    if (colors.length === 6) ctx.clearRect(88, 0, 8, 16);
    const blob = await new Promise<Blob>((resolve) => canvas.toBlob((value) => resolve(value!)));
    return [...new Uint8Array(await blob.arrayBuffer())];
  }, colors));
  for (const [id, colors] of [[texture, ["#00c800", "#c80000", "#c80000", "#c8c800", "#00c8c8", "#00c800"]], [blueTexture, ["#0000c8"]]] as const) {
    const payload = { width: colors.length * 16, height: 16, usage: "pixelArt", compressionState: "fallback_uncompressed" };
    files.set(`assets/${id}.texture.babasset`, await encodeAssetDocument({ guid: id, type: "Texture", name: id, version: 1, payload }, {
      headerPayload: payload, extraChunks: [{ id: "pixels", kind: "pixels", mime: "image/png", data: await png([...colors]) }],
    }));
  }
  const asset = async (id: string, type: "Tileset" | "Tilemap" | "Sprite", payload: unknown, dependencies: string[]) => {
    files.set(`assets/${id}.${type.toLowerCase()}.babasset`, await encodeAssetDocument({ guid: id, type, name: id, version: 1, payload: payload as Record<string, unknown> }, { dependencies }));
  };
  await asset(atlas, "Tileset", normalizeTilesetPayload({ textureGuid: texture, atlasWidth: 96, tiles: animated ? [{ id: 1, animation: [1, 2], animationFrameDurationMs: 400 }] : [] }), [texture]);
  await asset(blueAtlas, "Tileset", normalizeTilesetPayload({ textureGuid: blueTexture }), [blueTexture]);
  const scene = createDefaultScene("2d");
  scene.settings.grid.showGrid = false;
  const map = (tile: number) => {
    let map: TilemapPayload = { ...createDefaultTilemapPayload(), tilesetGuid: atlas, tilesets: [{ guid: atlas, firstGid: 1, tileCount: 6 }], width: 2, height: 2 };
    for (let x = 0; x < 2; x++) for (let y = 0; y < 2; y++) map = setTile(map, "layer-1", x, y, tile);
    return map;
  };
  const addMap = async (id: number, payload: ReturnType<typeof map>, position: [number, number, number], order: number) => {
    await asset(guid(id), "Tilemap", payload, payload.tilesets.map((ref) => ref.guid));
    scene.actors.push(createActor(`map-${id}`, `Map ${id}`, { transform: { position, rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, components: [{ id: `component-${id}`, classId: "TilemapComponent", properties: { assetGuid: guid(id), sortingLayer: "Default", orderInLayer: order } }] }));
  };
  const addSprite = async (id: number, cell: number, position: [number, number, number], order: number, size = 1) => {
    const sprite = createDefaultSpritePayload(); sprite.textureGuid = cell === 3 ? blueTexture : texture; sprite.pixelsPerUnit = 16;
    sprite.frames[0] = { ...sprite.frames[0]!, u: cell === 3 ? 0 : (cell - 1) / 6, uSize: cell === 3 ? 1 : 1 / 6, width: 16, height: 16 };
    await asset(guid(id), "Sprite", sprite, [sprite.textureGuid]);
    scene.actors.push(createActor(`sprite-${id}`, `Sprite ${id}`, { transform: { position, rotation: [0, 0, 0, 1], scale: [size, size, 1] }, components: [{ id: `component-${id}`, classId: "SpriteComponent", properties: { assetGuid: guid(id), sortingLayer: "Default", orderInLayer: order } }] }));
  };
  if (animated) {
    await addMap(20, map(1), [-1, -1, 0], 0);
  } else {
    const grouped = map(1);
    grouped.layers = [{ ...grouped.layers[0]!, sortingLayer: "Props" }, { ...map(2).layers[0]!, id: "back", sortingLayer: "Decals", orderInLayer: 20 }];
    await addMap(20, grouped, [-3, -1, 0], 5);
    await addSprite(21, 4, [-2.5, 0.5, 0], 6);
    await addMap(22, map(6), [0, -1, 0], 5);
    await addSprite(23, 3, [1, 0, 0], 4, 2);
    await addSprite(24, 5, [0.5, 0.5, -0.5], -5);
    const saved = map(3);
    saved.tilesets = [{ guid: atlas, firstGid: 1, tileCount: 2 }, { guid: blueAtlas, firstGid: 3, tileCount: 1 }];
    await addMap(25, saved, [3, -1, 0], 5);
  }
  files.set(MAIN_SCENE_FILE, await encodeAssetDocument({ guid: guid(1), type: "Scene", name: "Main", version: 3, payload: scene as unknown as Record<string, unknown> }, { dependencies: scene.actors.flatMap((actor) => actor.components.map((component) => component.properties.assetGuid as string).filter(Boolean)) }));
  return files;
}

async function colors(canvas: Locator) {
  return canvas.evaluate((node) => {
    const source = node as HTMLCanvasElement;
    const copy = document.createElement("canvas"); copy.width = source.width; copy.height = source.height;
    const ctx = copy.getContext("2d")!; ctx.drawImage(source, 0, 0);
    const pixels = ctx.getImageData(0, 0, copy.width, copy.height).data;
    const counts = { red: 0, green: 0, blue: 0, yellow: 0, cyan: 0 };
    for (let i = 0; i < pixels.length; i += 4) {
      const [r, g, b] = [pixels[i]!, pixels[i + 1]!, pixels[i + 2]!];
      if (r > 100 && g < 30 && b < 30) counts.red++;
      if (g > 100 && r < 30 && b < 30) counts.green++;
      if (b > 100 && r < 30 && g < 30) counts.blue++;
      if (r > 100 && g > 100 && b < 30) counts.yellow++;
      if (g > 100 && b > 100 && r < 30) counts.cyan++;
    }
    return counts;
  });
}

for (const animated of [false, true]) {
  test(animated ? "Tilemap animation visibly loops in Scene Preview, Play and Preview Build" : "Tilemap groups, atlas growth, cutouts and world depth agree in all render modes", async ({ page }) => {
    test.setTimeout(180_000);
    await openMinimalTestProject(page, await fixture(page, animated));
    await openMainScene(page);
    const check = async (canvas: Locator) => {
      if (animated) {
        for (const color of ["green", "red", "green"] as const) await expect.poll(async () => (await colors(canvas))[color], { timeout: 15_000, intervals: [80, 100] }).toBeGreaterThan(200);
      } else {
        await expect(async () => {
          const result = await colors(canvas);
          for (const color of ["green", "blue", "yellow", "cyan"] as const) expect(result[color], color).toBeGreaterThan(100);
          expect(result.red).toBeLessThan(20);
        }).toPass({ timeout: 20_000 });
      }
    };
    const checkPausedStep = async (canvas: Locator, preview: boolean) => {
      if (!animated) return;
      if (preview) await page.getByRole("button", { name: "Console", exact: true }).click();
      else await page.getByTestId("play-console-open").click();
      let output = 0;
      const command = async (line: string) => {
        await page.getByTestId("debug-console-input").fill(line);
        await page.getByTestId("debug-console-submit").click();
        await expect(page.getByTestId(`debug-console-output-${output++}`)).toBeVisible();
        await canvas.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      };
      await command("pause");
      await command("slomo 3");
      const initial = await colors(canvas);
      const initialColor = initial.green > initial.red ? "green" : "red";
      const targetColor = initialColor === "green" ? "red" : "green";
      let changed = false;
      for (let step = 0; step < 12; step++) {
        await command("step");
        if ((await colors(canvas))[targetColor] > 200) { changed = true; break; }
      }
      expect(changed, "a completed step must draw the new frame while still paused").toBe(true);
      const held = await colors(canvas);
      await page.waitForTimeout(500);
      expect(await colors(canvas)).toEqual(held);
      await command("resume");
      await page.getByTestId("debug-console").getByRole("button", { name: "Close", exact: true }).click();
    };
    await check(page.getByTestId("viewport-canvas"));
    await clickPlayAndWaitForOverlay(page);
    await check(page.getByTestId("play-canvas"));
    await checkPausedStep(page.getByTestId("play-canvas"), false);
    await page.getByTestId("play-overlay-close").click();
    await page.getByTestId("debug-menu").click();
    await page.getByTestId("preview-build-toggle").click();
    await page.getByTestId("play-preview").click();
    await waitForPreviewBuildBoot(page);
    await check(page.frameLocator('[data-testid="preview-build-iframe"]').getByTestId("player-canvas"));
    await checkPausedStep(page.frameLocator('[data-testid="preview-build-iframe"]').getByTestId("player-canvas"), true);
    await page.getByTestId("preview-build-close").click();
  });
}
