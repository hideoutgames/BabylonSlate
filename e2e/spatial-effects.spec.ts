import { expect, test } from "@playwright/test";
import type { runSpatialEffectsProof } from "../apps/editor/src/testing/spatial-effects-proof";
import { SOFTWARE_WEBGPU_ARGS } from "./software-webgpu";

test.use({ launchOptions: { args: SOFTWARE_WEBGPU_ARGS } });
for (const backend of ["webgl2"] as ("webgl2" | "webgpu")[])
  for (const kind of [
    "combined",
  ] as ("reflections" | "point" | "spot" | "sun" | "combined")[]) {
    test(`${kind} spatial lighting renders and retires on ${backend}`, async ({
      page,
    }, testInfo) => {
      test.setTimeout(90_000);
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => {
        if (
          ["warning", "error"].includes(message.type()) &&
          /shader|WebGPU uncaptured|VALIDATE_STATUS|ERROR: 0:|context lost|fatal error/i.test(
            message.text(),
          )
        )
          errors.push(message.text());
      });
      await page.goto("/?test=1&spatialEffectsProof=1");
      await page.waitForFunction(
        () =>
          typeof (window as unknown as { __spatialEffectsProof?: unknown })
            .__spatialEffectsProof === "function",
      );
      const result = await page
        .evaluate(
          ({ backend, kind }) =>
            (
              window as unknown as {
                __spatialEffectsProof: typeof runSpatialEffectsProof;
              }
            ).__spatialEffectsProof(backend, kind),
          { backend, kind },
        )
        .catch(async (error: unknown) => {
          await testInfo.attach("spatial-errors", {
            body: JSON.stringify(errors),
            contentType: "application/json",
          });
          throw error;
        });
      await testInfo.attach("spatial-pixels", {
        body: JSON.stringify(result),
        contentType: "application/json",
      });
      expect(errors).toEqual([]);
      expect(result.reservations.reservedBytes).toBe(0);
      for (const capture of result.captures) {
      for (const difference of capture.stackDifferences)
        expect(difference, "authored stack replacement preserves reflections").toBeLessThan(1);
        expect(
          capture.cameraSwitchDifference,
          "camera switch uses the new camera matrices",
        ).toBeLessThan(1);
        const lit = capture.on.filter(
          (value, i) => i % 4 === 0 && value > capture.off[i]! + 8,
        ).length;
        expect(lit, `${capture.path}: visible ${kind}`).toBeGreaterThan(20);
        const disabledDifference =
          capture.disabled.reduce(
            (sum, value, i) => sum + Math.abs(value - capture.off[i]!),
            0,
          ) / capture.off.length;
        expect(
          disabledDifference,
          `${capture.path}: disabling restores scene color`,
        ).toBeLessThan(1);
        const identityDifference =
          capture.identityDisplay.reduce(
            (sum, value, i) => sum + Math.abs(value - capture.on[i]!),
            0,
          ) / capture.on.length;
        expect(
          identityDifference,
          `${capture.path}: an identity vignette preserves spatial color`,
        ).toBeLessThan(0.5);
        const linearDifference =
          capture.linear.reduce(
            (sum, value, i) => sum + Math.abs(value - capture.on[i]!),
            0,
          ) / capture.on.length;
        expect(
          linearDifference,
          `${capture.path}: default linear display preserves spatial color`,
        ).toBeLessThan(3);
        if (kind !== "reflections") {
          const occluded = capture.changed.filter(
            (value, i) => i % 4 === 0 && value > capture.on[i]! + 3,
          ).length;
          expect(
            occluded,
            `${capture.path}: shadows occlude fog`,
          ).toBeGreaterThan(20);
        } else
          expect(
            capture.changed.some((value, i) => i % 4 === 0 && value > 50),
          ).toBe(true);
      }
      const graph = result.captures[0]!.on,
        native = result.captures[1]!.on;
      expect(
        graph.reduce((sum, value, i) => sum + Math.abs(value - native[i]!), 0) /
          graph.length,
        "native and graph parity",
      ).toBeLessThan(5);
    });
  }

/** Camera spans 12 x 9 world units in a 96 x 72 orthographic capture. */
function fogDarkening(before: number[], after: number[], centerX: number, centerY: number) {
  let difference = 0;
  for (let y = centerY - 1; y <= centerY + 1; y++)
    for (let x = centerX - 1; x <= centerX + 1; x++) {
      const index = (y * 96 + x) * 4;
      difference += before[index]! - after[index]!;
    }
  return difference / 9;
}

function pixelDifference(before: number[], after: number[]) {
  return before.reduce((sum, value, index) => sum + Math.abs(value - after[index]!), 0) / before.length;
}

for (const backend of ["webgl2"] as ("webgl2" | "webgpu")[]) {
  test(`local fog volumes stay bounded and retire on ${backend}`, async ({ page }, testInfo) => {
    test.setTimeout(90_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (["warning", "error"].includes(message.type()) &&
        /shader|WebGPU uncaptured|VALIDATE_STATUS|ERROR: 0:|context lost|fatal error/i.test(message.text()))
        errors.push(message.text());
    });
    await page.goto("/?test=1&spatialEffectsProof=1");
    await page.waitForFunction(() => typeof (window as unknown as {
      __spatialEffectsProof?: unknown;
    }).__spatialEffectsProof === "function");
    const result = await page.evaluate((backend) => (window as unknown as {
      __spatialEffectsProof: typeof runSpatialEffectsProof;
    }).__spatialEffectsProof(backend, "fogVolumes"), backend).catch(async (error: unknown) => {
      await testInfo.attach("fog-volume-errors", {
        body: JSON.stringify(errors), contentType: "application/json",
      });
      throw error;
    });
    await testInfo.attach("fog-volume-pixels", {
      body: JSON.stringify(result), contentType: "application/json",
    });
    expect(errors).toEqual([]);
    expect(result.reservations.reservedBytes).toBe(0);
    expect(result.fogCaptures).toHaveLength(2);
    for (const capture of result.fogCaptures) {
      const { path, off, box, moved, sphere } = capture;
      expect(off[(36 * 96 + 32) * 4], `${path}: visible neutral backdrop`).toBeGreaterThan(100);
      expect(fogDarkening(off, box, 32, 36), `${path}: local fog activates with global fog disabled and density zero`).toBeGreaterThan(30);
      expect(Math.abs(fogDarkening(off, box, 64, 36)), `${path}: neighboring rays remain clear`).toBeLessThan(1);
      expect(pixelDifference(box, capture.overlap), `${path}: overlapping half-density media equal one full-density volume`).toBeLessThan(1);

      // One diagonal crosses the rotated long axis; the other misses its short
      // axis. Sorting avoids depending on the GPU readback's vertical origin.
      const diagonals = [
        (fogDarkening(off, box, 40, 44) + fogDarkening(off, box, 24, 28)) / 2,
        (fogDarkening(off, box, 40, 28) + fogDarkening(off, box, 24, 44)) / 2,
      ].sort((a, b) => a - b);
      expect(Math.abs(diagonals[0]!), `${path}: rotated box's narrow axis`).toBeLessThan(1);
      expect(diagonals[1], `${path}: rotated box's long axis`).toBeGreaterThan(15);
      expect(Math.abs(fogDarkening(off, moved, 32, 36)), `${path}: live movement clears the old location`).toBeLessThan(1);
      expect(fogDarkening(off, moved, 64, 36), `${path}: live movement reaches the new location`).toBeGreaterThan(30);
      expect(fogDarkening(off, sphere, 74, 36), `${path}: scaled sphere extends horizontally`).toBeGreaterThan(20);
      expect(Math.abs(fogDarkening(off, sphere, 64, 44)), `${path}: scaled sphere remains narrow vertically`).toBeLessThan(1);
      // The ellipsoid is centered at x=2 with radii [2, 0.5, 1]. Boundary
      // pixels span x=3.44..3.69 (local x=0.72..0.84), within its falloff band.
      // The center rays remain in its dense core; both samples stay in bounds.
      const hardBoundary = fogDarkening(off, sphere, 76, 36);
      const softBoundary = fogDarkening(off, capture.softSphere, 76, 36);
      const softCore = fogDarkening(off, capture.softSphere, 64, 36);
      expect(hardBoundary - softBoundary, `${path}: edge falloff softens the same boundary rays`).toBeGreaterThan(20);
      expect(softBoundary, `${path}: the soft boundary retains partial fog`).toBeGreaterThan(2);
      expect(softBoundary, `${path}: the falloff band is thinner than the core`).toBeLessThan(softCore / 2);
      expect(softCore, `${path}: soft edges retain a dense core`).toBeGreaterThan(30);
      expect(pixelDifference(off, capture.disabled), `${path}: disabled local sources restore scene color`).toBeLessThan(1);
      expect(pixelDifference(off, capture.removed), `${path}: removing the final source restores scene color`).toBeLessThan(1);
      expect(fogDarkening(capture.insideOff, capture.inside, 48, 36), `${path}: camera inside a volume sees fog`).toBeGreaterThan(30);
    }
    expect(pixelDifference(result.fogCaptures[0]!.box, result.fogCaptures[1]!.box), "native and graph local fog parity").toBeLessThan(3);
  });
}

/** Pixels at least `threshold` darker in `after`, red channel only. */
function darkened(before: number[], after: number[], threshold: number) {
  return before.filter((value, i) => i % 4 === 0 && value - after[i]! >= threshold).length;
}

for (const backend of ["webgl2"] as ("webgl2" | "webgpu")[]) {
  test(`ambient occlusion darkens contact creases and retires on ${backend}`, async ({ page }, testInfo) => {
    test.setTimeout(90_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (["warning", "error"].includes(message.type()) &&
        /shader|WebGPU uncaptured|VALIDATE_STATUS|ERROR: 0:|context lost|fatal error/i.test(message.text()))
        errors.push(message.text());
    });
    await page.goto("/?test=1&spatialEffectsProof=1");
    await page.waitForFunction(() => typeof (window as unknown as {
      __spatialEffectsProof?: unknown;
    }).__spatialEffectsProof === "function");
    const result = await page.evaluate((backend) => (window as unknown as {
      __spatialEffectsProof: typeof runSpatialEffectsProof;
    }).__spatialEffectsProof(backend, "ambientOcclusion"), backend).catch(async (error: unknown) => {
      await testInfo.attach("occlusion-errors", { body: JSON.stringify(errors), contentType: "application/json" });
      throw error;
    });
    await testInfo.attach("occlusion-pixels", { body: JSON.stringify(result), contentType: "application/json" });
    expect(errors).toEqual([]);
    expect(result.reservations.reservedBytes).toBe(0);
    expect(result.occlusionCaptures).toHaveLength(2);
    const pixels = 96 * 72;
    for (const capture of result.occlusionCaptures) {
      const { path, off, on } = capture;
      expect(darkened(off, on, 8), `${path}: the crate's contact crease darkens`).toBeGreaterThan(20);
      // Open floor and the cleared background receive no occlusion.
      const unchanged = off.filter((value, i) => i % 4 === 0 && Math.abs(value - on[i]!) <= 2).length;
      expect(unchanged, `${path}: unoccluded pixels keep scene color`).toBeGreaterThan(pixels * 0.6);
      expect(on.filter((value, i) => i % 4 === 0 && value > off[i]! + 2).length, `${path}: occlusion never brightens`).toBe(0);
      expect(darkened(off, capture.linear, 8), `${path}: Scene Linear keeps occlusion`).toBeGreaterThan(20);
      expect(darkened(capture.orthographicOff, capture.orthographic, 8), `${path}: orthographic occlusion`).toBeGreaterThan(20);
      expect(pixelDifference(off, capture.disabled), `${path}: disabling restores scene color`).toBeLessThan(1);
    }
    expect(pixelDifference(result.occlusionCaptures[0]!.on, result.occlusionCaptures[1]!.on), "native and graph parity").toBeLessThan(3);
  });
}
