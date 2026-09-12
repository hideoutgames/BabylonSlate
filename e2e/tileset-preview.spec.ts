import { expect, test, type Page } from "@playwright/test";
import { encodeAssetDocument } from "../packages/assets/src/asset-document";
import { minimalProjectFiles } from "../packages/assets/src/test-support/minimal-project";
import { createNodeBasisEncodeFn } from "../packages/assets/src/node-basis-encode";
import {
  DEFAULT_TEXTURE_ENCODE_SETTINGS,
  encodeSettingsHash,
  ktx2ChunkId,
} from "../packages/assets/src/texture-compression";
import { createDefaultTilesetPayload } from "../packages/assets/src/tileset-payload";
import { createDefaultTilemapPayload } from "../packages/assets/src/tilemap-payload";
import {
  createActor,
  createDefaultScene,
  MAIN_SCENE_FILE,
} from "../packages/core/src/index";
import { openMinimalTestProject } from "./minimal-project";
import { openAssetFromBrowser, openMainScene } from "./open-test-project";
import { clickPlayAndWaitForOverlay } from "./play";
import { expectGreenIllumination } from "./preview-parity";
import { IPAD_TEST_TAG } from "./ipad-tag";

const textureGuid = "00000000-0000-4000-8000-000000000010";
const tilesetGuid = "00000000-0000-4000-8000-000000000011";
const tilemapGuid = "00000000-0000-4000-8000-000000000012";

// Numeric solid-color fixtures, with no pictorial assets or generated artwork.
async function greenPng(page: Page, width: number, height: number) {
  const bytes = await page.evaluate(
    async ({ width, height }) => {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d")!;
      context.fillStyle = "rgb(0, 200, 0)";
      context.fillRect(0, 0, width, height);
      const blob = await new Promise<Blob>((resolve) =>
        canvas.toBlob((value) => resolve(value!)),
      );
      return [...new Uint8Array(await blob.arrayBuffer())];
    },
    { width, height },
  );
  return new Uint8Array(bytes);
}

async function atlasFiles(
  page: Page,
  width: number,
  height: number,
  compressed = false,
) {
  const files = await minimalProjectFiles();
  const pixels = await greenPng(page, width, height);
  const extraChunks = [
    { id: "pixels", kind: "pixels", mime: "image/png", data: pixels },
  ];
  let encodedChunkId: string | undefined;
  if (compressed) {
    const encode = createNodeBasisEncodeFn(() => {
      const rgba = new Uint8Array(width * height * 4);
      for (let i = 0; i < rgba.length; i += 4) {
        rgba[i + 1] = 200;
        rgba[i + 3] = 255;
      }
      return { rgba, width, height };
    });
    const settings = {
      ...DEFAULT_TEXTURE_ENCODE_SETTINGS,
      maxDimension: Math.max(width, height),
    };
    const { ktx2 } = await encode(pixels, settings);
    encodedChunkId = ktx2ChunkId(await encodeSettingsHash(settings));
    extraChunks.push({
      id: encodedChunkId,
      kind: "ktx2",
      mime: "image/ktx2",
      data: ktx2,
    });
  }
  const texture = {
    width,
    height,
    usage: compressed ? "albedo" : "pixelArt",
    downsample: 1,
    compressionState: compressed ? "compressed" : "fallback_uncompressed",
    ktx2ChunkId: encodedChunkId,
  };
  files.set(
    "assets/atlas.babasset",
    await encodeAssetDocument(
      {
        guid: textureGuid,
        type: "Texture",
        name: "Atlas",
        version: 1,
        payload: texture,
      },
      { headerPayload: texture, extraChunks },
    ),
  );
  files.set(
    "assets/ground.tileset.babasset",
    await encodeAssetDocument(
      {
        guid: tilesetGuid,
        type: "Tileset",
        name: "Ground",
        version: 1,
        payload: {
          ...createDefaultTilesetPayload(),
          textureGuid,
          atlasWidth: width,
          atlasHeight: height,
          tileWidth: 16,
          tileHeight: 16,
        },
      },
      { dependencies: [textureGuid] },
    ),
  );
  return files;
}

test(
  "Tileset Preview fills the dock and fits wide and tall atlases after resizing",
  { tag: IPAD_TEST_TAG },
  async ({ page }, testInfo) => {
    for (const [width, height] of [
      [1024, 128],
      [128, 1024],
    ]) {
      const files = await atlasFiles(page, width!, height!);
      await openMinimalTestProject(page, files);
      await openAssetFromBrowser(page, "assets/ground.tileset.babasset");
      for (const viewport of [
        { width: 1194, height: 834 },
        { width: 950, height: 650 },
      ]) {
        await page.setViewportSize(viewport);
        const panel = page.getByTestId("tileset-preview-panel");
        const surface = page.getByTestId("tileset-preview-surface");
        const image = surface.locator("img");
        await expect(image).toBeVisible();
        await expect(async () => {
          const p = (await panel.boundingBox())!;
          const s = (await surface.boundingBox())!;
          const i = (await image.boundingBox())!;
          expect(s.height).toBeGreaterThan(p.height - 150);
          expect(s.width).toBeGreaterThan(p.width - 30);
          expect(Math.abs(s.y + s.height - (p.y + p.height - 12))).toBeLessThan(
            2,
          );
          expect(s.y + s.height).toBeLessThanOrEqual(viewport.height);
          expect(i.x).toBeGreaterThanOrEqual(s.x);
          expect(i.y).toBeGreaterThanOrEqual(s.y);
          expect(i.x + i.width).toBeLessThanOrEqual(s.x + s.width);
          expect(i.y + i.height).toBeLessThanOrEqual(s.y + s.height);
          expect(
            Math.abs(i.x + i.width / 2 - (s.x + s.width / 2)),
          ).toBeLessThan(2);
          expect(
            Math.abs(i.y + i.height / 2 - (s.y + s.height / 2)),
          ).toBeLessThan(2);
        }).toPass();
      }
      await page.screenshot({
        path: testInfo.outputPath(`atlas-${width}x${height}.png`),
      });
    }
  },
);

test("encoded Tilemap atlas renders its pixels in Scene Preview and Play", async ({
  page,
}) => {
  const files = await atlasFiles(page, 64, 64, true);
  const tilemap = createDefaultTilemapPayload();
  tilemap.tilesetGuid = tilesetGuid;
  tilemap.tilesets = [{ guid: tilesetGuid, firstGid: 1, tileCount: 16 }];
  tilemap.layers[0]!.chunks = [
    { cx: 0, cy: 0, tiles: Array<number>(32 * 32).fill(1) },
  ];
  files.set(
    "assets/ground.tilemap.babasset",
    await encodeAssetDocument(
      {
        guid: tilemapGuid,
        type: "Tilemap",
        name: "Ground Map",
        version: 1,
        payload: tilemap as unknown as Record<string, unknown>,
      },
      { dependencies: [tilesetGuid] },
    ),
  );
  const scene = createDefaultScene("2d");
  scene.actors.push(
    createActor("ground", "Ground", {
      transform: {
        position: [-2.56, -2.56, 0],
        rotation: [0, 0, 0, 1],
        scale: [1, 1, 1],
      },
      components: [
        {
          id: "ground-map",
          classId: "TilemapComponent",
          properties: { assetGuid: tilemapGuid },
        },
      ],
    }),
  );
  files.set(
    MAIN_SCENE_FILE,
    await encodeAssetDocument(
      {
        guid: "00000000-0000-4000-8000-000000000001",
        type: "Scene",
        name: "Main",
        version: 3,
        payload: scene as unknown as Record<string, unknown>,
      },
      { dependencies: [tilemapGuid] },
    ),
  );
  await openMinimalTestProject(page, files);
  await openMainScene(page);
  await expect.poll(() => page.evaluate(() => {
    const host = globalThis as unknown as {
      __babylonslateViewportTest?: { sceneVisuals: () => unknown[] };
    };
    return host.__babylonslateViewportTest?.sceneVisuals() ?? [];
  })).toEqual(expect.arrayContaining([expect.objectContaining({
    actorId: "ground", materialName: `albedo:${textureGuid}`,
  })]));
  await expectGreenIllumination(page.getByTestId("viewport-canvas"));
  await clickPlayAndWaitForOverlay(page);
  await expectGreenIllumination(page.getByTestId("play-canvas"));
  await page.getByTestId("play-overlay-close").click();
});
