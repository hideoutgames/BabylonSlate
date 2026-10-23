import { expect, test, type Locator } from "@playwright/test";
import {
  createActor,
  createDefaultScene,
  createMeshComponent,
  createSkyboxComponent,
  identitySerializedTransform,
  type EnvironmentSource,
} from "../packages/core/src/index.ts";
import { openMainScene, openTestProject } from "./open-test-project";
import { setPreviewScene } from "./preview-parity";
import { clickPlayAndWaitForOverlay } from "./play";

/** Mean brightness of the canvas centre, where the sphere fills the view. */
function centreBrightness(canvas: Locator): Promise<number> {
  return canvas.evaluate((node: HTMLCanvasElement) => {
    if (!node.width || !node.height) return 0;
    const copy = document.createElement("canvas");
    copy.width = copy.height = 16;
    const context = copy.getContext("2d")!;
    const side = Math.min(node.width, node.height) * 0.2;
    context.drawImage(node, (node.width - side) / 2, (node.height - side) / 2, side, side, 0, 0, 16, 16);
    const pixels = context.getImageData(0, 0, 16, 16).data;
    let sum = 0;
    for (let i = 0; i < pixels.length; i += 4) sum += (pixels[i]! + pixels[i + 1]! + pixels[i + 2]!) / 3;
    return sum / (pixels.length / 4);
  });
}

// A lightless sphere in front of the default sky: only image-based lighting can brighten it.
function skyLitScene(environmentSource: EnvironmentSource) {
  const scene = createDefaultScene();
  scene.settings.environmentColor = [0, 0, 0];
  scene.settings.environmentSource = environmentSource;
  scene.settings.grid.showGrid = false;
  scene.settings.shadowOverrides = { enabled: false };
  const camera = scene.actors.find((actor) => actor.id === scene.settings.mainCameraActorId)!;
  camera.transform = { ...identitySerializedTransform(), position: [0, 0, -4] };
  scene.actors = [
    camera,
    createActor("sky", "Skybox", { components: [createSkyboxComponent("sky-component")] }),
    createActor("ball", "Ball", {
      transform: { ...identitySerializedTransform(), scale: [3, 3, 3] },
      components: [createMeshComponent("ball-mesh", "sphere")],
    }),
  ];
  return scene;
}

test("a Skybox environment source lights surfaces from the sky in the editor and Play", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  // The sky is GGX-filtered on the GPU; a failure would silently fall back to the raw sky.
  const filterErrors: string[] = [];
  page.on("console", (message) => {
    if (["warning", "error"].includes(message.type()) && /environment (filtering|lighting) failed|GL_INVALID|WebGL: INVALID_/i.test(message.text())) filterErrors.push(message.text());
  });
  await openTestProject(page);
  await openMainScene(page);
  const viewport = page.getByTestId("viewport-canvas");
  const ready = () => expect(page.getByTestId("viewport-panel")).toHaveAttribute("data-scene-ready", "true", { timeout: 30_000 });

  await setPreviewScene(page, skyLitScene("none"));
  await ready();
  await page.waitForTimeout(500);
  const dark = await centreBrightness(viewport);
  await viewport.screenshot({ path: testInfo.outputPath("source-none.png") });

  await setPreviewScene(page, skyLitScene("skybox"));
  await ready();
  await expect.poll(() => centreBrightness(viewport), { timeout: 20_000 }).toBeGreaterThan(dark + 25);
  await viewport.screenshot({ path: testInfo.outputPath("source-skybox.png") });

  await clickPlayAndWaitForOverlay(page);
  const play = page.getByTestId("play-canvas");
  await expect.poll(() => centreBrightness(play), { timeout: 30_000 }).toBeGreaterThan(dark + 25);
  await play.screenshot({ path: testInfo.outputPath("play-skybox.png") });
  expect(filterErrors).toEqual([]);
});
