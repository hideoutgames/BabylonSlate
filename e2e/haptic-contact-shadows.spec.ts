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

/** Per pixel, the Chebyshev distance to the nearest pixel where `source` holds (a breadth-first search over 8 neighbours). */
function chebyshevDistance(source: boolean[], width: number, height: number): number[] {
  const distance = source.map((held) => (held ? 0 : Infinity));
  const queue = source.flatMap((held, pixel) => (held ? [pixel] : []));
  for (let head = 0; head < queue.length; head++) {
    const pixel = queue[head]!, row = Math.floor(pixel / width), column = pixel % width;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const y = row + dy, x = column + dx;
        if (y < 0 || y >= height || x < 0 || x >= width) continue;
        const neighbour = y * width + x;
        if (distance[neighbour]! <= distance[pixel]! + 1) continue;
        distance[neighbour] = distance[pixel]! + 1;
        queue.push(neighbour);
      }
    }
  }
  return distance;
}

/** Per floor pixel of a shadow mask (1 blocked, 0 open, -1 off the floor), how far the nearest floor pixel of the other kind is. */
function distanceToEdge(blocked: number[], width: number, height: number) {
  const toBlocked = chebyshevDistance(blocked.map((kind) => kind === 1), width, height);
  const toOpen = chebyshevDistance(blocked.map((kind) => kind === 0), width, height);
  return blocked.map((kind, pixel) => (kind === 1 ? toOpen[pixel]! : kind === 0 ? toBlocked[pixel]! : -1));
}

/** The share of a light's contribution a pixel keeps (its largest channel), between unlit (0) and unshadowed (1). */
function lightShare(drawn: number[], open: number[], unlit: number[], pixel: number) {
  let share = 0;
  for (let channel = 0; channel < 3; channel++) {
    const full = open[pixel * 4 + channel]! - unlit[pixel * 4 + channel]!;
    if (full > 8) share = Math.max(share, (drawn[pixel * 4 + channel]! - unlit[pixel * 4 + channel]!) / full);
  }
  return share;
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
      const shadowed = Array.from({ length: count }, (_, pixel) => pixel).filter((pixel) => difference(open, drawn, pixel) > 2);
      report[light] = {
        atlas: [capture(babylon, light).atlas, capture(haptic, light).atlas],
        shadowed: shadowed.length,
        contrast: shadowed.reduce((sum, pixel) => sum + difference(open, drawn, pixel), 0) / Math.max(1, shadowed.length),
        outliers: differences.filter((value) => value > 2).length,
        largest: Math.max(...differences),
        mean: differences.reduce((sum, value) => sum + value, 0) / count,
      };
    }
    for (const light of ["sun", "point"]) {
      const blocked = haptic.blocked[light]!;
      const edge = distanceToEdge(blocked, haptic.width, haptic.height);
      const drawn = capture(haptic, light).pixels, open = capture(haptic, `${light} unshadowed`).pixels, unlit = capture(haptic, `${light} unlit`).pixels;
      const bands: Record<number, { umbra: number; umbraShare: number; open: number; openShadowed: number }> = {};
      for (let ring = 1; ring <= 6; ring++) {
        const umbra = blocked.map((kind, pixel) => (kind === 1 && edge[pixel]! >= ring ? pixel : -1)).filter((pixel) => pixel >= 0);
        const far = blocked.map((kind, pixel) => (kind === 0 && edge[pixel]! >= ring ? pixel : -1)).filter((pixel) => pixel >= 0);
        bands[ring] = {
          umbra: umbra.length,
          umbraShare: Math.max(0, ...umbra.map((pixel) => lightShare(drawn, open, unlit, pixel))),
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
    const spot = report.spot as { atlas: boolean[]; shadowed: number; outliers: number; largest: number };
    const sun = report.sun as { atlas: boolean[]; shadowed: number };
    // Babylon's maps on its path, atlas tiles on the block's.
    expect([spot.atlas, sun.atlas]).toEqual([[false, true], [false, true]]);
    expect(spot.shadowed).toBeGreaterThan(200);
    // The spot light's matches Babylon's PCSS but for float rounding and the blockers' depth (measured: up to 9 pixels,
    // by up to 9/255).
    expect(spot.outliers).toBeLessThanOrEqual(12);
    expect(spot.largest).toBeLessThanOrEqual(12);
    // The point light's faces: two pixels from the shadow's outline, the open floor is as lit as without the shadow, and
    // the shadowed floor keeps under a third of the light (Babylon's PCSS lightens a shadow with its blockers' distance;
    // measured: 0.29 on WebGL2, 0.19 on WebGPU).
    const point = (report["point mask"] as Record<number, { umbra: number; umbraShare: number; open: number; openShadowed: number }>)[2]!;
    expect(point.umbra).toBeGreaterThan(400);
    expect(point.openShadowed).toBe(0);
    expect(point.umbraShare).toBeLessThan(1 / 3);
    // CEL draws Contact Hardening as PCF.
    expect(report.cel).toEqual({ differing: 0 });
  });
}
