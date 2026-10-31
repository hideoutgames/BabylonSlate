import { expect, test } from "@playwright/test";
import type { runPooledLodProof } from "../apps/editor/src/testing/pooled-lod-proof";

type Proof = typeof runPooledLodProof;

test("pooled model leaves draw at their own Auto LOD level, the far one through its source's coarser level, on webgl2", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (["error", "warning"].includes(message.type()) && /shader|VALIDATE_STATUS|GL_INVALID|ERROR: 0:|context lost|InstancedMesh|LOD/i.test(message.text()))
      errors.push(message.text());
  });
  await page.goto("/?test=1&pooledLodProof=1");
  await page.waitForFunction(() => typeof (window as unknown as { __pooledLodProof?: unknown }).__pooledLodProof === "function");
  const result = await page.evaluate(() => (window as unknown as { __pooledLodProof: Proof }).__pooledLodProof("webgl2"));
  await testInfo.attach("pooled-lod", { body: JSON.stringify(result, null, 2), contentType: "application/json" });
  expect(errors).toEqual([]);
  expect(result.pooled).toBe(true);
  expect(result.levels).toBeGreaterThan(0);
  expect(result.nearLevel).toBe(0);
  expect(result.farLevel).toBeGreaterThan(0);
  // Both draw: the far one's batch is its level's.
  expect(result.nearBrightness).toBeGreaterThan(40);
  expect(result.farBrightness).toBeGreaterThan(40);
});
