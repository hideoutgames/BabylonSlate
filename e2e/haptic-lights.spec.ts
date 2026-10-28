import { expect, test } from "@playwright/test";
import type { runHapticLightProof } from "../apps/editor/src/testing/haptic-light-proof";
import { SOFTWARE_WEBGPU_ARGS } from "./software-webgpu";

test.use({ launchOptions: { args: SOFTWARE_WEBGPU_ARGS } });

test("the HapticLights spike shades PBR graphs like Babylon's light path, and light changes compile nothing", async ({ page }, testInfo) => {
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
  expect([...babylon.keys()]).toEqual(["all lights", "two off", "sun only"]);
  for (const capture of result.captures) {
    const reference = babylon.get(capture.name)!;
    let difference = 0;
    let lit = 0;
    for (let index = 0; index < reference.length; index++) {
      difference = Math.max(difference, Math.abs(capture.pixels[index]! - reference[index]!));
      if (index % 4 === 0 && Math.max(...reference.slice(index, index + 3)) > 25) lit++;
    }
    expect(lit, `${capture.path} ${capture.name}`).toBeGreaterThan(400);
    // The loops sum lights in another order than lightSources: float rounding only.
    expect(difference, `${capture.path} ${capture.name}`).toBeLessThanOrEqual(2);
  }
  // The poses really differ, so a loop that ignored a light would fail above.
  expect(babylon.get("two off")).not.toEqual(babylon.get("all lights"));
  expect(result.hapticLitEffects).toBeGreaterThanOrEqual(1);
  expect(result.steps).toEqual([
    { step: "a point switched off", newLitEffects: 0 },
    { step: "a spot switched off", newLitEffects: 0 },
    { step: "the fill switched off", newLitEffects: 0 },
    { step: "all back on", newLitEffects: 0 },
    { step: "a new point", newLitEffects: 0 },
    { step: "a point removed", newLitEffects: 0 },
  ]);
});
