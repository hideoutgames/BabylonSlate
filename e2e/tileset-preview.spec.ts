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
import { openMainScene } from "./open-test-project";
import { clickPlayAndWaitForOverlay } from "./play";
import { expectGreenIllumination } from "./preview-parity";

const textureGuid = "00000000-0000-4000-8000-000000000010";
const tilesetGuid = "00000000-0000-4000-8000-000000000011";
const tilemapGuid = "00000000-0000-4000-8000-000000000012";

test.afterEach(async ({ page }, info) => {
  if (info.status === info.expectedStatus) return;
  await info.attach("scene-texture-pixels", { body: JSON.stringify(await page.evaluate(() =>
    (window as unknown as { __babylonslateViewportTest?: { sceneTexturePixels(): Promise<unknown> } }).__babylonslateViewportTest?.sceneTexturePixels() ?? [])), contentType: "application/json" });
});

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

test("encoded Tilemap atlas renders its pixels in Scene Preview and Play", async ({
  page,
}, testInfo) => {
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
  await testInfo.attach("tilemap-native-diagnostic", { body: JSON.stringify(await page.evaluate(() => {
    const host = window as unknown as { __babylonslateViewportTest: { sceneVisuals(): unknown; renderingBaseline(): unknown } };
    return { visuals: host.__babylonslateViewportTest.sceneVisuals(), rendering: host.__babylonslateViewportTest.renderingBaseline() };
  })), contentType: "application/json" });
  await expectGreenIllumination(page.getByTestId("viewport-canvas"));
  const upload = await page.evaluate(() =>
    (
      window as unknown as {
        __babylonslateViewportTest: {
          renderingBaseline(): {
            estimatedTextureBytes: number;
            glInfo: { renderer: string };
            ktx2Uploads: Array<{ format: number; type: number; mips: boolean }>;
          };
        };
      }
    ).__babylonslateViewportTest.renderingBaseline(),
  );
  expect(upload.ktx2Uploads.length).toBeGreaterThan(0);
  if (
    /swiftshader|llvmpipe|softpipe|microsoft basic render|\bsoftware\b/i.test(
      upload.glInfo.renderer,
    )
  ) {
    // The encoded 64x64 RGBA atlas uploads all seven levels (21844 bytes),
    // even though Tilemap uses a no-mip sampling policy. This also excludes
    // the previous fixed-ASTC estimate and last-mip-only fallback estimate.
    expect(
      upload.ktx2Uploads.every(
        (texture) => texture.format === 5 && texture.type === 0 && texture.mips,
      ),
    ).toBe(true);
    expect(upload.estimatedTextureBytes).toBeGreaterThanOrEqual(21844);
  }
  await testInfo.attach("ktx2-upload", {
    body: JSON.stringify(upload),
    contentType: "application/json",
  });
  await clickPlayAndWaitForOverlay(page);
  await expectGreenIllumination(page.getByTestId("play-canvas"));
  await page.getByTestId("play-overlay-close").click();
});
