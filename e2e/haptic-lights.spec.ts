import { expect, test } from "@playwright/test";
import type { runHapticLightProof } from "../apps/editor/src/testing/haptic-light-proof";
import { SOFTWARE_WEBGPU_ARGS } from "./software-webgpu";

test.use({ launchOptions: { args: SOFTWARE_WEBGPU_ARGS } });

/** The most pixels (of 9600) a CEL pose may differ in by more than rounding (measured: none). */
const CEL_EDGE_PIXELS = 20;

const LIGHT_STEPS = [
  { step: "a point switched off", newLitEffects: 0 },
  { step: "a spot switched off", newLitEffects: 0 },
  { step: "the fill switched off", newLitEffects: 0 },
  { step: "all back on", newLitEffects: 0 },
  { step: "a new point", newLitEffects: 0 },
  { step: "a point removed", newLitEffects: 0 },
];

test("HapticLightingBlock shades graph Materials like Babylon's PBR and CEL blocks, and light changes compile nothing", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (["error", "warning"].includes(message.type()) &&
      /shader|VALIDATE_STATUS|GL_INVALID|ERROR: 0:|context lost|fatal error/i.test(message.text())) errors.push(message.text());
  });
  await page.goto("/?test=1&hapticLightProof=1");
  await page.waitForFunction(() => typeof (window as unknown as { __hapticLightProof?: unknown }).__hapticLightProof === "function");
  const result = await page.evaluate(() => (window as unknown as { __hapticLightProof: typeof runHapticLightProof }).__hapticLightProof());
  await testInfo.attach("haptic-light-proof", { body: JSON.stringify(result), contentType: "application/json" });
  expect(errors).toEqual([]);
  const babylon = new Map(result.captures.filter((capture) => capture.path === "babylon").map((capture) => [capture.name, capture.pixels]));
  expect([...babylon.keys()]).toEqual(["all lights", "two off", "sun only", "environment only", "rotated environment", "box-projected environment"]);
  for (const capture of result.captures) {
    const reference = babylon.get(capture.name)!;
    let difference = 0;
    let lit = 0;
    for (let index = 0; index < reference.length; index++) {
      difference = Math.max(difference, Math.abs(capture.pixels[index]! - reference[index]!));
      if (index % 4 === 0 && Math.max(...reference.slice(index, index + 3)) > 25) lit++;
    }
    expect(lit, `${capture.path} ${capture.name}`).toBeGreaterThan(1500);
    // The same BRDF and environment evaluated in another order: float rounding only. The lights' range is far beyond
    // the scene, so HapticLightingBlock's range window (which Babylon's physical falloff lacks) stays at one.
    expect(difference, `${capture.path} ${capture.name}`).toBeLessThanOrEqual(2);
  }
  // The poses really differ, so a block that ignored a light, the cube's rotation or its box would fail above.
  for (const pose of ["two off", "environment only", "rotated environment", "box-projected environment"])
    expect(babylon.get(pose), pose).not.toEqual(babylon.get("all lights"));
  // Two programs per Material, for the plain and the box-projected cube, and none carries Babylon's light defines.
  expect(result.hapticEffects).toBe(6);
  expect(result.lightDefines).toBe(0);
  expect(result.steps).toEqual(LIGHT_STEPS);

  // CEL, against Babylon's CelLightBlock. Its hard steps can flip on float rounding where a pixel sits on a band
  // edge, so a few pixels may differ by a whole band; the rest match to rounding.
  const celPaths = (path: string) => new Map(result.celCaptures.filter((capture) => capture.path === path).map((capture) => [capture.name, capture.pixels]));
  const celBabylon = celPaths("babylon");
  const celHaptic = celPaths("haptic");
  expect([...celBabylon.keys()]).toEqual([
    "sun and fill", "sun only", "fill only", "environment only", "rotated environment", "additive", "blend", "wide highlights", "no highlights",
  ]);
  for (const [name, reference] of celBabylon) {
    const pixels = celHaptic.get(name)!;
    let outliers = 0;
    let lit = 0;
    for (let index = 0; index < reference.length; index += 4) {
      let difference = 0;
      for (let channel = 0; channel < 3; channel++) difference = Math.max(difference, Math.abs(pixels[index + channel]! - reference[index + channel]!));
      if (difference > 2) outliers++;
      if (Math.max(...reference.slice(index, index + 3)) > 25) lit++;
    }
    expect(lit, `cel ${name}`).toBeGreaterThan(1500);
    expect(outliers, `cel ${name}`).toBeLessThanOrEqual(CEL_EDGE_PIXELS);
  }
  for (const pose of ["fill only", "environment only", "additive", "blend", "wide highlights", "no highlights"])
    expect(celBabylon.get(pose), pose).not.toEqual(celBabylon.get("sun and fill"));
  expect(celBabylon.get("rotated environment")).not.toEqual(celBabylon.get("environment only"));
  // Point and spot lights fall off physically on the block, by design: lit, and not as Babylon's CEL draws them.
  expect(celHaptic.get("all lights")).not.toEqual(celHaptic.get("sun and fill"));
  // One CEL program per Material: CEL ignores the cube's format and box.
  expect(result.celEffects).toBe(3);
  expect(result.celSteps).toEqual(LIGHT_STEPS);
});
