import { expect, test } from "@playwright/test";
import type { runHapticLightProof } from "../apps/editor/src/testing/haptic-light-proof";
import { SOFTWARE_WEBGPU_ARGS } from "./software-webgpu";

test.use({ launchOptions: { args: SOFTWARE_WEBGPU_ARGS } });

const LIGHT_STEPS = [
  { step: "a point switched off", newLitEffects: 0 },
  { step: "a spot switched off", newLitEffects: 0 },
  { step: "the fill switched off", newLitEffects: 0 },
  { step: "all back on", newLitEffects: 0 },
  { step: "a new point", newLitEffects: 0 },
  { step: "a point removed", newLitEffects: 0 },
];

/** The largest channel difference between two captures at a pixel. */
function difference(a: number[], b: number[], pixel: number) {
  let largest = 0;
  for (let channel = 0; channel < 3; channel++) largest = Math.max(largest, Math.abs(a[pixel * 4 + channel]! - b[pixel * 4 + channel]!));
  return largest;
}

/** Pixels whose largest channel differs between two captures by more than 2/255. */
function outliers(a: number[], b: number[]) {
  let count = 0;
  for (let pixel = 0; pixel < a.length / 4; pixel++) if (difference(a, b, pixel) > 2) count++;
  return count;
}

/** Pixels with a channel above 25/255. */
function lit(pixels: number[]) {
  let count = 0;
  for (let index = 0; index < pixels.length; index += 4) if (Math.max(pixels[index]!, pixels[index + 1]!, pixels[index + 2]!) > 25) count++;
  return count;
}

/**
 * The pixels whose 3×3 neighbourhood shows one surface (`ids`: per pixel, -1 for none) that `keep` accepts: at an
 * outline a pixel blends two surfaces, and its centre does not stand for its whole area.
 */
function settled(ids: number[], width: number, height: number, keep: (id: number) => boolean) {
  const pixels: number[] = [];
  for (let row = 1; row < height - 1; row++) {
    for (let column = 1; column < width - 1; column++) {
      const pixel = row * width + column;
      const id = ids[pixel]!;
      if (id < 0 || !keep(id)) continue;
      let uniform = true;
      for (let dy = -1; dy <= 1 && uniform; dy++) for (let dx = -1; dx <= 1; dx++) if (ids[pixel + dy * width + dx] !== id) uniform = false;
      if (uniform) pixels.push(pixel);
    }
  }
  return pixels;
}

/** The floor pixels whose view of a light is blocked (1) or open (0), each with its neighbours of the same kind. */
function settledShadowPixels(blocked: number[], width: number, height: number) {
  return {
    blocked: settled(blocked, width, height, (kind) => kind === 1),
    open: settled(blocked, width, height, (kind) => kind === 0),
  };
}

for (const backend of ["webgl2", "webgpu"] as const) {
  test(`HapticLightingBlock shades graph Materials as its model predicts on ${backend}, and light changes compile nothing`, async ({ page }, testInfo) => {
    test.setTimeout(240_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (["error", "warning"].includes(message.type()) &&
        /shader|WGSL|WebGPU uncaptured|VALIDATE_STATUS|GL_INVALID|ERROR: 0:|context lost|fatal error/i.test(message.text())) errors.push(message.text());
    });
    await page.goto("/?test=1&hapticLightProof=1");
    await page.waitForFunction(() => typeof (window as unknown as { __hapticLightProof?: unknown }).__hapticLightProof === "function");
    const result = await page.evaluate((backend) =>
      (window as unknown as { __hapticLightProof: typeof runHapticLightProof }).__hapticLightProof(backend), backend);
    await testInfo.attach(`haptic-light-proof-${backend}`, { body: JSON.stringify(result), contentType: "application/json" });
    expect(errors).toEqual([]);
    const { width, height, surfaceIds } = result;

    // The expectations below are linear colours shown through the sRGB encoding alone: no exposure, contrast or tone
    // mapping. The block decodes the cubes' bytes with the same power.
    expect(result.display).toMatchObject({ toneMapping: false, exposure: 1, contrast: 1 });
    const gamma = 2.2;
    const toDisplay = (linear: number) => 255 * Math.min(Math.max(linear, 0), 1) ** (1 / gamma);
    const toLinear = (display: number) => (display / 255) ** gamma;
    const flat = settled(surfaceIds, width, height, (id) => id < 10);
    const everySurface = settled(surfaceIds, width, height, () => true);
    const report: Record<string, unknown> = {};

    // Direct light, per floor and box pixel, as the block's BRDF evaluates it.
    for (const { name, pixels, expected } of result.analytic) {
      let largest = 0;
      let over = 0;
      for (const pixel of flat) {
        const rgb = expected[pixel]!;
        let apart = 0;
        for (let channel = 0; channel < 3; channel++) apart = Math.max(apart, Math.abs(pixels[pixel * 4 + channel]! - toDisplay(rgb[channel]!)));
        largest = Math.max(largest, apart);
        if (apart > 2) over++;
      }
      report[`analytic ${name}`] = { pixels: flat.length, largest, over, lit: lit(pixels) };
    }

    // Mirrors in a cube of six flat faces.
    for (const { name, pixels, expected } of result.mirrors) {
      let count = 0;
      let largest = 0;
      for (const pixel of flat) {
        const hit = expected[pixel]!;
        if (hit.margin < 1.25) continue;
        count++;
        largest = Math.max(largest, Math.max(...[0, 1, 2].map((channel) => Math.abs(pixels[pixel * 4 + channel]! - result.faceColors[hit.face]![channel]!))));
      }
      report[`mirror ${name}`] = { count, largest, faces: new Set(flat.map((pixel) => expected[pixel]!.face)).size };
    }

    // The furnace.
    {
      const metal = result.furnace["white metal"]!;
      const grey = result.uniformGrey;
      const metalApart = everySurface.map((pixel) => Math.max(...[0, 1, 2].map((channel) => Math.abs(metal[pixel * 4 + channel]! - grey))));
      const c = toLinear(grey);
      const ratios = everySurface.map((pixel) => {
        let sum = 0;
        for (let channel = 0; channel < 3; channel++)
          sum += toLinear(result.furnace.matte![pixel * 4 + channel]!) - toLinear(result.furnace.black![pixel * 4 + channel]!);
        return sum / 3 / (0.8 * c);
      }).sort((a, b) => a - b);
      report.furnace = {
        pixels: everySurface.length, metalLargest: Math.max(...metalApart), metalOver: metalApart.filter((value) => value > 2).length,
        ratioMin: ratios[0], ratioMax: ratios[ratios.length - 1], ratioMedian: ratios[ratios.length >> 1],
      };
    }

    // The rect light.
    {
      const rectCaptures = result.rect.captures;
      const ratios: number[] = [];
      for (const pixel of flat) {
        const form = result.rect.formFactors[pixel]!;
        if (form < 0.05) continue;
        let sum = 0;
        for (let channel = 0; channel < 3; channel++) sum += toLinear(rectCaptures.matte![pixel * 4 + channel]!) - toLinear(rectCaptures.black![pixel * 4 + channel]!);
        ratios.push(sum / 3 / (0.8 * form));
      }
      ratios.sort((a, b) => a - b);
      const inside: number[] = [];
      const outside: number[] = [];
      const gradientSamples: unknown[] = [];
      for (const pixel of flat) {
        const hit = result.rect.mirror[pixel];
        const value = Math.max(...[0, 1, 2].map((channel) => rectCaptures.mirror![pixel * 4 + channel]!));
        if (hit && hit.inside > 0.05) {
          inside.push(value);
          if (gradientSamples.length < 400 && pixel % 7 === 0)
            gradientSamples.push({ u: hit.u, v: hit.v, rgb: rectCaptures["mirror, gradient emission"]!.slice(pixel * 4, pixel * 4 + 3) });
        } else if (!hit || hit.inside < -0.05) outside.push(value);
      }
      report.rect = {
        diffusePixels: ratios.length, ratioMin: ratios[0], ratioMax: ratios[ratios.length - 1],
        mirrorInside: inside.length, insideMin: Math.min(...inside), insideMax: Math.max(...inside), expectedInside: toDisplay(result.rect.mirrorIntensity),
        mirrorOutside: outside.length, outsideMax: Math.max(...outside),
        whiteMatte: outliers(rectCaptures.matte!, rectCaptures["matte, white emission"]!),
        whiteMirror: outliers(rectCaptures.mirror!, rectCaptures["mirror, white emission"]!),
        gradientApart: outliers(rectCaptures.mirror!, rectCaptures["mirror, gradient emission"]!),
        gradientSamples,
      };
    }
    const captures = new Map(result.captures.map((capture) => [capture.name, capture.pixels]));
    const cel = new Map(result.celCaptures.map((capture) => [capture.name, capture.pixels]));
    const floorPixels = settled(surfaceIds, width, height, (id) => id === 0);
    report.effects = { pbr: result.hapticEffects, cel: result.celEffects };
    report.cel = [...cel].map(([name, pixels]) => [name, lit(pixels), new Set(floorPixels.map((pixel) => pixels.slice(pixel * 4, pixel * 4 + 3).join())).size]);
    report.poses = [...captures].map(([name, pixels]) => [name, outliers(pixels, captures.get("all lights")!), outliers(pixels, captures.get("environment only")!)]);
    await testInfo.attach(`haptic-light-report-${backend}`, { body: JSON.stringify(report), contentType: "application/json" });

    expect(result.lightDefines).toBe(0);
    expect(result.steps).toEqual(LIGHT_STEPS);
    expect(result.celSteps).toEqual(LIGHT_STEPS);

    for (const [light, { blocked, modes }] of Object.entries(result.shadow)) {
      const settledPixels = settledShadowPixels(blocked, width, height);
      const shadowReport = modes.map(({ mode, atlas, shadowed, unshadowed, unlit, newLitEffects }) => ({
        light, mode, atlas, newLitEffects, blocked: settledPixels.blocked.length, open: settledPixels.open.length,
        lighting: settledPixels.blocked.reduce((sum, pixel) => sum + difference(unshadowed, unlit, pixel), 0) / settledPixels.blocked.length,
        blockedLit: settledPixels.blocked.filter((pixel) => difference(shadowed, unlit, pixel) > 2).length,
        openShadowed: settledPixels.open.filter((pixel) => difference(shadowed, unshadowed, pixel) > 2).length,
      }));
      await testInfo.attach(`haptic-light-${light}-shadow-${backend}`, { body: JSON.stringify(shadowReport), contentType: "application/json" });
      for (const entry of shadowReport) {
        const label = `${light} ${entry.mode}`;
        expect(entry.atlas, label).toBe(true);
        expect(entry.newLitEffects, label).toBe(0);
        expect(entry.blocked, label).toBeGreaterThan(100);
        expect(entry.open, label).toBeGreaterThan(1000);
        expect(entry.lighting, label).toBeGreaterThan(20);
        expect(entry.blockedLit, label).toBe(0);
        expect(entry.openShadowed, label).toBe(0);
      }
    }
  });
}
