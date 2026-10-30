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

    // The expectations below are linear colours shown through the display encoding alone (no exposure, contrast or
    // tone mapping): Babylon's 2.2 power, or the exact sRGB curve on an Engine with exact conversions (the app's
    // WebGPU Engine). The block decodes the cubes' bytes with the same curve.
    expect(result.display).toMatchObject({ toneMapping: false, exposure: 1, contrast: 1 });
    const exact = result.display.exactSrgb;
    const toDisplay = (linear: number) => {
      const value = Math.min(Math.max(linear, 0), 1);
      return 255 * (!exact ? value ** (1 / 2.2) : value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055);
    };
    const toLinear = (display: number) => {
      const value = display / 255;
      return !exact ? value ** 2.2 : value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    };
    const channels = (pixels: number[], pixel: number) => [0, 1, 2].map((channel) => pixels[pixel * 4 + channel]!);
    const flat = settled(surfaceIds, width, height, (id) => id < 10);
    const everySurface = settled(surfaceIds, width, height, () => true);
    expect(flat.length).toBeGreaterThan(3000);
    const report: Record<string, unknown> = {};

    // Direct light: per floor and box pixel, the block's BRDF evaluated here for a non-metal with F0 = 0 under every
    // enabled punctual light and the fill, without environment. Each channel rounds to 8 bits once; float evaluation
    // order moves a value by less (measured: at most 0.56/255 on WebGL2).
    for (const { name, pixels, expected } of result.analytic) {
      const apart = flat.map((pixel) => Math.max(...channels(pixels, pixel).map((value, channel) => Math.abs(value - toDisplay(expected[pixel]![channel]!)))));
      report[`direct ${name}`] = { largest: Math.max(...apart), lit: lit(pixels) };
      expect(lit(pixels), name).toBeGreaterThan(3000);
      expect(apart.filter((value) => value > 1.5), name).toEqual([]);
    }

    // Environment: a mirror (a white metal, F0 = 1, at the smallest roughness) in a cube of six flat faces shows, at each
    // floor and box pixel, the face its reflected direction meets: plain, with the cube rotated, box-projected onto a
    // probe's volume, and both. Where that direction lies near a face's edge the prefiltered cube blends the faces, so
    // only directions whose largest component is 1.25 times the next count; the faces' colours differ by at least
    // 100/255 in some channel, and the rest is the prefilter's softening (measured: up to 11/255). The app's WebGPU
    // Engine draws relative to a floating origin, which the probe's box must follow as the surface positions do.
    for (const { name, pixels, expected } of result.mirrors) {
      const checked = flat.filter((pixel) => expected[pixel]!.margin >= 1.25);
      const apart = checked.map((pixel) => Math.max(...channels(pixels, pixel).map((value, channel) =>
        Math.abs(value - result.faceColors[expected[pixel]!.face]![channel]!))));
      report[`mirror ${name}`] = { pixels: checked.length, largest: Math.max(...apart), faces: new Set(checked.map((pixel) => expected[pixel]!.face)).size };
      expect(checked.length, name).toBeGreaterThan(2000);
      expect(new Set(checked.map((pixel) => expected[pixel]!.face)).size, name).toBeGreaterThanOrEqual(3);
      expect(apart.filter((value) => value > 12), name).toEqual([]);
    }

    // The furnace: in a cube of one grey a rough white metal shows exactly that grey wherever it faces the view (the
    // multi-scatter term restores the energy the single-scatter table loses), and a non-metal adds its diffuse colour
    // times the cube's radiance (the irradiance harmonics, pre-scaled) over a black one that reflects alike.
    const metal = result.furnace["white metal"]!;
    const metalApart = everySurface.map((pixel) => Math.max(...channels(metal, pixel).map((value) => Math.abs(value - result.uniformGrey))));
    const radiance = toLinear(result.uniformGrey);
    const diffuseColor = toLinear(0.8 * 255);
    const irradiance = everySurface.map((pixel) => [0, 1, 2].reduce((sum, channel) =>
      sum + toLinear(result.furnace.matte![pixel * 4 + channel]!) - toLinear(result.furnace.black![pixel * 4 + channel]!), 0) / 3 / (diffuseColor * radiance));
    report.furnace = { metalLargest: Math.max(...metalApart), irradiance: [Math.min(...irradiance), Math.max(...irradiance)] };
    expect(everySurface.length).toBeGreaterThan(3000);
    expect(metalApart.filter((value) => value > 1)).toEqual([]);
    // 8-bit rounding of two captures, divided by a difference of about 0.2 (measured: 0.988 to 1.026).
    expect(irradiance.filter((ratio) => Math.abs(ratio - 1) > 0.05)).toEqual([]);

    // The rect light alone. A non-metal over a black one: its diffuse colour times the rect's form factor (the LTC with
    // the identity transform), where the form factor is large enough for 8-bit differences to resolve.
    const rect = result.rect;
    const lighted = flat.filter((pixel) => rect.formFactors[pixel]! > 0.05);
    const formRatio = lighted.map((pixel) => [0, 1, 2].reduce((sum, channel) =>
      sum + toLinear(rect.captures.matte![pixel * 4 + channel]!) - toLinear(rect.captures.black![pixel * 4 + channel]!), 0) / 3 /
      (diffuseColor * rect.formFactors[pixel]!));
    // A mirror shows the panel's radiance where its reflected ray meets the panel, and nothing elsewhere (no
    // environment, no other light): pixels a twentieth of the panel inside or outside its edge.
    const inside = flat.filter((pixel) => (rect.mirror[pixel]?.inside ?? -1) > 0.05);
    const outside = flat.filter((pixel) => (rect.mirror[pixel]?.inside ?? -1) < -0.05);
    const shown = toDisplay(rect.mirrorIntensity);
    report.rect = {
      lighted: lighted.length, formRatio: [Math.min(...formRatio), Math.max(...formRatio)], inside: inside.length,
      insideValues: [...new Set(inside.map((pixel) => channels(rect.captures.mirror!, pixel).join()))], outside: outside.length,
      outsideLargest: Math.max(...outside.map((pixel) => Math.max(...channels(rect.captures.mirror!, pixel)))), shown,
    };
    expect(lighted.length).toBeGreaterThan(1000);
    expect(formRatio.filter((ratio) => Math.abs(ratio - 1) > 0.05)).toEqual([]);
    expect(inside.length).toBeGreaterThan(200);
    expect(inside.filter((pixel) => Math.max(...channels(rect.captures.mirror!, pixel).map((value) => Math.abs(value - shown))) > 2)).toEqual([]);
    expect(outside.length).toBeGreaterThan(1000);
    expect(outside.filter((pixel) => Math.max(...channels(rect.captures.mirror!, pixel)) > 6)).toEqual([]);
    // A white emission draws as the flat light; a gradient colours the mirror's image of the panel.
    expect(outliers(rect.captures.matte!, rect.captures["matte, white emission"]!), "white emission on matte").toBe(0);
    expect(outliers(rect.captures.mirror!, rect.captures["mirror, white emission"]!), "white emission on mirror").toBe(0);
    expect(outliers(rect.captures.mirror!, rect.captures["mirror, gradient emission"]!), "gradient emission").toBeGreaterThan(300);
    await testInfo.attach(`haptic-light-report-${backend}`, { body: JSON.stringify(report), contentType: "application/json" });

    // The regular surfaces under the sky cube: each pose changes the image, so a block that ignored a light, the cube's
    // rotation or its box, or the rect light would show here too.
    const captures = new Map(result.captures.map((capture) => [capture.name, capture.pixels]));
    for (const pose of ["two off", "environment only", "rotated environment", "box-projected environment"])
      expect(outliers(captures.get(pose)!, captures.get("all lights")!), pose).toBeGreaterThan(300);
    for (const pose of ["rotated environment", "box-projected environment", "rect light"])
      expect(outliers(captures.get(pose)!, captures.get("environment only")!), pose).toBeGreaterThan(300);
    // Two programs per regular Material (the plain and the box-projected cube) and one for each of the white metal, the
    // matte, the black and the mirror Materials, which draw no box; none carries Babylon's light defines. WebGPU
    // releases a program once no draw holds it, so there only those of the Materials drawn since remain.
    expect(result.hapticEffects).toBe(backend === "webgl2" ? 11 : 9);
    expect(result.lightDefines).toBe(0);
    expect(result.steps).toEqual(LIGHT_STEPS);

    // CEL, the block's HAPTIC_CEL define: hard steps, so a flat floor under the sun and the fill takes one band and the
    // highlight (two colours), and one without highlights, under the fill alone or under the environment alone takes
    // one; every pose lights the scene, and each setting changes the image.
    const cel = new Map(result.celCaptures.map((capture) => [capture.name, capture.pixels]));
    const floor = settled(surfaceIds, width, height, (id) => id === 0);
    const colours = (pose: string) => new Set(floor.map((pixel) => channels(cel.get(pose)!, pixel).join())).size;
    for (const [pose, pixels] of cel) expect(lit(pixels), `cel ${pose}`).toBeGreaterThan(3000);
    for (const pose of ["sun and fill", "sun only"]) expect(colours(pose), pose).toBe(2);
    for (const pose of ["no highlights", "fill only", "environment only"]) expect(colours(pose), pose).toBe(1);
    for (const pose of ["fill only", "environment only", "additive", "blend", "wide highlights", "no highlights", "rect light", "all lights"])
      expect(cel.get(pose), pose).not.toEqual(cel.get("sun and fill"));
    expect(cel.get("rotated environment")).not.toEqual(cel.get("environment only"));
    // One CEL program per Material: CEL ignores the cube's format and box.
    expect(result.celEffects).toBe(3);
    expect(result.celSteps).toEqual(LIGHT_STEPS);

    // A spot light's, the sun's and a point light's shadows, drawn through the shadow controller and the frame graph
    // into the atlas: a floor pixel whose view of the light the box or the ball blocks draws as with the light off, any
    // other as with the light's shadow switched off, in both render modes, and the shadow compiles nothing.
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
