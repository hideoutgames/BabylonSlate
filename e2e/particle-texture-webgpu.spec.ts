import { expect, test, type Locator, type Page } from "@playwright/test";
import { sniffKtx2Size } from "../packages/assets/src/ktx2-info";
import { minimalProjectFiles } from "../packages/assets/src/test-support/minimal-project";
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

// Explicit software adapter admission for this functional proof, not GPU qualification.
test.use({ launchOptions: { args: SOFTWARE_WEBGPU_ARGS } });

const TEXTURE_PATH = "assets/albedo.babasset";
/** WebGPU rejects a block-compressed texture whose size is not whole 4x4 blocks. */
const GPU_FAILURE = /GPUValidationError|not a multiple of the block|Invalid CommandBuffer/;

type CompressedTexture = { format: string; width: number; height: number };

/**
 * Init script: records every block-compressed WebGPU texture (the KTX2
 * transcode targets). A source PNG fallback uploads rgba8 and is not listed.
 */
function recordCompressedGpuTextures(): void {
  type Descriptor = { format: string; size: number[] | { width: number; height?: number } };
  const host = globalThis as {
    GPUDevice?: { prototype: { createTexture(descriptor: Descriptor): unknown } };
    __compressedGpuTextures?: CompressedTexture[];
  };
  const device = host.GPUDevice?.prototype;
  if (!device) return;
  const created: CompressedTexture[] = [];
  host.__compressedGpuTextures = created;
  const createTexture = device.createTexture;
  device.createTexture = function (this: unknown, descriptor: Descriptor) {
    if (/^(bc|astc|etc2|eac)/.test(descriptor.format)) {
      const size = descriptor.size;
      const [width = 1, height = 1] = Array.isArray(size) ? size : [size.width, size.height];
      created.push({ format: descriptor.format, width, height });
    }
    return createTexture.call(this, descriptor);
  };
}

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
    const bytes = current?.ktx2ChunkId
      ? await api?.readAssetChunk?.(path, current.ktx2ChunkId)
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

/** Pure-red fixture pixels, and pixels that change over 600 ms (p17's motion diff). */
async function previewPixels(canvas: Locator): Promise<{ red: number; moved: number }> {
  return canvas.evaluate(async (node: HTMLCanvasElement) => {
    const context = node.getContext("2d");
    if (!context) return { red: 0, moved: 0 };
    const before = context.getImageData(0, 0, node.width, node.height).data;
    await new Promise((resolve) => setTimeout(resolve, 600));
    const after = context.getImageData(0, 0, node.width, node.height).data;
    let red = 0;
    let moved = 0;
    for (let i = 0; i < Math.min(before.length, after.length); i += 4) {
      if (after[i]! > 150 && after[i + 1]! < 90 && after[i + 2]! < 90) red += 1;
      if (Math.abs(before[i]! - after[i]!) > 32) moved += 1;
    }
    return { red, moved };
  });
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

test("Particle Usage texture draws from its block-aligned KTX2 on WebGPU", async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  const gpuFailures: string[] = [];
  const consoleProblems: string[] = [];
  page.on("console", (message) => {
    const line = `[${message.type()}] ${message.text()}`;
    if (GPU_FAILURE.test(message.text())) gpuFailures.push(line);
    if (["error", "warning"].includes(message.type()) && consoleProblems.length < 50) consoleProblems.push(line.slice(0, 500));
  });
  page.on("pageerror", (error) => {
    if (GPU_FAILURE.test(error.message)) gpuFailures.push(`[pageerror] ${error.message}`);
  });
  await page.addInitScript(recordCompressedGpuTextures);
  const files = await minimalProjectFiles();
  const project = JSON.parse(new TextDecoder().decode(files.get(PROJECT_FILE)!));
  project.settings.render.gpuBackend = "webgpu";
  files.set(PROJECT_FILE, new TextEncoder().encode(JSON.stringify(project)));
  await openMinimalTestProject(page, files);
  // The viewport installs diagnostics for the Engine shared by previews.
  await openMainScene(page);
  await expect.poll(() => engineBackend(page)).toBe("webgpu");

  // albedo.png is 1x1: it encodes unaligned until its Usage is Particle.
  const textureGuid = await importAlbedoTexture(page);
  await expect.poll(async () => (await committedEncode(page)).compressionState, {
    timeout: 60_000,
  }).toBe("compressed");
  const importEncode = await committedEncode(page);
  await openAssetFromBrowser(page, TEXTURE_PATH);
  await expect(page.getByTestId("texture-details")).toBeVisible();
  await chooseOption(page, "property-usage", "Particle");
  // Save only after the Particle encode commits: the preview resolves the saved Usage.
  const particleEncode = { compressionState: "compressed", ktx2: { width: 4, height: 4 } };
  await expect.poll(() => committedEncode(page), { timeout: 60_000 }).toEqual(particleEncode);
  await saveAllIfEnabled(page);
  // The Texture tab opened before that encode; saving it must keep the 4x4 KTX2 export packs.
  await expect.poll(() => committedEncode(page)).toEqual(particleEncode);

  // Texture Sample with unwired UV reads particle_uv.
  const materialPath = "assets/SparksMat.material.babasset";
  await createContentBrowserAsset(page, "Material", "SparksMat");
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
  await compileMaterialPreview(page);
  await saveAllIfEnabled(page);

  await createContentBrowserAsset(page, "ParticleEmitter", "Sparks");
  await openAssetFromBrowser(page, "assets/Sparks.emitter.babasset");
  const preview = page.getByTestId("particle-emitter-preview");
  const failed = preview.getByTestId("particle-preview-failed");
  const canvas = page.getByTestId("particle-emitter-preview-canvas");
  await expect(preview.getByTestId("particle-preview-empty")).toContainText("No Material");
  await preview.getByTestId("particle-preview-action").click();
  await pickAsset(page, "particle-preview-material-picker", materialGuid);
  let boundAt = Date.now();
  let drawMs: number | null = null;
  let retries = 0;
  let firstDraw = { red: 0, moved: 0 };
  let steady = { red: 0, moved: 0 };
  let compressed: CompressedTexture[] | null = null;
  let backend: string | null = null;
  try {
    await expect(preview.getByTestId("particle-preview-backend")).toBeVisible({ timeout: 30_000 });
    await expect(async () => {
      // Software WebGPU preparation runs close to the Preview's 4 s stall deadline
      // (SCENE_SHADER_WARM_TIMEOUT_MS). Recover once through the product's Retry;
      // the GPU texture recorder and console checks still cover the first attempt.
      if (await failed.isVisible()) {
        const reason = (await failed.textContent()) ?? "";
        if (retries > 0 || !/timed out/i.test(reason)) throw new Error(`Particle Preview failed: ${reason}`);
        retries += 1;
        await failed.getByRole("button", { name: "Retry" }).click();
        boundAt = Date.now();
      }
      firstDraw = await previewPixels(canvas);
      expect(Math.min(firstDraw.red, firstDraw.moved)).toBeGreaterThan(200);
    }).toPass({ timeout: 60_000 });
    drawMs = Date.now() - boundAt;
    // Later frames keep drawing and moving (an invalid command buffer drops every frame).
    steady = await previewPixels(canvas);
  } finally {
    await canvas.screenshot({ path: testInfo.outputPath("particle-texture-webgpu.png") }).catch(() => undefined);
    compressed = await page.evaluate(
      () => (globalThis as { __compressedGpuTextures?: CompressedTexture[] }).__compressedGpuTextures ?? null,
    ).catch(() => null);
    backend = await engineBackend(page).catch(() => null);
    await testInfo.attach("particle-texture-webgpu", {
      body: JSON.stringify({
        backend, importEncode, compressed, drawMs, retries, firstDraw, steady, gpuFailures, consoleProblems,
        previewFailed: await failed.textContent({ timeout: 1_000 }).catch(() => null),
      }),
      contentType: "application/json",
    });
  }

  expect(Math.min(steady.red, steady.moved)).toBeGreaterThan(200);
  expect(backend).toBe("webgpu");
  // The Particle KTX2 reached the GPU as a 4x4 block-compressed texture, not the PNG fallback.
  expect(compressed).toContainEqual(expect.objectContaining({ width: 4, height: 4 }));
  expect(compressed!.filter((texture) => texture.width % 4 !== 0 || texture.height % 4 !== 0)).toEqual([]);
  expect(gpuFailures).toEqual([]);
});
