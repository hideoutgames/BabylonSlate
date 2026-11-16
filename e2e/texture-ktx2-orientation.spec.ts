import { expect, test, type Page, type TestInfo } from "@playwright/test";
import {
  MAIN_SCENE_FILE,
  PROJECT_FILE,
  createActor,
  createDefaultScene,
} from "../packages/core/src/index";
import { encodeAssetDocument } from "../packages/assets/src/asset-document";
import { sniffKtx2Size } from "../packages/assets/src/ktx2-info";
import { createDefaultMigrationRegistry } from "../packages/assets/src/migration";
import { createNodeBasisEncodeFn } from "../packages/assets/src/node-basis-encode";
import { minimalProjectFiles } from "../packages/assets/src/test-support/minimal-project";
import {
  DEFAULT_TEXTURE_ENCODE_SETTINGS,
  encodeSettingsHash,
  ktx2ChunkId,
  type TextureEncodeSettings,
} from "../packages/assets/src/texture-compression";
import type { ViewportProofResult, ViewportProofSamplePoint } from "../apps/editor/src/testing/viewport-proof";
import { openMinimalTestProject } from "./minimal-project";
import { openMainScene } from "./open-test-project";
import { SOFTWARE_GL_ARGS } from "./software-gl";

// The software rasteriser, for a functional proof, not GPU qualification.
test.use({ launchOptions: { args: SOFTWARE_GL_ARGS } });

const TEXTURE_GUID = "00000000-0000-4000-8000-000000000071";

type Rgb = [number, number, number];

/** Basis-encode an RGBA image built in code (rows top to bottom), as the editor's encoder does. */
async function encodeKtx2(
  settings: TextureEncodeSettings,
  width: number,
  height: number,
  colourOfRow: (row: number) => Rgb,
): Promise<Uint8Array> {
  const encode = createNodeBasisEncodeFn(() => {
    const rgba = new Uint8Array(width * height * 4);
    for (let row = 0; row < height; row++) {
      const [r, g, b] = colourOfRow(row);
      for (let column = 0; column < width; column++) rgba.set([r, g, b, 255], (row * width + column) * 4);
    }
    return { rgba, width, height };
  });
  const { ktx2 } = await encode(new Uint8Array(0), settings);
  expect(sniffKtx2Size(ktx2)).toEqual({ width, height });
  return ktx2;
}

/** The minimal project and its startup scene's GUID. */
async function projectFiles(): Promise<{ files: Map<string, Uint8Array>; startupSceneGuid: string }> {
  const files = await minimalProjectFiles();
  const project = JSON.parse(new TextDecoder().decode(files.get(PROJECT_FILE)!));
  return { files, startupSceneGuid: project.settings.startupSceneGuid };
}

async function viewportProof(
  page: Page,
  testInfo: TestInfo,
  label: string,
  options: { skyboxPoints?: ViewportProofSamplePoint[] },
): Promise<ViewportProofResult> {
  const proof = await page.evaluate((options) => (globalThis as unknown as {
    __hapticViewportTest: {
      viewportProof: (options: {
        frames: number;
        timeoutMs: number;
        skyboxPoints?: ViewportProofSamplePoint[];
      }) => Promise<ViewportProofResult>;
    };
  }).__hapticViewportTest.viewportProof({ frames: 30, timeoutMs: 30_000, ...options }), options);
  await testInfo.attach(label, { body: JSON.stringify({ ...proof, frames: undefined }), contentType: "application/json" });
  return proof;
}

const TOP: Rgb = [0, 200, 0];
const BOTTOM: Rgb = [200, 0, 0];
const GREY: Rgb = [128, 128, 128];

/** A `width`×`height` PNG drawn in the page: `top` over `bottom`, split at half height. */
async function twoTonePng(page: Page, width: number, height: number, top: Rgb, bottom: Rgb): Promise<Uint8Array> {
  const bytes = await page.evaluate(async ({ width, height, top, bottom }) => {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d")!;
    context.fillStyle = `rgb(${top.join(",")})`;
    context.fillRect(0, 0, width, height / 2);
    context.fillStyle = `rgb(${bottom.join(",")})`;
    context.fillRect(0, height / 2, width, height / 2);
    const blob = await new Promise<Blob>((resolve) => canvas.toBlob((value) => resolve(value!)));
    return [...new Uint8Array(await blob.arrayBuffer())];
  }, { width, height, top, bottom });
  return new Uint8Array(bytes);
}

/**
 * Adds the `width`×`height` Texture `TEXTURE_GUID`, green over red. A `ktx2`
 * Texture carries a grey PNG, so its green or red can only come from the KTX2.
 */
async function addTwoToneTexture(
  page: Page,
  files: Map<string, Uint8Array>,
  width: number,
  height: number,
  source: "png" | "ktx2",
): Promise<void> {
  const pixels = source === "png"
    ? await twoTonePng(page, width, height, TOP, BOTTOM)
    : await twoTonePng(page, width, height, GREY, GREY);
  const extraChunks = [{ id: "pixels", kind: "pixels", mime: "image/png", data: pixels }];
  const texture: Record<string, unknown> = {
    width,
    height,
    usage: source === "ktx2" ? "albedo" : "pixelArt",
    downsample: 1,
    // Pixel Art is never compressed, so its import writes no compression state.
    ...(source === "ktx2" ? { compressionState: "compressed" } : {}),
  };
  if (source === "ktx2") {
    const settings = { ...DEFAULT_TEXTURE_ENCODE_SETTINGS, maxDimension: height };
    const chunkId = ktx2ChunkId(await encodeSettingsHash(settings));
    const ktx2 = await encodeKtx2(settings, width, height, (row) => (row < height / 2 ? TOP : BOTTOM));
    extraChunks.push({ id: chunkId, kind: "ktx2", mime: "image/ktx2", data: ktx2 });
    texture.ktx2ChunkId = chunkId;
  }
  files.set("assets/atlas.hasset", await encodeAssetDocument(
    { guid: TEXTURE_GUID, type: "Texture", name: "Atlas", version: 1, payload: texture },
    { headerPayload: texture, extraChunks },
  ));
}

/** A 9×9 grid of viewport samples over the 2D scene. */
const GRID_POINTS: ViewportProofSamplePoint[] = Array.from({ length: 81 }, (_, index) => ({
  x: 0.1 + (index % 9) * 0.1,
  y: 0.1 + Math.floor(index / 9) * 0.1,
}));

type TileReading = { green: number; red: number; reads: "upright" | "upside down" | "mixed" };

/**
 * A 2D scene with one 2D Texture showing the whole 12×24 Texture, green over
 * red, scaled to span several viewport samples: drawn upright its green
 * samples all sit above its red ones.
 */
async function textureQuadScene(page: Page, source: "png" | "ktx2"): Promise<Map<string, Uint8Array>> {
  const { files, startupSceneGuid } = await projectFiles();
  await addTwoToneTexture(page, files, 12, 24, source);
  const scene = createDefaultScene("2d");
  // The grid's red X axis runs along the centre sample row, outside the picture.
  scene.settings.grid.showGrid = false;
  scene.actors.push(createActor("picture", "Picture", {
    // 0.12×0.24 world units at 100 pixels per unit, scaled to 6×6 and centred on the origin.
    transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [50, 25, 1] },
    components: [{ id: "picture-texture", classId: "2DTextureComponent", properties: { textureGuid: TEXTURE_GUID } }],
  }));
  files.set(MAIN_SCENE_FILE, await encodeAssetDocument({
    guid: startupSceneGuid, type: "Scene", name: "Main",
    version: createDefaultMigrationRegistry().currentVersion("Scene"), payload: scene as unknown as Record<string, unknown>,
  }, { dependencies: [TEXTURE_GUID] }));
  return files;
}

/** Sample y grows downward: upright when every green sample is above every red one. */
function quadReading(proof: ViewportProofResult): TileReading {
  const green: number[] = [];
  const red: number[] = [];
  for (const sample of proof.skybox) {
    const [r = 0, g = 0, b = 0] = sample.pixels.at(-1) ?? [];
    if (g >= 80 && g > 2 * Math.max(r, b)) green.push(sample.point.y);
    if (r >= 80 && r > 2 * Math.max(g, b)) red.push(sample.point.y);
  }
  const reads = !green.length || !red.length ? "mixed"
    : Math.max(...green) < Math.min(...red) ? "upright"
      : Math.max(...red) < Math.min(...green) ? "upside down" : "mixed";
  return { green: green.length, red: red.length, reads };
}

/** Opens the 2D Texture scene and reads it once both tones show. */
async function drawTextureQuad(page: Page, testInfo: TestInfo, source: "png" | "ktx2"): Promise<TileReading> {
  await openMinimalTestProject(page, await textureQuadScene(page, source));
  await openMainScene(page);
  let proof: ViewportProofResult | undefined;
  let reading: TileReading | undefined;
  await expect(async () => {
    proof = await viewportProof(page, testInfo, `texture2d-${source}`, { skyboxPoints: GRID_POINTS });
    reading = quadReading(proof);
    expect(Math.min(reading.green, reading.red), source).toBeGreaterThan(0);
  }).toPass({ timeout: 60_000 });
  return reading!;
}

test("a KTX2 on a 2D Texture draws the same way up as its PNG", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  // Software GL decodes the KTX2 to RGBA: an unflipped upload whose V flip comes from the GLSL texture matrix.
  const png = await drawTextureQuad(page, testInfo, "png");
  const ktx2 = await drawTextureQuad(page, testInfo, "ktx2");
  await testInfo.attach("texture2d-orientation", { body: JSON.stringify({ png, ktx2 }), contentType: "application/json" });
  expect(png.reads).toBe("upright");
  expect(ktx2.reads, "12x24 KTX2").toBe(png.reads);
});
