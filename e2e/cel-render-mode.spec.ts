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
            intensity: 2,
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
  }

  scene.actors = [...subjects, fill];
  scene.settings.celShading = { specularStrength: 1, specularSize: 1 };
  await setPreviewScene(page, scene);
  await expect
    .poll(() => pixelsNear(viewport, [255, 255, 255]))
    .toBeGreaterThan(100);
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
