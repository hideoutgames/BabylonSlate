import { expect, test, type Locator } from "@playwright/test";
import { createActor, createDefaultScene } from "../packages/core/src/index.ts";
import { openMinimalTestProject } from "./minimal-project";
import { openMainScene } from "./open-test-project";
import { clickPlayAndWaitForOverlay } from "./play";
import { setPreviewScene } from "./preview-parity";

async function pixelCounts(canvas: Locator) {
  return canvas.evaluate((node: HTMLCanvasElement) => {
    const copy = document.createElement("canvas");
    copy.width = node.width;
    copy.height = node.height;
    const context = copy.getContext("2d")!;
    context.drawImage(node, 0, 0);
    const pixels = context.getImageData(0, 0, copy.width, copy.height).data;
    let blue = 0;
    let background = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      const r = pixels[i]!;
      const g = pixels[i + 1]!;
      const b = pixels[i + 2]!;
      if (b > 40 && b > r * 1.25 && b > g * 1.1) blue++;
      if (r > 25 && Math.abs(r - g) < 3 && Math.abs(g - b) < 3) background++;
    }
    return { blue, background };
  });
}

test("the camera model renders in the editor and disappears from Game Camera and Play", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await openMinimalTestProject(page);
  await openMainScene(page);
  const scene = createDefaultScene();
  scene.settings.environmentColor = [0.12, 0.12, 0.12];
  scene.settings.grid.showGrid = false;
  scene.actors = ["primary", "other"].map((id, i) => createActor(id, id, {
    transform: { position: [0, 0, i * 2], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
    components: [{ id: "camera", classId: "CameraComponent", properties: {} }],
  }));
  scene.settings.mainCameraActorId = "primary";
  scene.settings.mainCameraComponentId = "camera";
  await setPreviewScene(page, scene);
  await page.evaluate(() => (globalThis as unknown as {
    __babylonslateViewportTest: {
      setShadowCaptureView: (position: number[], target: number[], fov: number) => void;
    };
  }).__babylonslateViewportTest.setShadowCaptureView([1.2, 0.6, 3], [0, 0, 1.65], 0.65));
  const viewport = page.getByTestId("viewport-canvas");
  await expect.poll(async () => (await pixelCounts(viewport)).blue).toBeGreaterThan(1000);
  await testInfo.attach("editor-camera.png", { body: await viewport.screenshot(), contentType: "image/png" });

  // The other camera is directly in front of the default camera. Its helper
  // must not leak into authored views, including the frozen editor render list.
  await page.getByTestId("viewport-settings").click();
  await page.getByTestId("viewport-game-camera-toggle").click();
  await page.keyboard.press("Escape");
  await expect.poll(async () => (await pixelCounts(viewport)).blue).toBeLessThan(10);
  await expect.poll(async () => (await pixelCounts(viewport)).background).toBeGreaterThan(3000);
  await page.getByTestId("viewport-settings").click();
  await page.getByTestId("viewport-game-camera-toggle").click();
  await page.keyboard.press("Escape");
  await expect.poll(async () => (await pixelCounts(viewport)).blue).toBeGreaterThan(1000);

  await clickPlayAndWaitForOverlay(page);
  const play = page.getByTestId("play-canvas");
  await expect.poll(async () => (await pixelCounts(play)).background).toBeGreaterThan(3000);
  expect((await pixelCounts(play)).blue).toBeLessThan(10);
  expect(errors).toEqual([]);
});
