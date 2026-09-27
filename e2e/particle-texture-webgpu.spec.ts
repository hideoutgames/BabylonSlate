import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { ATLAS_TEXTURES_META } from "../packages/assets/src/atlas-textures";
import { encodeAssetDocument } from "../packages/assets/src/asset-document";
import { importImage } from "../packages/assets/src/importers/image";
import { sniffKtx2Size } from "../packages/assets/src/ktx2-info";
import { createNodeBasisEncodeFn } from "../packages/assets/src/node-basis-encode";
import { textureEncodeSettingsFor } from "../packages/assets/src/resolve-gpu-texture";
import { minimalProjectFiles } from "../packages/assets/src/test-support/minimal-project";
import { DEFAULT_TEXTURE_ENCODE_SETTINGS, textureEncodeChunkId } from "../packages/assets/src/texture-compression";
import { createDefaultTilesetPayload } from "../packages/assets/src/tileset-payload";
import { PROJECT_FILE } from "../packages/core/src/project";
import type { EngineSceneDiagnostics } from "../apps/editor/src/testing/webgpu-previews-proof";
import {
  addMaterialPaletteNode,
  compileMaterialPreview,
  connectMaterialPins,
  guidForPath,
  importAlbedoTexture,
  pickMaterialNodeTexture,
} from "./material-graph";
import { openMinimalTestProject } from "./minimal-project";
import {
  createContentBrowserAsset,
  openAssetFromBrowser,
  openMainScene,
} from "./open-test-project";
import { saveAllIfEnabled } from "./save-all";
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

const TEXTURE_PATH = "assets/albedo.babasset";

async function engineBackend(page: Page): Promise<string | null> {
  return page.evaluate(async () => {
    const host = globalThis as unknown as {
      __babylonslateViewportTest?: {
        engineSceneDiagnostics: () => Promise<EngineSceneDiagnostics | null>;
      };
    };
    return (await host.__babylonslateViewportTest?.engineSceneDiagnostics())?.backend ?? null;
  });
}

/** Registry compression state and the committed KTX2's header size. */
async function committedEncode(page: Page): Promise<{
  compressionState: string | null;
  ktx2: { width: number; height: number } | null;
}> {
  const state = await page.evaluate(async (path) => {
    const api = (
      globalThis as {
        __babylonslateTest?: {
          textureEncodeState?: (path: string) => {
            compressionState: string | null;
            ktx2ChunkId: string | null;
          } | null;
          readAssetChunk?: (path: string, chunkId: string) => Promise<Uint8Array | null>;
        };
      }
    ).__babylonslateTest;
    const current = api?.textureEncodeState?.(path) ?? null;
    // A read that races the registry rewriting the file fails; the poll reads again.
    const bytes = current?.ktx2ChunkId
      ? await api?.readAssetChunk?.(path, current.ktx2ChunkId).catch(() => null)
      : null;
    return {
      compressionState: current?.compressionState ?? null,
      header: bytes ? Array.from(bytes.subarray(0, 32)) : null,
    };
  }, TEXTURE_PATH);
  return {
    compressionState: state.compressionState,
    ktx2: state.header ? sniffKtx2Size(new Uint8Array(state.header)) : null,
  };
}

/** The minimal project (plus `extraFiles`) seeded with `gpuBackend: "webgpu"`, its viewport Engine on WebGPU. */
async function openWebGpuProject(page: Page, extraFiles: ReadonlyMap<string, Uint8Array> = new Map()): Promise<void> {
  await page.addInitScript(recordCompressedGpuTextures);
  const files = await minimalProjectFiles();
  const project = JSON.parse(new TextDecoder().decode(files.get(PROJECT_FILE)!));
  project.settings.render.gpuBackend = "webgpu";
  files.set(PROJECT_FILE, new TextEncoder().encode(JSON.stringify(project)));
  for (const [filePath, bytes] of extraFiles) files.set(filePath, bytes);
  await openMinimalTestProject(page, files);
  // The viewport installs diagnostics for the Engine shared by previews.
  await openMainScene(page);
  await expect.poll(() => engineBackend(page)).toBe("webgpu");
}

const ATLAS_TEXTURE_GUID = "00000000-0000-4000-8000-000000000081";

/**
 * `albedo.png` (1×1 red) as a `compressed` Albedo Texture committed as a red
 * 1×1 KTX2 under the id the registry computes, and a Tileset whose header
 * lists it as an atlas: it stays off the 4×4 grid, so WebGPU decodes it to RGBA.
 */
async function atlasTextureFiles(): Promise<Map<string, Uint8Array>> {
  const png = new Uint8Array(await readFile(path.join(process.cwd(), "e2e/fixtures/albedo.png")));
  const [texture] = await importImage(png, { fileName: "albedo.png", existingGuids: new Set() });
  const settings = textureEncodeSettingsFor(texture!.payload, DEFAULT_TEXTURE_ENCODE_SETTINGS, "albedo", { atlas: true });
  const chunkId = await textureEncodeChunkId(settings, "albedo");
  const encode = createNodeBasisEncodeFn(() => ({ rgba: new Uint8Array([255, 0, 0, 255]), width: 1, height: 1 }));
  const { ktx2 } = await encode(new Uint8Array(0), settings);
  expect(sniffKtx2Size(ktx2)).toEqual({ width: 1, height: 1 });
  const payload = { ...texture!.payload, compressionState: "compressed", ktx2ChunkId: chunkId };
  const tileset = { ...createDefaultTilesetPayload(), textureGuid: ATLAS_TEXTURE_GUID, atlasWidth: 1, atlasHeight: 1, tileWidth: 1, tileHeight: 1 };
  return new Map([
    [TEXTURE_PATH, await encodeAssetDocument(
      { guid: ATLAS_TEXTURE_GUID, type: "Texture", name: "albedo", version: texture!.version, payload },
      { headerPayload: payload, extraChunks: [...texture!.chunks, { id: chunkId, kind: "ktx2", mime: "image/ktx2", data: ktx2 }] },
    )],
    ["assets/Embers.tileset.babasset", await encodeAssetDocument(
      { guid: "00000000-0000-4000-8000-000000000082", type: "Tileset", name: "Embers", version: 1, payload: tileset },
      { headerMeta: { [ATLAS_TEXTURES_META]: [ATLAS_TEXTURE_GUID] } },
    )],
  ]);
}

/** Resolves once the editor's texture alignment pass ran and is idle, with the Textures it requeued. */
async function settledAlignmentPass(page: Page): Promise<string[]> {
  let requeued: string[] = [];
  await expect.poll(async () => {
    const state = await page.evaluate(() => (globalThis as {
      __babylonslateTest?: { textureAlignment?: () => { runs: number; pending: number; requeued: string[] } };
    }).__babylonslateTest?.textureAlignment?.() ?? null);
    requeued = state?.requeued ?? [];
    return state !== null && state.runs > 0 && state.pending === 0;
  }, { timeout: 60_000 }).toBe(true);
  return requeued;
}

/** A Particle-domain Material whose Texture Sample (unwired UV reads particle_uv) drives Color. */
async function createTextureParticleMaterial(page: Page, name: string, textureGuid: string): Promise<string> {
  const materialPath = `assets/${name}.material.babasset`;
  await createContentBrowserAsset(page, "Material", name);
  await openAssetFromBrowser(page, materialPath);
  await expect(page.getByTestId("document-workspace-material")).toBeVisible();
  await chooseOption(page, "property-domain", "Particle");
  const materialGuid = await guidForPath(page, materialPath);
  expect(materialGuid.length).toBeGreaterThan(0);
  await addMaterialPaletteNode(page, "Texture Sample", "texture.sample");
  await pickMaterialNodeTexture(page, textureGuid);
  await connectMaterialPins(page, "texture.sample-", "rgba", '[data-id="output"]', "color");
  await expect(
    page
      .getByTestId("material-graph-editor")
      .locator('.react-flow__edge[data-id*=":rgba:output:color"]'),
  ).toHaveCount(1);
  return materialGuid;
}

async function closeDocumentTab(page: Page, kind: string): Promise<void> {
  await page
    .locator(`[data-testid="document-tab"][data-document-kind="${kind}"]`)
    .getByTestId("document-tab-close")
    .click();
  await expect(page.getByTestId("dirty-close-dialog")).toHaveCount(0);
  await expect(page.getByTestId(`document-workspace-${kind}`)).toHaveCount(0);
}

async function pickAsset(page: Page, pickerTestId: string, guid: string): Promise<void> {
  await expect(page.getByTestId(pickerTestId)).toBeVisible();
  await page.getByTestId(`search-item-${guid}`).click();
  await expect(page.getByTestId(pickerTestId)).toHaveCount(0);
}

async function chooseOption(page: Page, testId: string, option: string): Promise<void> {
  await page.getByTestId(testId).click();
  await page.getByRole("option", { name: option, exact: true }).click();
  await expect(page.getByTestId(testId)).toContainText(option);
}

test("An odd-sized Albedo import encodes 4x4 and draws block-compressed on WebGPU", async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  const { gpuFailures, consoleProblems } = watchGpuFailures(page);
  await openWebGpuProject(page);

  // albedo.png is 1x1: a compressed non-atlas encode rounds up to the 4x4 block grid.
  const textureGuid = await importAlbedoTexture(page);
  const importEncode = { compressionState: "compressed", ktx2: { width: 4, height: 4 } };
  await expect.poll(() => committedEncode(page), { timeout: 60_000 }).toEqual(importEncode);

  const materialGuid = await createTextureParticleMaterial(page, "SparksMat", textureGuid);
  await compileMaterialPreview(page);
  await saveAllIfEnabled(page);

  await createContentBrowserAsset(page, "ParticleEmitter", "Sparks");
  await openAssetFromBrowser(page, "assets/Sparks.emitter.babasset");
  const preview = page.getByTestId("particle-emitter-preview");
  const canvas = page.getByTestId("particle-emitter-preview-canvas");
  await expect(preview.getByTestId("particle-preview-empty")).toContainText("No Material");
  await preview.getByTestId("particle-preview-action").click();
  await pickAsset(page, "particle-preview-material-picker", materialGuid);
  const run = previewDraw();
  let compressed: CompressedTexture[] | null = null;
  let backend: string | null = null;
  try {
    await expectPreviewDraws(preview, canvas, "red", run);
  } finally {
    await canvas.screenshot({ path: testInfo.outputPath("particle-texture-webgpu.png") }).catch(() => undefined);
    compressed = await compressedGpuTextures(page).catch(() => null);
    backend = await engineBackend(page).catch(() => null);
    await testInfo.attach("particle-texture-webgpu", {
      body: JSON.stringify({
        backend, importEncode, compressed, ...run, gpuFailures, consoleProblems,
        previewFailed: await preview.getByTestId("particle-preview-failed").textContent({ timeout: 1_000 }).catch(() => null),
      }),
      contentType: "application/json",
    });
  }

  expect(Math.min(run.steady.matched, run.steady.moved)).toBeGreaterThan(200);
  expect(backend).toBe("webgpu");
  // The KTX2 reached the GPU as a 4x4 block-compressed texture, not the PNG fallback.
  expect(compressed).toContainEqual(expect.objectContaining({ width: 4, height: 4 }));
  expect(offBlockGrid(compressed!)).toEqual([]);
  expect(gpuFailures).toEqual([]);
});

test("A running emitter Preview draws a 1x1 atlas KTX2 on WebGPU and rebinds its Particle re-encode without Retry", async ({ page }, testInfo) => {
  test.setTimeout(300_000);
  const { gpuFailures, consoleProblems } = watchGpuFailures(page);
  await openWebGpuProject(page, await atlasTextureFiles());

  // A Tileset uses the 1x1 Albedo Texture, so its compressed 1x1 KTX2 stays off the 4x4 block grid.
  expect(await settledAlignmentPass(page)).not.toContain(ATLAS_TEXTURE_GUID);
  expect(await committedEncode(page)).toEqual({ compressionState: "compressed", ktx2: { width: 1, height: 1 } });
  const materialGuid = await createTextureParticleMaterial(page, "EmberMat", ATLAS_TEXTURE_GUID);
  await saveAllIfEnabled(page);
  // Mounted tabs keep their previews; only the emitter Preview may hold the texture.
  await closeDocumentTab(page, "material");

  const emitterPath = "assets/Sparks.emitter.babasset";
  await createContentBrowserAsset(page, "ParticleEmitter", "Sparks");
  await openAssetFromBrowser(page, emitterPath);
  const details = page.getByTestId("particle-emitter-details-panel");
  await details.getByTestId("property-material").click();
  await pickAsset(page, "particle-emitter-material-picker", materialGuid);
  await expect(details.getByTestId("property-material")).toContainText(/EmberMat/);
  await saveAllIfEnabled(page);
  const preview = page.getByTestId("particle-emitter-preview");
  const canvas = page.getByTestId("particle-emitter-preview-canvas");

  const albedoRun = previewDraw();
  const particleRun = previewDraw();
  let albedoCompressed: CompressedTexture[] | null = null;
  let failuresBeforeRebind: string[] = [];
  let failuresBeforeDraw: string[] = [];
  let failuresWhileDrawing: string[] = [];
  let compressed: CompressedTexture[] | null = null;
  try {
    // The 1x1 Texture draws rather than showing No Material, and nothing reaches the GPU compressed off the grid.
    // (Only texture-webgpu-fallback.spec.ts can tell a KTX2 draw from a source PNG one.)
    await expectPreviewDraws(preview, canvas, "red", albedoRun);
    await expect(preview.getByTestId("particle-preview-empty")).toHaveCount(0);
    albedoCompressed = await compressedGpuTextures(page);
    failuresBeforeRebind = [...gpuFailures];

    // Particle Usage always re-encodes block-aligned, atlas or not; the Preview keeps running meanwhile.
    await page.evaluate(() => {
      const host = globalThis as { __compressedGpuTextures?: unknown[] };
      host.__compressedGpuTextures?.splice(0);
    });
    await openAssetFromBrowser(page, TEXTURE_PATH);
    await expect(page.getByTestId("texture-details")).toBeVisible();
    await chooseOption(page, "property-usage", "Particle");
    const particleEncode = { compressionState: "compressed", ktx2: { width: 4, height: 4 } };
    await expect.poll(() => committedEncode(page), { timeout: 60_000 }).toEqual(particleEncode);
    await saveAllIfEnabled(page);
    await expect.poll(() => committedEncode(page)).toEqual(particleEncode);
    await openAssetFromBrowser(page, emitterPath);

    // Without Retry, the running Preview rebinds the re-encode: the 4x4 KTX2 reaches the GPU.
    await expect
      .poll(() => compressedGpuTextures(page), { timeout: 30_000 })
      .toContainEqual(expect.objectContaining({ width: 4, height: 4 }));
    await expectPreviewDraws(preview, canvas, "red", particleRun, () => {
      failuresBeforeDraw = [...gpuFailures];
    });
    failuresWhileDrawing = gpuFailures.slice(failuresBeforeDraw.length);
  } finally {
    await canvas.screenshot({ path: testInfo.outputPath("particle-texture-rebind.png") }).catch(() => undefined);
    compressed = await compressedGpuTextures(page).catch(() => null);
    await testInfo.attach("particle-texture-rebind", {
      body: JSON.stringify({
        albedoCompressed, compressed, albedoRun, particleRun, failuresBeforeRebind, gpuFailures, consoleProblems,
        previewFailed: await preview.getByTestId("particle-preview-failed").textContent({ timeout: 1_000 }).catch(() => null),
      }),
      contentType: "application/json",
    });
  }
  expect(Math.min(albedoRun.steady.matched, albedoRun.steady.moved)).toBeGreaterThan(200);
  // The 1x1 KTX2 never reached the GPU block-compressed.
  expect(offBlockGrid(albedoCompressed ?? [])).toEqual([]);
  expect(failuresBeforeRebind).toEqual([]);
  expect(Math.min(particleRun.steady.matched, particleRun.steady.moved)).toBeGreaterThan(200);
  expect(failuresBeforeDraw).toEqual([]);
  expect(failuresWhileDrawing).toEqual([]);
  expect(compressed).toContainEqual(expect.objectContaining({ width: 4, height: 4 }));
  expect(offBlockGrid(compressed!)).toEqual([]);
  expect(gpuFailures).toEqual([]);
});
