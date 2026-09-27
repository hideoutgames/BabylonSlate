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

type PreviewDraw = {
  retries: number;
  drawMs: number | null;
  firstDraw: { red: number; moved: number };
  steady: { red: number; moved: number };
};

/**
 * Waits until the Preview draws moving red particles, then samples a later
 * window into `run`. Software WebGPU preparation runs close to the Preview's
 * 4 s stall deadline (SCENE_SHADER_WARM_TIMEOUT_MS): a **Preview Failed** that
 * says it timed out is retried once through the product's Retry; any other
 * failure, or a second one, fails. `onDrawing` runs between the two samples.
 */
async function expectPreviewDraws(
  preview: Locator,
  canvas: Locator,
  run: PreviewDraw,
  onDrawing?: () => void,
): Promise<void> {
  const failed = preview.getByTestId("particle-preview-failed");
  let startedAt = Date.now();
  await expect(preview.getByTestId("particle-preview-backend").or(failed)).toBeVisible({ timeout: 30_000 });
  await expect(async () => {
    if (await failed.isVisible()) {
      const reason = (await failed.textContent()) ?? "";
      if (run.retries > 0 || !/timed out/i.test(reason)) throw new Error(`Particle Preview failed: ${reason}`);
      run.retries += 1;
      await failed.getByRole("button", { name: "Retry" }).click();
      startedAt = Date.now();
    }
    run.firstDraw = await previewPixels(canvas);
    expect(Math.min(run.firstDraw.red, run.firstDraw.moved)).toBeGreaterThan(200);
  }).toPass({ timeout: 60_000 });
  run.drawMs = Date.now() - startedAt;
  onDrawing?.();
  // Later frames keep drawing and moving (an invalid command buffer drops every frame).
  run.steady = await previewPixels(canvas);
}

/** GPU validation / block-size messages from the console and uncaught page errors. */
function watchGpuFailures(page: Page): { gpuFailures: string[]; consoleProblems: string[] } {
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
  return { gpuFailures, consoleProblems };
}

/** The minimal project seeded with `gpuBackend: "webgpu"`, its viewport Engine on WebGPU. */
async function openWebGpuProject(page: Page): Promise<void> {
  await page.addInitScript(recordCompressedGpuTextures);
  const files = await minimalProjectFiles();
  const project = JSON.parse(new TextDecoder().decode(files.get(PROJECT_FILE)!));
  project.settings.render.gpuBackend = "webgpu";
  files.set(PROJECT_FILE, new TextEncoder().encode(JSON.stringify(project)));
  await openMinimalTestProject(page, files);
  // The viewport installs diagnostics for the Engine shared by previews.
  await openMainScene(page);
  await expect.poll(() => engineBackend(page)).toBe("webgpu");
}

async function compressedGpuTextures(page: Page): Promise<CompressedTexture[] | null> {
  return page.evaluate(
    () => (globalThis as { __compressedGpuTextures?: CompressedTexture[] }).__compressedGpuTextures ?? null,
  );
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

test("Particle Usage texture draws from its block-aligned KTX2 on WebGPU", async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  const { gpuFailures, consoleProblems } = watchGpuFailures(page);
  await openWebGpuProject(page);

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
  const run: PreviewDraw = { retries: 0, drawMs: null, firstDraw: { red: 0, moved: 0 }, steady: { red: 0, moved: 0 } };
  let compressed: CompressedTexture[] | null = null;
  let backend: string | null = null;
  try {
    await expectPreviewDraws(preview, canvas, run);
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

  expect(Math.min(run.steady.red, run.steady.moved)).toBeGreaterThan(200);
  expect(backend).toBe("webgpu");
  // The Particle KTX2 reached the GPU as a 4x4 block-compressed texture, not the PNG fallback.
  expect(compressed).toContainEqual(expect.objectContaining({ width: 4, height: 4 }));
  expect(compressed!.filter((texture) => texture.width % 4 !== 0 || texture.height % 4 !== 0)).toEqual([]);
  expect(gpuFailures).toEqual([]);
});

test("Set Usage To Particle from a particle Material's Compiler Results saves an open, dirty Texture tab, re-encodes block-aligned and undoes", async ({ page }) => {
  test.setTimeout(180_000);
  // The warning does not depend on the backend: projects can run on WebGPU devices.
  await openMinimalTestProject(page);
  const textureGuid = await importAlbedoTexture(page);
  await expect.poll(async () => (await committedEncode(page)).compressionState, {
    timeout: 60_000,
  }).toBe("compressed");

  // An open, dirty Texture tab takes the fix as its own edit, as Texture Details does.
  // Albedo to Normal stays compressed and does not re-encode, so only the fix's encode runs.
  await openAssetFromBrowser(page, TEXTURE_PATH);
  await expect(page.getByTestId("texture-details")).toBeVisible();
  await chooseOption(page, "property-usage", "Normal");
  const textureTab = page.locator('[data-testid="document-tab"][data-document-kind="texture"]');
  await expect(textureTab).toContainText("*");

  await createTextureParticleMaterial(page, "EmberMat", textureGuid);

  // albedo.png is 1x1 and its open tab's Usage is compressed: a 1x1 KTX2 that WebGPU rejects.
  const warning = 'Texture "albedo" is 1×1; set its Usage to Particle so it loads on WebGPU.';
  const row = page.getByTestId("material-diagnostic-particle.texture_block_align");
  await expect(row).toHaveAttribute("data-severity", "warning");
  await expect(row).toContainText(warning);
  await page.getByTestId("material-diagnostic-particle.texture_block_align-action").click();
  // The edit clears the warning, and the tab is saved with it (and its pending Normal edit).
  await expect(row).toHaveCount(0);
  const notification = page.getByTestId(`texture-usage-notification-${textureGuid}`);
  await expect(notification).toContainText('Texture "albedo" now uses Particle Usage.');
  await expect(textureTab).not.toContainText("*");
  await expect.poll(() => committedEncode(page), { timeout: 60_000 }).toEqual({
    compressionState: "compressed",
    ktx2: { width: 4, height: 4 },
  });

  // Undo restores the Usage the open tab had, saved again, so the warning returns.
  await notification.getByTestId(`texture-usage-undo-${textureGuid}`).click();
  await expect(notification).toHaveCount(0);
  await expect(row).toContainText(warning);
  await expect(textureTab).not.toContainText("*");
  await textureTab.getByTestId("document-tab-select").click();
  await expect(page.getByTestId("property-usage")).toContainText("Normal");
  await expect(textureTab).not.toContainText("*");
});

test("Set Usage To Particle from a Basic emitter clears the warning on every surface and draws on WebGPU", async ({ page }, testInfo) => {
  test.setTimeout(300_000);
  const { gpuFailures, consoleProblems } = watchGpuFailures(page);
  await openWebGpuProject(page);
  const warning = 'Texture "albedo" is 1×1; set its Usage to Particle so it loads on WebGPU.';

  // albedo.png is 1x1 with Albedo Usage: a compressed 1x1 KTX2 that WebGPU rejects.
  const textureGuid = await importAlbedoTexture(page);
  await expect.poll(() => committedEncode(page), { timeout: 60_000 }).toEqual({
    compressionState: "compressed",
    ktx2: { width: 1, height: 1 },
  });

  const materialGuid = await createTextureParticleMaterial(page, "EmberMat", textureGuid);
  const materialRow = page.getByTestId("material-diagnostic-particle.texture_block_align");
  await expect(materialRow).toBeVisible();
  await expect(materialRow).toHaveAttribute("data-severity", "warning");
  await expect(materialRow).toContainText(warning);
  await expect(page.getByTestId("material-diagnostic-particle.texture_block_align-action")).toHaveText(
    "Set Usage To Particle",
  );
  await saveAllIfEnabled(page);
  // Mounted tabs keep their previews; only the emitter Preview may hold the 1x1 texture.
  await closeDocumentTab(page, "material");

  await createContentBrowserAsset(page, "ParticleGraph", "Embers");
  await openAssetFromBrowser(page, "assets/Embers.particlegraph.babasset");
  const graphPreview = page.getByTestId("particle-graph-preview");
  await graphPreview.getByTestId("particle-preview-action").click();
  await pickAsset(page, "particle-preview-material-picker", materialGuid);
  const graphResults = page.getByTestId("particle-graph-compiler-results");
  const graphRow = graphResults.getByTestId("particle-graph-diagnostic-particle.texture_block_align");
  await expect(graphRow).toBeVisible();
  await expect(graphRow).toHaveAttribute("data-severity", "warning");
  await expect(graphRow).toContainText(warning);
  await expect(graphResults.getByTestId("particle-graph-diagnostic-particle.texture_block_align-action")).toHaveText(
    "Set Usage To Particle",
  );
  // A warning, not an error: the graph still builds and runs its Preview.
  await expect(graphPreview.getByTestId("particle-preview-backend")).toHaveText("CPU", { timeout: 30_000 });
  await saveAllIfEnabled(page);
  await closeDocumentTab(page, "particle-graph");

  await createContentBrowserAsset(page, "ParticleEmitter", "Sparks");
  await openAssetFromBrowser(page, "assets/Sparks.emitter.babasset");
  const details = page.getByTestId("particle-emitter-details-panel");
  await details.getByTestId("property-material").click();
  await pickAsset(page, "particle-emitter-material-picker", materialGuid);
  await expect(details.getByTestId("property-material")).toContainText(/EmberMat/);
  const notice = details.getByTestId("particle-texture-usage-notice");
  await expect(notice).toContainText(warning);
  const fix = notice.getByTestId(`particle-texture-usage-fix-${textureGuid}`);
  await expect(fix).toHaveText("Set Usage To Particle");
  const preview = page.getByTestId("particle-emitter-preview");
  const canvas = page.getByTestId("particle-emitter-preview-canvas");
  // Let the Preview load the 1x1 texture first, so the fix must reach a running Preview.
  await expect(
    preview.getByTestId("particle-preview-backend").or(preview.getByTestId("particle-preview-failed")),
  ).toBeVisible({ timeout: 30_000 });
  await saveAllIfEnabled(page);

  // One click: the Texture tab is closed, so the Usage saves at once and re-encodes.
  await page.evaluate(() => {
    const host = globalThis as { __compressedGpuTextures?: unknown[] };
    host.__compressedGpuTextures?.splice(0);
  });
  await fix.click();
  await expect(notice).toHaveCount(0);
  await expect(details.getByTestId(`texture-usage-notification-${textureGuid}`)).toContainText(
    'Texture "albedo" now uses Particle Usage.',
  );
  await expect.poll(() => committedEncode(page), { timeout: 60_000 }).toEqual({
    compressionState: "compressed",
    ktx2: { width: 4, height: 4 },
  });

  const run: PreviewDraw = { retries: 0, drawMs: null, firstDraw: { red: 0, moved: 0 }, steady: { red: 0, moved: 0 } };
  let failuresBeforeDraw = 0;
  let failuresWhileDrawing: string[] = [];
  let compressed: CompressedTexture[] | null = null;
  try {
    // Without Retry, the running Preview rebinds the re-encode: the 4x4 KTX2 reaches the GPU.
    await expect
      .poll(() => compressedGpuTextures(page), { timeout: 30_000 })
      .toContainEqual(expect.objectContaining({ width: 4, height: 4 }));
    // Frames bound to the 1x1 texture fail until the Preview rebinds; count from the first good draw.
    await expectPreviewDraws(preview, canvas, run, () => {
      failuresBeforeDraw = gpuFailures.splice(0).length;
    });
    failuresWhileDrawing = [...gpuFailures];
  } finally {
    await canvas.screenshot({ path: testInfo.outputPath("particle-texture-usage-fix.png") }).catch(() => undefined);
    compressed = await compressedGpuTextures(page).catch(() => null);
    await testInfo.attach("particle-texture-usage-fix", {
      body: JSON.stringify({
        compressed, ...run, failuresBeforeDraw, gpuFailures, consoleProblems,
        previewFailed: await preview.getByTestId("particle-preview-failed").textContent({ timeout: 1_000 }).catch(() => null),
      }),
      contentType: "application/json",
    });
  }
  expect(Math.min(run.steady.red, run.steady.moved)).toBeGreaterThan(200);
  expect(failuresWhileDrawing).toEqual([]);
  // After the click the texture reached the GPU as 4x4 blocks, never off the 4-texel grid.
  expect(compressed).toContainEqual(expect.objectContaining({ width: 4, height: 4 }));
  expect(compressed!.filter((texture) => texture.width % 4 !== 0 || texture.height % 4 !== 0)).toEqual([]);

  // The warning is gone from the other surfaces too.
  await openAssetFromBrowser(page, "assets/Embers.particlegraph.babasset");
  await expect(graphResults).toContainText("No Issues");
  await expect(graphResults.getByTestId("particle-graph-diagnostic-particle.texture_block_align")).toHaveCount(0);
  await openAssetFromBrowser(page, "assets/EmberMat.material.babasset");
  await expect(page.getByTestId("material-compiler-results")).toBeVisible();
  await expect(materialRow).toHaveCount(0);
  await openAssetFromBrowser(page, TEXTURE_PATH);
  await expect(page.getByTestId("property-usage")).toContainText("Particle");
  expect(gpuFailures).toEqual([]);
});
