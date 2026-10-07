import { expect, test } from "@playwright/test";
import type { runTemporalAntiAliasingProof } from "../apps/editor/src/testing/temporal-anti-aliasing-proof";
import { SOFTWARE_WEBGPU_ARGS } from "./software-webgpu";

test.use({ launchOptions: { args: SOFTWARE_WEBGPU_ARGS } });

/** Mean and largest absolute channel difference over RGB, ignoring alpha. */
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

/** Bright pixels where the reference shows open background (no surface within one pixel). */
function trailPixels(pixels: number[], reference: number[], width: number) {
  let count = 0;
  const height = reference.length / 4 / width;
  for (let y = 1; y < height - 1; y++)
    for (let x = 1; x < width - 1; x++) {
      let open = true;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++)
          if (reference[((y + dy) * width + x + dx) * 4]! > 8) open = false;
      if (open && pixels[(y * width + x) * 4]! > 24) count++;
    }
  return count;
}

/** Pixels partway between the black background and the white surfaces. */
function partialPixels(pixels: number[]) {
  return pixels.filter((value, i) => i % 4 === 0 && value > 24 && value < 231).length;
}

for (const backend of ["webgl2"] as ("webgl2" | "webgpu")[]) {
  test(`temporal anti-aliasing accumulates and reprojects on ${backend}`, async ({ page }, testInfo) => {
    test.setTimeout(90_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (["warning", "error"].includes(message.type()) &&
        /shader|WebGPU uncaptured|VALIDATE_STATUS|ERROR: 0:|context lost|fatal error/i.test(message.text()))
        errors.push(message.text());
    });
    await page.goto("/?test=1&temporalAntiAliasingProof=1");
    await page.waitForFunction(() => typeof (window as unknown as { __temporalAntiAliasingProof?: unknown }).__temporalAntiAliasingProof === "function");
    const result = await page.evaluate((backend) => (window as unknown as {
      __temporalAntiAliasingProof: typeof runTemporalAntiAliasingProof;
    }).__temporalAntiAliasingProof(backend), backend).catch(async (error: unknown) => {
      await testInfo.attach("temporal-errors", { body: JSON.stringify(errors), contentType: "application/json" });
      throw error;
    });
    await testInfo.attach("temporal-pixels", { body: JSON.stringify(result), contentType: "application/json" });
    expect(errors).toEqual([]);
    expect(result.reservations.reservedBytes).toBe(0);
    expect(result.captures).toHaveLength(1);
    for (const capture of result.captures) {
      expect(capture.off.some((value, i) => i % 4 === 0 && value > 200), "visible surfaces").toBe(true);
      expect(partialPixels(capture.off), "aliased edges without TAA").toBeLessThan(8);
      expect(partialPixels(capture.on), "accumulated edges are smoothed").toBeGreaterThan(40);
      expect(difference(capture.off, capture.on).mean, "accumulation keeps the image in place").toBeLessThan(6);
      expect(difference(capture.on, capture.next).mean, "converged frames are stable").toBeLessThan(1.5);
      expect(capture.projectionRestored, "the camera projection stays unjittered").toBe(true);
      expect(trailPixels(capture.moved, capture.movedReference, result.width), "a moved surface leaves no trail").toBe(0);
      expect(difference(capture.moved, capture.movedReference).mean, "a moved surface resolves").toBeLessThan(6);
      expect(difference(capture.panned, capture.pannedReference).mean, "history follows camera motion").toBeLessThan(5);
    }
  });
}
