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

/**
 * The floor pixels whose view of the shadow poses' lamp is blocked (1) or open (0), leaving out each pixel with a
 * neighbour of another kind or off the floor: at an outline the filter blends, and a pixel's centre does not stand for
 * its whole area.
 */
function settledShadowPixels(blocked: number[], width: number, height: number) {
  const settled = { blocked: [] as number[], open: [] as number[] };
  for (let row = 1; row < height - 1; row++) {
    for (let column = 1; column < width - 1; column++) {
      const pixel = row * width + column;
      const kind = blocked[pixel]!;
      if (kind < 0) continue;
      let uniform = true;
      for (let dy = -1; dy <= 1 && uniform; dy++) for (let dx = -1; dx <= 1; dx++) if (blocked[pixel + dy * width + dx] !== kind) uniform = false;
      if (uniform) (kind ? settled.blocked : settled.open).push(pixel);
    }
  }
  return settled;
}

/** Pixels (of 9600) differing by more than 2/255, the largest difference, and the reference's lit pixels. */
function compare(reference: number[], pixels: number[]) {
  let outliers = 0;
  let largest = 0;
  let lit = 0;
  for (let index = 0; index < reference.length; index += 4) {
    let difference = 0;
    for (let channel = 0; channel < 3; channel++) difference = Math.max(difference, Math.abs(pixels[index + channel]! - reference[index + channel]!));
    if (difference > 2) outliers++;
    largest = Math.max(largest, difference);
    if (Math.max(...reference.slice(index, index + 3)) > 25) lit++;
  }
  return { outliers, largest, lit };
}

for (const backend of ["webgl2", "webgpu"] as const) {
  test(`HapticLightingBlock shades graph Materials like Babylon's PBR and CEL blocks on ${backend}, and light changes compile nothing`, async ({ page }, testInfo) => {
    test.setTimeout(180_000);
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

    // PBR. The same BRDF and environment evaluated in another order: float rounding only. The lights' range is far
    // beyond the scene, so HapticLightingBlock's range window (which Babylon's physical falloff lacks) stays at one.
    // The software WebGPU adapter rounds a few silhouette pixels of the ball, at grazing angles, further (measured:
    // up to 3 pixels, by up to 9/255 on the white metal).
    const tolerance = backend === "webgl2" ? { outliers: 0, largest: 2 } : { outliers: 10, largest: 16 };
    const paths = (captures: typeof result.captures, path: string) =>
      new Map(captures.filter((capture) => capture.path === path).map((capture) => [capture.name, capture.pixels]));
    const babylon = paths(result.captures, "babylon");
    const haptic = paths(result.captures, "haptic");
    // Babylon's WGSL reflection block cannot compile a box-projected cube, so WebGPU has no reference for that pose.
    const boxReference = backend === "webgl2" ? ["box-projected environment"] : [];
    expect([...babylon.keys()]).toEqual([
      "all lights", "two off", "sun only", "environment only", "rotated environment", ...boxReference, "rect light on metal",
      "emissive rect light on metal",
    ]);
    expect([...haptic.keys()]).toEqual([
      "all lights", "two off", "sun only", "environment only", "rotated environment", "box-projected environment", "rect light on metal",
      "emissive rect light on metal", "rect light",
    ]);
    for (const [name, reference] of babylon) {
      const { outliers, largest, lit } = compare(reference, haptic.get(name)!);
      expect(lit, name).toBeGreaterThan(1500);
      expect(outliers, name).toBeLessThanOrEqual(tolerance.outliers);
      expect(largest, name).toBeLessThanOrEqual(tolerance.largest);
    }
    // The poses really differ, so a block that ignored a light, the cube's rotation or its box would fail above.
    for (const pose of ["two off", "environment only", "rotated environment", "box-projected environment"])
      expect(haptic.get(pose), pose).not.toEqual(haptic.get("all lights"));
    // The emission texture really colours the rect light's reflection.
    expect(compare(haptic.get("rect light on metal")!, haptic.get("emissive rect light on metal")!).outliers).toBeGreaterThan(300);
    // The rect light lights the regular surfaces too, where its Fresnel is the standard LTC one rather than Babylon's.
    expect(compare(haptic.get("environment only")!, haptic.get("rect light")!).outliers).toBeGreaterThan(1000);
    // Two programs per Material, for the plain and the box-projected cube, and one for the white metal, which draws its
    // rect light's emission without another; none carries Babylon's light defines. WebGPU releases a program once no draw holds it, as the white metal pose's Material
    // swap leaves them, so there only the three drawn since remain.
    expect(result.hapticEffects).toBe(backend === "webgl2" ? 7 : 3);
    expect(result.lightDefines).toBe(0);
    expect(result.steps).toEqual(LIGHT_STEPS);

    // CEL, against Babylon's CelLightBlock. Its hard steps can flip on float rounding where a pixel sits on a band
    // edge, so a few pixels may differ by a whole band (measured: none); the rest match to rounding.
    const celBabylon = paths(result.celCaptures, "babylon");
    const celHaptic = paths(result.celCaptures, "haptic");
    expect([...celBabylon.keys()]).toEqual([
      "sun and fill", "sun only", "fill only", "environment only", "rotated environment", "additive", "blend", "wide highlights", "no highlights",
    ]);
    for (const [name, reference] of celBabylon) {
      const { outliers, lit } = compare(reference, celHaptic.get(name)!);
      expect(lit, `cel ${name}`).toBeGreaterThan(1500);
      expect(outliers, `cel ${name}`).toBeLessThanOrEqual(20);
    }
    for (const pose of ["fill only", "environment only", "additive", "blend", "wide highlights", "no highlights"])
      expect(celBabylon.get(pose), pose).not.toEqual(celBabylon.get("sun and fill"));
    expect(celBabylon.get("rotated environment")).not.toEqual(celBabylon.get("environment only"));
    // Point and spot lights fall off physically on the block, by design: lit, and not as Babylon's CEL draws them.
    expect(celHaptic.get("all lights")).not.toEqual(celHaptic.get("sun and fill"));
    // Babylon's light block draws rect lights far dimmer than its PBR block; the block lights CEL with PBR's form factor.
    expect(compare(celHaptic.get("environment only")!, celHaptic.get("rect light")!).outliers).toBeGreaterThan(300);
    // One CEL program per Material: CEL ignores the cube's format and box.
    expect(result.celEffects).toBe(3);
    expect(result.celSteps).toEqual(LIGHT_STEPS);

    // A spot light's and the sun's shadows on the block's path, drawn through the shadow controller and the frame graph
    // into the atlas: a floor pixel whose view of the light the box or the ball blocks draws as with the light off, any
    // other as with the light's shadow switched off, in both render modes, and the shadow compiles nothing.
    for (const [light, { blocked, modes }] of Object.entries(result.shadow)) {
      const settled = settledShadowPixels(blocked, result.width, result.height);
      const shadowReport = modes.map(({ mode, atlas, shadowed, unshadowed, unlit, newLitEffects }) => ({
        light, mode, atlas, newLitEffects, blocked: settled.blocked.length, open: settled.open.length,
        // The light really lights the blocked pixels when nothing shadows them.
        lighting: settled.blocked.reduce((sum, pixel) => sum + difference(unshadowed, unlit, pixel), 0) / settled.blocked.length,
        blockedLit: settled.blocked.filter((pixel) => difference(shadowed, unlit, pixel) > 2).length,
        openShadowed: settled.open.filter((pixel) => difference(shadowed, unshadowed, pixel) > 2).length,
      }));
      await testInfo.attach(`haptic-light-${light}-shadow-${backend}`, { body: JSON.stringify(shadowReport), contentType: "application/json" });
      for (const report of shadowReport) {
        const label = `${light} ${report.mode}`;
        expect(report.atlas, label).toBe(true);
        expect(report.newLitEffects, label).toBe(0);
        expect(report.blocked, label).toBeGreaterThan(100);
        expect(report.open, label).toBeGreaterThan(1000);
        expect(report.lighting, label).toBeGreaterThan(20);
        expect(report.blockedLit, label).toBe(0);
        expect(report.openShadowed, label).toBe(0);
      }
    }
  });
}
