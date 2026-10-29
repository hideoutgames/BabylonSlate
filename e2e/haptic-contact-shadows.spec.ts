import { expect, test } from "@playwright/test";
import type { runHapticContactShadowProof } from "../apps/editor/src/testing/haptic-contact-shadow-proof";
import { SOFTWARE_WEBGPU_ARGS } from "./software-webgpu";

test.use({ launchOptions: { args: SOFTWARE_WEBGPU_ARGS } });

type Proof = typeof runHapticContactShadowProof;
type Result = Awaited<ReturnType<Proof>>;

/** The largest channel difference between two captures at a pixel. */
function difference(a: number[], b: number[], pixel: number) {
  let largest = 0;
  for (let channel = 0; channel < 3; channel++) largest = Math.max(largest, Math.abs(a[pixel * 4 + channel]! - b[pixel * 4 + channel]!));
  return largest;
}

function capture(result: Result, name: string) {
  const found = result.captures.find((entry) => entry.name === name);
  if (!found) throw new Error(`No ${name} capture`);
  return found;
}

/**
 * Per floor pixel of a shadow mask (1 blocked, 0 open, -1 off the floor), how many pixels away (in rings) the nearest
 * floor pixel of the other kind is; off the floor, -1.
 */
function distanceToEdge(blocked: number[], width: number, height: number) {
  const distance = blocked.map(() => -1);
  for (let pixel = 0; pixel < blocked.length; pixel++) {
    const kind = blocked[pixel]!;
    if (kind < 0) continue;
    const row = Math.floor(pixel / width), column = pixel % width;
    let ring = 1;
    for (; ring < Math.max(width, height); ring++) {
      let other = false;
      for (let dy = -ring; dy <= ring && !other; dy++) {
        for (let dx = -ring; dx <= ring; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
          const y = row + dy, x = column + dx;
          if (y < 0 || y >= height || x < 0 || x >= width) continue;
          const neighbour = blocked[y * width + x]!;
          if (neighbour >= 0 && neighbour !== kind) {
            other = true;
            break;
          }
        }
      }
      if (other) break;
    }
    distance[pixel] = ring;
  }
  return distance;
}

for (const backend of ["webgl2", "webgpu"] as const) {
  test(`Contact Hardening on the light block draws Babylon's PCSS from the shadow atlas on ${backend}`, async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (["error", "warning"].includes(message.type()) &&
        /shader|WGSL|WebGPU uncaptured|VALIDATE_STATUS|GL_INVALID|ERROR: 0:|context lost|fatal error/i.test(message.text())) errors.push(message.text());
    });
    await page.goto("/?test=1&hapticContactShadowProof=1");
    await page.waitForFunction(() => typeof (window as unknown as { __hapticContactShadowProof?: unknown }).__hapticContactShadowProof === "function");
    const run = (path: "babylon" | "haptic") => page.evaluate(([backend, path]) =>
      (window as unknown as { __hapticContactShadowProof: Proof }).__hapticContactShadowProof(backend, path), [backend, path] as const);
    const babylon = await run("babylon");
    const haptic = await run("haptic");
    const count = haptic.width * haptic.height;
    const report: Record<string, unknown> = {};
    for (const light of ["spot", "sun"]) {
      const reference = capture(babylon, light).pixels, drawn = capture(haptic, light).pixels, open = capture(haptic, `${light} unshadowed`).pixels;
      const differences = Array.from({ length: count }, (_, pixel) => difference(reference, drawn, pixel));
      const shadowed = Array.from({ length: count }, (_, pixel) => pixel).filter((pixel) => difference(open, reference, pixel) > 2);
      report[light] = {
        atlas: [capture(babylon, light).atlas, capture(haptic, light).atlas],
        shadowed: shadowed.length,
        contrast: shadowed.reduce((sum, pixel) => sum + difference(open, reference, pixel), 0) / Math.max(1, shadowed.length),
        outliers: differences.filter((value) => value > 2).length,
        largest: Math.max(...differences),
        mean: differences.reduce((sum, value) => sum + value, 0) / count,
      };
    }
    for (const light of ["sun", "point"]) {
      const blocked = haptic.blocked[light]!;
      const edge = distanceToEdge(blocked, haptic.width, haptic.height);
      const drawn = capture(haptic, light).pixels, open = capture(haptic, `${light} unshadowed`).pixels, unlit = capture(haptic, `${light} unlit`).pixels;
      const bands: Record<number, { umbra: number; umbraLit: number; open: number; openShadowed: number }> = {};
      for (let ring = 1; ring <= 6; ring++) {
        const umbra = blocked.map((kind, pixel) => (kind === 1 && edge[pixel]! >= ring ? pixel : -1)).filter((pixel) => pixel >= 0);
        const far = blocked.map((kind, pixel) => (kind === 0 && edge[pixel]! >= ring ? pixel : -1)).filter((pixel) => pixel >= 0);
        bands[ring] = {
          umbra: umbra.length,
          umbraLit: umbra.filter((pixel) => difference(drawn, unlit, pixel) > 2).length,
          open: far.length,
          openShadowed: far.filter((pixel) => difference(drawn, open, pixel) > 2).length,
        };
      }
      report[`${light} mask`] = bands;
    }
    const celPcss = capture(haptic, "cel spot").pixels, celPcf = capture(haptic, "cel spot pcf").pixels;
    report.cel = { differing: Array.from({ length: count }, (_, pixel) => difference(celPcss, celPcf, pixel)).filter((value) => value > 0).length };
    await testInfo.attach(`haptic-contact-shadows-${backend}`, { body: JSON.stringify(report, null, 2), contentType: "application/json" });
    console.log(JSON.stringify(report));
    expect(errors).toEqual([]);
  });
}
