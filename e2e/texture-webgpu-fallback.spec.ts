import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import {
  MAIN_SCENE_FILE,
  PROJECT_FILE,
  createActor,
  createDefaultScene,
  createDefaultSunActor,
  createMeshComponent,
  lookAtRotation,
} from "../packages/core/src/index";
import { encodeAssetDocument } from "../packages/assets/src/asset-document";
import { importImage } from "../packages/assets/src/importers/image";
import { sniffKtx2Size } from "../packages/assets/src/ktx2-info";
import { MATERIAL_PAYLOAD_VERSION, createDefaultMigrationRegistry } from "../packages/assets/src/migration";
import { createNodeBasisEncodeFn } from "../packages/assets/src/node-basis-encode";
import { normalizeParticleEmitterPayload } from "../packages/assets/src/particle-basic-emitter";
import { textureEncodeSettingsFor } from "../packages/assets/src/resolve-gpu-texture";
import { minimalProjectFiles } from "../packages/assets/src/test-support/minimal-project";
import {
  DEFAULT_TEXTURE_ENCODE_SETTINGS,
  encodeSettingsHash,
  ktx2ChunkId,
  type TextureEncodeSettings,
} from "../packages/assets/src/texture-compression";
import { createDefaultTilemapPayload } from "../packages/assets/src/tilemap-payload";
import { createDefaultTilesetPayload } from "../packages/assets/src/tileset-payload";
import { createDefaultMaterialDocument } from "../packages/shader-graph/src/document";
import type {
  ViewportProofResult,
  ViewportProofSamplePoint,
  ViewportProofSubjectResult,
} from "../apps/editor/src/testing/webgpu-previews-proof";
import { openMinimalTestProject } from "./minimal-project";
import { openAssetFromBrowser, openMainScene } from "./open-test-project";
import { clickPlayAndWaitForOverlay } from "./play";
import { SOFTWARE_WEBGPU_ARGS } from "./software-webgpu";
import {
  compressedGpuTextures,
  expectPreviewDraws,
  offBlockGrid,
  previewDraw,
  recordCompressedGpuTextures,
  watchGpuFailures,
  type CompressedTexture,
} from "./webgpu-texture-proof";

// Explicit software adapter admission for this functional proof, not GPU qualification.
test.use({ launchOptions: { args: SOFTWARE_WEBGPU_ARGS } });

const TEXTURE_GUID = "00000000-0000-4000-8000-000000000071";
const SURFACE_GUID = "00000000-0000-4000-8000-000000000072";
const PARTICLE_GUID = "00000000-0000-4000-8000-000000000073";
const TEXTURE_PATH = "assets/albedo.babasset";
const EMITTER_PATH = "assets/OddSparks.emitter.babasset";
/** Samples the texture through its surface Material. */
const TEXTURED_BOX = "actor-1";
/** No Material: the engine default material under the same light. */
const PLAIN_BOX = "plain-box";
/** Directional light from the camera's side, so the −Z faces the viewport samples are lit. */
const SUN_POSITION: [number, number, number] = [0, 8, -8];

type Backend = "webgl2" | "webgpu";
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

/** The minimal project on `backend`. */
async function projectFiles(backend: Backend): Promise<{ files: Map<string, Uint8Array>; startupSceneGuid: string }> {
  const files = await minimalProjectFiles();
  const project = JSON.parse(new TextDecoder().decode(files.get(PROJECT_FILE)!));
  project.settings.render.gpuBackend = backend;
  files.set(PROJECT_FILE, new TextEncoder().encode(JSON.stringify(project)));
  return { files, startupSceneGuid: project.settings.startupSceneGuid };
}

/**
 * `e2e/fixtures/albedo.png` (1×1 pure red) as a `compressed` Albedo Texture
 * whose committed 1×1 KTX2 is pure green: a green draw comes from the KTX2, a
 * red one from the PNG. The chunk id is the one the registry and the resolver
 * compute for this payload, so opening the project neither re-encodes it nor
 * prefers another chunk. A surface Material samples it on the box and a
 * particle Material in an Emitter; a second box has no Material.
 */
async function fixture(backend: Backend): Promise<Map<string, Uint8Array>> {
  const { files, startupSceneGuid } = await projectFiles(backend);
  const migrations = createDefaultMigrationRegistry();
  const png = new Uint8Array(await readFile(path.join(process.cwd(), "e2e/fixtures/albedo.png")));
  const [texture] = await importImage(png, { fileName: "albedo.png", existingGuids: new Set() });
  expect(texture!.payload).toMatchObject({ usage: "albedo", width: 1, height: 1 });
  const settings = textureEncodeSettingsFor(texture!.payload, DEFAULT_TEXTURE_ENCODE_SETTINGS);
  const chunkId = ktx2ChunkId(await encodeSettingsHash(settings));
  const ktx2 = await encodeKtx2(settings, 1, 1, () => [0, 255, 0]);
  const payload = { ...texture!.payload, compressionState: "compressed", ktx2ChunkId: chunkId };
  files.set(TEXTURE_PATH, await encodeAssetDocument(
    { guid: TEXTURE_GUID, type: "Texture", name: texture!.name, version: texture!.version, payload },
    { headerPayload: payload, extraChunks: [...texture!.chunks, { id: chunkId, kind: "ktx2", mime: "image/ktx2", data: ktx2 }] },
  ));
  for (const [guid, domain, name] of [[SURFACE_GUID, "surface", "OddSurface"], [PARTICLE_GUID, "particle", "OddParticle"]] as const) {
    const material = createDefaultMaterialDocument(name, domain);
    material.nodes.push({ id: "sample", type: "texture.sample", position: { x: 0, y: 0 }, properties: { textureGuid: TEXTURE_GUID } });
    material.edges = [{ id: "sample-output", sourceNodeId: "sample", sourcePinId: domain === "particle" ? "rgba" : "rgb",
      targetNodeId: "output", targetPinId: domain === "particle" ? "color" : "baseColor" }];
    files.set(`assets/${name}.material.babasset`, await encodeAssetDocument({
      guid, type: "Material", name, version: MATERIAL_PAYLOAD_VERSION, payload: material as unknown as Record<string, unknown>,
    }, { dependencies: [TEXTURE_GUID] }));
  }
  files.set(EMITTER_PATH, await encodeAssetDocument({
    guid: "00000000-0000-4000-8000-000000000074", type: "ParticleEmitter", name: "OddSparks",
    version: migrations.currentVersion("ParticleEmitter"),
    payload: normalizeParticleEmitterPayload({ render: { materialGuid: PARTICLE_GUID } }) as unknown as Record<string, unknown>,
  }, { dependencies: [PARTICLE_GUID] }));
  const scene = createDefaultScene();
  scene.settings.grid.showGrid = false;
  const textured = createMeshComponent("mesh-1", "box");
  textured.properties.materialGuid = SURFACE_GUID;
  const sun = createDefaultSunActor(lookAtRotation(SUN_POSITION, [0, 0, 0]));
  sun.transform.position = [...SUN_POSITION];
  sun.components[0]!.properties.castShadows = false;
  scene.actors = [
    createActor(TEXTURED_BOX, "Actor", { classId: "Main", components: [textured] }),
    createActor(PLAIN_BOX, "Plain Box", {
      transform: { position: [2, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
      components: [createMeshComponent("plain-mesh", "box")],
    }),
    sun,
    ...scene.actors.filter((actor) => actor.id === scene.settings.mainCameraActorId),
  ];
  files.set(MAIN_SCENE_FILE, await encodeAssetDocument({
    guid: startupSceneGuid, type: "Scene", name: "Main",
    version: migrations.currentVersion("Scene"), payload: scene as unknown as Record<string, unknown>,
  }, { dependencies: ["00000000-0000-4000-8000-000000000002", SURFACE_GUID] }));
  return files;
}

/** Registry compression state and the committed KTX2's header size. */
async function committedKtx2(page: Page, assetPath: string): Promise<{
  compressionState: string | null;
  ktx2: { width: number; height: number } | null;
}> {
  const state = await page.evaluate(async (assetPath) => {
    const api = (globalThis as {
      __babylonslateTest?: {
        textureEncodeState?: (path: string) => { compressionState: string | null; ktx2ChunkId: string | null } | null;
        readAssetChunk?: (path: string, chunkId: string) => Promise<Uint8Array | null>;
      };
    }).__babylonslateTest;
    const current = api?.textureEncodeState?.(assetPath) ?? null;
    const bytes = current?.ktx2ChunkId ? await api?.readAssetChunk?.(assetPath, current.ktx2ChunkId).catch(() => null) : null;
    return { compressionState: current?.compressionState ?? null, header: bytes ? Array.from(bytes.subarray(0, 32)) : null };
  }, assetPath);
  return { compressionState: state.compressionState, ktx2: state.header ? sniffKtx2Size(new Uint8Array(state.header)) : null };
}

async function viewportProof(
  page: Page,
  testInfo: TestInfo,
  label: string,
  options: { trackedActorIds?: string[]; skyboxPoints?: ViewportProofSamplePoint[] },
): Promise<ViewportProofResult> {
  const proof = await page.evaluate((options) => (globalThis as unknown as {
    __babylonslateViewportTest: {
      webgpuPreviewsProof: (options: {
        frames: number;
        timeoutMs: number;
        trackedActorIds?: string[];
        skyboxPoints?: ViewportProofSamplePoint[];
      }) => Promise<ViewportProofResult>;
    };
  }).__babylonslateViewportTest.webgpuPreviewsProof({ frames: 30, timeoutMs: 30_000, ...options }), options);
  await testInfo.attach(label, { body: JSON.stringify({ ...proof, frames: undefined }), contentType: "application/json" });
  return proof;
}

function subject(proof: ViewportProofResult, actorId: string): ViewportProofSubjectResult {
  return proof.subjects.find((entry) => entry.actorId === actorId)!;
}

/** The lit pure-green KTX2: not the red PNG beside it, nor the default material. */
function readsGreen(pixel: number[] | null | undefined): boolean {
  const [r = 0, g = 0, b = 0] = pixel ?? [];
  return g >= 60 && g > 2 * Math.max(r, b);
}

/** The engine default material (a 0.8 / 0.65 grey checker) under the warm sun: lit and near neutral. */
function readsLitGrey(pixel: number[] | null | undefined): boolean {
  const [r = 0, g = 0, b = 0] = pixel ?? [];
  const max = Math.max(r, g, b);
  return max >= 60 && max - Math.min(r, g, b) <= max * 0.3;
}

/**
 * Frames keep presenting, the textured box draws the green KTX2 (its Material
 * compiles after the scene opens) and the box with no Material stays grey.
 */
async function expectBoxesDrawKtx2(page: Page, testInfo: TestInfo, backend: Backend): Promise<void> {
  let proof = undefined as ViewportProofResult | undefined;
  await expect(async () => {
    proof = await viewportProof(page, testInfo, `viewport-${backend}`, { trackedActorIds: [TEXTURED_BOX, PLAIN_BOX] });
    const pixel = subject(proof, TEXTURED_BOX).last?.pixel;
    expect(readsGreen(pixel), `${TEXTURED_BOX} ${pixel}`).toBe(true);
  }).toPass({ timeout: 60_000 });
  expect(proof!.backend).toBe(backend);
  expect(proof!.timedOut).toBe(false);
  expect(proof!.engineErrors).toEqual([]);
  for (const actorId of [TEXTURED_BOX, PLAIN_BOX]) {
    const entry = subject(proof!, actorId);
    expect(entry.realizedAtFrame, actorId).not.toBeNull();
    expect(entry.backgroundPixelFrames, actorId).toBe(0);
  }
  const plain = subject(proof!, PLAIN_BOX).last?.pixel;
  expect(readsLitGrey(plain), `${PLAIN_BOX} ${plain}`).toBe(true);
}

test("WebGPU decodes a Basis KTX2 off the 4×4 block grid to RGBA: the viewport and Emitter Preview draw it and Play runs", async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  const { gpuFailures, consoleProblems } = watchGpuFailures(page);
  await page.addInitScript(recordCompressedGpuTextures);
  await openMinimalTestProject(page, await fixture("webgpu"));
  // The seeded encode stays committed: opening the project does not re-encode it.
  expect(await committedKtx2(page, TEXTURE_PATH)).toEqual({ compressionState: "compressed", ktx2: { width: 1, height: 1 } });
  await openMainScene(page);
  await expectBoxesDrawKtx2(page, testInfo, "webgpu");

  // Emitter Preview: the particle Material samples the same KTX2.
  await openAssetFromBrowser(page, EMITTER_PATH);
  const preview = page.getByTestId("particle-emitter-preview");
  const canvas = page.getByTestId("particle-emitter-preview-canvas");
  const run = previewDraw();
  try {
    await expectPreviewDraws(preview, canvas, "green", run);
  } finally {
    await testInfo.attach("emitter-preview", { body: JSON.stringify({ ...run, consoleProblems }), contentType: "application/json" });
  }
  expect(Math.min(run.steady.matched, run.steady.moved)).toBeGreaterThan(200);
  await expect(preview.getByTestId("particle-preview-empty")).toHaveCount(0);

  // Play loads the scene and runs on with nothing to report about the texture.
  await openMainScene(page);
  await clickPlayAndWaitForOverlay(page);
  const tick = () => page.evaluate(() => (globalThis as unknown as { __babylonslatePlayTest?: { tickIndex(): number } }).__babylonslatePlayTest?.tickIndex() ?? 0);
  const started = await tick();
  await expect.poll(tick, { timeout: 30_000 }).toBeGreaterThan(started + 30);
  await expect(page.getByTestId("play-overlay")).toBeVisible();
  // The log tail renders only once something is logged.
  await expect(page.getByTestId("play-log-tail").filter({ hasText: /Scene loading failed|was not drawn/ })).toHaveCount(0);
  await page.getByTestId("play-overlay-close").click();
  await expect(page.getByTestId("play-overlay")).toHaveCount(0);

  const compressed = await compressedGpuTextures(page);
  await testInfo.attach("gpu", { body: JSON.stringify({ compressed, gpuFailures }), contentType: "application/json" });
  expect(compressed).not.toBeNull();
  // The 1×1 KTX2 never reached the GPU block-compressed.
  expect(offBlockGrid(compressed!)).toEqual([]);
  expect(gpuFailures).toEqual([]);
});

test("WebGL2 draws the same 1×1 Albedo KTX2", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  await openMinimalTestProject(page, await fixture("webgl2"));
  await openMainScene(page);
  await expectBoxesDrawKtx2(page, testInfo, "webgl2");
});

const TILESET_GUID = "00000000-0000-4000-8000-000000000075";
const TILEMAP_GUID = "00000000-0000-4000-8000-000000000076";
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
    compressionState: source === "ktx2" ? "compressed" : "fallback_uncompressed",
  };
  if (source === "ktx2") {
    const settings = { ...DEFAULT_TEXTURE_ENCODE_SETTINGS, maxDimension: height };
    const chunkId = ktx2ChunkId(await encodeSettingsHash(settings));
    const ktx2 = await encodeKtx2(settings, width, height, (row) => (row < height / 2 ? TOP : BOTTOM));
    extraChunks.push({ id: chunkId, kind: "ktx2", mime: "image/ktx2", data: ktx2 });
    texture.ktx2ChunkId = chunkId;
  }
  files.set("assets/atlas.babasset", await encodeAssetDocument(
    { guid: TEXTURE_GUID, type: "Texture", name: "Atlas", version: 1, payload: texture },
    { headerPayload: texture, extraChunks },
  ));
}

/**
 * A 2D scene whose Tilemap fills one chunk with the top tile of a one-column,
 * two-tile atlas (`tile`×`2·tile`, green over red): drawn upright the map
 * reads green, upside down it reads red.
 */
async function atlasScene(page: Page, tile: number, source: "png" | "ktx2"): Promise<Map<string, Uint8Array>> {
  const { files, startupSceneGuid } = await projectFiles("webgpu");
  const width = tile;
  const height = tile * 2;
  await addTwoToneTexture(page, files, width, height, source);
  files.set("assets/ground.tileset.babasset", await encodeAssetDocument({
    guid: TILESET_GUID, type: "Tileset", name: "Ground", version: 1,
    payload: { ...createDefaultTilesetPayload(), textureGuid: TEXTURE_GUID, atlasWidth: width, atlasHeight: height, tileWidth: tile, tileHeight: tile },
  }, { dependencies: [TEXTURE_GUID] }));
  const tilemap = createDefaultTilemapPayload();
  tilemap.tilesetGuid = TILESET_GUID;
  tilemap.tilesets = [{ guid: TILESET_GUID, firstGid: 1, tileCount: 2 }];
  tilemap.layers[0]!.chunks = [{ cx: 0, cy: 0, tiles: Array<number>(32 * 32).fill(1) }];
  files.set("assets/ground.tilemap.babasset", await encodeAssetDocument({
    guid: TILEMAP_GUID, type: "Tilemap", name: "Ground Map", version: 1, payload: tilemap as unknown as Record<string, unknown>,
  }, { dependencies: [TILESET_GUID] }));
  const scene = createDefaultScene("2d");
  // 32 tiles at 100 pixels per unit, centred on the origin.
  const half = (32 * tile) / 100 / 2;
  scene.actors.push(createActor("ground", "Ground", {
    transform: { position: [-half, -half, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
    components: [{ id: "ground-map", classId: "TilemapComponent", properties: { assetGuid: TILEMAP_GUID } }],
  }));
  files.set(MAIN_SCENE_FILE, await encodeAssetDocument({
    guid: startupSceneGuid, type: "Scene", name: "Main",
    version: createDefaultMigrationRegistry().currentVersion("Scene"), payload: scene as unknown as Record<string, unknown>,
  }, { dependencies: [TILEMAP_GUID] }));
  return files;
}

/** A 9×9 grid of viewport samples over the 2D scene. */
const GRID_POINTS: ViewportProofSamplePoint[] = Array.from({ length: 81 }, (_, index) => ({
  x: 0.1 + (index % 9) * 0.1,
  y: 0.1 + Math.floor(index / 9) * 0.1,
}));

type TileReading = { green: number; red: number; reads: "upright" | "upside down" | "mixed" };

function tileReading(proof: ViewportProofResult): TileReading {
  let green = 0;
  let red = 0;
  for (const sample of proof.skybox) {
    const [r = 0, g = 0, b = 0] = sample.pixels.at(-1) ?? [];
    if (g >= 80 && g > 2 * Math.max(r, b)) green += 1;
    if (r >= 80 && r > 2 * Math.max(g, b)) red += 1;
  }
  const reads = green > 0 && red === 0 ? "upright" : red > 0 && green === 0 ? "upside down" : "mixed";
  return { green, red, reads };
}

test("WebGPU draws a Tilemap atlas the same way up as its PNG, decoded to RGBA off the block grid or block-compressed on it", async ({ page }, testInfo) => {
  test.setTimeout(300_000);
  const { gpuFailures } = watchGpuFailures(page);
  await page.addInitScript(recordCompressedGpuTextures);
  const readings: Record<string, TileReading & { compressed: CompressedTexture[] }> = {};
  // A 10×20 KTX2 is off the 4×4 block grid (decoded to RGBA); 12×24 stays block-compressed.
  for (const [label, tile, source] of [
    ["png", 10, "png"],
    ["rgba", 10, "ktx2"],
    ["compressed", 12, "ktx2"],
  ] as const) {
    await openMinimalTestProject(page, await atlasScene(page, tile, source));
    await openMainScene(page);
    let proof: ViewportProofResult | undefined;
    let reading: TileReading | undefined;
    await expect(async () => {
      proof = await viewportProof(page, testInfo, `tilemap-${label}`, { skyboxPoints: GRID_POINTS });
      reading = tileReading(proof);
      expect(reading.green + reading.red, label).toBeGreaterThanOrEqual(3);
    }).toPass({ timeout: 60_000 });
    // Software WebGL2 decodes every KTX2 to RGBA, so a fallback would prove nothing here.
    expect(proof!.backend, label).toBe("webgpu");
    const recorded = await compressedGpuTextures(page);
    expect(recorded, label).not.toBeNull();
    readings[label] = { ...reading!, compressed: recorded! };
  }
  const { png, rgba, compressed } = readings as Record<"png" | "rgba" | "compressed", TileReading & { compressed: CompressedTexture[] }>;
  const blockCompressed = compressed.compressed.some((texture) => texture.width === 12 && texture.height === 24);
  await testInfo.attach("tilemap-orientation", { body: JSON.stringify({ readings, blockCompressed, gpuFailures }), contentType: "application/json" });
  expect(png.reads).toBe("upright");
  expect(rgba.reads, "RGBA-decoded 10x20 KTX2").toBe(png.reads);
  // The block-compressed upload ignores invertY; the ResourceCache wrapper flips V instead.
  expect(blockCompressed, "12x24 KTX2 reached the GPU block-compressed").toBe(true);
  expect(compressed.reads, "block-compressed 12x24 KTX2").toBe(png.reads);
  // The 10×20 KTX2 was drawn, and never block-compressed.
  expect(offBlockGrid(rgba.compressed)).toEqual([]);
  expect(gpuFailures).toEqual([]);
});

/**
 * A 2D scene on `backend` with one 2D Texture showing the whole 12×24
 * Texture, green over red, scaled to span several viewport samples: drawn
 * upright its green samples all sit above its red ones.
 */
async function textureQuadScene(page: Page, backend: Backend, source: "png" | "ktx2"): Promise<Map<string, Uint8Array>> {
  const { files, startupSceneGuid } = await projectFiles(backend);
  await addTwoToneTexture(page, files, 12, 24, source);
  const scene = createDefaultScene("2d");
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

/** Opens the 2D Texture scene and reads it once both tones show; on WebGPU also returns the recorded compressed textures. */
async function drawTextureQuad(
  page: Page,
  testInfo: TestInfo,
  backend: Backend,
  source: "png" | "ktx2",
): Promise<TileReading & { compressed: CompressedTexture[] | null }> {
  await openMinimalTestProject(page, await textureQuadScene(page, backend, source));
  await openMainScene(page);
  let proof: ViewportProofResult | undefined;
  let reading: TileReading | undefined;
  await expect(async () => {
    proof = await viewportProof(page, testInfo, `texture2d-${backend}-${source}`, { skyboxPoints: GRID_POINTS });
    reading = quadReading(proof);
    expect(Math.min(reading.green, reading.red), source).toBeGreaterThan(0);
  }).toPass({ timeout: 60_000 });
  expect(proof!.backend, source).toBe(backend);
  return { ...reading!, compressed: await compressedGpuTextures(page) };
}

test("WebGPU draws a block-compressed KTX2 on a 2D Texture the same way up as its PNG", async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  const { gpuFailures } = watchGpuFailures(page);
  await page.addInitScript(recordCompressedGpuTextures);
  const readings: Record<string, TileReading & { compressed: CompressedTexture[] }> = {};
  for (const source of ["png", "ktx2"] as const) {
    const { compressed: recorded, ...reading } = await drawTextureQuad(page, testInfo, "webgpu", source);
    expect(recorded, source).not.toBeNull();
    readings[source] = { ...reading, compressed: recorded! };
  }
  const { png, ktx2 } = readings as Record<"png" | "ktx2", TileReading & { compressed: CompressedTexture[] }>;
  const blockCompressed = ktx2.compressed.some((texture) => texture.width === 12 && texture.height === 24);
  await testInfo.attach("texture2d-orientation", { body: JSON.stringify({ readings, blockCompressed, gpuFailures }), contentType: "application/json" });
  expect(png.reads).toBe("upright");
  expect(blockCompressed, "12x24 KTX2 reached the GPU block-compressed").toBe(true);
  expect(ktx2.reads, "block-compressed 12x24 KTX2").toBe(png.reads);
  expect(gpuFailures).toEqual([]);
});

test("WebGL2 draws a KTX2 on a 2D Texture the same way up as its PNG", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  // Software GL decodes the KTX2 to RGBA: an unflipped upload whose V flip comes from the GLSL texture matrix.
  const png = await drawTextureQuad(page, testInfo, "webgl2", "png");
  const ktx2 = await drawTextureQuad(page, testInfo, "webgl2", "ktx2");
  await testInfo.attach("texture2d-webgl2-orientation", { body: JSON.stringify({ png, ktx2 }), contentType: "application/json" });
  expect(png.reads).toBe("upright");
  expect(ktx2.reads, "12x24 KTX2").toBe(png.reads);
});
