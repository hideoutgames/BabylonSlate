import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  createActor,
  createDefaultScene,
  createMeshComponent,
  createSkyboxComponent,
} from "../packages/core/src/index.ts";
import {
  createContentBrowserAsset,
  openAssetFromBrowser,
  openMainScene,
  openTestProject,
} from "./open-test-project";
import { guidForPath } from "./material-graph";
import { saveAllIfEnabled } from "./save-all";
import { setPreviewScene } from "./preview-parity";
import { clickPlayAndWaitForOverlay } from "./play";

async function greenPixels(canvas: Locator): Promise<number> {
  return canvas.evaluate((node: HTMLCanvasElement) => {
    if (!node.width || !node.height) return 0;
    const copy = document.createElement("canvas");
    copy.width = node.width;
    copy.height = node.height;
    const context = copy.getContext("2d")!;
    context.drawImage(node, 0, 0);
    const pixels = context.getImageData(0, 0, copy.width, copy.height).data;
    let green = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      if (
        pixels[i + 1]! > 80 &&
        pixels[i + 1]! > pixels[i]! * 2 &&
        pixels[i + 1]! > pixels[i + 2]! * 2
      )
        green++;
    }
    return green;
  });
}

async function setShading(page: Page, mode: "pbr" | "unlit", prefix = "") {
  await page.getByTestId(`${prefix}viewport-settings`).click();
  await page.getByTestId(`${prefix}viewport-shading-mode`).click();
  await page.getByTestId(`${prefix}viewport-shading-${mode}`).click();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId(`${prefix}viewport-settings-menu`)).toHaveCount(
    0,
  );
}

async function expectSkyboxPixels(canvas: Locator) {
  await expect.poll(() => canvas.evaluate((node: HTMLCanvasElement) => {
    if (!node.width || !node.height) return 0;
    const copy = document.createElement("canvas");
    copy.width = copy.height = 32;
    const context = copy.getContext("2d")!;
    context.drawImage(node, 0, 0, 32, 32);
    const pixels = context.getImageData(0, 0, 32, 32).data;
    let sky = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      // The default cubemap is blue; white albedo, black clear, and the green
      // test subject cannot satisfy this check.
      if (pixels[i + 2]! > pixels[i]! + 20 &&
          pixels[i + 2]! > pixels[i + 1]! + 10 &&
          pixels[i + 1]! > 40 && pixels[i + 3]! > 240) sky++;
    }
    return sky;
  }), { timeout: 20_000 }).toBeGreaterThan(100);
}

test("Scene fog changes authored PBR surface pixels in the editor and Play", async ({ page }) => {
  test.setTimeout(180_000);
  await openTestProject(page);
  await createContentBrowserAsset(page, "Material", "FogSurface");
  const materialPath = "assets/FogSurface.material.babasset";
  await openAssetFromBrowser(page, materialPath);
  await page.getByTestId("material-graph-editor").locator('.react-flow__node[data-id="baseColor"]').click();
  await page.getByTestId("property-color").fill("#00ff00");
  await saveAllIfEnabled(page);

  const mesh = createMeshComponent("fog-sphere-mesh", "sphere");
  mesh.properties.materialGuid = await guidForPath(page, materialPath);
  const scene = createDefaultScene();
  scene.settings.environmentColor = [0, 0, 0];
  scene.settings.environmentTextureGuid = null;
  scene.settings.grid.showGrid = false;
  scene.settings.mainCameraActorId = null;
  scene.settings.mainCameraComponentId = null;
  scene.settings.fogColor = [1, 0, 0];
  scene.settings.fogMode = "exponentialSquared";
  scene.settings.fogDensity = 2;
  scene.actors = [
    createActor("fog-sphere", "Fog Sphere", {
      transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [4, 4, 4] },
      components: [mesh],
    }),
    createActor("fill", "Fill", {
      components: [{ id: "fill-light", classId: "HemisphericFillLightComponent",
        properties: { color: [1, 1, 1], groundColor: [1, 1, 1], intensity: 1 } }],
    }),
  ];
  const redPixels = (canvas: Locator) => canvas.evaluate((node: HTMLCanvasElement) => {
    const copy = document.createElement("canvas");
    copy.width = node.width;
    copy.height = node.height;
    const context = copy.getContext("2d")!;
    context.drawImage(node, 0, 0);
    const pixels = context.getImageData(0, 0, copy.width, copy.height).data;
    let red = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i]! > 100 && pixels[i]! > pixels[i + 1]! * 2 && pixels[i]! > pixels[i + 2]! * 2) red++;
    }
    return red;
  });
  await openMainScene(page);
  await setPreviewScene(page, scene);
  const viewport = page.getByTestId("viewport-canvas");
  await expect.poll(() => greenPixels(viewport), { timeout: 30_000 }).toBeGreaterThan(500);
  await clickPlayAndWaitForOverlay(page);
  const play = page.getByTestId("play-canvas");
  await expect.poll(() => greenPixels(play), { timeout: 30_000 }).toBeGreaterThan(500);
  await page.getByTestId("play-overlay-close").click();

  // The background stays black, so only the authored surface can become red.
  scene.settings.fogEnabled = true;
  await setPreviewScene(page, scene);
  await expect.poll(() => redPixels(viewport), { timeout: 30_000 }).toBeGreaterThan(500);
  await expect.poll(() => greenPixels(viewport)).toBeLessThan(50);
  await clickPlayAndWaitForOverlay(page);
  await expect.poll(() => redPixels(play), { timeout: 30_000 }).toBeGreaterThan(500);
  await expect.poll(() => greenPixels(play)).toBeLessThan(50);
  await page.getByTestId("play-overlay-close").click();
  scene.settings.fogEnabled = false;
  await setPreviewScene(page, scene);
  await expect.poll(() => greenPixels(viewport), { timeout: 30_000 }).toBeGreaterThan(500);
});

test("Emissive color popup stays reachable outside the graph and within a short viewport", async ({ page }) => {
  await openTestProject(page);
  await createContentBrowserAsset(page, "Material", "EmissivePicker");
  await openAssetFromBrowser(page, "assets/EmissivePicker.material.babasset");
  const graph = page.getByTestId("material-graph-editor");
  await page.setViewportSize({ width: 1100, height: 420 });
  await graph.getByRole("button", { name: "Size Graph To Fit" }).click();
  const trigger = graph.getByTestId("pin-default-output-emissive");
  await trigger.click();
  const dialog = page.getByTestId("pin-default-output-emissive-dialog");
  await expect(dialog).toBeVisible();
  const bounds = await dialog.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.y).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(1100);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(420);
  // Filling and clicking use Playwright actionability checks, catching content
  // clipped by the graph's transform/scrollport as well as viewport overflow.
  await dialog.getByRole("textbox", { name: "Hex", exact: true }).fill("#00ff00");
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  await trigger.click();
  await expect(dialog.getByRole("textbox", { name: "Hex", exact: true })).toHaveValue("#00ff00");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
});

test("Unlit preserves skyboxes and PBR model color in Scene, Prefab, and Model Preview", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  await openTestProject(page);
  await createContentBrowserAsset(page, "Material", "UnlitSurface");
  const materialPath = "assets/UnlitSurface.material.babasset";
  await openAssetFromBrowser(page, materialPath);
  await page
    .getByTestId("material-graph-editor")
    .locator('.react-flow__node[data-id="baseColor"]')
    .click();
  await page.getByTestId("property-color").fill("#00ff00");
  await saveAllIfEnabled(page);
  const materialGuid = await guidForPath(page, materialPath);
  const modelPath = "assets/Mannequin/mannequin.babasset";
  const modelGuid = await guidForPath(page, modelPath);
  expect(materialGuid).not.toBe("");
  expect(modelGuid).not.toBe("");

  // Use the real imported model and assign its slot after entering Unlit.
  await openAssetFromBrowser(page, modelPath);
  const preview = page.getByTestId("model-preview-canvas");
  await expect(preview).toBeVisible();
  await page.getByTestId("model-preview-shading").click();
  await page.getByTestId("model-preview-shading-unlit").click();
  await page.getByTestId("property-slot-0").click();
  await page.getByTestId(`search-item-${materialGuid}`).click();
  await expect
    .poll(() => greenPixels(preview), { timeout: 20_000 })
    .toBeGreaterThan(500);
  await expectSkyboxPixels(preview);
  await preview.screenshot({ path: testInfo.outputPath("model-unlit.png") });
  await page.getByTestId("model-preview-shading").click();
  await page.getByTestId("model-preview-shading-pbr").click();
  await expect
    .poll(() => greenPixels(preview), { timeout: 20_000 })
    .toBeGreaterThan(500);
  await expectSkyboxPixels(preview);
  await preview.screenshot({ path: testInfo.outputPath("model-pbr.png") });
  await saveAllIfEnabled(page);

  const mesh = createMeshComponent("unlit-model-mesh", "box");
  mesh.properties.assetGuid = modelGuid;
  const scene = createDefaultScene();
  scene.settings.environmentColor = [0, 0, 0];
  scene.settings.environmentTextureGuid = null;
  scene.settings.grid.showGrid = false;
  scene.actors = [
    createActor("unlit-model", "Unlit Model", { components: [mesh] }),
    createActor("sky", "Skybox", {
      components: [createSkyboxComponent("sky-component")],
    }),
  ];
  await openMainScene(page);
  await setPreviewScene(page, scene);
  const viewport = page.getByTestId("viewport-canvas");
  await expect(page.getByTestId("viewport-panel")).toHaveAttribute(
    "data-scene-ready",
    "true",
    {
      timeout: 30_000,
    },
  );
  await expect.poll(() => greenPixels(viewport)).toBeLessThan(100);
  await setShading(page, "unlit");
  await expect
    .poll(() => greenPixels(viewport), { timeout: 20_000 })
    .toBeGreaterThan(500);
  await expectSkyboxPixels(viewport);
  await viewport.screenshot({ path: testInfo.outputPath("scene-unlit.png") });
  await setShading(page, "pbr");
  await expect.poll(() => greenPixels(viewport)).toBeLessThan(100);
  await expectSkyboxPixels(viewport);
  await setShading(page, "unlit");
  await expect.poll(() => greenPixels(viewport)).toBeGreaterThan(500);

  // A surface first compiled without lights must use newly authored lighting
  // when switching back to PBR, including the scene's frozen material path.
  scene.actors.push(
    createActor("key-light", "Key Light", {
      components: [
        {
          id: "key-light-component",
          classId: "HemisphericFillLightComponent",
          properties: { color: [1, 1, 1], intensity: 1 },
        },
      ],
    }),
  );
  await setPreviewScene(page, scene);
  await setShading(page, "pbr");
  await expect
    .poll(() => greenPixels(viewport), { timeout: 20_000 })
    .toBeGreaterThan(500);
  await viewport.screenshot({ path: testInfo.outputPath("scene-pbr.png") });

  await openAssetFromBrowser(page, "assets/Mannequin.class.babasset");
  await expect(page.getByTestId("graph-panel")).toBeVisible({
    timeout: 15_000,
  });
  expect(
    await page.evaluate(
      async (components) => {
        const host = globalThis as unknown as {
          __babylonslateTest: {
            setMainGraphComponents: (
              value: typeof components,
            ) => Promise<boolean>;
          };
        };
        return host.__babylonslateTest.setMainGraphComponents(components);
      },
      [mesh],
    ),
  ).toBe(true);
  await page.locator(".dv-tab").filter({ hasText: "Prefab" }).click();
  const prefab = page.getByTestId("prefab-preview-canvas");
  await expect(prefab).toBeVisible();
  await setShading(page, "unlit", "prefab-");
  try {
    await expect
      .poll(() => greenPixels(prefab), { timeout: 20_000 })
      .toBeGreaterThan(500);
  } finally {
    const diagnostics = await page.evaluate(() => (globalThis as unknown as {
      __babylonslatePrefabViewportTest?: { diagnostics: () => unknown };
    }).__babylonslatePrefabViewportTest?.diagnostics());
    await testInfo.attach("prefab-render-state", { body: JSON.stringify(diagnostics), contentType: "application/json" });
  }
  await prefab.screenshot({ path: testInfo.outputPath("prefab-unlit.png") });
  await setShading(page, "pbr", "prefab-");
  await expect.poll(() => greenPixels(prefab)).toBeGreaterThan(500);
  await prefab.screenshot({ path: testInfo.outputPath("prefab-pbr.png") });
});
