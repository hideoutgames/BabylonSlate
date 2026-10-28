import { expect, test, type Locator, type Page } from "@playwright/test";
import { PROJECT_FILE } from "../packages/core/src/project";
import { encodeAssetDocument } from "../packages/assets/src/asset-document";
import { encodeGlbJsonBin } from "../packages/assets/src/importers/glb-parse";
import { minimalProjectFiles } from "../packages/assets/src/test-support/minimal-project";
import { MATERIAL_PAYLOAD_VERSION } from "../packages/assets/src/migration";
import { createDefaultMaterialDocument } from "../packages/shader-graph/src/document";
import { openMinimalTestProject } from "./minimal-project";
import { openAssetFromBrowser, openMainScene } from "./open-test-project";
import { compileMaterialPreview } from "./material-graph";
import { SOFTWARE_WEBGPU_ARGS } from "./software-webgpu";

// Explicit software adapter admission for this functional proof, not GPU qualification.
test.use({ launchOptions: { args: SOFTWARE_WEBGPU_ARGS } });

const MODEL_GUID = "00000000-0000-4000-8000-000000000010";
const PBR_MATERIAL_GUID = "00000000-0000-4000-8000-000000000011";
const CEL_MATERIAL_GUID = "00000000-0000-4000-8000-000000000012";
const UNLIT_MATERIAL_GUID = "00000000-0000-4000-8000-000000000013";
const QUAD_MATERIAL_GUID = "00000000-0000-4000-8000-000000000014";

const MODEL_ASSET = "assets/Quad.model.hasset";
const PBR_MATERIAL_ASSET = "assets/AuthoredPbr.material.hasset";

// WebGL2 previews are covered by the default-backend specs; this one pins WebGPU.
type Backend = "webgpu";

function isGpuFailure(type: string, message: string): boolean {
  return (
    ["error", "warning"].includes(type) &&
    /shader|program|GL_INVALID|WebGPU uncaptured|WebGPU|VALIDATE_STATUS|ERROR: 0:|context lost|fatal error/i.test(
      message,
    )
  );
}

/** Small quad GLB whose one primitive names material 0. */
function encodeQuadGlb(): Uint8Array {
  const vertices = new Float32Array([
    -2, -2, 0, 2, -2, 0, 2, 2, 0, -2, 2, 0, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1,
    0, 0, 1, 0, 1, 1, 0, 1,
  ]);
  const geometry = new Uint8Array(140);
  geometry.set(new Uint8Array(vertices.buffer));
  geometry.set(new Uint8Array(new Uint16Array([0, 1, 2, 0, 2, 3]).buffer), 128);
  return encodeGlbJsonBin(
    {
      asset: { version: "2.0" },
      buffers: [{ byteLength: geometry.length }],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: 48 },
        { buffer: 0, byteOffset: 48, byteLength: 48 },
        { buffer: 0, byteOffset: 96, byteLength: 32 },
        { buffer: 0, byteOffset: 128, byteLength: 12 },
      ],
      accessors: [
        {
          bufferView: 0,
          componentType: 5126,
          count: 4,
          type: "VEC3",
          min: [-2, -2, 0],
          max: [2, 2, 0],
        },
        { bufferView: 1, componentType: 5126, count: 4, type: "VEC3" },
        { bufferView: 2, componentType: 5126, count: 4, type: "VEC2" },
        { bufferView: 3, componentType: 5123, count: 6, type: "SCALAR" },
      ],
      materials: [{ name: "Quad", doubleSided: true }],
      meshes: [
        {
          primitives: [
            {
              attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 },
              indices: 3,
              material: 0,
            },
          ],
        },
      ],
      nodes: [{ mesh: 0 }],
      scenes: [{ nodes: [0] }],
      scene: 0,
    },
    geometry,
  );
}

function materialAsset(
  guid: string,
  name: string,
  color: number[],
  options: { unlit?: boolean; twoSided?: boolean } = {},
) {
  const document = createDefaultMaterialDocument(name);
  document.nodes.find((node) => node.id === "baseColor")!.properties.value =
    color;
  if (options.unlit) document.shadingModel = "unlit";
  document.twoSided = options.twoSided === true;
  return encodeAssetDocument({
    guid,
    type: "Material",
    name,
    version: MATERIAL_PAYLOAD_VERSION,
    payload: document as unknown as Record<string, unknown>,
  });
}

/** Project fixture: backend pinned, one quad GLB, four authored materials. */
async function proofProjectFiles(backend: Backend) {
  const files = await minimalProjectFiles();
  const project = JSON.parse(
    new TextDecoder().decode(files.get(PROJECT_FILE)!),
  );
  project.settings.render = {
    ...project.settings.render,
    gpuBackend: backend,
  };
  files.set(PROJECT_FILE, new TextEncoder().encode(JSON.stringify(project)));
  files.set(
    MODEL_ASSET,
    await encodeAssetDocument(
      {
        guid: MODEL_GUID,
        type: "Model",
        name: "Quad",
        version: 1,
        payload: {
          materialSlots: [{ index: 0, name: "Quad", materialGuid: QUAD_MATERIAL_GUID }],
          importScale: 1,
        },
      },
      {
        extraChunks: [
          {
            id: "source",
            kind: "geometry",
            mime: "model/gltf-binary",
            data: encodeQuadGlb(),
          },
        ],
      },
    ),
  );
  files.set(
    PBR_MATERIAL_ASSET,
    await materialAsset(PBR_MATERIAL_GUID, "AuthoredPbr", [0.7, 0.18, 0.14]),
  );
  files.set(
    "assets/AuthoredCel.material.hasset",
    await materialAsset(CEL_MATERIAL_GUID, "AuthoredCel", [0.16, 0.45, 0.85]),
  );
  files.set(
    "assets/Unlit.material.hasset",
    await materialAsset(UNLIT_MATERIAL_GUID, "Unlit", [0.9, 0.75, 0.1], { unlit: true }),
  );
  files.set(
    "assets/Quad.material.hasset",
    // Two-sided, as the importer makes a double-sided glTF material.
    await materialAsset(QUAD_MATERIAL_GUID, "Quad", [0.2, 0.6, 0.3], { twoSided: true }),
  );
  return files;
}

async function engineSceneDiagnostics(page: Page) {
  return page.evaluate(async () => {
    const host = globalThis as unknown as {
      __hapticViewportTest?: {
        engineSceneDiagnostics: () => Promise<unknown>;
      };
    };
    return host.__hapticViewportTest?.engineSceneDiagnostics() ?? null;
  });
}

/** Project settings → Rendering → render mode select (CEL ⇄ PBR). */
async function projectMode(page: Page, mode: "PBR" | "CEL") {
  await page.getByTestId("settings-menu").click();
  await page.getByTestId("project-settings").click();
  await page.getByTestId("settings-modal-category-rendering").click();
  await page.getByTestId("setting-render-mode").click();
  await page.getByRole("option", { name: mode, exact: true }).click();
  await expect(
    page
      .getByTestId("settings-modal")
      .getByRole("button", { name: "CEL Shading", exact: true }),
  ).toHaveCount(mode === "CEL" ? 1 : 0);
  await page
    .getByTestId("settings-modal")
    .getByRole("button", { name: "Done", exact: true })
    .click();
}

interface CanvasEvidence {
  width: number;
  height: number;
  nonBlank: number;
  meanLum: number;
  topLum: number;
  bottomLum: number;
  /** RGBA row through canvas center, downsampled for attachments. */
  centerRow: number[][];
  /** Distinct 16-step luminance buckets across the canvas. */
  distinctLevels: number;
  corners: number[][];
}

/** The sampled center-row pixel nearest the canvas center. */
function centerPixel(evidence: CanvasEvidence): number[] {
  return evidence.centerRow[Math.floor(evidence.centerRow.length / 2)]!;
}

/** Readback evidence from a 2D preview canvas or GL canvas via drawImage. */
async function canvasEvidence(canvas: Locator): Promise<CanvasEvidence> {
  return canvas.evaluate((node: HTMLCanvasElement) => {
    const copy = document.createElement("canvas");
    copy.width = node.width;
    copy.height = node.height;
    const ctx = copy.getContext("2d")!;
    ctx.drawImage(node, 0, 0);
    const data = ctx.getImageData(0, 0, copy.width, copy.height).data;
    const lum = (i: number) =>
      0.2126 * data[i]! + 0.7152 * data[i + 1]! + 0.0722 * data[i + 2]!;
    const at = (x: number, y: number) => {
      const i = (y * copy.width + x) * 4;
      return [data[i]!, data[i + 1]!, data[i + 2]!, data[i + 3]!];
    };
    let nonBlank = 0;
    let lumSum = 0;
    let topSum = 0;
    let bottomSum = 0;
    const levels = new Set<number>();
    const midY = Math.floor(copy.height / 2);
    for (let y = 0; y < copy.height; y++) {
      for (let x = 0; x < copy.width; x++) {
        const i = (y * copy.width + x) * 4;
        const l = lum(i);
        lumSum += l;
        if (y < copy.height / 2) topSum += l;
        else bottomSum += l;
        levels.add(Math.floor(l / 16));
        if (
          Math.abs(data[i]! - data[0]!) > 6 ||
          Math.abs(data[i + 1]! - data[1]!) > 6 ||
          Math.abs(data[i + 2]! - data[2]!) > 6
        )
          nonBlank++;
      }
    }
    const centerRow: number[][] = [];
    for (let x = 0; x < copy.width; x += Math.max(1, Math.floor(copy.width / 48)))
      centerRow.push(at(x, midY));
    const total = copy.width * copy.height;
    return {
      width: copy.width,
      height: copy.height,
      nonBlank,
      meanLum: lumSum / total,
      topLum: topSum / (total / 2),
      bottomLum: bottomSum / (total / 2),
      centerRow,
      distinctLevels: levels.size,
      corners: [
        at(2, 2),
        at(copy.width - 3, 2),
        at(2, copy.height - 3),
        at(copy.width - 3, copy.height - 3),
      ],
    };
  });
}

for (const backend of ["webgpu"] as const) {
  test(`material, model and prefab previews present correctly on ${backend}`, async ({
    page,
  }, testInfo) => {
    test.setTimeout(240_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (isGpuFailure(message.type(), message.text()))
        errors.push(message.text());
    });

    await openMinimalTestProject(page, await proofProjectFiles(backend));
    await openMainScene(page);

    for (const mode of ["pbr", "cel"] as const) {
      await projectMode(page, mode === "cel" ? "CEL" : "PBR");

      // Real Material Editor document preview.
      await openAssetFromBrowser(page, PBR_MATERIAL_ASSET);
      await compileMaterialPreview(page);
      const materialCanvas = page.getByTestId("material-preview-canvas");
      // "ready" means the compiled Material is bound, not that a frame drawn
      // with it has been read back to the canvas. A remounted preview shows
      // its default checker cube until then, so wait for the authored colour.
      await expect
        .poll(
          async () => {
            const evidence = await canvasEvidence(materialCanvas);
            const [red, green, blue] = centerPixel(evidence);
            return evidence.nonBlank > 200 && red! > Math.max(green!, blue!);
          },
          {
            timeout: 30_000,
            message: `material preview never showed its red base color on ${backend}/${mode}`,
          },
        )
        .toBe(true);
      const material = await canvasEvidence(materialCanvas);
      await materialCanvas.screenshot({
        path: testInfo.outputPath(`material-${mode}-${backend}.png`),
      });
      expect(
        await page.getByTestId("material-preview-error").count(),
        `material preview error on ${backend}/${mode}`,
      ).toBe(0);
      expect(
        material.nonBlank,
        `material preview blank on ${backend}/${mode}`,
      ).toBeGreaterThan(200);
      // The previewed cube covers the center with the authored red base color.
      const [materialRed, materialGreen, materialBlue] = centerPixel(material);
      expect(
        materialRed,
        `material preview shows its red base color on ${backend}/${mode}`,
      ).toBeGreaterThan(Math.max(materialGreen!, materialBlue!));

      // Real Model document preview.
      await openAssetFromBrowser(page, MODEL_ASSET);
      const modelCanvas = page.getByTestId("model-preview-canvas");
      await expect(modelCanvas).toBeVisible({ timeout: 30_000 });
      // The quad draws once its slot Material has compiled.
      await expect
        .poll(
          async () => {
            const evidence = await canvasEvidence(modelCanvas);
            const [red, green, blue] = centerPixel(evidence);
            return evidence.nonBlank > 200 && green! > Math.max(red!, blue!);
          },
          {
            timeout: 30_000,
            message: `model preview never showed its slot Material on ${backend}/${mode}`,
          },
        )
        .toBe(true);
      const model = await canvasEvidence(modelCanvas);
      await modelCanvas.screenshot({
        path: testInfo.outputPath(`model-${mode}-${backend}.png`),
      });
      expect(
        await page.getByTestId("model-preview-load-error").count(),
        `model preview error on ${backend}/${mode}`,
      ).toBe(0);
      // The framed quad covers the center with its slot Material's green base color.
      const [modelRed, modelGreen, modelBlue] = centerPixel(model);
      expect(
        modelGreen,
        `model preview shows its slot Material on ${backend}/${mode}`,
      ).toBeGreaterThan(Math.max(modelRed!, modelBlue!));

      // Real Prefab document preview: pitch-black background, no skybox.
      await openAssetFromBrowser(page, "assets/main.class.hasset");
      await page.locator(".dv-tab").filter({ hasText: "Prefab" }).click();
      const prefabCanvas = page.getByTestId("prefab-preview-canvas");
      await expect(prefabCanvas).toBeVisible({ timeout: 30_000 });
      await expect
        .poll(async () => (await canvasEvidence(prefabCanvas)).nonBlank, {
          timeout: 30_000,
        })
        .toBeGreaterThan(10);
      const prefab = await canvasEvidence(prefabCanvas);
      await prefabCanvas.screenshot({
        path: testInfo.outputPath(`prefab-${mode}-${backend}.png`),
      });
      // The Prefab preview keeps its editor grid across the lower half; only the
      // sky region above it must stay pitch black (no preview skybox).
      for (const [index, corner] of prefab.corners.slice(0, 2).entries())
        expect(
          Math.max(corner[0]!, corner[1]!, corner[2]!),
          `prefab top corner ${index} must stay pitch black on ${backend}/${mode}`,
        ).toBeLessThan(24);

      // A render-mode switch rebuilds the viewport handle; while the Scene
      // document tab is hidden the remount can stay parked in
      // waitForCanvasSize, so the shared Engine may briefly report no world
      // scene at all. Preview scenes persist on that Engine across the
      // rebuild — re-query until the API reports a preview scene instead of
      // racing the reload (or a mid-recreation preview Scene).
      type SceneDiagnostics = {
        kind: string;
        skyboxMesh: boolean;
        shadowGeneratorCount: number;
        lights: { name: string }[];
      };
      // Asserted rather than annotated: the poll callback assigns it, so a
      // `null` initializer would narrow it to `null` after the poll.
      let diagnostics = null as { scenes: SceneDiagnostics[] } | null;
      let previewScenes: SceneDiagnostics[] = [];
      await expect
        .poll(
          async () => {
            diagnostics = (await engineSceneDiagnostics(page)) as typeof diagnostics;
            previewScenes = (diagnostics?.scenes ?? []).filter(
              (scene) => scene.kind === "preview",
            );
            return previewScenes.length;
          },
          {
            timeout: 60_000,
            message: `no preview scene found on ${backend}/${mode}`,
          },
        )
        .toBeGreaterThan(0);
      await testInfo.attach(`preview-scenes-${mode}-${backend}`, {
        body: JSON.stringify({
          material,
          model,
          prefab,
          diagnostics,
        }),
        contentType: "application/json",
      });
      const scenes = diagnostics?.scenes ?? [];
      for (const scene of previewScenes) {
        // Interactive previews share the engine default skybox.
        expect(
          scene.skyboxMesh,
          `preview skybox missing on ${backend}/${mode}`,
        ).toBe(true);
        expect(
          scene.shadowGeneratorCount,
          `preview shadow generators on ${backend}/${mode}`,
        ).toBe(0);
        // Studio rig installed by createPreviewLighting.
        expect(
          scene.lights.map((light) => light.name),
          `preview light rig on ${backend}/${mode}`,
        ).toEqual(
          expect.arrayContaining([
            "materialPreviewLight",
            "materialPreviewFill",
          ]),
        );
      }
      // The Prefab preview is the non-preview loaded scene: no preview skybox.
      const prefabScenes = scenes.filter((scene) => scene.kind === "other");
      for (const scene of prefabScenes)
        expect(
          scene.skyboxMesh,
          `prefab preview must not get the skybox on ${backend}/${mode}`,
        ).toBe(false);
    }

    await testInfo.attach("preview-gpu-errors", {
      body: JSON.stringify(errors),
      contentType: "application/json",
    });
    expect(errors).toEqual([]);
  });
}
