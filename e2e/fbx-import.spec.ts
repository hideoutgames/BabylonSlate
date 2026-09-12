import path from "node:path";
import { expect, test } from "@playwright/test";
import { openAssetFromBrowser, openTestProject } from "./open-test-project";

test("FBX worker imports a canonical model with a stable rest-pose preview", async ({
  page,
}) => {
  await openTestProject(page);
  await page
    .getByTestId("content-browser-import-input")
    .setInputFiles(
      path.join(process.cwd(), "packages/render/src/__fixtures__/fbx/box.fbx"),
    );
  await expect(
    page.locator('[data-asset-path="assets/box.babasset"]'),
  ).toBeVisible({ timeout: 30000 });
  await openAssetFromBrowser(page, "assets/box.babasset");
  const canvas = page.getByTestId("model-preview-canvas");
  await expect(canvas).toBeVisible();
  const pixels = () =>
    canvas.evaluate((element: HTMLCanvasElement) => {
      const data = element
        .getContext("2d")!
        .getImageData(0, 0, element.width, element.height).data;
      let visible = 0;
      for (let i = 3; i < data.length; i += 4) if (data[i]! > 0) visible++;
      return visible;
    });
  await expect.poll(pixels).toBeGreaterThan(100);
});
