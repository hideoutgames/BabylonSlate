import { expect, test } from "@playwright/test";
import type { runAntiAliasingHaloProof, runAntiAliasingProof } from "../apps/editor/src/testing/anti-aliasing-proof";
import { SOFTWARE_WEBGPU_ARGS } from "./software-webgpu";

test.use({ launchOptions: { args: SOFTWARE_WEBGPU_ARGS } });

/** Largest and mean absolute channel difference over RGB, ignoring alpha. */
function difference(a: number[], b: number[]) {
  let sum = 0, count = 0, max = 0;
  for (let i = 0; i < a.length; i++) {
    if (i % 4 === 3) continue;
    const delta = Math.abs(a[i]! - b[i]!);
    sum += delta;
    max = Math.max(max, delta);
    count++;
  }
  return { mean: sum / count, max };
}

/** Pixels partway between the black background and the white surfaces: smoothed edge pixels. */
function partialPixels(pixels: number[]) {
  return pixels.filter((value, i) => i % 4 === 0 && value > 24 && value < 231).length;
}

for (const backend of ["webgl2", "webgpu"] as const) {
  test(`a static camera draws identical frames and MSAA smooths geometric and alpha-tested edges on ${backend}`, async ({ page }, testInfo) => {
    test.setTimeout(90_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (["warning", "error"].includes(message.type()) &&
        /shader|WebGPU uncaptured|VALIDATE_STATUS|ERROR: 0:|INVALID_(?:ENUM|OPERATION|VALUE)|context lost|fatal error/i.test(message.text()))
        errors.push(message.text());
    });
    await page.goto("/?test=1&antiAliasingProof=1");
    await page.waitForFunction(() => typeof (window as unknown as { __antiAliasingProof?: unknown }).__antiAliasingProof === "function");
    const result = await page.evaluate((backend) => (window as unknown as {
      __antiAliasingProof: typeof runAntiAliasingProof;
    }).__antiAliasingProof(backend), backend).catch(async (error: unknown) => {
      await testInfo.attach("anti-aliasing-errors", { body: JSON.stringify(errors), contentType: "application/json" });
      throw error;
    });
    await testInfo.attach("anti-aliasing-pixels", { body: JSON.stringify(result), contentType: "application/json" });
    expect(errors).toEqual([]);
    expect(result.reservations.reservedBytes).toBe(0);
    const capture = Object.fromEntries(result.captures.map((entry) => [entry.label, entry]));
    // WebGPU multisamples at 4 only.
    expect(result.captures.map((entry) => entry.samples)).toEqual([1, 4, backend === "webgpu" ? 4 : 2, 1, 4, 1, 4, 1, 4]);
    for (const entry of result.captures) {
      expect(entry.first.some((value, i) => i % 4 === 0 && value > 200), `${entry.label}: visible surfaces`).toBe(true);
      // No jitter: a static camera's consecutive frames are the same image, pixel for pixel.
      expect(difference(entry.first, entry.second).max, `${entry.label}: consecutive frames are identical`).toBe(0);
    }
    // The cutout's edges are alpha-test edges: MSAA alone leaves them hard, alpha-to-coverage smooths them.
    for (const [aliased, smoothed] of [["off", "msaa4"], ["off", "msaa2"], ["chain off", "chain msaa4"], ["cutout off", "cutout msaa4"]] as const) {
      expect(partialPixels(capture[aliased]!.first), `${aliased}: aliased edges`).toBeLessThan(8);
      expect(partialPixels(capture[smoothed]!.first), `${smoothed}: smoothed edges`).toBeGreaterThan(40);
      // Multisampling smooths edges only: the image stays in place.
      expect(difference(capture[aliased]!.first, capture[smoothed]!.first).mean, `${smoothed}: same image`).toBeLessThan(6);
    }
    // Back to Off, the view draws exactly what it drew before multisampling.
    expect(difference(capture.off!.first, capture["off again"]!.first).max).toBe(0);
  });
}

/**
 * Pixels MSAA changed (any channel by more than `threshold`) that lie more than one pixel from every edge of the aliased
 * image (a pixel whose 3 × 3 neighbourhood spans more than 24 in any channel, so a grey silhouette on sky counts): a halo of an effect whose depth disagrees with
 * the resolved colour.
 */
function haloPixels(aliased: number[], smoothed: number[], width: number, threshold: number) {
  const height = aliased.length / 4 / width;
  const edge = new Uint8Array(width * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const low = [255, 255, 255], high = [0, 0, 0];
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = Math.min(width - 1, Math.max(0, x + dx)), ny = Math.min(height - 1, Math.max(0, y + dy));
          for (let c = 0; c < 3; c++) {
            const value = aliased[(ny * width + nx) * 4 + c]!;
            low[c] = Math.min(low[c]!, value);
            high[c] = Math.max(high[c]!, value);
          }
        }
      if (low.some((value, c) => high[c]! - value > 24)) edge[y * width + x] = 1;
    }
  let count = 0;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      let near = false;
      for (let dy = -1; dy <= 1 && !near; dy++)
        for (let dx = -1; dx <= 1 && !near; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx >= 0 && ny >= 0 && nx < width && ny < height && edge[ny * width + nx]) near = true;
        }
      if (near) continue;
      const i = (y * width + x) * 4;
      if ([0, 1, 2].some((c) => Math.abs(aliased[i + c]! - smoothed[i + c]!) > threshold)) count++;
    }
  return count;
}

for (const backend of ["webgl2", "webgpu"] as const) {
  test(`MSAA leaves no halo beside silhouettes over ambient occlusion, reflections and water on ${backend}`, async ({ page }, testInfo) => {
    test.setTimeout(90_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (["warning", "error"].includes(message.type()) &&
        /shader|WebGPU uncaptured|VALIDATE_STATUS|ERROR: 0:|INVALID_(?:ENUM|OPERATION|VALUE)|context lost|fatal error/i.test(message.text()))
        errors.push(message.text());
    });
    await page.goto("/?test=1&antiAliasingProof=1");
    await page.waitForFunction(() => typeof (window as unknown as { __antiAliasingHaloProof?: unknown }).__antiAliasingHaloProof === "function");
    const result = await page.evaluate((backend) => (window as unknown as {
      __antiAliasingHaloProof: typeof runAntiAliasingHaloProof;
    }).__antiAliasingHaloProof(backend), backend);
    await testInfo.attach("anti-aliasing-halo", { body: JSON.stringify(result), contentType: "application/json" });
    expect(errors).toEqual([]);
    // Every depth reader is in the frame: the spatial chain and the water scene copy.
    expect(result.tasks).toEqual(expect.arrayContaining(["Scene Ambient Occlusion", "Scene Reflections", "Water scene copy"]));
    const [aliased, smoothed] = result.captures;
    expect([aliased!.samples, smoothed!.samples]).toEqual([1, 4]);
    expect(difference(aliased!.pixels, smoothed!.pixels).mean, "same image").toBeLessThan(6);
    expect(haloPixels(aliased!.pixels, smoothed!.pixels, result.width, 16), "no halo away from the edges").toBe(0);
  });
}
