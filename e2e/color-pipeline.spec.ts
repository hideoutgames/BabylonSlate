import { expect, test, type Locator, type Page } from "@playwright/test";
import { createActor, createDefaultScene, createMeshComponent, type SerializedScene } from "../packages/core/src/index.ts";
import { createDefaultMaterialDocument, type MaterialDocument } from "../packages/shader-graph/src/document.ts";
import { encodeAssetDocument } from "../packages/assets/src/asset-document";
import { MATERIAL_PAYLOAD_VERSION } from "../packages/assets/src/migration";
import { minimalProjectFiles } from "../packages/assets/src/test-support/minimal-project";
import { openMinimalTestProject } from "./minimal-project";
import { openMainScene } from "./open-test-project";
import { setPreviewScene } from "./preview-parity";
import { SOFTWARE_WEBGPU_ARGS } from "./software-webgpu";

test.use({ launchOptions: { args: SOFTWARE_WEBGPU_ARGS } });
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

/**
 * The editor check only needs the bloom quad: the FXAA slab saturates in
 * display space like the quad and is far larger in the editor camera's
 * framing, so keeping it would merge both into one hot blob whose ring band
 * reaches far beyond the halo. The lit sphere is unused here.
 */
function editorBloomScene(): SerializedScene {
  const scene = colorPipelineScene();
  scene.name = "Editor Bloom";
  scene.actors = scene.actors.filter(
    (actor) => actor.id !== "edge" && actor.id !== "sphere",
  );
  return scene;
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

async function scalingLevel(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    const host = window as typeof window & {
      __babylonslatePlayerTest?: {
        rendering: () => { scalingLevel?: number } | null;
      };
    };
    return host.__babylonslatePlayerTest?.rendering()?.scalingLevel ?? null;
  });
}

/**
 * The dynamic-resolution valve resizes the raster without touching the
 * backbuffer size or the task list, so a settled signature must cover both
 * pixels and the scaling level. Holding the signature for a window longer
 * than the valve's 30-frame step cooldown means a late step cannot land
 * between a baseline and its comparison capture.
 */
async function settledFrame(
  page: Page,
  canvas: Locator,
  timeoutMs = 45_000,
): Promise<{ pixels: Buffer; level: number | null }> {
  const deadline = Date.now() + timeoutMs;
  let signature = "";
  let stableSince = 0;
  for (;;) {
    const pixels = await framePixels(canvas);
    let hash = 0;
    for (let i = 0; i < pixels.length; i += 97)
      hash = (hash * 31 + pixels[i]!) | 0;
    const level = await scalingLevel(page);
    const next = `${hash}:${level}`;
    if (next !== signature) {
      signature = next;
      stableSince = Date.now();
    } else if (Date.now() - stableSince >= 3000) {
      return { pixels, level };
    }
    if (Date.now() > deadline)
      throw new Error(
        `Canvas signature never settled (pixel hash ${hash}, scaling level ${level})`,
      );
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
  pad = 14,
): number {
  let sum = 0;
  let count = 0;
  for (let y = Math.max(0, box.y0 - pad); y < Math.min(height, box.y1 + pad); y++) {
    for (let x = Math.max(0, box.x0 - pad); x < Math.min(width, box.x1 + pad); x++) {
      const inside =
        x >= box.x0 - 1 && x <= box.x1 + 1 && y >= box.y0 - 1 && y <= box.y1 + 1;
      if (inside) continue;
      sum += luminance(pixels, (y * width + x) * 4);
      count++;
    }
  }
  return count ? sum / count : 0;
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
  for (const material of fixtureMaterials().filter(
    (material) => material.guid !== MAT_EDGE,
  )) {
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
  await setPreviewScene(page, editorBloomScene());
  const canvas = page.getByTestId("viewport-canvas");
  const baseline = (await settledFrame(page, canvas)).pixels;
  const probe = await canvas.evaluate((node: HTMLCanvasElement) => ({
    width: node.width,
    height: node.height,
  }));
  const blob = hotBlob(baseline, probe.width, probe.height);
  expect(blob.count, "over-bright quad must be visible").toBeGreaterThan(50);
  // The editor canvas is far larger than the packed player's 320×180, so the
  // band scales with the quad's projected size to stay inside the halo.
  const ringPad = Math.max(
    14,
    Math.round(Math.min(blob.x1 - blob.x0, blob.y1 - blob.y0) / 6),
  );
  const baseRing = bloomRingMean(
    baseline,
    probe.width,
    probe.height,
    blob,
    ringPad,
  );

  await page.getByTestId("settings-menu").click();
  await page.getByTestId("project-settings").click();
  await page.getByTestId("settings-modal-category-rendering").click();
  await page.getByRole("button", { name: "Post Processing" }).click();
  await page.getByTestId("project-effects-bloom").click();
  // Match the packed spec's bloom signature; the default weight is tuned for
  // a subtle look and cannot lift the ring on a viewport this size.
  await page.getByTestId("project-effects-bloom-weight").fill("2");
  await page.getByTestId("project-effects-bloom-kernel").fill("48");
  await page
    .getByTestId("settings-modal")
    .getByRole("button", { name: "Done", exact: true })
    .click();

  try {
    // The owned passes compile asynchronously; let the post-settings frame
    // settle so the first presented frame cannot pass for the bloomed one.
    await settledFrame(page, canvas);
    await expect
      .poll(
        async () =>
          bloomRingMean(
            await framePixels(canvas),
            probe.width,
            probe.height,
            blob,
            ringPad,
          ),
        { timeout: 30_000 },
      )
      .toBeGreaterThan(baseRing + 8);
    expect(errors).toEqual([]);
  } finally {
    // The ring readout diagnoses a failed rise the same way the packed
    // spec's summary does; attach it even when the poll times out.
    await testInfo
      .attach("viewport-bloom", {
        body: JSON.stringify({
          baseline: baseRing,
          ringPad,
          bloomed: await framePixels(canvas)
            .then((pixels) =>
              bloomRingMean(pixels, probe.width, probe.height, blob, ringPad),
            )
            .catch(() => null),
          errors,
        }),
        contentType: "application/json",
      })
      .catch(() => {});
    await testInfo
      .attach("viewport-canvas", {
        body: await framePixels(canvas).catch(() => Buffer.alloc(0)),
        contentType: "application/octet-stream",
      })
      .catch(() => {});
  }
});
