import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  createActor,
  createDefaultScene,
  createDefaultSkyboxActor,
  createMeshComponent,
} from "../packages/core/src/index.ts";
import { PROJECT_FILE } from "../packages/core/src/project";
import { encodeAssetDocument } from "../packages/assets/src/asset-document";
import { encodeGlbJsonBin } from "../packages/assets/src/importers/glb-parse";
import { minimalProjectFiles } from "../packages/assets/src/test-support/minimal-project";
import { MATERIAL_PAYLOAD_VERSION } from "../packages/assets/src/migration";
import { createDefaultMaterialDocument } from "../packages/shader-graph/src/document";
import { openMinimalTestProject } from "./minimal-project";
import {
  openAssetFromBrowser,
  openMainScene,
  waitForSceneViewportReady,
} from "./open-test-project";
import { setPreviewScene } from "./preview-parity";
import { compileMaterialPreview } from "./material-graph";
import { SOFTWARE_WEBGPU_ARGS } from "./software-webgpu";
import type { ViewportProofResult } from "../apps/editor/src/testing/webgpu-previews-proof";

// Explicit software adapter admission for this functional proof, not GPU qualification.
test.use({ launchOptions: { args: SOFTWARE_WEBGPU_ARGS } });

const MODEL_GUID = "00000000-0000-4000-8000-000000000010";
const PBR_MATERIAL_GUID = "00000000-0000-4000-8000-000000000011";
const CEL_MATERIAL_GUID = "00000000-0000-4000-8000-000000000012";
const UNLIT_MATERIAL_GUID = "00000000-0000-4000-8000-000000000013";

const MODEL_ASSET = "assets/Quad.model.babasset";
const PBR_MATERIAL_ASSET = "assets/AuthoredPbr.material.babasset";

type Backend = "webgl2" | "webgpu";

function isGpuFailure(type: string, message: string): boolean {
  return (
    ["error", "warning"].includes(type) &&
    /shader|program|GL_INVALID|WebGPU uncaptured|WebGPU|VALIDATE_STATUS|ERROR: 0:|context lost|fatal error/i.test(
      message,
    )
  );
}

/** Small textured quad GLB; the same synthetic model the CEL spec packs. */
function encodeQuadGlb(uri: string): Uint8Array {
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
      images: [{ uri }],
      textures: [{ source: 0 }],
      materials: [
        {
          name: "Native",
          doubleSided: true,
          pbrMetallicRoughness: {
            baseColorTexture: { index: 0 },
            metallicFactor: 0,
            roughnessFactor: 1,
          },
        },
      ],
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
  unlit = false,
) {
  const document = createDefaultMaterialDocument(name);
  document.nodes.find((node) => node.id === "baseColor")!.properties.value =
    color;
  if (unlit) document.shadingModel = "unlit";
  return encodeAssetDocument({
    guid,
    type: "Material",
    name,
    version: MATERIAL_PAYLOAD_VERSION,
    payload: document as unknown as Record<string, unknown>,
  });
}

/** Project fixture: backend pinned, one quad GLB, three authored materials. */
async function proofProjectFiles(page: Page, backend: Backend) {
  const uri = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 2;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#33994d";
    context.fillRect(0, 0, 2, 2);
    return canvas.toDataURL("image/png");
  });
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
          materialSlots: [{ index: 0, name: "Native", materialGuid: null }],
          importScale: 1,
        },
      },
      {
        extraChunks: [
          {
            id: "source",
            kind: "geometry",
            mime: "model/gltf-binary",
            data: encodeQuadGlb(uri),
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
    "assets/AuthoredCel.material.babasset",
    await materialAsset(CEL_MATERIAL_GUID, "AuthoredCel", [0.16, 0.45, 0.85]),
  );
  files.set(
    "assets/Unlit.material.babasset",
    await materialAsset(UNLIT_MATERIAL_GUID, "Unlit", [0.9, 0.75, 0.1], true),
  );
  return files;
}

const TRACKED_ACTORS = {
  glb: "proof-glb",
  primitive: "proof-primitive",
  pbr: "proof-pbr",
  cel: "proof-cel",
  unlit: "proof-unlit",
} as const;

/** Skybox + directional/fill lights + GLB + native primitive + three authored materials. */
async function seedProofScene(page: Page) {
  const scene = createDefaultScene("WebGPU preview proof");
  scene.settings.grid.showGrid = false;
  const glbMesh = createMeshComponent("glb-mesh", "box");
  glbMesh.properties.assetGuid = MODEL_GUID;
  const pbrMesh = createMeshComponent("pbr-mesh", "sphere");
  pbrMesh.properties.materialGuid = PBR_MATERIAL_GUID;
  const celMesh = createMeshComponent("cel-mesh", "sphere");
  celMesh.properties.materialGuid = CEL_MATERIAL_GUID;
  const unlitMesh = createMeshComponent("unlit-mesh", "sphere");
  unlitMesh.properties.materialGuid = UNLIT_MATERIAL_GUID;
  const subject = (
    id: string,
    name: string,
    x: number,
    scale: number,
    components: ReturnType<typeof createMeshComponent>[],
  ) =>
    createActor(id, name, {
      transform: {
        position: [x, 0, 0],
        rotation: [0, 0, 0, 1],
        scale: [scale, scale, scale],
      },
      components,
    });
  scene.actors = [
    ...scene.actors.filter(
      (actor) => actor.id === scene.settings.mainCameraActorId,
    ),
    createDefaultSkyboxActor(),
    createActor("proof-sun", "Sun", {
      transform: {
        position: [0, 5, -3],
        rotation: [0.382683, 0, 0, 0.92388],
        scale: [1, 1, 1],
      },
      components: [
        {
          id: "proof-sun-light",
          classId: "LightComponent",
          properties: {
            lightKind: "directional",
            color: [1, 1, 1],
            intensity: 1.2,
            castShadows: false,
          },
        },
      ],
    }),
    createActor("proof-fill", "Fill", {
      components: [
        {
          id: "proof-fill-light",
          classId: "HemisphericFillLightComponent",
          properties: {
            color: [1, 1, 1],
            groundColor: [0.6, 0.6, 0.6],
            intensity: 0.35,
          },
        },
      ],
    }),
    subject(TRACKED_ACTORS.glb, "GLB Quad", -3.4, 0.55, [glbMesh]),
    subject(TRACKED_ACTORS.primitive, "Native Box", -1.5, 1.2, [
      createMeshComponent("prim-mesh", "box"),
    ]),
    subject(TRACKED_ACTORS.pbr, "Authored PBR", 0, 1.2, [pbrMesh]),
    subject(TRACKED_ACTORS.cel, "Authored CEL", 1.5, 1.2, [celMesh]),
    subject(TRACKED_ACTORS.unlit, "Authored Unlit", 3, 1.2, [unlitMesh]),
  ];
  await setPreviewScene(page, scene);
}

async function recordViewportProof(
  page: Page,
): Promise<ViewportProofResult> {
  return page.evaluate(async (trackedActorIds) => {
    const host = globalThis as unknown as {
      __babylonslateViewportTest?: {
        webgpuPreviewsProof: (options: {
          frames?: number;
          timeoutMs?: number;
          trackedActorIds?: string[];
        }) => Promise<ViewportProofResult>;
      };
    };
    const api = host.__babylonslateViewportTest;
    if (!api) throw new Error("Viewport test hook is not mounted");
    return api.webgpuPreviewsProof({
      frames: 60,
      timeoutMs: 30_000,
      trackedActorIds,
    });
  }, Object.values(TRACKED_ACTORS));
}

async function engineSceneDiagnostics(page: Page) {
  return page.evaluate(async () => {
    const host = globalThis as unknown as {
      __babylonslateViewportTest?: {
        engineSceneDiagnostics: () => Promise<unknown>;
      };
    };
    return host.__babylonslateViewportTest?.engineSceneDiagnostics() ?? null;
  });
}

function expectStableViewport(
  record: ViewportProofResult,
  label: string,
): void {
  expect(
    record.presentedFrames,
    `${label}: presented frame count`,
  ).toBeGreaterThanOrEqual(60);
  expect(record.timedOut, `${label}: recording timed out`).toBe(false);
  for (const [index, sky] of record.skybox.entries()) {
    // A static skybox is pixel-identical frame to frame; allow two changes for
    // late face-texture upload, never the per-frame flicker seen on iPad.
    expect(
      sky.changes,
      `${label}: skybox point ${index} flickered`,
    ).toBeLessThanOrEqual(2);
  }
  for (const subject of record.subjects) {
    expect(
      subject.realizedAtFrame,
      `${label}: ${subject.actorId} visual never realized`,
    ).not.toBeNull();
    expect(
      subject.materialsReadyAtFrame,
      `${label}: ${subject.actorId} materials never ready`,
    ).not.toBeNull();
    expect(
      subject.droppedAfterRealization,
      `${label}: ${subject.actorId} visual dropped after realization`,
    ).toBe(0);
  }
  const glb = record.subjects.find(
    (subject) => subject.actorId === "proof-glb",
  )!;
  const glbLast = glb.last!;
  expect(
    glbLast.meshes.length,
    `${label}: GLB visual missing on the last frame`,
  ).toBeGreaterThan(0);
  expect(
    glbLast.pixel,
    `${label}: GLB projected point off-canvas`,
  ).not.toBeNull();
  expect(
    glbLast.meshes.some((mesh) => mesh.inFrustum),
    `${label}: GLB visual culled out of the frustum`,
  ).toBe(true);
  expect(record.engineErrors, `${label}: engine errors`).toEqual([]);
}

/** Project settings → Rendering → render mode select (CEL ⇄ PBR). */
async function projectMode(page: Page, mode: "PBR" | "CEL") {
  await page.getByTestId("settings-menu").click();
  await page.getByTestId("project-settings").click();
  await page.getByTestId("settings-modal-category-rendering").click();
  await page.getByTestId("setting-render-mode").click();
  await page.getByRole("option", { name: mode, exact: true }).click();
  await expect(page.getByTestId("project-cel-settings")).toHaveCount(
    mode === "CEL" ? 1 : 0,
  );
  await page
    .getByTestId("settings-modal")
    .getByRole("button", { name: "Done", exact: true })
    .click();
}

/** Switch Rendering → GPU backend and wait for the rebuilt engine. */
async function switchGpuBackend(page: Page, backend: "WebGL2" | "WebGPU") {
  await page.getByTestId("settings-menu").click();
  await page.getByTestId("project-settings").click();
  await page.getByTestId("settings-modal-category-rendering").click();
  await page.getByTestId("project-gpu-backend").click();
  await page.getByRole("option", { name: backend, exact: true }).click();
  await page
    .getByTestId("settings-modal")
    .getByRole("button", { name: "Done", exact: true })
    .click();
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            (
              window as unknown as {
                __babylonslateViewportTest?: {
                  renderingBaseline: () => { backend: string } | null;
                };
              }
            ).__babylonslateViewportTest?.renderingBaseline()?.backend ?? null,
        ),
      { timeout: 30_000 },
    )
    .toBe(backend.toLowerCase());
  await waitForSceneViewportReady(page);
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

for (const backend of ["webgl2", "webgpu"] as const) {
  test(`scene viewport stays stable with skybox, GLB and mixed materials on ${backend}`, async ({
    page,
  }, testInfo) => {
    test.setTimeout(180_000);
    const errors: string[] = [];
    const locations: unknown[] = [];
    const nativeLogs: unknown[] = [];
    const logSession = await page.context().newCDPSession(page);
    await logSession.send("Log.enable");
    logSession.on("Log.entryAdded", ({ entry }) => {
      if (["warning", "error"].includes(entry.level) && nativeLogs.length < 64)
        nativeLogs.push(entry);
    });
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (isGpuFailure(message.type(), message.text())) {
        errors.push(message.text());
        locations.push(message.location());
      }
    });

    await openMinimalTestProject(page, await proofProjectFiles(page, backend));
    await openMainScene(page);
    await seedProofScene(page);

    const record = await recordViewportProof(page);
    await testInfo.attach(`viewport-proof-${backend}`, {
      body: JSON.stringify(record),
      contentType: "application/json",
    });
    await page
      .getByTestId("viewport-canvas")
      .screenshot({ path: testInfo.outputPath(`viewport-${backend}.png`) });
    expectStableViewport(record, backend);

    if (backend === "webgl2") {
      // The brief requires the same recording after a WebGL2 → WebGPU switch.
      await switchGpuBackend(page, "WebGPU");
      const switched = await recordViewportProof(page);
      await testInfo.attach("viewport-proof-webgl2-switched-webgpu", {
        body: JSON.stringify(switched),
        contentType: "application/json",
      });
      await page
        .getByTestId("viewport-canvas")
        .screenshot({ path: testInfo.outputPath("viewport-switched-webgpu.png") });
      expectStableViewport(switched, "webgl2→webgpu switch");
      expect(switched.backend).toBe("webgpu");
    }

    await testInfo.attach("gpu-errors", {
      body: JSON.stringify(errors),
      contentType: "application/json",
    });
    await testInfo.attach("gpu-error-locations", {
      body: JSON.stringify(locations),
      contentType: "application/json",
    });
    await testInfo.attach("native-gpu-logs", {
      body: JSON.stringify(nativeLogs),
      contentType: "application/json",
    });
    expect(errors, `${label(backend)} GPU/console errors`).toEqual([]);
  });
}

function label(backend: Backend): string {
  return backend === "webgpu" ? "WebGPU" : "WebGL2";
}

for (const backend of ["webgl2", "webgpu"] as const) {
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

    await openMinimalTestProject(page, await proofProjectFiles(page, backend));
    await openMainScene(page);

    for (const mode of ["pbr", "cel"] as const) {
      await projectMode(page, mode === "cel" ? "CEL" : "PBR");

      // Real Material Editor document preview.
      await openAssetFromBrowser(page, PBR_MATERIAL_ASSET);
      await compileMaterialPreview(page);
      const materialCanvas = page.getByTestId("material-preview-canvas");
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

      // Real Model document preview.
      await openAssetFromBrowser(page, MODEL_ASSET);
      const modelCanvas = page.getByTestId("model-preview-canvas");
      await expect(modelCanvas).toBeVisible({ timeout: 30_000 });
      await expect
        .poll(async () => (await canvasEvidence(modelCanvas)).nonBlank, {
          timeout: 30_000,
        })
        .toBeGreaterThan(200);
      const model = await canvasEvidence(modelCanvas);
      await modelCanvas.screenshot({
        path: testInfo.outputPath(`model-${mode}-${backend}.png`),
      });
      expect(
        await page.getByTestId("model-preview-load-error").count(),
        `model preview error on ${backend}/${mode}`,
      ).toBe(0);

      // Real Prefab document preview: pitch-black background, no skybox.
      await openAssetFromBrowser(page, "assets/main.class.babasset");
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

      const diagnostics = await engineSceneDiagnostics(page);
      await testInfo.attach(`preview-scenes-${mode}-${backend}`, {
        body: JSON.stringify({
          material,
          model,
          prefab,
          diagnostics,
        }),
        contentType: "application/json",
      });
      const scenes = (
        diagnostics as {
          scenes: {
            kind: string;
            skyboxMesh: boolean;
            shadowGeneratorCount: number;
            lights: { name: string }[];
            materials: { className: string }[];
          }[];
        } | null
      )?.scenes ?? [];
      const previewScenes = scenes.filter((scene) => scene.kind === "preview");
      expect(
        previewScenes.length,
        `no preview scene found on ${backend}/${mode}`,
      ).toBeGreaterThan(0);
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
      // CEL material replacement reaches preview PBR/native materials, while
      // authored NodeMaterials stay unwrapped (they are the preview subject).
      if (mode === "cel") {
        await expect
          .poll(
            async () => {
              const current = (await engineSceneDiagnostics(page)) as {
                scenes: { materials: { className: string }[] }[];
              } | null;
              return (
                current?.scenes
                  .flatMap((scene) => scene.materials)
                  .filter((material) => material.className === "CelMaterial")
                  .length ?? 0
              );
            },
            { timeout: 30_000 },
          )
          .toBeGreaterThan(0);
      } else {
        const celWrapped = scenes
          .flatMap((scene) => scene.materials)
          .filter((material) => material.className === "CelMaterial");
        expect(
          celWrapped.length,
          `unexpected CEL material under PBR on ${backend}`,
        ).toBe(0);
      }
    }

    await testInfo.attach("preview-gpu-errors", {
      body: JSON.stringify(errors),
      contentType: "application/json",
    });
    expect(errors).toEqual([]);
  });
}
