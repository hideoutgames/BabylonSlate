import { expect, test, type Page } from "@playwright/test";
import type { LargeWorldProofOptions, runLargeWorldProof } from "../apps/editor/src/testing/large-world-proof";
import { SOFTWARE_GL_ARGS } from "./software-gl";

// HAPTIC_RENDER_NATIVE_GPU=1 runs it on the machine's GPU outside CI: `--config playwright.perf.config.ts --project perf-gpu`.
const SOFTWARE_GL = process.env.HAPTIC_RENDER_NATIVE_GPU !== "1" || Boolean(process.env.CI);
if (SOFTWARE_GL) test.use({ launchOptions: { args: SOFTWARE_GL_ARGS } });

type Proof = typeof runLargeWorldProof;
const NEAR: LargeWorldProofOptions["origin"] = [0, 0, 0];
/** About 28 km from the world origin, where a 32-bit position is only good to a few millimetres. */
const FAR: LargeWorldProofOptions["origin"] = [20_000, 0, -20_000];

async function run(page: Page, options: LargeWorldProofOptions) {
  const errors: string[] = [];
  const listener = (message: { type(): string; text(): string }) => {
    if (["warning", "error"].includes(message.type()) && /shader|VALIDATE_STATUS|ERROR: 0:|context lost|fatal error/i.test(message.text()))
      errors.push(message.text());
  };
  page.on("console", listener);
  page.on("pageerror", (error) => errors.push(error.message));
  // A page of its own per run: Babylon's matrix precision and floating origin are page-wide.
  await page.goto("/?test=1&largeWorldProof=1");
  await page.waitForFunction(() => typeof (window as unknown as { __largeWorldProof?: unknown }).__largeWorldProof === "function");
  const result = await page.evaluate((value) => (window as unknown as { __largeWorldProof: Proof }).__largeWorldProof(value), options);
  page.off("console", listener);
  expect(errors).toEqual([]);
  expect(result.floatingOrigin).toBe(options.largeWorld);
  expect(new Set(result.frame).size, "not blank").toBeGreaterThan(32);
  return result;
}

/** RGBA pixels whose channels differ at all, those differing by more than 8 of 255, and the largest channel difference. */
function compare(a: number[], b: number[]) {
  let pixels = 0, visible = 0, largest = 0;
  for (let index = 0; index < a.length; index += 4) {
    let pixel = 0;
    for (let channel = 0; channel < 4; channel++) pixel = Math.max(pixel, Math.abs(a[index + channel]! - b[index + channel]!));
    if (pixel > 0) pixels++;
    if (pixel > 8) visible++;
    largest = Math.max(largest, pixel);
  }
  return { pixels, visible, largest, of: a.length / 4 };
}

test("Large World Rendering keeps a scene kilometres out steady, and draws a scene near the origin as the mode off does", async ({ page }, testInfo) => {
  test.setTimeout(480_000);
  const nearOff = await run(page, { largeWorld: false, origin: NEAR });
  const nearOn = await run(page, { largeWorld: true, origin: NEAR });
  const farOn = await run(page, { largeWorld: true, origin: FAR });
  const farOff = await run(page, { largeWorld: false, origin: FAR });
  const summary = {
    renderer: nearOff.renderer,
    nearOnVersusOff: compare(nearOn.frame, nearOff.frame),
    farOnVersusNearOn: compare(farOn.frame, nearOn.frame),
    farOffVersusNearOff: compare(farOff.frame, nearOff.frame),
  };
  await testInfo.attach("large-world", { body: JSON.stringify(summary), contentType: "application/json" });
  console.log(`large world proof ${JSON.stringify(summary)}`);
  const { nearOnVersusOff, farOnVersusNearOn, farOffVersusNearOff } = summary;
  // Near the origin the two modes draw the same picture up to rounding: the eye-relative placement rounds differently.
  expect(nearOnVersusOff.visible, "near: pixels visibly different").toBeLessThanOrEqual(nearOnVersusOff.of * 0.002);
  expect(nearOnVersusOff.pixels, "near: pixels different at all").toBeLessThanOrEqual(nearOnVersusOff.of * 0.05);
  // Kilometres out with the mode on, the picture is the one near the origin, within the same tolerance.
  expect(farOnVersusNearOn.visible, "far on: pixels visibly different").toBeLessThanOrEqual(farOnVersusNearOn.of * 0.002);
  expect(farOnVersusNearOn.pixels, "far on: pixels different at all").toBeLessThanOrEqual(farOnVersusNearOn.of * 0.05);
  // The control: without it, the same scene out there is visibly wrong.
  expect(farOffVersusNearOff.visible, "far off: the control").toBeGreaterThan(farOnVersusNearOn.visible);
});
