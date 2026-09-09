import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  createActor,
  createDefaultScene,
  createMeshComponent,
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

test("Unlit preserves PBR model color in Scene, Prefab, and Model Preview", async ({
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
  await preview.screenshot({ path: testInfo.outputPath("model-unlit.png") });
  await saveAllIfEnabled(page);

  const mesh = createMeshComponent("unlit-model-mesh", "box");
  mesh.properties.assetGuid = modelGuid;
  const scene = createDefaultScene();
  scene.settings.environmentColor = [0, 0, 0];
  scene.settings.environmentTextureGuid = null;
  scene.settings.grid.showGrid = false;
  scene.actors = [
    createActor("unlit-model", "Unlit Model", { components: [mesh] }),
  ];
  await openMainScene(page);
  await setPreviewScene(page, scene);
  const viewport = page.getByTestId("viewport-canvas");
  await expect(viewport).toHaveAttribute("data-scene-ready", "true", {
    timeout: 30_000,
  });
  await expect.poll(() => greenPixels(viewport)).toBeLessThan(100);
  await setShading(page, "unlit");
  await expect
    .poll(() => greenPixels(viewport), { timeout: 20_000 })
    .toBeGreaterThan(500);
  await viewport.screenshot({ path: testInfo.outputPath("scene-unlit.png") });
  await setShading(page, "pbr");
  await expect.poll(() => greenPixels(viewport)).toBeLessThan(100);
  await setShading(page, "unlit");
  await expect.poll(() => greenPixels(viewport)).toBeGreaterThan(500);

  await openAssetFromBrowser(page, "assets/Mannequin.class.babasset");
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
  await expect
    .poll(() => greenPixels(prefab), { timeout: 20_000 })
    .toBeGreaterThan(500);
  await prefab.screenshot({ path: testInfo.outputPath("prefab-unlit.png") });
  const unlitPixels = await greenPixels(prefab);
  await setShading(page, "pbr", "prefab-");
  await expect.poll(() => greenPixels(prefab)).toBeLessThan(unlitPixels / 4);
});
