import { expect, test } from "@playwright/test";
import type { runVariantSwapProof } from "../apps/editor/src/testing/variant-swap-proof";

test("a world view draws each Material's previous Effect with the changed lights while its new variant compiles, without a GL error", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (["error", "warning"].includes(message.type()) &&
      /shader|VALIDATE_STATUS|GL_INVALID|ERROR: 0:|context lost|fatal error|too small/i.test(message.text())) errors.push(message.text());
  });
  await page.goto("/?test=1&variantSwapProof=1");
  await page.waitForFunction(() =>
    typeof (window as unknown as { __hapticVariantSwapProof?: unknown }).__hapticVariantSwapProof === "function");
  const result = await page.evaluate(() =>
    (window as unknown as { __hapticVariantSwapProof: typeof runVariantSwapProof }).__hapticVariantSwapProof());
  await testInfo.attach("variant-swap-proof", { body: JSON.stringify(result), contentType: "application/json" });
  expect(errors).toEqual([]);
  const materials = ["native pbr", "native standard", "cel source:CEL", "graph"];
  expect(result.steps.map((step) => step.name)).toEqual([
    "a spot gives way to a point", "the sun is removed", "a spot stops casting shadows", "a point light stops casting shadows",
  ]);
  for (const step of result.steps) {
    // Each Material drew its previous Effect in every steady frame while its new variant was held back, with no GL
    // error, then drew the new variant once released.
    expect(step.drawn, step.name).toBe(3);
    expect(step.previousDrawn.sort(), step.name).toEqual([...materials].sort());
    expect(step.glErrors, step.name).toEqual([]);
    expect(step.adopted.sort(), step.name).toEqual([...materials].sort());
    expect(step.litPixels, step.name).toBeGreaterThan(400);
  }
  // Each previous Effect drew what its reference shows (float rounding only). With no spot left, the spot slot binds
  // an empty spot: the frame is the sun and the near point alone. A light that stopped casting shadows still lights
  // through its map's placeholder, which reads as an empty map: the frame is the new variant's.
  expect(Object.fromEntries(result.steps.flatMap((step) =>
    step.referenceDifference === undefined ? [] : [[step.name, step.referenceDifference <= 2]]))).toEqual({
    "a spot gives way to a point": true, "a spot stops casting shadows": true, "a point light stops casting shadows": true,
  });
});
