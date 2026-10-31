import { expect, test, type Page, type TestInfo } from "@playwright/test";
import type { runWaterCoverageProof } from "../apps/editor/src/testing/water-coverage-proof";
import { SOFTWARE_WEBGPU_ARGS } from "./software-webgpu";

test.use({ launchOptions: { args: SOFTWARE_WEBGPU_ARGS } });

/** Water Mesh Density: Low's, Medium and High's, and Ultra's. */
const DENSITIES = [0.75, 1, 1.5] as const;
const background = (pixels: number[], index: number) => pixels[index]! > 200 && pixels[index + 1]! < 60 && pixels[index + 2]! > 200;

/** Every view's holes (background below the water 800 m ahead, which water must fill), with the frames attached. */
async function coverage(page: Page, testInfo: TestInfo, backend: "webgl2" | "webgpu", density: number) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (["error", "warning"].includes(message.type()) &&
      /shader|WGSL|WebGPU uncaptured|VALIDATE_STATUS|GL_INVALID|ERROR: 0:|context lost|fatal error/i.test(message.text())) errors.push(message.text());
  });
  await page.goto("/?test=1&waterCoverageProof=1");
  await page.waitForFunction(() => typeof (window as unknown as { __waterCoverageProof?: unknown }).__waterCoverageProof === "function");
  const result = await page.evaluate(([backend, density]) =>
    (window as unknown as { __waterCoverageProof: typeof runWaterCoverageProof }).__waterCoverageProof(backend, density), [backend, density] as const);
  expect(errors).toEqual([]);
  const holes = result.views.map((view) => {
    const where: string[] = [];
    let count = 0;
    for (let index = 0; index < view.pixels.length; index += 4) {
      if (!background(view.pixels, index)) continue;
      const x = (index / 4) % result.width, read = Math.floor(index / 4 / result.width);
      const row = result.flipped ? result.height - 1 - read : read;
      if (row < view.checkedFrom) continue;
      count++;
      if (where.length < 12) where.push(`${x},${row}`);
    }
    return { camera: view.camera.join(", "), count, where: where.join(" ") };
  });
  await testInfo.attach(`water-coverage-${backend}-${density}`, { body: JSON.stringify(holes), contentType: "application/json" });
  for (const [index, view] of result.views.entries()) {
    const png = await page.evaluate(({ pixels, width, height, flipped }) => {
      const canvas = document.createElement("canvas");
      canvas.width = width; canvas.height = height;
      const image = new ImageData(width, height);
      for (let row = 0; row < height; row++) {
        const from = (flipped ? height - 1 - row : row) * width * 4;
        image.data.set(pixels.slice(from, from + width * 4), row * width * 4);
      }
      canvas.getContext("2d")!.putImageData(image, 0, 0);
      return canvas.toDataURL("image/png").split(",")[1]!;
    }, { pixels: view.pixels, width: result.width, height: result.height, flipped: result.flipped });
    await testInfo.attach(`water-coverage-${backend}-${density}-view${index}.png`, { body: Buffer.from(png, "base64"), contentType: "image/png" });
  }
  return holes.map((view) => ({ ...view, text: `${view.camera}: ${view.count} at ${view.where}` }));
}

for (const backend of ["webgl2", "webgpu"] as const) {
  for (const density of DENSITIES) {
    test(`blended water covers the whole frame with far neighbours at Water Mesh Density ${density} on ${backend}`, async ({ page }, testInfo) => {
      test.setTimeout(180_000);
      const holes = await coverage(page, testInfo, backend, density);
      // Any background in a view is a hole no body keeps.
      expect(holes.filter((view) => view.count > 0).map((view) => view.text)).toEqual([]);
    });
  }
}
