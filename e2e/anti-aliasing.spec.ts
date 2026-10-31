import { expect, test } from "@playwright/test";
import type { runAntiAliasingProof } from "../apps/editor/src/testing/anti-aliasing-proof";
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
  test(`a static camera draws identical frames and MSAA smooths geometric edges on ${backend}`, async ({ page }, testInfo) => {
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
    expect(result.captures.map((entry) => entry.samples)).toEqual([1, 4, backend === "webgpu" ? 4 : 2, 1, 4, 1]);
    for (const entry of result.captures) {
      expect(entry.first.some((value, i) => i % 4 === 0 && value > 200), `${entry.label}: visible surfaces`).toBe(true);
      // No jitter: a static camera's consecutive frames are the same image, pixel for pixel.
      expect(difference(entry.first, entry.second).max, `${entry.label}: consecutive frames are identical`).toBe(0);
    }
    for (const [aliased, smoothed] of [["off", "msaa4"], ["off", "msaa2"], ["chain off", "chain msaa4"]] as const) {
      expect(partialPixels(capture[aliased]!.first), `${aliased}: aliased edges`).toBeLessThan(8);
      expect(partialPixels(capture[smoothed]!.first), `${smoothed}: smoothed edges`).toBeGreaterThan(40);
      // Multisampling smooths edges only: the image stays in place.
      expect(difference(capture[aliased]!.first, capture[smoothed]!.first).mean, `${smoothed}: same image`).toBeLessThan(6);
    }
    // Back to Off, the view draws exactly what it drew before multisampling.
    expect(difference(capture.off!.first, capture["off again"]!.first).max).toBe(0);
  });
}
