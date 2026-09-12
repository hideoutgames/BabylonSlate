import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Locator } from "@playwright/test";
import { parseGlbForBrowse } from "../packages/assets/src/importers/glb-parse";
import { openAssetFromBrowser, openTestProject } from "./open-test-project";

async function renderedColors(canvas: Locator): Promise<number> {
  return canvas.evaluate((element: HTMLCanvasElement) => {
    const pixels = element
      .getContext("2d")!
      .getImageData(0, 0, element.width, element.height).data;
    const colors = new Set<number>();
    for (let i = 0; i < pixels.length; i += 4)
      if (pixels[i + 3]! > 0)
        colors.add((pixels[i]! << 16) | (pixels[i + 1]! << 8) | pixels[i + 2]!);
    return colors.size;
  });
}

test("Model preview remains in its authored pose while Animation preview advances", async ({
  page,
}, testInfo) => {
  test.setTimeout(180000);
  await openTestProject(page);
  // Optional local regression input stays outside the repository and CI artifacts.
  const source = process.env.BL_TEST_MODEL_SOURCE;
  let modelPath = "assets/Mannequin/mannequin.babasset";
  let animationPath = "assets/Mannequin/mannequin_idle.babasset";
  if (source) {
    const name = path.basename(source, path.extname(source));
    const clip = parseGlbForBrowse(new Uint8Array(readFileSync(source)))!
      .animations[0]!.name;
    modelPath = `assets/${name}.babasset`;
    animationPath = `assets/${name}_${clip}.babasset`;
    await page
      .getByTestId("content-browser-import-input")
      .setInputFiles(source);
    await expect(page.locator(`[data-asset-path="${modelPath}"]`)).toBeVisible({
      timeout: 90000,
    });
    await expect(page.getByTestId("importing-overlay")).toHaveCount(0, {
      timeout: 90000,
    });
  }
  await openAssetFromBrowser(page, modelPath);
  const model = page.getByTestId("model-preview-canvas");
  await expect
    .poll(() => renderedColors(model), { timeout: 30000 })
    .toBeGreaterThan(20);
  const frames = await model.evaluate(async (canvas: HTMLCanvasElement) => {
    const first = canvas.toDataURL();
    await new Promise<void>((resolve) => window.setTimeout(resolve, 2200));
    return [first, canvas.toDataURL()];
  });
  expect(frames[1]).toBe(frames[0]);
  await model.screenshot({ path: testInfo.outputPath("authored-pose.png") });
  await openAssetFromBrowser(page, animationPath);
  const animation = page.getByTestId("animation-preview-canvas");
  await expect(animation).toHaveAttribute("data-playing", "true");
  await expect
    .poll(() => renderedColors(animation), { timeout: 30000 })
    .toBeGreaterThan(20);
  const first = await animation.evaluate((canvas: HTMLCanvasElement) =>
    canvas.toDataURL(),
  );
  await expect
    .poll(() =>
      animation.evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL()),
    )
    .not.toBe(first);
});
