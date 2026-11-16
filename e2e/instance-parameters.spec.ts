import { expect, test } from "@playwright/test";
import type { runInstanceParametersProof } from "../apps/editor/src/testing/instance-parameters-proof";
import { SOFTWARE_GL_ARGS } from "./software-gl";

test.use({ launchOptions: { args: SOFTWARE_GL_ARGS } });

type Proof = typeof runInstanceParametersProof;

/** The index of the largest of a pixel's red, green and blue. */
const dominant = ([r, g, b]: number[]) => [r!, g!, b!].indexOf(Math.max(r!, g!, b!));

test("pooled crates each draw their own per-instance Tint, and a plain mesh the Material's", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (["error", "warning"].includes(message.type()) &&
      /shader|VALIDATE_STATUS|GL_INVALID|ERROR: 0:|context lost|attribute/i.test(message.text()))
      errors.push(message.text());
  });
  await page.goto("/?test=1&instanceParametersProof=1");
  await page.waitForFunction(() => typeof (window as unknown as { __instanceParametersProof?: unknown }).__instanceParametersProof === "function");
  const result = await page.evaluate(() =>
    (window as unknown as { __instanceParametersProof: Proof }).__instanceParametersProof());
  await testInfo.attach("instance-parameters", { body: JSON.stringify(result, null, 2), contentType: "application/json" });
  expect(errors).toEqual([]);
  // Red, green and blue crates; a grey plain box (the Material's Tint).
  expect(result.crates.map(dominant)).toEqual([0, 1, 2]);
  const [r, g, b] = result.plain;
  expect(Math.max(r!, g!, b!) - Math.min(r!, g!, b!)).toBeLessThan(12);
  expect(r).toBeGreaterThan(40);
  // The crates share one group source.
  expect(result.sources).toBe(1);
});
