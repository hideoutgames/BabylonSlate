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

type Band = { umbra: number; umbraShare: number; umbraLit: number; open: number; openShadowed: number };

for (const backend of ["webgl2", "webgpu"] as const) {
  test(`Contact Hardening on the light block draws each light's shadow from the shadow atlas where its blockers are, on ${backend}`, async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (["error", "warning"].includes(message.type()) &&
        /shader|WGSL|WebGPU uncaptured|VALIDATE_STATUS|GL_INVALID|ERROR: 0:|context lost|fatal error/i.test(message.text())) errors.push(message.text());
    });
    await page.goto("/?test=1&hapticContactShadowProof=1");
    await page.waitForFunction(() => typeof (window as unknown as { __hapticContactShadowProof?: unknown }).__hapticContactShadowProof === "function");
    const result = await page.evaluate((backend) =>
      (window as unknown as { __hapticContactShadowProof: Proof }).__hapticContactShadowProof(backend), backend);
    const count = result.width * result.height;
    const report: Record<string, unknown> = {};
    const bandsOf: Record<string, Record<number, Band>> = {};
    for (const light of ["spot", "sun", "point"]) {
      const blocked = result.blocked[light]!;
      const edge = distanceToEdge(blocked, result.width, result.height);
      const drawn = capture(result, light).pixels, open = capture(result, `${light} unshadowed`).pixels, unlit = capture(result, `${light} unlit`).pixels;
      const shadowed = Array.from({ length: count }, (_, pixel) => pixel).filter((pixel) => difference(open, drawn, pixel) > 2);
      const bands: Record<number, Band> = {};
      for (let ring = 1; ring <= 6; ring++) {
        const umbra = blocked.map((kind, pixel) => (kind === 1 && edge[pixel]! >= ring ? pixel : -1)).filter((pixel) => pixel >= 0);
        const far = blocked.map((kind, pixel) => (kind === 0 && edge[pixel]! >= ring ? pixel : -1)).filter((pixel) => pixel >= 0);
        bands[ring] = {
          umbra: umbra.length,
          umbraShare: Math.max(0, ...umbra.map((pixel) => lightShare(drawn, open, unlit, pixel))),
          umbraLit: umbra.filter((pixel) => lightShare(drawn, open, unlit, pixel) > 1 / 3).length,
          open: far.length,
          openShadowed: far.filter((pixel) => difference(drawn, open, pixel) > 2).length,
        };
      }
      bandsOf[light] = bands;
      report[light] = { atlas: capture(result, light).atlas, shadowed: shadowed.length, bands };
    }
    const celPcss = capture(result, "cel spot").pixels, celPcf = capture(result, "cel spot pcf").pixels;
    report.cel = { differing: Array.from({ length: count }, (_, pixel) => difference(celPcss, celPcf, pixel)).filter((value) => value > 0).length };
    await testInfo.attach(`haptic-contact-shadows-${backend}`, { body: JSON.stringify(report, null, 2), contentType: "application/json" });
    console.log(JSON.stringify(report));
    expect(errors).toEqual([]);
    // Each light's map draws into the atlas.
    expect(["spot", "sun", "point"].map((light) => capture(result, light).atlas)).toEqual([true, true, true]);
    // A few pixels from each shadow's outline the open floor is as lit as without the shadow, and the shadowed floor
    // keeps under a share of the light: Babylon's PCSS lightens a shadow with its blockers' distance (measured: sun 0.41
    // and 0.40 three pixels in; spot 0.24 on WebGL2 and 0.20 on WebGPU, point 0.29 and 0.19, two pixels in). The sun's
    // cascades compare against the receiver's plane, so the floor does not shadow itself as under Babylon's PCSS. The
    // spot's mask covers its cone, which holds the box's shadow: the ball's lies past the cone's outer angle, where
    // the spot lights nothing and its shadow is not defined.
    const expectations: [string, number, number, number][] = [["sun", 3, 150, 0.5], ["spot", 2, 150, 1 / 3], ["point", 2, 400, 1 / 3]];
    for (const [light, ring, umbra, share] of expectations) {
      const band = bandsOf[light]![ring]!;
      expect(band.umbra, light).toBeGreaterThan(umbra);
      expect(band.openShadowed, light).toBe(0);
      expect(band.umbraShare, light).toBeLessThan(share);
    }
    // CEL draws Contact Hardening as PCF.
    expect(report.cel).toEqual({ differing: 0 });
    // A pebble too small for the sun's second cascade is left out of it and kept in the first; every pixel whose floor
    // lies within the first cascade is as it is with every caster drawn.
    const far = result.farCasters;
    const differing = Array.from({ length: count }, (_, pixel) => pixel).filter((pixel) => difference(far.kept, far.all, pixel) > 0);
    report.farCasters = { threshold: far.threshold, listedKept: far.listedKept, listedAll: far.listedAll, differing: differing.length };
    console.log(JSON.stringify(report.farCasters));
    expect(far.threshold).toBeGreaterThan(0);
    expect([far.listedKept[1], far.listedAll[1]]).toEqual([false, true]);
    expect(differing.filter((pixel) => far.depths[pixel]! >= 0 && far.depths[pixel]! < far.firstCascadeEnd)).toEqual([]);
    // A local map stays cached while only the floating render origin moves, and draws what a fresh draw at that pose would.
    for (const light of ["spot", "point"]) {
      const kept = capture(result, `${light} origin moved`), redrawn = capture(result, `${light} origin moved redrawn`);
      expect([kept.originMoved, kept.passes, redrawn.passes], light).toEqual([true, 0, light === "point" ? 6 : 1]);
      const differing = Array.from({ length: count }, (_, pixel) => difference(kept.pixels, redrawn.pixels, pixel)).filter((value) => value > 0);
      expect(differing, light).toEqual([]);
    }
  });
}
