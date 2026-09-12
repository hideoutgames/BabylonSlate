import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  createActor,
  createDefaultScene,
  createMeshComponent,
} from "../packages/core/src/index.ts";
import { openMinimalTestProject } from "./minimal-project";
import {
  createContentBrowserAsset,
  openAssetFromBrowser,
  openMainScene,
} from "./open-test-project";
import { guidForPath } from "./material-graph";
import { saveAllIfEnabled } from "./save-all";
import { setPreviewScene } from "./preview-parity";
import { clickPlayAndWaitForOverlay } from "./play";
import { encodeAssetDocument } from "../packages/assets/src/asset-document";
import { encodeGlbJsonBin } from "../packages/assets/src/importers/glb-parse";
import { minimalProjectFiles } from "../packages/assets/src/test-support/minimal-project";

async function pixelsNear(
  canvas: Locator,
  color: number[],
  tolerance = 3,
): Promise<number> {
  return canvas.evaluate(
    (node: HTMLCanvasElement, { color, tolerance }) => {
      if (!node.width || !node.height) return 0;
      const copy = document.createElement("canvas");
      copy.width = node.width;
      copy.height = node.height;
      const ctx = copy.getContext("2d")!;
      ctx.drawImage(node, 0, 0);
      const pixels = ctx.getImageData(0, 0, copy.width, copy.height).data;
      let count = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        if (
          color.every(
            (channel, index) =>
              Math.abs(pixels[i + index]! - channel) <= tolerance,
          )
        )
          count++;
      }
      return count;
    },
    { color, tolerance },
  );
}

async function projectMode(page: Page, mode: "PBR" | "CEL", setup = false) {
  await page.getByTestId("settings-menu").click();
  await page.getByTestId("project-settings").click();
  await page.getByTestId("settings-modal-category-rendering").click();
  await page.getByTestId("setting-render-mode").click();
  await page.getByRole("option", { name: mode, exact: true }).click();
  if (setup) {
    await page.getByLabel("Specular Strength", { exact: true }).fill("0");
    await page.getByLabel("Specular Strength", { exact: true }).press("Tab");
  }
  await expect(page.getByTestId("project-cel-settings")).toHaveCount(
    mode === "CEL" ? 1 : 0,
  );
  await page
    .getByTestId("settings-modal")
    .getByRole("button", { name: "Done", exact: true })
    .click();
}

test("CEL preserves authored and texture colors, supports every light, and restores PBR in viewport and Play", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const shaderErrors: string[] = [];
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      /shader|ERROR: 0:|VALIDATE_STATUS/i.test(message.text())
    )
      shaderErrors.push(message.text());
  });
  await openMinimalTestProject(page);
  await createContentBrowserAsset(page, "Material", "CelColor");
  const materialPath = "assets/CelColor.material.babasset";
  await openAssetFromBrowser(page, materialPath);
  await page
    .getByTestId("material-graph-editor")
    .locator('.react-flow__node[data-id="baseColor"]')
    .click();
  await page.getByTestId("property-color").fill("#33994d");
  await saveAllIfEnabled(page);
  const materialGuid = await guidForPath(page, materialPath);
  expect(materialGuid).not.toBe("");
  await projectMode(page, "CEL", true);
  await projectMode(page, "PBR");

  const mesh = createMeshComponent("cel-mesh", "sphere");
  mesh.properties.materialGuid = materialGuid;
  const scene = createDefaultScene();
  scene.settings.environmentColor = [0, 0, 0];
  scene.settings.environmentTextureGuid = null;
  scene.settings.grid.showGrid = false;
  const subjects = [
    createActor("cel-actor", "Authored Color", {
      transform: {
        position: [-1.5, 0, 0],
        rotation: [0, 0, 0, 1],
        scale: [2.5, 2.5, 2.5],
      },
      components: [mesh],
    }),
    createActor("native-actor", "Native Texture", {
      transform: {
        position: [1.5, 0, 0],
        rotation: [0, 0, 0, 1],
        scale: [2, 2, 2],
      },
      components: [createMeshComponent("native-mesh", "box")],
    }),
  ];
  const fill = createActor("fill", "Fill", {
    components: [
      {
        id: "fill-light",
        classId: "HemisphericFillLightComponent",
        properties: { color: [1, 1, 1], groundColor: [1, 1, 1], intensity: 1 },
      },
    ],
  });
  scene.actors = [...subjects, fill];
  await openMainScene(page);
  await setPreviewScene(page, scene);
  const viewport = page.getByTestId("viewport-canvas");
  const authored = [51, 153, 77];
  await projectMode(page, "CEL");
  await expect
    .poll(() => pixelsNear(viewport, authored), { timeout: 30_000 })
    .toBeGreaterThan(500);
  // The fallback takes the imported/native material path and must preserve raw texture pixels too.
  await expect
    .poll(() => pixelsNear(viewport, [204, 204, 204]))
    .toBeGreaterThan(100);
  await viewport.screenshot({
    path: testInfo.outputPath("cel-white-light.png"),
  });
  await clickPlayAndWaitForOverlay(page);
  await expect
    .poll(() => pixelsNear(page.getByTestId("play-canvas"), authored), {
      timeout: 30_000,
    })
    .toBeGreaterThan(500);
  await page.getByTestId("play-overlay-close").click();

  // No light produces the darkest band; overrides update already-frozen surface graphs.
  scene.actors = subjects;
  await setPreviewScene(page, scene);
  await expect
    .poll(() => pixelsNear(viewport, [18, 54, 27]))
    .toBeGreaterThan(500);
  scene.settings.celShading = { shadowStrength: 0.25 };
  await setPreviewScene(page, scene);
  await expect
    .poll(() => pixelsNear(viewport, [38, 115, 58]))
    .toBeGreaterThan(500);

  // Overlapping fractional lights must share one ramp. Quantizing each light
  // separately produces extra brightness levels even with zero softness.
  for (const lightFalloff of ["banded", "smooth"] as const) {
    scene.settings.celShading = {
      shadowStrength: 1,
      shadowBands: 3,
      bandSoftness: 0,
      lightFalloff,
    };
    scene.actors = [
      ...subjects,
      ...[-1, 1].map((side) =>
        createActor(`overlap-${side}`, "Overlap", {
          transform: {
            position: [0, 0, 0],
            rotation: [0, side * 0.173648, 0, 0.984808],
            scale: [1, 1, 1],
          },
          components: [
            {
              id: `light-${side}`,
              classId: "LightComponent",
              properties: {
                lightKind: "directional",
                color: [1, 1, 1],
                intensity: 0.6,
              },
            },
          ],
        }),
      ),
    ];
    await setPreviewScene(page, scene);
    await expect
      .poll(() => pixelsNear(viewport, [26, 77, 39]))
      .toBeGreaterThan(100);
    await expect
      .poll(() => pixelsNear(viewport, authored))
      .toBeGreaterThan(100);
    await expect
      .poll(() =>
        viewport.evaluate((node: HTMLCanvasElement) => {
          const copy = document.createElement("canvas");
          copy.width = node.width;
          copy.height = node.height;
          const context = copy.getContext("2d")!;
          context.drawImage(node, 0, 0);
          const pixels = context.getImageData(
            0,
            0,
            copy.width,
            copy.height,
          ).data;
          let green = 0;
          let offBand = 0;
          for (let i = 0; i < pixels.length; i += 4) {
            if (
              pixels[i + 1]! < 15 ||
              pixels[i + 1]! < pixels[i]! * 1.8 ||
              pixels[i + 1]! < pixels[i + 2]! * 1.5
            )
              continue;
            green++;
            if (
              ![77, 153].some((level) => Math.abs(pixels[i + 1]! - level) <= 3)
            )
              offBand++;
          }
          return offBand / Math.max(green, 1);
        }),
      )
      .toBeLessThan(0.03);
  }

  for (const kind of ["directional", "point", "spot"] as const) {
    scene.settings.celShading = { shadowStrength: 1, lightFalloff: "banded" };
    const light = createActor("key", "Key", {
      transform: {
        position: [0, 3, -6],
        rotation: [0, 0, 0, 1],
        scale: [1, 1, 1],
      },
      components: [
        {
          id: "key-light",
          classId: "LightComponent",
          properties: {
            lightKind: kind,
            color: [1, 0, 0],
            intensity: 1,
            range: 100,
            outerAngle: 90,
            innerAngle: 60,
            castShadows: true,
          },
        },
      ],
    });
    scene.actors = [...subjects, light];
    await setPreviewScene(page, scene);
    await expect
      .poll(() => pixelsNear(viewport, [51, 0, 0]), {
        message: `${kind} colored light`,
        timeout: 20_000,
      })
      .toBeGreaterThan(100);
    scene.settings.celShading.lightColorInfluence = 0;
    await setPreviewScene(page, scene);
    await expect
      .poll(() => pixelsNear(viewport, authored), {
        message: `${kind} neutral light influence`,
      })
      .toBeGreaterThan(100);
    if (kind === "directional") {
      await expect
        .poll(() => pixelsNear(viewport, [26, 77, 39]))
        .toBeGreaterThan(100);
      await viewport.screenshot({
        path: testInfo.outputPath("cel-shadow-bands.png"),
      });
      scene.settings.celShading.shadowBands = 2;
      scene.settings.celShading.bandSoftness = 0;
      await setPreviewScene(page, scene);
      await expect
        .poll(() => pixelsNear(viewport, [26, 77, 39]))
        .toBeLessThan(30);
    }
  }

  scene.actors = [...subjects, fill];
  scene.settings.celShading = { specularStrength: 1, specularSize: 1 };
  await setPreviewScene(page, scene);
  await expect
    .poll(() => pixelsNear(viewport, [255, 255, 255]))
    .toBeGreaterThan(100);
  fill.components[0]!.properties.color = [1, 0, 0];
  fill.components[0]!.properties.groundColor = [1, 0, 0];
  scene.settings.celShading.shadowStrength = 1;
  await setPreviewScene(page, scene);
  await expect
    .poll(() => pixelsNear(viewport, [255, 0, 0]))
    .toBeGreaterThan(100);
  await expect
    .poll(() => pixelsNear(viewport, [255, 255, 255]))
    .toBeLessThan(30);
  fill.components[0]!.properties.color = [1, 1, 1];
  fill.components[0]!.properties.groundColor = [1, 1, 1];
  scene.settings.celShading = {};
  await setPreviewScene(page, scene);
  await projectMode(page, "PBR");
  await expect.poll(() => pixelsNear(viewport, authored)).toBeLessThan(100);
  await projectMode(page, "CEL");
  await expect
    .poll(() => pixelsNear(viewport, authored), { timeout: 20_000 })
    .toBeGreaterThan(500);
  expect(shaderErrors).toEqual([]);
});

test("CEL preserves sRGB image pixels on a native glTF surface", async ({
  page,
}) => {
  // A numeric texture fixture exercises Babylon's automatic hardware sRGB decode.
  const uri = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 2;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#33994d";
    context.fillRect(0, 0, 2, 2);
    return canvas.toDataURL("image/png");
  });
  const vertices = new Float32Array([
    -2, -2, 0, 2, -2, 0, 2, 2, 0, -2, 2, 0, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1,
    0, 0, 1, 0, 1, 1, 0, 1,
  ]);
  const geometry = new Uint8Array(140);
  geometry.set(new Uint8Array(vertices.buffer));
  geometry.set(new Uint8Array(new Uint16Array([0, 1, 2, 0, 2, 3]).buffer), 128);
  const source = encodeGlbJsonBin(
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
  const guid = "00000000-0000-4000-8000-000000000010";
  const files = await minimalProjectFiles();
  files.set(
    "assets/Native.model.babasset",
    await encodeAssetDocument(
      {
        guid,
        type: "Model",
        name: "Native",
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
            data: source,
          },
        ],
      },
    ),
  );
  await openMinimalTestProject(page, files);
  await projectMode(page, "CEL", true);
  const mesh = createMeshComponent("native", "box");
  mesh.properties.assetGuid = guid;
  const scene = createDefaultScene();
  scene.settings.environmentColor = [0, 0, 0];
  scene.settings.environmentTextureGuid = null;
  scene.settings.grid.showGrid = false;
  scene.actors = [
    createActor("model", "Model", { components: [mesh] }),
    createActor("fill", "Fill", {
      components: [
        {
          id: "light",
          classId: "HemisphericFillLightComponent",
          properties: {
            color: [1, 1, 1],
            groundColor: [1, 1, 1],
            intensity: 1,
          },
        },
      ],
    }),
  ];
  await openMainScene(page);
  await setPreviewScene(page, scene);
  await expect
    .poll(
      () => pixelsNear(page.getByTestId("viewport-canvas"), [51, 153, 77], 1),
      { timeout: 30_000 },
    )
    .toBeGreaterThan(500);
  for (let cycle = 0; cycle < 3; cycle++) {
    await projectMode(page, "PBR");
    await expect
      .poll(
        async () =>
          page
            .getByTestId("viewport-canvas")
            .evaluate((node: HTMLCanvasElement) => {
              const copy = document.createElement("canvas");
              copy.width = node.width;
              copy.height = node.height;
              const context = copy.getContext("2d")!;
              context.drawImage(node, 0, 0);
              const pixels = context.getImageData(
                0,
                0,
                copy.width,
                copy.height,
              ).data;
              let count = 0;
              for (let i = 0; i < pixels.length; i += 4)
                if (
                  pixels[i + 1]! > 10 &&
                  pixels[i + 1]! > pixels[i]! * 1.5 &&
                  pixels[i + 1]! > pixels[i + 2]! * 1.5
                )
                  count++;
              return count;
            }),
        { timeout: 20_000 },
      )
      .toBeGreaterThan(500);
    await projectMode(page, "CEL");
    await expect
      .poll(
        () => pixelsNear(page.getByTestId("viewport-canvas"), [51, 153, 77], 1),
        { timeout: 20_000 },
      )
      .toBeGreaterThan(500);
  }
  await clickPlayAndWaitForOverlay(page);
  await expect
    .poll(() => pixelsNear(page.getByTestId("play-canvas"), [51, 153, 77], 1), {
      timeout: 30_000,
    })
    .toBeGreaterThan(500);
});
