import { expect, test } from "@playwright/test";
import type { runOcclusionCullingProof } from "../apps/editor/src/testing/occlusion-culling-proof";
import { SOFTWARE_GL_ARGS } from "./software-gl";

test.use({ launchOptions: { args: SOFTWARE_GL_ARGS } });

type Proof = typeof runOcclusionCullingProof;

/** Pixels whose colour differs between two captures. */
function changed(a: number[], b: number[]) {
  let count = 0;
  for (let pixel = 0; pixel < a.length / 4; pixel++)
    if (a[pixel * 4] !== b[pixel * 4] || a[pixel * 4 + 1] !== b[pixel * 4 + 1] || a[pixel * 4 + 2] !== b[pixel * 4 + 2]) count++;
  return count;
}

test("occlusion culling draws fewer meshes and the same image, shadows of hidden meshes included", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (["error", "warning"].includes(message.type()) &&
      /shader|VALIDATE_STATUS|GL_INVALID|ERROR: 0:|context lost|fatal error/i.test(message.text())) errors.push(message.text());
  });
  await page.goto("/?test=1&occlusionCullingProof=1");
  await page.waitForFunction(() => typeof (window as unknown as { __occlusionCullingProof?: unknown }).__occlusionCullingProof === "function");
  const result = await page.evaluate(() =>
    (window as unknown as { __occlusionCullingProof: Proof }).__occlusionCullingProof());
  const report = {
    draws: result.draws, diagnostics: { ...result.diagnostics, ms: undefined }, culled: result.culled, hidden: result.hidden,
    changed: changed(result.off, result.on), casterShadow: changed(result.on, result.noCaster),
  };
  await testInfo.attach("occlusion-culling", { body: JSON.stringify(report, null, 2), contentType: "application/json" });
  console.log(JSON.stringify(report));
  expect(errors).toEqual([]);
  // Most crates behind the wall leave the list (those whose box reaches the wall's edge on screen stay), nothing in
  // view does, and the image is the same to the byte.
  expect(report.culled.hidden).toBeGreaterThanOrEqual(25);
  expect(report.culled.others).toEqual([]);
  expect(report.culled.caster).toBe(true);
  expect(report.changed).toBe(0);
  expect(report.draws.on).toBeLessThan(report.draws.off);
  // The hidden caster's shadow still draws: without it the image changes.
  expect(report.casterShadow).toBeGreaterThan(5);
});
