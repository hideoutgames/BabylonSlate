import { expect, test } from "@playwright/test";
import type { runHapticScreenShadowsProof } from "../apps/editor/src/testing/haptic-screen-shadows-proof";
import { SOFTWARE_WEBGPU_ARGS } from "./software-webgpu";

test.use({ launchOptions: { args: SOFTWARE_WEBGPU_ARGS } });

type Proof = typeof runHapticScreenShadowsProof;
type Result = Awaited<ReturnType<Proof>>;

function capture(result: Result, name: string) {
  const found = result.captures.find((entry) => entry.name === name);
  if (!found) throw new Error(`No ${name} capture`);
  return found;
}

/** The largest channel difference between two captures at a pixel. */
function difference(a: number[], b: number[], pixel: number) {
  let largest = 0;
  for (let channel = 0; channel < 3; channel++) largest = Math.max(largest, Math.abs(a[pixel * 4 + channel]! - b[pixel * 4 + channel]!));
  return largest;
}

/** The share of the unshadowed sun's light a pixel keeps (its brightest lit channel's), or -1 where the sun lights little. */
function share(drawn: number[], open: number[], pixel: number) {
  let value = -1;
  for (let channel = 0; channel < 3; channel++) {
    const full = open[pixel * 4 + channel]!;
    if (full > 24) value = Math.max(value, drawn[pixel * 4 + channel]! / full);
  }
  return value;
}

for (const backend of ["webgl2", "webgpu"] as const) {
  test(`Screen-Space Shadows darken the sun's contact shadows the map misses and nothing else, on ${backend}`, async ({ page }, testInfo) => {
    test.setTimeout(240_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (["error", "warning"].includes(message.type()) &&
        /shader|WGSL|WebGPU uncaptured|VALIDATE_STATUS|GL_INVALID|ERROR: 0:|context lost|fatal error/i.test(message.text())) errors.push(message.text());
    });
    await page.goto("/?test=1&hapticScreenShadowsProof=1");
    await page.waitForFunction(() => typeof (window as unknown as { __hapticScreenShadowsProof?: unknown }).__hapticScreenShadowsProof === "function");
    const result = await page.evaluate((backend) =>
      (window as unknown as { __hapticScreenShadowsProof: Proof }).__hapticScreenShadowsProof(backend), backend);
    const { mask, fade } = result;
    const count = result.width * result.height;
    const pixels = Array.from({ length: count }, (_, pixel) => pixel);
    const off = capture(result, "off").pixels, high = capture(result, "high again").pixels;
    const unshadowed = capture(result, "high, sun unshadowed").pixels;
    const lit = (pixel: number) => mask.surface[pixel] === "floor" || mask.surface[pixel] === "ramp";
    const near = (pixel: number) => mask.distance[pixel]! < fade.start;
    // Contact pixels the coarse map leaves (mostly) lit.
    const missed = pixels.filter((pixel) => lit(pixel) && near(pixel) && mask.contact[pixel] && share(off, unshadowed, pixel) > 0.6);
    const darkened = missed.filter((pixel) => share(high, unshadowed, pixel) < share(off, unshadowed, pixel) - 0.15);
    const changed = (set: number[]) => set.filter((pixel) => difference(off, high, pixel) > 2);
    const open = pixels.filter((pixel) => lit(pixel) && near(pixel) && mask.open[pixel]);
    const ramp = open.filter((pixel) => mask.surface[pixel] === "ramp");
    const beyond = pixels.filter((pixel) => mask.surface[pixel] === "floor" && mask.distance[pixel]! > fade.end);
    // Floor seen through the glass, away from any contact shadow: the blended glass reads no screen shadows.
    const glass = pixels.filter((pixel) => mask.surface[pixel] === "glass" && !mask.contact[pixel]);
    const cel = pixels.filter((pixel) => difference(capture(result, "cel off").pixels, capture(result, "cel high").pixels, pixel) > 0);
    const report = {
      reads: result.captures.map((entry) => [entry.name, entry.screenShadows]),
      contact: pixels.filter((pixel) => lit(pixel) && near(pixel) && mask.contact[pixel]).length,
      missed: missed.length, darkened: darkened.length,
      open: open.length, openChanged: changed(open).length, ramp: ramp.length, rampChanged: changed(ramp).length,
      beyond: beyond.length, beyondChanged: changed(beyond).length, glass: glass.length, glassChanged: changed(glass).length,
      celChanged: cel.length, lightCompiles: result.lightCompiles, planned: result.planned,
    };
    if (process.env.SCREEN_DUMP) {
      const fs = await import("node:fs");
      fs.writeFileSync(`${process.env.SCREEN_DUMP}/screen-${backend}.json`, JSON.stringify({ width: result.width, height: result.height, off, high, mask, openChanged: changed(open) }));
    }
    await testInfo.attach(`haptic-screen-shadows-${backend}`, { body: JSON.stringify(report, null, 2), contentType: "application/json" });
    console.log(JSON.stringify(report));
    expect(errors).toEqual([]);
    expect(report.reads).toEqual([["off", false], ["high", true], ["high, sun unshadowed", true], ["high again", true], ["cel off", false], ["cel high", false]]);
    // Most contact pixels the map misses darken.
    expect(report.missed).toBeGreaterThan(20);
    expect(report.darkened / report.missed).toBeGreaterThan(0.5);
    // Open floor and the ramp facing the sun, floor beyond the fade, floor behind the glass and CEL are unchanged.
    expect(report.open).toBeGreaterThan(1000);
    expect(report.openChanged / report.open).toBeLessThan(0.01);
    expect(report.ramp).toBeGreaterThan(50);
    expect(report.rampChanged).toBe(0);
    expect(report.beyond).toBeGreaterThan(30);
    expect(report.beyondChanged).toBe(0);
    expect(report.glass).toBeGreaterThan(30);
    expect(report.glassChanged).toBe(0);
    expect(report.celChanged).toBe(0);
    // Light steps compile nothing.
    expect(report.lightCompiles).toEqual([]);
  });
}
