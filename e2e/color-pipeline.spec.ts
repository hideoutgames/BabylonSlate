import { expect, test, type Locator, type Page } from "@playwright/test";
import { loadPlayerDistFiles } from "../apps/editor/src/services/load-player-files";
import {
  createActor,
  createDefaultScene,
  createMeshComponent,
  DEFAULT_RENDER_EFFECTS,
  DEFAULT_RENDER_PROJECT_SETTINGS,
  type RenderProjectSettings,
  type SerializedScene,
} from "../packages/core/src/index.ts";
import { exportGame, PREVIEW_STOP_MESSAGE } from "../packages/exporter/src/index.ts";
import { createDefaultMaterialDocument, type MaterialDocument } from "../packages/shader-graph/src/document.ts";
import { encodeAssetDocument } from "../packages/assets/src/asset-document";
import { MATERIAL_PAYLOAD_VERSION } from "../packages/assets/src/migration";
import { minimalProjectFiles } from "../packages/assets/src/test-support/minimal-project";
import { serveExportFiles } from "./export-static-server";
import { openMinimalTestProject } from "./minimal-project";
import { openMainScene } from "./open-test-project";
import { setPreviewScene } from "./preview-parity";
import { SOFTWARE_WEBGPU_ARGS } from "./software-webgpu";

test.use({ launchOptions: { args: SOFTWARE_WEBGPU_ARGS } });

const SCENE_GUID = "00000000-0000-4000-8000-000000000041";
const MAT_HOT = "00000000-0000-4000-8000-000000000042";
const MAT_EDGE = "00000000-0000-4000-8000-000000000043";
const MAT_WALL = "00000000-0000-4000-8000-000000000044";

/** PBR surface with black albedo and an HDR emissive term. */
function emissiveDoc(
  name: string,
  rgb: [number, number, number],
): MaterialDocument {
  const doc = createDefaultMaterialDocument(name);
  doc.nodes[0]!.properties = { value: [0, 0, 0] };
  doc.nodes.push({
    id: "emit",
    type: "const.color",
    position: { x: 0, y: 90 },
    properties: { value: rgb },
  });
  doc.edges.push({
    id: "e-emit",
    sourceNodeId: "emit",
    sourcePinId: "out",
    targetNodeId: "output",
    targetPinId: "emissive",
  });
  return doc;
}

/** Unlit display-space surface; uniform regardless of lighting or pipeline. */
function unlitDoc(
  name: string,
  rgb: [number, number, number],
): MaterialDocument {
  const doc = createDefaultMaterialDocument(name);
  doc.shadingModel = "unlit";
  doc.twoSided = true;
  doc.nodes[0]!.properties = { value: rgb };
  return doc;
}

function meshActor(
  id: string,
  name: string,
  meshKind: string,
  materialGuid: string | null,
  position: [number, number, number],
  scale: [number, number, number],
) {
  const mesh = createMeshComponent(`${id}-mesh`, meshKind);
  mesh.properties.materialGuid = materialGuid;
  return createActor(id, name, {
    transform: { position, rotation: [0, 0, 0, 1], scale },
    components: [mesh],
  });
}

/**
 * One frame covering every check: a uniform gray wall (vignette field), an
 * over-bright emissive quad (bloom + ACES), a hard-edged white slab (FXAA)
 * and a sunlit PBR sphere (CEL band levels).
 */
function colorPipelineScene(): SerializedScene {
  const scene = createDefaultScene();
  scene.name = "Color Pipeline";
  scene.settings.environmentColor = [0, 0, 0];
  scene.settings.environmentTextureGuid = null;
  scene.settings.grid.showGrid = false;
  scene.actors = scene.actors.filter(
    (actor) =>
      actor.id === scene.settings.mainCameraActorId ||
      actor.components.some(
        (component) => component.classId === "LightComponent",
      ),
  );
  scene.actors.push(
    meshActor("wall", "Vignette Wall", "box", MAT_WALL, [0, 0, 12], [90, 50, 1]),
    meshActor("hot", "Overbright Quad", "box", MAT_HOT, [-1.5, -0.5, 0], [3, 3, 0.5]),
    meshActor("edge", "Hard Edge Slab", "box", MAT_EDGE, [6.5, -1, 0], [10, 14, 1]),
    meshActor("sphere", "Lit Sphere", "sphere", null, [-5, -1.5, 0], [2.5, 2.5, 2.5]),
  );
  return scene;
}

function fixtureMaterials(): Array<{
  guid: string;
  name: string;
  doc: MaterialDocument;
}> {
  return [
    { guid: MAT_HOT, name: "Hot", doc: emissiveDoc("Hot", [3, 3, 3]) },
    { guid: MAT_EDGE, name: "Edge", doc: emissiveDoc("Edge", [1, 1, 1]) },
    { guid: MAT_WALL, name: "Wall", doc: unlitDoc("Wall", [0.35, 0.35, 0.35]) },
  ];
}

async function framePixels(canvas: Locator): Promise<Buffer> {
  const encoded = await canvas.evaluate((node: HTMLCanvasElement) => {
    const copy = document.createElement("canvas");
    copy.width = node.width;
    copy.height = node.height;
    const context = copy.getContext("2d")!;
    context.drawImage(node, 0, 0);
    const pixels = context.getImageData(0, 0, copy.width, copy.height).data;
    let binary = "";
    for (let offset = 0; offset < pixels.length; offset += 8192)
      binary += String.fromCharCode(...pixels.subarray(offset, offset + 8192));
    return btoa(binary);
  });
  return Buffer.from(encoded, "base64");
}

/** A repeated signature means both the rebuild and the frame have settled. */
async function settledPixels(
  canvas: Locator,
  timeoutMs = 30_000,
): Promise<Buffer> {
  const deadline = Date.now() + timeoutMs;
  let signature = -1;
  for (;;) {
    const pixels = await framePixels(canvas);
    let hash = 0;
    for (let i = 0; i < pixels.length; i += 97)
      hash = (hash * 31 + pixels[i]!) | 0;
    if (hash === signature) return pixels;
    signature = hash;
    if (Date.now() > deadline)
      throw new Error("Canvas pixel signature never settled");
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

function luminance(pixels: Buffer, offset: number): number {
  return (
    (pixels[offset]! * 77 + pixels[offset + 1]! * 150 + pixels[offset + 2]! * 29) >>
    8
  );
}

type Box = { x0: number; y0: number; x1: number; y1: number; count: number };

/** The over-bright quad is the only saturating surface in the fixture. */
function hotBlob(pixels: Buffer, width: number, height: number): Box {
  const box: Box = { x0: width, y0: height, x1: -1, y1: -1, count: 0 };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      if (luminance(pixels, offset) < 245) continue;
      box.count++;
      if (x < box.x0) box.x0 = x;
      if (x > box.x1) box.x1 = x;
      if (y < box.y0) box.y0 = y;
      if (y > box.y1) box.y1 = y;
    }
  }
  return box;
}

/** Mean luminance in a band just outside the hot quad's silhouette. */
function bloomRingMean(
  pixels: Buffer,
  width: number,
  height: number,
  box: Box,
): number {
  let sum = 0;
  let count = 0;
  for (let y = Math.max(0, box.y0 - 14); y < Math.min(height, box.y1 + 14); y++) {
    for (let x = Math.max(0, box.x0 - 14); x < Math.min(width, box.x1 + 14); x++) {
      const inside =
        x >= box.x0 - 1 && x <= box.x1 + 1 && y >= box.y0 - 1 && y <= box.y1 + 1;
      if (inside) continue;
      sum += luminance(pixels, (y * width + x) * 4);
      count++;
    }
  }
  return count ? sum / count : 0;
}

function patchMean(
  pixels: Buffer,
  width: number,
  height: number,
  cx: number,
  cy: number,
  radius: number,
): number {
  let sum = 0;
  let count = 0;
  for (let y = Math.max(0, cy - radius); y <= Math.min(height - 1, cy + radius); y++) {
    for (let x = Math.max(0, cx - radius); x <= Math.min(width - 1, cx + radius); x++) {
      sum += luminance(pixels, (y * width + x) * 4);
      count++;
    }
  }
  return count ? sum / count : 0;
}

function cornerMean(pixels: Buffer, width: number, height: number): number {
  return (
    patchMean(pixels, width, height, 4, 4, 3) +
    patchMean(pixels, width, height, width - 5, 4, 3) +
    patchMean(pixels, width, height, 4, height - 5, 3) +
    patchMean(pixels, width, height, width - 5, height - 5, 3)
  ) / 4;
}

/**
 * Mid-tone pixels hugging the strongest vertical edge. A binary raster edge
 * produces almost none; FXAA creates a column of blended values.
 */
function edgeIntermediates(
  pixels: Buffer,
  width: number,
  height: number,
): number {
  const y0 = Math.floor(height * 0.25);
  const y1 = Math.floor(height * 0.75);
  const columns: number[] = [];
  for (let x = 0; x < width; x++) {
    let sum = 0;
    for (let y = y0; y < y1; y++) sum += luminance(pixels, (y * width + x) * 4);
    columns.push(sum / (y1 - y0));
  }
  let edgeX = -1;
  let edgeStep = 0;
  for (let x = 4; x < width - 4; x++) {
    const step = Math.abs(columns[x]! - columns[x - 1]!);
    if (step > edgeStep) {
      edgeStep = step;
      edgeX = x;
    }
  }
  if (edgeX < 0 || edgeStep < 30) return 0;
  const low = Math.min(columns[edgeX - 3]!, columns[edgeX + 3]!) + 10;
  const high = Math.max(columns[edgeX - 3]!, columns[edgeX + 3]!) - 10;
  if (low >= high) return 0;
  let count = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = edgeX - 4; x <= edgeX + 4; x++) {
      const lum = luminance(pixels, (y * width + x) * 4);
      if (lum > low && lum < high) count++;
    }
  }
  return count;
}

function maxChannelDiff(a: Buffer, b: Buffer): { max: number; count: number } {
  let max = 0;
  let count = 0;
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i += 4) {
    let pixel = 0;
    for (let channel = 0; channel < 4; channel++)
      pixel = Math.max(pixel, Math.abs(a[i + channel]! - b[i + channel]!));
    if (pixel > max) max = pixel;
    if (pixel > 1) count++;
  }
  return { max, count };
}

function playerTest(page: Page) {
  return page.evaluate(() => {
    const host = window as typeof window & {
      __babylonslatePlayerTest?: {
        postProcessPassCount: () => number | null;
        setRenderSettings: (settings: unknown) => void;
        rendering: () => { pipeline?: { effective?: unknown } } | null;
      };
    };
    const api = host.__babylonslatePlayerTest;
    return api
      ? {
          passes: api.postProcessPassCount(),
          pipeline: api.rendering()?.pipeline?.effective ?? null,
        }
      : null;
  });
}

async function applyRenderSettings(
  page: Page,
  settings: Partial<RenderProjectSettings>,
) {
  await page.evaluate((next) => {
    const host = window as typeof window & {
      __babylonslatePlayerTest?: {
        setRenderSettings: (settings: unknown) => void;
      };
    };
    if (!host.__babylonslatePlayerTest)
      throw new Error("Player test hook is unavailable");
    host.__babylonslatePlayerTest.setRenderSettings(next);
  }, settings);
}

for (const backend of ["webgl2", "webgpu"] as const) {
  test(`packed ${backend} player applies project color pipeline stages`, async ({
    page,
    baseURL,
  }, testInfo) => {
    test.setTimeout(180_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (
        ["warning", "error"].includes(message.type()) &&
        /shader|WebGPU uncaptured|VALIDATE_STATUS|ERROR:\s*0:|context lost|texture.*(?:missing|not found|failed)/i.test(
          message.text(),
        )
      )
        errors.push(message.text());
    });
    // The manifest omits `effects` like a legacy project; runtime settings are
    // applied through the same handle command the editor viewport uses.
    const baseRender: RenderProjectSettings = {
      ...DEFAULT_RENDER_PROJECT_SETTINGS,
      gpuBackend: backend,
      customResolution: true,
      width: 320,
      height: 180,
      blackBars: true,
    };
    const manifestRender: RenderProjectSettings = { ...baseRender };
    delete manifestRender.effects;
    const packed = await exportGame({
      bundleDebugger: false,
      startupSceneGuid: SCENE_GUID,
      customResolution: manifestRender,
      scripts: [],
      assets: [
        ...fixtureMaterials().map((material) => ({
          guid: material.guid,
          type: "Material",
          name: material.name,
          sceneGuid: SCENE_GUID,
          bytes: new TextEncoder().encode(JSON.stringify(material.doc)),
        })),
        {
          guid: SCENE_GUID,
          type: "Scene",
          sceneGuid: SCENE_GUID,
          bytes: new TextEncoder().encode(
            JSON.stringify(colorPipelineScene()),
          ),
        },
      ],
      playerFiles: await loadPlayerDistFiles(new URL("/player/", baseURL!).href),
    });
    if (!packed.ok) throw new Error(packed.error);
    const server = await serveExportFiles(packed.value.files, {
      honorRange: true,
    });
    const summary: Record<string, unknown> = { backend };
    try {
      await page.goto(server.url);
      const root = page.getByTestId("player-root");
      await expect(root).toHaveAttribute("data-booted", "true", {
        timeout: 30_000,
      });
      await expect(page.getByTestId("scene-loading-dialog")).toBeHidden({
        timeout: 30_000,
      });
      const canvas = page.getByTestId("player-canvas");
      const width = 320;
      const height = 180;

      // Defaults baseline: the omitted effects block renders exactly as the
      // pre-settings pipeline did.
      const baseline = await settledPixels(canvas);
      summary.baseline = await testInfo
        .attach("baseline-canvas", {
          body: baseline,
          contentType: "application/octet-stream",
        })
        .then(() => "attached")
        .catch(() => "unattached");
      const blob = hotBlob(baseline, width, height);
      expect(blob.count, "over-bright quad must be visible").toBeGreaterThan(
        50,
      );
      const baseRing = bloomRingMean(baseline, width, height, blob);
      const baseCorner = cornerMean(baseline, width, height);
      const baseEdge = edgeIntermediates(baseline, width, height);
      const hotX = Math.floor((blob.x0 + blob.x1) / 2);
      const hotY = Math.floor((blob.y0 + blob.y1) / 2);
      const baseHot = patchMean(baseline, width, height, hotX, hotY, 2);
      expect(baseHot, "legacy clamp keeps the emissive saturated").toBeGreaterThan(245);

      // Explicit defaults are display-identical to the omitted block.
      await applyRenderSettings(page, {
        ...baseRender,
        effects: DEFAULT_RENDER_EFFECTS,
      });
      await expect
        .poll(
          async () =>
            maxChannelDiff(await framePixels(canvas), baseline).max,
          { timeout: 15_000 },
        )
        .toBeLessThanOrEqual(1);
      const identical = await framePixels(canvas);
      const diff = maxChannelDiff(identical, baseline);
      summary.defaultsDiff = diff;
      expect(diff.count, "explicit defaults must match the baseline within ±1/255").toBeLessThanOrEqual(
        Math.ceil((width * height) / 500),
      );

      // Bloom spreads the emissive glow beyond the quad silhouette.
      await applyRenderSettings(page, {
        ...baseRender,
        effects: {
          ...DEFAULT_RENDER_EFFECTS,
          bloom: { enabled: true, threshold: 0.9, weight: 2, kernel: 48, scale: 0.5 },
        },
      });
      await expect
        .poll(() => playerTest(page).then((state) => state?.passes ?? -1), {
          timeout: 20_000,
        })
        .toBeGreaterThan(0);
      await expect
        .poll(
          async () =>
            bloomRingMean(await framePixels(canvas), width, height, blob),
          { timeout: 20_000 },
        )
        .toBeGreaterThan(baseRing + 8);
      const bloomed = await framePixels(canvas);
      summary.bloomRing = {
        baseline: baseRing,
        bloomed: bloomRingMean(bloomed, width, height, blob),
      };

      // Vignette darkens corners relative to the uniform wall interior.
      await applyRenderSettings(page, {
        ...baseRender,
        effects: {
          ...DEFAULT_RENDER_EFFECTS,
          vignette: { enabled: true, weight: 3, color: [0, 0, 0] },
        },
      });
      await expect
        .poll(async () => cornerMean(await framePixels(canvas), width, height), {
          timeout: 20_000,
        })
        .toBeLessThan(baseCorner - 12);
      summary.vignetteCorner = {
        baseline: baseCorner,
        vignetted: cornerMean(await framePixels(canvas), width, height),
      };

      // FXAA inserts blended values along the hard slab edge.
      await applyRenderSettings(page, {
        ...baseRender,
        effects: { ...DEFAULT_RENDER_EFFECTS, fxaa: true },
      });
      await expect
        .poll(
          async () => edgeIntermediates(await framePixels(canvas), width, height),
          { timeout: 20_000 },
        )
        .toBeGreaterThan(baseEdge + 12);
      summary.fxaaEdge = {
        baseline: baseEdge,
        smoothed: edgeIntermediates(await framePixels(canvas), width, height),
      };

      // Scene Linear keeps HDR until the display stage: ACES resolves the
      // over-bright emissive below the byte clamp instead of saturating.
      await applyRenderSettings(page, {
        ...baseRender,
        effects: {
          ...DEFAULT_RENDER_EFFECTS,
          colorPipeline: { version: 1, mode: "sceneLinear" },
          toneMapping: "aces",
        },
      });
      await expect
        .poll(
          async () =>
            patchMean(await framePixels(canvas), width, height, hotX, hotY, 2),
          { timeout: 20_000 },
        )
        .toBeLessThan(baseHot - 6);
      const acesHot = patchMean(await framePixels(canvas), width, height, hotX, hotY, 2);
      expect(acesHot, "ACES output must stay below the clamp").toBeLessThan(252);
      summary.acesHot = { legacy: baseHot, aces: acesHot };

      // CEL renders display-space by construction: a Scene Linear request is
      // identity even when tone mapping and exposure are configured.
      await applyRenderSettings(page, {
        ...baseRender,
        mode: "cel",
        effects: DEFAULT_RENDER_EFFECTS,
      });
      const celBaseline = await settledPixels(canvas);
      const celPasses = (await playerTest(page))?.passes;
      await applyRenderSettings(page, {
        ...baseRender,
        mode: "cel",
        effects: {
          ...DEFAULT_RENDER_EFFECTS,
          colorPipeline: { version: 1, mode: "sceneLinear" },
          toneMapping: "aces",
          exposure: 2,
          contrast: 2,
        },
      });
      // A wrongly created display stage must not hide behind a stale frame:
      // give any chain time to draw, then require identical captures and the
      // same pass count.
      await page.waitForTimeout(600);
      const celLinearA = await settledPixels(canvas);
      const celLinearB = await framePixels(canvas);
      const celState = await playerTest(page);
      summary.cel = {
        passesBefore: celPasses,
        passesAfter: celState?.passes,
        diffA: maxChannelDiff(celLinearA, celBaseline),
        diffB: maxChannelDiff(celLinearB, celBaseline),
      };
      expect(celState?.passes).toBe(celPasses);
      expect(maxChannelDiff(celLinearA, celBaseline).max).toBeLessThanOrEqual(1);
      expect(maxChannelDiff(celLinearB, celBaseline).max).toBeLessThanOrEqual(1);

      await testInfo.attach("color-pipeline", {
        body: JSON.stringify({ summary, errors }),
        contentType: "application/json",
      });
      await testInfo.attach("final-canvas", {
        body: await canvas.screenshot(),
        contentType: "image/png",
      });
      expect(errors).toEqual([]);
    } finally {
      await page.evaluate(
        (type) => window.postMessage({ type }, window.location.origin),
        PREVIEW_STOP_MESSAGE,
      );
      await server.close();
    }
  });
}

test("editor viewport applies project bloom through Post Processing settings", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (
      ["warning", "error"].includes(message.type()) &&
      /shader|WebGPU uncaptured|VALIDATE_STATUS|ERROR:\s*0:|context lost/i.test(
        message.text(),
      )
    )
      errors.push(message.text());
  });
  const files = await minimalProjectFiles();
  for (const material of fixtureMaterials()) {
    files.set(
      `assets/${material.name}.material.babasset`,
      await encodeAssetDocument({
        guid: material.guid,
        type: "Material",
        name: material.name,
        version: MATERIAL_PAYLOAD_VERSION,
        payload: material.doc as unknown as Record<string, unknown>,
      }),
    );
  }
  await openMinimalTestProject(page, files);
  await openMainScene(page);
  await setPreviewScene(page, colorPipelineScene());
  const canvas = page.getByTestId("viewport-canvas");
  const baseline = await settledPixels(canvas);
  const probe = await canvas.evaluate((node: HTMLCanvasElement) => ({
    width: node.width,
    height: node.height,
  }));
  const blob = hotBlob(baseline, probe.width, probe.height);
  expect(blob.count, "over-bright quad must be visible").toBeGreaterThan(50);
  const baseRing = bloomRingMean(
    baseline,
    probe.width,
    probe.height,
    blob,
  );

  await page.getByTestId("settings-menu").click();
  await page.getByTestId("project-settings").click();
  await page.getByTestId("settings-modal-category-rendering").click();
  await page.getByRole("button", { name: "Post Processing" }).click();
  await page.getByTestId("project-effects-bloom").click();
  await page
    .getByTestId("settings-modal")
    .getByRole("button", { name: "Done", exact: true })
    .click();

  await expect
    .poll(
      async () =>
        bloomRingMean(await framePixels(canvas), probe.width, probe.height, blob),
      { timeout: 30_000 },
    )
    .toBeGreaterThan(baseRing + 8);
  await testInfo.attach("viewport-bloom", {
    body: JSON.stringify({
      baseline: baseRing,
      bloomed: bloomRingMean(
        await framePixels(canvas),
        probe.width,
        probe.height,
        blob,
      ),
      errors,
    }),
    contentType: "application/json",
  });
  await testInfo.attach("viewport-canvas", {
    body: await canvas.screenshot(),
    contentType: "image/png",
  });
  expect(errors).toEqual([]);
});
