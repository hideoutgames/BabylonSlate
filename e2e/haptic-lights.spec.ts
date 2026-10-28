import { expect, test } from "@playwright/test";
import type { runHapticLightProof } from "../apps/editor/src/testing/haptic-light-proof";
import { SOFTWARE_WEBGPU_ARGS } from "./software-webgpu";

test.use({ launchOptions: { args: SOFTWARE_WEBGPU_ARGS } });

test("HapticLightingBlock shades graph Materials like Babylon's PBR block, and light changes compile nothing", async ({ page }, testInfo) => {
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
  expect(result.steps).toEqual([
    { step: "a point switched off", newLitEffects: 0 },
    { step: "a spot switched off", newLitEffects: 0 },
    { step: "the fill switched off", newLitEffects: 0 },
    { step: "all back on", newLitEffects: 0 },
    { step: "a new point", newLitEffects: 0 },
    { step: "a point removed", newLitEffects: 0 },
  ]);
});
