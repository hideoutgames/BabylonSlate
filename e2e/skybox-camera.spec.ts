import { expect, test, type Locator } from "@playwright/test";
import {
  createActor,
  createDefaultScene,
  createSkyboxComponent,
} from "../packages/core/src/index";
import { openMainScene, openTestProject } from "./open-test-project";
import { clickPlayAndWaitForOverlay } from "./play";
import { setPreviewScene } from "./preview-parity";

async function expectSkyPixels(canvas: Locator) {
  await expect
    .poll(
      () =>
        canvas.evaluate((node) => {
          const source = node as HTMLCanvasElement;
          if (!source.width || !source.height) return 0;
          const copy = document.createElement("canvas");
          copy.width = 32;
          copy.height = 32;
          const context = copy.getContext("2d")!;
          context.drawImage(source, 0, 0, 32, 32);
          const pixels = context.getImageData(0, 0, 32, 32).data;
          let sky = 0;
          for (let index = 0; index < pixels.length; index += 4) {
            // Default sky has green; magenta clear, transparent, and unlit geometry do not.
            if (pixels[index + 1]! > 40 && pixels[index + 3]! > 240) sky++;
          }
          return sky / (32 * 32);
        }),
      { timeout: 20_000 },
    )
    .toBeGreaterThan(0.75);
}

test("large skybox remains visible after adding a possessing camera", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await openTestProject(page);
  await openMainScene(page);
  const scene = createDefaultScene();
  scene.settings.environmentColor = [1, 0, 1];
  scene.actors = [
    createActor("sky", "Skybox", {
      components: [createSkyboxComponent("sky-component", 10000)],
    }),
  ];
  await setPreviewScene(page, scene);
  await clickPlayAndWaitForOverlay(page);
  await expectSkyPixels(page.getByTestId("play-canvas"));
  await page.getByTestId("play-overlay-close").click();

  scene.actors.push(
    createActor("camera", "Camera", {
      components: [
        {
          id: "camera-component",
          classId: "CameraComponent",
          properties: {
            projectionMode: "perspective",
            fieldOfView: 60,
            nearClip: 0.1,
            farClip: 1000,
            attemptPossessViewTarget: true,
          },
        },
      ],
    }),
  );
  scene.actors.push(
    createActor("box", "Box", {
      transform: {
        position: [0, 0, 950],
        rotation: [0, 0, 0, 1],
        scale: [50, 50, 50],
      },
      components: [
        {
          id: "box-component",
          classId: "MeshComponent",
          properties: { meshKind: "box" },
        },
      ],
    }),
  );
  await setPreviewScene(page, scene);
  await clickPlayAndWaitForOverlay(page);
  await expectSkyPixels(page.getByTestId("play-canvas"));
  // Geometry near Far Clip must not be covered by the sky's infinite-far depth.
  await expect
    .poll(
      () =>
        page.getByTestId("play-canvas").evaluate((node) => {
          const source = node as HTMLCanvasElement;
          const copy = document.createElement("canvas");
          copy.width = copy.height = 1;
          const context = copy.getContext("2d")!;
          context.drawImage(
            source,
            source.width / 2,
            source.height / 2,
            1,
            1,
            0,
            0,
            1,
            1,
          );
          return Array.from(context.getImageData(0, 0, 1, 1).data).slice(0, 3);
        }),
      { timeout: 10_000 },
    )
    .toEqual([0, 0, 0]);
  await page.getByTestId("play-overlay-close").click();
});
