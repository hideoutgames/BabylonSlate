import { expect, test } from "@playwright/test";
import type { runHapticShadowJitterProof } from "../apps/editor/src/testing/haptic-shadow-jitter-proof";
import { SOFTWARE_WEBGPU_ARGS } from "./software-webgpu";

test.use({ launchOptions: { args: SOFTWARE_WEBGPU_ARGS } });

type Proof = typeof runHapticShadowJitterProof;
type Result = Awaited<ReturnType<Proof>>;

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

/** The share of the unshadowed light a pixel keeps (its largest lit channel's ratio), or -1 where nothing is lit. */
function shares(drawn: number[], open: number[], count: number): number[] {
  return Array.from({ length: count }, (_, pixel) => {
    let share = -1;
    for (let channel = 0; channel < 3; channel++) {
      const full = open[pixel * 4 + channel]!;
      if (full > 24) share = Math.max(share, drawn[pixel * 4 + channel]! / full);
    }
    return share;
  });
}

for (const backend of ["webgl2", "webgpu"] as const) {
  test(`the light block's shadow filters jitter only under temporal anti-aliasing, smoothing a coarse map's staircase, on ${backend}`, async ({ page }, testInfo) => {
    test.setTimeout(240_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (["error", "warning"].includes(message.type()) &&
        /shader|WGSL|WebGPU uncaptured|VALIDATE_STATUS|GL_INVALID|ERROR: 0:|context lost|fatal error/i.test(message.text())) errors.push(message.text());
    });
    await page.goto("/?test=1&hapticShadowJitterProof=1");
    await page.waitForFunction(() => typeof (window as unknown as { __hapticShadowJitterProof?: unknown }).__hapticShadowJitterProof === "function");
    // Real temporal anti-aliasing runs once, on WebGL2.
    const result = await page.evaluate(([backend, temporal]) =>
      (window as unknown as { __hapticShadowJitterProof: Proof }).__hapticShadowJitterProof(backend, temporal), [backend, backend === "webgl2"] as const);
    const { width, height, blocked } = result;
    const count = width * height;
    const open = capture(result, "unshadowed").pixels;
    const toBlocked = chebyshevDistance(blocked.map((kind) => kind === 1), width, height);
    const toOpen = chebyshevDistance(blocked.map((kind) => kind === 0), width, height);
    const edge = blocked.map((kind, pixel) => (kind === 1 ? toOpen[pixel]! : kind === 0 ? toBlocked[pixel]! : -1));
    const fixed = shares(capture(result, "fixed").pixels, open, count);
    const phases = Array.from({ length: 16 }, (_, index) => shares(capture(result, `phase ${index + 1}`).pixels, open, count));
    const averaged = fixed.map((value, pixel) => (value < 0 ? -1 : phases.reduce((sum, phase) => sum + phase[pixel]!, 0) / phases.length));
    // The staircase: how far a pixel's share lies from its 3x3 neighbourhood's mean, over the floor near the shadow's
    // outline (a straight soft edge is close to linear there; a texel staircase is not).
    const band = Array.from({ length: count }, (_, pixel) => pixel).filter((pixel) => {
      const row = Math.floor(pixel / width), column = pixel % width;
      if (row < 1 || column < 1 || row >= height - 1 || column >= width - 1 || edge[pixel]! < 1 || edge[pixel]! > 3) return false;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (fixed[pixel + dy * width + dx]! < 0 || blocked[pixel + dy * width + dx]! < 0) return false;
      return true;
    });
    const staircase = (image: number[]) => band.reduce((sum, pixel) => {
      let mean = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) mean += image[pixel + dy * width + dx]!;
      return sum + Math.abs(image[pixel]! - mean / 9);
    }, 0) / band.length;
    // Away from the outline the jitter changes nothing: the umbra stays dark and the open floor lit.
    const far = (kind: number) => Array.from({ length: count }, (_, pixel) => pixel).filter((pixel) => blocked[pixel] === kind && edge[pixel]! >= 4 && fixed[pixel]! >= 0);
    const umbra = far(1), lit = far(0);
    const differ = (a: number[], b: number[]) => a.filter((value, index) => value !== b[index]).length;
    const report = {
      band: band.length, umbra: umbra.length, lit: lit.length,
      staircase: { fixed: staircase(fixed), averaged: staircase(averaged) },
      jittered: result.captures.map((entry) => [entry.name, entry.jittered]),
      amplitudeZeroDiffers: differ(capture(result, "amplitude 0").pixels, capture(result, "fixed").pixels),
      fixedAgainDiffers: differ(capture(result, "fixed again").pixels, capture(result, "fixed").pixels),
      averagedUmbraMax: Math.max(...umbra.map((pixel) => averaged[pixel]!)),
      averagedLitMin: Math.min(...lit.map((pixel) => averaged[pixel]!)),
      temporal: backend === "webgl2" ? (() => {
        const drawn = shares(capture(result, "temporal").pixels, open, count);
        return { umbraMax: Math.max(...umbra.map((pixel) => drawn[pixel]!)), litMin: Math.min(...lit.map((pixel) => drawn[pixel]!)) };
      })() : null,
    };
    await testInfo.attach(`haptic-shadow-jitter-${backend}`, { body: JSON.stringify(report, null, 2), contentType: "application/json" });
    console.log(JSON.stringify(report));
    expect(errors).toEqual([]);
    expect(report.jittered).toEqual([
      ["fixed", false], ["amplitude 0", true], ...Array.from({ length: 16 }, (_, index) => [`phase ${index + 1}`, true]),
      ["fixed again", false], ["unshadowed", false], ...(backend === "webgl2" ? [["temporal", true], ["temporal off", false]] : []),
    ]);
    // At amplitude 0 the jittered program draws the fixed pattern exactly, and dropping the define restores it.
    expect([report.amplitudeZeroDiffers, report.fixedAgainDiffers]).toEqual([0, 0]);
    // Sixteen jittered frames average to a smoother outline than the fixed pattern's staircase.
    expect(report.band).toBeGreaterThan(100);
    expect(report.staircase.averaged).toBeLessThanOrEqual(0.6 * report.staircase.fixed);
    expect([report.umbra, report.lit].every((size) => size > 100)).toBe(true);
    expect(report.averagedUmbraMax).toBeLessThan(0.5);
    expect(report.averagedLitMin).toBeGreaterThan(0.95);
    // Temporal anti-aliasing resolves the jitter into the same shadow.
    if (report.temporal) {
      expect(report.temporal.umbraMax).toBeLessThan(0.5);
      expect(report.temporal.litMin).toBeGreaterThan(0.9);
    }
  });
}
