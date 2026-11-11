import { expect, test } from "@playwright/test";
import type { runSceneLayerBatchingProof } from "../apps/editor/src/testing/scene-layer-batching-proof";
import { encodeRgbaPng } from "../packages/render/src/png-encode";
import { SOFTWARE_WEBGPU_ARGS } from "./software-webgpu";

test.use({ launchOptions: { args: SOFTWARE_WEBGPU_ARGS } });

type Proof = typeof runSceneLayerBatchingProof;

/** Pixels whose channels differ at all, and the first few of them. */
function differences(a: number[], b: number[], width: number) {
  const first: string[] = [];
  let count = 0;
  for (let pixel = 0; pixel < a.length / 4; pixel += 1) {
    let same = true;
    for (let channel = 0; channel < 4; channel += 1) if (a[pixel * 4 + channel] !== b[pixel * 4 + channel]) same = false;
    if (same) continue;
    count += 1;
    if (first.length < 8) first.push(`(${pixel % width}, ${Math.floor(pixel / width)}): ${a.slice(pixel * 4, pixel * 4 + 4)} vs ${b.slice(pixel * 4, pixel * 4 + 4)}`);
  }
  return { count, first };
}

for (const backend of ["webgl2", "webgpu"] as const) for (const images of ["filtered", "nearest"] as const) {
  const title = images === "nearest"
    ? `a batched Scene Layer HUD whose images share a page draws the same image as its meshes one by one, in fewer draws than from their own textures, on ${backend}`
    : `a batched Scene Layer HUD draws the same image as its meshes one by one, in fewer draws, on ${backend}`;
  test(title, async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (["error", "warning"].includes(message.type()) &&
        /shader|WGSL|WebGPU uncaptured|VALIDATE_STATUS|GL_INVALID|ERROR: 0:|context lost|fatal error/i.test(message.text()))
        errors.push(message.text());
    });
    await page.goto("/?test=1&sceneLayerBatchingProof=1");
    await page.waitForFunction(() => typeof (window as unknown as { __sceneLayerBatchingProof?: unknown }).__sceneLayerBatchingProof === "function");
    const result = await page.evaluate(([backend, images]) =>
      (window as unknown as { __sceneLayerBatchingProof: Proof }).__sceneLayerBatchingProof(backend, images), [backend, images] as const);
    const report = result.cases.map(({ name, batched, unbatched, pages, ownTextures }) => ({
      name, draws: { batched: batched.draws, ownTextures, unbatched: unbatched.draws }, pages, differences: differences(unbatched.pixels, batched.pixels, result.width),
      drawn: unbatched.pixels.filter((value, index) => index % 4 === 0 && value > 40).length,
    }));
    await testInfo.attach(`scene-layer-batching-${backend}-${images}`, { body: JSON.stringify(report, null, 2), contentType: "application/json" });
    for (const { name, batched, unbatched } of result.cases) {
      for (const [label, image] of [["batched", batched], ["unbatched", unbatched]] as const) {
        await testInfo.attach(`${backend}-${images}-${name}-${label}.png`, {
          body: Buffer.from(encodeRgbaPng(result.width, result.height, new Uint8Array(image.pixels))), contentType: "image/png",
        });
      }
    }
    expect(errors).toEqual([]);
    for (const entry of report) {
      // The HUD drew: many pixels are brighter than the background.
      expect(entry.drawn, entry.name).toBeGreaterThan(result.width * result.height / 20);
      // Exactly the same image, every channel of every pixel.
      expect(entry.differences, entry.name).toEqual({ count: 0, first: [] });
      expect(entry.draws.batched, entry.name).toBeLessThan(entry.draws.unbatched * 0.7);
      if (images === "nearest") {
        // Every icon and sprite image that has a texel grid is on the page and drawn there, and batches that sample it
        // are fewer than those of the images' own textures.
        expect(result.pageImages).toBe(10);
        expect(entry.pages, entry.name).toEqual({ images: 10, drawn: 10 });
        expect(entry.draws.batched, entry.name).toBeLessThan(entry.draws.ownTextures);
      } else {
        // A filtered image stays on its own texture: a lookup on a page would blend in its neighbours' texels.
        expect(entry.pages, entry.name).toEqual({ images: 0, drawn: 0 });
        expect(entry.draws.batched, entry.name).toBe(entry.draws.ownTextures);
      }
    }
  });
}
